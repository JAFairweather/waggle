// ship_imports.mjs — shipped code may only import shipped code (#432).
//
// The deploy ships a fixed list of paths and `console/` is not on it. Nothing enforced that the
// code on that list only reaches other code on that list, so a module could import across the
// boundary, pass every suite, pass CI, and then fail to load on the box with ERR_MODULE_NOT_FOUND —
// a resolver error that names a path and says nothing about a deploy set.
//
// It had already happened once and nearly happened twice:
//
//   - `tools/relay-invite.mjs` imported `../console/nip98.mjs`. tools/ ships, console/ does not.
//   - #328 nearly pointed `src/bridge.mjs` at `console/scope-hash.mjs`. That one was caught by
//     reading the ship list by hand, which is not a control.
//
// WHAT THIS COVERS, AND WHAT IT DELIBERATELY DOES NOT. It walks `src/` and `tools/` — the code that
// RUNS on the box. `tests/` also ships, and 9 of its suites import from `console/` on purpose, to
// bind a browser copy to its node twin (`tests/scope_hash.mjs` is the documented example). Those
// imports do not resolve in the deployed tree either, and that is fine: the deploy installs with
// `npm ci --omit=dev` and never runs the suite there, so nothing on the box loads them. Extending
// this walk to tests/ would report 29 findings, none of them actionable, which is how a check stops
// being read. If the deploy ever runs tests on the box, that changes and this comment is the record
// of why.
//
// Run: node tests/ship_imports.mjs   (exit 0 = pass, 1 = fail)

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

// ── The ship list is read from the deploy scripts, never restated here ───────────────────────────
//
// A copy in this file would be a fourth place the list lives, and the one that never gets updated.
// The two scripts are required to mirror each other; that requirement is itself asserted below,
// because if they diverge, "shipped" has two meanings and this whole suite is testing the wrong one.
const shipListFrom = (file) => {
  const text = readFileSync(join(REPO, file), 'utf8')
  const m = /^SHIP='([^']*)'/m.exec(text)
  if (!m) return null
  return m[1].trim().split(/\s+/).filter(Boolean)
}

const runnerShip = shipListFrom('deploy/deploy-runner.sh')
const verifyShip = shipListFrom('deploy/verify-deployed.sh')

check(Array.isArray(runnerShip) && runnerShip.length >= 5,
  `deploy-runner.sh names a SHIP list this test could read (${runnerShip ? runnerShip.length : 'NOT FOUND'} entries)`)
check(Array.isArray(verifyShip) && verifyShip.length >= 5,
  `verify-deployed.sh names a SHIP list this test could read (${verifyShip ? verifyShip.length : 'NOT FOUND'} entries)`)
check(JSON.stringify(runnerShip) === JSON.stringify(verifyShip),
  'the two SHIP lists are identical — they define the same tree, so a divergence makes "shipped" ambiguous')
if (!runnerShip || !verifyShip) { console.log('\nSHIP IMPORTS INCONCLUSIVE — could not read the ship list'); process.exit(3) }

const SHIP = runnerShip
// rsync and `git ls-tree -- <dir>` both take a directory entry to mean everything beneath it.
const shipped = (repoRelative) => SHIP.some(entry => repoRelative === entry || repoRelative.startsWith(`${entry}/`))

check(shipped('src/bridge.mjs') && shipped('tools/grant.mjs') && shipped('tests/scope_hash.mjs'),
  'the ship predicate accepts paths that really are on the list')
check(!shipped('console/nip98.mjs') && !shipped('console/scope-hash.mjs') && !shipped('docs/SPEC_EXTERNAL.md'),
  '…and refuses ones that are not — console/ and docs/ are outside the deployed tree')

