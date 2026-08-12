// Proving that a bunker has taken custody of a key, before the page lets go of it (#367).
//
// WHY THIS EXISTS AT ALL. Relay revocation is cooperative: a leave request must be signed by the
// leaving key itself and cannot be pre-signed (it carries a ±120s freshness window). So **a key
// that cannot sign later is a relay member nobody can ever remove** — not by the owner, not by
// waggle, not by the operator. Custody stopped being a convenience question the moment that became
// true. It decides whether a row is reversible.
//
// The flow this serves mints in the page, has the operator enrol the secret in their bunker, and
// then clears its own copy. The dangerous step is the last one, and the question it turns on is
// "did the key survive?". The old answer was "the download did not throw", which is not evidence:
// a blocked or discarded download throws nothing at all. The answer here is a SIGNATURE FROM THE
// PLACE THE KEY NOW LIVES — cold proof rather than an acknowledgement, which is this repo's rule
// everywhere else.
//
// Ordering is the other half. The proof runs while the page STILL HOLDS the key, so a failure is
// recoverable: the operator fixes the pairing and tries again. The previous flow had already
// destroyed its copy by the time anything could go wrong.
//
// WHAT A PASS ACTUALLY MEANS, stated because it is narrower than it sounds: some signer reachable
// at that bunker URI holds the private half of this exact pubkey, right now. It does not prove the
// bunker will still be reachable tomorrow, that its own storage is durable, or that nobody else
// holds a copy. Those are not knowable from here and the copy must not imply them.

const HEX64_RE = /^[0-9a-f]{64}$/

// An ephemeral, unassigned kind. THREE independent reasons, because the failure this guards against
// is a challenge event escaping and being useful to whoever catches it:
//
//   1. It is never transmitted. It is signed by the bunker and compared in this page; no relay is
//      ever handed it. That is the actual defence.
//   2. Kinds in the 20000-29999 range are ephemeral — relays do not store them — so a leak does not
//      become a durable artifact.
//   3. It is not kind:22242 (NIP-42 AUTH) and not kind:27235 (NIP-98 HTTP auth), both of which were
//      the obvious things to reach for and both of which are REPLAYABLE CREDENTIALS: one
//      authenticates to a relay, the other authorises an HTTP request. Signing either as a
//      liveness check hands out a bearer token to prove the key is alive.
export const CUSTODY_CHALLENGE_KIND = 20000

/// Build the exact event the bunker is asked to sign. Pure and separately exported, so a test can
/// assert what goes OUT as well as what comes back — a challenge that quietly changed shape would
/// otherwise only be visible as a mismatch at the far end.
export function buildCustodyChallenge({ expectedPubkeyHex, nonce, now }) {
  const pk = String(expectedPubkeyHex || '').toLowerCase()
  if (!HEX64_RE.test(pk)) throw new Error('custody: expected a 64-character hex pubkey to prove custody OF')
  if (!/^[0-9a-f]{32,}$/.test(String(nonce || ''))) throw new Error('custody: the challenge needs a random nonce of at least 128 bits, or a replayed signature would pass')
  const created = Number(now)
  if (!Number.isFinite(created)) throw new Error('custody: the challenge needs a numeric created_at')
  return {
    kind: CUSTODY_CHALLENGE_KIND,
    created_at: Math.floor(created),
    // The nonce is what makes this proof about THIS moment. Without it an old signed challenge —
    // from a previous run, a screenshot, a different agent's enrolment — would satisfy the check.
    tags: [['challenge', String(nonce)]],
    content: 'waggle console: proving this bunker holds the key it was enrolled with. Not published anywhere.',
    pubkey: pk,
  }
}

/// Ask the signer to sign the challenge and decide whether custody is proven.
///
/// Returns a verdict rather than throwing, because every branch here is something the operator has
/// to READ and act on, and they are four different actions: fix the pairing, enrol the right key,
/// distrust the signer, try again. `!ok` cannot tell those apart, and a refusal whose reason is
/// wrong sends someone hunting in the wrong place.
export async function proveCustody({ expectedPubkeyHex, sign, verifyEvent, nonce, now = Date.now() / 1000 }) {
  let challenge
  try {
    challenge = buildCustodyChallenge({ expectedPubkeyHex, nonce, now })
  } catch (e) {
    return { proven: false, code: 'CHALLENGE_UNBUILDABLE', reason: e.message }
  }
  const want = String(expectedPubkeyHex).toLowerCase()

  let signed
  try {
    signed = await sign(challenge)
  } catch (e) {
    return {
      proven: false,
      code: 'SIGNER_UNAVAILABLE',
      reason: `the bunker did not answer (${e && e.message ? e.message : e}). The key is still in this page — fix the pairing and try again; nothing has been lost.`,
    }
  }
  if (!signed || typeof signed !== 'object') {
    return { proven: false, code: 'SIGNER_UNAVAILABLE', reason: 'the bunker returned nothing to check. The key is still in this page.' }
  }

  // Signature FIRST. Until this passes, `signed.pubkey` is an unauthenticated claim — a field any
  // signer can set to anything — so comparing it before verifying would be comparing a string a
  // broken or hostile signer chose. The relay-invite path learned this the same way (#365).
  let verified = false
  try { verified = !!verifyEvent(signed) } catch { verified = false }
  if (!verified) {
    return {
      proven: false,
      code: 'SIGNATURE_INVALID',
      reason: 'the signer returned an event whose signature does not verify, so there is no way to tell which key it came from. Do NOT clear the key from this page.',
    }
  }

  // The signature is valid — but valid for WHAT? A signer can hold a perfectly good key and sign a
  // perfectly good event that is not the one we asked about. Compare the challenge back.
  const gotNonce = (signed.tags || []).find(t => Array.isArray(t) && t[0] === 'challenge')?.[1]
  if (String(gotNonce || '') !== String(nonce) || Number(signed.kind) !== CUSTODY_CHALLENGE_KIND) {
    return {
      proven: false,
      code: 'CHALLENGE_TAMPERED',
      reason: 'the signer returned a validly-signed event that is not the challenge it was given, so this proves nothing about the key we asked about. Do NOT clear the key from this page.',
    }
  }

  const got = String(signed.pubkey || '').toLowerCase()
  if (got !== want) {
    // The case this whole module exists for. An operator who enrols the wrong key — their own, a
    // previous agent's, one from another tab — gets a bunker that signs beautifully for something
    // else. Clearing here would strand the minted key as an unremovable relay member.
    return {
      proven: false,
      code: 'WRONG_KEY',
      reason: `this bunker holds a DIFFERENT key: it signed as ${got.slice(0, 12)}… but the key made here is ${want.slice(0, 12)}…. Enrol the key this page made, not another one. Nothing has been cleared.`,
    }
  }

  return {
    proven: true,
    code: 'PROVEN',
    // Says what it proves and no more. "The bunker has your key safe" would be a claim about
    // durability and exclusivity that nothing here established.
    reason: `the bunker signed as ${want.slice(0, 12)}… — some signer reachable at that URI holds this key right now. It cannot tell you the bunker's own storage is durable, or that no copy exists elsewhere.`,
    signedAt: Number(signed.created_at) || null,
  }
}

/// A nonce, from the platform CSPRNG. Separate so the page cannot accidentally pass a counter, and
/// so a test can inject a known value without stubbing global crypto.
export function custodyNonce(getRandomValues) {
  const bytes = new Uint8Array(16)
  getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}
