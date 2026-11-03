// console_owner_view.mjs — whom an agent can mention, opened from its card's sealed owner_view, and
// the one-way flag on the grid (#691, docs/DESIGN_MENTION_RIGHTS.md, step 3).
//
// What this suite holds:
//
//  1. Before anything is opened the card is checked: its signature, that its author is the agent,
//     its kind and d tag, and one copy sealed to this owner. Each failure is "can't tell" with its
//     own reason, and the signer is never asked to open anything for a card that failed.
//  2. A reply-only card (may_post null) is its own state and needs no opening.
//  3. The opened list is held to nvoy's form: every field, no other, one entry per key, one key per
//     name, a refused grant on no entry. A list that breaks any of these is "can't tell", never
//     "nobody"; a legitimate list, a bare-key manifest entry included, still reads.
//  4. A square is flagged one-way only when it is on (by nvoy or by Buzz), the agent's list is
//     readable, and the giver is neither on it nor the agent. A voice is checked as its own key.
//  5. The count line under the grid and the row's named list say what they mean, and a list that
//     can't be read is said rather than counted as no pair.
//
// Every key is synthetic.
//
//   node tests/console_owner_view.mjs

import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, nip44 } from 'nostr-tools'
import { sealedFor, viewsFor, viewShape, openOwnerView, oneWay, oneWayLine, mentionLines, REPLY_ONLY, WHY, CARD_KIND, CARD_D } from '../console/owner-view.mjs'
import { readCards } from '../console/hive-list.mjs'
import { cellOf, agentsOf } from '../console/hive-grid.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const key = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) } }
const owner = key(), cograntor = key(), agent = key(), other = key(), giver = key(), voice = key(), peer = key()
const id = n => n.toString(16).padStart(64, '0')
const g1 = id(1), g2 = id(2), g3 = id(3)

const view = {
  mention: [
    { name: 'peer', pubkey: peer.pk, source: 'manifest', grants: [g2] },
    { name: null, pubkey: owner.pk, source: 'manifest', grants: [] },
    { name: 'giver', pubkey: giver.pk, source: 'grant', grants: [g1] },
  ],
  refused: [{ grant: g3, reason: 'the name peer is held by ' + peer.pk.slice(0, 8) }],
  channels: [{ id: '00000000-0000-4000-8000-000000000000', name: null }],
}
// Sealed as nvoy seals it: one fresh key per publication, a copy for each grantor.
function seal(json, recipients) {
  const one = generateSecretKey(), by = getPublicKey(one)
  return recipients.map(to => ({ to, by, sealed: nip44.encrypt(json, nip44.getConversationKey(one, to)) }))
}
const body = (extra = {}) => ({ version: 1, pubkey: agent.pk, grantors: [owner.pk, cograntor.pk], may_post: { channels: 1, per_hour: 5, mentions: 2 },
  owner_view: seal(JSON.stringify(view), [owner.pk, cograntor.pk]), ...extra })
let clock = 1_700_000_000
// As a relay serves it: plain JSON. finalizeEvent marks its result verified, and a spread copy
// carries that mark, so a tampered copy would pass verifyEvent without the round trip.
const card = (content, { by = agent, kind = CARD_KIND, d = CARD_D } = {}) => JSON.parse(JSON.stringify(
  finalizeEvent({ kind, created_at: clock++, tags: [['d', d]], content: typeof content === 'string' ? content : JSON.stringify(content) }, by.sk)))

let asked = 0
const decryptAs = who => async (by, sealed) => { asked++; return nip44.decrypt(sealed, nip44.getConversationKey(who.sk, by)) }
const ctx = { owner: owner.pk, agent: agent.pk, verify: verifyEvent, decrypt: decryptAs(owner) }
const open = (ev, extra = {}) => openOwnerView(ev, { ...ctx, ...extra })
const why = async (ev, extra) => { const r = await open(ev, extra); return r.state === 'cant-tell' ? r.why : r.state }

