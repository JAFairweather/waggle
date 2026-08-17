// dm-relay-publish.mjs — the agent's inbox, published from the console (#581).
//
// THE STEP THAT DID NOT EXIST. A kind:10050 is where the bridge is allowed to deliver sealed mail.
// `src/bridge.mjs:3230` has no public-relay fallback by design (NIP-17 treats "no list" as "not
// ready to receive"), so with no kind:10050 the bridge logs `RETURN not sent -> …: no valid
// kind:10050 recipient DM relay list` and drops the message. The console admitted an agent, gave it
// a name, and told the operator the inbox was "not observable from the console" — while a public
// relay answers the question in nine seconds. The symptom on the agent's side is an empty inbox,
// which is indistinguishable from no mail. That is the whole defect: a step nobody owned, whose
// absence rendered as something other than missing.
//
// WHY THE SAME RELAY SET AS THE NAME. The bridge discovers a kind:10050 on its ordinary read relays
// (`src/bridge.mjs:1609`, `fanout(PUB.relays…)`) — the same place it discovers a kind:0. Publishing
// the two to different sets is a silent partial reachability: the name resolves, the mail does not,
// and nothing in either publish reports a problem. So this imports `PUBLIC_RELAYS` from
// `profile-publish.mjs` rather than declaring a second list. One list, one place, and a suite that
// holds it equal to `src/relays.mjs`.
//
// WHAT COUNTS AS PROVEN — COLD READ-BACK BY ID. A relay's OK is not a publish: relays return OK and
// drop, and `relay.primal.net` accepted one of these and then failed to serve it back on a cold read
// during the session that produced this file. `pushed` and `proven` are separate fields and no
// caller can collapse them by accident.
//
// By ID, specifically, and not by content the way `profile-publish.mjs` compares: a kind:10050 has
// an EMPTY content string by construction, so a content comparison here would match any kind:10050
// this key ever published, including the stale two-relay one this publish exists to replace. The id
// is a hash over the tags, so id equality is the only comparison that distinguishes the list we just
// pushed from the list we are trying to fix. There is no community leg, so unlike the profile there
// is no second copy with a different id to accommodate.

import { verifyEvent } from 'nostr-tools'
import { PUBLIC_RELAYS } from './profile-publish.mjs'

export { PUBLIC_RELAYS }

/// The cap is NIP-17's, lifted from `src/dm_relays.mjs` for the same reason `PUBLIC_RELAYS` is
/// lifted: the page cannot import `../src/`. The suite drives both copies over one fixture table
/// rather than asserting the sources look alike.
export const MAX_DM_RELAYS = 8

/// Loopback, private or link-local — the addresses that make a published inbox unreachable from
/// anywhere but this network. Kept identical, function for function, to the copy in
/// `src/dm_relays.mjs`; `tests/console_dm_relays.mjs` drives the same table through both and fails
/// when they disagree, which is what forces a fix here to be a fix there too.
///
/// IPv6 is a separate branch, and both reasons for that were live defects (#584 review):
///
///   * **WHATWG `URL.hostname` returns an IPv6 host BRACKETED** — `[::1]`, never `::1`. So the three
///     comparisons this replaces matched nothing and every IPv6 loopback, ULA and link-local address
///     was ACCEPTED. Driven: `wss://[::1]`, `wss://[fc00::1]`, `wss://[fe80::1]` and
///     `wss://[::ffff:127.0.0.1]` all passed the guard on both sides.
///   * **The brackets are also the only thing that tells an address from a name.** `fc` and `fd` are
///     a ULA prefix in an address and two ordinary opening letters in a hostname, so testing
///     `startsWith('fc')` against an unbracketed host refuses `wss://fd-relay.example` — a public
///     relay with a perfectly ordinary name. Stripping the brackets in place would have fixed the
///     first defect and kept the second.
function privateHost(hostname) {
  const bracketed = /^\[(.*)\]$/.exec(hostname)
  if (!bracketed) return /^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)
  const addr = bracketed[1]
  // `::ffff:127.0.0.1` normalises to `::ffff:7f00:1`, which the IPv4 rule above cannot see. Rebuild
  // the dotted form and ask that rule the same question, rather than writing a second copy of it
  // that would then be differently wrong.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr)
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16)
    return privateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  if (addr === '::1' || addr === '::') return true      // loopback, and the unspecified address
  if (/^fe[89ab][0-9a-f]?:/.test(addr)) return true     // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{0,2}:/.test(addr)) return true    // fc00::/7 unique-local
  return false
}

