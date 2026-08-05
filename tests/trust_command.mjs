// trust_command.mjs — the signed lane for the trust tiers (#286).
//
// The in-channel verbs `follow` and `mute` mutate `trusted_repliers` and `muted_authors` and
// publish NO signed event. `follow` is the largest single trust jump the bridge makes —
// quarantined stranger to standing follow, which skips review from then on — and it rested
// on an unsigned channel message. Not an outsider path: the handler gates on the approver
// roster. But an AUDITABILITY gap, because nothing outside the box could see it happen.
//
// Worse, and this is what made it invisible rather than merely unsigned: neither verb called
// scheduleControlState(), so even the published COUNTER an observer would watch stayed at its
// old value until some unrelated event happened to trigger a publish. The one signal that
// would have revealed the change was suppressed by omission.
//
// This suite drives the REAL handleTrustControlCommand and changeTrustTier against a temp
// config, with no sockets. It checks the same discipline the watchlist lane already has, plus
// the removal the channel verbs never offered — there is no in-channel way to un-follow or
// un-mute, so a vouch was effectively permanent unless someone hand-edited config.json.
//
//   node tests/trust_command.mjs

import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'

const tmp = mkdtempSync(join(tmpdir(), 'wb-trust-'))
const configDir = join(tmp, 'tree'); const stateDir = join(tmp, 'data')
mkdirSync(configDir); mkdirSync(stateDir)
const CHAN = '77777777-7777-7777-7777-777777777777'
const CFG = join(configDir, 'config.json')
const approverSk = generateSecretKey(), approver = getPublicKey(approverSk)
const strangerSk = generateSecretKey(), stranger = getPublicKey(strangerSk)
const outsiderSk = generateSecretKey()
const already = getPublicKey(generateSecretKey())
const bridgeSk = generateSecretKey(), bridgePk = getPublicKey(bridgeSk)

