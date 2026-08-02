// tests/suite_count.mjs — the suite roster is a constant maintained by hand, so check it (#172).
//
// `CLAUDE.md` makes the number load-bearing:
//
//   "If a run reports fewer than N, the branch is on a stale base."
//
// That is a stale-base detector whose calibration was maintained by hand, and it drifted four
// times in two days. When it is wrong it does not fail loudly — it sits quiet through exactly the
// situation it exists to catch, which is this repo's own rule about an alarm that always fires and
// one that never fires failing identically.
//
// Three things must agree, and the interesting one is the second:
//
//   1. every invocation in package.json's `test` script names a file that exists
//   2. every tests/*.mjs on disk is INVOKED — an orphan test file is worse than a missing one,
//      because it looks like coverage in the tree and runs nowhere
//   3. every prose count (CLAUDE.md, README.md, GETTING_STARTED.md) equals the invocation count
//
// This file counts itself, which is consistent rather than clever: it is invoked from the same
// script it reads.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) fails++
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const script = pkg.scripts.test

// The invocation roster, in script order.
const invoked = [...script.matchAll(/node\s+(tests\/[\w.-]+\.mjs)/g)].map(m => m[1])
const onDisk = readdirSync(join(ROOT, 'tests')).filter(f => f.endsWith('.mjs')).map(f => `tests/${f}`)

console.log(`suite roster: ${invoked.length} invocation(s), ${onDisk.length} file(s) on disk`)

// 1. No invocation may name a file that does not exist — that fails at run time anyway, but it
//    fails as a confusing "cannot find module" rather than as a roster problem.
const ghosts = invoked.filter(f => !existsSync(join(ROOT, f)))
ok('every invoked suite exists on disk', ghosts.length === 0, `missing: ${ghosts.join(', ')}`)

// 2. An ORPHAN is the failure worth catching: a test file sitting in the tree, looking like
//    coverage, that no run ever executes. It cannot go red because it never goes anywhere.
const orphans = onDisk.filter(f => !invoked.includes(f))
ok('every test file on disk is actually invoked (no orphans)', orphans.length === 0, `never run: ${orphans.join(', ')}`)

// 3. Duplicates would inflate the count without adding coverage.
const dupes = invoked.filter((f, i) => invoked.indexOf(f) !== i)
ok('no suite is invoked twice', dupes.length === 0, `duplicated: ${[...new Set(dupes)].join(', ')}`)

// 4. Every restated count must equal the roster. This is the drift the issue documents: four
//    hand-syncs in two days, and on the last one the README's roster listed 17 while claiming 19.
const N = invoked.length
const DOCS = ['CLAUDE.md', 'README.md', 'docs/GETTING_STARTED.md']
for (const rel of DOCS) {
  const path = join(ROOT, rel)
  if (!existsSync(path)) { ok(`${rel}: present`, false, 'file missing'); continue }
  const text = readFileSync(path, 'utf8')
  const claims = [...text.matchAll(/(\d+)\s+suites/g)].map(m => Number(m[1]))
  const floors = [...text.matchAll(/fewer than\s+(\d+)/g)].map(m => Number(m[1]))
  const wrong = [...claims, ...floors].filter(n => n !== N)
  if (!claims.length && !floors.length) {
    ok(`${rel}: states no count (nothing to drift)`, true)
  } else {
    ok(`${rel}: every stated count is ${N}`, wrong.length === 0, `found ${[...new Set(wrong)].join(', ')}`)
  }
}

console.log(fails ? `\nsuite_count: ${fails} FAILED` : '\nsuite_count: all checks passed')
process.exit(fails ? 1 : 0)