/// Why a relay was refused, in words the operator can act on — or null when it is fine.
///
/// This returns a REASON, not a boolean, because `!ok` cannot tell a correct refusal from a correct
/// refusal with a misleading explanation, and the explanation is the entire actionable content of
/// this step. An operator who pastes `ws://localhost:7777` and is told only "invalid" goes hunting
/// for a typo in a URL that has none.
export function refuseReason(value) {
  const raw = String(value || '').trim()
  if (!raw) return 'empty'
  let u
  try { u = new URL(raw) } catch { return `${raw} is not a URL` }
  if (u.protocol !== 'wss:') return `${raw} is ${u.protocol.replace(':', '')}, and a DM relay must be wss: — this list is public, and a plaintext hop is a public one`
  if (u.username || u.password) return `${raw} carries credentials in the URL, and this list is published where anyone can read it`
  if (u.hash) return `${raw} carries a fragment, which a relay never sees and which would make this list differ from the one that gets used`
  const host = u.hostname.toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return `${raw} names a local host. This list tells OTHER machines where to deliver, so a name only this machine resolves is an inbox nobody can reach`
  }
  if (privateHost(host)) {
    return `${raw} is a private-network address. This list tells OTHER machines where to deliver, so nothing outside that network can reach it`
  }
  return null
}

/// The same normalisation `src/dm_relays.mjs` applies when the bridge READS a list, applied here
/// when the console WRITES one. A publisher that accepts what the reader will discard writes an
/// inbox with fewer relays in it than the operator was shown.
export function normalizeDmRelayList(values, cap = MAX_DM_RELAYS) {
  const seen = new Set(), out = []
  for (const value of values || []) {
    if (refuseReason(value)) continue
    const url = new URL(String(value).trim()).href.replace(/\/$/, '')
    if (seen.has(url)) continue
    seen.add(url); out.push(url)
    if (out.length >= cap) break
  }
  return out
}

/// What will actually be published, and what will not — with the reason for each drop.
///
/// Every caller gets both halves. A page that renders only `relays` shows the operator a shorter
/// list than they typed and says nothing about the difference, which is how a rejected relay reads
/// as a relay that was never entered.
export function planDmRelays(values) {
  const relays = normalizeDmRelayList(values)
  const refused = []
  const seen = new Set(relays)
  for (const value of values || []) {
    const why = refuseReason(value)
    if (why === 'empty') continue
    if (why) { refused.push({ value: String(value).trim(), why }); continue }
    const url = new URL(String(value).trim()).href.replace(/\/$/, '')
    // Past the cap, or a duplicate — both are silent drops in `normalizeDmRelayList`, and a silent
    // drop is the failure this whole module is about.
    // Names the URL, like every other reason here, and says "would be" rather than "are": the
    // handler returns on any refusal, so nothing is published on this road. The previous wording
    // contradicted the sentence it was rendered inside — "only the first 8 are published … nothing
    // has been published yet" — and dropped the one actionable fact, which URL fell off the end
    // (#584 review). The suite asserted `/cap/i` on the reason, which passes on either wording.
    if (!seen.has(url)) refused.push({ value: String(value).trim(), why: `${String(value).trim()} is over the ${MAX_DM_RELAYS}-relay cap NIP-17 sets — only the first ${MAX_DM_RELAYS} would be published` })
  }
  return { relays, refused }
}

