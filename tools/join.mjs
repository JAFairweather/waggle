#!/usr/bin/env node
// join.mjs — the one command. A session with nothing asks to join a hive, and waits.
//
//   node tools/join.mjs --hive <npub|hex> --caps task,task-relay --purpose "what you are for"
//
// What this does, in order:
//   1. mints an EPHEMERAL request key — this is the envelope, NOT the identity (docs/DESIGN_JOIN.md)
//   2. publishes a signed join request naming the hive and the capabilities it wants
//   3. waits for a pairing token sealed to the request key, and opens it (src/pairing_token.mjs)
//   4. PROVES the bunker actually controls the approved identity before writing anything
//   5. seats the pairing, and burns the request key
//
// WHAT IT DOES NOT DO, and must not be described as doing. It does not mint the persistent agent
// identity — that is minted into the OWNER's Bunker when they approve, and this session never
// holds it. What it seats is a NIP-46 pairing to that identity, which the owner can revoke; the
// key itself never moves. It does not post to the channel.
//
// THE RESPONDER IS NOT BUILT. `tools/join-approve.mjs` is a design, not a file — JOIN_RUNBOOK §6
// lists it first under "what is missing for the unattended loop". Until it exists the owner reads
// the request and issues the grants by hand from the console (§4 and §5), and seals the pairing
// token by hand too. This comment and the output below both used to name that tool as though it
// existed, which sent an owner looking for a file that has never been in the tree.
//
// WHY A CUSTODY CHALLENGE SITS BETWEEN OPENING THE TOKEN AND WRITING IT. Opening a sealed token
// proves who sealed it, not that the signer on the other end of the URI holds the identity the
// owner approved. `readPairingToken` says so — it returns `custodyUnproven: true` and no promise
// beyond that. A pairing seated without the challenge points somewhere unverified, and every later
// signature inherits the mistake. So the signature happens first, pinned, and is never published.
//
// The request key is written to a 0600 file in a temp dir for the lifetime of the wait, because a
// reply sealed to it arrives after this process has been running for a while and a key held only
// in memory dies with a dropped connection. It is deleted on exit, on failure, and on signal.
// It is never printed.

import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath, resolve } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, verifyEvent } from 'nostr-tools'
import { buildJoinRequest, REQUESTABLE_CAPS } from '../src/join_request.mjs'
import { readPairingToken, PAIRING_TOKEN_KIND } from '../src/pairing_token.mjs'
import { seatPlan, timeoutReport, firstTruthy } from '../src/pairing_seat.mjs'
import { makeBunkerSigner, withPinnedCustody } from '../src/nostr_signer.mjs'
import { relaySet } from '../src/relays.mjs'

const RELAYS = relaySet(process.env.JOIN_RELAYS)

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const die = (msg, code = 1) => { console.error(`join: ${msg}`); process.exit(code) }

const toHex = (v) => {
  const s = String(v || '').trim()
  if (/^npub1/i.test(s)) { try { return nip19.decode(s).data } catch { die('that npub does not decode') } }
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase()
  die(`"${s || '(nothing)'}" is not an npub or a 64-character hex key`)
}

const hiveArg = arg('hive')
if (!hiveArg) die('usage: node tools/join.mjs --hive <npub|hex> [--caps task,task-relay] [--purpose "..."] [--label name] [--seat <dir>]')
const hive = toHex(hiveArg)
const caps = (arg('caps', 'task,task-relay')).split(',').map(s => s.trim()).filter(Boolean)
const purpose = arg('purpose', '')
const label = arg('label', '')
const waitSecs = Number(arg('wait', '900'))
// Where a proven pairing is written. Absent, the ceremony still runs and still proves custody — it
// just discards the pairing at the end and says so. A dry run that silently seated a credential
// somewhere of its own choosing would be the worse default.
const seatDir = arg('seat') ? resolve(arg('seat')) : null

for (const cap of caps) {
  if (!REQUESTABLE_CAPS.includes(cap)) die(`"${cap}" cannot be requested — choose from: ${REQUESTABLE_CAPS.join(', ')}`)
}

// ── The ephemeral request key ───────────────────────────────────────────────────────────────
// Minted here, used to sign one request and to receive one sealed reply, then destroyed. It is
// never granted anything and never appears in the roster.
const secret = generateSecretKey()
const requestPubkey = getPublicKey(secret)
const keyDir = mkdtempSync(joinPath(tmpdir(), 'waggle-join-'))
const keyPath = joinPath(keyDir, 'request-key')
writeFileSync(keyPath, Buffer.from(secret).toString('hex'), { mode: 0o600 })
chmodSync(keyPath, 0o600)

