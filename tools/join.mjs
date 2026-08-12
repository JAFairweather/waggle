#!/usr/bin/env node
// join.mjs — the one command. A session with nothing asks to join a hive, and waits.
//
//   node tools/join.mjs --hive <npub|hex> --caps task,task-relay --purpose "what you are for"
//
// What this does, in order:
//   1. mints an EPHEMERAL request key — this is the envelope, NOT the identity (docs/DESIGN_JOIN.md)
//   2. publishes a signed join request naming the hive and the capabilities it wants
//   3. waits for a sealed reply addressed to the request key
//   4. prints what to do next, and burns the request key
//
// WHAT IT DOES NOT DO, and must not be described as doing. It does not mint the persistent agent
// identity — that is minted into the OWNER's Bunker when they approve, and this session never
// holds it. It does not pair. It does not post to the channel. Those steps need a Bunker and a
// responder; see docs/JOIN_RUNBOOK.md.
//
// THE RESPONDER IS NOT BUILT. `tools/join-approve.mjs` is a design, not a file — JOIN_RUNBOOK §6
// lists it first under "what is missing for the unattended loop". Until it exists the owner reads
// the request and issues the grants by hand from the console (§4 and §5). This comment and the
// output below both used to name that tool as though it existed, which sent an owner looking for
// a file that has never been in the tree.
//
// The request key is written to a 0600 file in a temp dir for the lifetime of the wait, because a
// reply sealed to it arrives after this process has been running for a while and a key held only
// in memory dies with a dropped connection. It is deleted on exit, on failure, and on signal.
// It is never printed.

import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { buildJoinRequest, REQUESTABLE_CAPS } from '../src/join_request.mjs'
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
if (!hiveArg) die('usage: node tools/join.mjs --hive <npub|hex> [--caps task,task-relay] [--purpose "..."] [--label name]')
const hive = toHex(hiveArg)
const caps = (arg('caps', 'task,task-relay')).split(',').map(s => s.trim()).filter(Boolean)
const purpose = arg('purpose', '')
const label = arg('label', '')
const waitSecs = Number(arg('wait', '900'))

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
console.log('request, decide, and issue the grants from the console (docs/JOIN_RUNBOOK.md §4 and §5).')
console.log('Send them the request id above. This session holds no key and never will.')
console.log()
console.log(`join: waiting up to ${waitSecs}s for the decision, then burning the request key…`)

// The wait is deliberately dumb: this build has no pairing step yet, so there is nothing for this
// process to do with an approval except tell the operator it happened. Claiming otherwise would be
// the thing this repo calls blurring shipped with designed.
await new Promise(r => setTimeout(r, Math.max(0, Math.min(waitSecs, 3600)) * 1000))
burn()
console.log('join: request key burned. If the owner approved, the grants are live on the hive —')
console.log('      check with the console access list. Pairing to the persistent identity is the')
console.log('      next step and is not built yet (docs/DESIGN_JOIN.md).')
