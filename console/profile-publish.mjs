// profile-publish.mjs — the agent's name, published from the console (#487, second leg).
//
// A name is the thing that actually matters. Buzz resolves an at-word against a `users` row's
// `display_name`, written only by `handle_kind0_profile` and keyed on `event.pubkey` — and
// `event.rs` rejects any event whose pubkey differs from the authenticated identity. So the agent's
// OWN key has to publish its own kind:0, and no bridge can do it on the agent's behalf.
//
// `tools/publish_profile.mjs` does this from node with a bunker pairing on disk. This is the same
// dual push from a page holding a NIP-46 pairing it proved, so the operator never leaves the flow.
//
// THE DUAL PUSH, and the honest shape of "common". Plain event to the public relays; the same
// CONTENT to the community relay over NIP-98. The two copies are NOT one event — the community
// copy can carry an auth tag, so its id differs. Common means one profile, byte-identical in
// `content`. Nothing here reports it as one event.
//
// WHAT COUNTS AS PROVEN. A relay's OK is not proof: relays return OK and drop, and others answer
// 503 while the write succeeds. Every verdict below comes from a COLD READ-BACK — a fresh
// connection, the event fetched by author and kind, its content compared. `pushed` and `proven` are
// separate fields for exactly that reason, and no caller can collapse them by accident.
//
// AND THE COMMUNITY READ-BACK IS EXPECTED TO FAIL. Membership buys write, not read (#399): a
// community read-back has answered `403 RBAC: access denied` for an admitted key, which is the same
// refusal an unadmitted key gets — so it distinguishes nothing. That is INCONCLUSIVE and it is
// stated as such. Reporting it as a failure would send the operator to fix a working publish;
// reporting it as a pass would claim a proof nobody performed.
//
// CONTENT IS ADOPTED, NEVER INVENTED, when there is something to adopt. A second, drifting profile
// that disagrees with the one already published is the failure worth preventing.

/// The public relays an agent's profile goes to. Lifted from `src/relays.mjs`
/// (`DEFAULT_PUBLIC_RELAYS`) for the same reason `console/relay-admission.mjs` lifts its constants:
/// the page cannot import ../src/. The suite holds the two lists equal — a page publishing to a
/// different set from the one the bridge reads is a profile nobody looks for.
export const PUBLIC_RELAYS = Object.freeze([
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
  'wss://jskitty.com/nostr',
])

/// Build the kind:0 template. UNSIGNED — the page signs through the agent's bunker, which is the
/// whole point: no key exists here to sign with.
///
/// Refuses an empty name rather than publishing a blank face. A kind:0 with no `name` writes a
/// `users` row with no `display_name`, which is indistinguishable from never having published at
/// all — except that it looks like it worked.
export function profileTemplate({ name, about = '', picture = '', adopted = null, now }) {
  const display = String(name || '').trim()
  if (!display) throw new Error('a profile needs a name — an at-word resolves against it, and a kind:0 without one publishes a blank face that looks like success')
  // Adopted fields are the floor, not the ceiling: anything the operator typed wins, and anything
  // they left blank keeps whatever is already published rather than blanking it.
  const base = adopted && typeof adopted === 'object' ? { ...adopted } : {}
  const content = { ...base, name: display, display_name: display }
  if (about.trim()) content.about = about.trim()
  else if (!base.about) delete content.about
  if (picture.trim()) content.picture = picture.trim()
  else if (!base.picture) delete content.picture
  return {
    kind: 0,
    created_at: Number.isFinite(now) ? now : Math.floor(Date.now() / 1000),
    tags: [],
    // The exact string that gets published, and the exact string every read-back is compared
    // against. Re-serialising the parsed object for the comparison would compare two things that
    // are equal as objects and different as bytes, which is how "common" quietly stops being true.
    content: JSON.stringify(content),
  }
}

