// Who is in each room (docs/DESIGN_HIVE_CONSOLE.md, "Who is in each room").
//
// The community relay signs one member list per room (kind 39002, `d` = room id, `p` tags name the
// members). This module only judges lists that have already arrived: it never connects, never signs,
// and never reads the relay's direct-member list (kind 13534), which is not a list of who may post.
//
// A list counts only when it is a valid event signed by the relay's own key. A room with no
// trusted list stays unread; "no answer" is never read as "nobody is in the room".

import { verifyEvent } from 'nostr-tools'

export const ROOM_MEMBERS = 39002

const roomOf = ev => ev.tags.find(t => t[0] === 'd')?.[1] || null

const HEX64 = /^[0-9a-f]{64}$/

/// The key the room relay signs its lists with: NIP-11's `self` field (NIP-43). Anything else is
/// null, and with no key no list is trusted.
export function relayKeyFrom(info) {
  const k = typeof info?.self === 'string' ? info.self.toLowerCase() : ''
  return HEX64.test(k) ? k : null
}

/// A room read by `#h` that the relay refuses ends in CLOSED "restricted: not a channel member".
/// That is a refusal to show the list, not an empty room.
export const isRoomRefusal = msg => /^restricted:\s*not a channel member/i.test(String(msg || ''))

/// Judge the lists a read returned. `asked` is the room ids the page listed; `refused` is the rooms
/// whose read the relay closed with a refusal; `relayKey` is the hex key the room relay signs with.
/// Returns `{ rooms, unread }`: `rooms` maps a room id to the Set of member keys, and `unread` maps a
/// room id to why it isn't read ('refused', 'untrusted' or 'no-list').
export function judgeRoomLists(events, { asked = [], refused = [], relayKey, verify = verifyEvent } = {}) {
  const rooms = new Map(), unread = new Map(), newest = new Map()
  for (const ev of events || []) {
    if (!ev || ev.kind !== ROOM_MEMBERS) continue
    const room = roomOf(ev)
    if (!room) continue
    if (!relayKey || ev.pubkey !== relayKey || !verify(ev)) {
      if (!newest.has(room)) unread.set(room, 'untrusted')
      continue
    }
    if (newest.has(room) && newest.get(room) >= ev.created_at) continue
    newest.set(room, ev.created_at)
    unread.delete(room)
    rooms.set(room, new Set(ev.tags.filter(t => t[0] === 'p' && HEX64.test(t[1] || '')).map(t => t[1])))
  }
  for (const room of refused) if (!rooms.has(room)) unread.set(room, 'refused')
  for (const room of asked) if (!rooms.has(room) && !unread.has(room)) unread.set(room, 'no-list')
  return { rooms, unread }
}

/// The rooms the page read that both keys are in, sorted. Empty means "not in any room you can
/// see" with it, never "doesn't hear it": rooms the owner isn't in are not read.
export function sharedRooms(a, b, rooms) {
  const out = []
  for (const [room, members] of rooms || []) if (members.has(a) && members.has(b)) out.push(room)
  return out.sort()
}

export const ROOM_NAME = 39000
export const ROOM_READ_SECS = 10
export const ROOM_RELAY_STORAGE = 'waggle.roomrelay'

/// The room relay the owner named on Config: `{ url, key }`, or null. Only a wss:// address is kept.
/// `key` is the hex signing key the owner typed, used when the relay's NIP-11 doesn't state one.
export function loadRoomRelay(storage = globalThis.localStorage) {
  let v = null
  try { v = JSON.parse(storage?.getItem(ROOM_RELAY_STORAGE) || 'null') } catch { return null }
  const url = typeof v?.url === 'string' && /^wss:\/\/[^\s/]+(\/\S*)?$/.test(v.url) ? v.url : null
  if (!url) return null
  const key = typeof v.key === 'string' && HEX64.test(v.key.toLowerCase()) ? v.key.toLowerCase() : null
  return { url, key }
}
export function saveRoomRelay({ url, key = null }, storage = globalThis.localStorage) {
  if (!/^wss:\/\/[^\s/]+(\/\S*)?$/.test(String(url || ''))) return false
  const k = key ? String(key).toLowerCase() : null
  if (k && !HEX64.test(k)) return false
  try { storage?.setItem(ROOM_RELAY_STORAGE, JSON.stringify({ url, key: k })); return true } catch { return false }
}
export function forgetRoomRelay(storage = globalThis.localStorage) {
  try { storage?.removeItem(ROOM_RELAY_STORAGE) } catch { /* private mode */ }
}

/// The relay's signing key from its NIP-11 document, or null if it doesn't answer or state one.
export async function fetchRelayKey(url, { fetch = globalThis.fetch, timeoutMs = ROOM_READ_SECS * 1000 } = {}) {
  try {
    const http = url.replace(/^wss:/, 'https:')
    const ctl = typeof AbortController === 'function' ? new AbortController() : null
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
    const r = await fetch(http, { headers: { Accept: 'application/nostr+json' }, signal: ctl?.signal })
    if (t) clearTimeout(t)
    return r.ok ? relayKeyFrom(await r.json()) : null
  } catch { return null }
}