// --- 1. the checks before opening ---
const good = card(body())
const readable = await open(good)
check(readable.state === 'readable' && JSON.stringify(readable.view) === JSON.stringify(view) && readable.eventId === good.id,
  'a card the agent signed, with a copy sealed to you, opens to its list')
check(sealedFor(good, ctx).state === 'sealed', 'before opening, the same card is sealed and ready')
check((await open(good, { owner: cograntor.pk, decrypt: decryptAs(cograntor) })).state === 'readable', 'each grantor opens its own copy')

asked = 0
// From a fresh copy: opening `good` above marked that object verified, and a spread would carry it.
const tampered = { ...JSON.parse(JSON.stringify(good)), content: good.content.replace('"per_hour":5', '"per_hour":6') }
check(tampered.content !== good.content, 'fixture: the tampered card says something different')
const failing = [
  ['no card', null, 'no-card'],
  ['a bad signature', tampered, 'bad-signature'],
  ['a signature check that throws', good, 'bad-signature', { verify: () => { throw new Error('boom') } }],
  ['a card signed by another key', card(body({ pubkey: other.pk }), { by: other }), 'not-its-card'],
  ['a card naming the agent but signed by another key', card(body(), { by: other }), 'not-its-card'],
  ['the right card asked of another agent', good, 'not-its-card', { agent: other.pk }],
  ['a different kind', card(body(), { kind: 30079 }), 'not-its-card'],
  ['a different d tag', card(body(), { d: 'nvoy-agent-card-old' }), 'not-its-card'],
  ['a card describing another key', card(body({ pubkey: other.pk })), 'not-its-card'],
  ['content that is not JSON', card('not json'), 'unreadable-card'],
  ['a card with no may_post at all', card(body({ may_post: undefined })), 'unreadable-card'],
  ['no owner_view', card(body({ owner_view: undefined })), 'no-view'],
  ['an owner_view that is not a list', card(body({ owner_view: { to: owner.pk } })), 'bad-shape'],
  ['no copy sealed to you', card(body({ owner_view: seal(JSON.stringify(view), [cograntor.pk]) })), 'not-for-you'],
  ['an empty owner_view', card(body({ owner_view: [] })), 'not-for-you'],
  ['two copies sealed to you', card(body({ owner_view: [...seal(JSON.stringify(view), [owner.pk]), ...seal('{}', [owner.pk])] })), 'bad-shape'],
  ['a sealing key that is not a key', card(body({ owner_view: seal(JSON.stringify(view), [owner.pk]).map(e => ({ ...e, by: 'npub1x' })) })), 'bad-shape'],
  ['an empty sealed field', card(body({ owner_view: [{ to: owner.pk, by: agent.pk, sealed: '' }] })), 'bad-shape'],
]
for (const [label, ev, want, extra] of failing) check(await why(ev, extra) === want, `${label} is "can't tell": ${want}`)
check(asked === 0, 'the signer is never asked to open a card that failed a check')

check(await why(good, { decrypt: async () => { throw new Error('refused') } }) === 'decrypt-failed', 'a signer that refuses is "can\'t tell": decrypt-failed')
check(await why(good, { decrypt: async () => undefined }) === 'decrypt-failed', 'a signer that returns nothing is "can\'t tell": decrypt-failed')
check(await why(good, { decrypt: decryptAs(other) }) === 'decrypt-failed', 'a key the copy was not sealed to cannot open it')

// --- 2. reply-only ---
asked = 0
check((await open(card(body({ may_post: null, owner_view: undefined })))).state === 'reply-only', 'a card with may_post null is reply-only')
check((await open(card(body({ may_post: null })))).state === 'reply-only', 'reply-only stays reply-only even if a view is attached')
check(asked === 0, 'reply-only asks the signer for nothing')
check(await why({ ...card(body({ may_post: null })), sig: '00'.repeat(64) }) === 'bad-signature', 'an unsigned reply-only card is "can\'t tell", not reply-only')

