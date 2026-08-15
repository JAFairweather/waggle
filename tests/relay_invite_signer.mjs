// relay-invite: which identity signs, asserted against the REAL command line (#477, #478 review).
//
// `chooseSigningSource` is pure and tested directly in tests/nip98_auth.mjs. This file covers the
// part that is not pure and had no test at all: `buildSigner` in tools/relay-invite.mjs — reading
// the pairing out of the environment, the EXPECT_PUBKEY pre-flight, the key-file checks, and the
// banner that tells the operator which key is about to write permanent state. That code lives in a
// script with top-level execution, so it cannot be imported; it is exercised by running it.
//
// Every case here stops before a socket is opened. The chooser refusals never build a signer at
// all, and the paths that do build one use a local key file. BUZZ_RELAY_URL points at a closed
// port so the run ends immediately after the part under test, with no network and no relay.
//
// A subprocess can only ever drive the LOCAL key path, where the pairing address, the resolved
// identity and the pinned key are the same value — so the last block here drives
// `resolveSigner` in-process with a signer whose identity differs from its address, which is
// the only arrangement where pinning to the wrong one is visible. `makeBunkerSigner`'s own
// half — that the identity is ASKED via get_public_key — is in tests/nostr_signer.mjs.
//
//   node tests/relay_invite_signer.mjs

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { withPinnedCustody } from '../src/nostr_signer.mjs'
import { resolveSigner, signerBanner } from '../src/relay_invite_signer.mjs'

let pass = 0, fail = 0
const ok = (name, value) => { console.log(value ? 'ok  ' : 'FAIL', '—', name); value ? pass++ : fail++ }

const TOOL = fileURLToPath(new URL('../tools/relay-invite.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'waggle-invite-signer-'))

// A closed port, not a bad hostname: connection refused returns at once, where DNS for an invalid
// name can sit. Nothing here should ever depend on how long the network takes.
const DEAD_RELAY = 'http://127.0.0.1:1'

/** Run the tool with a clean environment and report what the operator would see. */
const run = (args, env = {}) => {
  const base = { PATH: process.env.PATH, HOME: dir, BUZZ_RELAY_URL: DEAD_RELAY }
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args],
      { env: { ...base, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out, err: '' }
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout || ''), err: String(e.stderr || '') }
  }
}
const said = (r, re) => re.test(r.err) || re.test(r.out)

