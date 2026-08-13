// consent.mjs — verify a participant's in-door consent (design: docs/CONSENT.md, #131/#132).
//
// LIVE. `src/bridge.mjs` imports verifyConsent and calls it on every candidate 440, and
// mirror_require_consent is ON in production — so this file decides whether a watched author's posts
// cross. This header claimed the opposite long after it stopped being true (#331); a stale comment on
// a live gate is how a reviewer talks themselves out of reading it.
// Still pure and standalone by design, mirroring nvoy console/capgrants.mjs: read events, verify,
// classify, resolve revocation — no I/O, no state.
//
// THE INVERSION IS THE WHOLE POINT. Every other grant in the estate is authored by the AUTHORITY
// (the maintainer admits a participant). A consent record is authored by the DATA SUBJECT — the
// participant grants waggle a `mirror` capability over their OWN content. So the checks below key
// on: the grantee is the bridge (`p` == bridge), the cap is `mirror`, the scope is THIS community,
// and — the load-bearing one — a revocation only counts if it is signed by the SAME participant who
// granted. Only the grantor may revoke their own consent.

import { verifyEvent } from 'nostr-tools/pure'
import { scopeHashOrNull } from './scope_hash.mjs'

export const KIND = { grant: 440, revocation: 441 }
export const CONSENT_CAP = 'mirror'

// The sixth hand-written copy, and one #328 did not list. Kept as an export because the suite
// imports it; the construction now comes from src/scope_hash.mjs so it cannot drift from the
// issuer. verifyConsent reads its salt off a candidate 440, so a salt that is not even-length hex
// returns null and matches nothing rather than throwing.
export const scopeHash = (communityId, saltHex) => scopeHashOrNull(String(communityId), saltHex)

const tagVal = (ev, k) => (ev.tags.find(t => t[0] === k) || [])[1]

/**
 * Verify one event as a mirror-consent grant for THIS bridge + community.
 *
 * @param ev                  a candidate 440
 * @param opts.bridgePubkey   waggle's hex pubkey — the grantee a consent must name
 * @param opts.communityId    the channel/community id the bridge mirrors into (its own secret)
 * @param opts.expectedTosHash  if given, the consent's `tos` must match — consent is bound to the
 *                              exact terms shown, so changed terms don't ride an old yes (§7)
 * @returns { ok:true, participant, tosHash } | { ok:false, reason }
 *
 * The participant (grantor) is the event's AUTHOR — never a `p` tag, never a claim. That is what
 * makes this consent and not something a third party can forge on the subject's behalf.
 */
export function verifyConsent(ev, { bridgePubkey, communityId, expectedTosHash } = {}) {
  if (!ev || ev.kind !== KIND.grant) return { ok: false, reason: 'not a 440' }
  if (tagVal(ev, 'da-cap') !== CONSENT_CAP) return { ok: false, reason: 'not a mirror capability' }
  // The grantee must be THIS bridge — a consent naming some other key is not consent to us.
  if ((tagVal(ev, 'p') || '').toLowerCase() !== String(bridgePubkey).toLowerCase()) {
    return { ok: false, reason: 'grantee is not this bridge' }
  }
  // Signature first: an unsigned/forged 440 is not authority, and its `pubkey` is a claim until
  // verifyEvent holds. Wire-form only (a finalize symbol would short-circuit — the tests use real sigs).
  let sigOk; try { sigOk = verifyEvent(ev) } catch { sigOk = false }
  if (!sigOk) return { ok: false, reason: 'signature does not verify' }
  // Scope must recompute to THIS community from the consent's own salt. A consent scoped to another
  // community does not authorise mirroring into ours.
  const scope = ev.tags.find(t => t[0] === 'da-scope')
  if (!scope || !scope[2]) return { ok: false, reason: 'no salted scope' }
  if (scopeHash(communityId, scope[2]) !== scope[1]) return { ok: false, reason: 'scope is another community' }
  const tosHash = tagVal(ev, 'tos') || null
  if (expectedTosHash !== undefined && tosHash !== expectedTosHash) {
    return { ok: false, reason: 'consent is bound to different terms than the current ToS' }
  }
  // The participant is the AUTHOR — the data subject who signed their own consent.
  return { ok: true, participant: ev.pubkey, tosHash }
}

/**
 * Build the live consent set from a batch of 440/441 events.
 *
 * @returns { consent: Map(participantPub -> {recordId, tosHash}), revoked, rejected }
 *   `consent` holds only ACTIVE, this-bridge, this-community consents. `revoked`/`rejected` are
 *   COUNTED, never swallowed — "nobody has consented" and "we couldn't read the consents" are
 *   different facts (the house rule: being unable to check is not being fine).
 *
 * Revocation rule, stated because it is the subtle one: a 441 revokes a consent ONLY if it is
 * signed by the SAME key that granted it. A 441 from anyone else — even the bridge, even the
 * maintainer — does not revoke a participant's consent. The subject alone withdraws their consent.
 */
export function readConsents(events, { bridgePubkey, communityId, expectedTosHash } = {}) {
  const grants = new Map()          // recordId -> { participant, tosHash, ev }
  const revsByAuthor = new Map()    // "author|targetId" -> true
  for (const ev of events || []) {
    if (ev.kind === KIND.grant) {
      const v = verifyConsent(ev, { bridgePubkey, communityId, expectedTosHash })
      if (v.ok) grants.set(ev.id, { participant: v.participant, tosHash: v.tosHash, ev })
    } else if (ev.kind === KIND.revocation) {
      let sigOk; try { sigOk = verifyEvent(ev) } catch { sigOk = false }
      if (!sigOk) continue
      for (const t of ev.tags) if (t[0] === 'e' && t[1]) revsByAuthor.set(`${ev.pubkey}|${t[1]}`, true)
    }
  }
  const consent = new Map()
  let revoked = 0
  for (const [recordId, g] of grants) {
    // Revoked iff the SAME participant published a 441 e-tagging this record.
    if (revsByAuthor.has(`${g.participant}|${recordId}`)) { revoked++; continue }
    // Newest active consent per participant wins (a re-consent under new terms supersedes).
    const prev = consent.get(g.participant)
    if (!prev || g.ev.created_at >= prev.at) consent.set(g.participant, { recordId, tosHash: g.tosHash, at: g.ev.created_at })
  }
  return { consent, revoked, checked: (events || []).length }
}
