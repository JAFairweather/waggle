// #658 — waggle no longer carries. Every agent hears the channel through its own broker, so by
// default the bridge counts posts and publishes the control state, and carries nothing: no return
// lane, no seating on a grant, no unseating on a revoke, and no lane reported as running.
//
// Each "nothing happened" is paired with a control proving the same harness does see it happen when
// carrying is asked for, so an empty journal here means the lane is off, not that the probe is blind.
//
//   node tests/carrying_off.mjs

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'

const dir = mkdtempSync(resolve(tmpdir(), 'wb-carrying-off-'))
const bridgeSk = generateSecretKey()
const grantorSk = generateSecretKey()
const crewSk = generateSecretKey()
const crew = getPublicKey(crewSk)
const claude = getPublicKey(generateSecretKey())
const agentPk = getPublicKey(generateSecretKey())
const CHAN = '3f2b9c14-7d0e-4a58-9b61-c8ee4a70d215'

writeFileSync(resolve(dir, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: [], inbox: CHAN, staging_inbox: CHAN, watch_authors: [], watch_events: [],
    approvers: [], grantors: [getPublicKey(grantorSk)], seat_grantees: true, control_state_publish: true,
    mirror_consent_hive_id: 'a'.repeat(64), mirror_consent_hive_name: 'test hive', mirror_consent_hive_handle: 'test',
    scan_authors: [crew], scan_channels: ['scanchan', 'otherchan'],
    return_lane: [{ npub_hex: claude, mention: 'claude', authors: [] }],
  },
}))
process.env.CONFIG_PATH = resolve(dir, 'config.json')
process.env.SEND_JOURNAL_PATH = resolve(dir, 'send-journal.log')
process.env.SEEN_PATH = resolve(dir, 'seen.log')
process.env.POSTED_MAP_PATH = resolve(dir, 'posted.log')
process.env.RLSEEN_PATH = resolve(dir, 'return-lane-seen.log')
process.env.SCAN_WATERMARK_PATH = resolve(dir, 'scan-watermark.json')
process.env.UNSEATPENDING_PATH = resolve(dir, 'roster-unseat-pending.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.FORWARD_MODE = 'buzz'
process.env.WB_STUB_SEND = '1'
process.env.WB_NO_BOOT = '1'
delete process.env.WAGGLE_CARRYING

const { scanChannel, postingCounts, processGrantEvent, grantSet, seatGrantee, seated, buildControlState } = await import('../src/bridge.mjs')

let fails = 0
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }
const carries = () => existsSync(process.env.SEND_JOURNAL_PATH)
  ? readFileSync(process.env.SEND_JOURNAL_PATH, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(r => r.lane === 'return') : []
const wire = ev => JSON.parse(JSON.stringify(ev))
const now = Math.floor(Date.now() / 1000)
const mention = (text, at) => wire(finalizeEvent({ kind: 9, content: text, created_at: at, tags: [] }, crewSk))
const fetchOf = rows => (ch, floor, before, cb) => cb(null, before ? [] : rows)

// --- the scan counts the post and carries nothing ------------------------------------------------
const quiet = mention('@claude are you there', now - 5)
await scanChannel('scanchan', fetchOf([quiet]), false)
ok('a mention in a scanned channel is not carried', carries().length === 0)
ok('…but the post is still counted for the hive page',
  postingCounts.summary([crew]).agents.some(r => r.pubkey === crew && r.posts >= 1))

// Control: the same harness, asked to carry, does record a carry.
await scanChannel('otherchan', fetchOf([mention('@claude second thing', now - 3)]), true)
ok('CONTROL — with carrying asked for, the same harness records the carry', carries().length === 1)

// --- a grant admits without seating, and a revoke drops without unseating ------------------------
let calls = []
const capture = async d => { calls.push(d); return { stdout: '' } }
const rosterQuery = async () => '[]'
const settle = () => new Promise(r => setImmediate(r))
const salt = randomBytes(16).toString('hex')
const scope = createHash('sha256').update(Buffer.concat([
  Buffer.from('waggle/da-scope/v1'), Buffer.from([0]), Buffer.from(CHAN), Buffer.from(salt, 'hex'),
])).digest('hex')

await seatGrantee(getPublicKey(generateSecretKey()), capture, rosterQuery)
ok('CONTROL — the capture records a seat when one is made directly', calls.length === 1)
calls = []

const grant = wire(finalizeEvent({ kind: 440, created_at: now, tags: [['p', agentPk], ['da-scope', scope, salt], ['da-cap', 'admit']], content: '' }, grantorSk))
processGrantEvent(grant, { emitFn: capture, queryFn: rosterQuery })
await settle()
ok('an admit grant is still recorded', grantSet.has(agentPk))
ok('…and seats nobody', calls.length === 0 && !seated.has(agentPk))

processGrantEvent(wire(finalizeEvent({ kind: 441, created_at: now, tags: [['e', grant.id]], content: '' }, grantorSk)), { emitFn: capture, queryFn: rosterQuery })
await settle()
ok('withdrawing it is recorded', !grantSet.has(agentPk))
ok('…and removes nobody from the channel', calls.length === 0)

// --- the control state says what is running -----------------------------------------------------
const lanes = buildControlState().operations.lanes
ok('no lane is reported as running', Object.values(lanes).every(v => v === false))

// --- the boot wiring: the loops that would carry are behind the switch ----------------------------
const src = readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8')
ok('the channel poll asks scanChannel not to carry', src.includes('await scanChannel(ch, scanFetchPage, CARRYING)'))
ok('…and skips the carry retries', /if \(!CARRYING\) return\n\s+await retryPendingCarries\(\)/.test(src))
ok('the sealed lanes are not connected', src.includes('if (CARRYING) RELAYS.forEach(connect)'))
ok('the staging carry does not run', src.includes('if (CARRYING) scanReturnLane(msgs)'))
ok('a process with nothing to run idles instead of exiting into a restart loop', /if \(!CARRYING && !PUB\) \{[^\n]*setInterval\(/.test(src))

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
