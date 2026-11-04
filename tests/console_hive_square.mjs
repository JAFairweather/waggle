// console_hive_square.mjs — one square of the hive grid and its side panel (#698).
//
// docs/DESIGN_HIVE_CONSOLE.md, "The square" and "Clicking a square". What this suite holds:
//
//  1. Each of the five states comes from the gate the spec names: ✓ an approval read in full, ! the
//     taker's readable list leaves the giver out, blank no approval, ? no settings or a short read,
//     and a pending change wins over all of them.
//  2. A Buzz square read from your copy is the copy mark, never a plain ✓, and says Buzz's own list
//     isn't read; a copy that leaves the giver out is ?, never blank.
//  3. Every panel says the post's arrival and the agent's presence aren't read. No panel claims either.
//  4. The panel's one button: Let / Stop it / Undo, and a disabled one naming who can change it.
//  5. The words keep the spec's plain vocabulary.
//  6. A square's "Show who B can @mention" opens only B's private list; Needs you's "Show it" opens all.
//  7. Once the room lists are read, a blank square splits into "hears it, won't act" and "not in any
//     room you can see with it", only when both are in a room the page read and every room's list was
//     trusted. Otherwise it keeps today's line, and "hears it" always names the room.
//
// Every key is synthetic.
//
//   node tests/console_hive_square.mjs

import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import { readFileSync } from 'node:fs'
import { panelOf, backOf, listsToOpen, ANSWER, GLYPH, LEGEND } from '../console/hive-square.mjs'
import { cellOf } from '../console/hive-grid.mjs'
import { readGrants, scopeTable, answersFor, PLATFORMS } from '../console/hive-list.mjs'
import { scopeHash } from '../console/scope-hash.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const key = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) } }
const SALT = '00112233445566778899aabbccddeeff'

const owner = key(), pi = key(), mc = key(), person = key(), bz = key(), luke = key()
// A recognised agent that publishes no settings: one of the known lab keys, public.
const bare = { pk: PLATFORMS.find(x => x.id === 'lab').keys[0] }
const NAMES = new Map([[owner.pk, 'you'], [pi.pk, 'Pi Dog'], [mc.pk, 'MC Claude'], [person.pk, 'Dennis'], [bz.pk, 'Buzz Bee'], [luke.pk, 'Luke'], [bare.pk, 'Dead Rabbit']])
const nameOf = pk => NAMES.get(pk) || pk.slice(0, 8)

const grant = async (by, grantee, agent, cap, at) => finalizeEvent({ kind: 440, created_at: at, content: '',
  tags: [['p', grantee], ['da-scope', await scopeHash(agent, SALT), SALT], ['da-cap', cap]] }, by.sk)
// Pi Dog may give MC Claude work, by your approval. Luke lets you give Pi Dog work.
const piTasksMc = await grant(owner, pi.pk, mc.pk, 'task', 1700000000)
const lukeTasksPi = await grant(luke, owner.pk, pi.pk, 'task', 1700000001)

async function hive(events, { partial = false, buzz = null, views = new Map() } = {}) {
  const { grants } = readGrants(events, { verify: verifyEvent })
  const table = await scopeTable([owner.pk, pi.pk, mc.pk, person.pk, bz.pk, luke.pk, bare.pk], grants, scopeHash)
  const card = (pk, grantors = [owner.pk]) => ({ pubkey: pk, grantors, signedAt: 1700000100, may_post: { channels: 1 } })
  const rows = [
    { pubkey: owner.pk, isOwner: true },
    { pubkey: pi.pk, card: card(pi.pk, [owner.pk, luke.pk]) },
    { pubkey: mc.pk, card: card(mc.pk) },
    { pubkey: person.pk },
    { pubkey: bz.pk },
    { pubkey: luke.pk },
    { pubkey: bare.pk },
  ]
  for (const r of rows) r.answers = answersFor(r, { owner: owner.pk, grantEvents: events, table })
  const byKey = new Map(rows.map(r => [r.pubkey, r]))
  const ctx = { owner: owner.pk, nameOf, grants, subjectOf: table.subjectOf, views, buzz, partial: { approvals: partial } }
  const square = (taker, giver, change = null) => {
    const t = byKey.get(taker), g = byKey.get(giver)
    const cell = cellOf(t, g, { owner: owner.pk, grants, subjectOf: table.subjectOf, buzz })
    return panelOf({ taker: t, giver: g, cell, change, ctx })
  }
  return { row: pk => byKey.get(pk), ctx, square }
}
const readable = (mention = []) => ({ state: 'readable', signedAt: 1700000100, view: { mention, refused: [], channels: [] } })
const NOT_READ = /(post|your post) reaches .* isn't read yet: that needs each room's member list\. Whether .* is connected right now isn't read either\./

