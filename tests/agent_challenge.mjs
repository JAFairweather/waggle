// agent_challenge.mjs — the proof-of-control gate every agent-onboarding door converges on (#309).
//
// Drives the REAL createAgentChallenge + verifyAgentChallenge against synthetic signed events.
// The governing rule here is that a refusal assertion alone is worthless: a guard that rejects
// everything and a guard that rejects the dangerous thing fail identically under a one-sided test.
// That exact gap shipped a silent outage on 2026-08-01, so EVERY refusal below is paired with a
// legitimate value that must still get through — and `refuses()` asserts WHICH guard spoke, so an
// assertion cannot pass on an incidental TypeError instead of the check it names.
//
// The properties that matter and their failure modes:
//   - a genuine response from the claimed key PASSES (the pair for every refusal);
//   - a valid signature by a DIFFERENT key is refused — else "prove control" proves nothing;
//   - a response to another nonce is refused — else a harvested signature replays forever;
//   - a foreign kind or a missing/duplicated domain tag is refused — else a signature obtained on
//     another waggle surface can be presented here as a control proof;
//   - the value CHECKED is the value VERIFIED, even when the caller supplies getters;
//   - a polluted Object.prototype cannot reintroduce nostr-tools' verification short-circuit;
//   - expiry is judged when the response is VERIFIED, not when the signer was opened.
//
//   node tests/agent_challenge.mjs

import { generateSecretKey, getPublicKey, finalizeEvent, verifiedSymbol } from 'nostr-tools/pure'
import {
  AGENT_CHALLENGE_KIND, AGENT_CHALLENGE_TAG,
  createAgentChallenge, verifyAgentChallenge, challengeEvidence,
} from '../src/agent_challenge.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

// `want` is required: without it a refusal assertion passes on ANY throw, including a TypeError
// from a typo, which is how a deleted guard goes unnoticed. Asserting the message ties each
// assertion to the specific guard it claims to exercise.
const refuses = (fn, label, want) => {
  try { fn(); check(false, `${label} (no refusal)`); return } catch (e) {
    const named = e.message.startsWith('agent-challenge: ') && e.message.includes(want)
    check(named, named ? label : `${label} — threw the WRONG error: ${e.message}`)
  }
}
const allows = (fn, label) => { try { fn(); check(true, label) } catch (e) { check(false, `${label} — threw: ${e.message}`) } }

const agentSk = generateSecretKey(), agent = getPublicKey(agentSk)
const otherSk = generateSecretKey(), other = getPublicKey(otherSk)
const AT = 1_780_000_000
const at = () => AT

// DELIBERATELY returns the raw finalizeEvent result WITHOUT a JSON roundtrip — unlike every other
// fixture helper in this suite. That is what makes the tampering assertions below a real negative
// control: nostr-tools stamps `verifiedSymbol` on what it finalizes, and a roundtrip would strip it,
// so "tidying" this helper to match the house wire-form convention would silently convert those
// assertions into restatements of JSON.parse. Do not.
const respond = (sk, nonce, { kind = AGENT_CHALLENGE_KIND, tag = AGENT_CHALLENGE_TAG, extra = [], created_at = AT } = {}) =>
  finalizeEvent({ kind, created_at, tags: [[tag, nonce], ...extra], content: '' }, sk)

// ---- issuing --------------------------------------------------------------------------------
const challenge = createAgentChallenge(agent, { now: at })
check(challenge.agent_pubkey === agent, 'challenge binds the identity the connection claims')
check(challenge.expires_at > challenge.issued_at, 'challenge carries an expiry after its issue time')
check(Object.isFrozen(challenge), 'challenge is frozen — a caller cannot widen it after issue')

const second = createAgentChallenge(agent, { now: at })
check(second.nonce !== challenge.nonce, 'each challenge gets a fresh nonce (no reuse across issues)')

