// ws_runtime.mjs — prove the socket implementation is installed, on a runtime that has no global.
//
// `tests/ship_imports.mjs` asserts that every module which opens a socket imports
// `src/ws_runtime.mjs`. That is a check on the text, and the text was not the problem: the code
// that shipped imported `nostr-tools/pool` perfectly correctly and still could not open a socket.
// So this suite deletes `globalThis.WebSocket` and drives the real modules.
//
// WHY A DELETED GLOBAL IS A FAITHFUL STAND-IN. `package.json` declares `"node": ">=20"`, and Node
// did not ship `WebSocket` unflagged until 22. Every CI runner and every developer machine here is
// past that, so the supported floor of this project is the one configuration nothing tests. The
// delete reproduces it exactly — `nostr-tools` resolves a bare `WebSocket` identifier, and a bare
// identifier that is absent is absent for the same reason either way.
//
// THE CONTROL IS THE POINT. `oneose` fires on total connection failure, so "EOSE arrived" is not
// evidence of anything: a bogus hostname produces `events=0 eose=true` and so does a runtime with
// no sockets. The first version of this probe reported a pass on exactly that basis. Every
// assertion below therefore turns on `closed` reasons or on bytes actually received.
//
// Run: node tests/ws_runtime.mjs   (exit 0 = pass, 1 = fail)

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The probes live in a temp dir, so a bare `nostr-tools/pool` there resolves against the temp dir's
// (nonexistent) node_modules and dies with ERR_MODULE_NOT_FOUND — which `run()` would report as
// `crashed`, i.e. as the very failure this suite is trying to attribute to a missing global.
// Resolve it here, where the repo's node_modules is on the path, and embed the absolute specifier.
const POOL = import.meta.resolve('nostr-tools/pool')
const TMP = mkdtempSync(join(tmpdir(), 'waggle-ws-'))

