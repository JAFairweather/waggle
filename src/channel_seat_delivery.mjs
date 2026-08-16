// channel_seat_delivery.mjs — the bridge's half of the broker seat (#502).
//
// #488 built both ends and nothing in between. The console can sign a seat intent; the broker's
// forced command can apply one and return a receipt. What carried the intent from one to the other
// was an operator running `ssh` by hand — the last command line in the connect flow, and the step
// the goal excludes.
//
// This module is the decision layer for the middle. The bridge already consumes an approver-signed
// control lane (`handleWatchlistControlCommand` and its siblings), and `DESIGN_AGENT_LIFECYCLE_PLANE`
// is explicit that owner intent belongs there and that no second transport should be invented for
// it. So a seat rides the lane that already moves a watchlist entry, and this file holds the parts
// worth testing without a broker: what may be forwarded, and what a returned receipt is allowed to
// make the bridge believe.
//
// WHAT THE BRIDGE FORWARDS IS THE SIGNED EVENT, BYTE FOR BYTE. It does not re-sign, re-wrap or
// re-encode it. The broker verifies the same signature against its own approver roster, so the two
// sides agree on authority without the bridge being trusted to assert it — the bridge is a wire,
// and a wire that could rewrite the intent would be a second approver.
//
// THE RECEIPT IS NOT SIGNED, AND THAT IS THE OPEN QUESTION FOR REVIEW. The policy plane verifies a
// signed receipt because its evidence path is untrusted end to end. Here the ssh channel is the
// authentication: `StrictHostKeyChecking=yes` against a pinned known-hosts file identifies the
// broker, and a forced command means the account can produce nothing else. A broker that can lie
// about a seat is a broker that can make the seat, so a signature would prove nothing further —
// but that argument is the thing to attack, not to assume.

import { canonicalJson } from './buzz_policy_core.mjs'
import { SEAT_OP, SEAT_VERSION, keyFingerprint, parseSeatIntent } from './channel_seat.mjs'

const HEX64 = /^[0-9a-f]{64}$/
const RESULTS = new Set(['seated', 'already-seated', 'conflict', 'refused'])
const RECEIPT_KEYS = 'agent,at,fingerprint,instance,op,reason,result,v'
// The receipt comes off a pipe. A broker that has gone wrong in an interesting way can put a great
// deal on stdout, and a megabyte of it parsed as JSON is a denial of service against the bridge
// rather than a diagnosis.
const MAX_RECEIPT_BYTES = 8192

const refuse = reason => Object.freeze({ ok: false, reason })

/**
 * Is this control event a seat intent this bridge should forward?
 *
 * Pure and total: it is handed bytes that arrived over a relay. It deliberately does NOT decide
 * whether the seat is a good idea — that is the broker's decision, made against a file this side
 * cannot see. It decides only whether spending an ssh call is warranted, and refuses locally
 * whatever the broker would refuse anyway.
 */
export function seatIntentToForward(event, { approvers = [], bridgePubkey = '', commandD = '',
  now = Math.floor(Date.now() / 1000), maxAgeSeconds = 900, maxFutureSkew = 300 } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return refuse('not an event')
  const author = String(event.pubkey || '').toLowerCase()
  if (!HEX64.test(author)) return refuse('event has no author')
  if (!Array.isArray(approvers) || !approvers.includes(author)) return refuse('author is not an approver')
  if (!HEX64.test(String(bridgePubkey || '').toLowerCase())) return refuse('no bridge identity to address')
  if (!commandD) return refuse('no seat command tag configured')

  // Addressed to THIS bridge and to the seat verb specifically. Two tags exactly, in the shape the
  // sibling handlers use: a control event carrying extra tags is refused rather than read past,
  // because a tag this handler ignores is a tag a future handler might not.
  const tags = Array.isArray(event.tags) ? event.tags : []
  if (tags.length !== 2 ||
      tags[0]?.[0] !== 'd' || tags[0]?.[1] !== commandD || tags[0].length !== 2 ||
      tags[1]?.[0] !== 'p' || String(tags[1]?.[1] || '').toLowerCase() !== String(bridgePubkey).toLowerCase() || tags[1].length !== 2) {
    return refuse('not addressed to this bridge')
  }

  // A future-dated event and an old one are different diagnoses, and the sibling handlers already
  // learnt not to report the first as the second — a signer whose clock is ahead sends an operator
  // hunting for staleness that is not there.
  if (!Number.isSafeInteger(event.created_at)) return refuse('stale command')
  if (event.created_at > now + maxFutureSkew) return refuse('command is dated in the future')
  if (now - event.created_at > maxAgeSeconds) return refuse('stale command')

  let body
  try { body = JSON.parse(String(event.content || '')) } catch { return refuse('invalid body') }
  // Canonical, and compared against the exact content bytes. The broker re-derives the same
  // canonical form, so an intent whose content is merely equivalent JSON would be forwarded here and
  // refused there — a refusal the operator would read as the broker rejecting their key.
  if (canonicalJson(body) !== event.content) return refuse('intent content is not canonical JSON')
  const intent = parseSeatIntent(body)
  if (intent.ok !== true) return refuse(intent.reason)

  return Object.freeze({ ok: true, intent, fingerprint: keyFingerprint(intent.keyBlob) })
}

