// control_state.mjs — owner-control read plane (#67 / #206).
//
// The console must never read config.json. This drives the real bridge-derived payload through
// the bridge-key signer, checks its wire signature, and proves the consent lifecycle is rendered
// as owner-observable state without creating a free-form public publishing capability.
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, unlinkSync, mkdirSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getEventHash, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { sealedTaskRouteCommand } from '../console/task-route-envelope.mjs'
import { consoleSigner, CONSOLE_SESSION_KEY } from '../console/signer-session.mjs'
import { confirmedFreshSigner } from '../console/confirmed-fresh-signer.mjs'
import { stableControlSigner } from '../console/stable-control-signer.mjs'
import { controlStateFresh, newestFreshControlState, requireFreshControlState,
  CONTROL_STATE_MAX_AGE_SECS, CONTROL_STATE_MAX_FORWARD_SKEW_SECS } from '../console/control-state-freshness.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'wb-control-state-'))
const CFG = join(tmp, 'config.json')
const SEND_JOURNAL = join(tmp, 'send-journal.log')
const HIVE = 'a'.repeat(64)
const CHANNEL = '77777777-7777-7777-7777-777777777777'
const bridgeSk = generateSecretKey()
const watchedSk = generateSecretKey(), watched = getPublicKey(watchedSk)
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'dryrun'
process.env.CONFIG_PATH = CFG
process.env.SEEN_PATH = join(tmp, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(tmp, 'watermark')
process.env.POSTED_MAP_PATH = join(tmp, 'posted.log')
process.env.MIRRORASKED_PATH = join(tmp, 'asked.log')
process.env.SEND_JOURNAL_PATH = SEND_JOURNAL
process.env.RELAYSEEN_PATH = join(tmp, 'relay-lane-seen.log')
const AGENT_ROWS = join(tmp, 'agent-rows.json')
process.env.AGENTROWS_PATH = AGENT_ROWS
writeFileSync(CFG, JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: [], inbox: CHANNEL, staging_inbox: CHANNEL, watch_authors: [watched], watch_events: [],
    mirror_consent_hive_id: HIVE, mirror_consent_hive_name: 'Test Hive',
    mirror_consent_hive_handle: 'test@example.com', mirror_consent_terms_url: 'https://example.com/terms',
    control_state_publish: false,
  },
}))

const { buildControlState, publishControlState, processConsentEvent, mirrorAsked, mirrorRevoked, PUB,
  grantSet, activeReturnLane, handleControlStateCommand, handleWatchlistControlCommand,
  handleModerationControlCommand, recordPosted,
  handleTaskRouteControlCommand, handleSealedTaskRouteControl, CONTROL_COMMAND_KIND,
  CONTROL_COMMAND_D, WATCHLIST_COMMAND_D, MODERATION_COMMAND_D, TASK_ROUTE_PROTOCOL } = await import('../src/bridge.mjs')
const { signControlState, CONTROL_STATE_KIND } = await import('../src/nostr_egress.mjs')
const { scopeHash } = await import('../src/consent.mjs')

let n = 0, pass = 0
const t = (name, ok) => { n++; if (ok) { pass++; console.log(`ok - ${name}`) } else console.log(`FAIL - ${name}`) }
const wire = (ev) => JSON.parse(JSON.stringify(ev))
const stateOf = () => buildControlState().follows.find(f => f.pubkey === watched)?.consent

t('a configured watched author starts pending', stateOf() === 'pending')
mirrorAsked.add(watched)
t('a recorded disclosure ask is visible as asked', stateOf() === 'asked')

const now = Math.floor(Date.now() / 1000)

const signerRaceState = { observed_at: now }
let signerRaceBridge = '4'.repeat(64), signerRaceCurrent = signerRaceState, signerRaceSigned = 0
let signerRaceRejected = false
try {
  await stableControlSigner(signerRaceBridge, signerRaceState, () => ({ bridge: signerRaceBridge, state: signerRaceCurrent }), {
    signerFactory: async () => ({
      getPublicKey: async () => { signerRaceBridge = '5'.repeat(64); signerRaceCurrent = { observed_at: now }; return '6'.repeat(64) },
      signEvent: async () => { signerRaceSigned++; return {} },
    }),
    now: () => now,
  })
} catch (error) { signerRaceRejected = /state changed/.test(error.message) }
t('a concurrent reload during signer open cannot redirect a moderation command to another bridge',
  signerRaceRejected && signerRaceSigned === 0)
const consent = wire(finalizeEvent({
  kind: 440, created_at: now, content: '',
  tags: [['p', getPublicKey(bridgeSk)], ['da-scope', scopeHash(HIVE, '11'.repeat(16)), '11'.repeat(16)], ['da-cap', 'mirror'], ['tos', PUB.mirrorExpectedTosHash]],
}, watchedSk))
processConsentEvent(consent)
t('a valid participant 440 becomes active', stateOf() === 'active')

const revocation = wire(finalizeEvent({ kind: 441, created_at: now + 1, content: '', tags: [['e', consent.id]] }, watchedSk))
processConsentEvent(revocation)
t('the participant withdrawal becomes revoked', stateOf() === 'revoked' && mirrorRevoked.has(watched))

const signed = wire(await signControlState(buildControlState()))
t('state is a signed NIP-78 application event', signed.kind === CONTROL_STATE_KIND && verifyEvent(signed))
t('state has the fixed address and no secret/config fields',
  signed.tags.some(t => t[0] === 'd' && t[1] === 'waggle-control-state') &&
  signed.tags.some(t => t[0] === 'v' && t[1] === '1') &&
  !/config|secret|private_key|inbox_uuid/i.test(signed.content))
const body = JSON.parse(signed.content)
t('state contains only the declared owner-visible fields',
  Object.keys(body).sort().join(',') === 'agents,bridge,follows,hive,observed_at,operations,publishing,v' &&
  Object.keys(body.follows[0]).sort().join(',') === 'consent,pubkey' &&
  Object.keys(body.operations).sort().join(',') === 'drops,gates,lanes,trust' &&
  Object.keys(body.operations.drops).sort().join(',') === 'relay_not_relay,relay_preauth')

