#!/usr/bin/env node
// seat-agent.mjs — seat an EXISTING `bunker://` pairing into an agent's runtime, after proving the
// bunker holds the identity that runtime is configured to be.
//
// The gap this fills, found by walking it rather than reading it. The console can take a
// `bunker://` URI and prove custody (`console/index.html`, the mint-bunker field), but a browser
// cannot write to `~/.nvoy/desktop/<agent>/credentials/`, so the proven pairing stops there.
// `pair-agent.mjs` writes those files, but only from a `nostrconnect://` approval it negotiated
// itself — it has no way to accept a URI the owner already has. `seatPlan` exists and had exactly
// one caller, `tools/join.mjs`, reachable only by running a whole join. So an agent whose identity
// was minted and enrolled in a Bunker had no supported path from "the owner holds a URI for it" to
// "the runtime can sign as it", and its install check reported `Bunker pairing MISSING` forever.
//
// The URI arrives BY FILE, never in argv: it is a credential, and argv reaches shell history and
// every process listing on the box. Nothing here prints it, its secret, or its relays.
//
// Custody is proved BEFORE anything is written, on the same argument as `join.mjs`: a pairing that
// cannot sign as the expected key is not a pairing worth seating, and a half-written credentials
// directory reads as progress to every checker in this repo.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { generateSecretKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { makeBunkerSigner, withPinnedCustody } from '../src/nostr_signer.mjs'
import { assertChallengeProof } from '../src/nostrconnect.mjs'
import { seatPlan } from '../src/pairing_seat.mjs'
import { PAIRING_TOKEN_KIND } from '../src/pairing_token.mjs'

const USAGE = `usage: node tools/seat-agent.mjs --name <agent> --uri-file <path> [--root <dir>] [--expect <64hex>]

  --uri-file  a file containing the bunker:// URI. NEVER pass the URI itself — it is a credential,
              and argv reaches shell history.
  --expect    the 64-hex identity this bunker must sign as. Defaults to the agent's runtime
              manifest when one exists, and falls back to the key named in the URI.`

const die = (message, code = 1) => { console.error(`seat-agent: ${message}`); process.exit(code) }
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}

const name = arg('name')
if (!name) die(USAGE)
// The same rule the rest of the tree enforces: a runtime directory is a slug, and a display name
// with a space produces a path no later command can name (#523).
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  die(`--name ${JSON.stringify(name)} is not a short stable id. Use lowercase letters, digits and hyphens — ` +
    'the display name is a different thing and is set by the agent\'s own kind:0.')
}
const uriFile = arg('uri-file')
if (!uriFile) die(USAGE)
const root = resolve(arg('root', join(homedir(), '.nvoy', 'desktop')))
const seatDir = join(root, name, 'credentials')

