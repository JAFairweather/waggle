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

import { PUBLIC_RELAYS } from './profile-publish.mjs'

export { PUBLIC_RELAYS }

/// The cap is NIP-17's, lifted from `src/dm_relays.mjs` for the same reason `PUBLIC_RELAYS` is
/// lifted: the page cannot import `../src/`. The suite drives both copies over one fixture table
/// rather than asserting the sources look alike.
export const MAX_DM_RELAYS = 8

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
  if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
      host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
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
    if (!seen.has(url)) refused.push({ value: String(value).trim(), why: `over the ${MAX_DM_RELAYS}-relay cap NIP-17 sets — only the first ${MAX_DM_RELAYS} are published` })
  }
  return { relays, refused }
}

/// The unsigned kind:10050. UNSIGNED because no key exists on this page to sign with — the agent's
/// bunker signs it, the same way it signs its own kind:0.
///
/// Refuses an empty list rather than publishing a list of nothing. A kind:10050 with no relay tags
/// is worse than no kind:10050 at all: it is a signed, replaceable statement that supersedes any
/// working list already published, and it reads to the bridge as "not ready to receive".
export function dmRelayListTemplate({ relays, now } = {}) {
  const urls = normalizeDmRelayList(relays)
  if (!urls.length) {
    throw new Error('an inbox needs at least one reachable wss:// relay — publishing an empty kind:10050 REPLACES any working list this key already has, and tells the bridge the agent is not ready to receive')
  }
  return {
    kind: 10050,
    created_at: Number.isFinite(now) ? now : Math.floor(Date.now() / 1000),
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
export function currentDmRelays(events, pubkey) {
  const target = String(pubkey || '').toLowerCase()
  const newest = (events || [])
    .filter(e => e && e.kind === 10050 && String(e.pubkey || '').toLowerCase() === target && Array.isArray(e.tags))
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0) || String(b.id || '').localeCompare(String(a.id || '')))[0]
  if (!newest) return []
  return normalizeDmRelayList(newest.tags.filter(t => Array.isArray(t) && t[0] === 'relay').map(t => t[1]))
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

// A fresh connection every time — that is what makes it COLD. `answered` is tracked apart from
// `newest`: a relay that never sent EOSE has told us nothing, and nothing is not "not there".
function wsReadBack(url, pubkey, { WS = globalThis.WebSocket, timeoutMs = 12000 } = {}) {
  return new Promise(resolve => {
    let ws, newest = null, answered = false
    try { ws = new WS(url) } catch { return resolve({ url, answered: false, newest: null }) }
    const done = () => { try { ws.close() } catch { /* already closed */ } resolve({ url, answered, newest }) }
    const t = setTimeout(done, timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'dm', { kinds: [10050], authors: [pubkey], limit: 5 }]))
    ws.onmessage = m => {
      let msg
      try { msg = JSON.parse(typeof m.data === 'string' ? m.data : '') } catch { return }
      if (msg[0] === 'EVENT' && msg[2]?.pubkey === pubkey && (!newest || msg[2].created_at > newest.created_at)) newest = msg[2]
      if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') { answered = msg[0] === 'EOSE'; clearTimeout(t); done() }
    }
    ws.onerror = () => { clearTimeout(t); done() }
  })
}

/// Read whatever inbox the public relays already serve for this key, so the operator sees what they
/// are replacing before they replace it.
export async function readDmRelays(pubkey, { relays = PUBLIC_RELAYS, WS, timeoutMs } = {}) {
  const seen = await Promise.all(relays.map(u => wsReadBack(u, pubkey, { WS, timeoutMs })))
  return {
    events: seen.map(r => r.newest).filter(Boolean),
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
  const confirmed = backs.filter(b => b.newest && b.newest.id === signedEvent.id)
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