refuses(() => createAgentChallenge('not-a-pubkey', { now: at }), 'refuses a malformed identity at issue', 'agent pubkey')
refuses(() => createAgentChallenge(agent, { now: at, nonce: () => 'short' }), 'refuses a nonce below the shared length floor', 'nonce is invalid')
refuses(() => createAgentChallenge(agent, { now: at, ttlSeconds: 0 }), 'refuses a non-positive ttl', 'ttl')
refuses(() => createAgentChallenge(agent, { now: () => NaN }), 'refuses an unusable issuing clock', 'issuing clock')
allows(() => createAgentChallenge(agent, { now: at, ttlSeconds: 30 }), 'PAIR: a positive ttl is accepted')

// ---- the positive control, stated first and re-stated after every refusal ---------------------
const good = respond(agentSk, challenge.nonce)
allows(() => verifyAgentChallenge(challenge, good, { now: at }), 'a genuine response from the claimed key VERIFIES')

const result = verifyAgentChallenge(challenge, good, { now: at })
check(result.agent_pubkey === agent && result.nonce === challenge.nonce, 'result names the proven identity and the nonce it answered')
check(result.response_id === good.id, 'result records WHICH event proved it, not merely that something did')
check(/^challenge signed .+Z, nonce .+…$/.test(challengeEvidence(result)), 'evidence states when the proof happened, not that it is currently true')

// ---- wrong key ------------------------------------------------------------------------------
// The whole point of the gate. This event is perfectly valid — just not from the claimed identity.
const byOther = respond(otherSk, challenge.nonce)
check(byOther.pubkey === other, 'precondition: the impostor response is genuinely signed, just by another key')
refuses(() => verifyAgentChallenge(challenge, byOther, { now: at }), 'refuses a VALID signature from a different key', 'different key')
allows(() => verifyAgentChallenge(challenge, good, { now: at }), 'PAIR: the claimed key still verifies')

// A challenge issued for the other identity accepts that identity's response — so the check is
// "matches the claimed key", not "only ever accepts this one agent".
const otherChallenge = createAgentChallenge(other, { now: at })
allows(() => verifyAgentChallenge(otherChallenge, respond(otherSk, otherChallenge.nonce), { now: at }),
  'PAIR: a different agent proves control of ITS own challenge')

// ---- wrong nonce ----------------------------------------------------------------------------
refuses(() => verifyAgentChallenge(challenge, respond(agentSk, second.nonce), { now: at }),
  'refuses the right key answering a DIFFERENT challenge (no replay of a harvested signature)', 'commit to exactly this challenge nonce')
allows(() => verifyAgentChallenge(second, respond(agentSk, second.nonce), { now: at }),
  'PAIR: that same response verifies against the challenge it actually answers')

// ---- domain separation ----------------------------------------------------------------------
refuses(() => verifyAgentChallenge(challenge, respond(agentSk, challenge.nonce, { kind: 27235 }), { now: at }),
  'refuses a NIP-98-kind event — a distinct kind is what stops cross-protocol replay', 'not an agent-challenge event')
refuses(() => verifyAgentChallenge(challenge, respond(agentSk, challenge.nonce, { tag: 'nonce' }), { now: at }),
  'refuses a response that omits the ceremony tag', 'commit to exactly this challenge nonce')
refuses(() => verifyAgentChallenge(challenge, respond(agentSk, challenge.nonce, { extra: [[AGENT_CHALLENGE_TAG, second.nonce]] }), { now: at }),
  'refuses a response carrying TWO ceremony tags (which nonce is authoritative must never be a read order)', 'commit to exactly this challenge nonce')
allows(() => verifyAgentChallenge(challenge, good, { now: at }), 'PAIR: the correct kind and exactly one tag verify')

// ---- tampering ------------------------------------------------------------------------------
refuses(() => verifyAgentChallenge(challenge, { ...good, content: 'edited' }, { now: at }),
  'refuses an event whose content was altered after signing', 'signature does not verify')
refuses(() => verifyAgentChallenge(challenge, { ...good, pubkey: agent, sig: 'f'.repeat(128) }, { now: at }),
  'refuses a forged signature', 'signature does not verify')