// ---- agents must survive to the SIGNED artifact, not merely to buildControlState ------------------
// This is the assertion whose absence let the console screen ship dead. `buildControlState` added an
// `agents` field, but `signControlState` validates through a CLOSED schema that REBUILDS the object
// from an exact field list — so the field was stripped on every publish, and the console's
// `agents === undefined → []` tolerance rendered "no agents admitted" forever, indistinguishable
// from working. Asserting on buildControlState's return value would still pass today. Only the
// signed content proves it.
const AGENT_A = 'a1'.repeat(32), AGENT_B = 'b2'.repeat(32)
writeFileSync(AGENT_ROWS, JSON.stringify({
  [AGENT_B]: { agent: AGENT_B, status: 'revoked', label: 'retired probe', return_lane: false },
  [AGENT_A]: { agent: AGENT_A, status: 'admitted', label: 'Dennis', return_lane: true },
}))
const withAgents = wire(await signControlState(buildControlState()))
const agentBody = JSON.parse(withAgents.content)
t('agents SURVIVE the closed egress schema into the signed content',
  Array.isArray(agentBody.agents) && agentBody.agents.length === 2)
t('and each agent carries exactly the four declared public-safe fields',
  agentBody.agents.every(a => Object.keys(a).sort().join(',') === 'label,pubkey,return_lane,status'))
t('and they are sorted by pubkey, so a re-publish is not a spurious diff',
  agentBody.agents[0].pubkey < agentBody.agents[1].pubkey)
t('and the values are the real ones, not defaults',
  agentBody.agents.find(a => a.pubkey === AGENT_A)?.status === 'admitted' &&
  agentBody.agents.find(a => a.pubkey === AGENT_A)?.return_lane === true &&
  agentBody.agents.find(a => a.pubkey === AGENT_B)?.status === 'revoked')

// The schema sits beside the key, so it must refuse independently of the projection upstream.
const okRow = { pubkey: AGENT_A, status: 'admitted', label: 'Dennis', return_lane: true }
const refusesAgent = async (agents, label) => {
  let refused = false
  try { await signControlState({ ...buildControlState(), agents }) } catch { refused = true }
  t(label, refused)
}
await refusesAgent([{ ...okRow, status: 'deputised' }], 'the schema refuses a status outside the closed set')
await refusesAgent([{ ...okRow, return_lane: 'yes' }], 'the schema refuses a non-boolean return_lane')
await refusesAgent([{ ...okRow, pubkey: 'not-a-key' }], 'the schema refuses a malformed agent pubkey')
await refusesAgent([{ ...okRow, note: 'invented field' }], 'the schema refuses an agent carrying an undeclared field')
await refusesAgent([okRow, { ...okRow }], 'the schema refuses duplicate agents')
// A bech32 nsec is 63 printable ASCII characters and passes the label shape check cleanly. An owner
// mis-pasting into the label field would otherwise publish it in a signed, world-readable record.
await refusesAgent([{ ...okRow, label: 'nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' }],
  'the schema refuses a label that looks like an nsec — a credential must not reach a signed public artifact')
await refusesAgent([{ ...okRow, label: 'bunker://deadbeef' }], 'and refuses a label that looks like a Bunker URI')
// PAIR: after all of those refusals, an ordinary label still gets through — the guard refuses
// credentials, not labels. Note the space and parentheses: fixtures resembling production is the
// lesson from the slot-validator outage, where every test name was 'A', 'B' or 'Dennis'.
let ordinaryLabel = false
try {
  const ok = wire(await signControlState({ ...buildControlState(), agents: [{ ...okRow, label: 'My Dude (reviewer)' }] }))
  ordinaryLabel = JSON.parse(ok.content).agents[0].label === 'My Dude (reviewer)'
} catch { ordinaryLabel = false }
t('PAIR: an ordinary label with a space and punctuation still reaches the signed artifact', ordinaryLabel)
unlinkSync(AGENT_ROWS)

let publishedControlId = ''
const acceptedControl = await publishControlState(async (event) => { publishedControlId = event.id; return 1 }, true)
const controlJournal = readFileSync(SEND_JOURNAL, 'utf8').trim().split('\n').map(line => JSON.parse(line))
t('an accepted control-state publication is recorded for the out-of-process tripwire',
  acceptedControl === 1 && controlJournal.some(row => row.id === publishedControlId && row.kind === CONTROL_STATE_KIND && row.operation === 'control_state'))

let unacknowledgedControlId = ''
const unacknowledged = await publishControlState(async (event) => { unacknowledgedControlId = event.id; return 0 }, true)
const afterUnacknowledged = readFileSync(SEND_JOURNAL, 'utf8').trim().split('\n').map(line => JSON.parse(line))
t('an attempted control-state publication is journaled even when every relay acknowledgement is lost',
  unacknowledged === 0 && afterUnacknowledged.some(row => row.id === unacknowledgedControlId && row.operation === 'control_state'))

const beforeSignFailure = afterUnacknowledged.length
let publishAfterSignFailure = 0
const refusedControl = await publishControlState(async () => { publishAfterSignFailure++; return 1 }, true,
  async () => { throw new Error('fixture signing refusal') })
const afterSignFailure = readFileSync(SEND_JOURNAL, 'utf8').trim().split('\n').map(line => JSON.parse(line))
t('a signing refusal creates no journal row and performs no network write',
  refusedControl === 0 && publishAfterSignFailure === 0 && afterSignFailure.length === beforeSignFailure)

// Replace the expected journal file with a directory: open-for-append must fail on every platform.
// The publication boundary must fail closed rather than create an on-relay event with no durable row.
unlinkSync(SEND_JOURNAL)
mkdirSync(SEND_JOURNAL)
let publishAfterJournalFailure = 0
const unjournaled = await publishControlState(async () => { publishAfterJournalFailure++; return 1 }, true)
t('a journal open/write/fsync failure suppresses the network write', unjournaled === 0 && publishAfterJournalFailure === 0)
rmdirSync(SEND_JOURNAL)
writeFileSync(SEND_JOURNAL, afterSignFailure.map(row => JSON.stringify(row)).join('\n') + '\n')

