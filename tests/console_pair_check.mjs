// console_pair_check.mjs — can these two reach each other? (#691, docs/DESIGN_PAIR_CHECK.md, step 1)
//
// What this suite holds, by the design's acceptance cases marked (suite):
//
//  1. An approval read in full is Proven or Closed; a partial read is Can't tell either way (3).
//  2. A gate with no source is Not read yet for every pair, and no such line is Proven or Claimed (4).
//  3. Two cards configuring a common channel are Claimed, never Proven (6).
//  4. An agent and a person: the person's work-in lines and mention right are not drawn, each with
//     its sentence, and every drawn line has a state (9).
//  5. A Buzz agent: Claimed when the copy lists the giver, Can't tell when a full copy does not (10).
//  6. Claimed is counted, never called open (11); the D9 pair is Proven one way, Closed the other (5).
//
// Every key is synthetic.
//
//   node tests/console_pair_check.mjs

import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import { pairCheck, kindOf, summaryOf, STATES } from '../console/pair-check.mjs'
import { readGrants, scopeTable, answersFor } from '../console/hive-list.mjs'
import { draftRevoke } from '../console/hive-change.mjs'
import { scopeHash } from '../console/scope-hash.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const key = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) } }
const SALT = '00112233445566778899aabbccddeeff'

const owner = key(), pi = key(), mc = key(), person = key(), bz = key(), stranger = key()
const NAMES = new Map([[owner.pk, 'You'], [pi.pk, 'Pi Dog'], [mc.pk, 'MC Claude'], [person.pk, 'Dennis'], [bz.pk, 'Buzz Bee']])
const nameOf = pk => NAMES.get(pk) || pk.slice(0, 8)

const grant = async (by, grantee, agent, cap, at, extra = []) => finalizeEvent({ kind: 440, created_at: at, content: '',
  tags: [['p', grantee], ['da-scope', await scopeHash(agent, SALT), SALT], ['da-cap', cap], ...extra] }, by.sk)

// Pi Dog may give MC Claude work, by the owner's approval. MC Claude can't mention Pi Dog: the D9 pair.
const piTasksMc = await grant(owner, pi.pk, mc.pk, 'task', 1700000000)
const strangerTasksPi = await grant(stranger, mc.pk, pi.pk, 'task', 1700000001)

async function hive(events, { partial = false, buzz = null, views = new Map() } = {}) {
  const { grants } = readGrants(events, { verify: verifyEvent })
  const table = await scopeTable([owner.pk, pi.pk, mc.pk, person.pk, bz.pk], grants, scopeHash)
  const card = pk => ({ pubkey: pk, grantors: [owner.pk], signedAt: 1700000100, may_post: { channels: 1 } })
  const rows = [
    { pubkey: owner.pk, isOwner: true },
    { pubkey: pi.pk, card: card(pi.pk) },
    { pubkey: mc.pk, card: card(mc.pk) },
    { pubkey: person.pk },
    { pubkey: bz.pk },
  ]
  for (const r of rows) r.answers = answersFor(r, { owner: owner.pk, grantEvents: events, table })
  const byKey = new Map(rows.map(r => [r.pubkey, r]))
  const ctx = { owner: owner.pk, nameOf, grants, subjectOf: table.subjectOf, views, buzz, partial: { approvals: partial } }
  return { row: pk => byKey.get(pk), ctx }
}
const lineOf = (res, from, gate) => {
  const d = res.directions.find(d => d.from === from)
  return [...d.work, ...d.reach].find(l => l.gate === gate)
}
const readable = (mention = [], channels = []) => ({ state: 'readable', signedAt: 1700000100, view: { mention, refused: [], channels } })
const allDrawn = res => res.directions.flatMap(d => [...d.work, ...d.reach]).filter(l => !l.notDrawn)

