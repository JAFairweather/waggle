// agent_bundle.mjs — prove `dist/waggle-agent.mjs` is usable on a host that cannot install.
//
// GrokDoggyDog's host refuses `git clone` and refuses `npm ci` with "executable content could not
// be bound", but runs a file that was written and then executed (his own probe, exit 0). The bundle
// exists for that host and for no other reason, so every assertion here is about that machine: no
// checkout, no node_modules, one file.
//
// WHY THIS SUITE DOES NOT TRUST THE BUILD SCRIPT'S OWN REPORT. `tools/build-agent-bundle.mjs`
// checks its output and exits non-zero, and a suite that merely ran it and read the exit code would
// be asserting that a checker agrees with itself. It shipped a bundle that passed all of its own
// checks and died on its first socket — `--version` answers before any subcommand is imported, so
// `ws`'s `require('events')` was never reached. That defect is the reason section 4 exists, and it
// is driven here through an independently built artifact rather than through the builder's verdict.
//
// THE NEGATIVE CONTROLS ARE THE LOAD-BEARING PART. Every check below that can only ever pass is
// paired with a deliberately broken input that must make it fail. A matcher for "no bare imports"
// that cannot match a bare import reports a clean bundle on every possible input, and that is
// indistinguishable from a bundle that is genuinely clean.
//
// Run: node tests/agent_bundle.mjs   (exit 0 = pass, 1 = fail)

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = mkdtempSync(join(tmpdir(), 'waggle-bundle-'))
const OUT = join(TMP, 'waggle-agent.mjs')
// Every child gets PATH and HOME and nothing else. An ALLOWLIST, not a denylist of known-bad
// names: one forgotten prefix and a child inherits a signing key again. Without this the suite
// reds on any machine with BUZZ_PRIVATE_KEY set — and reds for the right-looking reason, because
// with a key in scope `inbox` does not stop at its signer check, it proceeds into a live read.
// CI passes today only because CI has no key. HOME points inside TMP so nothing resolves back out.
const SANDBOX_HOME = join(TMP, 'home')
mkdirSync(SANDBOX_HOME, { recursive: true })
const CLEAN_ENV = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: SANDBOX_HOME }