const currentState = buildControlState()
const { v: legacyV, observed_at: legacyObservedAt, hive: legacyHive, bridge: legacyBridge, publishing: legacyPublishing, follows: legacyFollows } = currentState
const legacy = await signControlState({ v: legacyV, observed_at: legacyObservedAt, hive: legacyHive, bridge: legacyBridge, publishing: legacyPublishing, follows: legacyFollows })
t('a legacy v1 control state remains signable for existing bridges', verifyEvent(wire(legacy)) && !('operations' in JSON.parse(legacy.content)))

let rejected = false
try { await signControlState({ ...buildControlState(), follows: [{ pubkey: watched, consent: 'free prose' }] }) } catch { rejected = true }
t('an arbitrary status cannot be signed', rejected)
let invented = false
try { await signControlState({ ...buildControlState(), operations: { ...buildControlState().operations, drops: { ...buildControlState().operations.drops, narrative: 'invented log text' } } }) } catch { invented = true }
t('an arbitrary operational field cannot be signed', invented)

const command = (sk, enabled, created_at = Math.floor(Date.now() / 1000), target = getPublicKey(bridgeSk)) => wire(finalizeEvent({
  kind: CONTROL_COMMAND_KIND, created_at, content: JSON.stringify({ v: 1, enabled }),
  tags: [['d', CONTROL_COMMAND_D], ['p', target]],
}, sk))
const beforePublish = PUB.controlStatePublish
const nonApprover = command(generateSecretKey(), !beforePublish)
t('a non-approver cannot change the public-state setting', !handleControlStateCommand(nonApprover).ok && PUB.controlStatePublish === beforePublish)
const wrongRecipient = command(watchedSk, !beforePublish, Math.floor(Date.now() / 1000), 'b'.repeat(64))
t('a command for another bridge cannot change the setting', !handleControlStateCommand(wrongRecipient).ok && PUB.controlStatePublish === beforePublish)
// The test fixture has no approver by default; make the consenting participant one expressly.
PUB.approvers.push(getPublicKey(watchedSk))
const fresh = command(watchedSk, !beforePublish)
let published = 0
const applied = handleControlStateCommand(fresh, async () => { published++; return 1 })
t('a fresh approver command persists and changes the setting', applied.ok && PUB.controlStatePublish === !beforePublish)
t('the bridge emits a signed acknowledgement state', published === 1)
const replay = handleControlStateCommand(fresh, async () => { published++; return 1 })
t('the same command cannot be replayed', !replay.ok && PUB.controlStatePublish === !beforePublish)

const mirrorTarget = getPublicKey(generateSecretKey())
const watchCommand = (action, target, created_at = Math.floor(Date.now() / 1000) + 2, tags = [['d', WATCHLIST_COMMAND_D], ['p', getPublicKey(bridgeSk)]]) => wire(finalizeEvent({
  kind: CONTROL_COMMAND_KIND, created_at, content: JSON.stringify({ v: 1, action, target }),
  tags,
}, watchedSk))
const add = watchCommand('mirror', mirrorTarget)
const added = handleWatchlistControlCommand(add)
t('a signed browser mirror command persists and hot-adds a watched author', added.ok && added.added && PUB.authors.includes(mirrorTarget))
t('the mirror and its replay watermark commit together in one config write', (() => { const p = JSON.parse(readFileSync(CFG, 'utf8')).public; return p.watch_authors.includes(mirrorTarget) && p.watchlist_command_at === add.created_at })())
t('a browser command has a narrow schema and cannot be replayed', !handleWatchlistControlCommand(add).ok)
const duplicateRecipient = watchCommand('mirror', getPublicKey(generateSecretKey()), add.created_at + 1, [['d', WATCHLIST_COMMAND_D], ['p', getPublicKey(bridgeSk)], ['p', getPublicKey(bridgeSk)]])
t('a multi-recipient command cannot widen a fixed bridge target', !handleWatchlistControlCommand(duplicateRecipient).ok)
const extraTag = watchCommand('mirror', getPublicKey(generateSecretKey()), add.created_at + 1, [['d', WATCHLIST_COMMAND_D], ['p', getPublicKey(bridgeSk)], ['client', 'untrusted']])
t('a command address has no extensible tags', !handleWatchlistControlCommand(extraTag).ok)
const remove = watchCommand('unmirror', mirrorTarget, add.created_at + 1)
const removed = handleWatchlistControlCommand(remove)
t('a signed browser unmirror command persists and hot-removes a watched author', removed.ok && removed.removed && !PUB.authors.includes(mirrorTarget))

const source = (sk, created_at = now) => wire(finalizeEvent({ kind: 1, created_at, content: 'quarantined source', tags: [] }, sk))
const moderation = (action, target, created_at, sk = watchedSk,
  tags = [['d', MODERATION_COMMAND_D], ['p', getPublicKey(bridgeSk)]], body = { v: 1, action, target }) => wire(finalizeEvent({
  kind: CONTROL_COMMAND_KIND, created_at, content: JSON.stringify(body), tags,
}, sk))
const stage = (event, buzz = event.id.split('').reverse().join('')) => recordPosted({
  id: event.id, author: event.pubkey, buzz, dest: CHANNEL, q: true, ts: now,
})

const followSource = source(generateSecretKey())
stage(followSource)
const followAt = now + 4
let moderationPublished = 0, moderationScheduled = 0
const followResult = await handleModerationControlCommand(moderation('follow', followSource.id, followAt), {
  fetchOriginal: async id => id === followSource.id ? followSource : null,
  publishRelease: async event => { if (event.id === followSource.id) moderationPublished++ },
  schedule: () => { moderationScheduled++ }, rate: () => true,
})
t('a signed owner moderation command releases and vouches for one quarantined source',
  followResult.ok && followResult.action === 'follow' && PUB.trustedRepliers.includes(followSource.pubkey) && moderationPublished === 1)
