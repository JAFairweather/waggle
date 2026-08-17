#!/usr/bin/env node
// publish-dm-relay-list.mjs — repair or declare one identity's NIP-17 inbox.
//
// The recipient's signed kind:10050 is the only authority for where sealed
// mail is delivered.  This intentionally updates ONLY that event: no kind:0
// profile and no kind:10002 general relay list are changed as a side effect.
//
// Two ways to sign, and the Bunker one is preferred (#381, #367):
//
//   NVOY_BUNKER=bunker://… EXPECT_PUBKEY=<npub|hex> \        # key never on this host
//     node tools/publish-dm-relay-list.mjs --dm-relays wss://…
//
//   NVOY_NSEC=… EXPECT_PUBKEY=<npub|hex> \                   # local key
//     node tools/publish-dm-relay-list.mjs --dm-relays wss://…
//
//   WAGGLE_BUNKER_URI_FILE=<path> WAGGLE_NIP46_CLIENT_NSEC_FILE=<path> \   # a seated pairing
//     EXPECT_PUBKEY=<npub|hex> node tools/publish-dm-relay-list.mjs --dm-relays wss://…
//
// The third form is preferred for an agent, and is the only one available to an agent that paired
// ITSELF: pair-agent.mjs spends the bunker URI's single-use secret, so the NVOY_BUNKER path can no
// longer mint a client key and answers `Unknown client`. See resolveSigner (#579).
//
// Until #381 this tool took NVOY_NSEC and nothing else, so the sanctioned
// custody model — key in the Bunker, nsec deleted — could not use it, and
// completing onboarding meant putting an nsec back on disk. A tool that
// forces a custody violation to finish the flow it serves undermines the
// design it implements.
//
// The key arrives through the environment, never argv. EXPECT_PUBKEY is
// mandatory so a copied shell environment cannot silently publish for the
// wrong standing identity — and on the Bunker path it is compared to
// get_public_key BEFORE sign_event is called, because a signature obtained
// under the wrong identity cannot be un-obtained. Success requires a fresh,
// signature-verified read-back — relay OK alone is not delivery evidence.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import WebSocket from '../src/ws_runtime.mjs'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { signDmRelayList } from './dm_relay_list_lib.mjs'
import { recipientDmRelays } from '../src/dm_relays.mjs'
import { DEFAULT_PUBLIC_RELAYS, relaySet } from '../src/relays.mjs'
import { bunkerSignerFromUri, loadBunkerSignerFiles, parseBunkerInput } from '../src/nostr_signer.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback = '') => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] || '' }
const die = message => { console.error(`publish-dm-relay-list: ${message}`); process.exit(1) }
const expected = flag('--expect-pubkey', process.env.EXPECT_PUBKEY || '').trim()
const bunkerUri = String(process.env.NVOY_BUNKER || '').trim()
const raw = String(process.env.NVOY_NSEC || process.env.SESSION_NSEC || '').trim()

// A seated pairing is a THIRD source, read from files rather than the environment (#579).
//
// `loadBunkerSignerFiles`, NOT `loadNostrSigner`. The latter also falls back to `BUZZ_PRIVATE_KEY`,
// which is set in the bridge host's environment — so using it here would make this tool see a
// signer on the box where it previously saw none, and collide with an `NVOY_NSEC` that has always
// worked. Widening what counts as a credential is not a side effect worth taking to save a line.
//
// It throws when only one of the two paths is set, which is a misconfiguration worth stopping on
// rather than falling through to "no signer configured" — that message would send someone looking
// for the wrong thing entirely.
//
// The narrow cut and the label below are load-bearing on each other, so do not "simplify" one
// without the other (#580 review). `sources` names this entry
// `the seated pairing (WAGGLE_BUNKER_URI_FILE)`. Under `loadNostrSigner`, `seated` would be truthy
// from `BUZZ_PRIVATE_KEY` with no such file set anywhere — and then every downstream message, the
// collision refusal here and `signDmRelayList`'s identity-mismatch refusal alike, would name a file
// the operator never touched. A refusal whose stated reason sends someone hunting for the wrong
// thing is the failure this repo has paid for more than once.
let seated = null
try {
  seated = loadBunkerSignerFiles(
    String(process.env.WAGGLE_BUNKER_URI_FILE || '').trim(),
    String(process.env.WAGGLE_NIP46_CLIENT_NSEC_FILE || '').trim())
} catch (e) { die(e.message) }