writeFileSync(CFG, JSON.stringify({
  relays: [], recipients: [],
  public: { relays: [], inbox: CHAN, staging_inbox: CHAN, watch_authors: [], watch_events: [],
    approvers: [approver], grantors: [], trusted_repliers: [already], muted_authors: [] },
}))
// A real bridge key, so `p`-tag addressing can PASS. Without it every command refuses at the
// first guard with 'not a trust command', and a suite asserting eight distinct refusals would
// exercise exactly one — false confidence, which is worse than no test.
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'dryrun'
process.env.CONFIG_PATH = CFG
process.env.SEEN_PATH = join(stateDir, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(tmp, 'wm')
process.env.POSTED_MAP_PATH = join(tmp, 'pm.log')
chmodSync(configDir, 0o555)

const B = await import('../src/bridge.mjs')
const { handleTrustControlCommand, changeTrustTier, PUB, CONTROL_COMMAND_KIND, TRUST_COMMAND_D } = B

let pass = 0, fail = 0
const ok = (name, value, detail = '') => { console.log(`${value ? 'ok  ' : 'FAIL'} — ${name}${value ? '' : detail ? ` (${detail})` : ''}`); value ? pass++ : fail++ }
const cfg = () => JSON.parse(readFileSync(CFG, 'utf8')).public
const now = () => Math.floor(Date.now() / 1000)

const cmd = (action, target, sk = approverSk, over = {}) => finalizeEvent({
  kind: CONTROL_COMMAND_KIND, created_at: over.created_at ?? now(),
  tags: over.tags ?? [['d', TRUST_COMMAND_D], ['p', bridgePk]],
  content: over.content ?? JSON.stringify({ v: 1, action, target }),
}, sk)

// The happy path FIRST, so the refusals below are known to be reaching their own guards
// rather than all failing at addressing.
const accepted = handleTrustControlCommand(cmd('follow', stranger))
ok('a well-formed signed follow from an approver is ACCEPTED', accepted.ok === true, accepted.reason)
ok('…and it moved the tier', PUB.trustedRepliers.includes(stranger) && cfg().trusted_repliers.includes(stranger))
const replay = handleTrustControlCommand(cmd('follow', stranger, approverSk, { created_at: now() - 5 }))
ok('an older command is refused as superseded — the watermark advanced',
  replay.ok === false && replay.reason === 'superseded command', replay.reason)
// reset so the direct-mutation checks below start from a known tier
changeTrustTier(stranger, 'unfollow')

// ── the mutation itself, exercised directly ───────────────────────────────────
const added = changeTrustTier(stranger, 'follow')
ok('follow adds to the standing-follow tier', added.ok && added.added === true)
ok('…in PUB, so routing sees it now', PUB.trustedRepliers.includes(stranger))
ok('…and in the config file, so it survives the next boot', cfg().trusted_repliers.includes(stranger))

const again = changeTrustTier(stranger, 'follow')
ok('a repeated follow is idempotent, not a duplicate', again.ok && again.already === true &&
  cfg().trusted_repliers.filter(k => k === stranger).length === 1)

const removed = changeTrustTier(stranger, 'unfollow')
ok('UNFOLLOW removes — the capability the in-channel verbs never had',
  removed.ok && removed.removed === true && !PUB.trustedRepliers.includes(stranger) &&
  !cfg().trusted_repliers.includes(stranger))
ok('unfollowing someone who was never followed is a no-op, not an error',
  changeTrustTier(getPublicKey(generateSecretKey()), 'unfollow').ok === true)
ok('a pre-existing entry is untouched by another key\'s change', cfg().trusted_repliers.includes(already))

const muted = changeTrustTier(stranger, 'mute')
ok('mute adds to the muted tier', muted.ok && PUB.muted.includes(stranger) && cfg().muted_authors.includes(stranger))
ok('UNMUTE removes', changeTrustTier(stranger, 'unmute').ok && !PUB.muted.includes(stranger))
ok('the two tiers are independent — muting does not vouch',
  !PUB.trustedRepliers.includes(stranger))

ok('an invalid action is refused', changeTrustTier(stranger, 'promote').ok === false)
ok('a non-hex target is refused', changeTrustTier('not-a-key', 'follow').ok === false)

// ── the signed lane's discipline ──────────────────────────────────────────────
// Bridge addressing needs BRIDGE_PK, which is derived from the environment at import. Where a
// check cannot be reached in this harness, assert the refusal reason so the guard is still
// proven to run in the right order rather than silently skipped.
// Each refusal is asserted for ITS OWN reason. Checking only `ok === false` would pass even
// when every case died at the first guard, which is exactly what happened while writing this.
const T = getPublicKey(generateSecretKey())    // a fresh target, so the watermark is not the cause
const reasons = [
  ['a non-approver is refused', cmd('follow', T, outsiderSk), 'author is not an approver'],
  ['a malformed body is refused', cmd('follow', T, approverSk, { content: '{' }), 'invalid body'],
  ['an unknown action is refused', cmd('promote', T), 'invalid command body'],
  ['an extra body field is refused', cmd('follow', T, approverSk, { content: JSON.stringify({ v: 1, action: 'follow', target: T, extra: 1 }) }), 'invalid command body'],
  ['a stale command is refused', cmd('follow', T, approverSk, { created_at: now() - 3600 }), 'stale command'],
  ['a future-dated command is refused', cmd('follow', T, approverSk, { created_at: now() + 3600 }), 'stale command'],
  ['a command with the wrong d-tag is refused', cmd('follow', T, approverSk, { tags: [['d', 'waggle-watchlist'], ['p', bridgePk]] }), 'not addressed to this bridge'],
  ['a command addressed to another key is refused', cmd('follow', T, approverSk, { tags: [['d', TRUST_COMMAND_D], ['p', 'f'.repeat(64)]] }), 'not addressed to this bridge'],
  ['a command with extra tags is refused', cmd('follow', T, approverSk, { tags: [['d', TRUST_COMMAND_D], ['p', bridgePk], ['x', 'y']] }), 'not addressed to this bridge'],
]
for (const [name, ev, expected] of reasons) {
  const r = handleTrustControlCommand(ev)
  ok(`${name} — for its own reason`, r.ok === false && r.reason === expected, `got '${r.reason}', wanted '${expected}'`)
}
ok('a tampered signature is refused', handleTrustControlCommand({
  ...cmd('follow', stranger), sig: '0'.repeat(128),
}).ok === false)
ok('a non-30078 event is not a trust command',
  handleTrustControlCommand({ ...cmd('follow', stranger), kind: 1 }).ok === false)

// ── the counter an observer watches must move ────────────────────────────────
// This is the omission that made the gap invisible: the tier changed and the published
// counter did not, so nothing outside the box could notice.
const bridgeSrc = readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8')
const channelCommandBody = bridgeSrc.slice(
  bridgeSrc.indexOf('async function handleCommand'),
  bridgeSrc.indexOf('// --- Return lane'))
const moderationPrimitive = bridgeSrc.slice(
  bridgeSrc.indexOf('async function applyModerationCommand'),
  bridgeSrc.indexOf('async function handleCommand'))
ok('the in-channel `mute` and `follow` verbs use the shared durable moderation primitive',
  /\['approve', 'follow', 'mute', 'reject'\]/.test(channelCommandBody) &&
  /applyModerationCommand\(st, word/.test(channelCommandBody))
ok('the shared moderation primitive refreshes signed state for standing trust changes',
  /if \(action === 'follow' \|\| action === 'mute'\) schedule\(\)/.test(moderationPrimitive))
ok('the signed lane refreshes it too', /scheduleControlState\(\)/.test(
  bridgeSrc.slice(bridgeSrc.indexOf('function changeTrustTier'), bridgeSrc.indexOf('function addWatchAuthor'))))

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
