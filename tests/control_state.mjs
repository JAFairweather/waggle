// control_state.mjs — owner-control read plane (#67 / #206).
//
// The console must never read config.json. This drives the real bridge-derived payload through
// the bridge-key signer, checks its wire signature, and proves the consent lifecycle is rendered
// as owner-observable state without creating a free-form public publishing capability.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'

const tmp = mkdtempSync(join(tmpdir(), 'wb-control-state-'))
const CFG = join(tmp, 'config.json')
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
writeFileSync(CFG, JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: [], inbox: CHANNEL, staging_inbox: CHANNEL, watch_authors: [watched], watch_events: [],
    mirror_consent_hive_id: HIVE, mirror_consent_hive_name: 'Test Hive',
    mirror_consent_hive_handle: 'test@example.com', mirror_consent_terms_url: 'https://example.com/terms',
    control_state_publish: false,
  },
}))

const { buildControlState, processConsentEvent, mirrorAsked, mirrorRevoked, PUB, handleControlStateCommand, handleWatchlistControlCommand, CONTROL_COMMAND_KIND, CONTROL_COMMAND_D, WATCHLIST_COMMAND_D } = await import('../src/bridge.mjs')
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

const followingPage = readFileSync(new URL('../console/following.html', import.meta.url), 'utf8')
t('the Following console signs only the narrow watchlist command, never a bridge config request', /\['d','waggle-watchlist'\]/.test(followingPage) && /JSON\.stringify\(\{v:1,action,target\}\)/.test(followingPage) && !/fetch\([^)]*config\.json/.test(followingPage))

const configPage = readFileSync(new URL('../console/config.html', import.meta.url), 'utf8')
const operationsPage = readFileSync(new URL('../console/config-operations.mjs', import.meta.url), 'utf8')
t('the Config console closes the entire signed state and renders only fresh verified public operations', /config-operations\.mjs/.test(configPage) && /verifyEvent/.test(operationsPage) && /exact\(state, \['v', 'observed_at', 'hive', 'bridge', 'publishing', 'follows', 'operations'\]\)/.test(operationsPage) && /exact\(state\.hive, \['id', 'name', 'handle'\]\)/.test(operationsPage) && /state\.follows\.every/.test(operationsPage) && /newest\.observed_at <= now \+ 60/.test(operationsPage) && /now - newest\.observed_at <= 900/.test(operationsPage) && /Verified signed state from/.test(operationsPage) && /Aggregate counts only/.test(operationsPage) && !/fetch\([^)]*config\.json/.test(operationsPage) && !/\/config\.json/.test(operationsPage))

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
