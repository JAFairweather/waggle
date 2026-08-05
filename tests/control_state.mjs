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
  handleTaskRouteControlCommand, handleSealedTaskRouteControl, CONTROL_COMMAND_KIND,
  CONTROL_COMMAND_D, WATCHLIST_COMMAND_D, TASK_ROUTE_PROTOCOL } = await import('../src/bridge.mjs')
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
let undefinedSealRefused = false
try {
  await sealedTaskRouteCommand({ ...ownerSigner, signEvent: async () => undefined },
    getPublicKey(bridgeSk), taskBody('upsert'), routeAt)
} catch (error) { undefinedSealRefused = /invalid or altered route seal/.test(error.message) }
t('an injected signer that returns no event fails with a bounded route error', undefinedSealRefused)
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
t('the Config console closes the entire signed state and renders only fresh verified public operations', /config-operations\.mjs/.test(configPage) && /verifyEvent/.test(operationsPage) && /exact\(state, \['v', 'observed_at', 'hive', 'bridge', 'publishing', 'follows', 'operations'\]\)/.test(operationsPage) && /exact\(state\.hive, \['id', 'name', 'handle'\]\)/.test(operationsPage) && /state\.follows\.every/.test(operationsPage) && /newest\.observed_at <= now \+ 60/.test(operationsPage) && /now - newest\.observed_at <= 900/.test(operationsPage) && /Verified signed state from/.test(operationsPage) && /Aggregate counts only/.test(operationsPage) && !/fetch\([^)]*config\.json/.test(operationsPage) && !/\/config\.json/.test(operationsPage))
t('the Config route form emits only an encrypted gift wrap and never publishes its private tuple', /task-routes\.mjs/.test(configPage) && /waggle-task-route/.test(taskRoutesPage) && /nvoy-task-carry-v1/.test(taskRoutesPage) && /nip44\.encrypt/.test(taskEnvelope) && /kind:1059/.test(taskEnvelope) && /nip44Encrypt/.test(taskEnvelope) && /consoleSigner/.test(taskRoutesPage) && !/kind:30078/.test(taskRoutesPage + taskEnvelope) && !/fetch\([^)]*config\.json/.test(taskRoutesPage) && !/\/config\.json/.test(taskRoutesPage))

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
