// seat_agent.mjs — `tools/seat-agent.mjs` writes a credential, so nothing about it may be asserted
// by reading its source. It is driven here as a real subprocess against a real NIP-46 signer over a
// real socket, the shape #531's review established for `join.mjs`.
//
// The four properties that matter, each with the direction that proves it is not a tool which
// refuses everything:
//
//   1. a bunker that signs as a DIFFERENT key is refused, and nothing is written
//   2. a bunker that answers a substituted event is refused, and nothing is written
//   3. an occupied seat is refused BEFORE the network, so a live pairing is never overwritten
//   4. an honest bunker is seated — three files, mode 600, and the identity it actually signs as
//
// Sections 1 and 2 fail differently and the difference is the point: the pin catches a wrong key,
// and only the wrapper's comparison catches a right key answering the wrong event. A suite that
// could not tell them apart would pass with either half deleted.
//
// It also asserts what must NEVER appear on stdout or stderr: the URI, its secret, and the client
// key the tool mints. A credential tool that leaks into a terminal scrollback has failed even when
// it seats correctly, and this is the only place that can see the output.
//
// The harness is one loopback TLS server, because `makeBunkerSigner` is wss-only by design
// (src/nostr_signer.mjs) and that is not being relaxed to make a test pass. Its certificate is
// minted per run into a temp dir and trusted through NODE_EXTRA_CA_CERTS for the child alone, so
// verification stays ON and no key is committed to this repo.

import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TOOL = join(ROOT, 'tools', 'seat-agent.mjs')
let pass = 0, fail = 0
const check = (ok, what) => { if (ok) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

// The bunker's own key, and a second identity it can wrongly claim to be.
const ID_KEY = generateSecretKey(), ID_PUB = getPublicKey(ID_KEY)
const OTHER_PUB = getPublicKey(generateSecretKey())

const workdir = mkdtempSync(join(tmpdir(), 'wb-seat-agent-'))
const certPath = join(workdir, 'cert.pem'), keyPath = join(workdir, 'key.pem')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=127.0.0.1',
  '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'pipe' })

let mode = 'honest'          // 'honest' | 'wrong-key' | 'scraped'
let sawSignRequest = false   // proves a run actually reached the custody proof

const store = []
const subs = new Set()
const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) })
const wss = new WebSocketServer({ server })

const matches = (f, ev) =>
  (!f.ids || f.ids.includes(ev.id)) &&
  (!f.kinds || f.kinds.includes(ev.kind)) &&
  (!f.authors || f.authors.includes(ev.pubkey)) &&
  (!f['#p'] || ev.tags.some(t => t[0] === 'p' && f['#p'].includes(t[1]))) &&
  (f.since === undefined || ev.created_at >= f.since)

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
  if (ev.kind !== 24133 || !ev.tags.some(t => t[0] === 'p' && t[1] === ID_PUB)) return

  let req
  try {
    req = JSON.parse(nip44.v2.decrypt(ev.content, nip44.v2.utils.getConversationKey(ID_KEY, ev.pubkey)))
  } catch { return }

  if (req.method === 'connect') return deliver(sealTo({ id: req.id, result: 'ack' }, ev.pubkey))
  if (req.method === 'get_public_key') {
    // 'wrong-key' answers with an identity this bunker does not hold. The tool must refuse on the
    // CLAIM, before it ever asks for a signature — so `sawSignRequest` staying false is the assertion.
    return deliver(sealTo({ id: req.id, result: mode === 'wrong-key' ? OTHER_PUB : ID_PUB }, ev.pubkey))
  }
  if (req.method === 'sign_event') {
    sawSignRequest = true
    const submitted = JSON.parse(req.params[0])
    // honest: sign what was submitted. scraped: a real, valid event signed by the SAME pinned key —
    // so the signature verifies and the pin passes, and only the wrapper's comparison can tell.
    const answer = mode === 'scraped'
      ? finalizeEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000) - 86400, tags: [],
        content: JSON.stringify({ name: 'scraped-from-a-public-relay' }) }, ID_KEY)
      : finalizeEvent({ kind: submitted.kind, created_at: submitted.created_at,
        tags: submitted.tags || [], content: submitted.content || '' }, ID_KEY)
    return deliver(sealTo({ id: req.id, result: JSON.stringify(answer) }, ev.pubkey))
  }
  return deliver(sealTo({ id: req.id, error: `harness does not implement ${req.method}` }, ev.pubkey))
}))

await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res) })
const RELAY_URL = `wss://127.0.0.1:${server.address().port}`

