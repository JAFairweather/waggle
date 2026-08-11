// #355 / goal item 2 — the console mints an agent's identity, and the private half is take-once.
//
// The interesting assertions here are not "it produces a key". They are the two the design claims:
// the public half is a separate object with no field that could carry the secret, and the private
// half can be taken exactly once. Both of those are the kind of property that a later edit breaks
// silently, which is why they are asserted rather than commented.
//
//   node tests/mint_agent_key.mjs

import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { mintAgentKey, keyFileContents, keyFileName } from '../console/mint-agent-key.mjs'

let fails = 0
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }

const primitives = { generateSecretKey, getPublicKey, nsecEncode: nip19.nsecEncode, npubEncode: nip19.npubEncode }
const minted = mintAgentKey(primitives)

ok('the public half is a 64-character hex pubkey', /^[0-9a-f]{64}$/.test(minted.display.pubkeyHex))
ok('…and an npub', /^npub1[0-9a-z]{20,90}$/.test(minted.display.npub))
ok('the npub and the hex are the SAME key — a mismatch would grant to a key nobody holds',
  nip19.decode(minted.display.npub).data === minted.display.pubkeyHex)

// The property that matters most: nothing renderable can carry the secret. A string search over
// every value on `display` is the check a future field would have to survive.
ok('the display half has exactly the two public fields',
  JSON.stringify(Object.keys(minted.display).sort()) === JSON.stringify(['npub', 'pubkeyHex']))
ok('the display half is frozen, so a caller cannot staple the secret onto it',
  Object.isFrozen(minted.display))

const nsec = minted.secret.take()
ok('the private half is an nsec', /^nsec1[0-9a-z]{20,90}$/.test(String(nsec)))
ok('…and it derives the public half that was handed over',
  getPublicKey(nip19.decode(nsec).data) === minted.display.pubkeyHex)
ok('taking it a second time yields null, not a copy', minted.secret.take() === null)
ok('…and the object says so', minted.secret.taken() === true)

// forget() on an untaken secret — the path a cancelled panel uses.
const abandoned = mintAgentKey(primitives)
ok('an untaken secret does not report itself taken', abandoned.secret.taken() === false)
abandoned.secret.forget()
ok('forget() makes the secret unrecoverable', abandoned.secret.take() === null && abandoned.secret.taken() === true)

// sign() — USE the key without yielding it. This is what the relay-join step needs: a signature,
// not the nsec. Routing that through take() would hand the key to code that only wanted a
// signature AND destroy it before the operator could save it.
const forSigning = mintAgentKey(primitives)
const signed = forSigning.secret.sign({ kind: 27235, created_at: 1, tags: [], content: '' },
  { decode: nip19.decode, finalize: finalizeEvent })
ok('sign() returns an event signed by the minted key', signed.pubkey === forSigning.display.pubkeyHex)
ok('…that verifies', verifyEvent(signed))
ok('…and signing did NOT consume the secret — the operator can still save it', forSigning.secret.taken() === false)
ok('…so take() still yields it afterwards', /^nsec1/.test(String(forSigning.secret.take())))
ok('…and sign() returns null once the key is gone, rather than throwing',
  forSigning.secret.sign({ kind: 1, created_at: 1, tags: [], content: '' },
    { decode: nip19.decode, finalize: finalizeEvent }) === null)

// Two mints must not collide. A generator wired to a constant would pass every assertion above.
const second = mintAgentKey(primitives)
ok('NEGATIVE CONTROL — two mints produce different identities', second.display.pubkeyHex !== minted.display.pubkeyHex)

// The file is one nsec and a newline. Anything else is a file someone pastes somewhere whole.
ok('the key file is exactly the nsec and a newline', keyFileContents(nsec) === `${nsec}\n`)
ok('the file name does not carry the identity', !keyFileName().includes('npub') && keyFileName() === 'agent.nsec')

let refused = null
try { keyFileContents(minted.display.npub) } catch (e) { refused = e.message }
ok('building a key file from an npub is refused — and says it is not an nsec', /not an nsec/.test(String(refused)))
refused = null
try { keyFileContents('') } catch (e) { refused = e.message }
ok('building a key file from nothing is refused', /not an nsec/.test(String(refused)))

// Both directions on the mint guards: a primitive that returns the wrong shape must be refused,
// and the same call with sound primitives must still succeed — otherwise "refuses the bad thing"
// is indistinguishable from "refuses everything".
refused = null
try { mintAgentKey({ ...primitives, getPublicKey: () => 'not-a-pubkey' }) } catch (e) { refused = e.message }
ok('a getPublicKey that returns junk is refused, naming the pubkey', /hex pubkey/.test(String(refused)))
refused = null
try { mintAgentKey({ ...primitives, nsecEncode: () => 'npub1definitelynotansec' }) } catch (e) { refused = e.message }
ok('an nsecEncode that returns an npub is refused, naming the nsec', /not an nsec/.test(String(refused)))
ok('…and sound primitives still mint', /^[0-9a-f]{64}$/.test(mintAgentKey(primitives).display.pubkeyHex))

console.log(fails ? `\nMINT AGENT KEY FAIL — ${fails}` : '\nMINT AGENT KEY PASS — public half renderable, private half take-once')
process.exit(fails ? 1 : 0)
