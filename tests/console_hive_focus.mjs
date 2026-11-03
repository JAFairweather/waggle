// console_hive_focus.mjs — the hive at 50 agents (#698, build step 4).
//
// docs/DESIGN_HIVE_CONSOLE.md, "At 50 agents". What this suite holds:
//
//  1. Find an agent matches a name, or a key prefix of four or more hex characters, and an empty
//     query finds no one.
//  2. The focused agent's column and row are read from the same square kinds the grid draws: ✓ stays
//     open as chips, and every other state folds into a count that names its agents.
//  2b. Counts are the signed state: an unsigned change is its own line and moves no count, and a
//     square only your copy of Buzz's list answers is counted apart, in the column and the row.
//  3. A person has no column, and is never counted in a row.
//  4. A folded group is one line with its agents and its ✓ squares, and groups fold at the start once
//     the grid outgrows a screen.
//  5. The page wires the search, the folds and the focus to these functions.
//
// Every key is synthetic.
//
//   node tests/console_hive_focus.mjs

import { readFileSync } from 'node:fs'
import { findAgents, focusOf, focusLines, groupLine, FOLD_ABOVE, foldedAtStart } from '../console/hive-focus.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const hex = n => n.toString(16).padStart(2, '0').repeat(32)

// Fifty agents, you, and one person.
const you = { pubkey: hex(0), isOwner: true }
const agents = Array.from({ length: 50 }, (_, i) => ({ pubkey: hex(i + 1) }))
const dennis = { pubkey: hex(200) }
const rows = [you, ...agents, dennis]
const columns = [you, ...agents]
const NAMES = new Map([[you.pubkey, 'you'], [dennis.pubkey, 'Dennis'], ...agents.map((a, i) => [a.pubkey, i === 0 ? 'Pi Dog' : i === 1 ? 'MC Claude' : `agent ${i + 1}`])])
const nameOf = pk => NAMES.get(pk) || pk.slice(0, 8)
const pi = agents[0], mc = agents[1]

// Who gives Pi Dog work: you (✓, and your unsigned stop), MC Claude (!), agent 3 (copy), agent 4
// unknown, agent 5 blank with your unsigned add. Pi Dog gives MC Claude work (✓) and agent 3 none.
// Everyone else blank.
const K = new Map([
  [`${pi.pubkey}>${you.pubkey}`, 'work'], [`${pi.pubkey}>${mc.pubkey}`, 'blocked'],
  [`${pi.pubkey}>${agents[2].pubkey}`, 'copy'], [`${pi.pubkey}>${agents[3].pubkey}`, 'unknown'],
  [`${pi.pubkey}>${dennis.pubkey}`, 'none'],
  [`${mc.pubkey}>${pi.pubkey}`, 'work'], [`${agents[2].pubkey}>${pi.pubkey}`, 'none'],
])
const kindOf = (taker, giver) => taker.pubkey === giver.pubkey ? 'self'
  : giver.pubkey === dennis.pubkey && !K.has(`${taker.pubkey}>${giver.pubkey}`) ? 'none'
    : K.get(`${taker.pubkey}>${giver.pubkey}`) || 'none'
const personAware = (taker, giver) => taker.pubkey === dennis.pubkey ? 'person' : kindOf(taker, giver)
const C = new Map([[`${pi.pubkey}>${you.pubkey}`, 'remove'], [`${pi.pubkey}>${agents[4].pubkey}`, 'add']])
const changeOf = (taker, giver) => C.get(`${taker.pubkey}>${giver.pubkey}`) || null

// ── 1. Find an agent ─────────────────────────────────────────────────────────────────────────────
{
  check(findAgents(rows, '', nameOf).length === 0 && findAgents(rows, '   ', nameOf).length === 0, 'an empty query finds no one')
  check(findAgents(rows, 'pi dog', nameOf).map(r => r.pubkey).join() === pi.pubkey, 'a name, in any case, finds that agent')
  check(findAgents(rows, 'agent 1', nameOf).length === 10, 'a part of a name finds every agent holding it')
  check(findAgents(rows, hex(2).slice(0, 4), nameOf).map(r => r.pubkey).join() === mc.pubkey, 'four hex characters find a key by its start')
  check(findAgents(rows, '020', nameOf).length === 0, 'three hex characters are not a key search')
}

// ── 2. One agent's column and row, as counts ─────────────────────────────────────────────────────
{
  const f = focusOf(pi.pubkey, { rows, columns, kindOf: personAware, changeOf })
  const { column, row } = focusLines(f, { nameOf })
  check(column.head === '2 can give it work' && column.glyph === 'work', "the column heads with everyone nvoy's rules say can give it work: ✓ and !")
  check(column.chips.length === 2 && column.chips.includes(you.pubkey) && column.chips.includes(mc.pubkey), 'and they stay open as chips')
  const rest = Object.fromEntries(column.rest.map(r => [r.kind, r]))
  check(rest.blocked?.text === "1 of those 2 it can't answer back by name" && rest.blocked.pks.join() === mc.pubkey, '! folds into a count of those it cannot answer back')
  check(rest.copy?.text === "1 by your copy of Buzz's list. Buzz's own list isn't read" && rest.copy.pks.join() === agents[2].pubkey, "a copy of Buzz's list is counted apart, and says it is a copy")
  check(rest.none?.pks.length === 47 && rest.none.text === "47 it won't act on what they say", 'blank squares fold into one count')
  check(rest.unknown?.text === '1 not known yet', '? folds into a count')
  check(rest.add?.text === "1 you're adding, not signed yet. Until you sign, they can't" && rest.add.pks.join() === agents[4].pubkey, 'your unsigned add is its own line')
  check(rest.remove?.text === "1 you're stopping, not signed yet. Until you sign, nothing changes" && rest.remove.pks.join() === you.pubkey, 'your unsigned stop is its own line')
  check(column.chips.length + rest.copy.pks.length + rest.none.pks.length + rest.unknown.pks.length === rows.length - 1, 'every other row is counted exactly once, by its signed square')
  check(row.head === 'It gives 1 work' && row.chips.join() === mc.pubkey, 'the row heads with whom it gives work')
  check(!row.rest.some(r => r.pks.includes(dennis.pubkey)), 'a person is never counted in a row')
}

