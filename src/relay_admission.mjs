// relay_admission.mjs — the decisions in the invite sequence, extracted from the tool (#487).
//
// Admission is the leg that makes an agent a first-class member: `POST /api/invites` mints, and
// `POST /api/invites/claim` is deliberately exempt from `enforce_relay_membership` and inserts the
// `relay_members` row the NIP-42 AUTH gate reads. `tools/relay-invite.mjs` walks that sequence
// today and is the only way to walk it — which means the console cannot admit an agent, so the
// operator drops to a terminal in the middle of a flow that has no other command in it.
//
// WHY THE DECISIONS MOVED OUT OF THE TOOL. They were `process.exit` calls and `console.error`
// strings interleaved with `fetch`, so the only way to assert "a failed policy read must not be
// read as no policy" was to stand up a relay that fails in that particular way. Nothing here does
// I/O: every function takes a response that already arrived and returns what to do about it. The
// caller — CLI or page — owns the socket and the presentation.
//
// Three of these encode a refusal that has to survive the port to a browser, because a console
// makes each one EASIER to get wrong than the CLI did:
//
//   1. **Consent is not inferred.** The CLI needs `--accept-terms`, and needs `--confirm-age`
//      separately, because an age attestation is a statement by a person about themselves and no
//      tool may assert it for them. A checkbox is a much softer surface than a flag — a page that
//      pre-ticks either, or derives one from the other, has made the operator's statement on their
//      behalf. `policyGate` refuses both directions and says which one is missing.
//   2. **A failed policy read is not "no policy".** Guessing produces a 403 at claim time that the
//      operator cannot explain. Being unable to check is not the same as being fine, so the read
//      has a third verdict and it is not a success.
//   3. **"Joined" and "already a member" are different facts.** Collapsing them hides a re-run that
//      consumed nothing behind a first claim that consumed a slot — and slots are finite.
import { MAX_USES, MAX_TTL_SECS, MIN_TTL_SECS, refusal } from './relay_invite.mjs'

/// What a mint answered. `code` is a BEARER SECRET: whoever holds it can claim the invite, so it
/// is returned for the caller to hand onward and never folded into a message meant for a log.
export function mintOutcome({ status, json = null, text = '' } = {}) {
  const s = Number(status)
  if (s === 403) {
    return { ok: false, role: true, exitCode: 4, reason:
      'this key does not hold owner or admin in relay_members, and minting needs the role. ' +
      'The ask to the relay operator is one line: put this key in relay_members as admin.' }
  }
  if (s === 401) return { ok: false, exitCode: 1, reason: `the relay rejected the signature: ${refusal(s, json, text)}` }
  if (s === 429) return { ok: false, exitCode: 4, reason: `rate limited: ${refusal(s, json, text)}` }
  if (s < 200 || s >= 300) return { ok: false, exitCode: 2, reason: `${s} — ${refusal(s, json, text)}` }
  const code = json?.code || json?.invite?.code || null
  if (!code) {
    // A 2xx with no code is the worst answer to guess about: it may have consumed a mint. Say so
    // rather than reporting a success the caller cannot act on or a failure it might retry.
    return { ok: false, inconclusive: true, exitCode: 3, reason:
      `the relay answered ${s} but returned no invite code — cannot tell whether an invite was minted. ` +
      'Do not retry blindly; read the relay\'s invite list before minting again.' }
  }
  return { ok: true, code }
}

/// What a `/api/join-policy` read means. THREE verdicts, because two would force the failure case
/// into one of the successes.
export function policyReadVerdict({ status, json = null } = {}) {
  const s = Number(status)
  if (s === 404) return { state: 'none' }
  if (s >= 200 && s < 300) {
    const policy = json?.policy ?? null
    return policy ? { state: 'present', policy } : { state: 'none' }
  }
  return { state: 'inconclusive', exitCode: 3, reason:
    `could not read the join policy (${s}) — refusing to guess whether one applies. ` +
    'A wrong guess here becomes a 403 at claim time that nothing explains.' }
}