// --- 3. the shape of the opened list ---
const shaped = v => viewShape(JSON.stringify(v))
const entry = (patch, i = 0) => ({ ...view, mention: view.mention.map((e, j) => j === i ? { ...e, ...patch } : e) })
check(!!shaped(view), 'nvoy\'s form reads, with a bare-key manifest entry (name null) among them')
check(!!shaped({ mention: [], refused: [], channels: [] }), 'an empty list reads: that is a real answer, "nobody by name"')
const broken = [
  ['an unknown top-level field', { ...view, extra: 1 }],
  ['a missing channels field', { mention: view.mention, refused: view.refused }],
  ['mention not a list', { ...view, mention: {} }],
  ['an entry with an extra field', entry({ note: 'x' })],
  ['an entry with no grants field', { ...view, mention: [{ name: 'peer', pubkey: peer.pk, source: 'manifest' }] }],
  ['a pubkey that is not lowercase hex', entry({ pubkey: peer.pk.toUpperCase() })],
  ['a name that breaks the rule', entry({ name: 'My Dude' })],
  ['a name that is a number', entry({ name: 7 })],
  ['an unknown source', entry({ source: 'buzz' })],
  ['a grant id that is not an id', entry({ grants: ['abc'] })],
  ['a grant entry with no grant', entry({ grants: [] }, 2)],
  ['a grant entry with no name', entry({ name: null }, 2)],
  ['two entries for one key', { ...view, mention: [...view.mention, { name: 'again', pubkey: peer.pk, source: 'grant', grants: [id(9)] }] }],
  ['two keys for one name, case-folded', { ...view, mention: [...view.mention, { name: 'PEER', pubkey: other.pk, source: 'grant', grants: [id(9)] }] }],
  ['one grant id on two entries', entry({ grants: [g2] }, 2)],
  ['a refused grant that is also on an entry', { ...view, refused: [{ grant: g1, reason: 'clash' }] }],
  ['a refusal with no reason', { ...view, refused: [{ grant: g3, reason: '' }] }],
  ['a refusal with an extra field', { ...view, refused: [{ grant: g3, reason: 'x', by: 'y' }] }],
  ['a channel with no id', { ...view, channels: [{ id: '', name: null }] }],
  ['a channel name that is not text', { ...view, channels: [{ id: 'c', name: 5 }] }],
]
for (const [label, v] of broken) check(shaped(v) === null, `${label} is refused`)
check(viewShape('not json') === null && viewShape('null') === null && viewShape('[]') === null, 'plaintext that is not an object is refused')
const badList = card(body({ owner_view: seal(JSON.stringify({ ...view, extra: 1 }), [owner.pk]) }))
check(await why(badList) === 'bad-shape', 'a list in the wrong form is "can\'t tell": bad-shape, never "nobody"')

// The page reads cards through readCards, which keeps the event the view rests on.
const cards = readCards([good], { owner: owner.pk, verify: verifyEvent })
check(cards.get(agent.pk)?.event?.id === good.id && sealedFor(cards.get(agent.pk).event, ctx).state === 'sealed', 'readCards keeps the signed event, and it checks the same')

// --- 4. the one-way flag ---
const on = { on: true, giver: other.pk, agent: agent.pk, view: readable }
check(oneWay(on) === true, 'on, readable, and the giver is not on the list: flagged')
check(oneWay({ ...on, giver: giver.pk }) === false, 'the giver is on the list (by grant): not flagged')
check(oneWay({ ...on, giver: peer.pk }) === false, 'the giver is on the list (set on the fleet host): not flagged')
check(oneWay({ ...on, giver: agent.pk }) === false, 'the giver is the agent itself: not flagged')
check(oneWay({ ...on, on: false }) === false, 'the square is off: not flagged')
check(oneWay({ ...on, view: { state: 'reply-only' } }) === false, 'a reply-only agent carries no flags')
check(oneWay({ ...on, view: { state: 'cant-tell', why: 'no-view' } }) === false && oneWay({ ...on, view: undefined }) === false, "an agent whose list can't be read carries no flags")
check(oneWay({ ...on, view: { state: 'readable', view: { mention: [], refused: [], channels: [] } } }) === true, 'an empty readable list flags every giver')