t('the trust mutation and moderation replay watermark commit in the same config write', (() => {
  const p = JSON.parse(readFileSync(CFG, 'utf8')).public
  return p.trusted_repliers.includes(followSource.pubkey) && p.moderation_command_at === followAt
})())
t('follow refreshes the signed aggregate state immediately', moderationScheduled === 1)
t('the same signed moderation command cannot replay',
  !(await handleModerationControlCommand(moderation('follow', followSource.id, followAt), {
    fetchOriginal: async () => followSource, publishRelease: async () => { moderationPublished++ },
    schedule: () => { moderationScheduled++ }, rate: () => true,
  })).ok && moderationPublished === 1 && moderationScheduled === 1)

const sameSecondSource = source(generateSecretKey())
stage(sameSecondSource)
const sameSecondCommand = moderation('approve', sameSecondSource.id, followAt)
const sameSecondResult = await handleModerationControlCommand(sameSecondCommand, {
  fetchOriginal: async () => sameSecondSource,
  publishRelease: async event => { if (event.id === sameSecondSource.id) moderationPublished++ },
  rate: () => true,
})
t('distinct moderation decisions signed in the same second are both accepted',
  sameSecondResult.ok && moderationPublished === 2 && PUB.moderationCommandAt === followAt)
t('same-second command ids commit atomically with the timestamp watermark', (() => {
  const p = JSON.parse(readFileSync(CFG, 'utf8')).public
  return p.moderation_command_at === followAt && p.moderation_command_ids.length === 2 &&
    p.moderation_command_ids.includes(sameSecondCommand.id)
})())
t('a relay replay of the second same-second decision remains inert',
  !(await handleModerationControlCommand(sameSecondCommand, {
    fetchOriginal: async () => sameSecondSource,
    publishRelease: async () => { moderationPublished++ }, rate: () => true,
  })).ok && moderationPublished === 2)

const invalidSource = source(generateSecretKey())
stage(invalidSource)
const tampered = { ...invalidSource, content: 'changed after signing' }
const beforeInvalidAt = PUB.moderationCommandAt
const invalidResult = await handleModerationControlCommand(moderation('approve', invalidSource.id, followAt + 1), {
  fetchOriginal: async () => tampered, publishRelease: async () => { moderationPublished++ }, rate: () => true,
})
t('a forged or mismatched original cannot advance the moderation watermark or release',
  !invalidResult.ok && PUB.moderationCommandAt === beforeInvalidAt && moderationPublished === 2)

const cappedSource = source(generateSecretKey())
stage(cappedSource)
const beforeCapAt = PUB.moderationCommandAt
const cappedResult = await handleModerationControlCommand(moderation('approve', cappedSource.id, followAt + 1), {
  fetchOriginal: async () => cappedSource, publishRelease: async () => { moderationPublished++ }, rate: () => false,
})
t('a rate-capped release cannot advance policy or publish',
  !cappedResult.ok && PUB.moderationCommandAt === beforeCapAt && moderationPublished === 2)

const approvedSource = source(generateSecretKey())
stage(approvedSource)
let approveScheduled = 0
const approveResult = await handleModerationControlCommand(moderation('approve', approvedSource.id, followAt + 1), {
  fetchOriginal: async () => approvedSource,
  publishRelease: async event => { if (event.id === approvedSource.id) moderationPublished++ },
  schedule: () => { approveScheduled++ }, rate: () => true,
})
t('approve releases one source without creating standing trust', approveResult.ok &&
  !PUB.trustedRepliers.includes(approvedSource.pubkey) && moderationPublished === 3 && approveScheduled === 0)

const mutedSource = source(generateSecretKey())
stage(mutedSource)
let muteFetched = 0, muteScheduled = 0
const muteResult = await handleModerationControlCommand(moderation('mute', mutedSource.id, followAt + 2), {
  fetchOriginal: async () => { muteFetched++; return mutedSource },
  publishRelease: async () => { moderationPublished++ }, schedule: () => { muteScheduled++ }, rate: () => true,
})
t('mute records standing policy without fetching or releasing the quarantined content',
  muteResult.ok && PUB.muted.includes(mutedSource.pubkey) && muteFetched === 0 && moderationPublished === 3)
t('mute refreshes the signed aggregate state immediately', muteScheduled === 1)

const duplicateSource = source(generateSecretKey())
stage(duplicateSource)
const duplicateAt = followAt + 3
let openDuplicateFetch
const duplicateFetchGate = new Promise(resolve => { openDuplicateFetch = resolve })
let duplicateReleases = 0
const duplicateCommand = moderation('approve', duplicateSource.id, duplicateAt)
const duplicateOptions = {
  fetchOriginal: async () => { await duplicateFetchGate; return duplicateSource },
  publishRelease: async event => {
    duplicateReleases++
    recordPosted({ id: event.id, author: event.pubkey, buzz: '7'.repeat(64), dest: CHANNEL, q: false, ts: now })
  },
  rate: () => true,
}
const duplicateRuns = [
  handleModerationControlCommand(duplicateCommand, duplicateOptions),
  handleModerationControlCommand(duplicateCommand, duplicateOptions),
]
openDuplicateFetch()
const duplicateResults = await Promise.all(duplicateRuns)
t('concurrent relay copies execute one moderation release and one durable decision',
  duplicateResults.filter(result => result.ok).length === 1 && duplicateReleases === 1 &&
  PUB.moderationCommandAt === duplicateAt)

const interleavedSource = source(generateSecretKey())
stage(interleavedSource)
const oldAt = duplicateAt + 1, newAt = duplicateAt + 2
let openSlowFetch
const slowFetchGate = new Promise(resolve => { openSlowFetch = resolve })
let interleavedReleases = 0
const interleavedPublish = async event => {
  interleavedReleases++
  recordPosted({ id: event.id, author: event.pubkey, buzz: '8'.repeat(64), dest: CHANNEL, q: false, ts: now })
}
const slowOld = handleModerationControlCommand(moderation('approve', interleavedSource.id, oldAt), {
  fetchOriginal: async () => { await slowFetchGate; return interleavedSource },
  publishRelease: interleavedPublish, rate: () => true,
})
const fastNew = handleModerationControlCommand(moderation('approve', interleavedSource.id, newAt), {
  fetchOriginal: async () => interleavedSource,
  publishRelease: interleavedPublish, rate: () => true,
})
openSlowFetch()
const [oldResult, newResult] = await Promise.all([slowOld, fastNew])
t('a slow old and fast new command release once and leave the maximum watermark',
  oldResult.ok && newResult.ok && interleavedReleases === 1 &&
  PUB.moderationCommandAt === newAt && JSON.parse(readFileSync(CFG, 'utf8')).public.moderation_command_at === newAt)

