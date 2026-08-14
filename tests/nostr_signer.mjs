// Remote-signer boundary: URI/client credentials are descriptor-checked and the bridge identity
// is derived from the Bunker pointer without ever loading its nsec on this host.
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import * as nip44 from 'nostr-tools/nip44'
import { loadNostrSigner, makeBunkerSigner, makeLocalSigner } from '../src/nostr_signer.mjs'
import { buildTripwireAlarmWrap } from '../tools/tripwire_alarm_lib.mjs'

let pass = 0, fail = 0
const ok = (name, value) => { console.log(value ? 'ok  ' : 'FAIL', '—', name); value ? pass++ : fail++ }
const attempt = env => { try { return { value: loadNostrSigner(env, { Pool: class {} }) } } catch (error) { return { error: String(error.message) } } }
const dir = mkdtempSync(join(tmpdir(), 'waggle-signer-'))
const uriPath = join(dir, 'bunker-uri'), clientPath = join(dir, 'client-nsec')
const bunkerPub = 'a'.repeat(64), client = generateSecretKey()
const uri = `bunker://${bunkerPub}?relay=wss%3A%2F%2Frelay.example&secret=not-printed`

try {
  writeFileSync(uriPath, `${uri}\n`, { mode: 0o600 })
  writeFileSync(clientPath, `${nip19.nsecEncode(client)}\n`, { mode: 0o600 })
  const remote = attempt({ WAGGLE_BUNKER_URI_FILE: uriPath, WAGGLE_NIP46_CLIENT_NSEC_FILE: clientPath }).value
  ok('mode-0600 Bunker files create a remote signer for the URI identity', remote?.remote === true && remote.pubkey === bunkerPub)
  ok('one credential file without the other is refused', /set both/.test(attempt({ WAGGLE_BUNKER_URI_FILE: uriPath }).error || ''))
  chmodSync(uriPath, 0o644)
  ok('group/world-readable Bunker URI is refused', /0600/.test(attempt({ WAGGLE_BUNKER_URI_FILE: uriPath, WAGGLE_NIP46_CLIENT_NSEC_FILE: clientPath }).error || ''))
  chmodSync(uriPath, 0o600)
  const link = join(dir, 'uri-link'); symlinkSync(uriPath, link)
  ok('a symlinked Bunker URI is refused', /non-symlink/.test(attempt({ WAGGLE_BUNKER_URI_FILE: link, WAGGLE_NIP46_CLIENT_NSEC_FILE: clientPath }).error || ''))

  const localKey = generateSecretKey(), peerKey = generateSecretKey(), peer = getPublicKey(peerKey)
  const local = loadNostrSigner({ BUZZ_PRIVATE_KEY: Buffer.from(localKey).toString('hex') })
  const event = await local.signEvent({ kind: 13, created_at: 1, tags: [], content: 'sealed' })
  ok('legacy local mode still signs as the configured bridge identity', verifyEvent(JSON.parse(JSON.stringify(event))) && event.pubkey === getPublicKey(localKey))
  const ciphertext = await local.nip44Encrypt(peer, 'round trip')
  ok('legacy local mode retains NIP-44 encryption compatibility', nip44.decrypt(ciphertext, nip44.getConversationKey(peerKey, local.pubkey)) === 'round trip')

  // Drive the actual NIP-46 request/response wire with an in-memory bunker. This proves remote
  // mode does not merely parse a URI: sign/encrypt/decrypt all cross the client-key RPC boundary.
  const bunkerKey = generateSecretKey(), liveBunkerPub = getPublicKey(bunkerKey)
  const clientPub = getPublicKey(client), rpcConversation = nip44.getConversationKey(bunkerKey, clientPub)
  class FakePool {
    subscribeMany(_relays, _filter, handlers) { this.onevent = handlers.onevent }
    publish(_relays, request) {
      const message = JSON.parse(nip44.decrypt(request.content, rpcConversation))
      let result
      if (message.method === 'connect') result = 'ack'
      else if (message.method === 'get_public_key') result = liveBunkerPub
      else if (message.method === 'sign_event') result = JSON.stringify(finalizeEvent(JSON.parse(message.params[0]), bunkerKey))
      else if (message.method === 'nip44_encrypt') result = nip44.encrypt(message.params[1], nip44.getConversationKey(bunkerKey, message.params[0]))
      else if (message.method === 'nip44_decrypt') result = nip44.decrypt(message.params[1], nip44.getConversationKey(bunkerKey, message.params[0]))
      const response = finalizeEvent({ kind: 24133, created_at: 1, tags: [['p', clientPub]],
        content: nip44.encrypt(JSON.stringify({ id: message.id, result }), rpcConversation) }, bunkerKey)
      void Promise.resolve().then(() => this.onevent(response))
      return []
    }
    close() {}
  }
  const rpcSigner = makeBunkerSigner(`bunker://${liveBunkerPub}?relay=wss%3A%2F%2Frelay.example&secret=x`, nip19.nsecEncode(client), { Pool: FakePool })
  const remoteEvent = await rpcSigner.signEvent({ kind: 13, created_at: 2, tags: [], content: 'remote' })
  ok('Bunker mode signs through NIP-46 as the remote identity', verifyEvent(remoteEvent) && remoteEvent.pubkey === liveBunkerPub)
  const remoteCiphertext = await rpcSigner.nip44Encrypt(peer, 'remote round trip')
  ok('Bunker mode encrypts through NIP-46 without the identity nsec', nip44.decrypt(remoteCiphertext, nip44.getConversationKey(peerKey, liveBunkerPub)) === 'remote round trip')
  ok('userPubkey() resolves an identity at all', await rpcSigner.userPubkey() === liveBunkerPub)
  rpcSigner.close()

  // THE DISTINGUISHING CASE (#478 review). Above, the remote signer and the identity it holds are
  // the same key, so nothing there can tell `.pubkey` — the hex out of `bunker://` — from the
  // identity that actually signs. NIP-46 permits them to differ, and `get_public_key` is the only
  // thing that resolves the second. Reading the URI hex as the identity dead-ends both ways: pin to
  // it and every signature is a custody mismatch; name the true key and it is refused for
  // disagreeing with the pairing. So they are made DIFFERENT here, which is the only arrangement
  // that can fail.
  {
    const signerKey = generateSecretKey(), signerPub = getPublicKey(signerKey)   // what bunker:// names
    const userKey = generateSecretKey(), userPub = getPublicKey(userKey)         // what it signs as
    let getPublicKeyCalls = 0, reply = m => m
    const conv = nip44.getConversationKey(signerKey, getPublicKey(client))
    class SplitPool {
      subscribeMany(_r, _f, h) { this.onevent = h.onevent }
      publish(_r, request) {
        const m = JSON.parse(nip44.decrypt(request.content, conv))
        let result
        if (m.method === 'connect') result = 'ack'
        else if (m.method === 'get_public_key') { getPublicKeyCalls++; result = userPub }
        else if (m.method === 'sign_event') result = JSON.stringify(finalizeEvent(JSON.parse(m.params[0]), userKey))
        const response = finalizeEvent({ kind: 24133, created_at: 1, tags: [['p', getPublicKey(client)]],
          content: nip44.encrypt(JSON.stringify(reply({ id: m.id, result })), conv) }, signerKey)
        void Promise.resolve().then(() => this.onevent(response))
        return []
      }
      close() {}
    }
    const split = makeBunkerSigner(`bunker://${signerPub}?relay=wss%3A%2F%2Frelay.example&secret=x`,
      nip19.nsecEncode(client), { Pool: SplitPool })

    ok('.pubkey is the URI hex — the transport address, not the identity', split.pubkey === signerPub)
    const resolvedId = await split.userPubkey()
    ok('userPubkey() returns the identity the bunker signs as, not the URI hex',
      resolvedId === userPub && resolvedId !== split.pubkey)
    ok('…and it got there by asking get_public_key', getPublicKeyCalls === 1)
    const splitEvent = await split.signEvent({ kind: 27235, created_at: 3, tags: [], content: '' })
    ok('…which is the key the signatures actually carry', splitEvent.pubkey === resolvedId)
    await split.userPubkey()
    ok('the answer is cached — one prompt per run, not one per signature', getPublicKeyCalls === 1)

    // NEGATIVE CONTROL — a bunker that will not say who it is must be refused, not defaulted back
    // to the URI hex. Silently falling back is how the dead-end above returns.
    reply = m => ({ id: m.id, result: 'not-a-pubkey' })
    const mute = makeBunkerSigner(`bunker://${signerPub}?relay=wss%3A%2F%2Frelay.example&secret=x`,
      nip19.nsecEncode(client), { Pool: SplitPool })
    let refusedId = ''
    try { await mute.userPubkey() } catch (e) { refusedId = e.message }
    ok('NEGATIVE CONTROL — a malformed get_public_key is refused, not silently defaulted',
      /malformed pubkey/.test(refusedId) && !/^$/.test(refusedId))
    ok('…and says why it matters, rather than only that it failed', /cannot establish which identity/.test(refusedId))
    split.close(); mute.close()
  }

  const alarmKey = generateSecretKey(), recipientKey = generateSecretKey(), recipient = getPublicKey(recipientKey)
  const alarmSigner = makeLocalSigner(Buffer.from(alarmKey).toString('hex'), 'TEST_ALARM_NSEC')
  const wrap = await buildTripwireAlarmWrap('drill', recipient, alarmSigner, { now: () => 100, backdated: () => 90 })
  // Verify the WIRE form. `buildTripwireAlarmWrap` returns the finalizeEvent result directly, and
  // nostr-tools stamps `verifiedSymbol` on what it finalizes — `verifyEvent` short-circuits on that
  // marker, so verifying the object itself asserts nothing about the signature. Confirmed: without
  // the roundtrip, `{...wrap, sig: '0'.repeat(128)}` also passes. Same pattern as line 35.
  ok('tripwire builds a valid gift wrap addressed only to the operator', verifyEvent(JSON.parse(JSON.stringify(wrap))) && wrap.kind === 1059 &&
    JSON.stringify(wrap.tags) === JSON.stringify([['p', recipient]]))
  const alarmSeal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(recipientKey, wrap.pubkey)))
  ok('tripwire seal is signed by the dedicated alarm identity', verifyEvent(alarmSeal) && alarmSeal.pubkey === alarmSigner.pubkey && alarmSeal.kind === 13)
  const alarmRumor = JSON.parse(nip44.decrypt(alarmSeal.content, nip44.getConversationKey(recipientKey, alarmSigner.pubkey)))
  ok('tripwire rumor binds recipient, alarm identity, and content', alarmRumor.kind === 14 && alarmRumor.pubkey === alarmSigner.pubkey &&
    alarmRumor.content === 'drill' && JSON.stringify(alarmRumor.tags) === JSON.stringify([['p', recipient]]))
  const mutating = { ...alarmSigner, async signEvent(event) { return finalizeEvent({ ...event, tags: [['p', 'f'.repeat(64)]] }, alarmKey) } }
  let mutation = ''
  try { await buildTripwireAlarmWrap('drill', recipient, mutating, { now: () => 100, backdated: () => 90 }) } catch (error) { mutation = error.message }
  ok('tripwire refuses a signer that changes policy-owned seal bytes', /changed the sealed alarm event/.test(mutation))
  const widening = { ...alarmSigner, async signEvent(event) { return { ...finalizeEvent(event, alarmKey), delegated_by: 'attacker-controlled' } } }
  let widened = ''
  try { await buildTripwireAlarmWrap('drill', recipient, widening, { now: () => 100, backdated: () => 90 }) } catch (error) { widened = error.message }
  ok('tripwire refuses signer-supplied fields outside the closed event schema', /changed the sealed alarm event/.test(widened))
} finally { rmSync(dir, { recursive: true, force: true }) }

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
