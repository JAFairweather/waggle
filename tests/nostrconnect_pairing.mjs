// nostrconnect_pairing.mjs — the client-first pairing an agent uses to seat itself (#528).
//
// The claim under test is not "a URI is rendered". It is that a pairing reaches `credentials/` ONLY
// when it was bound to the operator's approval and proven to hold the expected key, and that every
// other path leaves the directory exactly as it found it. Both directions on each, because a check
// that only ever refuses cannot be told from one that refuses everything.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import * as nip44 from 'nostr-tools/nip44'
import { NIP46_KIND, REQUIRED_PERMS, awaitApproval, bunkerUriFrom, clientNsec, mintSecret, nostrconnectUri, readApproval }
  from '../src/nostrconnect.mjs'
import { makeBunkerSigner } from '../src/nostr_signer.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
let pass = 0, fail = 0
const check = (ok, what) => { if (ok) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

const CLIENT_KEY = generateSecretKey()
const CLIENT_PUB = getPublicKey(CLIENT_KEY)
const SIGNER_KEY = generateSecretKey()
const SIGNER_PUB = getPublicKey(SIGNER_KEY)
const RELAYS = ['wss://relay.example.test', 'wss://other.example.test']
const SECRET = mintSecret()

console.log('\n1. the request')

const uri = nostrconnectUri({ clientPubkey: CLIENT_PUB, relays: RELAYS, secret: SECRET, name: 'waggle:oliver' })
check(uri.startsWith(`nostrconnect://${CLIENT_PUB}?`),
  'the request is addressed FROM the client key — this is the direction where the agent generates its own')
const q = new URL(uri).searchParams
check(q.getAll('relay').join(',') === RELAYS.join(','), 'it carries every relay, because that is the only way back')
check(q.get('secret') === SECRET, 'and the binding secret')
for (const p of REQUIRED_PERMS) check(q.get('perms').split(',').includes(p), `it asks for ${p}`)
check(q.get('perms').split(',').includes('nip44_decrypt'),
  '…and nip44_decrypt in particular — a sign-only pairing signs happily and then reports an empty inbox')

// Refusals, each for a reason that would otherwise fail silently later.
const refuses = fn => { try { fn(); return null } catch (e) { return e.message } }
check(/at least one wss/.test(refuses(() => nostrconnectUri({ clientPubkey: CLIENT_PUB, relays: [], secret: SECRET })) || ''),
  'NO RELAY is refused at render time — a request nothing can answer times out and reads as "not approved"')
check(/secret must be at least/.test(refuses(() => nostrconnectUri({ clientPubkey: CLIENT_PUB, relays: RELAYS, secret: 'short' })) || ''),
  'a short secret is refused — it is the whole binding')
check(/64-character hex/.test(refuses(() => nostrconnectUri({ clientPubkey: 'nope', relays: RELAYS, secret: SECRET })) || ''),
  'a malformed client pubkey is refused')
check(refuses(() => nostrconnectUri({ clientPubkey: CLIENT_PUB, relays: [...RELAYS, 'http://plain.test'], secret: SECRET })) === null &&
  new URL(nostrconnectUri({ clientPubkey: CLIENT_PUB, relays: [...RELAYS, 'http://plain.test'], secret: SECRET }))
    .searchParams.getAll('relay').length === 2,
  'BOTH DIRECTIONS — a non-wss entry is DROPPED while the good ones still get through, so a typo is not an outage')

console.log('\n2. reading a response')

// Fixtures are built by signing and then round-tripping through JSON. `verifyEvent` memoises its
// verdict on a symbol, and object spread copies symbols — so a forgery built as `{...honest, id}`
// verifies TRUE against the honest event's cached result, and a negative control built the
// convenient way tests nothing.
const wire = e => JSON.parse(JSON.stringify(e))
const respond = (result, { from = SIGNER_KEY, to = CLIENT_PUB, error } = {}) => {
  const payload = JSON.stringify(error ? { id: 'x', result, error } : { id: 'x', result })
  return wire(finalizeEvent({ kind: NIP46_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['p', to]],
    content: nip44.v2.encrypt(payload, nip44.v2.utils.getConversationKey(from, to)) }, from))
}
const read = ev => readApproval(ev, { clientKey: CLIENT_KEY, clientPubkey: CLIENT_PUB, secret: SECRET })

const honest = read(respond(SECRET))
check(honest && honest.bound === true && honest.signerPubkey === SIGNER_PUB && !honest.refused,
  'a response that ECHOES the secret is bound, and reveals which key answered')

