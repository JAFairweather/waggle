// console_room_lists.mjs — who is in each room is read only from lists the room relay signed (#698).
//
// The design (docs/DESIGN_HIVE_CONSOLE.md, "Who is in each room") holds three things this suite
// checks, each a way the read could quietly claim more than it saw:
//
//  1. A list signed by any key but the relay's own is never read as the room's members, and the
//     room is marked untrusted rather than empty.
//  2. A room the page asked about that sent no list stays unread. "No answer" is never "nobody".
//  3. Sharing no room the page read is not "doesn't hear it". sharedRooms only ever proves "hears".
//
//   node tests/console_room_lists.mjs

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools'
import { judgeRoomLists, sharedRooms, relayKeyFrom, isRoomRefusal, ROOM_MEMBERS, ROOM_NAME, readRooms, roomsOf, roomsNeed, authTemplate, loadRoomRelay, saveRoomRelay, fetchRelayKey, relayKeyFor } from '../console/room-lists.mjs'

let failed = 0
const ok = (cond, msg) => { if (cond) console.log(`ok   ${msg}`); else { failed++; console.log(`FAIL ${msg}`) } }

const relaySk = generateSecretKey(), relayKey = getPublicKey(relaySk)
const otherSk = generateSecretKey()
const [a, b, c] = [1, 2, 3].map(() => getPublicKey(generateSecretKey()))
// Round-trip through JSON, as a relay delivers it: finalizeEvent caches a "verified" mark on the
// object it signs, and a copy made with spread would carry that mark past an altered body.
const wire = ev => JSON.parse(JSON.stringify(ev))
const list = (sk, room, members, created_at = 1000) => wire(finalizeEvent({
  kind: ROOM_MEMBERS, created_at, content: '',
  tags: [['d', room], ...members.map(p => ['p', p, '', 'member'])],
}, sk))

// 1. Signed by the relay: read.
{
  const { rooms, unread } = judgeRoomLists([list(relaySk, 'r1', [a, b])], { asked: ['r1'], relayKey })
  ok(rooms.get('r1')?.size === 2 && rooms.get('r1').has(a) && rooms.get('r1').has(b), 'a relay-signed list names its members')
  ok(unread.size === 0, 'a read room is not unread')
}

// 1b. Signed by another key: untrusted, never read.
{
  const { rooms, unread } = judgeRoomLists([list(otherSk, 'r1', [a, b])], { asked: ['r1'], relayKey })
  ok(!rooms.has('r1'), 'a list signed by another key is not read as members')
  ok(unread.get('r1') === 'untrusted', 'that room is marked untrusted, not empty')
}

// 1c. Relay's key but a forged body: verify fails, untrusted.
{
  const ev = list(relaySk, 'r1', [a])
  const forged = { ...ev, tags: [...ev.tags, ['p', c, '', 'member']] }
  const { rooms, unread } = judgeRoomLists([forged], { asked: ['r1'], relayKey })
  ok(!rooms.has('r1') && unread.get('r1') === 'untrusted', 'an altered list with the relay key fails its signature')
}

// 1d. No relay key known: nothing is trusted.
{
  const { rooms, unread } = judgeRoomLists([list(relaySk, 'r1', [a])], { asked: ['r1'] })
  ok(rooms.size === 0 && unread.get('r1') === 'untrusted', 'without the relay key no list is trusted')
}

// 1e. A trusted list beside an untrusted one for the same room: the trusted one wins.
{
  const { rooms, unread } = judgeRoomLists([list(otherSk, 'r1', [c]), list(relaySk, 'r1', [a])], { asked: ['r1'], relayKey })
  ok(rooms.get('r1')?.has(a) && !rooms.get('r1').has(c) && !unread.has('r1'), 'a forged list does not displace the relay-signed one')
}

// 1f. Two relay lists: the newer one is the room.
{
  const { rooms } = judgeRoomLists([list(relaySk, 'r1', [a, b], 2000), list(relaySk, 'r1', [a], 1000)], { relayKey })
  ok(rooms.get('r1')?.size === 2, 'the newest relay-signed list wins regardless of arrival order')
}

// 2. Asked, no list: unread, not empty.
{
  const { rooms, unread } = judgeRoomLists([list(relaySk, 'r1', [a])], { asked: ['r1', 'r2'], relayKey })
  ok(!rooms.has('r2') && unread.get('r2') === 'no-list', 'a room that sent no list stays unread')
  ok(judgeRoomLists([], { asked: ['r3'], relayKey }).unread.get('r3') === 'no-list', 'an empty reply leaves every asked room unread')
}

// 2b. Other kinds and lists with no room id are ignored.
{
  const stray = wire(finalizeEvent({ kind: 13534, created_at: 1, content: '', tags: [['member', a]] }, relaySk))
  const noRoom = wire(finalizeEvent({ kind: ROOM_MEMBERS, created_at: 1, content: '', tags: [['p', a]] }, relaySk))
  const { rooms, unread } = judgeRoomLists([stray, noRoom, null], { relayKey })
  ok(rooms.size === 0 && unread.size === 0, "the relay's direct-member list and roomless lists are not read")
}

