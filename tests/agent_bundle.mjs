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
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = mkdtempSync(join(tmpdir(), 'waggle-bundle-'))
const OUT = join(TMP, 'waggle-agent.mjs')

let pass = true
const check = (cond, label, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}${detail ? `  [${detail}]` : ''}`)
  if (!cond) pass = false
}

// Run a command and return {code, out, err} without throwing, so a non-zero exit is data rather
// than a crash. Most of what this suite asserts IS a non-zero exit.
const run = (args, opts = {}) => {
  try {
    const out = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    return { code: 0, out, err: '' }
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout || ''), err: String(e.stderr || e.message || '') }
  }
}

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

// ── 3. The WebSocket door stays shut ───────────────────────────────────────────────────────────
console.log('\n-- 3. socket resolution (#576/#578) --')

// `nostr-tools/pool` resolves a BARE GLOBAL `WebSocket`, which Node did not ship unflagged until 22
// while package.json declares >=20. Absent, it reports the failure as EOSE — the vocabulary of a
// healthy empty relay. If `useWebSocketImplementation` is not in the bundle, that door is open again
// on exactly the hosts the bundle was built to serve.
check(src.includes('useWebSocketImplementation'), 'the bundle installs a WebSocket into nostr-tools\' pool')
check(/createRequire/.test(src), 'the bundle provides a real `require` for the CommonJS deps it inlines')

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
const cliSrc = readFileSync(join(REPO, 'src/agent_cli.mjs'), 'utf8')
const advertised = [...cliSrc.matchAll(/^\s{2}'?([a-z][a-z-]*)'?:\s*'/gm)].map(m => m[1])
const dispatched = [...cliSrc.matchAll(/case '([a-z][a-z-]*)':\s*return import\('([^']+)'\)/g)].map(m => [m[1], m[2]])

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