// Burn on every exit path, including the ones nobody plans for. A request key that outlives the
// ceremony is a key on disk, which is the thing this design exists to avoid.
let burned = false
const burn = () => {
  if (burned) return
  burned = true
  try { rmSync(keyDir, { recursive: true, force: true }) } catch { /* nothing else to do at exit */ }
}
process.on('exit', burn)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { burn(); process.exit(130) })
process.on('uncaughtException', (e) => { burn(); die(`unexpected failure: ${e.message}`, 1) })

// ── Publish, then listen ────────────────────────────────────────────────────────────────────
const publish = (url, ev) => new Promise(resolve => {
  let ws, done = false
  const fin = (accepted) => { if (done) return; done = true; try { ws.close() } catch {} ; resolve({ url, accepted }) }
  try { ws = new WebSocket(url) } catch { return fin(false) }
  const t = setTimeout(() => fin(false), 10000)
  ws.onopen = () => ws.send(JSON.stringify(['EVENT', ev]))
  ws.onmessage = (m) => {
    try { const d = JSON.parse(m.data); if (d[0] === 'OK' && d[1] === ev.id) { clearTimeout(t); fin(!!d[2]) } } catch { /* not ours */ }
  }
  ws.onerror = () => { clearTimeout(t); fin(false) }
})

// A cold read-back of our own request by id, from a FRESH connection. Relays return OK and drop;
// others 503 while the write succeeded. An accepted count is not proof the request is fetchable.
const readBack = (url, id) => new Promise(resolve => {
  let ws, done = false, found = false
  const fin = () => { if (done) return; done = true; try { ws.close() } catch {} ; resolve({ url, found }) }
  try { ws = new WebSocket(url) } catch { return fin() }
  const t = setTimeout(fin, 10000)
  ws.onopen = () => ws.send(JSON.stringify(['REQ', 'rb', { ids: [id] }]))
  ws.onmessage = (m) => {
    try {
      const d = JSON.parse(m.data)
      if (d[0] === 'EVENT' && d[2]?.id === id) found = true
      if (d[0] === 'EOSE' || d[0] === 'CLOSED') { clearTimeout(t); fin() }
    } catch { /* not ours */ }
  }
  ws.onerror = () => { clearTimeout(t); fin() }
})

const unsigned = buildJoinRequest({ hivePubkey: hive, caps, purpose, label })
const request = finalizeEvent(unsigned, secret)

console.log(`join: asking ${nip19.npubEncode(hive)}`)
console.log(`join: as ${nip19.npubEncode(requestPubkey)}  (ephemeral — burned when this exits)`)
console.log(`join: requesting ${caps.join(', ')}`)

const results = await Promise.all(RELAYS.map(u => publish(u, request)))
const accepted = results.filter(r => r.accepted)
for (const r of results) console.log(`  ${new URL(r.url).host}: ${r.accepted ? 'accepted' : 'no'}`)
if (!accepted.length) { burn(); die('no relay accepted the request. Nothing was published.', 1) }

// Prove it rather than trust the OK.
const back = await Promise.all(accepted.map(r => readBack(r.url, request.id)))
const fetchable = back.filter(r => r.found)
if (!fetchable.length) {
  burn()
  die(`${accepted.length} relay(s) said OK but the request cannot be fetched back by id from any of them. Treat it as unpublished.`, 3)
}
console.log(`join: published and read back cold from ${fetchable.length}/${accepted.length} relay(s)`)
console.log()
console.log('Request id (the owner needs this to approve):')
console.log(`  ${request.id}`)
console.log()
console.log('Now the owner approves — BY HAND. There is no responder yet: nothing watches for this')
console.log('request, nothing will DM them, and no reply of theirs will be parsed. They read the')
console.log('request, decide, issue the grants from the console (docs/JOIN_RUNBOOK.md §4 and §5),')
console.log('and seal a pairing token back to the request key above.')
console.log('Send them the request id above. This session holds no key and never will.')
console.log()
console.log(`join: waiting up to ${waitSecs}s for a pairing token, then burning the request key…`)

// ── Wait for a pairing token sealed to R ────────────────────────────────────────────────────
// A token from anyone other than the hive this session asked to join is not a near miss to report
// with a decrypt failure — it is a stranger answering someone else's question, and it is dropped
// before the sealing key is even derived.
const conversation = (peer) => nip44.v2.utils.getConversationKey(secret, peer)

let refusals = 0