// ── 2b. Unsigned changes and copies move no count ────────────────────────────────────────────────
{
  const t = { pubkey: hex(90) }, b = { pubkey: hex(91) }, c = { pubkey: hex(92) }
  const names = new Map([[t.pubkey, 'T'], [b.pubkey, 'B'], [c.pubkey, 'C']]), nm = pk => names.get(pk)
  const only = (k, ch = null) => ({ rows: [t, b], columns: [t, b], kindOf: (x, y) => x === y ? 'self' : x === t && y === b ? k : 'none', changeOf: (x, y) => x === t && y === b ? ch : null })
  const stop = focusLines(focusOf(t.pubkey, only('work', 'remove')), { nameOf: nm }).column
  check(stop.head === '1 can give it work' && stop.chips.join() === b.pubkey, 'stopping the only giver, unsigned, still counts it as giving work')
  check(stop.rest.some(r => r.kind === 'remove' && r.pks.join() === b.pubkey), 'and the stop is its own line')
  check(groupLine('G', [b], only('work', 'remove')) === 'G · 1 agent · 1 give work', 'and a folded group still counts it')
  const add = focusLines(focusOf(t.pubkey, only('none', 'add')), { nameOf: nm }).column
  check(add.head === 'Nobody can give it work' && !add.chips.length, 'an unsigned add counts no one yet')
  const copy = focusLines({ pk: t.pubkey, column: { copy: [b.pubkey] }, row: { copy: [c.pubkey] } }, { nameOf: nm })
  check(copy.column.head === "Only your copy of Buzz's list says anyone can give it work" && copy.column.glyph === 'copy' && !copy.column.chips.length, 'a copy-only column says so, and draws the copy square, not ✓')
  check(copy.row.head === "Only your copies of Buzz's lists say it gives anyone work" && copy.row.glyph === 'copy' && !copy.row.chips.length, 'and so does a copy-only row')
  check(copy.row.rest.some(r => r.kind === 'copy' && r.pks.join() === c.pubkey && /Buzz's own lists aren't read/.test(r.text)), "the row's copy count says Buzz's own lists aren't read")
  check(groupLine('G', [b], only('copy')) === 'G · 1 agent · 0 give work · 1 by your copy of Buzz', 'a folded group counts copies after the signed count')
}

// ── 3. A key with no column ──────────────────────────────────────────────────────────────────────
{
  const f = focusOf(dennis.pubkey, { rows, columns, kindOf: personAware })
  const { column } = focusLines(f, { nameOf })
  check(f.column === null && column.head === 'Dennis takes no work through this page' && !column.chips.length, 'a person has no column, and says so')
  const me = focusLines(focusOf(you.pubkey, { rows, columns, kindOf: personAware }), { nameOf })
  check(me.column.head === 'Nobody can give you work' && /^You give 1 work$/.test(me.row.head), 'for you, it reads in the second person')
  check(focusOf(hex(250), { rows, columns, kindOf }) === null, 'a key not in the hive has no focus')
}

// ── 4. Groups fold ───────────────────────────────────────────────────────────────────────────────
{
  check(groupLine('Frontier lab harnesses', [pi, mc], { columns, kindOf: personAware }) === 'Frontier lab harnesses · 2 agents · 2 give work', "a folded group names its agents and its ✓ squares")
  check(groupLine('People', [dennis], { columns, kindOf: personAware }) === 'People · 1 agent · 0 give work', 'and counts one in the singular')
  check(FOLD_ABOVE === 30 && !foldedAtStart(30) && foldedAtStart(31) && foldedAtStart(rows.length), 'groups fold at the start once the grid has more than a screen of rows')
}

// ── 5. The page ──────────────────────────────────────────────────────────────────────────────────
{
  const page = readFileSync(new URL('../console/hive.html', import.meta.url), 'utf8')
  check(/from '\.\/hive-focus\.mjs'/.test(page) && /id="find" type="search"/.test(page), 'the hive imports the focus module and draws Find an agent')
  check(/findAgents\(/.test(page) && /focusOf\(/.test(page) && /focusLines\(/.test(page) && /groupLine\(/.test(page) && /foldedAtStart\(/.test(page), 'and drives the search, the focus and the folds from it')
  check(/\.base : null/.test(page) && /changeOf: changeAt/.test(page) && /`sq \$\{l\.glyph\}`/.test(page), 'the page counts signed squares, passes your changes apart, and draws the head square the counts chose')
  check(!/innerHTML\s*=(?!\s*'')/.test(page), 'names reach the page only as text')
}

if (!pass) { console.error('\nconsole_hive_focus: FAILURES ABOVE'); process.exit(1) }
console.log('\nconsole_hive_focus: all passed')