const acked = read(respond('ack'))
check(acked && acked.bound === false && !acked.refused,
  'an `ack` is surfaced but NOT bound — a real signer that skips the echo and an impostor are indistinguishable here')

const declined = read(respond('', { error: 'user rejected' }))
check(declined && declined.refused === true && /user rejected/.test(declined.error),
  'a refusal is a RESULT, not silence — "the operator declined" and "nothing arrived" are different outcomes')

check(read(respond('some-other-secret')) === null, 'a response echoing the WRONG secret is not for this request')
check(read(respond(SECRET, { to: getPublicKey(generateSecretKey()) })) === null,
  'a response addressed to a different client is not for this request')
check(read({ ...respond(SECRET), kind: 1 }) === null, 'a non-24133 event is not a response')

// The forgery: same shape, same p tag, real secret in the payload — but the signature is not the
// author's. Built through the wire so nothing is memoised.
const forged = wire(respond(SECRET))
forged.content = respond(SECRET, { from: generateSecretKey() }).content
check(read(forged) === null, 'an event whose signature does not verify is dropped')
const tampered = wire(respond(SECRET))
tampered.sig = tampered.sig.replace(/^../, tampered.sig.startsWith('00') ? 'ff' : '00')
check(read(tampered) === null, 'and so is one with a mangled signature')

// POSITIVE CONTROL on the whole block. Every assertion above this line could pass for a function
// that returns null unconditionally.
check(honest !== null && acked !== null && declined !== null,
  'POSITIVE CONTROL — three of the fixtures above DID return a result, so `null` is a verdict and not the only answer')

// The property that is easy to state backwards: knowing the secret is what binds, so a response
// from ANY key that echoes it is bound. That is correct — the secret is only ever shown to the
// operator — and it is why the custody proof is a separate step that a secret cannot satisfy.
const otherKey = generateSecretKey()
const fromElsewhere = read(respond(SECRET, { from: otherKey }))
check(fromElsewhere && fromElsewhere.bound === true && fromElsewhere.signerPubkey === getPublicKey(otherKey),
  'binding is about the APPROVAL, not the identity — a different key echoing the secret binds, and custody is proven separately')

console.log('\n3. waiting on the relays')

const fakePool = events => class {
  subscribeMany(relays, filter, { onevent }) {
    this.filter = filter
    setTimeout(() => { for (const e of events) onevent(e) }, 0)
    return { close() {} }
  }
  close() {}
}
const noise = [{ ...respond('ack', { to: getPublicKey(generateSecretKey()) }) }, { kind: 1, pubkey: SIGNER_PUB }]

const got = await awaitApproval({ relays: RELAYS, clientKey: CLIENT_KEY, secret: SECRET,
  Pool: fakePool([...noise, respond(SECRET)]), timeoutMs: 5000 })
check(got && got.bound === true, 'the wait resolves on the approval, after ignoring traffic that is not for it')

const timedOut = await awaitApproval({ relays: RELAYS, clientKey: CLIENT_KEY, secret: SECRET,
  Pool: fakePool(noise), timeoutMs: 60 })
check(timedOut === null,
  'BOTH DIRECTIONS — with no approval it resolves NULL rather than rejecting: not approved yet is not a failure')

let sawFilter
await awaitApproval({ relays: RELAYS, clientKey: CLIENT_KEY, secret: SECRET, timeoutMs: 40,
  Pool: class { subscribeMany(r, f) { sawFilter = f; return { close() {} } } close() {} } })
check(sawFilter && sawFilter.kinds[0] === NIP46_KIND && sawFilter['#p'][0] === CLIENT_PUB,
  'and it subscribes for responses addressed to THIS client key, not for everything on the relay')

console.log('\n4. what gets written is what the loader reads')

// The integration property, and the one most likely to be wrong: a pairing this tool stores has to
// be one `makeBunkerSigner` accepts. Two files that nothing can load is a seating that reports
// success and fails at first use.
const stored = bunkerUriFrom({ signerPubkey: SIGNER_PUB, relays: RELAYS, secret: SECRET })
check(stored.startsWith(`bunker://${SIGNER_PUB}?`), 'the stored form is bunker://<the key that answered>')
let loaded = null, loadErr = ''
try { loaded = makeBunkerSigner(stored, clientNsec(CLIENT_KEY)) } catch (e) { loadErr = e.message }
check(loaded !== null, `the existing signer loader accepts it${loadErr ? ` — ${loadErr}` : ''}`)
check(loaded && loaded.pubkey === SIGNER_PUB && loaded.remote === true,
  '…and resolves to the same key, over the remote transport')