// The secret is a distinct, searchable value so the leak assertion cannot pass by accident: a
// generic word would appear in the output for unrelated reasons and the check would prove nothing.
const SECRET = 'sekrit-canary-4e28a9cc'
const URI = `bunker://${ID_PUB}?relay=${encodeURIComponent(RELAY_URL)}&secret=${SECRET}`
const uriFile = join(workdir, 'uri.txt')
writeFileSync(uriFile, `A note the operator pasted it into.\n\n${URI}\n\ntrailing prose\n`)

// ASYNC spawn, never spawnSync: this process IS the relay, and a synchronous child would block the
// event loop so the server never accepts. That failure looks identical in both directions.
const runSeat = (root, extra = []) => new Promise(res => {
  sawSignRequest = false
  store.length = 0
  subs.clear()
  const child = spawn(process.execPath, [TOOL, '--name', 'probe-agent', '--uri-file', uriFile, '--root', root, ...extra],
    { cwd: ROOT, env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath } })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  child.on('close', code => res({ rc: code, out }))
})
const seatOf = root => join(root, 'probe-agent', 'credentials')

console.log('\n1. a bunker holding a DIFFERENT identity is refused')

mode = 'wrong-key'
const wrongRoot = join(workdir, 'r-wrong')
const wrong = await runSeat(wrongRoot, ['--expect', ID_PUB])
check(wrong.rc !== 0, `it exits non-zero (rc=${wrong.rc})`)
check(!existsSync(seatOf(wrongRoot)),
  'and NOTHING is seated — not an empty directory, which every checker in this repo reads as progress')
// Assert the REASON, not only the refusal: this message is what the operator acts on, and a correct
// refusal with a misleading explanation is indistinguishable from a correct one by `!ok` alone.
check(/signs as/.test(wrong.out) && wrong.out.includes(OTHER_PUB),
  '…and it names the key the bunker actually claims, not just that something was wrong')
check(!sawSignRequest,
  '…and it never asked for a signature — a wrong identity is settled before the bunker is made to sign')

console.log('\n2. a bunker that answers a SUBSTITUTED event is refused (#531, at this call site)')

mode = 'scraped'
const scrapedRoot = join(workdir, 'r-scraped')
const scraped = await runSeat(scrapedRoot, ['--expect', ID_PUB])
check(sawSignRequest, 'ANCHOR — the tool actually asked for a signature, so this run reached the custody proof')
check(scraped.rc !== 0, `it exits non-zero (rc=${scraped.rc})`)
check(!existsSync(seatOf(scrapedRoot)), 'and NOTHING is seated')
// This is asserted ACROSS BOTH LAYERS on purpose. The comment below predicted #531 would catch this
// twice; what it actually does is catch it FIRST, in the \`src/nostr_signer.mjs\` wrapper, which
// short-circuits before \`assertChallengeProof\` is ever reached and reports in its own words
// ("than the one submitted — kind, content, tags, created_at changed"). Pinning either layer's
// sentence makes this suite a test of which guard fired, and it broke on exactly that. The property
// the operator needs is unchanged: they are told a different event came back, and told which fields
// carried the substitution.
check(/DIFFERENT event than the one (it was asked to sign|submitted)/.test(scraped.out) &&
  /(the challenge tag is|tags(,| )|, tags)/.test(scraped.out),
  '…and it says the signer returned a DIFFERENT event, naming the fields that carried it')
// On `main` the pinned wrapper checks that the signature verifies and that the KEY is right — not
// that the event came back unchanged. So what catches this here is the tool's own
// `assertChallengeProof`, and the assertion below records that: `CUSTODY MISMATCH` is the wrapper's
// wording, and its absence is the evidence that the pin passed and something else did the work.
// #531 adds the wrapper-level comparison; when it lands this is caught twice, and this suite still
// holds, because it asserts the refusal the operator reads rather than which layer produced it.
check(!/CUSTODY MISMATCH/.test(scraped.out),
  '…and NOT as a custody mismatch — the key was right, so the pin is not what caught this')

console.log('\n3. BOTH DIRECTIONS — an honest bunker is seated')

mode = 'honest'
const goodRoot = join(workdir, 'r-good')
const good = await runSeat(goodRoot, ['--expect', ID_PUB])
check(sawSignRequest, 'ANCHOR — this run also reached the custody proof')
check(good.rc === 0, `an honest bunker exits 0 (rc=${good.rc})`)
check(/custody proved/.test(good.out), '`custody proved` IS printed')
const seated = existsSync(seatOf(goodRoot)) ? readdirSync(seatOf(goodRoot)).sort() : []
check(seated.join(',') === 'bunker-client,bunker-uri,identity', `all three files are seated (${seated.join(', ') || 'nothing'})`)
check(seated.length === 3 && seated.every(f => (statSync(join(seatOf(goodRoot), f)).mode & 0o777) === 0o600),
  '…every seated file at mode 600')
