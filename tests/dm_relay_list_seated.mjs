// dm_relay_list_seated.mjs — a self-paired agent can publish its own kind:10050 (#579).
//
// THE DEFECT THIS EXISTS FOR. `publish-dm-relay-list.mjs` is the only tool that publishes a
// kind:10050, and it took a `bunker://` URI in `NVOY_BUNKER`, minted its own client keypair, and
// spent the URI's secret to authorise it. That secret is single-use, and `tools/pair-agent.mjs`
// spends it at pairing time — so an agent that paired ITSELF arrived here holding a working signer
// it could not use, and got `Unknown client`.
//
// It matters because the failure is total and silent downstream: with no kind:10050 the bridge has
// no public-relay fallback by design, logs `RETURN not sent … no valid kind:10050`, and drops every
// message. The agent sees an empty inbox — which is what no mail looks like.
//
// WHY THIS DRIVES THE TOOL AS A SUBPROCESS. The signer choice is made at module top level in a
// script, and the property is not "the seated branch was selected" — it is "an event was signed by
// the right key and stored". A test asserting the branch would stay green if the branch were taken
// and then could not sign, which is the exact shape of the bug it replaces.
//
// The relay is loopback TLS with a per-run certificate, because `relaySet` accepts `wss://` only
// and that requirement is not relaxed to make a test pass — the same reasoning, and the same
// harness shape, as tests/join_custody.mjs. It wears the NIP-46 hat too, so the seated pairing is
// exercised over a real transport rather than stubbed out.
//
// Run: node tests/dm_relay_list_seated.mjs   (exit 0 = pass, 1 = fail)

import { execFileSync, execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import * as nip19 from 'nostr-tools/nip19'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = join(REPO, 'tools/publish-dm-relay-list.mjs')

let pass = 0, fail = 0
const check = (ok, what, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${what}`) }
  else { fail++; console.log(`  FAIL ${what}${detail ? `\n         ${String(detail).slice(0, 300)}` : ''}`) }
}

// THREE keys, and the first two must differ or this harness proves less than it looks like it does.
//
//   SIGNER_KEY — the remote signer's TRANSPORT key. It is the hex in `bunker://<hex>`, and it is
//                what seals every kind:24133 envelope.
//   ID_KEY     — the IDENTITY the signer holds. It answers get_public_key and signs the kind:10050.
//
// NIP-46 permits these to differ, and a fixture that makes them equal cannot tell `signer.pubkey`
// (what the URI claims) from `signer.userPubkey()` (what the signer answers). A mutation swapping
// one for the other escaped against exactly that fixture — see the #538 review, where the same
// conflation made a pin pass for any bunker that answered.
const SIGNER_KEY = generateSecretKey(), SIGNER_PUB = getPublicKey(SIGNER_KEY)
const ID_KEY = generateSecretKey(), ID_PUB = getPublicKey(ID_KEY)
const OTHER_PUB = getPublicKey(generateSecretKey())

const workdir = mkdtempSync(join(tmpdir(), 'wb-dm-seated-'))
const certPath = join(workdir, 'cert.pem'), keyPath = join(workdir, 'key.pem')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=127.0.0.1',
  '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'pipe' })

const matches = (f, ev) =>
  (!f.ids || f.ids.includes(ev.id)) &&
  (!f.kinds || f.kinds.includes(ev.kind)) &&
  (!f.authors || f.authors.includes(ev.pubkey)) &&
  (!f['#p'] || ev.tags.some(t => t[0] === 'p' && f['#p'].includes(t[1])))

const store = []
const subs = new Set()
let sawSignRequest = false

const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) })
const wss = new WebSocketServer({ server })