// The squares as the grid computes them, by nvoy's fold and by Buzz.
const taker = (givers, extra = {}) => ({ pubkey: agent.pk, roles: [], card: { grantors: [owner.pk] }, answers: { work: { givers } }, ...extra })
const square = (row, from, opts = {}) => cellOf(row, { pubkey: from }, { owner: owner.pk, grants: [], subjectOf: h => h, ...opts })
const viaNvoy = taker([{ pubkey: other.pk, caps: ['task'], voice: false }])
check(oneWay({ on: square(viaNvoy, other.pk).on, giver: other.pk, agent: agent.pk, view: readable }) === true, 'an nvoy square that is on is flagged')
check(oneWay({ on: square(viaNvoy, cograntor.pk).on, giver: cograntor.pk, agent: agent.pk, view: readable }) === false, 'an nvoy square that is off is not')
check(oneWay({ on: square(viaNvoy, agent.pk).on, giver: agent.pk, agent: agent.pk, view: readable }) === false, 'its own square is not')
const buzz = { known: true, signedAt: clock, lists: new Map([[agent.pk, new Set([other.pk])]]) }
const viaBuzz = taker([])
check(square(viaBuzz, other.pk, { buzz }).buzz === true, 'fixture: the square is Buzz\'s answer, with nvoy giving nothing')
check(oneWay({ on: square(viaBuzz, other.pk, { buzz }).on, giver: other.pk, agent: agent.pk, view: readable }) === true, 'a Buzz-only square that is on is flagged')
check(oneWay({ on: square(viaBuzz, cograntor.pk, { buzz }).on, giver: cograntor.pk, agent: agent.pk, view: readable }) === false, 'a Buzz square off the allow-list is not')
check(oneWay({ on: square(viaBuzz, other.pk, { buzz: { known: false, lists: null } }).on, giver: other.pk, agent: agent.pk, view: readable }) === false, 'a Buzz square that is unknown is not')

// The voice: its own key gives the work, so a list naming only the voice's owner still flags it.
const viaVoice = taker([{ pubkey: voice.pk, caps: ['task'], voice: true }, { pubkey: owner.pk, caps: ['task'], voice: false }])
check(square(viaVoice, voice.pk).on && square(viaVoice, owner.pk).on, 'fixture: the voice and its owner can both give it work')
check(oneWay({ on: square(viaVoice, voice.pk).on, giver: voice.pk, agent: agent.pk, view: readable }) === true, 'the voice is flagged though its owner is on the list')
check(oneWay({ on: square(viaVoice, owner.pk).on, giver: owner.pk, agent: agent.pk, view: readable }) === false, "the voice's owner, on the list, is not")

// Acceptance 5: a reply-only agent given work carries no flag, whoever gives it.
const replyOnly = await open(card(body({ may_post: null, owner_view: undefined })))
check(oneWay({ on: square(viaNvoy, other.pk).on, giver: other.pk, agent: agent.pk, view: replyOnly }) === false, 'a reply-only agent given work by a key it cannot mention shows no flag')

// --- 5. what the page says ---
const names = new Map([[owner.pk, 'you'], [other.pk, 'Dennis'], [agent.pk, 'Pi Dog'], [voice.pk, 'Your voice'], [giver.pk, 'MC Claude']])
const shortKey = pk => `npub1${pk.slice(0, 6)}…`
// As the page's nameOf: a key with no name is its short key.
const nameOf = pk => names.get(pk) || shortKey(pk)
check(oneWayLine([{ giver: other.pk, agent: agent.pk }], { nameOf, readable: 1 }) === "1 one-way pair: Dennis → Pi Dog. That agent can't mention its giver back.", 'one pair: "1 one-way pair", named')
check(oneWayLine([{ giver: other.pk, agent: agent.pk }, { giver: voice.pk, agent: agent.pk }], { nameOf, readable: 1 }) ===
  "2 one-way pairs: Dennis → Pi Dog, Your voice → Pi Dog. Each agent can't mention its giver back.", 'two pairs: plural, each named')