/// The newest kind:0 content already published for this key, parsed — or null. Pure, so the
/// adoption rule is assertable without a socket.
export function adoptFrom(events, pubkey) {
  const mine = (events || []).filter(e => e && e.kind === 0 && e.pubkey === pubkey && typeof e.content === 'string')
  const newest = mine.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0]
  if (!newest) return null
  try {
    const parsed = JSON.parse(newest.content)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
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
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'pp', { kinds: [0], authors: [pubkey], limit: 5 }]))
    ws.onmessage = m => {
      let msg
      try { msg = JSON.parse(typeof m.data === 'string' ? m.data : '') } catch { return }
      if (msg[0] === 'EVENT' && msg[2]?.pubkey === pubkey && (!newest || msg[2].created_at > newest.created_at)) newest = msg[2]
      if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') { answered = msg[0] === 'EOSE'; clearTimeout(t); done() }
    }
    ws.onerror = () => { clearTimeout(t); done() }
  })
}

/// Read whatever profile the public relays already serve for this key, so the publish can adopt it.
export async function readPublic(pubkey, { relays = PUBLIC_RELAYS, WS, timeoutMs } = {}) {
  const seen = await Promise.all(relays.map(u => wsReadBack(u, pubkey, { WS, timeoutMs })))
  return { events: seen.map(r => r.newest).filter(Boolean), answered: seen.filter(r => r.answered).length, asked: relays.length }
}

/// Publish to the public relays and PROVE it by cold read-back. `pushed` is what the relays said; `proven`
/// is what a second connection could actually fetch. They are different claims and stay separate.
export async function publishPublic(signedEvent, { relays = PUBLIC_RELAYS, WS, timeoutMs } = {}) {
  const pushes = await Promise.all(relays.map(u => wsPush(u, signedEvent, { WS, timeoutMs })))
  const backs = await Promise.all(relays.map(u => wsReadBack(u, signedEvent.pubkey, { WS, timeoutMs })))
  // Compared on the CONTENT STRING, not the event id: the community copy has a different id by
  // construction, and this is the same comparison used on both legs so the two are commensurable.
  const confirmed = backs.filter(b => b.newest && b.newest.content === signedEvent.content)
  return {
    pushed: pushes.filter(p => p.ok).length,
    said: pushes,
    proven: confirmed.length,
    // A relay that answered EOSE and served nothing is a real negative; one that never answered is
    // not. Keeping the count lets the caller say which it was instead of averaging them.
    answered: backs.filter(b => b.answered).length,
    asked: relays.length,
  }
}

/// The community leg. Signed by the agent, over NIP-98, to the same `/events` path
/// `tools/publish_profile.mjs` uses. The auth tag is optional and omitted entirely when absent —
/// answered live on 2026-08-15 (#482/#483): `relay_members` membership alone is sufficient to
/// write, and the community relay accepted a kind:0 over NIP-98 with no `x-auth-tag` at all. A gate
/// that skipped this leg unless a tag was present was not the conservative option; it was the only
/// thing between a correct configuration and a successful publish, and it failed by reporting
/// success.
export async function publishCommunity({ relayUrl, signedEvent, sign, authTag = '', fetchImpl = globalThis.fetch, nip98 }) {
  const base = String(relayUrl || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '')
  if (!base) throw new Error('no community relay URL — this leg is what makes the at-word resolve, so it is not skipped quietly')
  const url = `${base}/events`
  const { template, body } = await nip98.nip98Template({ url, method: 'POST', body: JSON.stringify(signedEvent) })
  const signed = await sign(template)
  const headers = { 'content-type': 'application/json', authorization: nip98.nip98Header(signed) }
  // Omitted entirely when unset. `x-auth-tag: undefined` puts the literal string "undefined" on the
  // wire, which the relay reads as a malformed tag rather than as no tag — so the run would answer
  // a question nobody asked.
  if (String(authTag).trim()) headers['x-auth-tag'] = String(authTag).trim()
  let res
  try { res = await fetchImpl(url, { method: 'POST', headers, body }) }
  catch (e) { return { ok: false, reach: true, reason: `could not reach the community relay (${e.message}) — a browser cannot tell that apart from a CORS policy withholding the answer` } }
  const text = await res.text().catch(() => '')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, reason: `the community relay refused the profile (${res.status}): ${String(text).slice(0, 160)}` }
  }
  // `accepted:false` inside a 200 is a refusal wearing a success code. Reading only the status here
  // would report a published name that never got written.
  if (json && json.accepted === false) {
    return { ok: false, status: res.status, reason: `the community relay answered ${res.status} but said accepted:false: ${String(text).slice(0, 160)}` }
  }
  return { ok: true, status: res.status, said: String(text).slice(0, 160) }
}