const deliver = ev => {
  store.push(ev)
  for (const s of subs) if (matches(s.filter, ev)) { try { s.socket.send(JSON.stringify(['EVENT', s.id, ev])) } catch { /* gone */ } }
}
// The envelope is sealed by the TRANSPORT key — that is the author the client subscribes to.
const sealTo = (payload, peerPub) => finalizeEvent({
  kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', peerPub]],
  content: nip44.v2.encrypt(JSON.stringify(payload), nip44.v2.utils.getConversationKey(SIGNER_KEY, peerPub)),
}, SIGNER_KEY)

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

  // The NIP-46 hat. The client key is minted outside this process, so the peer is learned from the
  // request rather than known in advance.
  if (ev.kind === 24133 && ev.tags.some(t => t[0] === 'p' && t[1] === SIGNER_PUB)) {
    let req
    try { req = JSON.parse(nip44.v2.decrypt(ev.content, nip44.v2.utils.getConversationKey(SIGNER_KEY, ev.pubkey))) } catch { return }
    if (req.method === 'connect') return deliver(sealTo({ id: req.id, result: 'ack' }, ev.pubkey))
    // …but the IDENTITY is what it answers with, and what signs. This is the whole distinction.
    if (req.method === 'get_public_key') return deliver(sealTo({ id: req.id, result: ID_PUB }, ev.pubkey))
    if (req.method === 'sign_event') {
      sawSignRequest = true
      const signed = finalizeEvent(JSON.parse(req.params[0]), ID_KEY)
      return deliver(sealTo({ id: req.id, result: JSON.stringify(signed) }, ev.pubkey))
    }
  }
}))

await new Promise(r => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const RELAY_URL = `wss://127.0.0.1:${PORT}`

// ── A credentials directory in the shape pair-agent.mjs leaves behind ────────────────────────────
const credDir = join(workdir, 'credentials')
mkdirSync(credDir, { recursive: true, mode: 0o700 })
const clientSk = generateSecretKey()
const uriPath = join(credDir, 'bunker-uri'), clientPath = join(credDir, 'bunker-client')
// The URI names the TRANSPORT key, not the identity — and the secret is already spent, which is the
// state pair-agent.mjs leaves behind and the reason the NVOY_BUNKER path cannot be used here.
writeFileSync(uriPath, `bunker://${SIGNER_PUB}?relay=${encodeURIComponent(RELAY_URL)}&secret=already-spent`, { mode: 0o600 })
writeFileSync(clientPath, nip19.nsecEncode(clientSk), { mode: 0o600 })

const runTool = (env, args = []) => new Promise(done => {
  execFile('node', [TOOL, '--dm-relays', DM_RELAY, ...args], {
    cwd: REPO, timeout: 60_000,
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath, RELAY_RELAYS: RELAY_URL,
      // Cleared so a developer's own shell cannot supply a second signer and change what is tested.
      NVOY_BUNKER: '', NVOY_NSEC: '', SESSION_NSEC: '', BUZZ_PRIVATE_KEY: '',
      WAGGLE_BUNKER_URI_FILE: '', WAGGLE_NIP46_CLIENT_NSEC_FILE: '', EXPECT_PUBKEY: '',
      ...env },
  }, (err, stdout, stderr) => done({ code: err ? (err.code ?? 1) : 0, out: String(stdout), err: String(stderr) }))
})

// The list's CONTENT and the relay it is PUBLISHED TO are different things, and only the second is
// dialled here. `normalizeDmRelayList` refuses loopback and private addresses in the content — an
// SSRF guard on a recipient-controlled event — so the loopback stub cannot appear there. That guard
// is correct and is not relaxed to make this run: the content is a public name that is never dialled
// by this tool, and RELAY_RELAYS carries the stub.
const DM_RELAY = 'wss://relay.example.test'

const SEATED = { WAGGLE_BUNKER_URI_FILE: uriPath, WAGGLE_NIP46_CLIENT_NSEC_FILE: clientPath }

console.log('\n── the seated pairing actually signs and publishes ──')
{
  const r = await runTool({ ...SEATED, EXPECT_PUBKEY: ID_PUB })
  check(r.code === 0, 'exits 0 — the tool ran to a confirmed cold read-back', `${r.err.slice(-300)}`)
  check(sawSignRequest, '  …and reached sign_event, so the pairing was USED, not merely selected')
  const published = store.filter(e => e.kind === 10050 && e.pubkey === ID_PUB)
  check(published.length > 0, '  …and a kind:10050 for the seated identity reached the relay', `store kinds: ${[...new Set(store.map(e => e.kind))].join(',')}`)
  check(published.every(e => verifyEvent(e)), '  …signed, and verifying against that key')
  check(published.some(e => e.tags.some(t => t[0] === 'relay' && t[1] === DM_RELAY)),
    '  …naming the relay it was asked to name')
}

