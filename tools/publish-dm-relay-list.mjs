#!/usr/bin/env node
// publish-dm-relay-list.mjs — repair or declare one identity's NIP-17 inbox.
//
// The recipient's signed kind:10050 is the only authority for where sealed
// mail is delivered.  This intentionally updates ONLY that event: no kind:0
// profile and no kind:10002 general relay list are changed as a side effect.
//
//   NVOY_NSEC=… EXPECT_PUBKEY=<npub|hex> \
//     node tools/publish-dm-relay-list.mjs \
//       --dm-relays wss://nos.lol,wss://relay.primal.net,wss://relay.nave.pub
//
// The key arrives through the environment, never argv. EXPECT_PUBKEY is
// mandatory so a copied shell environment cannot silently publish for the
// wrong standing identity. Success requires a fresh, signature-verified
// read-back — relay OK alone is not delivery evidence.

import WebSocket from 'ws'
import { getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { buildDmRelayListEvent } from './dm_relay_list_lib.mjs'
import { recipientDmRelays } from '../src/dm_relays.mjs'
import { DEFAULT_PUBLIC_RELAYS, relaySet } from '../src/relays.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback = '') => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] || '' }
const die = message => { console.error(`publish-dm-relay-list: ${message}`); process.exit(1) }
const expected = flag('--expect-pubkey', process.env.EXPECT_PUBKEY || '').trim()
const raw = String(process.env.NVOY_NSEC || process.env.SESSION_NSEC || '').trim()
if (!raw) die('set NVOY_NSEC (or SESSION_NSEC); a secret is never accepted as an argument')
if (!expected) die('set EXPECT_PUBKEY (or --expect-pubkey) so the target identity is explicit')

let secretKey
try { secretKey = raw.startsWith('nsec1') ? nip19.decode(raw).data : Uint8Array.from(Buffer.from(raw, 'hex')) }
catch { die('NVOY_NSEC is not a valid nsec or 64-hex key') }
if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) die('NVOY_NSEC is not a 32-byte key')

const toHex = value => {
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  try {
    const decoded = nip19.decode(value)
    if (decoded.type === 'npub') return decoded.data
  } catch { /* clear error below */ }
  die('EXPECT_PUBKEY must be an npub or 64-character public key')
}
const pubkey = getPublicKey(secretKey)
if (pubkey !== toHex(expected)) die('EXPECT_PUBKEY does not match the supplied signing identity; nothing published')

// nave.pub on top of the default set: this list is what tells a sender where to reach a Nave/Buzz
// identity, and leaving out the relay that community actually runs on makes the list wrong there.
const relays = relaySet(process.env.RELAY_RELAYS, [...DEFAULT_PUBLIC_RELAYS, 'wss://relay.nave.pub'])
const dmRelays = String(flag('--dm-relays', process.env.DM_RELAYS || relays.join(','))).split(',').map(s => s.trim())
let event
try { event = buildDmRelayListEvent(secretKey, dmRelays) } catch (e) { die(e.message) }
const intended = event.tags.map(tag => tag[1])

function publish(url) {
  return new Promise(resolve => {
    let ws, done = false
    const finish = result => { if (done) return; done = true; try { ws?.close() } catch {} resolve({ url, ...result }) }
    try { ws = new WebSocket(url) } catch { return finish({ accepted: false, note: 'connect failed' }) }
    const timer = setTimeout(() => finish({ accepted: false, note: 'timeout' }), 12_000)
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])))
    ws.on('message', data => { try {
      const m = JSON.parse(data.toString())
      if (m[0] === 'OK' && m[1] === event.id) { clearTimeout(timer); finish({ accepted: !!m[2], note: m[2] ? 'accepted' : `rejected ${m[3] || ''}` }) }
    } catch {} })
    ws.on('error', error => { clearTimeout(timer); finish({ accepted: false, note: `error ${error.message}` }) })
  })
}

function readBack(url) {
  return new Promise(resolve => {
    let ws, done = false, found = null, answered = false
    const finish = () => { if (done) return; done = true; try { ws?.close() } catch {}; resolve({ url, found, answered }) }
    try { ws = new WebSocket(url) } catch { return finish() }
    const timer = setTimeout(finish, 10_000)
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'dm-list', { ids: [event.id], authors: [pubkey], kinds: [10050], limit: 1 }])))
    ws.on('message', data => { try {
      const m = JSON.parse(data.toString())
      if (m[0] === 'EVENT' && m[2]?.id === event.id) found = m[2]
      if (m[0] === 'EOSE') { answered = true; clearTimeout(timer); finish() }
    } catch {} })
    ws.on('error', () => { clearTimeout(timer); finish() })
  })
}

console.error(`publish-dm-relay-list: ${nip19.npubEncode(pubkey)}`)
console.error(`  private-message relays: ${intended.join(', ')}`)
const writes = await Promise.all(relays.map(publish))
for (const result of writes) console.error(`  publish ${new URL(result.url).host.padEnd(20)} ${result.note}`)
await new Promise(resolve => setTimeout(resolve, 1500))
const reads = await Promise.all(relays.map(readBack))
let confirmed = 0
for (const result of reads) {
  const valid = result.found && verifyEvent(result.found)
    && result.found.pubkey === pubkey
    && JSON.stringify(recipientDmRelays([result.found], pubkey)) === JSON.stringify(intended)
  if (valid) confirmed++
  console.error(`  readback ${new URL(result.url).host.padEnd(20)} ${result.answered ? (valid ? 'VERIFIED' : 'not found or invalid') : 'no answer'}`)
}
console.error(`publish-dm-relay-list: confirmed on ${confirmed}/${relays.length} relay(s) by cold read-back`)
console.log(event.id)
process.exit(confirmed ? 0 : 1)