try {
  const sk = generateSecretKey(), pk = getPublicKey(sk)
  const nsecLower = nip19.nsecEncode(sk)
  const files = {
    lower: join(dir, 'lower.nsec'),
    upper: join(dir, 'upper.nsec'),
    hex: join(dir, 'key.hex'),
    loose: join(dir, 'loose.nsec'),
    junk: join(dir, 'junk.nsec'),
    uri: join(dir, 'bunker-uri'),
    client: join(dir, 'bunker-client'),
  }
  writeFileSync(files.lower, `${nsecLower}\n`, { mode: 0o600 })
  writeFileSync(files.upper, `${nsecLower.toUpperCase()}\n`, { mode: 0o600 })
  writeFileSync(files.hex, `${Buffer.from(sk).toString('hex')}\n`, { mode: 0o600 })
  writeFileSync(files.loose, `${nsecLower}\n`, { mode: 0o644 })
  writeFileSync(files.junk, 'this is not a key\n', { mode: 0o600 })
  writeFileSync(files.uri, `bunker://${'a'.repeat(64)}?relay=wss%3A%2F%2Frelay.example\n`, { mode: 0o600 })
  writeFileSync(files.client, `${nip19.nsecEncode(generateSecretKey())}\n`, { mode: 0o600 })
  chmodSync(files.loose, 0o644)

  const pairing = { WAGGLE_BUNKER_URI_FILE: files.uri, WAGGLE_NIP46_CLIENT_NSEC_FILE: files.client }
  const mint = (args, env) => run(['mint', '--out', join(dir, `code-${Math.random().toString(36).slice(2)}`), ...args], env)

  // ── The chooser, read out of the real environment ───────────────────────────────────────────
  {
    const none = mint([])
    ok('no key and no pairing is refused', none.code === 1 && said(none, /no signing key/))
    ok('…and the error offers the bunker route, not only --key',
      said(none, /WAGGLE_BUNKER_URI_FILE/) && said(none, /--key/))

    const both = mint(['--key', files.lower], pairing)
    ok('--key together with a pairing is refused, not resolved by precedence',
      both.code === 1 && said(both, /will not pick one/))
    ok('…and the refusal names the permanent state at stake', said(both, /#366|cannot be removed/))

    const halfUri = mint([], { WAGGLE_BUNKER_URI_FILE: files.uri })
    ok('a pairing missing the client file is refused, naming the missing one',
      halfUri.code === 1 && said(halfUri, /WAGGLE_NIP46_CLIENT_NSEC_FILE/))
    const halfClient = mint([], { WAGGLE_NIP46_CLIENT_NSEC_FILE: files.client })
    ok('a pairing missing the URI file likewise',
      halfClient.code === 1 && said(halfClient, /WAGGLE_BUNKER_URI_FILE/))

    // An exported-but-empty env var is what a half-configured unit file looks like. Treating '' as
    // "configured" would refuse a --key the operator explicitly typed.
    const emptyEnv = mint(['--key', files.lower], { WAGGLE_BUNKER_URI_FILE: '', WAGGLE_NIP46_CLIENT_NSEC_FILE: '  ' })
    ok('an empty pairing env does not count as configured', said(emptyEnv, /minting as npub1/))
  }

  // ── The key file itself ──────────────────────────────────────────────────────────────────────
  {
    const missing = mint(['--key', join(dir, 'absent.nsec')])
    ok('a missing key file is refused, naming the path', missing.code === 1 && said(missing, /no key file at/))
    const loose = mint(['--key', files.loose])
    ok('a group-readable key file is refused as a finding', loose.code === 1 && said(loose, /must be 0600/))
    const junk = mint(['--key', files.junk])
    ok('a file holding neither an nsec nor hex is refused',
      junk.code === 1 && said(junk, /neither an nsec nor a 64-character hex key/))
  }

  // ── The identity the banner reports ─────────────────────────────────────────────────────────
  // This is the operator's only sight of which key is about to write an unremovable row, so it has
  // to be the key that will actually sign — and it has to appear for every valid key format.
  {
    const npub = nip19.npubEncode(pk)
    const lower = mint(['--key', files.lower])
    ok('a lowercase nsec signs, and the banner names that identity', said(lower, new RegExp(`minting as ${npub}\\b`)))

    // REGRESSION (#478 review). bech32 is case-insensitive and nip19.decode accepts NSEC1…, but
    // makeLocalSigner tests startsWith('nsec1') case-sensitively — so an uppercase file used to
    // fall through to the hex branch and be refused as "not a valid nsec or 64-hex key", which was
    // untrue of the file it described. Same key, same npub, or the tool is lying about its input.
    const upper = mint(['--key', files.upper])
    ok('an UPPERCASE nsec is the same key, not a rejected one', said(upper, new RegExp(`minting as ${npub}\\b`)))
    ok('…and is never described as invalid', !said(upper, /not a valid nsec|neither an nsec/))

    const hex = mint(['--key', files.hex])
    ok('a 64-hex key file resolves to the same identity', said(hex, new RegExp(`minting as ${npub}\\b`)))
    ok('the banner distinguishes the backend it used', said(hex, /local key file/))
  }

  // ── EXPECT_PUBKEY, both directions ──────────────────────────────────────────────────────────
  {
    const bad = mint(['--key', files.lower], { EXPECT_PUBKEY: 'not-hex' })
    ok('a malformed EXPECT_PUBKEY is refused before anything is signed',
      bad.code === 1 && said(bad, /64-character hex/))

    const wrong = mint(['--key', files.lower], { EXPECT_PUBKEY: 'f'.repeat(64) })
    ok('an EXPECT_PUBKEY naming a different key is refused', wrong.code === 1 && said(wrong, /does not match/))
    ok('…and prints BOTH keys, so the operator can see which pairing they picked up',
      said(wrong, new RegExp('f'.repeat(64))) && said(wrong, new RegExp(pk)))
    ok('…and says nothing was signed, in terms of the state at risk',
      said(wrong, /Refusing before signing/) && said(wrong, /writes state under whichever key signs/))

    // NEGATIVE CONTROL. Every assertion above is a refusal, and a pre-flight that refused
    // everything would satisfy all of them while making the tool useless. A matching EXPECT_PUBKEY
    // must get PAST the check and reach the relay — which is the failure this run should end on.
    const right = mint(['--key', files.lower], { EXPECT_PUBKEY: pk })
    ok('NEGATIVE CONTROL — a matching EXPECT_PUBKEY passes the pre-flight and signs',
      said(right, /minting as npub1/))
    ok('…and the run ends at the relay, not at the guard',
      said(right, /could not reach the relay/) && right.code === 2)
  }

  // ── The command surface still refuses what it always refused ────────────────────────────────
  {
    const noCmd = run([])
    ok('no subcommand still prints usage', noCmd.code === 1 && said(noCmd, /usage:/))
    ok('…and usage documents the bunker pairing as an alternative to --key',
      said(noCmd, /WAGGLE_BUNKER_URI_FILE/) && said(noCmd, /EXPECT_PUBKEY/))
    const ttl = mint(['--key', files.lower, '--ttl', '5'])
    ok('mint bounds are still enforced ahead of the signer', ttl.code === 1 && said(ttl, /minimum of 60s/))
    const noCode = run(['claim', '--key', files.lower])
    ok('claim still requires --code-file', noCode.code === 1 && said(noCode, /--code-file <path> is required/))
  }
  // ── The split case: pairing address ≠ identity ──────────────────────────────────────────────
  // Everything above runs the local-key path, where the pairing address, the resolved identity and
  // the pinned key are ALL THE SAME VALUE — so none of it can tell them apart. Three mutations
  // survived the full suite on exactly that blind spot (#478 review): pinning to `base.pubkey`
  // instead of the resolved identity, and both banners naming the address. This block is the only
  // arrangement in which those are distinguishable, and it drives the real decision code.
  {
    const uriHex = getPublicKey(generateSecretKey())          // what bunker:// names
    const userSk = generateSecretKey(), userPk = getPublicKey(userSk)   // what it signs as
    let asked = 0
    const split = (over = {}) => ({
      pubkey: uriHex, remote: true,
      userPubkey: async () => { asked++; return userPk },
      signEvent: async (e) => JSON.parse(JSON.stringify(finalizeEvent(e, userSk))),
      close() {}, ...over,
    })
    // A spy alongside the real wrapper: `pinned` proves the outcome, `pinnedTo` proves the argument.
    let pinnedTo = null
    const pin = (s, expect) => { pinnedTo = expect; return withPinnedCustody(s, expect) }
    const resolve = (over = {}, opts = {}) => resolveSigner(
      { uriFile: '/run/uri', clientFile: '/run/client', ...opts },
      { loadBunker: async () => split(over), loadLocal: async () => { throw new Error('not this path') }, pin })

    const r = await resolve()
    ok('the identity is the key the bunker reports, not the URI hex',
      r.identity === userPk && r.identity !== uriHex)
    ok('custody is pinned to that identity — NOT to the pairing address', pinnedTo === userPk)
    ok('…and the wrapper agrees', r.signer.pinned === userPk)
    ok('…so a signature by that identity is accepted rather than refused',
      (await r.signer.signEvent({ kind: 27235, created_at: 1, tags: [], content: '' })).pubkey === userPk)

    ok('the banner names the identity that will sign',
      signerBanner('claiming', r).includes(nip19.npubEncode(userPk)))
    ok('…and never the pairing address, which signs nothing',
      !signerBanner('claiming', r).includes(nip19.npubEncode(uriHex)))
    ok('…and still reports which backend it came from', /bunker pairing/.test(signerBanner('claiming', r)))

    // EXPECT_PUBKEY is compared against the RESOLVED identity. Naming the URI hex — the value an
    // operator reads straight off the pairing file — must fail, or the comparison is against the
    // wrong thing in the one case that matters.
    ok('EXPECT_PUBKEY naming the identity passes', !(await resolve({}, { expect: userPk })).error)
    const addr = await resolve({}, { expect: uriHex })
    ok('EXPECT_PUBKEY naming the PAIRING ADDRESS is refused', !!addr.error && /does not match/.test(addr.error))
    ok('…and the refusal is exit 1, the wrong-identity code', addr.code === 1)
    ok('…and hands back the signer so the caller can close the pool', !!addr.signer)

    // Finding 2 of the review: a malformed value used to cost a connect and an approval tap before
    // being told it was malformed. Asserted as "no round trip happened", not as message text.
    asked = 0
    const junkExpect = await resolve({}, { expect: 'not-hex' })
    ok('a malformed EXPECT_PUBKEY is refused for free — no identity round trip',
      /64-character hex/.test(String(junkExpect.error)) && asked === 0)

    // NEGATIVE CONTROLS — the guard must be able to pass, and must still refuse a broken signer.
    const local = await resolveSigner({ keyArg: '/k' }, {
      loadLocal: async () => ({ pubkey: userPk, remote: false, userPubkey: async () => userPk, close() {} }),
      loadBunker: async () => { throw new Error('not this path') }, pin })
    ok('NEGATIVE CONTROL — the local path still resolves and pins to its own key',
      !local.error && local.signer.pinned === userPk && /local key file/.test(signerBanner('minting', local)))

    const broken = await resolve({ userPubkey: async () => { throw new Error('nip46 get_public_key timed out') } })
    ok('a signer that cannot say who it is fails as a SIGNER fault, not bad input', broken.code === 2)
    ok('…and names the thing that could not be established', /which identity the signer holds/.test(broken.error))
    const junkId = await resolve({ userPubkey: async () => 'not-a-pubkey' })
    ok('a malformed identity is refused rather than pinned to', /nothing can be pinned/.test(String(junkId.error)))
  }
} finally { rmSync(dir, { recursive: true, force: true }) }

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
