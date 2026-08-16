// join_custody.mjs — `tools/join.mjs` is the caller this whole change exists for, and nothing drove
// it (#531 review).
//
// The only assertion tying that tool to the wrapper was a regex over its own source text. My Dude
// disabled the custody proof outright — `if (false) await signer.signEvent(…)`, matched literal left
// in a comment above it — and the suite stayed at 31/31 with `npm test` rc=0, printing
// `ok — tools/join.mjs proves custody over a FRESH nonce` while no custody was proved at all. That is
// #450 again: a source scan cannot tell a call from a string that looks like one.
//
// It matters more here than anywhere else in the tree. The PR's own thesis is that `join.mjs` is the
// caller where the substitution is invisible BECAUSE the signed event is discarded — so there is no
// downstream artifact to notice its absence either, and `join: custody proved` prints as fact over
// the seat write regardless.
//
// So this drives the real tool, as a real subprocess, over a real socket, against a signer that
// answers `sign_event` with a SCRAPED event: valid, signed by the pinned identity, and not the event
// that was submitted. Deliberately NOT an injected-deps extraction — an extraction leaves the call
// site exactly as untested as the grep did.
//
// The harness is one loopback TLS server wearing two hats, because both hops are wss-only by design
// (`relaySet` at src/relays.mjs:70, `makeBunkerSigner` at src/nostr_signer.mjs:45) and neither is
// being relaxed to make a test pass. Its certificate is minted per-run into a temp dir and trusted
// through NODE_EXTRA_CA_CERTS for the child alone: verification stays ON, and no key is ever
// committed to this repo.

import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { buildPairingToken, PAIRING_TOKEN_KIND } from '../src/pairing_token.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TOOL = join(ROOT, 'tools', 'join.mjs')
let pass = 0, fail = 0
const check = (ok, what) => { if (ok) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

const HIVE_KEY = generateSecretKey(), HIVE_PUB = getPublicKey(HIVE_KEY)
const ID_KEY = generateSecretKey(), ID_PUB = getPublicKey(ID_KEY)

const workdir = mkdtempSync(join(tmpdir(), 'wb-join-custody-'))
const certPath = join(workdir, 'cert.pem'), keyPath = join(workdir, 'key.pem')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=127.0.0.1',
  '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'pipe' })

// ── The relay, and the signer behind it ─────────────────────────────────────────────────────────
// One generic matcher rather than a special case per call site, so the harness cannot accidentally
// answer a filter the real tool never sends.
const matches = (f, ev) =>
  (!f.ids || f.ids.includes(ev.id)) &&
  (!f.kinds || f.kinds.includes(ev.kind)) &&
  (!f.authors || f.authors.includes(ev.pubkey)) &&
  (!f['#p'] || ev.tags.some(t => t[0] === 'p' && f['#p'].includes(t[1]))) &&
  (f.since === undefined || ev.created_at >= f.since)

let mode = 'honest'          // or 'scraped'
let sawSignRequest = false   // proves the run actually reached the custody proof

const store = []
const subs = new Set()       // { socket, id, filter }
const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) })
const wss = new WebSocketServer({ server })

const deliver = ev => {
  store.push(ev)
  for (const s of subs) {
    if (matches(s.filter, ev)) { try { s.socket.send(JSON.stringify(['EVENT', s.id, ev])) } catch { /* gone */ } }
  }
}

const sealTo = (payload, peerPub) => finalizeEvent({
  kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', peerPub]],
  content: nip44.v2.encrypt(JSON.stringify(payload), nip44.v2.utils.getConversationKey(ID_KEY, peerPub)),
}, ID_KEY)