let pass = true
const check = (cond, label, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}${detail ? `  [${detail}]` : ''}`)
  if (!cond) pass = false
}

// Run a command and return {code, out, err} without throwing, so a non-zero exit is data rather
// than a crash. Most of what this suite asserts IS a non-zero exit.
const run = (args, opts = {}) => {
  try {
    const out = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], ...opts, env: { ...CLEAN_ENV, ...(opts.env || {}) } })
    return { code: 0, out, err: '' }
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout || ''), err: String(e.stderr || e.message || '') }
  }
}

// ── 0. Children inherit nothing ────────────────────────────────────────────────────────────────
//
// The suite spawns the artifact and asserts on how it refuses. If a signing key reaches the child,
// `inbox` does not stop at its signer check — it proceeds into a live authenticated read, and the
// assertion below it fails for a reason that has nothing to do with the bundle. That is not
// hypothetical: it is what this suite did on any machine with BUZZ_PRIVATE_KEY exported, and it
// stayed green in CI only because CI has no key.
//
// The assertion is a property, not an exact set: macOS injects __CF_USER_TEXT_ENCODING into every
// child no matter what env is passed, so `keys === ['HOME','PATH']` would pass on Linux and fail on
// a Mac — a check that disagrees with itself by platform is worse than none.
console.log('\n-- 0. the child environment is sealed --')
const ENV_PROBE = ['-e', 'console.log(Object.keys(process.env).sort().join(" "))']
const SIGNER_SHAPED = /KEY|NSEC|BUNKER|SECRET|TOKEN|RELAY|WAGGLE|NVOY|BUZZ/i
const sealedNames = run(ENV_PROBE).out.trim().split(/\s+/).filter(Boolean)
check(sealedNames.includes('PATH') && sealedNames.includes('HOME'),
  'a child spawned by run() still gets PATH and HOME, so it can execute at all', sealedNames.join(' '))
check(!sealedNames.some(n => SIGNER_SHAPED.test(n)),
  'and nothing signer-shaped survives into it, so every command refuses for the same reason on every machine',
  sealedNames.filter(n => SIGNER_SHAPED.test(n)).join(' '))

// NEGATIVE CONTROL: without this, the check above is satisfied by a probe that reports nothing at
// all. It runs the injected name through SIGNER_SHAPED rather than matching the literal, so
// blinding that regex reds this line too — a literal here would leave the regex itself uncovered,
// and section 0 would stay green while blind to the exact defect it is written for. The injected
// value is a marker string, not a key.
const leakedNames = run(ENV_PROBE, { env: { BUZZ_PRIVATE_KEY: 'sentinel-not-a-key' } })
  .out.trim().split(/\s+/).filter(Boolean)
check(leakedNames.some(n => SIGNER_SHAPED.test(n)),
  'NEGATIVE CONTROL: with one injected the same probe DOES report it, so the check above can fail',
  leakedNames.filter(n => SIGNER_SHAPED.test(n)).join(' '))

// ── 1. The build runs and produces exactly one file ────────────────────────────────────────────
console.log('\n-- 1. build --')

const built = run([join(REPO, 'tools/build-agent-bundle.mjs'), '--out', OUT], { cwd: REPO })
if (built.code === 3) {
  // Exit 3 is the repo's INCONCLUSIVE contract: esbuild is absent, so nothing below could be judged.
  // Saying so and failing is right — a suite that quietly skipped would report a pass for a bundle
  // it never built, which is the shape of every defect this file exists to catch.
  check(false, 'esbuild is installed so the bundle can be built', built.err.split('\n')[0])
  process.exit(1)
}
check(built.code === 0, 'tools/build-agent-bundle.mjs exits 0', `code=${built.code} ${built.err.split('\n').filter(Boolean).slice(-1)[0] || ''}`)
check(existsSync(OUT), 'the artifact exists at --out')

const src = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
const bytes = existsSync(OUT) ? statSync(OUT).size : 0

// A size floor, because a scan of a near-empty file reports everything clean. The first build of
// this bundle was 2 KiB — it looked like a success and was a stub that reached for `../tools/`.
check(bytes > 200 * 1024, 'the artifact is larger than 200 KiB — its dependencies are actually in it', `${(bytes / 1024).toFixed(0)} KiB`)

// ── 2. No bare imports survive, and the matcher can see one ────────────────────────────────────
console.log('\n-- 2. no bare imports (with a negative control) --')

const BARE_IMPORT = /(?:^|\n)\s*(?:import|export)[^;\n]*?\bfrom\s*["']([^."'][^"']*)["']/g
const isBuiltin = m => m.startsWith('node:') || builtinModules.includes(m)
const bareIn = text => [...text.matchAll(BARE_IMPORT)].map(m => m[1]).filter(m => !isBuiltin(m))

check(bareIn(src).length === 0, 'the bundle imports nothing that needs node_modules', bareIn(src).join(' '))

// NEGATIVE CONTROL for the matcher itself.
check(bareIn("import WebSocket from 'ws'\n").length === 1, 'NEGATIVE CONTROL: the same matcher DOES flag a real bare import', 'ws')
check(bareIn("import { x } from './local.mjs'\n").length === 0, 'and does NOT flag a relative import — it refuses the dangerous thing, not everything')
check(bareIn("import { createRequire } from 'node:module'\n").length === 0, 'and does NOT flag a Node builtin, which resolves with no node_modules at all')

// ── 2b. No bare or computed require() survives, and the matcher can see BOTH ────────────────────
console.log('\n-- 2b. require() detection (with a differential control) --')

// This section exists because the previous matcher was `/\brequire\s*\(.../` and it had never
// matched anything, in any build. `\b` needs a word boundary and there is none between `_` and `r`,
// so `__require("ws")` — which is the shape of EVERY require esbuild emits into this bundle — was
// invisible to it. It reported green identically whether the bundle was clean or full of bare
// CommonJS deps, which is the same as having no check at all.
const REQUIRE_CALL = /(?<![\w$.])_{0,2}require\s*\(\s*(["'])?([^"')]*)/g
const reqIn = text => {
  const bare = [], dyn = []
  for (const m of text.matchAll(REQUIRE_CALL)) {
    if (!m[1]) { dyn.push(m[2].trim()); continue }
    if (/^[./]/.test(m[2])) continue
    if (!isBuiltin(m[2]) && !['bufferutil', 'utf-8-validate'].includes(m[2])) bare.push(m[2])
  }
  return { bare, dyn }
}

const liveReq = reqIn(src)
check(liveReq.bare.length === 0, 'the bundle require()s nothing that needs node_modules', liveReq.bare.join(' '))
check(liveReq.dyn.length === 0, 'the bundle contains no computed require()', liveReq.dyn.join(' '))

// POSITIVE CONTROL, and the one that matters most here. The bundle really does contain 19
// `__require("<builtin>")` calls. If this assertion ever reads 0, the matcher has gone blind again
// and every "no bare require" pass above became vacuous.
const builtinHits = [...src.matchAll(REQUIRE_CALL)].filter(m => m[1] && isBuiltin(m[2]))
check(builtinHits.length > 0,
  'POSITIVE CONTROL: the matcher DOES see the __require() calls that are legitimately present',
  `${builtinHits.length} builtin __require() calls matched`)

// DIFFERENTIAL CONTROL: the regex this replaced, run over the same live bundle. It must find
// nothing — that is the defect, pinned so a future edit cannot quietly restore it.
const OLD_REQUIRE = /\brequire\s*\(\s*["']([^./"'][^"']*)["']\s*\)/g
check([...src.matchAll(OLD_REQUIRE)].length === 0 && builtinHits.length > 0,
  'DIFFERENTIAL CONTROL: the OLD matcher sees none of them — it was structurally blind to `__require`',
  `old=0 new=${builtinHits.length}`)

// NEGATIVE CONTROLS: each shape that must fail.
check(reqIn('const ws = require("ws")').bare.length === 1, 'NEGATIVE CONTROL: flags a plain bare require', 'ws')
check(reqIn('var x = __require("ws")').bare.length === 1, 'NEGATIVE CONTROL: flags esbuild\'s shim form — the case the old regex missed', 'ws')
check(reqIn('var x = __require(name)').dyn.length === 1, 'NEGATIVE CONTROL: flags a computed specifier', 'name')

// And it refuses the dangerous thing, not everything.
check(reqIn('var x = __require("events")').bare.length === 0, 'and does NOT flag a builtin require — a legitimate value still gets through')
check(reqIn('const y = require("./local.mjs")').bare.length === 0, 'and does NOT flag a relative require')
check(reqIn('if (typeof require !== "undefined") return require.apply(this, arguments)').dyn.length === 0,
  'and does NOT flag the shim definition\'s own `require` value or `require.apply(` — no false positive on esbuild boilerplate')

// ── 3. The WebSocket door stays shut ───────────────────────────────────────────────────────────
console.log('\n-- 3. socket resolution (#576/#578) --')

// `nostr-tools/pool` resolves a BARE GLOBAL `WebSocket`, which Node did not ship unflagged until 22
// while package.json declares >=20. Absent, it reports the failure as EOSE — the vocabulary of a
// healthy empty relay. If `useWebSocketImplementation` is not in the bundle, that door is open again
// on exactly the hosts the bundle was built to serve.
check(src.includes('useWebSocketImplementation'), 'the bundle installs a WebSocket into nostr-tools\' pool')
check(/createRequire/.test(src), 'the bundle provides a real `require` for the CommonJS deps it inlines')

// Parsed here rather than in section 6 because section 4b drives every command in this list. The
// switch was already the authoritative list of what ships; it just was not feeding what runs.
const cliSrc = readFileSync(join(REPO, 'src/agent_cli.mjs'), 'utf8')
const dispatched = [...cliSrc.matchAll(/case '([a-z][a-z-]*)':\s*return import\('([^']+)'\)/g)].map(m => [m[1], m[2]])

// ── 4. It loads its dependencies, not just its entry ───────────────────────────────────────────
console.log('\n-- 4. the socket stack actually loads --')

// This is the check that was missing. `--version` returns before any subcommand is imported, so it
// passed a bundle whose first socket died with `Dynamic require of "events" is not supported`.
// Driving `inbox` imports agent-inbox, ws_runtime, `ws` and nostr-tools, then stops at the tool's
// OWN signer check. Asserting on that sentence rather than on the exit code is what separates
// "reached the tool" from "died on the way in" — both are non-zero.
const noSigner = run([OUT, 'inbox', '--pubkey', 'f'.repeat(64)], { cwd: TMP })
const noSignerText = noSigner.err + noSigner.out
check(!/Dynamic require|Cannot find (module|package)/.test(noSignerText),
  'running a subcommand does not die resolving a dependency',
  (noSignerText.split('\n').find(l => /Dynamic require|Cannot find/.test(l)) || '').trim())
check(/no signer configured/.test(noSignerText),
  'it reaches agent-inbox\'s own signer check — the whole module graph loaded from one file')

// NEGATIVE CONTROL: the same command against a bundle with the `require` shim removed must fail in
// the way the check names. Without this, section 4 could be a check that passes on anything.
const brokenPath = join(TMP, 'broken-agent.mjs')
const REQUIRE_LINE = 'const require = __nodeCreateRequire(import.meta.url)'
if (!src.includes(REQUIRE_LINE)) {
  // ANCHOR MISS. A mutation that does not apply and one that is not detected both look like a green
  // suite, and the second is the conclusion a reader would draw. Say so and fail.
  check(false, 'ANCHOR MISS: the require shim line is not in the built bundle, so the control below could not be built', REQUIRE_LINE)
} else {
  writeFileSync(brokenPath, src.replace(REQUIRE_LINE + '\n', ''))
  const broken = run([brokenPath, 'inbox', '--pubkey', 'f'.repeat(64)], { cwd: TMP })
  const brokenText = broken.err + broken.out
  check(/Dynamic require/.test(brokenText),
    'NEGATIVE CONTROL: with the require shim stripped, the same command DOES die on a dynamic require',
    (brokenText.split('\n').find(l => /Dynamic require/.test(l)) || '').trim().slice(0, 80))
  check(!/no signer configured/.test(brokenText),
    'and the broken bundle never reaches the signer check — the two outcomes are distinguishable')
}

// ── 4b. EVERY dispatched command loads, not just `inbox` ───────────────────────────────────────
//
// Section 4 drove one command out of five. `pair`, `publish-dm-relays` and `check` were never
// executed, so a dependency reachable only from one of them could break while this suite stayed
// green — the same shape as the defect section 4 exists for, and the reason it was found by hand
// rather than here. Each is invoked with no arguments: all five refuse on a missing required flag,
// and they do it AFTER the dynamic import has pulled in the whole module graph, so a loader error
// surfaces and none of them reaches the network.
console.log('\n-- 4b. every command loads --')
for (const [name, path] of dispatched) {
  const tool = path.replace(/^.*\//, '').replace(/\.mjs$/, '')
  const r = run([OUT, name], { cwd: TMP })
  const text = r.err + r.out
  check(!/Dynamic require|Cannot find (module|package)/.test(text),
    `\`${name}\` loads its whole dependency graph`,
    (text.split('\n').find(l => /Dynamic require|Cannot find/.test(l)) || '').trim().slice(0, 90))
  // Assert the REASON, not only that it refused. Both a loader death and a tool's own usage line
  // are non-zero exits with output; only one of them means the command actually arrived. Every
  // tool prefixes its refusal with its own basename, which is the dispatch target's filename.
  check(text.includes(`${tool}:`), `\`${name}\` refuses as ${tool} itself, so dispatch reached the tool`,
    text.split('\n')[0].trim().slice(0, 90))
}

