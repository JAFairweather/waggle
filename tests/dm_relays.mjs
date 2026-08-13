// Recipient DM relay lists are signed NIP-17 delivery preferences.
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { recipientDmRelays, normalizeDmRelayList } from '../src/dm_relays.mjs'

let n = 0, pass = 0
const t = (name, yes) => { n++; if (yes) { pass++; console.log(`ok - ${name}`) } else console.error(`FAIL - ${name}`) }
const sk = generateSecretKey(), pk = getPublicKey(sk)
const signed = (created_at, tags) => JSON.parse(JSON.stringify(finalizeEvent({ kind: 10050, created_at, tags, content: '' }, sk)))
// Strip `verifiedSymbol` before handing an event to an assertion. finalizeEvent stamps it, and so
// does verifyEvent on success — so an event that has merely been READ ONCE by a passing test above
// is stamped from then on, and object spread copies the symbol along with the fields. Every
// tampered fixture below must go through this or it is waved through and proves nothing (#320).
const wire = ev => JSON.parse(JSON.stringify(ev))

const old = signed(10, [['relay', 'wss://old.example']])
const current = signed(20, [['relay', 'wss://purplepag.es'], ['relay', 'wss://relay.nave.pub'], ['relay', 'wss://purplepag.es'], ['relay', 'http://not-private.example'], ['relay', 'wss://localhost']])
t('newest valid signed kind:10050 wins', JSON.stringify(recipientDmRelays([old, current], pk)) === JSON.stringify(['wss://purplepag.es', 'wss://relay.nave.pub']))
// Named for what it proves. This fixture is rejected on the author filter — `pubkey !== target`
// is checked before verifyEvent, so it never reaches the signature at all.
t('a list claiming another author is ignored', recipientDmRelays([{ ...current, pubkey: 'f'.repeat(64) }], pk).length === 0)

// ── The signature branch (#312) ────────────────────────────────────────────────────────────────
// Nothing above exercises it. Replacing `verifyEvent(e)` with `return true` — deleting the check
// outright — left this suite 6/6 green, so a delivery preference could have been forged by anyone
// who could put an event in front of the bridge and the suite would not have said so.
//
// Both fixtures below use the RIGHT pubkey, so they pass the author filter and the signature is
// the only thing left that can refuse them. Both go through `wire()` — `current` was stamped by
// the assertion on line 17 that read it successfully, and a spread would have carried that stamp
// onto the tampered copy. Written as a spread first, this suite reported both fixtures as
// VERIFYING, which is how the stamp announced itself.
//
// The forgery that matters: a real signature over a DIFFERENT body. An attacker does not need to
// forge a signature, only to edit a signed event in flight and hope nobody rehashes it.
const tampered = wire({ ...current, tags: [['relay', 'wss://attacker.example']] })
// Confirm the fixture is broken before believing anything the assertion says about it. If the
// verifiedSymbol were still attached this returns true, and it fails here rather than passing
// silently two lines down.
t('the tampered fixture really does fail verification — the probe kept its own input', verifyEvent(tampered) === false)
t('a list whose body was edited after signing is ignored', recipientDmRelays([tampered], pk).length === 0)
t('  …and the attacker relay is nowhere in the result', !recipientDmRelays([tampered, current], pk).includes('wss://attacker.example'))

const badSig = wire({ ...current, sig: '0'.repeat(128) })
t('the corrupted-signature fixture really does fail verification', verifyEvent(badSig) === false)
t('a list with a corrupted signature is ignored', recipientDmRelays([badSig], pk).length === 0)

// The other direction, and the load-bearing half: a guard that refuses everything satisfies all
// five assertions above while serving nobody. This is the same key and the same event, untouched.
t('NEGATIVE CONTROL — the correctly signed list from that same key is still served',
  JSON.stringify(recipientDmRelays([current], pk)) === JSON.stringify(['wss://purplepag.es', 'wss://relay.nave.pub']))
t('  …and a broken list does not suppress a good one alongside it',
  JSON.stringify(recipientDmRelays([badSig, tampered, current], pk)) === JSON.stringify(['wss://purplepag.es', 'wss://relay.nave.pub']))
// A tampered event sorts newest-first alongside a valid older one. If verification ran after the
// sort rather than inside the filter, the forgery would win the slot and return [] — silently
// turning a reachable recipient into an unreachable one.
t('  …including when the broken one is newer and would otherwise win the slot',
  JSON.stringify(recipientDmRelays([wire({ ...tampered, created_at: 99 }), current], pk)) === JSON.stringify(['wss://purplepag.es', 'wss://relay.nave.pub']))
t('a malformed event is ignored without throwing', recipientDmRelays([{ kind: 10050, pubkey: pk, tags: 'not tags' }], pk).length === 0)
t('a list for another recipient is ignored', recipientDmRelays([current], 'e'.repeat(64)).length === 0)
t('invalid, duplicate, and local URLs are rejected', JSON.stringify(normalizeDmRelayList(['wss://one.example', 'wss://one.example/', 'ws://plain.example', 'wss://127.0.0.1', 'wss://two.example'])) === JSON.stringify(['wss://one.example', 'wss://two.example']))
t('the bounded list keeps a recipient-declared relay.nave.pub', recipientDmRelays([current], pk).includes('wss://relay.nave.pub'))

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