let pass = true
const check = (cond, label, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}${detail ? `  [${detail}]` : ''}`)
  if (!cond) pass = false
}

// A preload that removes the global and refuses to continue if it could not, because a probe that
// silently kept the global would report a pass for a case it never ran.
const KILL_GLOBAL = join(TMP, 'kill-global.mjs')
writeFileSync(KILL_GLOBAL, `
delete globalThis.WebSocket
if (typeof globalThis.WebSocket !== 'undefined') {
  console.error('PROBE INVALID: global WebSocket survived the delete')
  process.exit(9)
}
`)

// The probe reports, it does not judge — so one script serves both arms and the assertions live here.
const PROBE = join(TMP, 'probe.mjs')
writeFileSync(PROBE, `
import ${JSON.stringify(join(REPO, 'src/ws_runtime.mjs'))}
import { SimplePool } from ${JSON.stringify(POOL)}
const [url, ms] = [process.argv[2], Number(process.argv[3] || 6000)]
const pool = new SimplePool()
let events = 0, eose = false, closed = null
pool.subscribeMany([url], { kinds: [1], limit: 3 }, {
  onevent() { events++ }, oneose() { eose = true }, onclose(r) { closed = r },
})
setTimeout(() => {
  console.log(JSON.stringify({ events, eose, closed }))
  process.exit(0)
}, ms)
`)

// A second probe, identical but WITHOUT the runtime import — the shape of the code that shipped.
const PROBE_BARE = join(TMP, 'probe-bare.mjs')
writeFileSync(PROBE_BARE, `
import { SimplePool } from ${JSON.stringify(POOL)}
const [url, ms] = [process.argv[2], Number(process.argv[3] || 6000)]
const pool = new SimplePool()
let events = 0, eose = false, closed = null
pool.subscribeMany([url], { kinds: [1], limit: 3 }, {
  onevent() { events++ }, oneose() { eose = true }, onclose(r) { closed = r },
})
setTimeout(() => { console.log(JSON.stringify({ events, eose, closed })); process.exit(0) }, ms)
`)

// ── The third door (#578) ────────────────────────────────────────────────────────────────────────
//
// `nostr-tools/nip46` does not import `pool.js`. It inlines a copy, with its own `_WebSocket` and
// its own `SimplePool`, and `BunkerSigner` builds THAT class when `params.pool` is absent. So the
// two probes above — both of which exercise `pool.js` — say nothing about this path, and neither
// does the ws_runtime import that both affected tools already had.
//
// These probes drive the signer's own `pool` rather than calling `connect()`, so no bunker has to
// exist and nothing waits on a human. The pointer names a key nobody holds — the assertion is about
// which socket implementation the signer's pool resolves, not about reaching a signer. It is DERIVED
// rather than written down as a literal, because `fromBunker` computes a shared secret against it
// and an off-curve 64-hex string throws inside @noble before any socket is opened, which the probe
// would report as a failure of the thing under test.
const PURE = import.meta.resolve('nostr-tools/pure')
const NIP46 = import.meta.resolve('nostr-tools/nip46')

const bunkerProbe = (build) => `
${build.imports}
import { getPublicKey } from ${JSON.stringify(PURE)}
const [url, ms] = [process.argv[2], Number(process.argv[3] || 6000)]
const remote = getPublicKey(new Uint8Array(32).fill(3))
const bp = await parseBunkerInput('bunker://' + remote + '?relay=wss://nos.lol&secret=probe')
if (!bp || !bp.pubkey) { console.error('PROBE INVALID: bunker pointer did not parse'); process.exit(9) }
const signer = ${build.call}
if (!signer.pool) { console.error('PROBE INVALID: signer exposes no pool to drive'); process.exit(9) }
let events = 0, eose = false, closed = null
signer.pool.subscribeMany([url], { kinds: [1], limit: 3 }, {
  onevent() { events++ }, oneose() { eose = true }, onclose(r) { closed = r },
})
setTimeout(() => { console.log(JSON.stringify({ events, eose, closed })); process.exit(0) }, ms)
`

// The shape that shipped: nip46 imported directly, no pool injected.
const PROBE_NIP46_BARE = join(TMP, 'probe-nip46-bare.mjs')
writeFileSync(PROBE_NIP46_BARE, bunkerProbe({
  imports: `import ${JSON.stringify(join(REPO, 'src/ws_runtime.mjs'))}\n` +
           `import { BunkerSigner, parseBunkerInput } from ${JSON.stringify(NIP46)}`,
  call: 'BunkerSigner.fromBunker(new Uint8Array(32).fill(7), bp, {})',
}))

// The fix: the same signer, built through the one module allowed to import nip46.
const PROBE_NIP46_FIXED = join(TMP, 'probe-nip46-fixed.mjs')
writeFileSync(PROBE_NIP46_FIXED, bunkerProbe({
  imports: `import { bunkerSignerFromUri, parseBunkerInput } from ${JSON.stringify(join(REPO, 'src/nostr_signer.mjs'))}`,
  call: 'bunkerSignerFromUri(new Uint8Array(32).fill(7), bp, {})',
}))

const run = (script, { killGlobal = false, url = 'wss://nos.lol', ms = 6000 } = {}) => {
  const args = killGlobal ? ['--import', `file://${KILL_GLOBAL}`] : []
  try {
    const out = execFileSync('node', [...args, script, url, String(ms)],
      { cwd: REPO, encoding: 'utf8', timeout: ms + 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(out.trim().split('\n').pop())
  } catch (e) {
    return { crashed: true, detail: String(e.stdout || '') + String(e.stderr || e.message || '') }
  }
}

const reasons = r => JSON.stringify(r.closed || null)
const undefinedWs = r => /WebSocket is not defined/.test(reasons(r))

// ── The module half: no network, so this half is the one that must never be flaky ────────────────
{
  const mod = await import(join(REPO, 'src/ws_runtime.mjs'))
  check(typeof mod.default === 'function', 'src/ws_runtime.mjs exports a WebSocket implementation')
  check(mod.default === mod.WebSocket, '  …and the named and default exports are the same object')
  check(typeof mod.default.OPEN === 'number',
    '  …carrying the readyState constants nostr-tools reads off the constructor (`_WebSocket.OPEN`)',
    `OPEN=${mod.default.OPEN}`)
}

// ── The seam half: drive it over a real relay ────────────────────────────────────────────────────
//
// OFFLINE IS NOT A PASS. If the positive control cannot reach a relay there is nothing to compare
// against, and every remaining assertion would be satisfied by a machine with no network at all —
// so this exits 3, the repo's INCONCLUSIVE, rather than green.
const control = run(PROBE, {})
if (control.crashed || control.events === 0) {
  console.log(`\nINCONCLUSIVE — the positive control read nothing from wss://nos.lol, so a failure to`)
  console.log(`connect below would prove nothing. This suite needs one reachable public relay.`)
  console.log(`  control: ${JSON.stringify(control).slice(0, 300)}`)
  process.exit(3)
}
check(control.events > 0, 'CONTROL: with the global present, a pool reads events from a real relay', `events=${control.events}`)

// The discriminating control: EOSE alone says nothing, and this is the run that proves it.
const bogus = run(PROBE, { url: 'wss://relay.invalid.example', ms: 5000 })
check(bogus.events === 0 && bogus.eose === true,
  'CONTROL: a relay that does not exist ALSO reports eose — so "EOSE arrived" is not evidence of a connection',
  `events=${bogus.events} eose=${bogus.eose}`)

// The defect, reproduced. Without the runtime import and without the global, the pool fails — and
// fails in the vocabulary of a quiet relay, which is why it was invisible.
const broken = run(PROBE_BARE, { killGlobal: true })
check(!broken.crashed && broken.events === 0,
  'REPRODUCES: with no global and no ws_runtime import, the pool reads nothing',
  `events=${broken.events}`)
check(broken.eose === true,
  '  …and reports it as EOSE — indistinguishable from an empty inbox to any caller that waits for one')
check(undefinedWs(broken),
  '  …with the true reason only in the close reasons, where nothing in this repo was looking',
  reasons(broken).slice(0, 120))

// The fix, driven. Same runtime, same absent global, one import different.
const fixed = run(PROBE, { killGlobal: true })
check(!fixed.crashed, 'FIX: importing src/ws_runtime.mjs, the same probe runs on a runtime with no global',
  fixed.crashed ? String(fixed.detail).slice(0, 200) : '')
check(fixed.events > 0, '  …and actually reads events, so the implementation reached nostr-tools',
  `events=${fixed.events}`)
check(!undefinedWs(fixed), '  …with no "WebSocket is not defined" among the close reasons', reasons(fixed).slice(0, 120))

// ── The third door, driven ───────────────────────────────────────────────────────────────────────
//
// Note what the first assertion is: with the global PRESENT, the bare nip46 signer works. Without
// it, "the fixed one reads and the bare one does not" would be satisfied by a probe that was simply
// broken, and this suite has already reported one pass on exactly that basis.
const nip46Control = run(PROBE_NIP46_BARE, {})
check(!nip46Control.crashed && nip46Control.events > 0,
  'CONTROL: with the global present, a BunkerSigner built straight from nip46 reads from a real relay',
  nip46Control.crashed ? String(nip46Control.detail).slice(0, 200) : `events=${nip46Control.events}`)

const nip46Broken = run(PROBE_NIP46_BARE, { killGlobal: true })
check(!nip46Broken.crashed && nip46Broken.events === 0,
  'REPRODUCES: nip46 carries its own pool, so the ws_runtime import in the same file buys it nothing',
  nip46Broken.crashed ? String(nip46Broken.detail).slice(0, 200) : `events=${nip46Broken.events}`)
check(undefinedWs(nip46Broken),
  '  …and the reason is the same "WebSocket is not defined", one module further in than #576',
  reasons(nip46Broken).slice(0, 120))

const nip46Fixed = run(PROBE_NIP46_FIXED, { killGlobal: true })
check(!nip46Fixed.crashed && nip46Fixed.events > 0,
  'FIX: built through src/nostr_signer.mjs, the signer’s pool reads events with no global present',
  nip46Fixed.crashed ? String(nip46Fixed.detail).slice(0, 200) : `events=${nip46Fixed.events}`)
check(!undefinedWs(nip46Fixed), '  …with no "WebSocket is not defined" among the close reasons', reasons(nip46Fixed).slice(0, 120))

// ── The tools an agent runs on its first day, on the runtime it will run them on ─────────────────
//
// pair-agent is the one that matters: it is the FIRST command a remote agent runs, and with no
// socket it waits out its whole timeout and exits 3, which reads exactly like an operator who never
// approved the request. --print-only opens nothing and writes nothing, so this asserts only that
// the module graph loads under the absent global — the failure it had was at import-and-connect
// time, not at parse time.
for (const tool of ['tools/pair-agent.mjs', 'tools/agent-inbox.mjs', 'tools/agent-send.mjs',
                    'tools/grant.mjs', 'tools/publish-dm-relay-list.mjs']) {
  let ok = false, detail = ''
  try {
    execFileSync('node', ['--import', `file://${KILL_GLOBAL}`, '--check', join(REPO, tool)],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    ok = true
  } catch (e) { detail = String(e.stderr || e.message).slice(0, 200) }
  check(ok, `${tool} parses with no global WebSocket`, detail)
}
// `--check` is syntax only, and syntax valid is not works (this repo has been burned by exactly
// that). So load pair-agent's real signing dependency for effect, under the absent global.
{
  let ok = false, detail = ''
  try {
    execFileSync('node', ['--import', `file://${KILL_GLOBAL}`, '-e',
      `import(${JSON.stringify(join(REPO, 'src/nostrconnect.mjs'))}).then(m => {
         if (typeof m.nostrconnectUri !== 'function' || typeof m.assertChallengeProof !== 'function')
           { console.error('module loaded but exported nothing expected'); process.exit(1) }
       })`], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    ok = true
  } catch (e) { detail = String(e.stderr || e.message).slice(0, 300) }
  check(ok, 'src/nostrconnect.mjs — the pairing listener — loads and exports under the absent global', detail)
}
{
  let ok = false, detail = ''
  try {
    execFileSync('node', ['--import', `file://${KILL_GLOBAL}`, '-e',
      `import(${JSON.stringify(join(REPO, 'src/nostr_signer.mjs'))}).then(m => {
         if (typeof m.bunkerSignerFromUri !== 'function' || typeof m.parseBunkerInput !== 'function')
           { console.error('module loaded but exported nothing expected'); process.exit(1) }
       })`], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    ok = true
  } catch (e) { detail = String(e.stderr || e.message).slice(0, 300) }
  check(ok, 'src/nostr_signer.mjs — the only module allowed to import nip46 — loads and re-exports it under the absent global', detail)
}

console.log(pass ? '\nWS RUNTIME PASS — the socket implementation is installed, not assumed'
                 : '\nWS RUNTIME FAIL')
process.exit(pass ? 0 : 1)