try { loaded && loaded.close() } catch { /* nothing opened */ }
check(nip19.decode(clientNsec(CLIENT_KEY)).type === 'nsec',
  'the client credential is stored as an nsec1, which is the form the loader decodes')
// NEGATIVE CONTROL on the loader itself: it has to be capable of refusing, or "it accepted ours"
// says nothing.
let refusedBad = false
try { makeBunkerSigner('bunker://not-hex?relay=wss://x.test', clientNsec(CLIENT_KEY)) } catch { refusedBad = true }
check(refusedBad, 'NEGATIVE CONTROL — the loader still refuses a malformed pairing, so acceptance is a verdict')

console.log('\n5. prove, then write — the failure paths leave nothing behind')

const TOOL = join(ROOT, 'tools', 'pair-agent.mjs')
const probeRoot = mkdtempSync(join(tmpdir(), 'wb-pair-'))
const run = args => {
  try {
    return { rc: 0, out: execFileSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) { return { rc: e.status, out: `${e.stdout || ''}${e.stderr || ''}` } }
}

const printOnly = run(['--name', 'oliver', '--root', probeRoot, '--print-only', '--relay', 'wss://relay.example.test'])
check(printOnly.rc === 3, `--print-only exits 3, INCONCLUSIVE — it did not pair, and it did not fail (rc=${printOnly.rc})`)
check(/nostrconnect:\/\//.test(printOnly.out), '…and it printed a request, so this is measuring a run that did something')
check(!existsSync(join(probeRoot, 'oliver', 'credentials')),
  'NOTHING was written — a half-seated credentials directory reads as progress to every checker in this repo')

const badName = run(['--name', 'Pi Dog', '--root', probeRoot, '--print-only'])
check(badName.rc === 1 && /usage:/.test(badName.out) && /short stable id/.test(badName.out),
  'a display name is refused with the rule, not with a command that would fail on it (#523)')
check(!existsSync(join(probeRoot, 'Pi Dog')) && !existsSync(join(probeRoot, 'pi dog')),
  '…and it created no directory for a name it refused')

const badExpect = run(['--name', 'oliver', '--root', probeRoot, '--expect', 'nothex', '--print-only'])
check(badExpect.rc === 1 && /--expect takes a 64-character hex/.test(badExpect.out), 'a malformed --expect is refused')
const badRelay = run(['--name', 'oliver', '--root', probeRoot, '--relay', 'http://plain.test', '--print-only'])
check(badRelay.rc === 1 && /wss:\/\/ URLs/.test(badRelay.out),
  'an explicit non-wss --relay is REFUSED here rather than dropped — the operator named it, so silence would be a surprise')

// Clobber. An existing pairing is a live credential; overwriting it orphans whatever it authorised.
const occupied = join(probeRoot, 'seated', 'credentials')
mkdirSync(occupied, { recursive: true })
writeFileSync(join(occupied, 'bunker-uri'), 'bunker://existing\n', { mode: 0o600 })
const clobber = run(['--name', 'seated', '--root', probeRoot, '--print-only'])
check(clobber.rc === 1 && /already exists/.test(clobber.out),
  'an existing pairing is not overwritten — it is a live credential, and replacing it silently orphans what it authorised')

// BOTH DIRECTIONS on the clobber guard: it must still let an unseated name through, or it is just
// a tool that refuses everything.
const fresh = run(['--name', 'unseated', '--root', probeRoot, '--print-only'])
check(fresh.rc === 3 && /nostrconnect:\/\//.test(fresh.out),
  'BOTH DIRECTIONS — a name with no pairing on disk still gets a request rendered')

// The order itself, asserted against the source: every write must come after the custody proof.
// This is the property the comment block claims, and a reordering would pass every test above.
const src = execFileSync('/bin/cat', [TOOL], { encoding: 'utf8' })
const proofAt = src.indexOf('await signer.signEvent(')
const writeAt = src.indexOf('writeFileSync(uriPath')
check(proofAt > 0 && writeAt > 0, 'ANCHOR — both the custody proof and the credential write were found in the source')
check(proofAt < writeAt, 'the custody proof runs BEFORE anything is written, so a refused pairing leaves no files')

rmSync(probeRoot, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
assert.equal(fail, 0, `${fail} assertion(s) failed`)
