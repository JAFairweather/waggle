// #355 / goal item 2 — the console mints an agent's identity, and the private half is take-once.
//
// The interesting assertions here are not "it produces a key". They are the two the design claims:
// the public half is a separate object with no field that could carry the secret, and the private
// half can be taken exactly once. Both of those are the kind of property that a later edit breaks
// silently, which is why they are asserted rather than commented.
//
//   node tests/mint_agent_key.mjs

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { mintAgentKey } from '../console/mint-agent-key.mjs'
const mintedModuleKeys = Object.keys(await import('../console/mint-agent-key.mjs'))

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

// PEEK BEFORE TAKE (#367). The key now goes to a bunker, and the page must prove the bunker has it
// before letting go — a proof that can fail, and must therefore be retryable. So reading the secret
// for enrolment must NOT spend it. Spending it on an attempt rather than an outcome was the whole
// defect in the download flow: a blocked download destroyed the only copy and reported success.
ok('peek() yields the secret', /^nsec1[0-9a-z]{20,90}$/.test(String(minted.secret.peek())))
ok('…twice, identically — reading it does not spend it', minted.secret.peek() === minted.secret.peek())
ok('…and the secret is still NOT taken after peeking', minted.secret.taken() === false)

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

// Two mints must not collide. A generator wired to a constant would pass every assertion above.
const second = mintAgentKey(primitives)
ok('NEGATIVE CONTROL — two mints produce different identities', second.display.pubkeyHex !== minted.display.pubkeyHex)

// There is deliberately no key-FILE helper any more. A file on disk is the thing that gets lost,
// and under cooperative relay revocation a lost key is a relay member nobody can ever remove
// (#367). Pinned as an absence, because a helpful re-addition would quietly restore the flow.
ok('the module exposes no key-file helper — the download path is gone, not merely unused',
  mintedModuleKeys.every(k => !/^keyFile/.test(k)))

let refused = null

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
