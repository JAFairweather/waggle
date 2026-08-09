// join_approval.mjs — what counts as the owner saying yes.
//
// This parser turns a string that arrived over a relay into "mint an identity and issue grants".
// It is the security boundary of the whole join ceremony, so the fixtures here are hostile on
// purpose and resemble real messages rather than tidy ones.
//
// The governing failure this defends against already happened in this repo: the rendering suite
// exists because a hostile note tried to mint an `APPROVED BY` heading inside quoted text. A
// `contains`-style parse would make every quoted string in every forwarded message a potential
// approval. So the tests below spend most of their effort on things that look like approvals and
// must not be — and are paired throughout with the legitimate reply still being accepted, because
// a parser that refuses everything passes every hostile case and is useless.
//
//   node tests/join_approval.mjs

import { decideJoinReply, authorizeJoinReply, approvalRequestMessage, APPROVE, DENY }
  from '../src/join_approval.mjs'
import { createChallengeRegistry } from '../src/challenge_registry.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const ID = '7f3a'.repeat(16)                       // 64 hex
const OWNER = 'a'.repeat(64), STRANGER = 'b'.repeat(64)
const setup = () => {
  const registry = createChallengeRegistry()
  const issued = registry.issue(OWNER, { caps: ['task'] })
  return { registry, id: issued.id }
}

// ── The exact reply is accepted, both verbs ─────────────────────────────────────────────────
{
  const yes = decideJoinReply(`${APPROVE} ${ID}`)
  check(yes.ok && yes.decision === 'APPROVE' && yes.requestId === ID, 'the exact approval is read as APPROVE')
  const no = decideJoinReply(`${DENY} ${ID}`)
  check(no.ok && no.decision === 'DENY', 'and the exact denial is read as DENY')
  check(decideJoinReply(`  ${APPROVE} ${ID}\n`).ok,
    'surrounding whitespace is tolerated — an owner who hits return has still sent exactly the token')
}

// ── Things that LOOK like approvals and must not be ─────────────────────────────────────────
// Each of these passes a `contains` check. That is the point.
{
  const hostile = [
    [`${APPROVE} ${ID} — looks good to me`, 'a comment appended after the token'],
    [`Sure, ${APPROVE} ${ID}`, 'a token with prose in front of it'],
    [`${APPROVE} ${ID}\n\n> quoted from someone else`, 'a token followed by a quote block'],
    [`> ${APPROVE} ${ID}`, 'a token that is itself quoted — someone forwarding the request back'],
    [`${APPROVE} ${ID}\n${APPROVE} ${'c'.repeat(64)}`, 'two tokens, so which one did they mean'],
    ['Please APPROVE this when you get a moment', 'the word approve in ordinary prose'],
    [`APPROVED BY ${ID}`, 'the exact heading a hostile note once tried to mint'],
    [`${APPROVE}\t${ID}`, 'a tab instead of a space'],
    [`${APPROVE}  ${ID}`, 'two spaces instead of one'],
    [`approve ${ID}`, 'lower case, far more likely to be prose than a decision'],
    [`Approve ${ID}`, 'title case'],
    [`${APPROVE} ${ID.toUpperCase()}`, 'an upper-case request id, which is not the id that was issued'],
    [`${APPROVE} ${ID.slice(0, 63)}`, 'a truncated request id'],
    [`${APPROVE} ${ID}${ID}`, 'a doubled request id'],
    [`${APPROVE}${ID}`, 'no separator at all'],
    ['', 'an empty message'],
    ['   \n  ', 'whitespace only'],
  ]
  for (const [body, why] of hostile) {
    check(!decideJoinReply(body).ok, `REFUSED — ${why}`)
  }
  check(!decideJoinReply(null).ok && !decideJoinReply(undefined).ok && !decideJoinReply(42).ok,
    'REFUSED — a reply that is not text at all')
}

// ── A near-miss is told what to send ────────────────────────────────────────────────────────
{
  const close = decideJoinReply(`${APPROVE} ${ID} thanks`)
  check(!close.ok && /exactly/.test(close.reason) && /no quoted text|no comment/.test(close.reason),
    'a near-miss refusal names the exact shape required, because the likeliest sender of one is the owner')
  const unrelated = decideJoinReply('what time is the standup')
  check(!unrelated.ok && !/exactly/.test(unrelated.reason),
    'and an ordinary message is not lectured about a format it was never trying to use')
}

