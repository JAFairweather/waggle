// A recipient relay-list publish is a narrow, signed NIP-17 replacement event.
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { buildDmRelayListEvent } from '../tools/dm_relay_list_lib.mjs'
import { recipientDmRelays } from '../src/dm_relays.mjs'

let total = 0, passed = 0
const test = (name, condition) => { total++; if (condition) { passed++; console.log(`ok - ${name}`) } else console.error(`FAIL - ${name}`) }
const secretKey = generateSecretKey(), pubkey = getPublicKey(secretKey)
const event = JSON.parse(JSON.stringify(buildDmRelayListEvent(secretKey, [
  'wss://nos.lol/', 'wss://relay.primal.net', 'wss://relay.nave.pub', 'wss://nos.lol', 'http://bad.example', 'wss://localhost',
], 1_786_000_000)))

test('builds a signed kind:10050 event', event.kind === 10050 && verifyEvent(event) && event.pubkey === pubkey && event.content === '')
test('uses only canonical recipient relay tags', JSON.stringify(event.tags) === JSON.stringify([
  ['relay', 'wss://nos.lol'], ['relay', 'wss://relay.primal.net'], ['relay', 'wss://relay.nave.pub'],
]))
test('the bridge resolves exactly the published delivery set', JSON.stringify(recipientDmRelays([event], pubkey)) === JSON.stringify([
  'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nave.pub',
]))
test('refuses a list with no safe websocket relay', (() => { try { buildDmRelayListEvent(secretKey, ['http://bad.example', 'wss://localhost']); return false } catch { return true } })())

console.log(`\n${passed}/${total} passed`)
process.exit(passed === total ? 0 : 1)
