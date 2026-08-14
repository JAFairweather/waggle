// publish_profile.mjs — the dual-push kind:0 publisher (#367).
//
// Dry-run only: no sockets, no relay, no real identity. The key is generated in-process and never
// leaves it — not into argv, not into the environment of anything but the child, not onto disk.
// The key here is generated in-process and never leaves it: no argv, no shell history.
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { withPinnedCustody } from '../src/nostr_signer.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'pp-'))
const sk = generateSecretKey()
const pk = getPublicKey(sk)
const hex = Buffer.from(sk).toString('hex')

const contentFile = join(dir, 'profile.json')
writeFileSync(contentFile, JSON.stringify({ display_name: 'Probe Agent', bot: true }))

let pass = true
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}${detail ? `  [${detail}]` : ''}`)
  if (!cond) pass = false
}

// The "no sockets" claim in the banner above is a property of the ARGV, not of --dry-run: without
// --content-file the tool reads the trio to adopt its content, which is three live connections with
// 12s timeouts inside `npm test`. Nothing enforced that, so enforce it here — and REFUSE rather
// than report, because reporting and spawning anyway would fail the suite AND dial out.
const run = (env, argv) => {
  if (!argv.includes('--content-file')) {
    ok('FIXTURE GUARD — every spawned case passes --content-file, so no case opens a socket', false, argv.join(' '))
    return { status: null, stdout: '', stderr: '' }
  }
  return spawnSync('node', ['tools/publish_profile.mjs', ...argv],
    { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } })
}

// 1. No signer at all. Must refuse, and say what is missing.
{
  const r = run({}, ['--dry-run', '--content-file', contentFile])
  // ASSERT THE REASON, not `/publish_profile:/`. That substring is echoed by any stack trace
  // through this file, so the old assertion passed on an unhandled TypeError — `loadNostrSigner`
  // returns null rather than throwing — and reported a crash as a refusal that "names what is
  // missing". Exit 1 was Node's uncaught-exception code, not a decision the tool made.
  ok('refuses with no signer configured, and names BOTH ways to configure one',
    r.status === 1 && /no signer configured/.test(r.stderr) &&
    /WAGGLE_BUNKER_URI_FILE/.test(r.stderr) && /BUZZ_PRIVATE_KEY/.test(r.stderr), `exit ${r.status}`)
  ok('  ...and it refuses rather than crashing — no stack trace, no TypeError',
    !/TypeError|^\s+at /m.test(r.stderr))
}

// 2. The happy path, dry. Signs, proves custody, builds BOTH copies, publishes nothing.
{
  const r = run({ BUZZ_PRIVATE_KEY: hex, EXPECT_PUBKEY: pk,
    BUZZ_RELAY_URL: 'wss://relay.invalid', BUZZ_AUTH_TAG: '["auth","probe"]' },
    ['--dry-run', '--content-file', contentFile])
  const e = r.stderr
  ok('dry run exits 0 and publishes nothing', r.status === 0 && /nothing published/.test(e), `exit ${r.status}`)
  ok('proves custody against EXPECT_PUBKEY', /CUSTODY PROVEN/.test(e) && e.includes(pk))
  ok('builds two copies with DIFFERENT ids', (() => {
    const t = e.match(/trio copy\s+([0-9a-f]{64})/), c = e.match(/community copy\s+([0-9a-f]{64})/)
    return t && c && t[1] !== c[1]
  })())
  ok('and says plainly they share content but are not one event', /different ids, because the community copy carries the auth tag/.test(e))
  ok('states the signature count BEFORE signing, so a bunker operator knows how many prompts to expect',
    /this run makes 2 signatures/.test(e) && e.indexOf('this run makes') < e.indexOf('CUSTODY PROVEN'))
}

// 3. NEGATIVE CONTROL. A custody check that has only ever passed proves nothing — so make it fail
//    on purpose and watch it say so. Same key, an EXPECT_PUBKEY that is somebody else.
{
  const other = getPublicKey(generateSecretKey())
  const r = run({ BUZZ_PRIVATE_KEY: hex, EXPECT_PUBKEY: other },
    ['--dry-run', '--content-file', contentFile])
  ok('NEGATIVE CONTROL — a signer that is not EXPECT_PUBKEY is refused, so the check can fail',
    r.status === 1 && /CUSTODY MISMATCH/.test(r.stderr), `exit ${r.status}`)
  ok('  ...and the refusal names both keys, so the operator can see which identity signed',
    r.stderr.includes(other) && r.stderr.includes(pk))
  ok('  ...and nothing was published on the refusal', /Nothing published/.test(r.stderr))
}

// 4. The community leg is skipped, loudly, when its env pair is absent — never silently.
{
  const r = run({ BUZZ_PRIVATE_KEY: hex }, ['--dry-run', '--content-file', contentFile])
  ok('skipping the community leg is stated, not silent',
    r.status === 0 && /BUZZ_RELAY_URL \/ BUZZ_AUTH_TAG unset/.test(r.stderr))
  ok('  ...and the signature count drops to 1 with it, rather than staying wrong',
    /this run makes 1 signature\b/.test(r.stderr))
}

// 5. A malformed content file is refused before anything is signed.
{
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, 'not json at all')
  const r = run({ BUZZ_PRIVATE_KEY: hex }, ['--dry-run', '--content-file', bad])
  ok('refuses a content file that is not a kind:0 body',
    r.status === 1 && /must hold the JSON body/.test(r.stderr), `exit ${r.status}`)
}

// 6. THE BLOCKING FINDING. A bunker answers every sign_event as an INDEPENDENT round trip, so a
//    check on the first signature says nothing about the fourth. This tool used to compare
//    EXPECT_PUBKEY against the trio copy alone: it printed CUSTODY PROVEN and exited 0 while the
//    community-bound copy — the one that writes the `users` row an at-word resolves against — was
//    signed by a different identity. Drive that exact shape: A first, B after.
{
  const skA = generateSecretKey(), pkA = getPublicKey(skA)
  const skB = generateSecretKey(), pkB = getPublicKey(skB)
  let n = 0
  const twoFaced = {
    pubkey: pkA, remote: true,
    signEvent: async ev => finalizeEvent(ev, ++n === 1 ? skA : skB),
    nip44Encrypt: async () => '', nip44Decrypt: async () => '', close() {},
  }
  const pinned = withPinnedCustody(twoFaced, pkA)

  const first = await pinned.signEvent({ kind: 0, created_at: 1, tags: [], content: '{}' })
  ok('the first signature by the pinned key is accepted', first.pubkey === pkA)

  let caught = null
  try { await pinned.signEvent({ kind: 0, created_at: 1, tags: [['auth', 'probe']], content: '{}' }) }
  catch (e) { caught = e }
  ok('SIGNATURE 2 SIGNED BY A DIFFERENT KEY IS REFUSED — the hole that sent #459 back',
    !!caught && /CUSTODY MISMATCH/.test(caught.message),
    caught ? 'refused' : 'RETURNED A SIGNATURE — the hole is open')
  ok('  ...and the refusal names which signature it was, and both keys',
    !!caught && /signature 2/.test(caught.message) &&
    caught.message.includes(pkB) && caught.message.includes(pkA))
  ok('  ...and carries exit 1 — the wrong identity is bad input, not a broken signer',
    !!caught && caught.exitCode === 1)
}

// 7. BOTH DIRECTIONS. A guard that refused the second signature unconditionally would pass §6 and
//    break every real run, which needs four signatures from the same key to go through.
{
  const sk2 = generateSecretKey(), pk2 = getPublicKey(sk2)
  const honest = {
    pubkey: pk2, remote: true,
    signEvent: async ev => finalizeEvent(ev, sk2),
    nip44Encrypt: async () => '', nip44Decrypt: async () => '', close() {},
  }
  const pinned = withPinnedCustody(honest, pk2)
  let every = true
  for (const kind of [0, 0, 27235, 27235]) {
    const s = await pinned.signEvent({ kind, created_at: 1, tags: [], content: '' })
    if (s.pubkey !== pk2) every = false
  }
  ok('all four signatures by the pinned key still get through, and are counted',
    every && pinned.signatures === 4, `${pinned.signatures} signatures`)
}

// 8. A signature that does not verify is a DIFFERENT failure from the wrong identity, and gets its
//    own exit code. Without this, exit 2 and exit 1 are indistinguishable to whoever is paged.
{
  const sk3 = generateSecretKey(), pk3 = getPublicKey(sk3)
  const broken = {
    pubkey: pk3, remote: true,
    // JSON round-trip on purpose: nostr-tools stamps a `verifiedSymbol` on what finalizeEvent
    // returns, and object spread copies symbols — so a spread "broken" event still reports as
    // verified and this case would pass without checking anything. A bunker's answer arrives over
    // JSON.parse and carries no such mark, which is what this reproduces.
    signEvent: async ev => ({ ...JSON.parse(JSON.stringify(finalizeEvent(ev, sk3))), sig: '11'.repeat(64) }),
    nip44Encrypt: async () => '', nip44Decrypt: async () => '', close() {},
  }
  let caught = null
  try { await withPinnedCustody(broken, pk3).signEvent({ kind: 0, created_at: 1, tags: [], content: '' }) }
  catch (e) { caught = e }
  ok('a signature that does not verify is refused as exit 2, not as a custody mismatch',
    !!caught && /does not verify/.test(caught.message) && caught.exitCode === 2)
}

// 9. STRUCTURAL. The wrapper is only a complete guard if nothing in the tool can sign around it.
//    `loaded` is the raw signer; it exists to be wrapped and must never be signed through or
//    handed to a function that signs.
{
  const src = readFileSync(join(ROOT, 'tools/publish_profile.mjs'), 'utf8')
  const callers = [...src.matchAll(/([A-Za-z_$][\w$]*)\.signEvent\(/g)].map(m => m[1])
  ok('every signEvent call in the tool is on the wrapped signer',
    callers.length >= 3 && callers.every(c => c === 'signer'), callers.join(' '))
  const passedTo = [...src.matchAll(/([A-Za-z_$][\w$]*)\s*\(\s*loaded\b/g)].map(m => m[1])
  ok('the raw signer is used only to build the wrapped one — never dereferenced, never passed on',
    passedTo.length === 1 && passedTo[0] === 'withPinnedCustody' && !/\bloaded\s*\./.test(src),
    passedTo.join(' ') || 'never passed')
}

// 10. NO CATCH ON A SIGNING PATH MAY SWALLOW A CUSTODY EXIT CODE (#459 re-read).
//
//    `withPinnedCustody` throws with an `exitCode`, and two call sites turn a throw from a signing
//    path into a value: `readBackCommunity` degrades to `{ reachable: false }`, the `pushCommunity`
//    call site to `{ status: 0 }`. Both re-raise first — and deleting either `if (e.exitCode)
//    die(...)` left every assertion above green, because all of them sit upstream of the push phase.
//
//    No false pass is reachable either way: with both swallowed the run lands on INCONCLUSIVE and
//    exits 3. What is lost is the verdict. A signer that answered as the WRONG identity on signature
//    3 or 4 would be reported as "could not check that relay" — the exact conflation between "bad"
//    and "unknown" the rest of this tool is built to refuse. So it is asserted, not left to the
//    defending comment beside it.
//
//    Structural, deliberately. Reaching those lines needs the push phase, which opens three live
//    websockets to the trio before the community leg is touched; a suite that dials out to prove a
//    catch block is a worse trade than a source scan that names which catch is unguarded.
{
  const src = readFileSync(join(ROOT, 'tools/publish_profile.mjs'), 'utf8')

  // Brace-matched rather than `[^}]*`. The pushCommunity catch closes over an object literal, so a
  // lazy negated class stops inside it — and would report the guard present when it had been cut.
  const block = (s, open) => {                       // `open` indexes the '{'
    let i = open + 1, depth = 1
    while (i < s.length && depth > 0) { if (s[i] === '{') depth++; else if (s[i] === '}') depth--; i++ }
    return { body: s.slice(open + 1, i - 1), end: i }
  }
  // A throw that can carry an exitCode originates at a signature or inside a function that takes one.
  const SIGNING = /\bsignEvent\s*\(|\bpushCommunity\s*\(/
  const signingCatches = (s) => {
    const found = []
    for (const m of s.matchAll(/\btry\s*\{/g)) {
      const t = block(s, m.index + m[0].length - 1)
      if (!SIGNING.test(t.body)) continue
      const c = /^\s*catch\s*\((\w+)\)\s*\{/.exec(s.slice(t.end))
      if (!c) continue
      const cb = block(s, t.end + c[0].length - 1)
      found.push({
        line: s.slice(0, m.index).split('\n').length,
        guarded: new RegExp(`\\b${c[1]}\\.exitCode\\b`).test(cb.body),
      })
    }
    return found
  }

  const sites = signingCatches(src)
  // Size floor. A walk that finds nothing reports every site guarded, which reads identically to a
  // tool with no unguarded catch in it.
  ok('the scan finds every catch on a signing path in the tool', sites.length >= 3,
    `${sites.length} found`)
  const swallowing = sites.filter(s => !s.guarded).map(s => `line ${s.line}`)
  ok('and every one of them consults exitCode before degrading — a custody result is never reported as "could not check"',
    sites.length >= 3 && swallowing.length === 0, swallowing.join(', ') || 'none')

  // NEGATIVE CONTROL, both directions. The zero above is a property of the tool only if this scan
  // can return non-zero, and only if it is not simply flagging every catch it sees.
  const SWALLOWS = `
try { nip98 = await signer.signEvent(t) }
catch (e) { return { reachable: false, why: e.message } }
`
  const RERAISES = `
try { p = await pushCommunity(signer, ev) }
catch (e) { if (e.exitCode) die(e.message, e.exitCode); p = { status: 0, text: e.message } }
`
  const UNRELATED = `
try { content = readFileSync(f, 'utf8') }
catch (e) { die('--content-file: ' + e.message) }
`
  ok('NEGATIVE CONTROL — a signing catch that degrades without checking exitCode IS flagged',
    signingCatches(SWALLOWS).length === 1 && !signingCatches(SWALLOWS)[0].guarded)
  ok('  ...and one that re-raises through an object literal is NOT — the brace match reads past it',
    signingCatches(RERAISES).length === 1 && signingCatches(RERAISES)[0].guarded)
  ok('  ...and a catch on no signing path is not dragged in, so this refuses the dangerous shape rather than every catch',
    signingCatches(UNRELATED).length === 0)
}

console.log(pass ? '\nALL PASS' : '\nSOMETHING FAILED')
process.exit(pass ? 0 : 1)