let joinRequestSeen = false
wss.on('connection', socket => socket.on('message', bytes => {
  let frame
  try { frame = JSON.parse(bytes.toString()) } catch { return }

  if (frame[0] === 'REQ') {
    const [, id, filter] = frame
    subs.add({ socket, id, filter })
    for (const ev of store) if (matches(filter, ev)) socket.send(JSON.stringify(['EVENT', id, ev]))
    socket.send(JSON.stringify(['EOSE', id]))
    return
  }
  if (frame[0] !== 'EVENT') return
  const ev = frame[1]
  socket.send(JSON.stringify(['OK', ev.id, true, '']))
  store.push(ev)

  // The NIP-46 hat. `join.mjs` mints its client key inside the subprocess, so the peer is learned
  // from the request rather than known in advance.
  if (ev.kind === 24133 && ev.tags.some(t => t[0] === 'p' && t[1] === ID_PUB)) {
    let req
    try {
      req = JSON.parse(nip44.v2.decrypt(ev.content, nip44.v2.utils.getConversationKey(ID_KEY, ev.pubkey)))
    } catch { return }
    if (req.method === 'connect') return deliver(sealTo({ id: req.id, result: 'ack' }, ev.pubkey))
    if (req.method === 'get_public_key') return deliver(sealTo({ id: req.id, result: ID_PUB }, ev.pubkey))
    if (req.method === 'sign_event') {
      sawSignRequest = true
      const submitted = JSON.parse(req.params[0])
      // honest: sign what was submitted. scraped: a real, valid, correctly-signed event by the SAME
      // pinned identity — a public kind:0, which every identity here publishes by design — so the
      // signature verifies and the pin passes and only the comparison can tell the difference.
      const answer = mode === 'honest'
        ? finalizeEvent({ kind: submitted.kind, created_at: submitted.created_at,
          tags: submitted.tags || [], content: submitted.content || '' }, ID_KEY)
        : finalizeEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000) - 86400,
          tags: [], content: JSON.stringify({ name: 'scraped-from-a-public-relay' }) }, ID_KEY)
      return deliver(sealTo({ id: req.id, result: JSON.stringify(answer) }, ev.pubkey))
    }
    return deliver(sealTo({ id: req.id, error: `harness does not implement ${req.method}` }, ev.pubkey))
  }

  // The join request itself. Everything the owner would do by hand happens here, once.
  if (!joinRequestSeen) {
    joinRequestSeen = true
    const pairingUri = `bunker://${ID_PUB}?relay=${encodeURIComponent(RELAY_URL)}&secret=harness`
    // buildPairingToken throws on a malformed uri, so this doubles as an assertion that the harness
    // is handing the tool a pairing of the shape the tool is entitled to expect.
    const token = buildPairingToken({ requestId: ev.id, identityPubkey: ID_PUB, pairingUri,
      expiresAt: Math.floor(Date.now() / 1000) + 3600 })
    deliver(finalizeEvent({
      kind: PAIRING_TOKEN_KIND, created_at: ev.created_at + 1, tags: [['p', ev.pubkey]],
      content: nip44.v2.encrypt(token, nip44.v2.utils.getConversationKey(HIVE_KEY, ev.pubkey)),
    }, HIVE_KEY))
  }
}))

await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res) })
const RELAY_URL = `wss://127.0.0.1:${server.address().port}`

// ASYNC spawn, never spawnSync: this process IS the relay, and a synchronous child would block the
// event loop so the server never accepts a connection. That failure looks identical in both
// directions, which is to say it proves nothing.
const runJoin = (seatDir) => new Promise(res => {
  // Every run is a fresh owner-approves-once. Without this the second run inherits a spent latch,
  // gets no pairing token, and times out at rc=4 — a harness fault that reads exactly like the tool
  // refusing an honest signer, which would have made section 2 look like a real regression.
  joinRequestSeen = false
  sawSignRequest = false
  store.length = 0
  subs.clear()
  const child = spawn(process.execPath, [TOOL, '--hive', HIVE_PUB, '--wait', '25', '--seat', seatDir], {
    cwd: ROOT,
    env: { ...process.env, JOIN_RELAYS: RELAY_URL, NODE_EXTRA_CA_CERTS: certPath },
  })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  child.on('close', code => res({ rc: code, out }))
})

console.log('\n1. a scraped event is refused at the call site the grep could not see')

mode = 'scraped'
const scrapedSeat = join(workdir, 'seat-scraped')
const scraped = await runJoin(scrapedSeat)

check(sawSignRequest, 'ANCHOR — the tool actually asked for a signature, so this run reached the custody proof')
check(scraped.rc !== 0, `it exits non-zero (rc=${scraped.rc})`)
check(!/custody proved/.test(scraped.out),
  '`join: custody proved` is NOT printed — the line that gates the seat write is the line under test')
check(!existsSync(scrapedSeat),
  'and NOTHING is seated — not an empty directory, which every checker in this repo reads as progress')
// Assert the REASON, not only the refusal: `!ok` cannot tell a correct refusal from a correct
// refusal with a misleading explanation, and this message is what the operator acts on.
check(/DIFFERENT event than the one submitted/.test(scraped.out) && /kind/.test(scraped.out),
  '…and it says the signer returned a DIFFERENT event, naming the field that changed')
check(!/CUSTODY MISMATCH/.test(scraped.out),
  '…and NOT as a custody mismatch — the pin passed; the pin is not what caught this')

console.log('\n2. BOTH DIRECTIONS — an honest signer still gets through')

mode = 'honest'
sawSignRequest = false
const honestSeat = join(workdir, 'seat-honest')
const honest = await runJoin(honestSeat)

check(sawSignRequest, 'ANCHOR — this run also reached the custody proof')
check(honest.rc === 0, `an honest signature exits 0 (rc=${honest.rc})`)
check(/custody proved/.test(honest.out), '`join: custody proved` IS printed')
const seated = existsSync(honestSeat) ? readdirSync(honestSeat) : []
check(seated.length > 0, `and the pairing IS seated (${seated.join(', ') || 'nothing'})`)
check(seated.length > 0 && seated.every(f => (statSync(join(honestSeat, f)).mode & 0o777) === 0o600),
  '…every seated file at mode 600')

// Without this pair, section 1 cannot be told from a harness that refuses everything — which is the
// exact failure this suite exists to stop being possible.

server.close(); wss.close()
for (const s of subs) { try { s.socket.terminate() } catch { /* gone */ } }
rmSync(workdir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
