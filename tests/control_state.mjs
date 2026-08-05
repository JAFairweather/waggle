// control_state.mjs — owner-control read plane (#67 / #206).
//
// The console must never read config.json. This drives the real bridge-derived payload through
// the bridge-key signer, checks its wire signature, and proves the consent lifecycle is rendered
// as owner-observable state without creating a free-form public publishing capability.
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getEventHash, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { sealedTaskRouteCommand } from '../console/task-route-envelope.mjs'
import { consoleSigner, CONSOLE_SESSION_KEY } from '../console/signer-session.mjs'
import { confirmedFreshSigner } from '../console/confirmed-fresh-signer.mjs'
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
  Object.keys(body).sort().join(',') === 'bridge,follows,hive,observed_at,operations,publishing,v' &&
  Object.keys(body.follows[0]).sort().join(',') === 'consent,pubkey' &&
  Object.keys(body.operations).sort().join(',') === 'drops,gates,lanes,trust' &&
  Object.keys(body.operations.drops).sort().join(',') === 'relay_not_relay,relay_preauth')

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

const invalidSource = source(generateSecretKey())
stage(invalidSource)
const tampered = { ...invalidSource, content: 'changed after signing' }
const beforeInvalidAt = PUB.moderationCommandAt
const invalidResult = await handleModerationControlCommand(moderation('approve', invalidSource.id, followAt + 1), {
  fetchOriginal: async () => tampered, publishRelease: async () => { moderationPublished++ }, rate: () => true,
})
t('a forged or mismatched original cannot advance the moderation watermark or release',
  !invalidResult.ok && PUB.moderationCommandAt === beforeInvalidAt && moderationPublished === 1)

const cappedSource = source(generateSecretKey())
stage(cappedSource)
const beforeCapAt = PUB.moderationCommandAt
const cappedResult = await handleModerationControlCommand(moderation('approve', cappedSource.id, followAt + 1), {
  fetchOriginal: async () => cappedSource, publishRelease: async () => { moderationPublished++ }, rate: () => false,
})
t('a rate-capped release cannot advance policy or publish',
  !cappedResult.ok && PUB.moderationCommandAt === beforeCapAt && moderationPublished === 1)

const approvedSource = source(generateSecretKey())
stage(approvedSource)
let approveScheduled = 0
const approveResult = await handleModerationControlCommand(moderation('approve', approvedSource.id, followAt + 1), {
  fetchOriginal: async () => approvedSource,
  publishRelease: async event => { if (event.id === approvedSource.id) moderationPublished++ },
  schedule: () => { approveScheduled++ }, rate: () => true,
})
t('approve releases one source without creating standing trust', approveResult.ok &&
  !PUB.trustedRepliers.includes(approvedSource.pubkey) && moderationPublished === 2 && approveScheduled === 0)

const mutedSource = source(generateSecretKey())
stage(mutedSource)
let muteFetched = 0, muteScheduled = 0
const muteResult = await handleModerationControlCommand(moderation('mute', mutedSource.id, followAt + 2), {
  fetchOriginal: async () => { muteFetched++; return mutedSource },
  publishRelease: async () => { moderationPublished++ }, schedule: () => { muteScheduled++ }, rate: () => true,
})
t('mute records standing policy without fetching or releasing the quarantined content',
  muteResult.ok && PUB.muted.includes(mutedSource.pubkey) && muteFetched === 0 && moderationPublished === 2)
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
  /consoleSigner/.test(routingScript) && /requireFreshControlState\(activeState\).*consoleSigner/s.test(routingScript) &&
  /\['d', 'waggle-moderation'\], \['p', activeBridge\]/.test(routingScript) &&
  /JSON\.stringify\(\{ v: 1, action, target \}\)/.test(routingScript) &&
  !/fetch\([^)]*config\.json/.test(routingScript) && !/\/config\.json/.test(routingScript))

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