// ── 1. The five states ───────────────────────────────────────────────────────────────────────────
{
  const both = new Map([[mc.pk, readable([{ name: 'pi', pubkey: pi.pk, source: 'manifest', grants: [] }])]])
  const h = await hive([piTasksMc], { views: both })
  const work = h.square(mc.pk, pi.pk)
  check(work.sq.kind === 'work' && GLYPH.work === '✓', 'an approval read in full, and the taker can mention the giver back: ✓')
  check(work.title === 'Pi Dog → MC Claude' && work.answer === ANSWER.work, 'the panel is headed giver → taker, with the answer')
  check(work.reasons[0] === 'You let Pi Dog give MC Claude work.' && work.reasons[1] === 'MC Claude can @mention Pi Dog back as @pi.', 'the approval line, then the answer-back line')
  check(work.acts === 'MC Claude asks before acting on it.', "nvoy's own rule says whether it acts without asking")

  const oneWayHive = await hive([piTasksMc], { views: new Map([[mc.pk, readable([])]]) })
  const blocked = oneWayHive.square(mc.pk, pi.pk)
  check(blocked.sq.kind === 'blocked' && GLYPH.blocked === '!', "the taker's readable list leaves the giver out: !")
  check(blocked.reasons[1] === "Pi Dog isn't on MC Claude's @mention list, so MC Claude can't bring Pi Dog back in by name.", '! says who cannot be brought back in, by name')

  const sealed = await hive([piTasksMc], { views: new Map([[mc.pk, { state: 'cant-tell', why: 'not-opened', event: {} }]]) })
  const priv = sealed.square(mc.pk, pi.pk)
  check(priv.sq.kind === 'work' && priv.showPrivate && /keeps who it can @mention private to you/.test(priv.reasons[1]), 'a private list keeps ✓, says so, and offers to show it')

  const none = h.square(pi.pk, mc.pk)
  check(none.sq.kind === 'none' && GLYPH.none === '' && none.reasons[0] === 'Nobody has let MC Claude give Pi Dog work.', 'no approval: blank, and says nobody approved it')

  const noCard = h.square(bare.pk, pi.pk)
  check(noCard.sq.kind === 'unknown' && /Dead Rabbit doesn't publish its settings, so who it takes work from is assumed, not read\./.test(noCard.reasons[0]), 'no settings published: ?, and says the rules are assumed')
  const short = await hive([piTasksMc], { partial: true, views: both })
  const s = short.square(mc.pk, pi.pk)
  check(s.sq.kind === 'unknown' && /may be missing\. Read again\./.test(s.reasons[0]), 'a short read is ?, even with the approval seen')

  const add = h.square(pi.pk, mc.pk, 'add'), remove = h.square(mc.pk, pi.pk, 'remove')
  check(add.sq.kind === 'add' && add.sq.base === 'none' && /^Your change, not signed yet/.test(add.reasons[0]), 'a pending change wins the square and says it is not signed')
  check(remove.sq.kind === 'remove' && remove.button.label === 'Undo', 'and its button is Undo')
  check(h.square(pi.pk, pi.pk).sq.kind === 'self', 'an agent meets itself in a square that says nothing')
  check(h.square(person.pk, pi.pk).sq.kind === 'person' && h.square(person.pk, pi.pk).button === null, 'a person takes no work through the page, and has no button')
}

// ── 2. Buzz: your copy, never Buzz's own ─────────────────────────────────────────────────────────
{
  const lists = new Map([[bz.pk, new Set([mc.pk])]])
  const h = await hive([piTasksMc], { buzz: { lists, known: true } })
  const on = h.square(bz.pk, mc.pk)
  check(on.sq.kind === 'copy' && GLYPH.copy === '✓' && on.answer === ANSWER.copy, 'the copy lists the giver: ✓ with the copy mark, not a plain ✓')
  check(/Buzz's own list isn't read\./.test(on.reasons[0]) && /copy of Buzz Bee's Buzz allow-list/.test(on.source), "it says Buzz's own list isn't read, and names the copy as its source")
  check(on.button.disabled && on.button.label === 'Change it in Buzz Desktop', 'the page never offers to change a Buzz square')
  const off = h.square(bz.pk, pi.pk)
  check(off.sq.kind === 'unknown' && /it is a copy/.test(off.reasons[0]), 'a copy that leaves the giver out is ?, never blank')
  const unread = await hive([piTasksMc], { buzz: { lists, known: false } })
  check(unread.square(bz.pk, mc.pk).sq.kind === 'unknown', 'a short read of the copy is ?')
}

// ── 3. What no square claims ─────────────────────────────────────────────────────────────────────
{
  const h = await hive([piTasksMc, lukeTasksPi], { views: new Map([[mc.pk, readable([])]]) })
  const all = [[mc.pk, pi.pk], [pi.pk, mc.pk], [bare.pk, pi.pk], [pi.pk, owner.pk], [mc.pk, owner.pk]].map(([t, g]) => h.square(t, g))
  check(all.every(p => p.reasons.some(r => NOT_READ.test(r))), "every square's panel says the post's arrival and presence aren't read")
  check(all.every(p => p.reasons.length <= 3), 'up to three reasons')
  const words = all.flatMap(p => [p.answer, p.acts, p.source, ...p.reasons, p.button?.label]).filter(Boolean).join(' ')
  check(!/\b(arrives|reaches it|is connected|hears it)\b/.test(words.replace(NOT_READ, '')), 'no panel claims the post arrives or the agent is connected')
  check(!/\b(grant|admit|sealed|gate|kind)\b/i.test(words), 'plain words: no grant, admit, sealed, gate or kind')
  check(LEGEND.length === 6 && LEGEND.map(([k]) => k).join() === 'work,copy,blocked,none,unknown,add', 'the legend draws the five states and the copy mark, in order')
}

// ── 4. The one button ────────────────────────────────────────────────────────────────────────────
{
  const h = await hive([piTasksMc, lukeTasksPi], { views: new Map([[mc.pk, readable([])]]) })
  check(h.square(mc.pk, pi.pk).button.label === 'Stop it', 'your own approval: Stop it')
  check(h.square(pi.pk, mc.pk).button.label === 'Let MC Claude give Pi Dog work', 'none: Let A give B work')
  const luke = h.square(pi.pk, owner.pk)
  check(luke.sq.kind !== 'none' && luke.reasons[0] === 'Luke approved this, not you.', "an approval you didn't sign says whose it is")
  check(luke.button.disabled && luke.button.label === 'Approved by Luke', 'and its button is disabled, naming who can withdraw it')
  check(h.square(mc.pk, owner.pk).button.label === 'Let MC Claude take work from you', 'with you as the giver, the button reads plainly')
  // The square Pi Dog → MC Claude (taker MC Claude); its reverse is MC Claude → Pi Dog (taker Pi Dog).
  const back = h.square(pi.pk, mc.pk).sq
  check(backOf(back, { taker: h.row(mc.pk), giver: h.row(pi.pk), ctx: h.ctx }) === "MC Claude → Pi Dog: won't act on it.", 'and back: the reverse square in one line, named the way it runs')
  check(backOf(null, { taker: h.row(pi.pk), giver: h.row(owner.pk), ctx: h.ctx }) === 'Pi Dog → you: you take no work through this page.', 'and back, to a key with no column: says so')
}

// ── 6. One square opens one list ─────────────────────────────────────────────────────────────────
{
  const sealed = { state: 'cant-tell', why: 'not-opened', event: { id: 'e' } }
  const views = new Map([[mc.pk, sealed], [pi.pk, { ...sealed, event: { id: 'f' } }], [luke.pk, readable([])]])
  const h = await hive([piTasksMc], { views })
  const p = h.square(mc.pk, pi.pk)
  check(p.showPrivate, "MC Claude's square offers to show its private list")
  const one = listsToOpen(views, mc.pk)
  check(one.length === 1 && one[0][0] === mc.pk, "with two private lists, the square's button asks for MC Claude's alone")
  check(listsToOpen(views).map(([pk]) => pk).sort().join() === [mc.pk, pi.pk].sort().join(), "Needs you's Show it asks for both, and never a readable one")
  check(listsToOpen(views, luke.pk).length === 0, 'a square whose list is already read asks for nothing')
  const page = readFileSync(new URL('../console/hive.html', import.meta.url), 'utf8')
  check(/show\.onclick = \(\) => openViews\(row\.pubkey\)/.test(page) && /\$\('hidden-go'\)\.onclick = \(\) => openViews\(\)/.test(page), "the page passes the square's taker, and Needs you passes no one")
}

// ── 7. Who is in each room ───────────────────────────────────────────────────────────────────────
{
  const h = await hive([piTasksMc])
  const rooms = (m, names = new Map(), unread = new Map()) => ({ rooms: new Map(Object.entries(m).map(([r, ks]) => [r, new Set(ks)])), names, unread })
  h.ctx.rooms = rooms({ r1: [pi.pk, mc.pk, owner.pk] }, new Map([['r1', 'general']]))
  const hears = h.square(pi.pk, mc.pk)
  check(hears.sq.kind === 'none' && hears.sq.hear === 'hears' && hears.answer === ANSWER.hears, 'blank, and both in a room read: "hears it, won\'t act"')
  check(hears.reasons.some(r => r === 'Pi Dog hears MC Claude in “general”. Whether Pi Dog is connected right now isn\'t read.'), 'the panel names the room it hears it in')
  const work = h.square(mc.pk, pi.pk)
  check(work.sq.kind === 'work' && work.sq.hear === null && work.reasons.some(r => /^MC Claude hears Pi Dog in “general”/.test(r)), 'a ✓ square keeps ✓ and names the room')

  h.ctx.rooms = rooms({ r1: [pi.pk, owner.pk], r2: [mc.pk, owner.pk] })
  const unseen = h.square(pi.pk, mc.pk)
  check(unseen.sq.hear === 'unseen' && unseen.answer === ANSWER.unseen && GLYPH.none === '', 'no shared room read: "not in any room you can see with it"')
  check(unseen.reasons.some(r => /isn't in any room you can see with MC Claude\. Rooms you aren't in aren't read/.test(r)), 'it says rooms you aren\'t in aren\'t read')
  check(!unseen.reasons.some(r => /doesn't hear/.test(r)) && !/doesn't hear/.test(unseen.answer), 'never a flat "doesn\'t hear it"')

  h.ctx.rooms = rooms({ r1: [pi.pk, owner.pk], r2: [mc.pk, owner.pk] }, new Map(), new Map([['r3', 'untrusted']]))
  const held = h.square(pi.pk, mc.pk)
  check(held.sq.hear === null && held.answer === ANSWER.none && held.reasons.some(r => NOT_READ.test(r)), 'a room not read or not trusted holds back "not in any room"')

  h.ctx.rooms = rooms({ r1: [pi.pk, owner.pk] })
  const nvoy = h.square(pi.pk, mc.pk)
  check(nvoy.sq.hear === null && nvoy.reasons.some(r => NOT_READ.test(r)), "an agent in no room read keeps today's line, and its squares don't split")
  check(h.square(mc.pk, pi.pk).reasons.some(r => NOT_READ.test(r)), 'so does a square whose taker is in no room read')
}

if (!pass) { console.error('\nconsole_hive_square: FAILURES ABOVE'); process.exit(1) }
console.log('\nconsole_hive_square: all passed')