/// Try the community read-back, and report whatever happened AS ITSELF.
///
/// This is expected to be refused. Membership buys write, not read — a community read-back answers
/// `403 RBAC: access denied` for an admitted key, the same refusal an unadmitted key gets, so it
/// distinguishes nothing (#399). INCONCLUSIVE, never a pass and never a failure of the publish.
export async function readBackCommunity({ relayUrl, pubkey, sign, authTag = '', fetchImpl = globalThis.fetch, nip98 }) {
  const base = String(relayUrl || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '')
  const url = `${base}/events?kinds=0&authors=${pubkey}&limit=5`
  let res
  try {
    const { template } = await nip98.nip98Template({ url, method: 'GET', body: '' })
    const signed = await sign(template)
    const headers = { authorization: nip98.nip98Header(signed) }
    if (String(authTag).trim()) headers['x-auth-tag'] = String(authTag).trim()
    res = await fetchImpl(url, { headers })
  } catch (e) { return { state: 'inconclusive', why: `could not ask: ${e.message}` } }
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    return { state: 'inconclusive', status: res.status,
      why: `${res.status} ${String(text).slice(0, 120)} — membership buys write, not read, so a refusal here says nothing about whether the profile landed` }
  }
  let events = null
  try {
    const parsed = JSON.parse(text)
    events = Array.isArray(parsed) ? parsed : (parsed?.events || parsed?.data || null)
  } catch { return { state: 'inconclusive', why: 'the answer was not JSON this page can read' } }
  if (!Array.isArray(events)) return { state: 'inconclusive', why: 'the answer carried no event array this page recognises' }
  const newest = events.filter(e => e && e.kind === 0 && e.pubkey === pubkey)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0] || null
  return { state: newest ? 'served' : 'absent', newest }
}

/// The single sentence the operator reads. Every branch names what was PROVEN, separately from what
/// was accepted — including the case that reads best and means least: both relays said OK and
/// neither read-back confirmed anything.
export function nameVerdict({ pub, community, communityRead }) {
  const parts = []
  if (pub.proven > 0) parts.push(`the public half is proven — ${pub.proven} of ${pub.asked} relays served it back on a fresh connection`)
  else if (pub.pushed > 0) parts.push(`${pub.pushed} of ${pub.asked} public relays accepted it and NONE served it back — a relay can accept and drop, so this is not published`)
  else parts.push('no public relay accepted it')

  if (community?.ok) {
    if (communityRead?.state === 'served') parts.push('and the community relay served it back, so the at-word resolves')
    else parts.push('and the community relay accepted it. The read-back is INCONCLUSIVE — membership buys write, not read, so nothing here can confirm the name from this page')
  } else if (community) {
    parts.push(`but the community leg did not land: ${community.reason}. Without it the at-word does not resolve`)
  }
  return {
    // Proven means the public half was read back cold. It deliberately does NOT include the
    // community leg, because no read-back on that side can currently confirm anything.
    proven: pub.proven > 0,
    communityAccepted: community?.ok === true,
    text: `${parts.join(', ')}.`,
  }
}
