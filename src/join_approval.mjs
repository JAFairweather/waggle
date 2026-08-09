// join_approval.mjs — read an owner's decision out of a direct-message reply, or refuse to.
//
// THE PARSE IS THE SECURITY BOUNDARY. This function turns a string that arrived over a relay into
// "the owner said yes", and everything downstream — minting an identity, issuing grants, releasing
// a pairing token — happens because it returned APPROVE. So it is written to be boring, exact,
// and impossible to satisfy by accident.
//
// THE WHOLE BODY MUST MATCH. Not "contains APPROVE". Not "a line that starts with APPROVE". The
// entire decrypted message, trimmed, must equal `APPROVE <request-id>`. This repo has already
// been bitten by the class this defends against: the rendering suite exists because a hostile
// note tried to mint an `APPROVED BY` heading inside quoted text, and a `contains`-style parse
// would make every quoted string in every forwarded message a potential approval. An owner who
// replies "APPROVE abc123 — looks good to me" has NOT approved, and is told so.
//
// WHAT THIS DOES NOT DO. It does not check signatures, it does not check who sent the message,
// and it does not consume anything. Those are the caller's, because they need keys and state that
// a parser must not hold. `decideJoinReply` is pure: text in, decision out. `authorizeJoinReply`
// composes it with the sender check and the single-use registry, which is the order that matters
// — cheap exact-match first, so a malformed message never reaches the registry and cannot burn a
// nonce by arriving.

const HEX64 = /^[0-9a-f]{64}$/
export const APPROVE = 'APPROVE'
export const DENY = 'DENY'

// Anchored, whole-string, single internal space, case-sensitive verb. Case-sensitivity is
// deliberate: "approve" in lower case is far more likely to be prose than a decision, and an
// owner who shouts it gets told exactly what to send instead.
const REPLY_RE = /^(APPROVE|DENY) ([0-9a-f]{64})$/

/**
 * Decide what a reply body says. Pure.
 * @returns {{ok: true, decision: 'APPROVE'|'DENY', requestId: string} | {ok: false, reason: string}}
 */
export function decideJoinReply(body) {
  if (typeof body !== 'string') return { ok: false, reason: 'reply is not text' }
  // Trim only the outside. Internal whitespace is left alone so that a reply carrying a quote,
  // a signature block, or a second line fails the anchor rather than being silently salvaged.
  const exact = body.trim()
  if (exact === '') return { ok: false, reason: 'reply is empty' }
  const m = REPLY_RE.exec(exact)
  if (!m) {
    // The refusal names the shape, because the most likely sender of a malformed reply is the
    // owner, and a refusal they cannot act on is a refusal that turns into a support question.
    const looksClose = /approve|deny/i.test(exact)
    return {
      ok: false,
      reason: looksClose
        ? 'reply must be exactly "APPROVE <request-id>" or "DENY <request-id>" and nothing else — no quoted text, no comment, no extra lines'
        : 'reply is not a decision',
    }
  }
  return { ok: true, decision: m[1], requestId: m[2] }
}

/**
 * Authorize a reply: it says something exact, the sender may decide, and the request id has not
 * already been spent.
 *
 * Order is load-bearing. The exact-match runs FIRST so that a message which is not a decision at
 * all never touches the registry — otherwise anyone who can send the owner's inbox a string
 * containing a valid request id could burn it, and a denial-of-approval is still a denial.
 * The sender check runs BEFORE the consume for the same reason: a stranger must not be able to
 * spend a nonce minted for the owner.
 *
 * @param {object}   args
 * @param {string}   args.body        decrypted reply text
 * @param {string}   args.senderPubkey 64-hex author of the reply
 * @param {string[]} args.approvers   pubkeys permitted to decide
 * @param {object}   args.registry    createChallengeRegistry instance holding outstanding requests
 */
export function authorizeJoinReply({ body, senderPubkey, approvers, registry }) {
  const decided = decideJoinReply(body)
  if (!decided.ok) return decided

  const sender = String(senderPubkey || '').toLowerCase()
  if (!HEX64.test(sender)) return { ok: false, reason: 'reply has no usable author' }

  // An empty approvers list must refuse everyone, never admit everyone. A misconfigured or
  // unread config is exactly when this is most likely to be consulted.
  const allowed = Array.isArray(approvers) ? approvers.map(a => String(a || '').toLowerCase()) : []
  if (!allowed.length) return { ok: false, reason: 'no approvers are configured, so nobody may decide' }
  if (!allowed.includes(sender)) return { ok: false, reason: 'sender is not an approver' }

  // Spend the request id. Both APPROVE and DENY consume it: a decided request is finished either
  // way, and leaving a denied id spendable would let a later replay of an earlier APPROVE
  // overturn the owner's refusal.
  const spent = registry.consume(decided.requestId, sender)
  if (!spent.ok) return { ok: false, reason: spent.reason }

  return { ok: true, decision: decided.decision, requestId: decided.requestId, request: spent.record, approver: sender }
}

/**
 * The message the owner receives. Built here so the wording and the parser cannot drift — the
 * instruction an owner is given is generated from the same constants the parser matches on.
 */
export function approvalRequestMessage({ requestId, requesterPubkey, caps = [], purpose = '', expiresAt = null, describeCap = (c) => c }) {
  if (!HEX64.test(String(requestId || ''))) throw new Error('approval request needs a 64-hex request id')
  const lines = [
    'A session is asking to join your hive as an agent.',
    '',
    `Requester key: ${requesterPubkey}`,
  ]
  if (purpose) lines.push(`It says: ${String(purpose).slice(0, 300)}`)
  lines.push('', 'If you approve, it will be able to:')
  for (const cap of caps) lines.push(`  - ${describeCap(cap)}`)
  lines.push(
    '',
    'It will NOT be able to read the channel. The community relay will not serve an external',
    'key; what reaches it is mentions only.',
    '',
  )
  if (expiresAt) lines.push(`This request expires ${new Date(expiresAt * 1000).toISOString()}. Doing nothing refuses it.`, '')
  lines.push(
    'Reply with EXACTLY one of these and nothing else — no quote, no comment, no extra line:',
    '',
    `${APPROVE} ${requestId}`,
    `${DENY} ${requestId}`,
  )
  return lines.join('\n')
}