/// The key the page checks lists against. The relay's own NIP-11 `self` wins whenever it states
/// one; the key typed on Config is used only when it doesn't. Null when neither gives one.
export async function relayKeyFor(relay, { fetchKey = fetchRelayKey } = {}) {
  if (!relay?.url) return null
  return (await fetchKey(relay.url)) || relay.key || null
}

/// The NIP-42 sign-in the owner's signer is asked for: this relay, this connection's challenge.
export const authTemplate = (url, challenge, now = Math.floor(Date.now() / 1000)) =>
  ({ kind: 22242, created_at: now, content: '', tags: [['relay', url], ['challenge', challenge]] })

/// Read every room's name and member list the owner can see, over one connection that signs in at
/// most once and is closed when the read ends. Never signs unless the relay asks, and only for the
/// challenge this connection was sent. The no-answer timer stops while the signer is asked.
/// Resolves { state, events, reason }: 'read', 'no-answer', 'declined' or 'auth-refused'.
export function readRooms({ url, sign, connect, timeoutMs = ROOM_READ_SECS * 1000 }) {
  return new Promise(resolve => {
    let ws, done = false, timer = null, challenge = null, wanted = false, signing = false, signed = false, authId = null, sub = 0
    const events = []
    const end = (state, reason = null) => {
      if (done) return; done = true; clearTimeout(timer)
      try { ws.close() } catch { /* already closed */ }
      resolve({ state, events: state === 'read' ? events : [], reason })
    }
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => end('no-answer'), timeoutMs) }
    const ask = () => { sub++; events.length = 0; ws.send(JSON.stringify(['REQ', `rooms${sub}`, { kinds: [ROOM_NAME, ROOM_MEMBERS] }])); arm() }
    const signIn = async () => {
      if (signing || signed || !challenge) return
      signing = true; clearTimeout(timer)
      let ev
      try { ev = await sign(authTemplate(url, challenge)) } catch { return end('declined') }
      if (done) return
      if (!ev?.id) return end('declined')
      signed = true; authId = ev.id
      ws.send(JSON.stringify(['AUTH', ev])); arm()
    }
    try { ws = connect(url) } catch { return end('no-answer') }
    arm()
    ws.onopen = () => ask()
    ws.onerror = () => end('no-answer')
    ws.onclose = () => end('no-answer')
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data) } catch { return }
      if (!Array.isArray(m)) return
      if (m[0] === 'AUTH' && typeof m[1] === 'string') { challenge = m[1]; if (wanted) signIn(); return }
      if (m[0] === 'OK' && m[1] === authId) return m[2] === true ? ask() : end('auth-refused', String(m[3] || ''))
      if (m[1] !== `rooms${sub}`) return
      if (m[0] === 'EVENT' && m[2]) events.push(m[2])
      else if (m[0] === 'EOSE') end('read')
      else if (m[0] === 'CLOSED') {
        const why = String(m[2] || '')
        if (/^auth-required/i.test(why) && !signed) { wanted = true; return signIn() }
        end('auth-refused', why)
      }
    }
  })
}

/// Judge a whole read: rooms are named by relay-signed 39000 events, members by 39002. A room with a
/// trusted name but no trusted list stays unread. Returns { rooms, unread, names, closed }.
export function roomsOf(events, { relayKey, verify = verifyEvent } = {}) {
  const names = new Map(), at = new Map(), closed = new Set()
  for (const ev of events || []) {
    if (ev?.kind !== ROOM_NAME || !relayKey || ev.pubkey !== relayKey) continue
    const room = roomOf(ev)
    if (!room || (at.has(room) && at.get(room) >= ev.created_at) || !verify(ev)) continue
    at.set(room, ev.created_at)
    const n = ev.tags.find(t => t[0] === 'name')?.[1]
    names.set(room, typeof n === 'string' && n.trim() ? n.trim().slice(0, 64) : null)
    // NIP-29: a closed room takes no join request; only an admin adds a member.
    if (ev.tags.some(t => t[0] === 'closed')) closed.add(room); else closed.delete(room)
  }
  return { ...judgeRoomLists(events, { asked: [...names.keys()], relayKey, verify }), names, closed }
}

