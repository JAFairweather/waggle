// The custody proof (#367). Relay revocation is cooperative and a leave request cannot be
// pre-signed, so a key that cannot sign later is a relay member nobody can ever remove. The page
// therefore must not clear its copy of a freshly-minted key on anything less than a signature from
// the place that key now lives.
//
// Every case here is driven through REAL keys and the real vendored crypto — `finalizeEvent` and
// `verifyEvent` from the same bundle the page loads. A suite that stubbed the signature check would
// pass identically against a module that never checked one.
//
//   node tests/bunker_custody.mjs

import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { webcrypto } from 'node:crypto'
import {
  proveCustody, buildCustodyChallenge, custodyNonce, CUSTODY_CHALLENGE_KIND,
} from '../console/bunker-custody.mjs'

let fails = 0
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }

const agentSk = generateSecretKey(), agentPk = getPublicKey(agentSk)
const otherSk = generateSecretKey(), otherPk = getPublicKey(otherSk)
const NOW = 1_760_000_000

// A signer that behaves exactly like a bunker holding `sk`: it is handed an unsigned event and
// returns a real signature over it.
const bunkerHolding = (sk) => async (event) => finalizeEvent({ ...event, pubkey: getPublicKey(sk) }, sk)

// --- the nonce, before anything is concluded from a proof that uses one ------------------------
{
  const a = custodyNonce(b => webcrypto.getRandomValues(b))
  const b = custodyNonce(b => webcrypto.getRandomValues(b))
  ok('a nonce is 128 bits of hex', /^[0-9a-f]{32}$/.test(a))
  ok('…and two nonces differ, so the challenge is about THIS moment', a !== b)
}

// --- what actually goes out --------------------------------------------------------------------
// Asserted separately from what comes back: a challenge that quietly changed shape would otherwise
// only surface as a mismatch at the far end, where it reads as the bunker's fault.
{
  const c = buildCustodyChallenge({ expectedPubkeyHex: agentPk, nonce: 'a'.repeat(32), now: NOW })
  ok('the challenge names the key it is about', c.pubkey === agentPk)
  ok('…carries the nonce in a challenge tag', c.tags.some(t => t[0] === 'challenge' && t[1] === 'a'.repeat(32)))
  ok('…and is an EPHEMERAL kind, so a leaked one is not a durable artifact',
    c.kind === CUSTODY_CHALLENGE_KIND && c.kind >= 20000 && c.kind <= 29999)
  // Both of these were the natural things to reach for and both are replayable credentials: 22242
  // authenticates to a relay, 27235 authorises an HTTP request. Signing either as a liveness check
  // hands out a bearer token. Pinned so a future "tidy-up" cannot quietly pick one.
  ok('…and is NOT a NIP-42 auth or NIP-98 http-auth event', c.kind !== 22242 && c.kind !== 27235)

  let refused = null
  try { buildCustodyChallenge({ expectedPubkeyHex: agentPk, nonce: 'short', now: NOW }) } catch (e) { refused = e.message }
  ok('a nonce too short to be unguessable is refused, and the refusal says why',
    /nonce/.test(String(refused)) && /replayed/.test(String(refused)))
  refused = null
  try { buildCustodyChallenge({ expectedPubkeyHex: 'npub1notahexkey', nonce: 'a'.repeat(32), now: NOW }) } catch (e) { refused = e.message }
  ok('an npub where a hex pubkey belongs is refused before anything is signed', /hex pubkey/.test(String(refused)))
}

// --- DIRECTION 1: the bunker really does hold the key ------------------------------------------
// This runs first and is re-pinned at the end. Every refusal below is equally satisfied by a module
// that refuses everything, and that failure would strand the operator with a key they cannot clear.
{
  const v = await proveCustody({
    expectedPubkeyHex: agentPk, sign: bunkerHolding(agentSk), verifyEvent,
    nonce: custodyNonce(b => webcrypto.getRandomValues(b)), now: NOW,
  })
  ok('a bunker holding the minted key PROVES custody', v.proven === true && v.code === 'PROVEN')
  // The copy is the thing the operator acts on, so it is asserted like any other guard's reason.
  ok('…and the message says what it proves — a signer holds it NOW', /holds this key right now/.test(v.reason))
  ok('…and explicitly does NOT claim durability or exclusivity',
    /durable/.test(v.reason) && /no copy exists elsewhere/.test(v.reason))
}

// --- DIRECTION 2: the refusals. Each must refuse for its OWN reason ----------------------------
const nonce = () => custodyNonce(b => webcrypto.getRandomValues(b))

