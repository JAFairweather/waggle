#!/usr/bin/env node
// pair-agent.mjs — seat an agent's Bunker pairing without anything carrying a credential to it.
//
//   node tools/pair-agent.mjs --name <short-stable-id> [--expect <64-hex>] [--relay wss://…]
//                             [--root <dir>] [--timeout <seconds>] [--print-only]
//
// Prints a `nostrconnect://` request, waits for the operator to approve it in their signer, proves
// what the resulting pairing actually holds, and only then writes `credentials/bunker-uri` and
// `credentials/bunker-client` — mode 0600, in the agent's own directory, from material this process
// generated itself. Nothing is transported: see `src/nostrconnect.mjs` for why that is the point
// (#528).
//
// ── The order matters more than any single step ────────────────────────────────────────────────
//
// Prove, then write. A run that is declined, times out, or pairs to the wrong identity leaves NO
// files behind, because a half-seated `credentials/` directory is worse than an empty one: every
// checker in this repo reports on file presence, so it would read as progress. The signer is built
// from strings held in memory, so there is nothing to clean up on the failure paths — the files are
// only reached once custody has been proven.
//
// ── Exit codes ─────────────────────────────────────────────────────────────────────────────────
//
//   0  paired AND custody proven — a verified signature over THIS run's own challenge
//   1  refused — declined at the signer, a custody mismatch, a substituted event, or bad input
//   2  the signer returned a signature that does not verify at all
//   3  INCONCLUSIVE — no bound approval before the timeout, whether or not something answered.
//      Not the same as refused, and not fine.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { assertChallengeProof, awaitApproval, bunkerUriFrom, clientNsec, mintSecret, nostrconnectUri, REQUIRED_PERMS } from '../src/nostrconnect.mjs'
import { makeBunkerSigner, withPinnedCustody } from '../src/nostr_signer.mjs'
import { DEFAULT_PUBLIC_RELAYS } from '../src/relays.mjs'
import { acceptableName, normaliseName } from '../src/connect_flags.mjs'

const argv = process.argv.slice(2)
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] ?? '') : '' }
const all = n => argv.reduce((acc, a, i) => (a === n && argv[i + 1] ? [...acc, argv[i + 1]] : acc), [])
const has = n => argv.includes(n)
const die = (message, code = 1) => { console.error(`pair-agent: ${message}`); process.exit(code) }

const name = normaliseName(flag('--name'))
if (!acceptableName(name)) {
  die('usage: node tools/pair-agent.mjs --name <short-stable-id> [--expect <64-hex>] [--relay wss://…]\n' +
      '       [--root <dir>] [--timeout <seconds>] [--print-only]\n' +
      '  --name takes a short stable id: lowercase, 2–64 characters, from a-z0-9._- and starting\n' +
      '  with a letter or digit. It is the directory under --root, not the display name.')
}

const root = resolve(flag('--root') || join(homedir(), '.nvoy', 'desktop'))
const here = join(root, name)
const credDir = join(here, 'credentials')
const uriPath = join(credDir, 'bunker-uri')
const clientPath = join(credDir, 'bunker-client')

const expect = String(flag('--expect') || '').trim().toLowerCase()
if (expect && !/^[0-9a-f]{64}$/.test(expect)) die('--expect takes a 64-character hex pubkey')

const relays = all('--relay').length ? all('--relay') : [...DEFAULT_PUBLIC_RELAYS]
const bad = relays.filter(r => !/^wss:\/\/[^\s]+$/.test(r))
if (bad.length) die(`--relay takes wss:// URLs; refused ${bad.join(' ')}`)

const timeoutMs = Math.max(10, Number(flag('--timeout') || 180)) * 1000

// Refuse to clobber. A pairing already on disk is a live credential, and overwriting it silently
// orphans whatever the old one was authorising.
for (const p of [uriPath, clientPath]) {
  if (existsSync(p)) die(`${p} already exists — remove it deliberately before re-pairing, or pass a different --name`)
}

const clientKey = generateSecretKey()
const clientPubkey = getPublicKey(clientKey)
const secret = mintSecret()
const uri = nostrconnectUri({ clientPubkey, relays, secret, name: `waggle:${name}`, perms: REQUIRED_PERMS })

console.log('')
console.log(`Approve this in your signer. It is a REQUEST, not a credential: it authorises nothing`)
console.log(`until you approve it, and it is spent the moment you do or when it times out.`)
console.log('')
console.log(uri)
console.log('')
console.log(`  agent      ${name}`)
console.log(`  will hold  ${credDir}`)
console.log(`  asking for ${REQUIRED_PERMS.join(', ')}`)
console.log(`  ${expect ? `must sign as  ${expect}` : 'no --expect given, so the identity is REPORTED, not enforced'}`)
console.log('')
if (has('--print-only')) {
  console.log('--print-only: not waiting, and nothing was written.')
  process.exit(3)
}
console.log(`Waiting up to ${Math.round(timeoutMs / 1000)}s…`)

const { approval, unbound } = await awaitApproval({ relays, clientKey, secret, timeoutMs })

