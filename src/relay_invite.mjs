// relay_invite.mjs — what a relay's refusal MEANS, and the bounds it enforces (#357, #362).
//
// Split out of `tools/relay-invite.mjs` so it can be asserted against directly. The tool is a
// script with top-level execution; importing it would run it, so the part worth testing has to
// live somewhere a test can call.
//
// The point of this module is the distinction between "the relay could not be reached" and "the
// relay answered, and its answer is no". The tool originally collapsed every non-401 failure into
// exit 2, "relay/network" — so `403 join_policy_required`, a deliberate and completely explicable
// decision, reached the operator as a suspected connectivity problem. A definitive refusal is a
// RESULT. Reporting it as a transient sends someone to check their network over a policy.

/** The relay's own input bounds (`buzz-relay` invites.rs), mirrored so a bad value fails locally. */
export const MIN_TTL_SECS = 60
export const MAX_TTL_SECS = 30 * 24 * 60 * 60
export const MAX_USES = 10_000
/** Claim attempts allowed per pubkey per 60s window. */
export const CLAIM_RATE_LIMIT = 10

/** Exit codes. 4 exists because "the relay said no" is neither bad input nor a network fault. */
export const EXIT = { OK: 0, INPUT: 1, NETWORK: 2, INCONCLUSIVE: 3, REFUSED: 4 }

const REFUSALS = {
  join_policy_required: 'this deployment has a join policy and the claim carried no receipt.\n' +
    '  Re-run with --accept-terms (and --confirm-age if the policy requires attestation).',
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

/**
 * Which exit code a status deserves.
 *
 * 4xx is the relay deciding; 5xx and anything else is the relay failing. The split matters because
 * a retry loop should back off on one and stop on the other.
 */
export function exitFor(status) {
  if (status >= 200 && status < 300) return EXIT.OK
  if (status === 401) return EXIT.INPUT
  if (status >= 400 && status < 500) return EXIT.REFUSED
  return EXIT.NETWORK
}

/** Local check of the relay's mint bounds. Returns null when fine, else the operator's message. */
export function checkMintBounds(ttl, uses) {
  if (!Number.isFinite(ttl) || ttl <= 0) return '--ttl must be a positive number of seconds'
  if (!Number.isFinite(uses) || uses < 1) return '--uses must be at least 1'
  if (ttl < MIN_TTL_SECS) return `--ttl ${ttl} is below the relay's minimum of ${MIN_TTL_SECS}s`
  if (ttl > MAX_TTL_SECS) return `--ttl ${ttl} is above the relay's maximum of ${MAX_TTL_SECS}s (30 days)`
  if (uses > MAX_USES) return `--uses ${uses} is above the relay's maximum of ${MAX_USES}`
  return null
}