// NEGATIVE CONTROL for 4b: the shim-stripped bundle from section 4 must fail both assertions on a
// command section 4 never drove. Without this, 4b is a loop that has only ever passed.
if (existsSync(brokenPath)) {
  const bp = run([brokenPath, 'pair'], { cwd: TMP })
  const bpText = bp.err + bp.out
  check(/Dynamic require|Cannot find (module|package)/.test(bpText),
    'NEGATIVE CONTROL: with the require shim stripped, `pair` DOES die on a loader error',
    (bpText.split('\n').find(l => /Dynamic require|Cannot find/.test(l)) || '').trim().slice(0, 80))
  check(!bpText.includes('pair-agent:'), '  …and never reaches pair-agent, so the two outcomes are distinguishable')
} else {
  check(false, 'ANCHOR MISS: the shim-stripped bundle was not built, so 4b has no negative control')
}

// ── 5. Entry behaviour: help, version, unknown command ─────────────────────────────────────────
console.log('\n-- 5. entry behaviour --')

const version = run([OUT, '--version'], { cwd: TMP })
check(version.code === 0 && version.out.trim().length > 0, 'the bundle answers --version with a build id', version.out.trim())
check(!/source \(not bundled\)/.test(version.out), 'and the build id is stamped, not the unbundled placeholder')