const outsiderModeration = moderation('mute', mutedSource.id, followAt + 3, generateSecretKey())
t('a non-approver cannot issue a moderation command', !(await handleModerationControlCommand(outsiderModeration)).ok)
const widenedModeration = moderation('mute', mutedSource.id, followAt + 3, watchedSk,
  [['d', MODERATION_COMMAND_D], ['p', getPublicKey(bridgeSk)], ['client', 'untrusted']])
t('a moderation command cannot widen its exact address or schema', !(await handleModerationControlCommand(widenedModeration)).ok)
const wrongBridgeModeration = moderation('mute', mutedSource.id, followAt + 3, watchedSk,
  [['d', MODERATION_COMMAND_D], ['p', 'b'.repeat(64)]])
t('a moderation command addressed to another bridge is inert', !(await handleModerationControlCommand(wrongBridgeModeration)).ok)
const staleModeration = moderation('mute', mutedSource.id, now - 901)
t('a stale moderation command is inert', !(await handleModerationControlCommand(staleModeration)).ok)
const inventedModeration = moderation('ban', mutedSource.id, followAt + 3)
t('an invented moderation verb cannot enter the command lane', !(await handleModerationControlCommand(inventedModeration)).ok)
const publicAlready = source(generateSecretKey())
recordPosted({ id: publicAlready.id, author: publicAlready.pubkey, buzz: '9'.repeat(64), dest: CHANNEL, q: false, ts: now })
t('a source that was never quarantined is not a moderation target',
  !(await handleModerationControlCommand(moderation('mute', publicAlready.id, followAt + 3))).ok)

const participant = getPublicKey(generateSecretKey())
const taskChannel = '88888888-8888-4888-8888-888888888888'
const taskBody = (action, target = participant, channel = taskChannel) => ({ v: 1, type: 'waggle-task-route', action, channel,
  sender: getPublicKey(watchedSk), participant: target, mention: 'codex', protocol: TASK_ROUTE_PROTOCOL })
const taskCommand = (body, created_at, sk = watchedSk) => {
  const rumor = { kind: 14, pubkey: getPublicKey(sk), created_at, content: JSON.stringify(body), tags: [['p', getPublicKey(bridgeSk)]] }
  rumor.id = getEventHash(rumor)
  const seal = wire(finalizeEvent({ kind: 13, created_at, content: 'encrypted', tags: [] }, sk))
  const wrap = wire(finalizeEvent({ kind: 1059, created_at, content: 'opaque', tags: [['p', getPublicKey(bridgeSk)]] }, generateSecretKey()))
  return { wrap, open: { openSealFn: async () => seal, openRumorFn: async () => rumor } }
}
const applyTask = async (body, created_at, sk) => {
  const command = taskCommand(body, created_at, sk)
  return handleSealedTaskRouteControl(command.wrap, command.open)
}
t('a public task-route event is rejected so private route tuples cannot leak to relays', !handleTaskRouteControlCommand({}).ok)
const refusedRoute = await applyTask(taskBody('upsert'), now + 10)
t('an owner cannot route to a participant who is not already admitted', !refusedRoute.ok && /not admitted/.test(refusedRoute.reason))
grantSet.set(participant, { grantId: '1'.repeat(64), grantor: getPublicKey(watchedSk) })
const routeAt = now + 11
const ownerSigner = {
  getPublicKey: async () => getPublicKey(watchedSk),
  signEvent: async event => wire(finalizeEvent(event, watchedSk)),
  nip44Encrypt: async (recipient, plaintext) => nip44.encrypt(plaintext, nip44.getConversationKey(watchedSk, recipient)),
}
const restoredSigner = { marker: 'saved-bunker' }
const fakeStorage = { value: 'nip46:saved', getItem(key) { return key === CONSOLE_SESSION_KEY ? this.value : null }, removeItem() { this.value = null } }
const selectedSigner = await consoleSigner({ storage: fakeStorage, parse: value => ({ kind: value.slice(0, 5) }),
  restore: session => session.kind === 'nip46' ? restoredSigner : null,
  browserSigner: () => ({ marker: 'ambient-window-nostr' }) })
t('the route Console reuses the Access tab Bunker session instead of ambient window.nostr', selectedSigner === restoredSigner)
const freshnessNow = 2_000_000_000
t('the shared control-state clock pins the estate policy at fifteen minutes old and sixty seconds ahead',
  CONTROL_STATE_MAX_AGE_SECS === 900 && CONTROL_STATE_MAX_FORWARD_SKEW_SECS === 60)
t('the shared control-state clock accepts current state and its exact age/skew boundaries',
  controlStateFresh(freshnessNow, freshnessNow) &&
  controlStateFresh(freshnessNow - CONTROL_STATE_MAX_AGE_SECS, freshnessNow) &&
  controlStateFresh(freshnessNow + CONTROL_STATE_MAX_FORWARD_SKEW_SECS, freshnessNow))
t('the shared control-state clock rejects stale, far-future, fractional, zero, and missing timestamps',
  !controlStateFresh(freshnessNow - CONTROL_STATE_MAX_AGE_SECS - 1, freshnessNow) &&
  !controlStateFresh(freshnessNow + CONTROL_STATE_MAX_FORWARD_SKEW_SECS + 1, freshnessNow) &&
  !controlStateFresh(freshnessNow + 0.5, freshnessNow) && !controlStateFresh(0, freshnessNow) &&
  !controlStateFresh(undefined, freshnessNow))
const freshCandidate = { observed_at: freshnessNow - 1, marker: 'current' }
const futureCandidate = { observed_at: freshnessNow + CONTROL_STATE_MAX_FORWARD_SKEW_SECS + 1, marker: 'future' }
t('a far-future record cannot suppress the newest currently valid control state',
  newestFreshControlState([freshCandidate, futureCandidate], freshnessNow) === freshCandidate)