check(oneWayLine([], { nameOf, readable: 2 }) === 'No one-way pairs among the agents whose lists you can read.', 'no pairs says whose lists it read')
check(oneWayLine([], { nameOf, readable: 0, unread: 0 }) === '', 'nothing read and nothing unread says nothing')
check(oneWayLine([], { nameOf, readable: 0, unread: 3 }) === "3 agents' lists can't be read, so they are not checked.", 'only unreadable lists: never "no pairs"')
check(oneWayLine([{ giver: other.pk, agent: agent.pk }], { nameOf, readable: 1, unread: 1 }).endsWith(" 1 agent's list can't be read, so it is not checked."), 'an unread list is said beside the pairs')

const said = mentionLines(readable, { nameOf, shortKey })
check(!said.unknown && said.lines[0] === `@peer · npub1${peer.pk.slice(0, 6)}… · set on the fleet host`, 'a manifest entry says "set on the fleet host", with its short key')
check(said.lines[1] === `no @name · you, npub1${owner.pk.slice(0, 6)}… · set on the fleet host`, 'a bare-key entry says it has no @name, and who it is')
check(said.lines[2] === `@giver · MC Claude, npub1${giver.pk.slice(0, 6)}… · by a mention grant`, 'a grant entry says so')
check(said.lines[3] === `Refused: grant ${g3.slice(0, 10)}…, the name peer is held by ${peer.pk.slice(0, 8)}`, 'a refused grant is listed with its reason')
check(mentionLines({ state: 'readable', view: { mention: [], refused: [], channels: [] } }, { nameOf, shortKey }).lines[0] === 'Nobody by name.', 'an empty readable list says nobody by name')
check(mentionLines({ state: 'reply-only' }, { nameOf, shortKey }).lines[0] === REPLY_ONLY &&
  REPLY_ONLY === 'It may only reply: it answers whoever gave the work, and can bring no one else in. Changing that is a fleet change.', 'a reply-only row says it may only reply, in the design\'s words')
const unread = mentionLines({ state: 'cant-tell', why: 'no-view' }, { nameOf, shortKey })
check(unread.unknown && unread.lines[0] === `Can't tell who it can mention: ${WHY['no-view']}.`, 'a list that can\'t be read says "can\'t tell who it can mention", and why')
check(Object.keys(WHY).every(k => typeof WHY[k] === 'string' && WHY[k].length), 'every reason has words')

// A taker with no card (#693 review): the grid shows it because it has work approvals, so it gets a
// view, reads "can't tell", carries no flag, and is counted as a list that can't be read.
const cardless = { pubkey: peer.pk, roles: [], card: null, answers: { work: { givers: [{ pubkey: owner.pk, caps: ['task'], voice: false }] } } }
const shown = agentsOf([cardless]).groups.flatMap(g => g.rows.map(r => r.pubkey))
check(shown.includes(peer.pk), 'a taker with work approvals and no card is on the chart')
const noCard = viewsFor({ cards: new Map(), takers: shown, owner: owner.pk, verify: verifyEvent }).get(peer.pk)
check(noCard?.state === 'cant-tell' && noCard.why === 'no-card', "it gets a view of its own: can't tell, because it has no card")
check(mentionLines(noCard, { nameOf, shortKey }).lines[0] === `Can't tell who it can mention: ${WHY['no-card']}.`, "its row says can't tell who it can mention, and why")
check(oneWay({ on: true, giver: owner.pk, agent: peer.pk, view: noCard }) === false, 'and none of its squares is flagged')
check(oneWayLine([], { nameOf, unread: 1, readable: 0 }) === "1 agent's list can't be read, so it is not checked.", "a chart of cardless takers still says its lists can't be read")
const kept = viewsFor({ cards: new Map([[peer.pk, { event: null }]]), takers: [peer.pk], owner: owner.pk, verify: verifyEvent }).get(peer.pk)
check(kept.why === 'no-card', 'a card entry wins over the taker default, and an empty one is no card either')

if (!pass) { console.log('\nconsole_owner_view: FAIL'); process.exit(1) }
console.log('\nconsole_owner_view: ok')