if (!approval) {
  // Two different silences, and the operator's next move differs. Nothing at all points at the
  // request never reaching a relay the signer watches. Something that answered but could not be
  // bound points at either a signer that does not implement the secret echo, or someone else on
  // one of these relays answering ahead of it — and this tool cannot tell those apart, which is
  // exactly why it seats neither.
  die(`no BOUND approval arrived in ${Math.round(timeoutMs / 1000)}s. That is INCONCLUSIVE, not a refusal.\n` +
      (unbound.length
        ? `  ${unbound.length} response${unbound.length === 1 ? '' : 's'} DID arrive and ${unbound.length === 1 ? 'was' : 'were'} not acted on, ` +
          'because none echoed this request\'s secret. Either your signer does not implement the echo, ' +
          'or something else on these relays answered. Try a relay your signer alone watches; if it ' +
          'still cannot echo, that signer cannot be seated by this tool.'
        : '  Nothing answered at all — the approval may still be sitting in your signer, or the ' +
          'request may have reached no relay it watches.') +
      '\n  Nothing was written.', 3)
}
// Bound first. A refusal that does not echo the secret is attacker-controlled text, and printing it
// as "the signer declined: <string>" attributes to the operator's own signer a sentence this tool
// has just said it will not attribute (#529 review). `awaitApproval` already withholds those, so
// this is the guard that keeps that true if it ever stops.
if (!approval.bound) {
  die('the response did not echo this request\'s secret, so it cannot be attributed to the approval ' +
      'you gave. This tool will not seat a pairing it cannot bind. Nothing was written.')
}
if (approval.refused) die(`the signer declined: ${approval.error}. Nothing was written.`)

// Custody, and it takes BOTH checks below. `get_public_key` is neither and cannot be: whoever
// answered controls every RPC response it sends, so it will answer with any key you were hoping
// for. `withPinnedCustody` verifies the returned signature and compares the signing key to the pin
// — necessary, and on its own still satisfiable by an impostor holding no key at all, which answers
// `sign_event` with a scraped public note authored by that key. `assertChallengeProof` is the half
// that closes it: the event that comes back must be the event that went out.
//
// kind:22242 is NIP-42's client-auth kind: ephemeral, so relays do not store it, and inert without
// a matching relay challenge. Signing one proves custody and authorises nothing. It is never
// published.
//
// The challenge is a FRESH nonce rather than the binding secret. They answer different questions —
// which approval this is, and who holds the key — and reusing one value for both would make a
// single leak satisfy two independent checks.
const nonce = mintSecret()
const bunkerUri = bunkerUriFrom({ signerPubkey: approval.signerPubkey, relays, secret })
const signer = withPinnedCustody(makeBunkerSigner(bunkerUri, clientNsec(clientKey), {
  uriLabel: 'the pairing you just approved', clientLabel: 'the client key this run generated',
}), expect)

let signed
try {
  signed = await signer.signEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000),
    tags: [['challenge', nonce]], content: `waggle pair-agent custody proof for ${name} — not published` })
  assertChallengeProof(signed, { kind: 22242, challenge: nonce })
} catch (e) {
  try { signer.close() } catch { /* already closed */ }
  die(`${e.message} Nothing was written.`, e.exitCode ?? 1)
}
try { signer.close() } catch { /* already closed */ }

// Only now. Everything above this line can fail, and every one of those failures leaves the
// credentials directory exactly as it found it.
mkdirSync(credDir, { recursive: true, mode: 0o700 })
writeFileSync(uriPath, `${bunkerUri}\n`, { mode: 0o600, flag: 'wx' })
writeFileSync(clientPath, `${clientNsec(clientKey)}\n`, { mode: 0o600, flag: 'wx' })

console.log('')
// Without `--expect` there is no pin, so `withPinnedCustody` skips its comparison and this run has
// established that the pairing can sign SOMETHING — not that it signs as the identity you meant.
// The request-time line above says so; a success banner that says otherwise is the contradiction an
// operator believes, because it is the last thing printed (#529 review).
console.log(expect
  ? 'PAIRED. Custody proven: a signature over this run\'s own challenge, verified against --expect.'
  : 'PAIRED, IDENTITY UNPINNED. The pairing signed this run\'s own challenge, so it holds a key —\n' +
    '  but no --expect was given, so nothing checked WHICH key. Re-run with --expect to pin it.')
console.log(`  signs as   ${signed.pubkey}${expect ? '  (matches --expect)' : '  (reported, not enforced)'}`)
console.log(`  wrote      ${uriPath}`)
console.log(`             ${clientPath}`)
console.log(`  both mode 0600. Neither value is printed here, and neither should ever be.`)
console.log('')
// Absolute, because the agent's cwd is its instance directory and every repo-relative command dies
// there with `Cannot find module` and exit 1 — the same code an unseated credential gives (#524).
console.log(`Confirm the install with:`)
console.log(`  node ${join(dirname(dirname(fileURLToPath(import.meta.url))), 'tools', 'connect-agent.mjs')} --name ${name} --check`)
