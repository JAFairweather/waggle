// control_state.mjs — owner-control read plane (#67 / #206).
//
// The console must never read config.json. This drives the real bridge-derived payload through
// the bridge-key signer, checks its wire signature, and proves the consent lifecycle is rendered
// as owner-observable state without creating a free-form public publishing capability.
import { mkdtempSync, writeFileSync } from 'node:fs'
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

const { buildControlState, processConsentEvent, mirrorAsked, mirrorRevoked, PUB } = await import('../src/bridge.mjs')
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

const signed = wire(signControlState(buildControlState()))
t('state is a signed NIP-78 application event', signed.kind === CONTROL_STATE_KIND && verifyEvent(signed))
t('state has the fixed address and no secret/config fields',
  signed.tags.some(t => t[0] === 'd' && t[1] === 'waggle-control-state') &&
  !/config|secret|channel|private_key/i.test(signed.content))
const body = JSON.parse(signed.content)
t('state contains only the declared owner-visible fields',
  Object.keys(body).sort().join(',') === 'bridge,follows,hive,observed_at,v' &&
  Object.keys(body.follows[0]).sort().join(',') === 'consent,pubkey')

let rejected = false
try { signControlState({ ...buildControlState(), follows: [{ pubkey: watched, consent: 'free prose' }] }) } catch { rejected = true }
t('an arbitrary status cannot be signed', rejected)

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
