// relay-admission.mjs — the browser copy of `src/relay_admission.mjs` (#487).
//
// Same bind as `console/nip98.mjs` and `console/scope-hash.mjs`: the page cannot import ../src/
// (serve-console pins DOCROOT to console/), and shipped code cannot import console/ (it is not in
// the deploy ship list). So the decisions are copied and `tests/console_admission.mjs` holds the
// two byte-equal across every status the relay can answer.
//
// WHY THESE DECISIONS MATTER MORE HERE THAN IN THE CLI. Each of the three refusals below is a
// flag in the tool and a CHECKBOX in this page, and a checkbox is the softer surface:
//
//   * a pre-ticked box, or one box deriving another, makes the operator's statement for them —
//     and an age attestation is a statement by a person about themselves that nothing may assert
//     on their behalf. `policyGate` refuses both directions and names which is missing.
//   * a failed policy read rendered as "no policy" produces a 403 at claim time the operator
//     cannot explain. It has a third verdict, and that verdict is not a success.
//   * "joined" and "already a member" are different facts; collapsing them hides a re-run that
//     consumed nothing behind a first claim that consumed a finite slot.
//
// `refusal` and the bounds are lifted from `src/relay_invite.mjs` rather than imported, because
// that module is node-side and carries more than a page needs. They are held equal by the suite.

export const MIN_TTL_SECS = 60
export const MAX_TTL_SECS = 30 * 24 * 60 * 60
export const MAX_USES = 10_000
export const CLAIM_RATE_LIMIT = 10

// Lifted from src/relay_invite.mjs with the rest. The skew guard matters MORE in a browser than in
// the CLI: a NIP-46 approval waits on a human tapping a phone, and NIP-98 is checked against the
// RELAY's clock — so a signature the operator approved slowly is refused as 401, which reads as
// "your key is wrong".
export const NIP98_WINDOW_SECS = 60
export const SIGN_TIMEOUT_MS = 45_000
export const MAX_SIGN_SKEW_SECS = 45

const REFUSALS = {
  // Names the ACT, not a flag. This string is rendered by the console too, and a page whose whole
  // purpose is to remove the terminal must not answer a refusal with a command-line switch. The
  // tool prints its own `--accept-terms` line next to this one, so the CLI loses nothing.
  join_policy_required: 'this deployment has a join policy and the claim carried no receipt.\n' +
    '  Accept the terms first — and attest age where the policy requires it.',
  invite_expired: 'the invite code has expired. Mint a new one.',
  invite_exhausted: 'the invite code has no uses left. Mint a new one, or raise --uses next time.',
  invite_invalid: 'the relay does not recognise this invite code. Check the code file is the one\n' +
    '  this deployment minted — a code from another relay is invalid here, not expired.',
}

/**
 * Explain a refusal in the operator's terms.
 *
 * Never returns an empty string: a refusal with no explanation is the failure mode this exists to
 * prevent — `!ok` cannot distinguish a correct refusal from a correct refusal nobody can act on.
 */
export function refusal(status, json, text = '') {
  const err = String(json?.error || '').trim()
  if (status === 429) {
    return `rate limited — the relay allows ${CLAIM_RATE_LIMIT} claim attempts per key per 60s. ` +
      'Wait a minute.\n  This is a throttle, not a rejection of the code.'
  }
  if (REFUSALS[err]) return `${err} — ${REFUSALS[err]}`
  if (/replay/i.test(err)) {
    return `${err} — a NIP-98 auth event with this id was already seen. created_at is\n` +
      '  second-granularity, so an identical call inside the same second repeats. Wait a second.'
  }
  return err || String(text).slice(0, 200) || '(no error body)'
}

export function checkMintBounds(ttl, uses) {
  if (!Number.isFinite(ttl) || ttl <= 0) return '--ttl must be a positive number of seconds'
  if (!Number.isFinite(uses) || uses < 1) return '--uses must be at least 1'
  if (ttl < MIN_TTL_SECS) return `--ttl ${ttl} is below the relay's minimum of ${MIN_TTL_SECS}s`
  if (ttl > MAX_TTL_SECS) return `--ttl ${ttl} is above the relay's maximum of ${MAX_TTL_SECS}s (30 days)`
  if (uses > MAX_USES) return `--uses ${uses} is above the relay's maximum of ${MAX_USES}`
  return null
}

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