// 2c. A refused room is refused, not empty and not missing.
{
  const { rooms, unread } = judgeRoomLists([], { asked: ['r1', 'r2'], refused: ['r2'], relayKey })
  ok(unread.get('r2') === 'refused' && unread.get('r1') === 'no-list' && rooms.size === 0, 'a refused room is marked refused')
  ok(isRoomRefusal('restricted: not a channel member'), "the relay's refusal is recognised")
  ok(!isRoomRefusal('auth-required: sign in') && !isRoomRefusal(''), 'other CLOSED reasons are not a room refusal')
}

// 2d. The relay key comes from NIP-11's `self`, and nothing else.
{
  ok(relayKeyFrom({ self: relayKey.toUpperCase() }) === relayKey, "NIP-11's self field is the relay key")
  ok(relayKeyFrom({ pubkey: relayKey }) === null, "NIP-11's operator pubkey is not the signing key")
  ok(relayKeyFrom({ self: 'npub1xyz' }) === null && relayKeyFrom(null) === null, 'a malformed or missing self gives no key')
}

// 3. Shared rooms prove hearing only.
{
  const { rooms } = judgeRoomLists([list(relaySk, 'r2', [a, b]), list(relaySk, 'r1', [a, b, c]), list(relaySk, 'r3', [c])], { relayKey })
  ok(JSON.stringify(sharedRooms(a, b, rooms)) === '["r1","r2"]', 'shared rooms are named, sorted')
  ok(sharedRooms(a, c, rooms).length === 1, 'only rooms both are in count')
  ok(sharedRooms(b, getPublicKey(generateSecretKey()), rooms).length === 0, 'no shared visible room is an empty answer, not a refusal')
}

// 4. The read: one connection, signs in once on the relay's own challenge, then closes.
const URL_ = 'wss://rooms.example'
function fakeRelay(script) {
  const sent = [], ws = { closed: false, send: m => { sent.push(JSON.parse(m)); script(JSON.parse(m), ws) }, close() { ws.closed = true } }
  ws.say = m => setTimeout(() => ws.onmessage?.({ data: JSON.stringify(m) }))
  return { ws, sent, connect: () => { setTimeout(() => { ws.say(['AUTH', 'chal-1']); ws.onopen?.() }); return ws } }
}
const ownerSk = generateSecretKey()
const named = (sk, room, name) => wire(finalizeEvent({ kind: ROOM_NAME, created_at: 1000, content: '', tags: [['d', room], ['name', name]] }, sk))
{
  let asked = 0, signedFor = null
  const r = fakeRelay((m, ws) => {
    if (m[0] === 'REQ' && m[1] === 'rooms1') ws.say(['CLOSED', 'rooms1', 'auth-required: sign in'])
    if (m[0] === 'AUTH') ws.say(['OK', m[1].id, true, ''])
    if (m[0] === 'REQ' && m[1] === 'rooms2') { ws.say(['EVENT', 'rooms2', named(relaySk, 'r1', 'general')]); ws.say(['EVENT', 'rooms2', list(relaySk, 'r1', [a, b])]); ws.say(['EOSE', 'rooms2']) }
  })
  const out = await readRooms({ url: URL_, connect: r.connect, sign: async t => { asked++; signedFor = t; return finalizeEvent(t, ownerSk) } })
  ok(out.state === 'read' && out.events.length === 2, 'a signed-in read returns the lists')
  ok(asked === 1, 'the signer is asked exactly once')
  ok(signedFor.kind === 22242 && signedFor.tags.some(t => t[0] === 'challenge' && t[1] === 'chal-1') && signedFor.tags.some(t => t[0] === 'relay' && t[1] === URL_), "the sign-in is for this relay and this connection's challenge")
  ok(r.ws.closed, 'the connection is closed when the read ends')
  ok(JSON.stringify(r.sent.find(m => m[0] === 'REQ')[2]) === JSON.stringify({ kinds: [ROOM_NAME, ROOM_MEMBERS] }), 'one request, room names and member lists only')
  const { rooms, names, unread } = roomsOf(out.events, { relayKey })
  ok(rooms.get('r1')?.has(a) && names.get('r1') === 'general' && unread.size === 0, 'roomsOf names the room and its members')
}
{
  const r = fakeRelay((m, ws) => {
    if (m[0] === 'REQ') ws.say(['CLOSED', m[1], 'auth-required: sign in'])
    if (m[0] === 'AUTH') ws.say(['OK', m[1].id, false, 'restricted: not a relay member'])
  })
  const out = await readRooms({ url: URL_, connect: r.connect, sign: async t => finalizeEvent(t, ownerSk) })
  ok(out.state === 'auth-refused' && out.events.length === 0 && r.ws.closed, 'a refused sign-in is reported and the socket closed')
}
{
  const r = fakeRelay((m, ws) => { if (m[0] === 'REQ') ws.say(['CLOSED', m[1], 'auth-required: sign in']) })
  const out = await readRooms({ url: URL_, connect: r.connect, sign: async () => { throw new Error('declined') } })
  ok(out.state === 'declined' && !r.sent.some(m => m[0] === 'AUTH'), 'a declined prompt sends no sign-in')
}
{
  let asked = 0
  const r = fakeRelay(() => {})
  const out = await readRooms({ url: URL_, connect: r.connect, sign: async () => { asked++ }, timeoutMs: 30 })
  ok(out.state === 'no-answer' && asked === 0, 'a silent relay is no-answer, and the signer is never asked')
}
{
  const r = fakeRelay((m, ws) => { if (m[0] === 'REQ') { ws.say(['EVENT', m[1], list(relaySk, 'r9', [a])]); ws.say(['EOSE', m[1]]) } })
  let asked = 0
  const out = await readRooms({ url: URL_, connect: r.connect, sign: async () => { asked++ } })
  ok(out.state === 'read' && asked === 0, 'a relay that asks for no sign-in gets none')
  const got = roomsOf(out.events, { relayKey })
  ok(got.rooms.get('r9')?.has(a) && !got.names.has('r9'), 'a relay-signed list is read even when its room name did not come back')
}
ok(authTemplate(URL_, 'c', 5).created_at === 5 && authTemplate(URL_, 'c').content === '', 'the sign-in template is plain')

