#!/usr/bin/env node
// merge-suites.mjs — resolve the suite-count merge conflict, safely (#387).
//
// Run it from inside a conflicted merge. It reads BOTH sides out of the index (git stages 2 and 3),
// computes the union, checks it against tests/ on disk, and writes package.json plus the counts and
// rosters in CLAUDE.md, README.md and docs/GETTING_STARTED.md.
//
//   node tools/merge-suites.mjs            # resolve
//   node tools/merge-suites.mjs --check     # report only, change nothing
//
// Why a tool: the obvious hand resolution — take one side — silently drops a working suite, and
// nothing downstream fails, because a suite that is not invoked cannot fail. Across ten of these
// merges in one session neither side was EVER a superset, and twice both sides declared the same
// count while holding different suites. See src/suite_union.mjs.
//
// It refuses rather than guesses: no conflict, no roster, an invoked suite missing from disk, or a
// suite on disk left uninvoked are all hard stops. Exit 0 resolved · 1 refused · 3 nothing to do.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { parseSuites, renderSuites, checkSuites, unionReport } from '../src/suite_union.mjs'

const CHECK = process.argv.includes('--check')
const DOCS = ['CLAUDE.md', 'README.md', 'docs/GETTING_STARTED.md']
const say = m => console.log(`merge-suites: ${m}`)
const die = m => { console.error(`merge-suites: ${m}`); process.exit(1) }

// A file that merged cleanly has no stage 2 or 3, and git says so on stderr. That is an expected
// answer here, not a failure — so the stderr is swallowed. A tool that prints `fatal:` while
// succeeding reads as broken, and an operator who learns to ignore its errors will ignore a real one.
const stage = (n, path) => {
  try { return execFileSync('git', ['show', `:${n}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }
  catch { return null }
}

const oursPkg = stage(2, 'package.json')
const theirsPkg = stage(3, 'package.json')
if (!oursPkg || !theirsPkg) {
  say('package.json is not conflicted — nothing to resolve')
  process.exit(3)
}

const ours = parseSuites(JSON.parse(oursPkg).scripts.test)
const theirs = parseSuites(JSON.parse(theirsPkg).scripts.test)
const report = unionReport(ours, theirs)
const merged = report.merged
const N = merged.length

// Say out loud what each side alone would have cost. A resolver that silently does the right thing
// teaches nobody that the wrong thing was on offer.
say(`ours ${ours.length} · theirs ${theirs.length} · union ${N}`)
if (report.onlyOurs.length) say(`  only ours:   ${report.onlyOurs.join(', ')}`)
if (report.onlyTheirs.length) say(`  only theirs: ${report.onlyTheirs.join(', ')}`)
if (report.equalCountsDifferentSets) {
  say('  ⚠ BOTH SIDES DECLARED THE SAME COUNT and hold different suites — taking either would have')
  say('    dropped a suite while leaving a number that looks reconciled.')
} else if (!report.supersetExists) {
  say('  ⚠ neither side is a superset — taking either would have dropped a suite')
}

const onDisk = readdirSync('tests').filter(f => f.endsWith('.mjs'))
const safety = checkSuites(merged, onDisk)
if (!safety.ok) {
  for (const p of safety.problems) console.error(`merge-suites:   ${p}`)
  die('the union does not pass its own checks; nothing written')
}
say(`union passes: every suite exists on disk, none invoked twice, none left uninvoked`)

// The roster names are not derivable from filenames — but BOTH sides carry a roster, so the delta
// is. Take the same union across the two rosters that the suite lists just took.
function rosterOf(text) {
  const m = text.match(/boot ·[\s\S]*?(?=\n\n)/)
  return m ? { block: m[0], items: m[0].split('·').map(s => s.trim()).filter(Boolean) } : null
}

if (CHECK) { say('--check: nothing was changed'); process.exit(0) }

const pkg = JSON.parse(theirsPkg)
pkg.scripts.test = renderSuites(merged)
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
say('wrote package.json')

for (const rel of DOCS) {
  if (!existsSync(rel)) continue
  let text = readFileSync(rel, 'utf8')

  // Resolve any conflict in the doc by taking THEIRS, then repair below — the same spine choice the
  // suite list made, so the two cannot disagree about which side led.
  text = text.replace(/<<<<<<< HEAD\n(.*?)\n?=======\n(.*?)\n?>>>>>>> [^\n]*\n/gs, (_, __, t) => t + '\n')
  if (text.includes('<<<<<<<')) die(`${rel}: a conflict remains that this tool did not resolve`)

  const o = rosterOf(stage(2, rel) || ''), t = rosterOf(stage(3, rel) || '')
  if (o && t) {
    const onlyOurs = o.items.filter(x => !t.items.includes(x))
    let block = t.block
    for (const item of onlyOurs) {
      const pred = o.items[o.items.indexOf(item) - 1]
      if (!pred || !block.includes(pred)) die(`${rel}: ANCHOR MISS — no place to insert "${item}"`)
      block = block.replace(`${pred} · `, `${pred} · ${item} · `)
    }
    const cur = rosterOf(text)
    if (!cur) die(`${rel}: no roster block after resolving`)
    text = text.replace(cur.block, block)
    if (onlyOurs.length) say(`${rel}: spliced ${onlyOurs.length} roster entr${onlyOurs.length === 1 ? 'y' : 'ies'}`)
  }

  text = text.replace(/\b\d+ suites\b/g, `${N} suites`).replace(/fewer than \d+/g, `fewer than ${N}`)
  writeFileSync(rel, text)
  say(`wrote ${rel}`)
}

say(`resolved at ${N} suites — now run: node tests/suite_count.mjs`)