// Refusing to guess is the existing rule for NVOY_BUNKER + NVOY_NSEC; two identities are two
// identities however they were supplied, and this tool publishes the authority for where a person's
// mail is delivered. Naming which pair collided matters — "more than one signer" sends someone
// hunting through an environment they did not set.
const sources = [seated && 'the seated pairing (WAGGLE_BUNKER_URI_FILE)', bunkerUri && 'NVOY_BUNKER', raw && 'NVOY_NSEC/SESSION_NSEC'].filter(Boolean)
if (sources.length === 0) die('set WAGGLE_BUNKER_URI_FILE + WAGGLE_NIP46_CLIENT_NSEC_FILE (a pairing seated by tools/pair-agent.mjs, preferred), or NVOY_BUNKER, or NVOY_NSEC/SESSION_NSEC; a secret is never accepted as an argument')
if (sources.length > 1) die(`more than one signer is configured — refusing to guess which identity you meant: ${sources.join(' and ')}`)
if (!expected) die('set EXPECT_PUBKEY (or --expect-pubkey) so the target identity is explicit')

const toHex = value => {
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  try {
    const decoded = nip19.decode(value)
    if (decoded.type === 'npub') return decoded.data
  } catch { /* clear error below */ }
  die('EXPECT_PUBKEY must be an npub or 64-character public key')
}
const wanted = toHex(expected)

// The Bunker authorises a specific CLIENT keypair, not anyone holding the secret. A fresh key
// each run is an app the signer has never seen ("Unknown client"), so it is persisted — the same
// reasoning as tools/grant.mjs. This is the transport identity, never the signing one.
//
// ── And a pairing that already exists is the third source (#579) ────────────────────────────────
//
// The `NVOY_BUNKER` path below spends the URI's secret to authorise the client key it mints. That
// secret is single-use. `tools/pair-agent.mjs` spends it at pairing time, so an agent that paired
// ITSELF — the whole point of the nostrconnect path — arrives here with a perfectly good signer it
// cannot use, and gets `Unknown client`.
//
// That was invisible while every agent was hand-seated on a machine the maintainer controls, where
// a fresh URI was always to hand. It is not survivable for a remote agent, and it fails at the one
// step that cannot be skipped: with no kind:10050 the bridge has NO public-relay fallback by design
// (`src/bridge.mjs`), so it logs `RETURN not sent … no valid kind:10050` and drops every message.
// The agent sees an empty inbox, which is what no mail looks like.
//
// So the seated pairing is preferred when present. It is the same credential every other first-day
// tool reads — `agent-send`, `agent-inbox`, `publish_profile` — and reusing the client key
// `pair-agent` persisted is what makes it work where a fresh one cannot.
async function resolveSigner() {
  if (seated) {
    // NO `withPinnedCustody` here, deliberately. It was in the first draft of this change and a
    // mutation test proved it dead: `signDmRelayList` below already refuses on identity mismatch
    // BEFORE asking for a signature, then verifies the returned event, its author and its tags.
    // Removing the pin changed no assertion — untested armour that reads as protection is worse
    // than none, so it is gone rather than given a test that only exercises the wrapper.
    //
    // `userPubkey()` is a round trip to the signer, not a field: what a pairing CLAIMS to hold and
    // what it holds are different things, and this is the value signDmRelayList checks.
    return { pubkey: await seated.userPubkey(), sign: tmpl => seated.signEvent(tmpl), close: () => seated.close?.() }
  }
  if (!bunkerUri) {
    let secretKey
    try { secretKey = raw.startsWith('nsec1') ? nip19.decode(raw).data : Uint8Array.from(Buffer.from(raw, 'hex')) }
    catch { die('NVOY_NSEC is not a valid nsec or 64-hex key') }
    if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) die('NVOY_NSEC is not a 32-byte key')
    return { pubkey: getPublicKey(secretKey), sign: tmpl => finalizeEvent(tmpl, secretKey), close: () => {} }
  }
  const bp = await parseBunkerInput(bunkerUri)
  if (!bp?.pubkey) die('NVOY_BUNKER is not a valid bunker:// URI — expected bunker://<64-hex>?relay=wss://…&secret=…')
  const keyDir = process.env.WAGGLE_HOME || resolve(homedir(), '.waggle')
  const keyPath = resolve(keyDir, 'dm-relay-client.key')
  let clientSk
  if (existsSync(keyPath)) clientSk = Uint8Array.from(Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex'))
  else {
    clientSk = generateSecretKey()
    mkdirSync(keyDir, { recursive: true, mode: 0o700 })
    writeFileSync(keyPath, Buffer.from(clientSk).toString('hex'), { mode: 0o600 })
    console.error(`(new client key saved to ${keyPath} — approve this app in your signer once; later runs reuse it)`)
  }
  // Through `bunkerSignerFromUri`, not `nostr-tools/nip46` directly: nip46 inlines its own pool
  // and its own WebSocket lookup, which `ws_runtime` above cannot reach (#578).
  const bunker = bunkerSignerFromUri(clientSk, bp, { onauth: url => console.error(`approve this connection in your signer: ${url}`) })
  try { await bunker.connect() } catch (e) { die(`bunker connect failed: ${String(e?.message || e)}`) }
  return { pubkey: await bunker.getPublicKey(), sign: tmpl => bunker.signEvent(tmpl), close: () => bunker.close?.() }
}

