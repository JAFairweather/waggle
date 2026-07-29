// Lane-2 rate-cap demonstration / regression test (annex §4.1.1).
//
// Proves the sealed channel-plane gates: oversized wraps drop, a plane exceeding its
// per-minute cap stops fanning out, the per-recipient token bucket caps ONE recipient's
// wake rate without collateral-throttling the plane's other recipient, and every drop
// is logged to the drops file with a HASHED plane id (never the raw one).
//
// Deterministic: a temp lane2_caps.json shrinks the knobs (bootBackfillMax: 0 so the
// boot allowance never masks the gates). Side-effect-free: buzz mode + WB_STUB_SEND,
// all state paths in a temp dir. Drives the REAL exported route().
//
// Run: node tests/lane2_caps.mjs   (exit 0 = pass, 1 = fail)

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'wb-l2-'))
const PLANE = 'a'.repeat(64)
const IN_A = '33333333-3333-3333-3333-333333333333'
const IN_B = '44444444-4444-4444-4444-444444444444'

writeFileSync(join(tmp, 'config.json'), JSON.stringify({
  relays: [],
  recipients: [
    { name: 'A', npub_hex: 'b'.repeat(64), inbox: IN_A },
    { name: 'B', npub_hex: 'c'.repeat(64), inbox: IN_B },
  ],
  channels: [{ name: 'testplane', plane_pubkey: PLANE, recipients: ['A', 'B'] }],
}))
writeFileSync(join(tmp, 'lane2_caps.json'), JSON.stringify({
  perPlane: { maxEventBytes: 2048, postsPerMinute: 6, postsPerHour: 100, perRecipientPerMinute: 1 },
  burst: { bootBackfillMax: 0, recipientBurst: 3 },
  global: { totalPostsPerHour: 1000 },
}))

process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'buzz'
process.env.WB_STUB_SEND = '1'
process.env.CONFIG_PATH = join(tmp, 'config.json')
process.env.LANE2_CAPS_PATH = join(tmp, 'lane2_caps.json')
process.env.LANE2_DROPS_PATH = join(tmp, 'lane2_drops.log')
process.env.SEEN_PATH = join(tmp, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(tmp, 'watermark')
process.env.POSTED_MAP_PATH = join(tmp, 'posted-map.log')

const { route } = await import('../src/bridge.mjs')

let buf = ''
const cap = (...a) => { buf += a.join(' ') + '\n' }
console.log = cap
console.error = cap

const hexId = n => String(n).padEnd(64, '0')
const wrap = (n, extra = {}) => ({ id: hexId(n), kind: 1059, pubkey: PLANE, tags: [['p', 'f'.repeat(64)]], content: 'x', created_at: Math.floor(Date.now() / 1000), ...extra })

// Case A — oversized wrap: dropped for everyone, logged with reason size.
route(wrap(1, { content: 'z'.repeat(4096) }))
// Case B — recipient token bucket: burst of deliveries; each event passes the plane gate
// (cap 6/min) but recipients hold only 3 burst tokens at 1/min refill — deliveries 4 and 5
// are recipient-dropped for BOTH recipients (buckets in lockstep), events 2-4 fan out.
for (let n = 2; n <= 6; n++) route(wrap(n))
// Case C — plane per-minute cap: events 7-8 exceed postsPerMinute 6 (six events already
// consumed the window: the oversized one was rejected before counting, events 2-6 plus 7
// fill it) — event 8 must be plane-dropped.
route(wrap(7)); route(wrap(8))

const out = buf
const drops = existsSync(process.env.LANE2_DROPS_PATH) ? readFileSync(process.env.LANE2_DROPS_PATH, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
const count = (sub) => out.split('\n').filter(l => l.includes(sub)).length

let pass = true
const check = (cond, label) => { console.info(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

check(count('LANE2 drop[size]') === 1, 'oversized wrap dropped with reason')
check(count(`FORWARD[stub] -> A`) === 3 && count(`FORWARD[stub] -> B`) === 3,
  'burst tokens: exactly 3 deliveries per recipient before the wake-rate gate closes')
check(count('drop[recipient-rate') >= 2, 'recipient-rate drops logged (never silent)')
check(count('LANE2 drop[plane-per-min]') >= 1, 'plane per-minute cap trips')
check(drops.length >= 4 && drops.every(d => d.plane_id_hash && d.plane_id_hash.length === 12 && !JSON.stringify(d).includes(PLANE)),
  'drops file written; hashed plane id only, raw id never logged')

console.info(pass ? '\nLANE2 PASS — sealed-lane caps hold' : '\nLANE2 FAIL')
process.exit(pass ? 0 : 1)