// ── Authorization: sender, and the order that protects the nonce ────────────────────────────
{
  const { registry, id } = setup()
  const good = authorizeJoinReply({ body: `${APPROVE} ${id}`, senderPubkey: OWNER, approvers: [OWNER], registry })
  check(good.ok && good.decision === 'APPROVE' && good.approver === OWNER, 'an approver sending the exact token is authorized')
  const replay = authorizeJoinReply({ body: `${APPROVE} ${id}`, senderPubkey: OWNER, approvers: [OWNER], registry })
  check(!replay.ok, 'and the identical message replayed a second time is refused')
}
{
  const { registry, id } = setup()
  const stranger = authorizeJoinReply({ body: `${APPROVE} ${id}`, senderPubkey: STRANGER, approvers: [OWNER], registry })
  check(!stranger.ok && /not an approver/.test(stranger.reason), 'a non-approver is refused')
  const owner = authorizeJoinReply({ body: `${APPROVE} ${id}`, senderPubkey: OWNER, approvers: [OWNER], registry })
  check(owner.ok,
    'and the stranger DID NOT BURN the request — otherwise anyone who can reach the inbox can deny the owner their approval')
}
{
  const { registry, id } = setup()
  const junk = authorizeJoinReply({ body: `${APPROVE} ${id} — yes please`, senderPubkey: OWNER, approvers: [OWNER], registry })
  check(!junk.ok, 'a malformed reply from the owner is refused')
  check(authorizeJoinReply({ body: `${APPROVE} ${id}`, senderPubkey: OWNER, approvers: [OWNER], registry }).ok,
    'and it did not burn the request either — the exact-match runs before the registry is touched')
}
{
  const { registry, id } = setup()
  check(!authorizeJoinReply({ body: `${APPROVE} ${id}`, senderPubkey: OWNER, approvers: [], registry }).ok,
    'an EMPTY approvers list refuses everyone rather than admitting everyone — the misconfigured case fails closed')
  check(!authorizeJoinReply({ body: `${APPROVE} ${id}`, senderPubkey: 'nope', approvers: [OWNER], registry }).ok,
    'and a malformed author is refused')
  check(authorizeJoinReply({ body: `${APPROVE} ${id}`, senderPubkey: OWNER.toUpperCase(), approvers: [OWNER], registry }).ok,
    'while case in the author key does not change who they are')
}

// ── DENY finishes the request too ───────────────────────────────────────────────────────────
{
  const { registry, id } = setup()
  const denied = authorizeJoinReply({ body: `${DENY} ${id}`, senderPubkey: OWNER, approvers: [OWNER], registry })
  check(denied.ok && denied.decision === 'DENY', 'a denial is authorized as a decision')
  const overturn = authorizeJoinReply({ body: `${APPROVE} ${id}`, senderPubkey: OWNER, approvers: [OWNER], registry })
  check(!overturn.ok,
    'and a later APPROVE for the same request cannot overturn it — a decided request is finished either way')
}

// ── The instruction and the parser cannot drift ─────────────────────────────────────────────
// The message tells the owner what to send. If that wording and this parser ever disagree, every
// approval fails and the reason is invisible — so the message is generated and fed straight back in.
{
  const msg = approvalRequestMessage({
    requestId: ID, requesterPubkey: 'd'.repeat(64), caps: ['task', 'task-relay'],
    purpose: 'ship the join runbook', expiresAt: 1_800_000_000,
    describeCap: (c) => ({ task: 'Take tasks from you', 'task-relay': 'Carry signed instructions' }[c] || c),
  })
  const approveLine = msg.split('\n').find(l => l.startsWith(APPROVE))
  const denyLine = msg.split('\n').find(l => l.startsWith(DENY))
  check(!!approveLine && decideJoinReply(approveLine).ok && decideJoinReply(approveLine).requestId === ID,
    'ROUND TRIP — the line the owner is told to send is a line this parser accepts')
  check(!!denyLine && decideJoinReply(denyLine).ok, 'and so is the denial line')
  check(/will NOT be able to read/.test(msg),
    'the message says plainly that this does not grant read — the claim an owner is most likely to assume wrongly')
  check(/Take tasks from you/.test(msg) && !/\btask\b(?!s)/.test(msg.split('If you approve')[1].split('It will NOT')[0]),
    'and capabilities are described in words, not as raw protocol vocabulary')
  check(/Doing nothing refuses it/.test(msg), 'and silence is stated to be a refusal — default closed, said out loud')
}

// ── NEGATIVE CONTROL ────────────────────────────────────────────────────────────────────────
// Most of this suite is refusals, which a parser that always returns {ok:false} would pass.
{
  const { registry, id } = setup()
  check(decideJoinReply(`${APPROVE} ${ID}`).ok && decideJoinReply(`${DENY} ${ID}`).ok,
    'NEGATIVE CONTROL — the exact tokens are accepted, so this parser does not simply refuse everything')
  check(authorizeJoinReply({ body: `${APPROVE} ${id}`, senderPubkey: OWNER, approvers: [OWNER], registry }).ok,
    'and a fully legitimate authorization succeeds end to end')
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