/// May the claim proceed? `accepted` and `ageConfirmed` are what the OPERATOR stated — never what
/// the policy requires, and never one derived from the other.
export function policyGate({ policy = null, accepted = false, ageConfirmed = false } = {}) {
  if (!policy) return { ok: true, body: null }
  const version = policy.version ?? policy.policy_version ?? null
  const needsAge = policy.age_attestation_required === true
  const missing = []
  if (!accepted) missing.push('the terms have not been accepted')
  if (needsAge && !ageConfirmed) missing.push('this policy requires an age attestation, which is a statement about yourself that nothing here will make for you')
  if (missing.length) return { ok: false, missing, reason: missing.join('; ') }
  if (version === null || version === undefined) {
    // Accepting an unversioned policy produces a receipt nothing can be checked against later.
    return { ok: false, reason: 'the policy carries no version — a receipt for it could not be tied to what was agreed' }
  }
  // `age_confirmed` is exactly what was stated, never `needsAge`. Where an attestation is not
  // required this sends the operator's actual answer rather than a convenient true.
  return { ok: true, body: { policy_version: version, age_confirmed: ageConfirmed === true } }
}

/// What an accept-policy call answered. A 2xx with no receipt is INCONCLUSIVE, not a success:
/// without the receipt nothing can tell whether the acceptance was recorded.
export function acceptOutcome({ status, json = null, text = '' } = {}) {
  const s = Number(status)
  if (s === 429) return { ok: false, exitCode: 4, reason: `rate limited: ${refusal(s, json, text)}` }
  if (s < 200 || s >= 300) return { ok: false, exitCode: s >= 400 && s < 500 ? 4 : 2, reason: `accept-policy ${s} — ${refusal(s, json, text)}` }
  const receipt = json?.receipt ?? null
  if (!receipt) return { ok: false, inconclusive: true, exitCode: 3, reason:
    `accept-policy returned ${s} but no receipt — cannot tell whether the acceptance was recorded.` }
  return { ok: true, receipt }
}

/// What a claim answered. The two successes are kept apart on purpose.
export function claimOutcome({ status, json = null, text = '' } = {}) {
  const s = Number(status)
  if (s === 401) return { ok: false, exitCode: 1, reason: `the relay rejected the signature: ${refusal(s, json, text)}` }
  if (s === 403 || s === 429) return { ok: false, exitCode: 4, reason: `${s} — ${refusal(s, json, text)}` }
  if (s < 200 || s >= 300) return { ok: false, exitCode: 2, reason: `${s} — ${refusal(s, json, text)}` }
  const said = String(json?.status || json?.outcome || '').toLowerCase()
  const already = /already/.test(said)
  return {
    ok: true,
    already,
    outcome: json?.status || json?.outcome || (json ? JSON.stringify(json).slice(0, 120) : '(no body)'),
    // The sentence that must follow every successful claim. Membership is what the relay now says;
    // it is NOT the same as having proved the key can authenticate, and the difference has cost
    // this project days. The proof is a kind:0 published from this key against the community relay
    // and read back cold.
    proven: false,
    note: already
      ? 'already a member — this claim consumed no slot.'
      : 'joined — this claim consumed a slot.',
  }
}

/// Re-exported so a caller has ONE import for the whole sequence — and so this module's export
/// surface is identical to the browser twin's. The suite asserts that name-for-name: a twin that
/// exported a different set would be a twin the page could call in ways nothing tested.
export { CLAIM_RATE_LIMIT, checkMintBounds } from './relay_invite.mjs'
export { refusal }
export { MAX_USES, MAX_TTL_SECS, MIN_TTL_SECS }
export { MAX_SIGN_SKEW_SECS, NIP98_WINDOW_SECS, SIGN_TIMEOUT_MS } from './relay_invite.mjs'
