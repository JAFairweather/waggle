// publish_profile.mjs — the dual-push kind:0 publisher (#367).
//
// Dry-run only: no sockets, no relay, no real identity. The key is generated in-process and never
// leaves it — not into argv, not into the environment of anything but the child, not onto disk.
// The key here is generated in-process and never leaves it: no argv, no shell history.
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

const ROOT = new URL('..', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'pp-'))
const sk = generateSecretKey()
const pk = getPublicKey(sk)
const hex = Buffer.from(sk).toString('hex')

const contentFile = join(dir, 'profile.json')
writeFileSync(contentFile, JSON.stringify({ display_name: 'Probe Agent', bot: true }))

const run = (env, argv) => spawnSync('node', ['tools/publish_profile.mjs', ...argv],
  { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } })

let pass = true
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}${detail ? `  [${detail}]` : ''}`)
  if (!cond) pass = false
}

// 1. No signer at all. Must refuse, and say what is missing.
{
  const r = run({}, ['--dry-run', '--content-file', contentFile])
  ok('refuses with no signer configured, and names what is missing',
    r.status === 1 && /publish_profile:/.test(r.stderr), `exit ${r.status}`)
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
}

// 5. A malformed content file is refused before anything is signed.
{
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, 'not json at all')
  const r = run({ BUZZ_PRIVATE_KEY: hex }, ['--dry-run', '--content-file', bad])
  ok('refuses a content file that is not a kind:0 body',
    r.status === 1 && /must hold the JSON body/.test(r.stderr), `exit ${r.status}`)
}

console.log(pass ? '\nALL PASS' : '\nSOMETHING FAILED')
process.exit(pass ? 0 : 1)
