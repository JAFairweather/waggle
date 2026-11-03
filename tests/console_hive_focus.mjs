// console_hive_focus.mjs — the hive at 50 agents (#698, build step 4).
//
// docs/DESIGN_HIVE_CONSOLE.md, "At 50 agents". What this suite holds:
//
//  1. Find an agent matches a name, or a key prefix of four or more hex characters, and an empty
//     query finds no one.
//  2. The focused agent's column and row are read from the same square kinds the grid draws: ✓ stays
//     open as chips, and every other state folds into a count that names its agents.
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

// Who gives Pi Dog work: you (✓), MC Claude (!), agent 3 (copy), agent 4 unknown, agent 5 your
// unsigned change. Pi Dog gives MC Claude work (✓) and agent 3 none. Everyone else blank.
const K = new Map([
  [`${pi.pubkey}>${you.pubkey}`, 'work'], [`${pi.pubkey}>${mc.pubkey}`, 'blocked'],
  [`${pi.pubkey}>${agents[2].pubkey}`, 'copy'], [`${pi.pubkey}>${agents[3].pubkey}`, 'unknown'],
  [`${pi.pubkey}>${agents[4].pubkey}`, 'add'], [`${pi.pubkey}>${dennis.pubkey}`, 'none'],
  [`${mc.pubkey}>${pi.pubkey}`, 'work'], [`${agents[2].pubkey}>${pi.pubkey}`, 'none'],
])
const kindOf = (taker, giver) => taker.pubkey === giver.pubkey ? 'self'
  : giver.pubkey === dennis.pubkey && !K.has(`${taker.pubkey}>${giver.pubkey}`) ? 'none'
    : K.get(`${taker.pubkey}>${giver.pubkey}`) || 'none'
const personAware = (taker, giver) => taker.pubkey === dennis.pubkey ? 'person' : kindOf(taker, giver)

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
  const f = focusOf(pi.pubkey, { rows, columns, kindOf: personAware })
  const { column, row } = focusLines(f, { nameOf })
  check(column.head === '3 can give it work', 'the column heads with everyone who can give it work: ✓, ! and copy')
  check(column.chips.length === 3 && column.chips.includes(you.pubkey) && column.chips.includes(mc.pubkey) && column.chips.includes(agents[2].pubkey), 'and they stay open as chips')
  const rest = Object.fromEntries(column.rest.map(r => [r.kind, r]))
  check(rest.blocked?.text === "1 of those 3 it can't answer back by name" && rest.blocked.pks.join() === mc.pubkey, '! folds into a count of those it cannot answer back')
  check(/^1 of those 3 come from your copy/.test(rest.copy?.text || ''), "a copy of Buzz's list is counted as a copy")
  check(rest.none?.pks.length === 46 && rest.none.text === "46 it won't act on what they say", 'blank squares fold into one count')
  check(rest.unknown?.text === '1 not known yet' && rest.add?.text === '1 change of yours, not signed yet', '? and your unsigned change each fold into a count')
  check(column.rest.reduce((n, r) => n + r.pks.length, 0) - rest.blocked.pks.length - rest.copy.pks.length + column.chips.length === rows.length - 1, 'every other row is counted exactly once')
  check(row.head === 'It gives 1 work' && row.chips.join() === mc.pubkey, 'the row heads with whom it gives work')
  check(!row.rest.some(r => r.pks.includes(dennis.pubkey)), 'a person is never counted in a row')
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
  check(!/innerHTML\s*=(?!\s*'')/.test(page), 'names reach the page only as text')
}

if (!pass) { console.error('\nconsole_hive_focus: FAILURES ABOVE'); process.exit(1) }
console.log('\nconsole_hive_focus: all passed')