/**
 * What did the broker actually say?
 *
 * Three outcomes, and the third is the one this project keeps having to defend: `unknown` is not a
 * refusal. A transport that failed, a receipt that would not parse, and a receipt for a different
 * key are three different facts, and collapsing any of them into "refused" tells an operator the
 * broker made a decision it never made.
 */
export function readSeatReceipt(stdout, { intent, fingerprint } = {}) {
  const unknown = reason => Object.freeze({ ok: false, terminal: false, reason })
  const raw = String(stdout == null ? '' : stdout)
  // A size FLOOR as well as a ceiling. An empty read is the shape a broken pipe takes, and a scan of
  // nothing has reported everything clean here before.
  if (!raw.trim()) return unknown('the broker returned nothing — INCONCLUSIVE, not a refusal')
  if (Buffer.byteLength(raw) > MAX_RECEIPT_BYTES) return unknown('the broker returned more than a receipt — INCONCLUSIVE')
  let receipt
  try { receipt = JSON.parse(raw) } catch { return unknown('the broker did not return a receipt — INCONCLUSIVE, not a refusal') }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return unknown('the broker did not return a receipt — INCONCLUSIVE, not a refusal')
  if (Object.keys(receipt).sort().join(',') !== RECEIPT_KEYS) return unknown('the receipt is not the shape this bridge understands — INCONCLUSIVE')
  if (receipt.v !== SEAT_VERSION || receipt.op !== SEAT_OP) return unknown('not a channel_seat receipt — INCONCLUSIVE')
  if (!RESULTS.has(receipt.result)) return unknown('the receipt names no outcome this bridge understands — INCONCLUSIVE')

  // Bound to what was SENT. A receipt is only evidence about the intent it answers; one that names a
  // different agent or a different key is a broker answering a question nobody here asked, and
  // reporting it as this seat's outcome would put a stranger's result under this agent's name.
  const wantAgent = intent && intent.ok === true ? intent.agent : null
  if (wantAgent && String(receipt.agent || '').toLowerCase() !== wantAgent) {
    return unknown(`the receipt answers for a different agent (${String(receipt.agent || 'none').slice(0, 16)}…) — INCONCLUSIVE`)
  }
  const wantFingerprint = fingerprint || (intent && intent.ok === true ? keyFingerprint(intent.keyBlob) : null)
  // A refusal legitimately carries no fingerprint: the broker may have refused before it had a key
  // to fingerprint. Only a receipt claiming an OUTCOME on a key has to name the right key.
  if (wantFingerprint && receipt.fingerprint && receipt.fingerprint !== wantFingerprint) {
    return unknown(`the receipt seats ${receipt.fingerprint} and this intent carried ${wantFingerprint} — INCONCLUSIVE`)
  }

  const seated = receipt.result === 'seated' || receipt.result === 'already-seated'
  // THE EXEMPTION ABOVE IS FOR REFUSALS, AND THE CODE DID NOT SAY SO. Written as
  // `receipt.fingerprint &&` it exempted EVERY falsy fingerprint, a receipt claiming a seat
  // included — which came back terminal and `seated: true`, advanced the watermark and rendered as
  // a completed seat, while `seatVerdict`, this project's other reader of the same field, refuses
  // exactly that. The comment stated the rule; the check did not implement it. Not reachable from an
  // honest broker, which is the point: this is the guard the unsigned-receipt argument leans on.
  if (seated && !receipt.fingerprint) {
    return unknown('the receipt claims a seat but names no key — INCONCLUSIVE')
  }
  return Object.freeze({ ok: true, terminal: true, seated, result: receipt.result, receipt: Object.freeze(receipt) })
}

/**
 * The line an operator reads in the journal.
 *
 * Written here rather than at the call site so the wording is testable: "seat unknown" and "seat
 * refused" are the two states that must never be rendered as each other, and a log line is what
 * somebody acts on at 2am.
 */
export function seatLogLine(outcome, { agent = '', approver = '', eventId = '' } = {}) {
  const who = `${String(agent).slice(0, 12)}…`
  const from = approver ? ` from approver ${String(approver).slice(0, 12)}…` : ''
  const src = eventId ? ` (${String(eventId).slice(0, 12)}…)` : ''
  if (outcome?.ok === true) return `channel-seat: ${outcome.result} for ${who}${from}${src}`
  return `channel-seat: UNKNOWN for ${who} — ${outcome?.reason || 'no reason given'}${from}${src}`
}