const signer = await resolveSigner()
const pubkey = String(signer.pubkey || '').toLowerCase()

// nave.pub on top of the default set: this list is what tells a sender where to reach a Nave/Buzz
// identity, and leaving out the relay that community actually runs on makes the list wrong there.
const relays = relaySet(process.env.RELAY_RELAYS, [...DEFAULT_PUBLIC_RELAYS, 'wss://relay.nave.pub'])
const dmRelays = String(flag('--dm-relays', process.env.DM_RELAYS || relays.join(','))).split(',').map(s => s.trim())
let event
// signDmRelayList refuses on identity mismatch BEFORE asking for a signature, and re-checks the
// event that comes back — a remote signer is a network peer, not a library call.
try { event = await signDmRelayList(signer, dmRelays, wanted) }
catch (e) { await signer.close?.(); die(e.message) }
await signer.close?.()
const intended = event.tags.map(tag => tag[1])

function publish(url) {
  return new Promise(resolve => {
    let ws, done = false
    const finish = result => { if (done) return; done = true; try { ws?.close() } catch {} resolve({ url, ...result }) }
    try { ws = new WebSocket(url) } catch { return finish({ accepted: false, note: 'connect failed' }) }
    const timer = setTimeout(() => finish({ accepted: false, note: 'timeout' }), 12_000)
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])))
    ws.on('message', data => { try {
      const m = JSON.parse(data.toString())
      if (m[0] === 'OK' && m[1] === event.id) { clearTimeout(timer); finish({ accepted: !!m[2], note: m[2] ? 'accepted' : `rejected ${m[3] || ''}` }) }
    } catch {} })
    ws.on('error', error => { clearTimeout(timer); finish({ accepted: false, note: `error ${error.message}` }) })
  })
}

function readBack(url) {
  return new Promise(resolve => {
    let ws, done = false, found = null, answered = false
    const finish = () => { if (done) return; done = true; try { ws?.close() } catch {}; resolve({ url, found, answered }) }
    try { ws = new WebSocket(url) } catch { return finish() }
    const timer = setTimeout(finish, 10_000)
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'dm-list', { ids: [event.id], authors: [pubkey], kinds: [10050], limit: 1 }])))
    ws.on('message', data => { try {
      const m = JSON.parse(data.toString())
      if (m[0] === 'EVENT' && m[2]?.id === event.id) found = m[2]
      if (m[0] === 'EOSE') { answered = true; clearTimeout(timer); finish() }
    } catch {} })
    ws.on('error', () => { clearTimeout(timer); finish() })
  })
}

// Name the identity AND how it was signed. A run that does not say which key it resolved is
// indistinguishable from one that never checked — the same silence #382 is about.
console.error(`publish-dm-relay-list: ${nip19.npubEncode(pubkey)} (signed via ${bunkerUri ? 'Bunker — no key on this host' : 'local key in the environment'})`)
console.error(`  private-message relays: ${intended.join(', ')}`)
const writes = await Promise.all(relays.map(publish))
for (const result of writes) console.error(`  publish ${new URL(result.url).host.padEnd(20)} ${result.note}`)
await new Promise(resolve => setTimeout(resolve, 1500))
const reads = await Promise.all(relays.map(readBack))
let confirmed = 0
for (const result of reads) {
  const valid = result.found && verifyEvent(result.found)
    && result.found.pubkey === pubkey
    && JSON.stringify(recipientDmRelays([result.found], pubkey)) === JSON.stringify(intended)
  if (valid) confirmed++
  console.error(`  readback ${new URL(result.url).host.padEnd(20)} ${result.answered ? (valid ? 'VERIFIED' : 'not found or invalid') : 'no answer'}`)
}
console.error(`publish-dm-relay-list: confirmed on ${confirmed}/${relays.length} relay(s) by cold read-back`)
console.log(event.id)
process.exit(confirmed ? 0 : 1)
