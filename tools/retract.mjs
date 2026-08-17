// Publish a NIP-09 deletion request for a note this key authored, then verify.
// Deletion on nostr is a REQUEST: relays may honour it, clients may cache, mirrors may keep
// serving. Verify afterwards rather than assuming, and report honestly either way.
import { SimplePool } from 'nostr-tools/pool'
import '../src/ws_runtime.mjs'
import { finalizeEvent } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { DEFAULT_PUBLIC_RELAYS, relaySet } from '../src/relays.mjs'

const TARGET = process.argv[2]
if (!/^[0-9a-f]{64}$/.test(TARGET || '')) { console.error('usage: retract.mjs <64-hex event id>'); process.exit(1) }

let nsec = null
for (const line of readFileSync(homedir() + '/.nvoy/claude-identity.env', 'utf8').split('\n')) {
  const t = line.trim()
  if (t.startsWith('NVOY_NSEC=')) nsec = t.slice('NVOY_NSEC='.length).replace(/^["']|["']$/g, '')
}
if (!nsec) { console.error('no NVOY_NSEC'); process.exit(1) }
const sk = nsec.startsWith('nsec') ? nip19.decode(nsec).data : Uint8Array.from(nsec.match(/../g).map(b => parseInt(b, 16)))

// Deliberately WIDER than the default set. Deletion is a request, not a guarantee (see the header),
// so the question this tool answers is "who is still serving it" — and a relay left out of the
// sweep is a relay that answers "no" by not being asked.
const RELAYS = relaySet([...DEFAULT_PUBLIC_RELAYS, 'wss://asia.vectorapp.io', 'wss://relay.dreamith.to'].join(','))
const pool = new SimplePool()

const del = finalizeEvent({
  kind: 5,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['e', TARGET], ['k', '1']],
  content: 'Posted in error — internal coordination, not intended for the public network.',
}, sk)

console.log('deletion event:', del.id)
const results = await Promise.allSettled(pool.publish(RELAYS, del))
results.forEach((r, i) => console.log(' ', RELAYS[i].padEnd(28), r.status === 'fulfilled' ? 'OK' : 'ERR ' + String(r.reason).slice(0, 60)))

// Give relays a moment, then check whether the original is still served.
await new Promise(r => setTimeout(r, 4000))
const still = await pool.querySync(RELAYS, { ids: [TARGET] })
console.log('\nORIGINAL STILL SERVED BY ANY RELAY:', still.length > 0 ? 'YES' : 'no')
pool.close(RELAYS)
process.exit(0)