// ── Read the URI, without ever echoing it ───────────────────────────────────────────────────────
// Extracted by pattern rather than taken as the whole file, so a URI pasted into a note, an .rtf or
// a mail body still works. If extraction mangles it, the custody proof below fails and nothing is
// written — the tool never has to decide whether the text "looks right".
let fileText
try { fileText = readFileSync(uriFile, 'utf8') } catch (e) { die(`cannot read --uri-file: ${e.message}`) }
const found = fileText.replace(/\\'[0-9a-fA-F]{2}/g, '').replace(/\\[a-zA-Z]+-?\d* ?/g, ' ').replace(/[{}]/g, ' ')
  .match(/bunker:\/\/[0-9a-fA-F]{64}\S*/)
if (!found) die(`no bunker:// URI with a 64-hex key found in ${uriFile}`)
const pairingUri = found[0].replace(/[\s"'<>,)]+$/, '')

let uriKey = '', relayCount = 0
try {
  const u = new URL(pairingUri.replace('bunker://', 'https://'))
  uriKey = u.hostname.toLowerCase()
  relayCount = u.searchParams.getAll('relay').filter(r => /^wss:\/\//.test(r)).length
} catch { die('that bunker:// URI does not parse') }
if (!relayCount) die('that bunker:// URI carries no wss relay, so nothing can reach the signer')

// ── What identity must it sign as ───────────────────────────────────────────────────────────────
// The manifest is preferred over the URI, because the URI names the signer's TRANSPORT key and
// NIP-46 permits that to differ from the identity it holds. Seating a pairing against the URI's own
// hex would make the check tautological: it would pass for any bunker that answers.
const manifestPath = join(root, name, 'instances', `${name}.json`)
let fromManifest = ''
// A MANIFEST THAT EXISTS AND CANNOT BE READ IS A REFUSAL, NOT A FALLBACK. Swallowing the parse
// error left `fromManifest` empty, so the pin degraded to `uriKey` — the signer's TRANSPORT key,
// which is the tautological check three lines above say this must never be — while the note printed
// "no manifest and no --expect". Both false, and both in the direction that reads as working.
//
// Only consulted when there is no --expect: that flag is the explicit override, and a broken file
// the run was never going to read is not a reason to stop.
if (!arg('expect') && existsSync(manifestPath)) {
  let manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
  catch (error) {
    die(`${manifestPath} exists and is not readable JSON (${String(error.message).slice(0, 80)}). ` +
      'Fix it or pass --expect. Refusing rather than falling back to the URI\'s own key, which would pin this to the signer\'s transport key and pass for any bunker that answers.')
  }
  fromManifest = String(manifest && manifest.pubkey ? manifest.pubkey : '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(fromManifest)) {
    die(`${manifestPath} exists but names no usable pubkey. ` +
      'Fix it or pass --expect. Refusing rather than falling back to the URI\'s own key, which would pin this to the signer\'s transport key and pass for any bunker that answers.')
  }
}
const expect = String(arg('expect', '') || fromManifest || uriKey).toLowerCase()
if (!/^[0-9a-f]{64}$/.test(expect)) die('--expect takes a 64-character hex pubkey')
const pinSource = arg('expect') ? '--expect' : (fromManifest ? `${name}'s runtime manifest` : 'the URI itself')
if (pinSource === 'the URI itself') {
  console.log('seat-agent: NOTE — no manifest and no --expect, so the pin is the URI\'s own key.')
  console.log('            That proves the bunker can sign; it cannot prove it is the right identity.')
}

console.log(`  agent      ${name}`)
console.log(`  will hold  ${seatDir}`)
console.log(`  must sign as ${expect}  (from ${pinSource})`)
console.log(`  relays in the pairing: ${relayCount}. Neither the URI nor its secret is printed here.`)

// Refuse before touching the network if the seat is occupied — a live pairing that gets overwritten
// orphans whatever it authorised.
const present = existsSync(seatDir) ? readdirSync(seatDir) : []
const dryPlan = seatPlan({ identityPubkey: expect, pairingUri, clientNsec: 'placeholder', present })
if (!dryPlan.ok) die(`${dryPlan.reason} Nothing was written.`, 6)

// ── Prove custody, then write ───────────────────────────────────────────────────────────────────
const clientNsec = nip19.nsecEncode(generateSecretKey())
let signer = null
try {
  signer = withPinnedCustody(makeBunkerSigner(pairingUri, clientNsec), expect)
  // Ask the bunker which identity it actually holds. The pin alone compares what came back; this
  // compares what it CLAIMS, and a disagreement between the two is worth naming separately.
  const claimed = String(await signer.userPubkey() || '').toLowerCase()
  if (claimed !== expect) {
    die(`that bunker signs as ${claimed}, not ${expect}. Nothing was written — seating it would ` +
      `give ${name} an identity that is not its own.`, 1)
  }
  // A fresh nonce, never a value that appears anywhere else. The signed event is discarded, so
  // `assertChallengeProof` is the only thing that can tell a signature from a scraped public note
  // by the same key (#531).
  const challenge = randomBytes(16).toString('hex')
  const signed = await signer.signEvent({ kind: PAIRING_TOKEN_KIND, created_at: Math.floor(Date.now() / 1000),
    tags: [['challenge', challenge]], content: '' })
  assertChallengeProof(signed, { kind: PAIRING_TOKEN_KIND, challenge })
  console.log(`seat-agent: custody proved — the bunker signed a fresh challenge as ${expect}`)
} catch (e) {
  try { signer?.close() } catch { /* nothing open */ }
  die(`the pairing did not prove custody, so nothing was written: ${e.message}`, e.exitCode ?? 2)
} finally {
  try { signer?.close() } catch { /* nothing open */ }
}

const plan = seatPlan({ identityPubkey: expect, pairingUri, clientNsec, present })
if (!plan.ok) die(`${plan.reason} Nothing was written.`, 6)
mkdirSync(seatDir, { recursive: true, mode: 0o700 })
for (const { name: file, value } of plan.files) {
  const path = join(seatDir, file)
  writeFileSync(path, value + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  console.log(`seat-agent: wrote ${path} (mode 600)`)
}
console.log(`\nSEATED. ${name} can now sign as ${expect} through the owner's bunker.`)
console.log('Confirm it with:')
console.log(`  node tools/connect-agent.mjs --name ${name} --lane sealed --check --pubkey ${expect}`)