// 5. Config: only a wss address, and only a hex key.
{
  const mem = new Map(), st = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) }
  ok(loadRoomRelay(st) === null, 'no room relay until the owner names one')
  ok(!saveRoomRelay({ url: 'https://rooms.example' }, st) && !saveRoomRelay({ url: URL_, key: 'npub1x' }, st), 'a non-wss address or a non-hex key is refused')
  ok(saveRoomRelay({ url: URL_, key: relayKey.toUpperCase() }, st) && loadRoomRelay(st).key === relayKey, 'a wss address and hex key are kept')
  ok(loadRoomRelay({ getItem: () => { throw new Error('blocked') } }) === null, 'blocked storage reads as no room relay')
}
{
  const k = await fetchRelayKey(URL_, { fetch: async (u, o) => ({ ok: u === 'https://rooms.example' && o.headers.Accept === 'application/nostr+json', json: async () => ({ self: relayKey }) }) })
  ok(k === relayKey, "the relay key is fetched from the relay's own NIP-11")
  ok(await fetchRelayKey(URL_, { fetch: async () => { throw new Error('cors') } }) === null, 'a blocked NIP-11 read gives no key')
}

// 5b. The relay's published key wins over one typed on Config; Config is only the fallback.
{
  const typed = getPublicKey(generateSecretKey())
  ok(await relayKeyFor({ url: URL_, key: typed }, { fetchKey: async () => relayKey }) === relayKey, "NIP-11's self wins over a conflicting Config key")
  ok(await relayKeyFor({ url: URL_, key: typed }, { fetchKey: async () => null }) === typed, 'the Config key is used only when NIP-11 states none')
  ok(await relayKeyFor({ url: URL_, key: null }, { fetchKey: async () => null }) === null && await relayKeyFor(null) === null, 'neither gives no key')
  const page = (await import('node:fs')).readFileSync(new URL('../console/hive.html', import.meta.url), 'utf8')
  ok(/const squareCtx = \(\) => \(\{[^\n]*\brooms: hive\.rooms\b/.test(page), 'every square is judged with the rooms the page read')
  ok(/const key = await relayKeyFor\(relay\)/.test(page) && !/relay\.key \|\|/.test(page), 'the page chooses its key through relayKeyFor')
}

// 6. Needs you: one line per case, each with the button the design names.
{
  ok(roomsNeed({ relay: null }).act === 'config', 'no address: Add it on Config')
  ok(roomsNeed({ relay: {}, state: null }).button === 'Read who is in each room', 'not yet read: one prompt, on the click')
  ok(roomsNeed({ relay: {}, state: 'no-answer' }).button === 'Read again', 'no answer: Read again')
  ok(roomsNeed({ relay: {}, state: 'declined' }).button === 'Read who is in each room', 'declined: read again from the start')
  ok(roomsNeed({ relay: {}, state: 'auth-refused' }).button === null, 'refused sign-in: no button')
  ok(/not signed by your Buzz relay/.test(roomsNeed({ relay: {}, state: 'read', untrusted: 1 }).text), 'an untrusted list says so')
  ok(roomsNeed({ relay: {}, state: 'read' }) === null, 'a clean read needs nothing')
  const both = roomsNeed({ relay: {}, state: 'read', untrusted: 2, unlisted: 3 }).text
  ok(/^2 rooms' member lists came back, but not signed by your Buzz relay/.test(both) && /3 rooms sent no member list/.test(both), 'untrusted and missing lists are both counted in one line')
  ok(roomsNeed({ relay: {}, state: 'read', unlisted: 1 }).text === "A room sent no member list, so who is in it isn't read.", 'one missing list reads in the singular')
}

if (failed) { console.log(`\n${failed} failed`); process.exit(1) }
console.log('\nall room-list checks passed')