let signingBoundaryRefused = false
try { requireFreshControlState(freshCandidate, freshnessNow + CONTROL_STATE_MAX_AGE_SECS + 1) } catch { signingBoundaryRefused = true }
t('state that expires after loading is refused at the signing boundary', signingBoundaryRefused)
let confirmationClock = freshnessNow, signerOpenedAfterConfirmation = 0, confirmationExpiryRefused = false
try {
  await confirmedFreshSigner({ observed_at: confirmationClock }, 'confirm', {
    confirmFn: () => { confirmationClock += CONTROL_STATE_MAX_AGE_SECS + 1; return true },
    now: () => confirmationClock,
    signerFactory: async () => { signerOpenedAfterConfirmation++; return {} },
  })
} catch { confirmationExpiryRefused = true }
t('time advancing during confirmation prevents the signer from opening',
  confirmationExpiryRefused && signerOpenedAfterConfirmation === 0)
let undefinedSealRefused = false
try {
  await sealedTaskRouteCommand({ ...ownerSigner, signEvent: async () => undefined },
    getPublicKey(bridgeSk), taskBody('upsert'), routeAt)
} catch (error) { undefinedSealRefused = /did not return a Nostr event/.test(error.message) }
t('an injected signer that returns no event fails with a bounded route error', undefinedSealRefused)
let switchedIdentityRefused = false
try {
  await sealedTaskRouteCommand({ ...ownerSigner, signEvent: async event => wire(finalizeEvent(event, bridgeSk)) },
    getPublicKey(bridgeSk), taskBody('upsert'), routeAt)
} catch (error) { switchedIdentityRefused = /switched identities/.test(error.message) }
t('the Console names a signer identity switch instead of publishing it', switchedIdentityRefused)
let widenedSealRefused = false
try {
  await sealedTaskRouteCommand({ ...ownerSigner, signEvent: async event => ({ ...wire(finalizeEvent(event, watchedSk)), client: 'injected' }) },
    getPublicKey(bridgeSk), taskBody('upsert'), routeAt)
} catch (error) { widenedSealRefused = /unsupported fields/.test(error.message) }
t('the Console refuses signer-added fields outside the closed seal schema', widenedSealRefused)
let alteredSealRefused = false
try {
  await sealedTaskRouteCommand({ ...ownerSigner, signEvent: async event => wire(finalizeEvent({ ...event, content: 'substituted' }, watchedSk)) },
    getPublicKey(bridgeSk), taskBody('upsert'), routeAt)
} catch { alteredSealRefused = true }
t('the Console refuses a signer that alters the encrypted route seal', alteredSealRefused)
const realWrap = await sealedTaskRouteCommand(ownerSigner, getPublicKey(bridgeSk), taskBody('upsert'), routeAt)
const extraOuterField = await handleSealedTaskRouteControl({ ...realWrap, extra: 'not part of NIP-59' })
t('the bridge refuses an extensible outer envelope even when its Nostr signature still verifies', !extraOuterField.ok && /invalid wrap/.test(extraOuterField.reason))
const routed = await handleSealedTaskRouteControl(realWrap)
t('an owner-signed task route persists and activates without a restart', routed.ok &&
  PUB.scanChannels.includes(taskChannel) && PUB.scanAuthors.includes(getPublicKey(watchedSk)) &&
  PUB.returnLane.some(route => route.npub_hex === participant && route.protocol === TASK_ROUTE_PROTOCOL && route.managedTaskRoute))
t('the task route and replay watermark commit in one config write', (() => {
  const p = JSON.parse(readFileSync(CFG, 'utf8')).public
  return p.task_route_command_at === routeAt && p.task_routes.length === 1 && p.task_routes[0].participant === participant
})())
const secondTaskChannel = '99999999-9999-4999-8999-999999999999'
const secondRoute = await applyTask(taskBody('upsert', participant, secondTaskChannel), now + 12)
t('one admitted identity can retain distinct routes into multiple conversations', secondRoute.ok &&
  activeReturnLane().filter(route => route.managedTaskRoute && route.npub_hex === participant).length === 2)
const routeReplay = await applyTask(taskBody('upsert'), routeAt)
const widened = await applyTask({ ...taskBody('upsert'), destination: 'invented' }, now + 13)
t('a sealed task-route command has an exact schema and cannot be replayed', !routeReplay.ok && !widened.ok)
const stranger = await applyTask(taskBody('remove'), now + 14, generateSecretKey())
t('a sealed route from a non-approver cannot change owner policy', stranger.handled === false)
const routeRemoved = await applyTask(taskBody('remove'), now + 15)
t('removing one route preserves the participant’s other conversation', routeRemoved.ok &&
  PUB.returnLane.filter(route => route.managedTaskRoute && route.npub_hex === participant).length === 1 &&
  JSON.parse(readFileSync(CFG, 'utf8')).public.task_routes.length === 1)
const lastRouteRemoved = await applyTask(taskBody('remove', participant, secondTaskChannel), now + 16)
t('the same signed control plane can remove the final managed task route', lastRouteRemoved.ok &&
  !PUB.returnLane.some(route => route.managedTaskRoute && route.npub_hex === participant) &&
  JSON.parse(readFileSync(CFG, 'utf8')).public.task_routes.length === 0)

const followingPage = readFileSync(new URL('../console/following.html', import.meta.url), 'utf8')
t('the Following console signs only the narrow watchlist command, never a bridge config request', /\['d','waggle-watchlist'\]/.test(followingPage) && /JSON\.stringify\(\{v:1,action,target\}\)/.test(followingPage) && !/fetch\([^)]*config\.json/.test(followingPage))