console.log('\n── NEGATIVE CONTROL: the arm that must fail, and for the stated reason ──')
{
  // A test that only proves the seated path is accepted cannot tell "accepts the right identity"
  // from "accepts anything". Pin to a key the bunker does not hold.
  sawSignRequest = false
  const before = store.filter(e => e.kind === 10050).length
  const r = await runTool({ ...SEATED, EXPECT_PUBKEY: OTHER_PUB })
  check(r.code !== 0, 'a pairing that resolves to another key is refused', `code ${r.code}`)
  check(!sawSignRequest, '  …BEFORE sign_event — a signature under the wrong identity cannot be un-obtained')
  check(store.filter(e => e.kind === 10050).length === before, '  …and nothing was published')
  check(/custody|pubkey|identity|expect/i.test(r.err),
    '  …with a reason that names the identity mismatch, not a generic failure', r.err.slice(-200))
}

console.log('\n── which signer is configured, and refusing to guess between two ──')
{
  const none = await runTool({ EXPECT_PUBKEY: ID_PUB })
  check(none.code !== 0, 'no signer at all is refused')
  check(/WAGGLE_BUNKER_URI_FILE/.test(none.err) && /NVOY_BUNKER/.test(none.err) && /NVOY_NSEC/.test(none.err),
    '  …naming all three sources, since the seated one is the only option for a self-paired agent', none.err.slice(-260))

  const half = await runTool({ WAGGLE_BUNKER_URI_FILE: uriPath, EXPECT_PUBKEY: ID_PUB })
  check(half.code !== 0, 'half a seated pairing is refused')
  check(/set both/i.test(half.err),
    '  …saying so, rather than falling through to "no signer configured" and misdirecting the search',
    half.err.slice(-200))

  const both = await runTool({ ...SEATED, NVOY_NSEC: nip19.nsecEncode(generateSecretKey()), EXPECT_PUBKEY: ID_PUB })
  check(both.code !== 0, 'two signers is refused rather than resolved by precedence')
  check(/seated pairing/.test(both.err) && /NVOY_NSEC/.test(both.err),
    '  …naming WHICH two collided', both.err.slice(-200))
}

console.log('\n── the regression this fix could have caused ──')
{
  // `loadNostrSigner` would also have accepted BUZZ_PRIVATE_KEY, which IS set in the bridge host's
  // environment. Using it here would have made this tool see a signer on the box where it saw none
  // before, and collide with an NVOY_NSEC that has always worked.
  //
  // The pin and the key MATCH here on purpose. An earlier version pinned to a different key, so the
  // run failed as an identity mismatch whether or not BUZZ_PRIVATE_KEY had been accepted as a
  // signer — and the mutation that swapped in `loadNostrSigner` escaped, because the assertion
  // could not tell the two refusals apart. With them matching, a tool that accepts this key
  // publishes successfully, and only a tool that never saw a signer refuses.
  const buzzSk = generateSecretKey()
  const r = await runTool({ BUZZ_PRIVATE_KEY: nip19.nsecEncode(buzzSk), EXPECT_PUBKEY: getPublicKey(buzzSk) })
  check(r.code !== 0,
    'BUZZ_PRIVATE_KEY alone is still not a signer for this tool — the seated path did not widen what counts as a credential',
    r.err.slice(-200))
  check(/set WAGGLE_BUNKER_URI_FILE/.test(r.err),
    '  …refusing for the RIGHT reason: no signer configured, not a mismatched identity', r.err.slice(-260))
  check(!store.some(e => e.kind === 10050 && e.pubkey === getPublicKey(buzzSk)),
    '  …and nothing was published under that key')

  // …and the path that has always worked still does. A fix that only proves the new door works
  // cannot tell that from having closed the old one.
  sawSignRequest = false
  const nsec = generateSecretKey()
  const local = await runTool({ NVOY_NSEC: nip19.nsecEncode(nsec), EXPECT_PUBKEY: getPublicKey(nsec) })
  check(local.code === 0, 'CONTROL: the local NVOY_NSEC path still publishes', local.err.slice(-300))
  check(store.some(e => e.kind === 10050 && e.pubkey === getPublicKey(nsec)),
    '  …and its event reached the relay')
}

wss.close(); server.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
