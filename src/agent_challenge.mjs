// agent_challenge.mjs — proof that whoever holds an agent's connection can actually sign with
// that agent's key (#309). Pure and credential-free: this module issues a nonce and verifies a
// signature over it. It never signs, never opens a connection, and never decides what the proven
// identity is then allowed to do.
//
// The gate is identical for all three key-provenance doors (mint / bring-your-own / make-your-own),
// because provenance changes where the key was born and nothing about what counts as proof.
//
// CALLER OBLIGATION — single use. This module holds no state, so it cannot enforce it: a caller
// that verifies the same response twice will succeed twice. The caller MUST discard a challenge
// the moment it verifies, and MUST NOT accept a second response against it. This matters because
// AGENT_CHALLENGE_KIND sits in NIP-01's ephemeral range, which relays broadcast to subscribers —
// so within the TTL, anyone who observes a response could otherwise present it on their own
// connection as proof of controlling that key. Consuming the challenge on first success is what
// closes that window.
import { randomBytes } from 'node:crypto'
import { verifyEvent, verifiedSymbol } from 'nostr-tools/pure'

export const AGENT_CHALLENGE_VERSION = 1
// A kind of its own, not NIP-98's 27235. Sharing a kind with another authorization protocol would
// let an event signed for that protocol be replayed here as a control proof.
export const AGENT_CHALLENGE_KIND = 27492
// Domain separation on top of the distinct kind: the response must name this exact ceremony. A
// signature harvested from any other waggle surface therefore cannot be presented as a challenge
// response even if an attacker can induce the agent to sign.
export const AGENT_CHALLENGE_TAG = 'waggle-agent-challenge'
const DEFAULT_TTL_SECONDS = 300
// Tolerance on the signer's clock when judging the `created_at` a response claims.
const CREATED_AT_SKEW_SECONDS = 300

const HEX64 = /^[0-9a-f]{64}$/
// Same nonce shape the NIP-98 path already validates, so one convention covers both.
const NONCE = /^[A-Za-z0-9_-]{16,128}$/

const fail = message => { throw new Error(`agent-challenge: ${message}`) }

/**
 * Issue a challenge bound to one claimed identity. The nonce is generated here, so the remote party
 * cannot present a value it chose or replay one it has seen answered. The `nonce` option is a test
 * seam and nothing else: supplying a constant through it defeats the whole ceremony.
 */
export function createAgentChallenge(agentPubkey, {
  now = () => Math.floor(Date.now() / 1000),
  nonce = () => randomBytes(24).toString('base64url'),
  ttlSeconds = DEFAULT_TTL_SECONDS,
} = {}) {
  if (typeof agentPubkey !== 'string' || !HEX64.test(agentPubkey)) fail('agent pubkey must be 32-byte hex')
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) fail('ttl must be a positive integer')
  const issuedAt = now()
  if (!Number.isSafeInteger(issuedAt)) fail('issuing clock is not a usable integer')
  const value = nonce()
  if (typeof value !== 'string' || !NONCE.test(value)) fail('generated nonce is invalid')
  return Object.freeze({
    version: AGENT_CHALLENGE_VERSION,
    agent_pubkey: agentPubkey,
    nonce: value,
    issued_at: issuedAt,
    expires_at: issuedAt + ttlSeconds,
  })
}

// Copy tags into plain arrays of plain strings. The caller's object may expose `tags` (or any tag
// row) as a getter that answers differently on each read, which would let the value this module
// CHECKS differ from the value it VERIFIES. Everything downstream reads only this copy.
const plainTags = tags => {
  if (!Array.isArray(tags)) fail('response has no tags')
  return tags.map(row => {
    if (!Array.isArray(row)) return []
    return row.map(cell => (typeof cell === 'string' ? cell : null))
  })
}

const tagValue = (tags, name) => {
  const found = tags.filter(row => row[0] === name)
  // Exactly one. Two `waggle-agent-challenge` tags would let a response carry both the nonce it
  // was asked for and one it wasn't, and leave which is authoritative up to whoever reads first.
  if (found.length !== 1) return null
  return typeof found[0][1] === 'string' ? found[0][1] : null
}

/**
 * Verify a response against a challenge. Returns a frozen result on success; throws on any failure.
 *
 * `now` is read HERE rather than by the caller before it opened the signer. Approving a signing
 * request is an unbounded human wait, so a freshness check performed before that dialog is not a
 * check at the boundary that matters — the same reason `console/confirmed-fresh-signer.mjs` exists.
 */
