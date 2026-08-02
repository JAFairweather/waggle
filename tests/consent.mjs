// consent.mjs — assertions over the in-door consent primitive (src/consent.mjs, #131/#132).
//
// The promise (docs/CONSENT.md): a participant's OWN signed consent is what admits their content,
// and only they can withdraw it. So the tests target the ways that promise fails silently:
//   - a consent forged on the subject's behalf being accepted (the inversion must hold);
//   - a revocation by anyone-but-the-grantor stopping a valid consent (only the subject withdraws);
//   - a consent scoped to another community, or bound to different terms, leaking through.
// Every acceptance is paired with a rejection, real signatures throughout (wire-form, so verifyEvent
// doesn't short-circuit on the finalize symbol).
//
//   node tests/consent.mjs

import { randomBytes, createHash } from 'node:crypto'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { verifyConsent, readConsents, scopeHash, CONSENT_CAP } from '../src/consent.mjs'

let n = 0, pass = 0
const t = (name, cond) => { n++; if (cond) { pass++; console.log(`ok - ${name}`) } else console.error(`FAIL - ${name}`) }

const bridgeSk = generateSecretKey(), bridgePubkey = getPublicKey(bridgeSk)
const partSk = generateSecretKey(), participant = getPublicKey(partSk)
const COMMUNITY = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
const TOS = createHash('sha256').update('the exact terms shown to the participant').digest('hex')

// Wire-form: strip the finalizeEvent validity symbol so verifyEvent actually re-checks the
// signature (the bridge only ever sees wire-form events off relays; a symbol-carrying event would
// short-circuit verification and hide a real forgery — the lesson tests/nipda_admission.mjs states).
const wire = (ev) => JSON.parse(JSON.stringify(ev))

// Build a consent 440 the way a participant would: THEY sign it, granting `mirror` to the bridge.
function consentGrant(sk, { community = COMMUNITY, cap = CONSENT_CAP, tos = TOS, grantee = bridgePubkey, created_at = 1000 } = {}) {
  const salt = randomBytes(16).toString('hex')
  return wire(finalizeEvent({
    kind: 440, created_at,
    tags: [['p', grantee], ['da-scope', scopeHash(community, salt), salt], ['da-cap', cap], ['tos', tos]],
    content: '',
  }, sk))
}
const opts = { bridgePubkey, communityId: COMMUNITY, expectedTosHash: TOS }

// --- 1. A GENUINE CONSENT IS ACCEPTED, and names the subject as its author ----------------------
{
  const g = consentGrant(partSk)
  const v = verifyConsent(g, opts)
  t('a participant-signed mirror consent verifies', v.ok === true)
  t('  the participant is the AUTHOR (the data subject), not a p tag', v.participant === participant)
  t('  the ToS hash rides with it', v.tosHash === TOS)
}

// --- 2. THE INVERSION MUST HOLD — no forging consent on someone else's behalf --------------------
{
  // An impostor signs a 440 that NAMES the participant nowhere meaningful and grants to the bridge.
  // Because the participant is the AUTHOR, an impostor can only ever consent for THEMSELVES.
  const impostorSk = generateSecretKey()
  const g = consentGrant(impostorSk)
  const v = verifyConsent(g, opts)
  t('a consent is only ever for its own signer (no third-party consent)', v.participant === getPublicKey(impostorSk))
  t('  …and it is NOT attributed to the real participant', v.participant !== participant)
}
{
  // A tampered/forged signature is refused outright.
  const g = consentGrant(partSk)
  const forged = { ...g, sig: g.sig.replace(/^../, g.sig.startsWith('00') ? 'ff' : '00') }
  t('a broken signature is refused', verifyConsent(forged, opts).ok === false)
}

// --- 3. SCOPE + CAP + GRANTEE must all match this bridge/community -------------------------------
t('a consent scoped to ANOTHER community is refused',
  verifyConsent(consentGrant(partSk, { community: 'ffffffff-0000-0000-0000-000000000000' }), opts).ok === false)
t('a non-mirror capability (e.g. admit) is refused',
  verifyConsent(consentGrant(partSk, { cap: 'admit' }), opts).ok === false)
t('a consent naming a DIFFERENT grantee (not this bridge) is refused',
  verifyConsent(consentGrant(partSk, { grantee: getPublicKey(generateSecretKey()) }), opts).ok === false)
t('a consent bound to DIFFERENT terms than the current ToS is refused',
  verifyConsent(consentGrant(partSk, { tos: createHash('sha256').update('old terms').digest('hex') }), opts).ok === false)

// --- 4. readConsents: the set, and the revocation rule (only the grantor withdraws) --------------
{
  const g = consentGrant(partSk)
  const { consent, revoked } = readConsents([g], opts)
  t('a batch yields the active consent, keyed by participant', consent.has(participant) && revoked === 0)
}
{
  // The participant revokes THEIR OWN consent — a 441 they signed, e-tagging the grant.
  const g = consentGrant(partSk)
  const rev = wire(finalizeEvent({ kind: 441, created_at: 2000, tags: [['e', g.id]], content: '' }, partSk))
  const { consent, revoked } = readConsents([g, rev], opts)
  t('the participant\'s own 441 revokes their consent', !consent.has(participant) && revoked === 1)
}
{
  // THE LOAD-BEARING CHECK: someone ELSE's 441 (the bridge, the maintainer, a stranger) must NOT
  // revoke the participant's consent. Only the subject withdraws their own.
  const g = consentGrant(partSk)
  const notTheGrantor = wire(finalizeEvent({ kind: 441, created_at: 3000, tags: [['e', g.id]], content: '' }, bridgeSk))
  const { consent, revoked } = readConsents([g, notTheGrantor], opts)
  t('a 441 by anyone BUT the grantor does NOT revoke the consent', consent.has(participant) && revoked === 0)
}
{
  // Re-consent under fresh terms supersedes: newest active wins.
  const older = consentGrant(partSk, { created_at: 1000 })
  const newer = consentGrant(partSk, { created_at: 5000 })
  const { consent } = readConsents([older, newer], opts)
  t('the newest active consent per participant wins', consent.get(participant)?.at === 5000)
}

// --- 5. an ordinary admission 440 (maintainer→participant) is NOT a consent ----------------------
{
  // The exact shape #131 warns not to confuse: a normal channel admit. Wrong cap, wrong grantee,
  // wrong author direction — it must not read as consent-to-be-mirrored.
  const admit = consentGrant(bridgeSk, { cap: 'admit', grantee: participant })
  t('a channel admission is not a mirror consent', verifyConsent(admit, opts).ok === false)
}

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