check(readFileSync(join(seatOf(goodRoot), 'identity'), 'utf8').trim() === ID_PUB,
  '…and `identity` holds the key the bunker actually signed as')
// The URI is extracted from surrounding prose, so prove what landed is the URI and not the prose.
check(readFileSync(join(seatOf(goodRoot), 'bunker-uri'), 'utf8').trim() === URI,
  '…and `bunker-uri` holds the URI itself, lifted clean out of the note it was pasted into')

console.log('\n4. an occupied seat is refused, before the network')

const occupied = await runSeat(goodRoot, ['--expect', ID_PUB])
check(occupied.rc !== 0, `a second run over a live pairing exits non-zero (rc=${occupied.rc})`)
check(!sawSignRequest,
  '…without contacting the bunker — a spent secret cannot be re-spent, so asking is the harm')
check(readFileSync(join(seatOf(goodRoot), 'identity'), 'utf8').trim() === ID_PUB,
  '…and the pairing that was already there is untouched')

console.log('\n4b. a manifest that exists and cannot be read is a REFUSAL, not a fallback')

// The degradation this closes: the parse error was swallowed, so `fromManifest` stayed empty and the
// pin fell through to the URI's own key — the signer's TRANSPORT key, which NIP-46 permits to differ
// from the identity, so the check passes for any bunker that answers. And the note printed "no
// manifest and no --expect". Both false, both in the direction that reads as having worked.
const withManifest = (dir, contents) => {
  const p = join(dir, 'probe-agent', 'instances', 'probe-agent.json')
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, contents)
  return p
}

mode = 'honest'
const brokenRoot = join(workdir, 'r-broken')
const brokenPath = withManifest(brokenRoot, '{ this is not json')
const broken = await runSeat(brokenRoot)
check(broken.rc !== 0, `a malformed manifest with no --expect refuses (rc=${broken.rc})`)
check(broken.out.includes(brokenPath), '…and NAMES the file, so the operator knows which one to fix')
check(!/no manifest and no --expect/.test(broken.out),
  '…and does NOT claim there is no manifest — the old note said that while a manifest sat right there')
check(!existsSync(seatOf(brokenRoot)), '…and nothing is seated')

const emptyRoot = join(workdir, 'r-nopub')
const emptyPath = withManifest(emptyRoot, JSON.stringify({ instance: 'probe-agent' }))
const empty = await runSeat(emptyRoot)
check(empty.rc !== 0 && empty.out.includes(emptyPath),
  'a manifest carrying no pubkey refuses the same way, and names the file too')

// POSITIVE CONTROL, and it is the one that matters: a refusal on every manifest would satisfy both
// assertions above while making the tool useless. A VALID manifest is read, is named as the pin
// source, and the run goes on to the custody proof.
mode = 'wrong-key'
const validRoot = join(workdir, 'r-validman')
withManifest(validRoot, JSON.stringify({ instance: 'probe-agent', pubkey: ID_PUB }))
const valid = await runSeat(validRoot)
check(/runtime manifest/.test(valid.out),
  'POSITIVE CONTROL — a valid manifest IS read, and named as where the pin came from')
check(valid.out.includes(ID_PUB) && /signs as/.test(valid.out),
  '…and the run reaches the custody proof, refusing on the KEY rather than on the manifest')

// --expect is the explicit override, so a manifest this run was never going to read must not stop
// it. Refusing here would block an operator who already named the key they mean.
const overrideRoot = join(workdir, 'r-override')
const overridePath = withManifest(overrideRoot, '{ this is not json')
const override = await runSeat(overrideRoot, ['--expect', ID_PUB])
check(!override.out.includes(overridePath),
  'with --expect given, a broken manifest is not consulted and not complained about')
check(/signs as/.test(override.out),
  '…and the run proceeds to the custody proof on the key the operator named')

console.log('\n5. nothing that must stay secret reaches the terminal')

const everything = [wrong.out, scraped.out, good.out, occupied.out].join('\n')
check(!everything.includes(SECRET), 'the URI secret never appears in output')
check(!everything.includes(URI), 'the URI itself never appears in output')
const clientKey = readFileSync(join(seatOf(goodRoot), 'bunker-client'), 'utf8').trim()
check(clientKey.startsWith('nsec1') && !everything.includes(clientKey),
  'the minted client key is an nsec and never appears in output')
// The control for the three above: a value that IS expected on stdout proves the haystack is real.
// Without it, an empty `everything` would pass all three and report a clean sweep of nothing.
check(everything.includes(ID_PUB), 'CONTROL — the output is non-empty and searchable (the pubkey is in it)')

server.close(); wss.close()
for (const s of subs) { try { s.socket.terminate() } catch { /* gone */ } }
rmSync(workdir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