export function verifyAgentChallenge(challenge, response, {
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (!challenge || typeof challenge !== 'object') fail('challenge is required')
  if (challenge.version !== AGENT_CHALLENGE_VERSION) fail('unsupported challenge version')
  if (!HEX64.test(String(challenge.agent_pubkey || ''))) fail('challenge names no usable identity')
  if (!NONCE.test(String(challenge.nonce || ''))) fail('challenge carries no usable nonce')
  if (!Number.isSafeInteger(challenge.issued_at)) fail('challenge has no usable issue time')
  if (!Number.isSafeInteger(challenge.expires_at)) fail('challenge has no usable expiry')

  if (!response || typeof response !== 'object' || Array.isArray(response)) fail('response is required')

  // Reconstruct FIRST, then check only the reconstruction. Two distinct hazards make this the
  // first act rather than a step before the signature check:
  //
  //  1. `verifyEvent` short-circuits on nostr-tools' `verifiedSymbol` — it returns the marker's
  //     value without re-checking the signature, and it also STAMPS that marker onto any object it
  //     inspects. Object spread copies enumerable own symbols, so `{...signed, content: 'edited'}`
  //     arrives pre-marked and verifies against content it was never signed over. A fresh literal
  //     carries no marker — and setting `verifiedSymbol` to `undefined` as an OWN property closes
  //     the same door from the other side, because the short-circuit tests `typeof … === 'boolean'`
  //     and resolves through the prototype chain, so a polluted `Object.prototype` would otherwise
  //     reintroduce it on an object of our own making. (A null prototype would also work, but
  //     nostr-tools' `validateEvent` does an `instanceof Object` check that such an object fails.)
  //  2. Any field read twice may answer differently each time if the caller supplies a getter. The
  //     value this function CHECKS must be the value it VERIFIES, so every later read — including
  //     the nonce and the id recorded in the result — comes from this snapshot and never from
  //     `response` again.
  const wire = { [verifiedSymbol]: undefined,
    id: response.id, pubkey: response.pubkey, created_at: response.created_at,
    kind: response.kind, tags: plainTags(response.tags), content: response.content, sig: response.sig }

  // Identity before signature: a valid signature by the wrong key is the interesting attack, and
  // saying "not the identity this connection claims" is more useful than "bad signature". It
  // discloses nothing — the remote party supplied the identity in the challenge it already holds.
  if (wire.pubkey !== challenge.agent_pubkey) {
    fail('response was signed by a different key than the one this connection claims')
  }
  if (wire.kind !== AGENT_CHALLENGE_KIND) fail('response is not an agent-challenge event')
  if (tagValue(wire.tags, AGENT_CHALLENGE_TAG) !== challenge.nonce) {
    fail('response does not commit to exactly this challenge nonce')
  }

  if (!HEX64.test(String(wire.id || ''))) fail('response has no usable id')
  if (typeof wire.sig !== 'string' || !/^[0-9a-f]{128}$/.test(wire.sig)) fail('response has no usable signature')
  if (!Number.isSafeInteger(wire.created_at)) fail('response has no usable created_at')
  if (typeof wire.content !== 'string') fail('response content must be a string')
  // Bound the claimed signing time. Not a replay defence — the nonce is ours and fresh, so no
  // pre-existing signature can carry it — but an event claiming to be signed in 33658 should not
  // become a stored proof, and waggle clamps timestamps everywhere else (gate A5).
  if (wire.created_at < challenge.issued_at - CREATED_AT_SKEW_SECONDS ||
      wire.created_at > challenge.expires_at + CREATED_AT_SKEW_SECONDS) {
    fail('response claims a signing time outside the challenge window')
  }

  // Signature last: it is the expensive check and the cheap ones have already excluded what they can.
  if (!verifyEvent(wire)) fail('response signature does not verify')

  // Expiry at the boundary, after the signature is known good: an expired-but-valid response is a
  // different fact from a forged one, and the caller may want to reissue rather than refuse.
  const checkedAt = now()
  if (!Number.isSafeInteger(checkedAt)) fail('verifying clock is not a usable integer')
  if (checkedAt > challenge.expires_at) fail('challenge expired before the response was verified')

  return Object.freeze({
    agent_pubkey: challenge.agent_pubkey,
    nonce: challenge.nonce,
    response_id: wire.id,
    verified_at: checkedAt,
  })
}

/**
 * The evidence line the console renders and the projection stores. Deliberately states when the
 * proof happened and what proved it, because a saved `passed` must never be read as "is currently
 * true" — #308 was exactly that failure.
 */
export function challengeEvidence(result) {
  if (!result || typeof result !== 'object') fail('not a verification result')
  if (!HEX64.test(String(result.agent_pubkey || ''))) fail('not a verification result')
  if (!NONCE.test(String(result.nonce || ''))) fail('verification result carries no usable nonce')
  if (!Number.isSafeInteger(result.verified_at)) fail('verification result has no usable timestamp')
  return `challenge signed ${new Date(result.verified_at * 1000).toISOString()}, nonce ${result.nonce.slice(0, 8)}…`
}