/// The Needs you line for a read that didn't happen, and its button. Null when nothing is wrong.
export function roomsNeed({ relay, state, untrusted = 0, unlisted = 0, readAt = null }) {
  if (!relay) return { text: "Who is in each room isn't read: this page doesn't know your Buzz relay yet.", button: 'Add it on Config', act: 'config' }
  if (!state) return { text: "Who is in each room isn't read. Reading it takes one Bunker prompt.", button: 'Read who is in each room', act: 'read' }
  if (state === 'no-answer') return { text: "Your Buzz relay didn't answer, so who is in each room isn't read.", button: 'Read again', act: 'read' }
  if (state === 'declined') return { text: "Not read: you didn't sign in to your Buzz relay.", button: 'Read who is in each room', act: 'read' }
  if (state === 'other-signer') return { text: "Not read: you're signed in as a different key from this hive.", button: 'Read who is in each room', act: 'read' }
  if (state === 'auth-refused') return { text: "Your Buzz relay wouldn't let you sign in, so who is in each room isn't read.", button: null }
  if (state === 'no-key') return { text: "Who is in each room isn't read: your Buzz relay doesn't say which key signs its lists. Add it on Config.", button: 'Add it on Config', act: 'config' }
  const parts = []
  if (untrusted) parts.push(untrusted === 1
    ? "A room's member list came back, but not signed by your Buzz relay, so it isn't trusted."
    : `${untrusted} rooms' member lists came back, but not signed by your Buzz relay, so they aren't trusted.`)
  if (unlisted) parts.push(`${unlisted === 1 ? 'A room' : `${unlisted} rooms`} sent no member list, so who is in ${unlisted === 1 ? 'it' : 'them'} isn't read.`)
  if (parts.length) return { text: parts.join(' '), button: 'Read again', act: 'read' }
  return null
}

// Step 7 of "Add an agent" (#719): how long the page listens for the agent's answer to the test mention.
export const PROOF_WAIT_SECS = 180

/// One signed-in connection for step 7's checks. It reads `filters`, then, given an unsigned test
/// `mention`, has the owner's signer sign it once, sends it, and keeps listening until `settled(events,
/// sent)` says the answer is in or `waitMs` passes; `onSent` hears when the relay took the mention. It
/// signs in only when the relay asks, and only for this connection's challenge; the timers stop while
/// the signer is asked. Resolves { state, events, sent, reason }, where state is 'read' (no mention given), 'answered', 'waited' (sent, no answer in
/// time), 'refused' (the relay would not take the mention), 'no-answer', 'declined' or 'auth-refused'.
export function proveInRoom({ url, sign, connect, filters, mention = null, settled = () => false, onSent = () => {},
  timeoutMs = ROOM_READ_SECS * 1000, waitMs = PROOF_WAIT_SECS * 1000 }) {
  return new Promise(resolve => {
    let ws, done = false, timer = null, challenge = null, wanted = false, signing = false, signed = false, authId = null, sub = 0
    let sent = null, accepted = false
    const events = [], seen = new Set()
    const end = (state, reason = null) => {
      if (done) return; done = true; clearTimeout(timer)
      try { ws.close() } catch { /* already closed */ }
      resolve({ state, events: [...events], sent, reason })
    }
    const arm = (ms = timeoutMs, state = 'no-answer') => { clearTimeout(timer); timer = setTimeout(() => end(state), ms) }
    const ask = () => { sub++; events.length = 0; seen.clear(); ws.send(JSON.stringify(['REQ', `proof${sub}`, ...filters])); arm() }
    const send = () => { ws.send(JSON.stringify(['EVENT', sent])); arm() }
    const signIn = async () => {
      if (signing || signed || !challenge) return
      signing = true; clearTimeout(timer)
      let ev
      try { ev = await sign(authTemplate(url, challenge)) } catch { return end('declined') }
      if (done) return
      if (!ev?.id) return end('declined')
      signed = true; authId = ev.id
      ws.send(JSON.stringify(['AUTH', ev])); arm()
    }
    const mentionNow = async () => {
      if (!mention) return end('read')
      if (sent) return send()
      clearTimeout(timer)
      let ev
      try { ev = await sign(mention) } catch { return end('declined') }
      if (done) return
      if (!ev?.id) return end('declined')
      sent = ev; send()
    }
    try { ws = connect(url) } catch { return end('no-answer') }
    arm()
    ws.onopen = () => ask()
    ws.onerror = () => end('no-answer')
    ws.onclose = () => end(accepted ? 'waited' : 'no-answer')
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data) } catch { return }
      if (!Array.isArray(m)) return
      if (m[0] === 'AUTH' && typeof m[1] === 'string') { challenge = m[1]; if (wanted) signIn(); return }
      if (m[0] === 'OK' && m[1] === authId) return m[2] !== true ? end('auth-refused', String(m[3] || '')) : sent ? send() : ask()
      if (m[0] === 'OK' && sent && m[1] === sent.id) {
        if (m[2] === true) { accepted = true; arm(waitMs, 'waited'); onSent(sent); return settled(events, sent) && end('answered') }
        if (/^auth-required/i.test(String(m[3] || '')) && !signed) { wanted = true; return signIn() }
        return end('refused', String(m[3] || ''))
      }
      if (m[1] !== `proof${sub}`) return
      if (m[0] === 'EVENT' && m[2]) {
        if (seen.has(m[2].id)) return
        seen.add(m[2].id); events.push(m[2])
        if (accepted && settled(events, sent)) end('answered')
      } else if (m[0] === 'EOSE') { if (!sent) mentionNow() }
      else if (m[0] === 'CLOSED') {
        const why = String(m[2] || '')
        if (/^auth-required/i.test(why) && !signed) { wanted = true; return signIn() }
        end('auth-refused', why)
      }
    }
  })
}