allows(() => verifyAgentChallenge(challenge, good, { now: at }), 'PAIR: the untampered event still verifies')
// The reconstruction drops unknown keys rather than rejecting them, so ordinary transport metadata
// must not break a legitimate response. Pairs with the two refusals above.
allows(() => verifyAgentChallenge(challenge, { ...good, receivedAt: 12345, relay: 'wss://example' }, { now: at }),
  'PAIR: extra transport metadata on an otherwise genuine response still verifies')

// ---- the value CHECKED must be the value VERIFIED --------------------------------------------
// A caller-supplied getter that answers differently on each read would otherwise let the nonce
// this module checks differ from the one it verifies a signature over.
const honest = respond(agentSk, challenge.nonce)
let reads = 0
const twoFaced = { id: honest.id, pubkey: honest.pubkey, created_at: honest.created_at,
  kind: honest.kind, content: honest.content, sig: honest.sig,
  get tags () { reads += 1; return reads === 1 ? [[AGENT_CHALLENGE_TAG, second.nonce]] : honest.tags } }
// Refused by the SIGNATURE, not by the nonce comparison — which is the proof the fix works. The
// snapshot feeds both checks, so the attacker's first-read nonce is also what gets verified, and
// it was never signed over. Before the snapshot existed, this response was accepted.
refuses(() => verifyAgentChallenge(second, twoFaced, { now: at }),
  'refuses a response whose tags answer differently on each read (checked value == verified value)', 'signature does not verify')
check(reads >= 1, 'precondition: the two-faced getter was actually consulted')
allows(() => verifyAgentChallenge(challenge, honest, { now: at }), 'PAIR: the same response, read honestly, verifies')

// The audit field must come from the verified snapshot, not from a second read of the caller.
let idReads = 0
const shiftyId = { pubkey: good.pubkey, created_at: good.created_at, kind: good.kind,
  tags: good.tags, content: good.content, sig: good.sig,
  get id () { idReads += 1; return idReads === 1 ? good.id : 'd'.repeat(64) } }
const shiftyResult = verifyAgentChallenge(challenge, shiftyId, { now: at })
check(shiftyResult.response_id === good.id, 'result.response_id is the id that was VERIFIED, not a later re-read')

// ---- prototype pollution cannot reintroduce the verification short-circuit --------------------
// nostr-tools' verifyEvent returns early when `typeof event[verifiedSymbol] === 'boolean'`, and
// that lookup resolves through the prototype chain.
const forged = { id: 'a'.repeat(64), pubkey: agent, created_at: AT, kind: AGENT_CHALLENGE_KIND,
  tags: [[AGENT_CHALLENGE_TAG, challenge.nonce]], content: 'I am not the agent', sig: 'b'.repeat(128) }
refuses(() => verifyAgentChallenge(challenge, forged, { now: at }), 'precondition: the forgery is refused normally', 'signature does not verify')
try {
  Object.prototype[verifiedSymbol] = true
  refuses(() => verifyAgentChallenge(challenge, forged, { now: at }),
    'refuses a forgery even with Object.prototype polluted with the verified marker', 'signature does not verify')
  allows(() => verifyAgentChallenge(challenge, good, { now: at }), 'PAIR: a genuine response still verifies under the same pollution')
} finally { delete Object.prototype[verifiedSymbol] }

// ---- expiry is judged at the verification boundary -------------------------------------------
// Approving a signing request is an unbounded human wait. A freshness check performed before that
// dialog opens is not a check at the boundary that matters.
const short = createAgentChallenge(agent, { now: at, ttlSeconds: 60 })
const shortResponse = respond(agentSk, short.nonce)
allows(() => verifyAgentChallenge(short, shortResponse, { now: () => AT + 59 }), 'verifies while still inside the window')
allows(() => verifyAgentChallenge(short, shortResponse, { now: () => AT + 60 }), 'verifies exactly ON the expiry second (boundary is inclusive)')
refuses(() => verifyAgentChallenge(short, shortResponse, { now: () => AT + 61 }), 'refuses one second past expiry — the same event, only the clock moved', 'expired')

