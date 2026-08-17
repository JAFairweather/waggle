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
// Static import/export, dynamic `import()` with a literal specifier, and
// `new URL('./x', import.meta.url)`, which several suites use to read a file rather than import it
// and which fails on the box for exactly the same reason. Only a COMPUTED dynamic specifier is
// outside this, and that one cannot be resolved statically by anything.
//
// The forms are matched separately rather than by one line-anchored alternation. The previous
// pattern used `[^\n]*?from`, which cannot cross a newline, so a multi-line import — house style
// here, 13 files use it — put its `from` on a line starting `} from …` and was never walked. Same
// for `const { x } = await import('./y')`, which only matched when `import(` began the line. Both
// spellings got a live cross-boundary import past this suite. No defect was hidden, because every
// such target happened to be on the ship list; what was missing was the guarantee, and a reviewer
// reading SHIP IMPORTS PASS could not tell which spelling had been in play.
//
// What bounds each pattern is the excluded quote: `[^;'"]*?` cannot cross a string literal, so a
// from-clause search starting at one `import` can never run forward and capture the NEXT
// statement's specifier. That is what makes spanning newlines safe here.
const STATIC_FROM = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"](\.[^'"]+)['"]/g
const BARE_IMPORT = /\bimport\s*['"](\.[^'"]+)['"]/g          // side-effect: import './x.mjs'
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g
const RELATIVE_URL = /new URL\(\s*['"](\.\.?\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g

export const relativeTargets = (source) => [...new Set([STATIC_FROM, BARE_IMPORT, DYNAMIC_IMPORT, RELATIVE_URL]
  .flatMap(re => [...source.matchAll(re)].map(m => m[1])))]

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
// One crossing, every spelling. Asserted form by form rather than by a total, because a count says
// "3 of 3" without saying WHICH three, and the gap this closes was three specific forms silently
// absent from a passing suite. Each entry is the same off-boundary target written a different way.
const CROSSING = '../console/scope-hash.mjs'
const FORMS = [
  ['single-line static import', `import { scopeHash } from '${CROSSING}'`],
  ['MULTI-LINE static import', `import {\n  scopeHash,\n} from '${CROSSING}'`],
  ['multi-line default + named', `import defaultThing, {\n  scopeHash,\n} from '${CROSSING}'`],
  ['namespace import', `import * as sh from '${CROSSING}'`],
  ['single-line export-from', `export { scopeHash } from "${CROSSING}"`],
  ['MULTI-LINE export-from', `export {\n  scopeHash,\n} from '${CROSSING}'`],
  ['export-star', `export * from '${CROSSING}'`],
  ['side-effect import, no binding', `import '${CROSSING}'`],
  ['dynamic import, leading await', `const { scopeHash } = await import('${CROSSING}')`],
  ['dynamic import, in an expression', `const p = Promise.all([import('${CROSSING}')])`],
  ['dynamic import, bare at line start', `import('${CROSSING}')`],
  ['new URL, in an expression', `const page = readFileSync(new URL('${CROSSING}', import.meta.url), 'utf8')`],
]
const missedForms = FORMS.filter(([, src]) => !relativeTargets(src).includes(CROSSING)).map(([name]) => name)
check(missedForms.length === 0,
  `NEGATIVE CONTROL — the extractor finds the crossing in all ${FORMS.length} spellings` +
  (missedForms.length ? ` — MISSED: ${missedForms.join(', ')}` : ''))
check(relativeTargets(FORMS.map(([, s]) => s).join('\n')).length === 1,
  '  …and reports it once, not once per spelling, so the offender list stays readable')
check(!shipped(relative(REPO, resolve(join(REPO, 'tools'), CROSSING))),
  '  …and that target really is off-boundary, so a zero above is a clean tree and not a dead check')

// The honest limit, asserted rather than claimed in prose: a COMPUTED specifier is not covered and
// cannot be. Pinning it means the header cannot quietly drift into overstating coverage again.
check(relativeTargets("const m = await import('../console/' + name + '.mjs')").length === 0,
  'a computed dynamic specifier is NOT covered — stated as a measured limit, not an assumption')

// Both directions. Everything above asserts that it FINDS things; an extractor that returns every
// string literal it sees would satisfy all of it while making the walk useless.
const SYNTHETIC_GOOD = `
import { scopeHashSync } from '../src/scope_hash.mjs'
import {
  defuseJournalText,
} from './render.mjs'
const { forwardPublic } = await import('../src/bridge.mjs')
`
const goodFound = relativeTargets(SYNTHETIC_GOOD)
check(goodFound.length === 3, `NEGATIVE CONTROL — it finds ordinary in-tree imports too, multi-line and dynamic included (found ${goodFound.length})`)
check(goodFound.every(spec => shipped(relative(REPO, resolve(join(REPO, 'tools'), spec)))),
  '  …and passes them, so the rule refuses the boundary rather than refusing every import')
check(relativeTargets("import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'").length === 0,
  '  …and bare-specifier imports are not relative targets, so the from-clause search cannot run past one statement into the next')

// The specific regression. Asserting only "nothing is off-boundary" would still pass if this file
// were deleted, so name the fix.
const relayInvite = readFileSync(join(REPO, 'tools/relay-invite.mjs'), 'utf8')
check(relayInvite.includes("from '../src/nip98.mjs'"),
  'tools/relay-invite.mjs takes NIP-98 from src/, which ships (#432)')
check(!relayInvite.includes('../console/nip98.mjs'),
  '  …and no longer from console/, which does not')
// The rule this protects is "shipped code does not import console/", NOT "there is one file".
// It used to assert the latter — no console/nip98.mjs at all — which was right while the page had
// no use for the builder. #487 gives it one: the console now signs its own NIP-98 requests to
// admit an agent, and it cannot import ../src/ because serve-console pins DOCROOT to console/.
// So the permitted arrangement is the one src/nip98.mjs's own header prescribes and
// console/scope-hash.mjs set the precedent for: a browser copy BOUND BY A TEST. Unbound, it is a
// fork, and a fork of a security-relevant builder is how two copies drift apart.
check(existsSync(join(REPO, 'src/nip98.mjs')), '  …and the shipped builder is in src/')
const webNip98 = join(REPO, 'console/nip98.mjs')
if (existsSync(webNip98)) {
  const binder = 'tests/console_admission.mjs'
  const bind = existsSync(join(REPO, binder)) ? readFileSync(join(REPO, binder), 'utf8') : ''
  check(bind.includes("from '../src/nip98.mjs'") && bind.includes("from '../console/nip98.mjs'"),
    `  …and the browser copy is BOUND — ${binder} imports both and holds them equal`)
  check(readFileSync(join(REPO, 'package.json'), 'utf8').includes(`node ${binder}`),
    '  …by a suite that npm test actually runs, since an unrun binding binds nothing')
} else {
  check(true, '  …and there is no browser copy to bind')
}

// ── A runtime global is an import you forgot to declare (#576) ───────────────────────────────────
//
// Same failure class as the boundary above — code that resolves here and not there — arriving
// through a different door. `tools/agent-inbox.mjs` and `tools/agent-send.mjs` constructed
// `new WebSocket(url)` with no import, relying on a global that only newer Node provides. Eight
// sibling tools import `ws` explicitly, so nothing looked odd in review.
//
// What made it worth a check rather than a fix: both call sites are wrapped as
// `try { ws = new WebSocket(url) } catch { return end() }`, and that catch swallows a
// ReferenceError exactly as it swallows a bad URL. On a runtime without the global the tool reports
// NO CONNECTION instead of reporting that it cannot open one, and an agent reading an empty inbox
// cannot tell that from no mail. Found onboarding an agent on Node 20.
// FIXING THE DIRECT CONSTRUCTORS WAS HALF OF IT. `nostr-tools/pool` resolves its socket as
// `opts.websocketImplementation || WebSocket` — the same bare global, reached through a dependency
// rather than a call site, so the version of this check that only looked for `new WebSocket(` gave
// the branch a clean bill while half the defect stood. That path is every bunker signature and
// every pairing (`src/nostr_signer.mjs`, `src/nostrconnect.mjs`), and it fails by calling `oneose`
// with `reason: "WebSocket is not defined"` — a healthy quiet relay and a runtime with no sockets
// at all, reported in the same vocabulary. Both doors now go through `src/ws_runtime.mjs`.
// The predicates are written against SOURCE, and the file-taking wrappers are the only thing that
// touches disk — so the controls below exercise the same regexes the scan does, rather than second
// copies of them that can drift into agreeing with a bug.
const usesWsSrc = s => /\bnew\s+WebSocket\s*\(/.test(s)
const usesPoolSrc = s => /\bnew\s+SimplePool\s*\(|Pool\s*=\s*SimplePool/.test(s)
const importsRuntimeSrc = s => /^import\s+(WebSocket\s+from\s+)?'\.\.?\/(src\/)?ws_runtime\.mjs'/m.test(s)
const usesWs = f => usesWsSrc(readFileSync(f, 'utf8'))
const usesPool = f => usesPoolSrc(readFileSync(f, 'utf8'))
const importsRuntime = f => importsRuntimeSrc(readFileSync(f, 'utf8'))
const isRuntime = f => relative(REPO, f) === 'src/ws_runtime.mjs'

const wsUsers = files.filter(f => !isRuntime(f) && (usesWs(f) || usesPool(f)))
// A scan that found nothing to check has told you nothing.
check(wsUsers.length >= 10, `found runtime modules that open a socket, directly or through a pool (${wsUsers.length}) — too few means the pattern moved, not that the risk went away`)
// …and one that cannot tell the two doors apart would stay green while either half regressed.
const poolUsers = files.filter(f => !isRuntime(f) && usesPool(f))
check(poolUsers.length >= 3, `and specifically, modules reaching a socket through nostr-tools' pool (${poolUsers.length}) — the half that was missed`)

const undeclared = wsUsers.filter(f => !importsRuntime(f)).map(f => relative(REPO, f))
check(undeclared.length === 0,
  `every module that opens a socket imports src/ws_runtime.mjs — a global is not a dependency (${undeclared.join(', ') || 'none undeclared'})`)
check(/useWebSocketImplementation\s*\(\s*WebSocket\s*\)/.test(readFileSync(join(REPO, 'src/ws_runtime.mjs'), 'utf8')),
  'src/ws_runtime.mjs installs the implementation into nostr-tools — importing it for a side effect it no longer has is the silent way this regresses')

// ── The third door: nip46 carries its own pool (#578) ────────────────────────────────────────────
//
// `nostr-tools/nip46` does not import `pool.js`. It inlines a copy — its own `_WebSocket`, its own
// `try { _WebSocket = WebSocket }`, its own `SimplePool` — and `BunkerSigner` builds THAT class when
// no pool is passed. So `useWebSocketImplementation` sets a variable in a module nip46 never reads,
// and nip46 exports no installer of its own.
//
// Both callers passed every check above while the door stood open, because each also constructs a
// raw `WebSocket` and so already imported `ws_runtime` — an import that does nothing for their
// bunker path. `usesPoolSrc` does not match `BunkerSigner.fromBunker(…)` and never will; the shape
// has no pool in it. The enforceable rule is therefore about the IMPORT, not the construction:
// `src/nostr_signer.mjs` owns nip46, injects a pool built from the installed implementation, and
// nothing else may reach past it.
const NIP46_OWNER = 'src/nostr_signer.mjs'
const importsNip46Src = s => /from\s+['"]nostr-tools\/nip46['"]/.test(s)
const buildsBunkerSrc = s => /\bBunkerSigner\s*\.\s*fromBunker\s*\(/.test(s)
const injectsPoolSrc = s => /BunkerSigner\s*\.\s*fromBunker\s*\([^)]*pool\s*:/s.test(s)

const nip46Importers = files.filter(f => importsNip46Src(readFileSync(f, 'utf8'))).map(f => relative(REPO, f))
check(nip46Importers.includes(NIP46_OWNER),
  `${NIP46_OWNER} imports nostr-tools/nip46 — if it stopped, every check below would pass vacuously`)
check(nip46Importers.filter(f => f !== NIP46_OWNER).length === 0,
  `and it is the ONLY module that does (${nip46Importers.filter(f => f !== NIP46_OWNER).join(', ') || 'no others'}) — nip46's inlined pool cannot be reached from ws_runtime, so a direct importer reopens the door silently`)

const builders = files.filter(f => buildsBunkerSrc(readFileSync(f, 'utf8'))).map(f => relative(REPO, f))
check(builders.length === 1 && builders[0] === NIP46_OWNER,
  `and BunkerSigner.fromBunker is called in exactly one place (${builders.join(', ') || 'nowhere — the pattern moved'})`)
check(injectsPoolSrc(readFileSync(join(REPO, NIP46_OWNER), 'utf8')),
  `${NIP46_OWNER} passes an explicit pool into fromBunker — params.pool is the only lever nip46 offers, and omitting it is the whole of #578`)

// NEGATIVE CONTROL. Every assertion above passes on a check that never looks at anything, so prove
// each predicate can say no — and, for the pool door, that it says no to the exact code that shipped.
{
  const bad = "const x = new WebSocket('wss://x')\n"
  const good = "import WebSocket from '../src/ws_runtime.mjs'\n" + bad
  check(usesWsSrc(bad) && !importsRuntimeSrc(bad), '  …CONTROL: the predicate flags a module that uses the global without importing the runtime')
  check(usesWsSrc(good) && importsRuntimeSrc(good), '  …CONTROL: and clears the same module once the import is there')

  const poolBad = "import { SimplePool } from 'nostr-tools/pool'\nconst pool = new SimplePool()\n"
  const poolGood = "import './ws_runtime.mjs'\n" + poolBad
  check(usesPoolSrc(poolBad) && !importsRuntimeSrc(poolBad), '  …CONTROL: it flags a pool user that installs no implementation — the shape that shipped')
  check(usesPoolSrc(poolGood) && importsRuntimeSrc(poolGood), '  …CONTROL: and clears it once the runtime is imported')
  // The default-argument spelling in src/nostr_signer.mjs, which reads nothing like `new SimplePool()`.
  check(usesPoolSrc('  Pool = SimplePool,\n'), '  …CONTROL: and recognises the injectable-Pool spelling, not just the constructor call')

  // The third door. Its first control is the one that matters: state, in the suite, that the pool
  // predicate CANNOT see this shape — that is why the rule above is about imports and not about
  // sockets, and a reader who does not know it will "simplify" the two checks into one.
  const nip46Bad = "import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46'\n" +
    "import WebSocket from '../src/ws_runtime.mjs'\n" +
    'const b = BunkerSigner.fromBunker(sk, bp, { onauth: u => log(u) })\n'
  check(!usesPoolSrc(nip46Bad) && importsRuntimeSrc(nip46Bad),
    '  …CONTROL: the pool predicate is BLIND to the code that shipped #578, and ws_runtime is imported — this is why both tools passed')
  check(importsNip46Src(nip46Bad) && buildsBunkerSrc(nip46Bad) && !injectsPoolSrc(nip46Bad),
    '  …CONTROL: the nip46 predicates flag that same source — importing nip46, building a signer, injecting no pool')

  const nip46Good = "import { bunkerSignerFromUri } from '../src/nostr_signer.mjs'\n" +
    'const b = bunkerSignerFromUri(sk, bp, { onauth: u => log(u) })\n'
  check(!importsNip46Src(nip46Good) && !buildsBunkerSrc(nip46Good),
    '  …CONTROL: and clear the fixed spelling — both directions, so this is not a check that refuses everything')
  check(injectsPoolSrc('BunkerSigner.fromBunker(sk, bp, { ...params, pool: params.pool || new Pool() })'),
    '  …CONTROL: and the pool-injection predicate says yes to an injected pool, not merely no to a missing one')
}

console.log(pass ? '\nSHIP IMPORTS PASS — runtime code stays inside the deployed tree' : '\nSHIP IMPORTS FAIL')
process.exit(pass ? 0 : 1)