{
  // THE CASE THIS MODULE EXISTS FOR. An operator enrols the wrong key — their own, a previous
  // agent's, one from another tab — and gets a bunker that signs beautifully for something else.
  // Clearing on that would strand the minted key as an unremovable relay member.
  const v = await proveCustody({ expectedPubkeyHex: agentPk, sign: bunkerHolding(otherSk), verifyEvent, nonce: nonce(), now: NOW })
  ok('a bunker holding a DIFFERENT key does not prove custody', v.proven === false && v.code === 'WRONG_KEY')
  ok('…and the refusal names BOTH keys, so the operator can see which one they enrolled',
    v.reason.includes(otherPk.slice(0, 12)) && v.reason.includes(agentPk.slice(0, 12)))
  ok('…and says nothing has been cleared, because nothing has', /[Nn]othing has been cleared/.test(v.reason))
}
{
  // A signer that returns an event it did not sign. Until the signature verifies, `pubkey` is an
  // unauthenticated claim — a field any signer can set to anything.
  // 'e', not 'x': the nonce must be HEX, and buildCustodyChallenge refuses a non-hex one before the
  // signer is ever asked. The first draft of this fixture used 'x' and reported CHALLENGE_UNBUILDABLE
  // — a pass for a case it never ran, which is the whole reason each verdict has its own code.
  const forged = { kind: CUSTODY_CHALLENGE_KIND, created_at: NOW, tags: [['challenge', 'e'.repeat(32)]], content: '', pubkey: agentPk, id: '0'.repeat(64), sig: '0'.repeat(128) }
  const v = await proveCustody({ expectedPubkeyHex: agentPk, sign: async () => forged, verifyEvent, nonce: 'e'.repeat(32), now: NOW })
  ok('an event claiming the right pubkey but carrying a bad signature is refused',
    v.proven === false && v.code === 'SIGNATURE_INVALID')
  ok('…and the refusal tells the operator NOT to clear the key', /Do NOT clear the key/.test(v.reason))
}
{
  // A validly-signed event that is not the challenge. Real signature, real key, wrong question —
  // so it proves the key can sign SOMETHING, which is not what was asked.
  const stale = await bunkerHolding(agentSk)({ kind: CUSTODY_CHALLENGE_KIND, created_at: NOW - 9000, tags: [['challenge', 'b'.repeat(32)]], content: '' })
  const v = await proveCustody({ expectedPubkeyHex: agentPk, sign: async () => stale, verifyEvent, nonce: 'c'.repeat(32), now: NOW })
  ok('a validly-signed event carrying someone ELSE\'S nonce does not count — no replay',
    v.proven === false && v.code === 'CHALLENGE_TAMPERED')
}
{
  // Right key, right nonce, wrong KIND — a signer that swapped the challenge for a note. If this
  // passed, the check would happily accept a kind:1 the operator's key had signed at any point.
  const swapped = await bunkerHolding(agentSk)({ kind: 1, created_at: NOW, tags: [['challenge', 'd'.repeat(32)]], content: 'hello' })
  const v = await proveCustody({ expectedPubkeyHex: agentPk, sign: async () => swapped, verifyEvent, nonce: 'd'.repeat(32), now: NOW })
  ok('a validly-signed event of the WRONG KIND does not count either',
    v.proven === false && v.code === 'CHALLENGE_TAMPERED')
}
{
  const v = await proveCustody({ expectedPubkeyHex: agentPk, sign: async () => { throw new Error('bunker: timed out') }, verifyEvent, nonce: nonce(), now: NOW })
  ok('a bunker that never answers is UNAVAILABLE, not a verdict about the key',
    v.proven === false && v.code === 'SIGNER_UNAVAILABLE' && /timed out/.test(v.reason))
  // The ordering property, in the copy: a failure here is recoverable precisely because the page
  // still holds the key. The old flow had already destroyed its copy by this point.
  ok('…and it says the key is still in the page and nothing has been lost',
    /still in this page/.test(v.reason) && /nothing has been lost/i.test(v.reason))
}
{
  const v = await proveCustody({ expectedPubkeyHex: agentPk, sign: async () => null, verifyEvent, nonce: nonce(), now: NOW })
  ok('a signer that returns nothing at all is refused rather than treated as a pass',
    v.proven === false && v.code === 'SIGNER_UNAVAILABLE')
}
{
  const v = await proveCustody({ expectedPubkeyHex: 'not-a-key', sign: bunkerHolding(agentSk), verifyEvent, nonce: nonce(), now: NOW })
  ok('an unbuildable challenge fails before the signer is ever asked', v.proven === false && v.code === 'CHALLENGE_UNBUILDABLE')
}

// --- and the legitimate case ONE MORE TIME, at the end -----------------------------------------
// Everything above is equally satisfied by a module that returns `proven:false` unconditionally,
// and that module would look correct on every single assertion in this file except this one.
{
  const v = await proveCustody({ expectedPubkeyHex: agentPk, sign: bunkerHolding(agentSk), verifyEvent, nonce: nonce(), now: NOW + 3600 })
  ok('a genuine bunker STILL proves custody after all the refusals — the guard is selective',
    v.proven === true && v.code === 'PROVEN')
}

console.log(fails ? `\nBUNKER CUSTODY FAIL — ${fails}` : '\nBUNKER CUSTODY PASS — the page lets go of a key only on a signature from where it now lives')
process.exit(fails ? 1 : 0)
