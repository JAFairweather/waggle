// Recipient DM relay lists are signed NIP-17 delivery preferences.
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { recipientDmRelays, normalizeDmRelayList } from '../src/dm_relays.mjs'

let n = 0, pass = 0
const t = (name, yes) => { n++; if (yes) { pass++; console.log(`ok - ${name}`) } else console.error(`FAIL - ${name}`) }
const sk = generateSecretKey(), pk = getPublicKey(sk)
const signed = (created_at, tags) => JSON.parse(JSON.stringify(finalizeEvent({ kind: 10050, created_at, tags, content: '' }, sk)))

const old = signed(10, [['relay', 'wss://old.example']])
const current = signed(20, [['relay', 'wss://purplepag.es'], ['relay', 'wss://relay.nave.pub'], ['relay', 'wss://purplepag.es'], ['relay', 'http://not-private.example'], ['relay', 'wss://localhost']])
t('newest valid signed kind:10050 wins', JSON.stringify(recipientDmRelays([old, current], pk)) === JSON.stringify(['wss://purplepag.es', 'wss://relay.nave.pub']))
t('a forged list is ignored', recipientDmRelays([{ ...current, pubkey: 'f'.repeat(64) }], pk).length === 0)
t('a malformed event is ignored without throwing', recipientDmRelays([{ kind: 10050, pubkey: pk, tags: 'not tags' }], pk).length === 0)
t('a list for another recipient is ignored', recipientDmRelays([current], 'e'.repeat(64)).length === 0)
t('invalid, duplicate, and local URLs are rejected', JSON.stringify(normalizeDmRelayList(['wss://one.example', 'wss://one.example/', 'ws://plain.example', 'wss://127.0.0.1', 'wss://two.example'])) === JSON.stringify(['wss://one.example', 'wss://two.example']))
t('the bounded list keeps a recipient-declared relay.nave.pub', recipientDmRelays([current], pk).includes('wss://relay.nave.pub'))

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
