// agent_challenge.mjs — proof that whoever holds an agent's connection can actually sign with
// that agent's key (#309). Pure and credential-free: this module issues a nonce and verifies a
// signature over it. It never signs, never opens a connection, and never decides what the proven
// identity is then allowed to do.
//
// The gate is identical for all three key-provenance doors (mint / bring-your-own / make-your-own),
// because provenance changes where the key was born and nothing about what counts as proof.
import { randomBytes } from 'node:crypto'
import { verifyEvent } from 'nostr-tools/pure'

export const AGENT_CHALLENGE_VERSION = 1
// A kind of its own, not NIP-98's 27235. Sharing a kind with another authorization protocol would
// let an event signed for that protocol be replayed here as a control proof.
export const AGENT_CHALLENGE_KIND = 27492
// Domain separation on top of the distinct kind: the response must name this exact ceremony. A
// signature harvested from any other waggle surface therefore cannot be presented as a challenge
// response even if an attacker can induce the agent to sign.
export const AGENT_CHALLENGE_TAG = 'waggle-agent-challenge'
const DEFAULT_TTL_SECONDS = 300

const HEX64 = /^[0-9a-f]{64}$/
// Same nonce shape the NIP-98 path already validates, so one convention covers both.
const NONCE = /^[A-Za-z0-9_-]{16,128}$/

const fail = message => { throw new Error(`agent-challenge: ${message}`) }

/**
 * Issue a challenge bound to one claimed identity. The nonce is generated here so a caller cannot
 * present a value it chose, or replay one it has seen answered before.
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

const tagValue = (event, name) => {
  const found = event.tags.filter(tag => Array.isArray(tag) && tag[0] === name)
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
  if (!Number.isSafeInteger(challenge.expires_at)) fail('challenge has no usable expiry')

  if (!response || typeof response !== 'object' || Array.isArray(response)) fail('response is required')
  if (!Array.isArray(response.tags)) fail('response has no tags')

  // Identity before signature: a valid signature by the wrong key is the interesting attack, and
  // saying "not the identity this connection claims" is more useful than "bad signature".
  if (response.pubkey !== challenge.agent_pubkey) {
    fail('response was signed by a different key than the one this connection claims')
  }
  if (response.kind !== AGENT_CHALLENGE_KIND) fail('response is not an agent-challenge event')
  if (tagValue(response, AGENT_CHALLENGE_TAG) !== challenge.nonce) {
    fail('response does not commit to exactly this challenge nonce')
  }

  // Signature last, because it is the expensive check and the cheap ones have already excluded
  // everything they can.
  //
  // Verify a RECONSTRUCTED wire event, never the caller's object. nostr-tools stamps a
  // `verifiedSymbol` on events it has already checked and short-circuits on it — and object spread
  // copies enumerable own symbol properties. So `{...signed, content: 'edited'}` arrives carrying a
  // stale "already verified" marker and passes `verifyEvent` without the signature ever being
  // re-checked against the altered content. Rebuilding from the seven wire fields drops the marker
  // and rejects any extra key in the same step.
  const wire = { id: response.id, pubkey: response.pubkey, created_at: response.created_at,
    kind: response.kind, tags: response.tags, content: response.content, sig: response.sig }
  if (!HEX64.test(String(wire.id || ''))) fail('response has no usable id')
  if (typeof wire.sig !== 'string' || !/^[0-9a-f]{128}$/.test(wire.sig)) fail('response has no usable signature')
  if (!Number.isSafeInteger(wire.created_at)) fail('response has no usable created_at')
  if (typeof wire.content !== 'string') fail('response content must be a string')
  if (!verifyEvent(wire)) fail('response signature does not verify')

  // Expiry at the boundary, after the signature is known good: an expired-but-valid response is a
  // different fact from a forged one, and the caller may want to reissue rather than refuse.
  const checkedAt = now()
  if (!Number.isSafeInteger(checkedAt)) fail('verifying clock is not a usable integer')
  if (checkedAt > challenge.expires_at) fail('challenge expired before the response was verified')

  return Object.freeze({
    agent_pubkey: challenge.agent_pubkey,
    nonce: challenge.nonce,
    response_id: response.id,
    verified_at: checkedAt,
  })
}

/**
 * The evidence line the console renders and the projection stores. Deliberately states when the
 * proof happened and what proved it, because a saved `passed` must never be read as "is currently
 * true" — #308 was exactly that failure.
 */
export function challengeEvidence(result) {
  if (!result || !HEX64.test(String(result.agent_pubkey || ''))) fail('not a verification result')
  return `challenge signed ${new Date(result.verified_at * 1000).toISOString()}, nonce ${result.nonce.slice(0, 8)}…`
}