const listen = (url, deadline, reg) => new Promise(resolve => {
  let ws, done = false
  const fin = (opened) => { if (done) return; done = true; clearTimeout(t); try { ws.close() } catch {} ; resolve(opened) }
  try { ws = new WebSocket(url) } catch { return fin(null) }
  const t = setTimeout(() => fin(null), Math.max(0, deadline - Date.now()))
  // Another relay got there first: stop waiting on this one rather than sitting on its timer.
  reg.onCancel(() => fin(null))
  ws.onopen = () => ws.send(JSON.stringify(['REQ', 'pair',
    { kinds: [PAIRING_TOKEN_KIND], '#p': [requestPubkey], since: request.created_at }]))
  ws.onmessage = (m) => {
    let ev
    try {
      const d = JSON.parse(m.data)
      if (d[0] !== 'EVENT' || !d[2]) return
      ev = d[2]
    } catch { return }
    try {
      if (ev.pubkey !== hive || !verifyEvent(ev)) return
    } catch { return }
    let plaintext
    try { plaintext = nip44.v2.decrypt(ev.content, conversation(ev.pubkey)) } catch { return }
    const opened = readPairingToken(plaintext, { requestId: request.id })
    if (!opened.ok) {
      // Say it and keep listening. A refused token is not the end of the wait — but a wait that
      // swallowed the reason would look identical to no token ever arriving, and the two need
      // different things from the operator.
      refusals++
      console.error(`join: a token arrived from the hive and was refused — ${opened.reason}`)
      return
    }
    fin(opened)
  }
  ws.onerror = () => { clearTimeout(t); fin(null) }
})

const deadline = Date.now() + Math.max(0, Math.min(waitSecs, 3600)) * 1000
// First relay to deliver wins and the rest are cancelled. `Promise.all` here made the happy path
// wait out the whole --wait window on the relays that had nothing to say — see `firstTruthy`.
const opened = await firstTruthy(RELAYS.map(u => reg => listen(u, deadline, reg)))

if (!opened) {
  burn()
  const report = timeoutReport(refusals)
  console.log(`join: ${report.lines[0]}`)
  for (const line of report.lines.slice(1)) console.log(`      ${line}`)
  process.exit(report.exitCode)
}

// ── Prove custody before anything is written ────────────────────────────────────────────────
// The client key is this session's half of the NIP-46 pairing, not the identity. It is minted here
// and is worthless to anyone who does not also hold the URI.
const clientNsec = nip19.nsecEncode(generateSecretKey())
let pairingUri = opened.pairing.take()
let signer = null
try {
  signer = withPinnedCustody(makeBunkerSigner(pairingUri, clientNsec), opened.identityPubkey)
  // Signed, verified against the pinned pubkey, compared back against what was submitted, and never
  // published. The challenge is the proof; putting it on a relay would only tell the world a pairing
  // happened.
  //
  // A FRESH nonce, not `request.id`. That id is printed above and the operator is told to circulate
  // it, so anyone who has seen it can pre-sign — or scrape — an event carrying it. A challenge whose
  // value is public is not a challenge, and this is the one call in the tree where the signed event
  // is discarded rather than published, so nothing downstream would notice.
  await signer.signEvent({ kind: PAIRING_TOKEN_KIND, created_at: Math.floor(Date.now() / 1000),
    tags: [['challenge', randomBytes(16).toString('hex')]], content: '' })
  console.log(`join: custody proved — the signer signs as ${opened.identityPubkey}`)
} catch (e) {
  pairingUri = null
  opened.pairing.forget()
  try { signer?.close() } catch {}
  burn()
  die(`the pairing did not prove custody, so nothing was written: ${e.message}`, e.exitCode ?? 2)
} finally {
  try { signer?.close() } catch {}
}

// ── Seat it ─────────────────────────────────────────────────────────────────────────────────
if (seatDir) {
  mkdirSync(seatDir, { recursive: true, mode: 0o700 })
  const present = readdirSync(seatDir)
  const plan = seatPlan({ identityPubkey: opened.identityPubkey, pairingUri, clientNsec, present })
  if (!plan.ok) {
    pairingUri = null
    burn()
    die(`${plan.reason} Nothing was written; the request key is burned.`, 6)
  }
  for (const { name, value } of plan.files) {
    const path = joinPath(seatDir, name)
    writeFileSync(path, value + '\n', { mode: 0o600 })
    chmodSync(path, 0o600)
    console.log(`join: wrote ${path} (mode 600)`)
  }
  // The identity is on disk, so the next session can pin to it instead of trusting whatever the
  // bunker reports. Print the line the operator needs — the file is the record, this is the reminder.
  console.log(`join: pin the seat with  EXPECT_PUBKEY=${opened.identityPubkey}`)
} else {
  console.log('join: no --seat <dir> given, so the proven pairing was discarded. Re-run with --seat')
  console.log('      to keep it; the owner will have to approve again.')
}
pairingUri = null

burn()
console.log(`join: request key burned. Paired to ${nip19.npubEncode(opened.identityPubkey)}.`)
console.log(`      The pairing expires at ${new Date(opened.expiresAt * 1000).toISOString()} unless`)
console.log('      the owner extended it in their Bunker; the identity itself is theirs to revoke.')