// A challenge round-tripped through a store that drops undefined fields must not verify forever.
const { expires_at: _drop, ...noExpiry } = short
refuses(() => verifyAgentChallenge(noExpiry, shortResponse, { now: () => AT + 315_360_000 }),
  'refuses a challenge with no expiry (never "true forever" because a comparison against undefined is false)', 'usable expiry')
const { issued_at: _drop2, ...noIssued } = short
refuses(() => verifyAgentChallenge(noIssued, shortResponse, { now: at }), 'refuses a challenge with no issue time', 'usable issue time')
refuses(() => verifyAgentChallenge(short, shortResponse, { now: () => NaN }), 'refuses an unusable verifying clock (NaN comparisons are false)', 'verifying clock')
allows(() => verifyAgentChallenge(short, shortResponse, { now: at }), 'PAIR: the intact challenge and a usable clock still verify')

// ---- claimed signing time --------------------------------------------------------------------
refuses(() => verifyAgentChallenge(challenge, respond(agentSk, challenge.nonce, { created_at: 0 }), { now: at }),
  'refuses a response claiming the epoch as its signing time', 'outside the challenge window')
refuses(() => verifyAgentChallenge(challenge, respond(agentSk, challenge.nonce, { created_at: 2_000_000_000 }), { now: at }),
  'refuses a response claiming a far-future signing time', 'outside the challenge window')
allows(() => verifyAgentChallenge(challenge, respond(agentSk, challenge.nonce, { created_at: AT - 120 }), { now: at }),
  'PAIR: a response signed slightly early (ordinary clock skew) still verifies')

// ---- shape ----------------------------------------------------------------------------------
refuses(() => verifyAgentChallenge(null, good, { now: at }), 'refuses a missing challenge', 'challenge is required')
refuses(() => verifyAgentChallenge({ ...challenge, version: 99 }, good, { now: at }), 'refuses an unsupported challenge version', 'unsupported challenge version')
refuses(() => verifyAgentChallenge({ ...challenge, agent_pubkey: 'nope' }, good, { now: at }), 'refuses a challenge naming no usable identity', 'no usable identity')
refuses(() => verifyAgentChallenge({ ...challenge, nonce: '!' }, good, { now: at }), 'refuses a challenge carrying no usable nonce', 'no usable nonce')
refuses(() => verifyAgentChallenge(challenge, null, { now: at }), 'refuses a missing response', 'response is required')
refuses(() => verifyAgentChallenge(challenge, { ...good, tags: 'nope' }, { now: at }), 'refuses a response whose tags are not a list', 'no tags')
refuses(() => verifyAgentChallenge(challenge, { ...good, id: 'nope' }, { now: at }), 'refuses a response with no usable id', 'no usable id')
refuses(() => verifyAgentChallenge(challenge, { ...good, sig: 'nope' }, { now: at }), 'refuses a response with no usable signature', 'no usable signature')
refuses(() => verifyAgentChallenge(challenge, { ...good, created_at: 'soon' }, { now: at }), 'refuses a response with a non-integer created_at', 'no usable created_at')
refuses(() => verifyAgentChallenge(challenge, { ...good, content: 42 }, { now: at }), 'refuses a response whose content is not a string', 'content must be a string')
allows(() => verifyAgentChallenge(challenge, good, { now: at }), 'PAIR: a well-formed challenge and response still verify')

// ---- evidence rendering -----------------------------------------------------------------------
refuses(() => challengeEvidence(null), 'evidence refuses a missing result', 'not a verification result')
refuses(() => challengeEvidence({ agent_pubkey: 'nope', nonce: challenge.nonce, verified_at: AT }), 'evidence refuses a result naming no usable identity', 'not a verification result')
refuses(() => challengeEvidence({ agent_pubkey: agent, nonce: 42, verified_at: AT }), 'evidence refuses a result with an unusable nonce', 'no usable nonce')
refuses(() => challengeEvidence({ agent_pubkey: agent, nonce: challenge.nonce, verified_at: NaN }), 'evidence refuses a result with an unusable timestamp', 'no usable timestamp')
allows(() => challengeEvidence(result), 'PAIR: a genuine result renders evidence')

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