const configPage = readFileSync(new URL('../console/config.html', import.meta.url), 'utf8')
const taskRoutesPage = readFileSync(new URL('../console/task-routes.mjs', import.meta.url), 'utf8')
const taskEnvelope = readFileSync(new URL('../console/task-route-envelope.mjs', import.meta.url), 'utf8')
const operationsPage = readFileSync(new URL('../console/config-operations.mjs', import.meta.url), 'utf8')
const routingPage = readFileSync(new URL('../console/routing.html', import.meta.url), 'utf8')
const routingScript = readFileSync(new URL('../console/routing.mjs', import.meta.url), 'utf8')
const confirmedSignerPage = readFileSync(new URL('../console/confirmed-fresh-signer.mjs', import.meta.url), 'utf8')
t('the Config console closes the entire signed state and renders only fresh verified public operations', /config-operations\.mjs/.test(configPage) && /verifyEvent/.test(operationsPage) && /exact\(state, \['v', 'observed_at', 'hive', 'bridge', 'publishing', 'follows', 'operations'\]\)/.test(operationsPage) && /exact\(state\.hive, \['id', 'name', 'handle'\]\)/.test(operationsPage) && /state\.follows\.every/.test(operationsPage) && /newestFreshControlState/.test(operationsPage) && /Verified signed state from/.test(operationsPage) && /Aggregate counts only/.test(operationsPage) && !/fetch\([^)]*config\.json/.test(operationsPage) && !/\/config\.json/.test(operationsPage))
t('every owner-control surface restores the shared signer session instead of selecting ambient NIP-07 directly',
  /consoleSigner/.test(followingPage) && /confirmedFreshSigner/.test(configPage) &&
  /consoleSigner/.test(confirmedSignerPage) && /consoleSigner/.test(taskRoutesPage) &&
  !/nip07Signer/.test(followingPage) && !/nip07Signer/.test(configPage))
t('all four control-state readers select from the same forward-skew and staleness contract',
  /newestFreshControlState/.test(followingPage) && /newestFreshControlState/.test(configPage) &&
  /newestFreshControlState/.test(taskRoutesPage) && /newestFreshControlState/.test(operationsPage))