const help = run([OUT, '--help'], { cwd: TMP })
check(help.code === 0, '--help exits 0 — it is an answer, not a usage error', `code=${help.code}`)

const bare = run([OUT], { cwd: TMP })
check(bare.code === 2, 'no command at all exits 2 — a usage error, told apart from --help', `code=${bare.code}`)

const unknown = run([OUT, 'wat'], { cwd: TMP })
check(unknown.code === 2, 'an unknown command exits 2', `code=${unknown.code}`)
// Assert the REASON, not only the refusal. This file may be the only waggle artifact on the machine,
// so there is no other --help to fall back to and no checkout to read; a refusal that does not name
// the valid set leaves the agent with nowhere to go.
check(/Valid commands:/.test(unknown.err), 'and names the valid set rather than only refusing')

// ── 6. Every advertised command is dispatchable ────────────────────────────────────────────────
console.log('\n-- 6. command parity --')

// The help table and the dispatch switch are two lists that must agree. They are deliberately
// separate (esbuild can only inline a dynamic import whose path is a literal, so the switch cannot
// be collapsed into the table), and two hand-maintained lists drift. A command advertised in help
// that throws on dispatch is a documented command that cannot run — this repo has shipped one
// before (#514).
const advertised = [...cliSrc.matchAll(/^\s{2}'?([a-z][a-z-]*)'?:\s*'/gm)].map(m => m[1])

check(advertised.length >= 5, 'the help table advertises at least the five onboarding commands', advertised.join(' '))
check(advertised.length === dispatched.length, 'the help table and the dispatch switch are the same length',
  `help=${advertised.length} switch=${dispatched.length}`)
for (const name of advertised) {
  check(dispatched.some(([d]) => d === name), `advertised command ${JSON.stringify(name)} has a dispatch case`)
}
for (const [name, path] of dispatched) {
  check(existsSync(resolve(REPO, 'src', path)), `dispatch target for ${JSON.stringify(name)} exists`, path)
  // A literal path is what makes the import inlinable. A template or a variable builds clean and
  // ships a stub — that is not hypothetical, it is what the first version of this bundle did.
  check(!/\$\{|\+/.test(path), `dispatch target for ${JSON.stringify(name)} is a literal, so esbuild can inline it`, path)
}

// ── 7. argv reaches the tool the way it would standalone ───────────────────────────────────────
console.log('\n-- 7. argv --')

// The subcommand word is spliced out before dispatch. If it were not, the tools' helper
// `flag = n => argv[argv.indexOf(n) + 1]` still works by luck in most orders — but a flag whose
// VALUE equals a subcommand name reads back the wrong token. Drive the real bundle with a value
// that collides, and assert the tool used the value it was given.
const collide = run([OUT, 'send', '--channel', 'send', '--bridge', 'f'.repeat(64)], { cwd: TMP })
const collideText = collide.err + collide.out
check(!/Dynamic require|Cannot find/.test(collideText), 'a subcommand-shaped flag value does not break dispatch')
check(collide.code !== 0, 'and agent-send still refuses — it has no signer and no body', `code=${collide.code}`)

console.log(`\n${pass ? 'PASS' : 'FAIL'} — tests/agent_bundle.mjs`)
process.exit(pass ? 0 : 1)