/// The unsigned kind:10050. UNSIGNED because no key exists on this page to sign with — the agent's
/// bunker signs it, the same way it signs its own kind:0.
///
/// Refuses an empty list rather than publishing a list of nothing. A kind:10050 with no relay tags
/// is worse than no kind:10050 at all: it is a signed, replaceable statement that supersedes any
/// working list already published, and it reads to the bridge as "not ready to receive".
///
/// `supersedes` is the newest `created_at` already published for this key. kind:10050 is REPLACEABLE
/// and NIP-01 resolves a tie on `created_at` by lowest id, so a bare `Date.now()` does not guarantee
/// replacement — and the two cases where it fails are the two that actually happen (#584 review):
/// a same-second retry, which is exactly what an operator does after reading "not proven", and a
/// clock-skewed future-dated stale list, which is a permanent wedge whose symptom this page would
/// have blamed on the relays. `max(now, supersedes + 1)` costs nothing and removes both.
export function dmRelayListTemplate({ relays, now, supersedes } = {}) {
  const urls = normalizeDmRelayList(relays)
  if (!urls.length) {
    throw new Error('an inbox needs at least one reachable wss:// relay — publishing an empty kind:10050 REPLACES any working list this key already has, and tells the bridge the agent is not ready to receive')
  }
  const base = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000)
  return {
    kind: 10050,
    created_at: Number.isFinite(supersedes) ? Math.max(base, supersedes + 1) : base,
    tags: urls.map(url => ['relay', url]),
    content: '',
  }
}

/// The relay list currently published for this key, or [] — so the operator can see what they are
/// about to replace. Pure, so the adoption rule is assertable without a socket.
///
/// Newest wins by `created_at`, with the id as the tiebreak, matching `recipientDmRelays` in
/// `src/dm_relays.mjs`. Two events with the same timestamp and different lists is exactly the case
/// where "whichever arrived first" would make the console and the bridge disagree.
///
/// THE SIGNATURE IS VERIFIED, and it was not (#584 review). This filters on kind, pubkey and tags,
/// and the value it returns PREFILLS the publish field — so a relay serving a forged kind:10050
/// carrying the agent's pubkey with a high `created_at` chose what the operator's default action
/// would sign, under the agent's real key, through the bunker. `refuseReason` still applies to every
/// entry, so this can never be pointed at loopback; it can be pointed at a relay the attacker chose,
/// which is silent delivery denial — the empty-inbox-indistinguishable-from-no-mail failure this
/// page exists to end, reintroduced through the fix. `recipientDmRelays` in `src/dm_relays.mjs:42`
/// has always verified here; this is the console catching up with it.
///
/// `verify` is injectable so the suite can drive a forgery without minting a valid signature for it,
/// but it DEFAULTS to the real `verifyEvent` — a verification that is off unless a caller remembers
/// to switch it on is not a verification.
export function currentDmRelays(events, pubkey, { verify = verifyEvent } = {}) {
  const target = String(pubkey || '').toLowerCase()
  const ok = e => { try { return !!verify(e) } catch { return false } }
  const newest = (events || [])
    .filter(e => e && e.kind === 10050 && String(e.pubkey || '').toLowerCase() === target && Array.isArray(e.tags))
    .filter(ok)
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0) || String(b.id || '').localeCompare(String(a.id || '')))[0]
  if (!newest) return []
  return normalizeDmRelayList(newest.tags.filter(t => Array.isArray(t) && t[0] === 'relay').map(t => t[1]))
}

/// The newest `created_at` this key already has published, or null. What `dmRelayListTemplate`'s
/// `supersedes` wants.
///
/// Verified, and by the same rule as `currentDmRelays` — deliberately. An unverified maximum is
/// worse than none: a forgery carrying a far-future timestamp would push our own `created_at` years
/// forward, and every list this key publishes after that would be unreplaceable by an honest clock.
export function newestCreatedAt(events, pubkey, { verify = verifyEvent } = {}) {
  const target = String(pubkey || '').toLowerCase()
  const stamps = (events || [])
    .filter(e => e && e.kind === 10050 && String(e.pubkey || '').toLowerCase() === target)
    .filter(e => { try { return !!verify(e) } catch { return false } })
    .map(e => Number(e.created_at))
    .filter(Number.isFinite)
  return stamps.length ? Math.max(...stamps) : null
}

