// consent-vocabulary.mjs — the browser's copy of the consent states (#389, for #331's Sources tab).
//
// `src/` and `console/` never import each other: the console is static files a browser fetches, and
// nothing under src/ is served. So this is a deliberate second copy, exactly like console/scope-hash.mjs,
// and `tests/control_state.mjs` asserts word-for-word agreement with src/consent_state.mjs. A copy
// nobody checks is a copy that drifts; the check is what makes the duplication honest.
//
// Why it matters that this list is complete rather than merely valid: config-operations.mjs rejects
// the WHOLE signed state if any follow carries a word it does not know. Miss one and the console does
// not mis-render a row — it renders "state unavailable" and the owner sees nothing at all.

/** Wire values, in the same precedence order as src/consent_state.mjs. */
export const CONSENT_STATES = Object.freeze([
  'active', 'grandfathered', 'asked', 'muted', 'revoked', 'held', 'pending',
])

/**
 * What the owner reads. Taken from the bridge's own vocabulary (#331) rather than invented, so a
 * row and the journal line explaining it use the same word.
 *
 * Two of these are not what you would guess:
 *   - `grandfathered` is a CARRY. It says so, because a label implying consent underpins an
 *     exemption is the one #331 calls the worst direction to be wrong in.
 *   - `muted` is the APPROVER's rejection, not the author's. #331 called this state "Declined",
 *     which reads as the author saying no — but the bridge cannot observe that. CONSENT.md §6 is
 *     that silence is a no, and there is no decline event, so nothing ever distinguishes "said no"
 *     from "has not answered". Naming the wrong party here would tell an owner the author refused
 *     when in fact the owner did.
 */
export const CONSENT_LABEL = Object.freeze({
  active: 'Carrying',
  grandfathered: 'Grandfathered — carried, no consent',
  asked: 'Asked — waiting on them',
  muted: 'Rejected by you — never asked',
  revoked: 'Withdrawn',
  held: 'Held, no consent',
  pending: 'No consent — carried, gate off',
})

/** Is this author's content reaching the community right now? Three of the seven say yes. */
export const CONSENT_IS_CARRYING = Object.freeze({
  active: true, grandfathered: true, pending: true,
  asked: false, muted: false, revoked: false, held: false,
})
