// agent_challenge.mjs — the proof-of-control gate every agent-onboarding door converges on (#309).
//
// Drives the REAL createAgentChallenge + verifyAgentChallenge against synthetic signed events.
// The governing rule here is that a refusal assertion alone is worthless: a guard that rejects
// everything and a guard that rejects the dangerous thing fail identically under a one-sided test.
// That exact gap shipped a silent outage on 2026-08-01, so EVERY refusal below is paired with a
// legitimate value that must still get through.
//
// The properties that matter and their failure modes:
//   - a genuine response from the claimed key PASSES (the pair for every refusal);
//   - a valid signature by a DIFFERENT key is refused — else "prove control" proves nothing;
//   - a response to another nonce is refused — else a harvested signature replays forever;
//   - a foreign kind or a missing/duplicated domain tag is refused — else a signature obtained on
//     another waggle surface can be presented here as a control proof;
//   - expiry is judged when the response is VERIFIED, not when the signer was opened.
//
//   node tests/agent_challenge.mjs

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import {
  AGENT_CHALLENGE_KIND, AGENT_CHALLENGE_TAG,
  createAgentChallenge, verifyAgentChallenge, challengeEvidence,
} from '../src/agent_challenge.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const refuses = (fn, label) => { try { fn(); check(false, label + ' (no refusal)') } catch { check(true, label) } }
const allows = (fn, label) => { try { fn(); check(true, label) } catch (e) { check(false, `${label} — threw: ${e.message}`) } }

const agentSk = generateSecretKey(), agent = getPublicKey(agentSk)
const otherSk = generateSecretKey(), other = getPublicKey(otherSk)
const AT = 1_780_000_000
const at = () => AT

// A response as an honest agent would produce it.
const respond = (sk, nonce, { kind = AGENT_CHALLENGE_KIND, tag = AGENT_CHALLENGE_TAG, extra = [] } = {}) =>
  finalizeEvent({ kind, created_at: AT, tags: [[tag, nonce], ...extra], content: '' }, sk)

// ---- issuing --------------------------------------------------------------------------------
const challenge = createAgentChallenge(agent, { now: at })
check(challenge.agent_pubkey === agent, 'challenge binds the identity the connection claims')
check(challenge.expires_at > challenge.issued_at, 'challenge carries an expiry after its issue time')
check(Object.isFrozen(challenge), 'challenge is frozen — a caller cannot widen it after issue')

const second = createAgentChallenge(agent, { now: at })
check(second.nonce !== challenge.nonce, 'each challenge gets a fresh nonce (no reuse across issues)')

refuses(() => createAgentChallenge('not-a-pubkey', { now: at }), 'refuses a malformed identity at issue')
refuses(() => createAgentChallenge(agent, { now: at, nonce: () => 'short' }), 'refuses a nonce below the shared length floor')
refuses(() => createAgentChallenge(agent, { now: at, ttlSeconds: 0 }), 'refuses a non-positive ttl')
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
refuses(() => verifyAgentChallenge(challenge, byOther, { now: at }), 'refuses a VALID signature from a different key')
allows(() => verifyAgentChallenge(challenge, good, { now: at }), 'PAIR: the claimed key still verifies')

// A challenge issued for the other identity accepts that identity's response — so the check is
// "matches the claimed key", not "only ever accepts this one agent".
const otherChallenge = createAgentChallenge(other, { now: at })
allows(() => verifyAgentChallenge(otherChallenge, respond(otherSk, otherChallenge.nonce), { now: at }),
  'PAIR: a different agent proves control of ITS own challenge')

// ---- wrong nonce ----------------------------------------------------------------------------
refuses(() => verifyAgentChallenge(challenge, respond(agentSk, second.nonce), { now: at }),
  'refuses the right key answering a DIFFERENT challenge (no replay of a harvested signature)')
allows(() => verifyAgentChallenge(second, respond(agentSk, second.nonce), { now: at }),
  'PAIR: that same response verifies against the challenge it actually answers')

// ---- domain separation ----------------------------------------------------------------------
refuses(() => verifyAgentChallenge(challenge, respond(agentSk, challenge.nonce, { kind: 27235 }), { now: at }),
  'refuses a NIP-98-kind event — a distinct kind is what stops cross-protocol replay')
refuses(() => verifyAgentChallenge(challenge, respond(agentSk, challenge.nonce, { tag: 'nonce' }), { now: at }),
  'refuses a response that omits the ceremony tag')
refuses(() => verifyAgentChallenge(challenge, respond(agentSk, challenge.nonce, { extra: [[AGENT_CHALLENGE_TAG, second.nonce]] }), { now: at }),
  'refuses a response carrying TWO ceremony tags (which nonce is authoritative must never be a read order)')
allows(() => verifyAgentChallenge(challenge, good, { now: at }), 'PAIR: the correct kind and exactly one tag verify')

// ---- tampering ------------------------------------------------------------------------------
refuses(() => verifyAgentChallenge(challenge, { ...good, content: 'edited' }, { now: at }),
  'refuses an event whose content was altered after signing')
refuses(() => verifyAgentChallenge(challenge, { ...good, pubkey: agent, sig: 'f'.repeat(128) }, { now: at }),
  'refuses a forged signature')
allows(() => verifyAgentChallenge(challenge, good, { now: at }), 'PAIR: the untampered event still verifies')

// ---- expiry is judged at the verification boundary -------------------------------------------
// Approving a signing request is an unbounded human wait. A freshness check performed before that
// dialog opens is not a check at the boundary that matters.
const short = createAgentChallenge(agent, { now: at, ttlSeconds: 60 })
const shortResponse = respond(agentSk, short.nonce)
allows(() => verifyAgentChallenge(short, shortResponse, { now: () => AT + 59 }), 'verifies while still inside the window')
allows(() => verifyAgentChallenge(short, shortResponse, { now: () => AT + 60 }), 'verifies exactly ON the expiry second (boundary is inclusive)')
refuses(() => verifyAgentChallenge(short, shortResponse, { now: () => AT + 61 }), 'refuses one second past expiry — the same event, only the clock moved')

// ---- shape ----------------------------------------------------------------------------------
refuses(() => verifyAgentChallenge(null, good, { now: at }), 'refuses a missing challenge')
refuses(() => verifyAgentChallenge({ ...challenge, version: 99 }, good, { now: at }), 'refuses an unsupported challenge version')
refuses(() => verifyAgentChallenge(challenge, null, { now: at }), 'refuses a missing response')
refuses(() => verifyAgentChallenge(challenge, { ...good, tags: 'nope' }, { now: at }), 'refuses a response whose tags are not a list')
allows(() => verifyAgentChallenge(challenge, good, { now: at }), 'PAIR: a well-formed challenge and response still verify')

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