// ── Extract every relative target a file reaches for ─────────────────────────────────────────────
//
// Static import/export, and `new URL('./x', import.meta.url)`, which several suites use to read a
// file rather than import it and which fails on the box for exactly the same reason. Dynamic
// `import(expr)` with a computed specifier is not covered and cannot be, statically.
const RELATIVE_FROM = /(?:^|\n)\s*(?:import[^\n]*?from|export[^\n]*?from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g
const RELATIVE_URL = /new URL\(\s*['"](\.\.?\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g

export const relativeTargets = (source) => [
  ...[...source.matchAll(RELATIVE_FROM)].map(m => m[1]),
  ...[...source.matchAll(RELATIVE_URL)].map(m => m[1]),
]

const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])

const RUNTIME_DIRS = ['src', 'tools']
const files = RUNTIME_DIRS.flatMap(d => walk(join(REPO, d))).filter(f => f.endsWith('.mjs'))

// A scan of an empty tree reports everything clean. Fail loudly rather than pass vacuously.
check(files.length >= 60, `scanned a plausible number of runtime modules (${files.length}) — a small number here means the walk broke, not that the tree shrank`)
if (files.length < 60) { console.log('\nSHIP IMPORTS INCONCLUSIVE — the walk found too little to judge'); process.exit(3) }

const offBoundary = []
const missing = []
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  for (const spec of relativeTargets(source)) {
    const target = resolve(dirname(file), spec)
    const rel = relative(REPO, target)
    if (!shipped(rel)) offBoundary.push(`${relative(REPO, file)} -> ${spec}`)
    else if (!existsSync(target)) missing.push(`${relative(REPO, file)} -> ${spec}`)
  }
}

check(offBoundary.length === 0,
  `no module under ${RUNTIME_DIRS.join('/ or ')}/ imports outside the ship list` +
  (offBoundary.length ? `\n     ${offBoundary.join('\n     ')}` : ''))
check(missing.length === 0,
  'every relative target that IS on the ship list actually exists' +
  (missing.length ? `\n     ${missing.join('\n     ')}` : ''))

// ── Controls ─────────────────────────────────────────────────────────────────────────────────────
//
// Everything above is satisfied by a check that finds nothing, including one that CANNOT find
// anything. These make it fail on purpose and then pass on purpose, so a zero above means the tree
// is clean rather than the extractor being broken.
const SYNTHETIC_BAD = `
import { nip98Template } from '../console/nip98.mjs'
export { scopeHash } from "../console/scope-hash.mjs"
const page = readFileSync(new URL('../console/index.html', import.meta.url), 'utf8')
`
const badFound = relativeTargets(SYNTHETIC_BAD)
check(badFound.length === 3, `NEGATIVE CONTROL — the extractor finds all three cross-boundary forms (found ${badFound.length})`)
check(badFound.every(spec => !shipped(relative(REPO, resolve(join(REPO, 'tools'), spec)))),
  '  …and each one is classified as off-boundary, so a zero above is a clean tree and not a dead check')

const SYNTHETIC_GOOD = `
import { scopeHashSync } from '../src/scope_hash.mjs'
import { defuseJournalText } from './render.mjs'
`
const goodFound = relativeTargets(SYNTHETIC_GOOD)
check(goodFound.length === 2, `NEGATIVE CONTROL — it finds ordinary in-tree imports too (found ${goodFound.length})`)
check(goodFound.every(spec => shipped(relative(REPO, resolve(join(REPO, 'tools'), spec)))),
  '  …and passes them, so the rule refuses the boundary rather than refusing every import')

// The specific regression. Asserting only "nothing is off-boundary" would still pass if this file
// were deleted, so name the fix.
const relayInvite = readFileSync(join(REPO, 'tools/relay-invite.mjs'), 'utf8')
check(relayInvite.includes("from '../src/nip98.mjs'"),
  'tools/relay-invite.mjs takes NIP-98 from src/, which ships (#432)')
check(!relayInvite.includes('../console/nip98.mjs'),
  '  …and no longer from console/, which does not')
check(existsSync(join(REPO, 'src/nip98.mjs')) && !existsSync(join(REPO, 'console/nip98.mjs')),
  '  …and there is exactly ONE copy of the builder, in src/ — a move, not a fork')

console.log(pass ? '\nSHIP IMPORTS PASS — runtime code stays inside the deployed tree' : '\nSHIP IMPORTS FAIL')
process.exit(pass ? 0 : 1)