// ── 1. Approval, full and partial ───────────────────────────────────────────────────────────────
{
  const views = new Map([[mc.pk, readable([], [{ id: 'c1', name: 'waggle-test' }])], [pi.pk, readable([], [{ id: 'c1', name: 'waggle-test' }])]])
  const h = await hive([piTasksMc], { views })
  const res = pairCheck(h.row(mc.pk), h.row(pi.pk), h.ctx)
  const l1 = lineOf(res, mc.pk, 1)
  check(l1.state === 'proven' && l1.says.includes(piTasksMc.id.slice(0, 8)) && l1.says.includes('signed by You'), 'a full read with the approval live: Proven, quoting its short id and grantor')
  check(lineOf(res, pi.pk, 1).state === 'closed' && /no approval/.test(lineOf(res, pi.pk, 1).says), 'a full read with no approval the other way: Closed')
  check(lineOf(res, mc.pk, 2).state === 'claimed', "taken is only Claimed: the card names grantors, not the approvals it took")

  check(res.summary.state === 'closed', "a Closed line decides the summary before any Can't tell")
  const mutual = new Map([[mc.pk, readable([{ name: 'pi', pubkey: pi.pk, source: 'manifest', grants: [] }], [{ id: 'c1' }])], [pi.pk, readable([{ name: 'mc', pubkey: mc.pk, source: 'manifest', grants: [] }], [{ id: 'c1' }])]])
  const partial = await hive([piTasksMc], { partial: true, views: mutual })
  const p = pairCheck(partial.row(mc.pk), partial.row(pi.pk), partial.ctx)
  check(lineOf(p, mc.pk, 1).state === 'cant-tell' && lineOf(p, pi.pk, 1).state === 'cant-tell', "a partial read is Can't tell, whether a grant was seen or not")
  check(/withdrawal relay/.test(lineOf(p, mc.pk, 1).says), 'and it names the read that came back short')
  check(p.summary.state === 'cant-tell', "the summary names the first Can't tell")

  const revoked = await hive([piTasksMc, finalizeEvent(draftRevoke({ grantId: piTasksMc.id }), owner.sk)], { views })
  const r = pairCheck(revoked.row(mc.pk), revoked.row(pi.pk), revoked.ctx)
  check(lineOf(r, mc.pk, 1).state === 'closed' && /revoked/.test(lineOf(r, mc.pk, 1).says), 'after a 441: Closed, "revoked"')
  check(r.summary.state === 'closed' && /^Closed at Approval/.test(r.summary.text), 'and the summary names Approval')

  const other = await hive([strangerTasksPi], { views })
  const o = pairCheck(other.row(pi.pk), other.row(mc.pk), other.ctx)
  check(lineOf(o, pi.pk, 1).state === 'closed' && lineOf(o, pi.pk, 2).state === 'closed' && /does not count approvals signed by/.test(lineOf(o, pi.pk, 2).says),
    "an approval by a grantor the card doesn't name: no approval counted, and taken says whose approvals it skips")
}

// ── 2. No source, no yes ─────────────────────────────────────────────────────────────────────────
{
  const h = await hive([piTasksMc])
  for (const [a, b] of [[mc.pk, pi.pk], [mc.pk, person.pk], [bz.pk, mc.pk], [person.pk, owner.pk]]) {
    const res = pairCheck(h.row(a), h.row(b), h.ctx)
    for (const d of res.directions) for (const gate of [3, 5, 6, 8]) {
      const l = [...d.work, ...d.reach].find(x => x.gate === gate)
      if (!l.notDrawn) check(l.state === 'not-read', `${nameOf(d.from)} → ${nameOf(d.to)}: ${l.title} is Not read yet`)
    }
    check(allDrawn(res).every(l => l.source !== 'nothing on the page yet' || (l.state !== 'proven' && l.state !== 'claimed')), `${nameOf(a)} and ${nameOf(b)}: no line without a source is Proven or Claimed`)
    check(!/\bopen\b|can reach/i.test(res.summary.text), `${nameOf(a)} and ${nameOf(b)}: the summary never says open`)
  }
  check(lineOf(pairCheck(h.row(mc.pk), h.row(pi.pk), h.ctx), mc.pk, 3).context.cardSignedAt === 1700000100, "connected carries the card's signing time as context, not as a state")
}

// ── 3. Configured, not proven ────────────────────────────────────────────────────────────────────
{
  const both = new Map([[mc.pk, readable([], [{ id: 'c1', name: 'waggle-test' }, { id: 'c2', name: 'ops' }])], [pi.pk, readable([], [{ id: 'c1', name: 'waggle-test' }])]])
  const h = await hive([piTasksMc], { views: both })
  const l4 = lineOf(pairCheck(h.row(mc.pk), h.row(pi.pk), h.ctx), mc.pk, 4)
  check(l4.state === 'claimed' && /waggle-test/.test(l4.says) && !/ops/.test(l4.says) && /not membership/.test(l4.says), 'a common configured channel is Claimed, named, and called configuration')
  const apart = await hive([piTasksMc], { views: new Map([[mc.pk, readable([], [{ id: 'c2', name: 'ops' }])], [pi.pk, readable([], [{ id: 'c1', name: 'waggle-test' }])]]) })
  check(lineOf(pairCheck(apart.row(mc.pk), apart.row(pi.pk), apart.ctx), mc.pk, 4).state === 'closed', 'two read lists with nothing in common: Closed')
  const unread = await hive([piTasksMc], { views: new Map([[mc.pk, { state: 'cant-tell', why: 'not-for-you' }], [pi.pk, readable()]]) })
  const u = pairCheck(unread.row(mc.pk), unread.row(pi.pk), unread.ctx)
  check(lineOf(u, mc.pk, 4).state === 'cant-tell' && lineOf(u, mc.pk, 7).state === 'cant-tell' && /no list sealed to you/.test(lineOf(u, mc.pk, 7).says),
    "an unreadable view: channel and mention lines Can't tell, with the reason, never Closed")
}

