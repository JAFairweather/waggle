// consent_gate.mjs — the in-door consent ENFORCEMENT in the live routing path (#131/#132, §8).
//
// Drives the REAL routePublic + processConsentEvent against synthetic wire-form events, dryrun +
// temp state (no sockets, no production). The properties that matter and their failure modes:
//   - OFF (the default) changes NOTHING — a bug here would silently gate the crew's feeds on deploy;
//   - ON, a mirrored feed / un-trusted reply flows only WITH consent; grandfathered is exempt;
//   - a reply is held BEFORE staging (the invisible pre-consent hold — the community never sees it);
//   - only the grantor revokes their own consent.
//
//   node tests/consent_gate.mjs

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'

const tmp = mkdtempSync(join(tmpdir(), 'wb-consent-gate-'))
const CHAN = '55555555-5555-5555-5555-555555555555'   // one routing channel inside the hive
const HIVE = 'a'.repeat(64)                            // stable Concord community_id: the consent scope
const STAGE = '66666666-6666-6666-6666-666666666666'
const POC = 'e'.repeat(64)                            // one of our own notes; replies to it are watched

const bridgeSk = generateSecretKey()
const bridgePk = getPublicKey(bridgeSk)
const partSk = generateSecretKey(), participant = getPublicKey(partSk)   // a watch_authors feed-mirror target
const grandSk = generateSecretKey(), grandpa = getPublicKey(grandSk)     // grandfathered (pre-consent crew)
const replierSk = generateSecretKey(), replier = getPublicKey(replierSk) // a stranger replying (watch_events)