t('every public owner-control signer rechecks freshness immediately before opening its signer',
  /requireFreshControlState\(activeState\).*consoleSigner/s.test(followingPage) &&
  /confirmedFreshSigner\(live/.test(configPage) &&
  /confirmFn\(prompt\).*requireFreshControlState\(state, now\(\)\).*signerFactory\(\)/s.test(confirmedSignerPage))
const accessPage = readFileSync(new URL('../console/index.html', import.meta.url), 'utf8')
t('the Access page describes its actual signer boundary instead of claiming to be read-only',
  /Keys stay with your signer/.test(accessPage) && !/Read-only, and deliberately/.test(accessPage))
t('the Config route form emits only an encrypted gift wrap and never publishes its private tuple', /task-routes\.mjs/.test(configPage) && /waggle-task-route/.test(taskRoutesPage) && /nvoy-task-carry-v1/.test(taskRoutesPage) && /nip44\.encrypt/.test(taskEnvelope) && /kind:1059/.test(taskEnvelope) && /nip44Encrypt/.test(taskEnvelope) && /consoleSigner/.test(taskRoutesPage) && !/kind:30078/.test(taskRoutesPage + taskEnvelope) && !/fetch\([^)]*config\.json/.test(taskRoutesPage) && !/\/config\.json/.test(taskRoutesPage))
t('the Routing console offers the three public moderation decisions and keeps reject private',
  ['approve', 'follow', 'mute'].every(action => routingPage.includes(`data-action="${action}"`)) &&
  !routingPage.includes('data-action="reject"') && /private rejection remains an in-channel action/.test(routingPage))
t('the Routing console signs only an exact bridge-addressed moderation command',
  /stableControlSigner\(bridge, state/.test(routingScript) &&
  /\['d', 'waggle-moderation'\], \['p', opened\.bridge\]/.test(routingScript) &&
  /JSON\.stringify\(\{ v: 1, action, target \}\)/.test(routingScript) &&
  !/fetch\([^)]*config\.json/.test(routingScript) && !/\/config\.json/.test(routingScript))

// ---- one word per author, and it has to be TRUE (#389, blocks #331) ----------------------------
// The record used to publish `pending` for four different realities — grandfathered, muted,
// never-asked and gated-held — and a grandfathered author is CARRIED. Driving the REAL projection
// here, not just the pure helper: the helper being right and the bridge calling it with the wrong
// arguments are independent failures, and only one of them is visible from the pure function.
const { consentState, CONSENT_STATES } = await import('../src/consent_state.mjs')
const { CONSENT_STATES: CONSOLE_STATES, CONSENT_LABEL, CONSENT_IS_CARRYING } =
  await import('../console/consent-vocabulary.mjs')

// The four legacy words must still mean what they meant. Negative control on the whole change: if
// this block were the only thing asserted, "adds three states" would be indistinguishable from
// "renames everything and breaks every published record".
t('#389 legacy: an unasked author with the gate off is still pending',
  consentState({ gated: false }) === 'pending')
t('#389 legacy: asked, active and revoked are unchanged',
  consentState({ asked: true }) === 'asked' &&
  consentState({ consented: true }) === 'active' &&
  consentState({ revoked: true }) === 'revoked')

// The defect itself, through the live bridge, on a CLEAN author — `watched` reads `revoked` by now,
// and the first draft asserted `!== 'pending'` against it, which is true of `revoked` whatever the
// gate does. It passed with the gate branch mutated flat to `pending`. Assert the word.
const gatedOnly = getPublicKey(generateSecretKey())
PUB.authors.push(gatedOnly)
const gatedRow = () => buildControlState().follows.find(f => f.pubkey === gatedOnly)?.consent
t('#389 with the gate OFF an un-consented author is pending — carried, ungated', gatedRow() === 'pending')
PUB.mirrorRequireConsent = true
t('#389 with the gate ON the same author reads held — every post dropped, and the word says so',
  gatedRow() === 'held')
t('#389 …so the meaning no longer depends on operations.gates, a field the schema treats as optional',
  consentState({ gated: true }) === 'held' && consentState({ gated: false }) === 'pending')
PUB.authors.pop()

// Grandfathering. This is the row that was lying in the worst direction: carried on a permanent
// exemption, published with the same word as an author whose every post is being held.
PUB.mirrorGrandfathered.push(watched)
const grandRow = () => buildControlState().follows.find(f => f.pubkey === watched)?.consent
t('#389 a grandfathered author reads grandfathered, not pending', grandRow() === 'grandfathered')
t('#389 grandfathering BEATS a withdrawal, because the gate carries them either way',
  mirrorRevoked.has(watched) && grandRow() === 'grandfathered')
t('#389 …and the label says it is a carry, so nobody reads consent into an exemption',
  /carried/i.test(CONSENT_LABEL.grandfathered) && CONSENT_IS_CARRYING.grandfathered === true)
PUB.mirrorGrandfathered.pop()

// Muted — the APPROVER's rejection. maybeAskConsent refuses a muted target permanently, so
// "waiting on them" would describe a wait that cannot end. A SECOND author, because `watched` has
// withdrawn by now and a withdrawal outranks a mute — the first draft of this check used `watched`
// and failed, which is the live projection proving it applies the precedence rather than the pure
// helper being asserted against itself.
const mutedOnly = getPublicKey(generateSecretKey())
PUB.authors.push(mutedOnly)
PUB.muted.push(mutedOnly)
t('#389 a muted author reads muted', buildControlState().follows.find(f => f.pubkey === mutedOnly)?.consent === 'muted')
t('#389 …and the other author is unaffected — the projection is per-author, not global',
  buildControlState().follows.find(f => f.pubkey === watched)?.consent === 'revoked')
t('#389 the muted label names the APPROVER as the refuser, not the author',
  /by you/i.test(CONSENT_LABEL.muted) && !/declined/i.test(CONSENT_LABEL.muted))
PUB.muted.pop(); PUB.authors.pop()
PUB.mirrorRequireConsent = false

// Precedence is copied from routePublic's gate, so assert the pairs that could plausibly be ordered
// the other way — each of these is a case where the obvious order publishes a false label.
t('#389 consent beats grandfathering — "they agreed" is not "we exempted them"',
  consentState({ consented: true, grandfathered: true }) === 'active')
t('#389 muted beats asked — an ask that will never be sent is not a wait',
  consentState({ muted: true, asked: true }) === 'muted')
t('#389 a withdrawal beats the approver’s mute — the subject’s own act outranks the label',
  consentState({ revoked: true, muted: true }) === 'revoked')

// Every state must survive SIGNING. The schema sits beside the key and used to restate the four
// words itself; a word the projection emits and the schema rejects fails closed after signing, on a
// record nobody looks at until the console renders blank.
let signedAll = 0
for (const consentWord of CONSENT_STATES) {
  try {
    const ev = await signControlState({ ...buildControlState(), follows: [{ pubkey: watched, consent: consentWord }] })
    if (JSON.parse(ev.content).follows[0].consent === consentWord) signedAll++
  } catch { /* counted by the shortfall */ }
}
t(`#389 all ${CONSENT_STATES.length} states survive the signing schema`, signedAll === CONSENT_STATES.length)
// NEGATIVE CONTROL: the schema is still closed. A loop that signs everything would pass the line
// above just as well as a correct one.
let refusedInvented = false
try { await signControlState({ ...buildControlState(), follows: [{ pubkey: watched, consent: 'carrying' }] }) }
catch { refusedInvented = true }
t('#389 NEGATIVE CONTROL — a plausible but undefined word is still refused', refusedInvented)

// The console keeps its own copy because nothing under src/ is served to a browser. A copy nobody
// checks is a copy that drifts — and drift here does not mis-render one row, it makes
// config-operations.mjs reject the whole signed state and show the owner nothing.
t('#389 the console vocabulary matches src/ word for word, and in the same order',
  CONSOLE_STATES.join(',') === CONSENT_STATES.join(','))
t('#389 every state has an owner-facing label and a carrying answer',
  CONSENT_STATES.every(s => typeof CONSENT_LABEL[s] === 'string' && CONSENT_LABEL[s].length > 0 &&
    typeof CONSENT_IS_CARRYING[s] === 'boolean'))
// NOT an instance check — a property one. Three separate files restated the four words, and each
// one rejects the ENTIRE signed state on a word it does not know, so a missed copy does not degrade
// a row: it blanks the page. Fixing the three I found would leave the fourth to be found in
// production, so assert that no file anywhere restates the list. Caught console/routing.mjs and
// console/following.html, both missed on the first pass of this very change.
{
  const roots = ['console', 'src', 'tools']
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) { if (entry.name !== 'vendor' && entry.name !== 'assets') walk(rel); continue }
      if (!/\.(mjs|html)$/.test(entry.name)) continue
      if (rel === 'src/consent_state.mjs' || rel === 'console/consent-vocabulary.mjs') continue   // the definitions
      const text = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
      // Any literal list holding 'active' and 'revoked' together is this vocabulary being restated.
      if (/\[[^\]\n]*'active'[^\]\n]*'revoked'[^\]\n]*\]|\[[^\]\n]*'revoked'[^\]\n]*'active'[^\]\n]*\]/.test(text)) offenders.push(rel)
    }
  }
  roots.forEach(walk)
  t('#389 no file restates the consent vocabulary — one missed copy blanks a whole page',
    offenders.length === 0)
  if (offenders.length) console.log(`     restated in: ${offenders.join(', ')}`)
}
t('#389 the two console pages that verify signed state read the shared list',
  [ '../console/routing.mjs', '../console/following.html' ].every(f =>
    /CONSENT_STATES\.includes\(f\.consent\)/.test(readFileSync(new URL(f, import.meta.url), 'utf8'))))
t('#389 the Following page names grandfathered as a CARRY, not as a pending consent',
  /carried, with no consent record/i.test(readFileSync(new URL('../console/following.html', import.meta.url), 'utf8')))
t('#389 config-operations accepts the vocabulary from the shared list, not a restated one',
  /CONSENT_STATES\.includes\(follow\.consent\)/.test(readFileSync(new URL('../console/config-operations.mjs', import.meta.url), 'utf8')) &&
  !/'pending', 'asked', 'active', 'revoked'/.test(readFileSync(new URL('../console/config-operations.mjs', import.meta.url), 'utf8')))

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
