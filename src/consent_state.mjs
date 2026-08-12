// consent_state.mjs — one word per watched author, and it has to be TRUE (#389, blocks #331).
//
// The owner-control record (#67/#206) publishes a consent state per watched author. It is signed,
// public, and it is the only thing a console can build a Sources tab on. For four of the six states
// #331 needs, it used to publish the same word: `pending`. Driven through the real bridge with
// enforcement on —
//
//     superseded-terms consenter   -> "pending"
//     grandfathered                -> "pending"
//     muted (approver rejected)    -> "pending"
//     never asked                  -> "pending"
//
// — and one of those four is being CARRIED. A grandfathered author is never held (bridge.mjs's
// consent gate: `if (!consentBinds && !PUB.mirrorGrandfathered.includes(author))`), so the record
// labelled an active carry identically to an author whose every post was dropped. That is the lie
// #331 calls the worst direction: it implies consent underpins a carry running on an exemption.
//
// THE PRECEDENCE IS COPIED, NOT CHOSEN. Each branch below mirrors what the routing gate actually
// does to that author's posts, because a label that disagrees with the routing is worse than no
// label — the owner acts on it. Two consequences that look wrong until you check the gate:
//
//   - `grandfathered` BEATS `revoked`. An author who withdrew consent and is also on the exemption
//     list is still carried, so `revoked` would be false. The withdrawal is real and is not lost —
//     it is simply not what is happening to their posts.
//   - `held` and `pending` are the same consent situation under different gates. With
//     mirror_require_consent ON an un-consented author is dropped; OFF, they are carried ungated.
//     One word for both made the top-level meaning depend on `operations.gates.consent_required`,
//     a field the schema treats as optional — so an omitted field silently flipped the meaning.
//
// Pure: no I/O, no config read, no bridge state. Callers pass what they observe.

/**
 * The closed vocabulary, in precedence order. Exported so the signing schema and the projection
 * cannot drift apart — a word this module can emit that the schema rejects would fail closed at the
 * relay, after signing, on a record nobody reads until the console is blank.
 */
export const CONSENT_STATES = Object.freeze([
  'active',         // carrying, on the subject's own consent record
  'grandfathered',  // CARRIED, no consent record, permanently exempt (the pre-consent crew)
  'asked',          // the disclosure DM went out; waiting on them. Silence is a no (CONSENT.md §6)
  'muted',          // the APPROVER rejected them. Never asked, ever — maybeAskConsent refuses
  'revoked',        // the subject withdrew their own consent
  'held',           // no consent and the gate is on: every post dropped, with the reason logged
  'pending',        // no consent and the gate is off: carried, ungated, observed only
])

const SET = new Set(CONSENT_STATES)

/** Is `word` a state this vocabulary defines? The schema's check and the projection's are the same. */
export function isConsentState(word) {
  return SET.has(word)
}

/**
 * Derive one author's state.
 *
 * Every argument is a fact the caller observed, never a config path — this module cannot be made to
 * disagree with the bridge by reading a different file than the bridge read.
 *
 * @param o.consented      the author holds an active, terms-bound consent record
 * @param o.grandfathered  the author is on the permanent exemption list
 * @param o.asked          a consent ask has been sealed to this author (durable, once ever)
 * @param o.muted          the approver rejected this author
 * @param o.revoked        the author published a valid withdrawal of their own consent
 * @param o.gated          mirror_require_consent is on
 * @returns one of CONSENT_STATES
 */
export function consentState({ consented, grandfathered, asked, muted, revoked, gated } = {}) {
  // Consent first: a grandfathered author who later consented is carried ON THE CONSENT, and saying
  // so is the difference between "they agreed" and "we exempted them".
  if (consented) return 'active'
  // Then the exemption, because the gate checks it next and carries them regardless of everything
  // below — including a withdrawal.
  if (grandfathered) return 'grandfathered'
  // A withdrawal is the subject's own act and outranks the operator's classification below it.
  if (revoked) return 'revoked'
  // Muted before asked: the approver's rejection means no ask will ever follow, so "waiting on them"
  // would describe a wait that cannot end.
  if (muted) return 'muted'
  if (asked) return 'asked'
  // Same consent situation, two different things happening to the posts. Name which.
  return gated ? 'held' : 'pending'
}