// ── 4. An agent and a person ─────────────────────────────────────────────────────────────────────
{
  const h = await hive([piTasksMc], { views: new Map([[mc.pk, readable()]]) })
  const res = pairCheck(h.row(mc.pk), h.row(person.pk), h.ctx)
  check(kindOf(h.row(person.pk)) === 'person' && kindOf(h.row(owner.pk)) === 'person' && kindOf(h.row(mc.pk)) === 'agent', 'a key with no card on no known platform is a person; so is the owner')
  const toPerson = res.directions.find(d => d.from === mc.pk), fromPerson = res.directions.find(d => d.from === person.pk)
  check([...toPerson.work, ...toPerson.reach].every(l => !l.notDrawn), 'the agent → person direction draws every line')
  check(fromPerson.work.every(l => l.notDrawn === 'A person takes no work through the page.'), "the person's work-in lines are not drawn, each with its sentence")
  check(lineOf(res, person.pk, 7).notDrawn === 'The page sets no mention right for a person.', "the person's mention right is not drawn, with its sentence")
  check(allDrawn(res).every(l => Object.hasOwn(STATES, l.state)), 'every drawn line has exactly one of the five states')
  check(/client settings/.test(lineOf(res, mc.pk, 8).says), "hearing, for a person, says their client's settings are not on the page")
}

// ── 5. A Buzz agent ──────────────────────────────────────────────────────────────────────────────
{
  const lists = new Map([[bz.pk, new Set([mc.pk])]])
  const h = await hive([piTasksMc], { buzz: { lists, known: true } })
  check(kindOf(h.row(bz.pk), h.ctx.buzz) === 'buzz', 'a key the Buzz copy names is a Buzz agent')
  const on = pairCheck(h.row(bz.pk), h.row(mc.pk), h.ctx)
  check(lineOf(on, bz.pk, 1).state === 'claimed' && /copy/.test(lineOf(on, bz.pk, 1).says), 'the copy lists the giver: Claimed, and says it is a copy')
  const off = pairCheck(h.row(bz.pk), h.row(pi.pk), h.ctx)
  check(lineOf(off, bz.pk, 1).state === 'cant-tell', "a full copy that doesn't list the giver: Can't tell, never Closed")
  check([2, 3, 4, 5, 6, 7, 8].every(g => lineOf(on, bz.pk, g).state === 'not-read'), 'every other line for the Buzz agent is Not read yet')
  const unknown = await hive([piTasksMc], { buzz: { lists, known: false } })
  check(lineOf(pairCheck(unknown.row(bz.pk), unknown.row(mc.pk), unknown.ctx), bz.pk, 1).state === 'cant-tell', "a partial read of the copy: Can't tell")
}

// ── 6. Claimed is counted; the D9 pair ───────────────────────────────────────────────────────────
{
  const lists = new Map([[bz.pk, new Set(['*'])]])
  const h = await hive([], { buzz: { lists, known: true } })
  const res = pairCheck(h.row(bz.pk), h.row(person.pk), h.ctx)
  check(res.summary.state === 'counted' && /^No gate the page could read is closed\. 0 proven, 1 claimed, \d+ not read yet\.$/.test(res.summary.text),
    'with Claimed and Not read yet only, the summary counts each state and never says open')

  const views = new Map([[mc.pk, readable([{ name: 'you', pubkey: owner.pk, source: 'manifest', grants: [] }])], [pi.pk, readable([{ name: 'mc-claude', pubkey: mc.pk, source: 'manifest', grants: [] }])]])
  const d9 = await hive([piTasksMc], { views })
  const p = pairCheck(d9.row(mc.pk), d9.row(pi.pk), d9.ctx)
  check(lineOf(p, mc.pk, 1).state === 'proven' && lineOf(p, mc.pk, 7).state === 'closed' && lineOf(p, mc.pk, 7).fix === 'mention',
    'the D9 pair: Pi Dog may give MC Claude work, MC Claude may not mention Pi Dog, and the fix is offered')
  check(lineOf(p, pi.pk, 7).state === 'proven' && /@mc-claude, set on the fleet host/.test(lineOf(p, pi.pk, 7).says), 'a listed mention is Proven, quoting the name and its source')
  const reply = await hive([piTasksMc], { views: new Map([[mc.pk, { state: 'reply-only' }]]) })
  const rl = lineOf(pairCheck(reply.row(mc.pk), reply.row(pi.pk), reply.ctx), mc.pk, 7)
  check(rl.state === 'closed' && /only replies/.test(rl.says) && !rl.fix, 'a reply-only agent: Closed, "only replies", and no fix')
  check(summaryOf([{ from: mc.pk, to: pi.pk, work: [], reach: [] }], nameOf).state === 'counted', 'an empty check counts nothing and still says nothing is open')
  let threw = false; try { pairCheck(d9.row(mc.pk), d9.row(mc.pk), d9.ctx) } catch { threw = true }
  check(threw, 'a key is never paired with itself')
}

if (!pass) { console.log('\nconsole_pair_check: FAIL'); process.exit(1) }
console.log('\nconsole_pair_check: ok')