// One relay, one push, one answer. `ok` is what the relay SAID, and it is never the verdict.
function wsPush(url, ev, { WS = globalThis.WebSocket, timeoutMs = 12000 } = {}) {
  return new Promise(resolve => {
    let ws
    try { ws = new WS(url) } catch (e) { return resolve({ url, ok: false, said: `could not connect: ${e.message}` }) }
    const done = (ok, said) => { try { ws.close() } catch { /* already closed */ } resolve({ url, ok, said }) }
    const t = setTimeout(() => done(false, 'timed out — the relay never answered'), timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', ev]))
    ws.onmessage = m => {
      let msg
      try { msg = JSON.parse(typeof m.data === 'string' ? m.data : '') } catch { return }
      if (msg[0] === 'OK' && msg[1] === ev.id) { clearTimeout(t); done(!!msg[2], msg[2] ? 'OK' : `refused: ${msg[3] || '(no reason given)'}`) }
    }
    ws.onerror = () => { clearTimeout(t); done(false, 'the socket errored') }
  })
}

// A fresh connection every time — that is what makes it COLD. `answered` is tracked apart from the
// events: a relay that never sent EOSE has told us nothing, and nothing is not "not there".
//
// EVERY served event is kept, not only the newest one (#584 review). Keeping a single `newest` was
// inherited from `profile-publish.mjs`, where it is harmless because that page compares CONTENT and
// every copy of a profile has the same content. Here the comparison is by ID, and `limit: 5` exists
// precisely because a relay may hold more than one kind:10050 for a key. So a relay that served our
// event alongside anything with a higher `created_at` — a stale future-dated list, which is exactly
// the thing this page exists to replace — reported `proven: 0`. Driven, same signed event both
// times, the only difference being an extra future-dated event on the relay:
//
//     serves ONLY our event      -> proven=1  "published and proven on 1 of 1 relays"
//     ALSO serves a future-dated -> proven=0  "NONE served it back by id … this is not published"
//
// Wrong in the direction that sends the operator at the relays when the fault is their own key's
// stale list.
//
// AND THERE IS NO `newest` HERE AT ALL — that was the line the first fix stopped short of (#584
// review, second read). Reducing to a newest at this level picks a winner BEFORE anything has
// checked a signature, and the only consumers, `currentDmRelays` and `newestCreatedAt`, verify. So a
// forged future-dated event served alongside the genuine one won the reduction, was the only event
// those functions ever saw, and was then correctly rejected — leaving an empty list and "nothing has
// been published yet" for a key whose list is sitting on the relay. `newestCreatedAt` failed the
// same way in the direction that matters more: the real maximum was discarded before the max was
// taken, so `supersedes` came back too low and the replacement could not replace anything.
//
// A reduction that runs before verification is a filter an unsigned event can steer. This function
// now reports what the relay served, and every choice among those events is made downstream by code
// that checks a signature first.
function wsReadBack(url, pubkey, { WS = globalThis.WebSocket, timeoutMs = 12000 } = {}) {
  return new Promise(resolve => {
    let ws, answered = false
    const served = []
    try { ws = new WS(url) } catch { return resolve({ url, answered: false, served: [] }) }
    const done = () => { try { ws.close() } catch { /* already closed */ } resolve({ url, answered, served }) }
    const t = setTimeout(done, timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'dm', { kinds: [10050], authors: [pubkey], limit: 5 }]))
    ws.onmessage = m => {
      let msg
      try { msg = JSON.parse(typeof m.data === 'string' ? m.data : '') } catch { return }
      if (msg[0] === 'EVENT' && msg[2]?.pubkey === pubkey) served.push(msg[2])
      if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') { answered = msg[0] === 'EOSE'; clearTimeout(t); done() }
    }
    ws.onerror = () => { clearTimeout(t); done() }
  })
}