writeFileSync(join(tmp, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: [], inbox: CHAN, staging_inbox: STAGE,
    watch_authors: [participant, grandpa], watch_events: [POC], grantors: [],
    mirror_grandfathered: [grandpa],
    mirror_consent_hive_id: HIVE,
  },
}))
process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'dryrun'
process.env.CONFIG_PATH = join(tmp, 'config.json')
process.env.SEEN_PATH = join(tmp, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(tmp, 'watermark')
process.env.POSTED_MAP_PATH = join(tmp, 'posted-map.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')   // so BRIDGE_PK is known

const { routePublic, processConsentEvent, mirrorConsent, consentRecordIds, CONSENT_REFRESHERS, PUB } = await import('../src/bridge.mjs')

const wire = (ev) => JSON.parse(JSON.stringify(ev))
const now = () => Math.floor(Date.now() / 1000)
const salted = (subject) => {
  const salt = randomBytes(16).toString('hex')
  const hash = createHash('sha256').update(Buffer.concat([
    Buffer.from('waggle/da-scope/v1'), Buffer.from([0]), Buffer.from(subject), Buffer.from(salt, 'hex'),
  ])).digest('hex')
  return [hash, salt]
}
// a participant-issued mirror consent (grantee = the bridge; scope = the community)
const consent = (sk, { community = HIVE, cap = 'mirror', grantee = bridgePk, tos = 't'.repeat(64) } = {}) => wire(finalizeEvent({
  kind: 440, created_at: now(),
  tags: [['p', grantee], ['da-scope', ...salted(community)], ['da-cap', cap], ['tos', tos]], content: '',
}, sk))
const revokeBy = (sk, id) => wire(finalizeEvent({ kind: 441, created_at: now() + 1, tags: [['e', id]], content: '' }, sk))
let seq = 0
const feedPost = (sk) => wire(finalizeEvent({ kind: 1, created_at: now(), tags: [], content: 'feed ' + (seq++) }, sk))
const replyPost = (sk) => wire(finalizeEvent({ kind: 1, created_at: now(), tags: [['e', POC]], content: 'reply ' + (seq++) }, sk))

const realLog = console.log.bind(console)
let buf = ''
console.log = console.error = (...a) => { buf += a.join(' ') + '\n' }
const routeOf = (ev) => { const b = buf.length; routePublic(ev); return buf.slice(b) }
const held = (out) => /hold\[no-consent\]/.test(out)

let pass = true
const check = (cond, label) => { realLog(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
let revocationRefreshes = 0
CONSENT_REFRESHERS.add(() => { revocationRefreshes++ })

// --- OFF (default) — behaviour is UNCHANGED, nothing gated -------------------------------------
PUB.mirrorRequireConsent = false
check(!held(routeOf(feedPost(partSk))), 'OFF: a mirrored-feed author with no consent is NOT gated (inert-by-default)')

// --- ON — the gate engages --------------------------------------------------------------------
PUB.mirrorRequireConsent = true
check(held(routeOf(feedPost(partSk))), 'ON: a mirrored feed with no consent is HELD')
check(!held(routeOf(feedPost(grandSk))), 'ON: a grandfathered author flows without a consent record')

// consent arrives → the feed flows
processConsentEvent(consent(partSk))
check(mirrorConsent.has(participant), 'processConsentEvent builds the set from a participant 440')
check(!held(routeOf(feedPost(partSk))), 'ON: once consented, the mirrored feed flows')

// --- the reply lane: held INVISIBLY (before staging) until consent -----------------------------
check(held(routeOf(replyPost(replierSk))), 'ON: an un-consented reply is HELD before staging (invisible)')
processConsentEvent(consent(replierSk))
check(mirrorConsent.has(replier), 'the replier can consent too')
check(!held(routeOf(replyPost(replierSk))), 'ON: once the replier consents, the reply proceeds (to staging)')

// --- revocation: only the grantor withdraws their own consent ----------------------------------
const c = consent(partSk)
processConsentEvent(c)
check(mirrorConsent.has(participant), 'consent re-established')
check(consentRecordIds().includes(c.id), 'the active consent record is exposed for its e-tag revocation subscription')
const refreshBeforeThirdParty = revocationRefreshes
processConsentEvent(revokeBy(replierSk, c.id))   // someone ELSE's 441 e-tagging the participant's record
check(mirrorConsent.has(participant), 'a 441 by anyone BUT the grantor does NOT revoke')
check(revocationRefreshes === refreshBeforeThirdParty, 'a third-party 441 does NOT churn revocation subscriptions')
const refreshBeforeOwnRevoke = revocationRefreshes
processConsentEvent(revokeBy(partSk, c.id))       // the participant's OWN 441
check(!mirrorConsent.has(participant), 'the participant\'s own 441 revokes their consent')
check(revocationRefreshes === refreshBeforeOwnRevoke + 1, 'a valid 441 refreshes the record-id revocation subscription')
check(held(routeOf(feedPost(partSk))), 'ON: after revocation, the feed is held again')

// --- processConsentEvent ignores what is not a mirror consent (fresh keys, non-vacuous) --------
const aSk = generateSecretKey(), aPk = getPublicKey(aSk)
processConsentEvent(consent(aSk, { cap: 'admit' }))          // an admit cap, not mirror
check(!mirrorConsent.has(aPk), 'an admit-cap 440 is NOT read as consent')

const bSk = generateSecretKey(), bPk = getPublicKey(bSk)
processConsentEvent(consent(bSk, { community: 'ffffffff-0000-0000-0000-000000000000' }))
check(!mirrorConsent.has(bPk), 'a consent scoped to ANOTHER community is NOT read for this one')

const dSk = generateSecretKey(), dPk = getPublicKey(dSk)
processConsentEvent(consent(dSk, { grantee: getPublicKey(generateSecretKey()) }))   // grantee != bridge
check(!mirrorConsent.has(dPk), 'a consent naming a different grantee (not this bridge) is ignored')

// …and the positive control alongside, so the three rejections aren't just "everything is rejected":
const eSk = generateSecretKey(), ePk = getPublicKey(eSk)
processConsentEvent(consent(eSk))
check(mirrorConsent.has(ePk), 'a well-formed mirror consent for this bridge+community IS read (positive control)')

// --- §7 version-binding (crew review of #199): a superseded-terms consent fails closed ----------
// Exercises the ToS bump the reviewer flagged as untested. mirror_require_consent stays ON.
const V1 = 'a'.repeat(64), V2 = 'b'.repeat(64)
const vSk = generateSecretKey(), vPk = getPublicKey(vSk)
const wSk = generateSecretKey(), wPk = getPublicKey(wSk)
PUB.authors.push(vPk, wPk)   // make them mirrored-feed authors so their posts reach the gate
PUB.mirrorExpectedTosHash = V1
processConsentEvent(consent(vSk, { tos: V1 }))
check(mirrorConsent.get(vPk)?.tosHash === V1, 'the consent records the terms hash it was given')
check(!held(routeOf(feedPost(vSk))), 'version ON: a consent matching the current ToS flows')
PUB.mirrorExpectedTosHash = V2                                   // a material v1->v2 bump
check(held(routeOf(feedPost(vSk))), 'version ON: after a ToS bump, the stale-terms consent is HELD (fails closed)')
processConsentEvent(consent(vSk, { tos: V2 }))                   // the participant re-consents under v2
check(!held(routeOf(feedPost(vSk))), 'version ON: re-consent under the new terms flows again')

PUB.mirrorExpectedTosHash = null                                // unconfigured → presence-only (back-compat)
processConsentEvent(consent(wSk, { tos: 'deadbeef'.repeat(8) }))
check(!held(routeOf(feedPost(wSk))), 'version OFF (no hash configured): presence-only, any-terms consent flows')

realLog(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