/// Read whatever inbox the public relays already serve for this key, so the operator sees what they
/// are replacing before they replace it.
export async function readDmRelays(pubkey, { relays = PUBLIC_RELAYS, WS, timeoutMs } = {}) {
  const seen = await Promise.all(relays.map(u => wsReadBack(u, pubkey, { WS, timeoutMs })))
  // EVERY event every relay served, deduplicated by id, and no reduction. `currentDmRelays` and
  // `newestCreatedAt` both take a maximum and both verify first; handing them one pre-picked event
  // per relay let an unverified event decide what they got to look at. Deduplication is by id only,
  // which cannot discard a distinct event — four relays serving the same list is one list.
  const byId = new Map()
  for (const r of seen) for (const e of r.served) if (e && e.id && !byId.has(e.id)) byId.set(e.id, e)
  return {
    events: [...byId.values()],
    // Kept apart on purpose: zero events from four relays that all answered is a real negative,
    // and zero events from four relays that never answered is nothing at all.
    answered: seen.filter(r => r.answered).length,
    asked: relays.length,
  }
}

/// Publish, then PROVE it by cold read-back BY ID. `pushed` is what the relays said; `proven` is
/// what a second connection could actually fetch back. `served` is the per-relay detail, because
/// "three of four" is the answer to a different question than "which one is missing".
export async function publishDmRelays(signedEvent, { relays = PUBLIC_RELAYS, WS, timeoutMs } = {}) {
  const pushes = await Promise.all(relays.map(u => wsPush(u, signedEvent, { WS, timeoutMs })))
  const backs = await Promise.all(relays.map(u => wsReadBack(u, signedEvent.pubkey, { WS, timeoutMs })))
  // `some`, over everything the relay served — not `newest.id`. See wsReadBack.
  const confirmed = backs.filter(b => b.served.some(e => e && e.id === signedEvent.id))
  return {
    pushed: pushes.filter(p => p.ok).length,
    said: pushes,
    proven: confirmed.length,
    servedBy: confirmed.map(b => b.url),
    answered: backs.filter(b => b.answered).length,
    asked: relays.length,
  }
}

/// The single sentence the operator reads.
///
/// The branch that matters most is the one that reads best and means least: every relay said OK and
/// none of them served it back. That is not a publish, and the wording says so rather than counting
/// the OKs. It happened during the session that produced this file.
export function inboxVerdict({ pub, relayCount } = {}) {
  const n = Number(relayCount ?? pub?.asked ?? 0)
  if (!pub) return { proven: false, text: 'nothing was published.' }
  if (pub.proven > 0) {
    return {
      proven: true,
      // One relay is a real inbox and a fragile one. The bridge delivers to whatever the list names,
      // so a single-relay inbox works right up until that relay does not — and the agent's symptom
      // then is an empty inbox, the same symptom as no list at all.
      text: pub.proven === 1
        ? `the inbox is published and proven on 1 of ${pub.asked} relays (${pub.servedBy.join(', ')}) — it works, but a single-relay inbox fails silently the day that relay does, and the agent's symptom is an empty inbox either way.`
        : `the inbox is published and proven — ${pub.proven} of ${pub.asked} relays served it back by id on a fresh connection (${pub.servedBy.join(', ')}). The bridge can now deliver ${n === 1 ? 'to it' : 'sealed mail to it'}.`,
    }
  }
  if (pub.pushed > 0) {
    return {
      proven: false,
      text: `${pub.pushed} of ${pub.asked} relays accepted it and NONE served it back by id — a relay can accept and drop, so this is not published and the bridge will still find no list.`,
    }
  }
  return {
    proven: false,
    text: pub.answered > 0
      ? `no relay accepted the inbox list. ${pub.answered} of ${pub.asked} answered, so they were reachable and refused it.`
      : `no relay accepted the inbox list, and none of the ${pub.asked} answered at all — this is a reachability problem from this browser, not a refusal.`,
  }
}
