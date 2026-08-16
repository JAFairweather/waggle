// adopt-identity.mjs — resolve the public key an operator NAMED, for the adopt path (#537).
//
// WHY THIS IS A MODULE. The console can prove custody of a `bunker://` URI, and #537 lets it do that
// for an identity the page did not mint. The whole safety of that rests on one decision: what the
// proof is pinned to. `bunker://<hex>` names the remote signer's TRANSPORT key, and NIP-46 permits
// that to differ from the identity it holds — so pinning to the URI's own hex is tautological, and
// would pass for any bunker that answers. The pin has to be the key the operator stated, resolved
// here rather than inline in a page, so it can be driven by a test in both directions.
//
// IT REFUSES A PRIVATE KEY BY TYPE, AND NEVER ECHOES ONE. An `nsec` pasted into a field asking for a
// public half is an operator error worth naming, and naming it must not put the value in a status
// line, the DOM, or a screenshot. The reason says which TYPE arrived and stops there.

/**
 * @param {string} raw an npub, or a 64-character hex pubkey
 * @param {{ decode: Function, npubEncode: Function }} nip19
 * @returns {{ok: true, pubkeyHex: string, npub: string} | {ok: false, reason: string}}
 */
export function resolveAdoptedPubkey(raw, nip19) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return { ok: false, reason: 'Give the identity — its npub, or its 64-character hex public key.' }

  // Hex first, and case-folded. A pubkey copied out of a manifest or a log arrives upper, lower or
  // mixed, and refusing one of those spellings of the same key is a refusal with no meaning behind it.
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    const pubkeyHex = text.toLowerCase()
    try {
      return { ok: true, pubkeyHex, npub: nip19.npubEncode(pubkeyHex) }
    } catch (e) {
      return { ok: false, reason: `that is 64 hex characters but not a usable public key (${e.message}).` }
    }
  }

  let decoded
  try {
    decoded = nip19.decode(text)
  } catch {
    // Deliberately does not quote the input. A malformed value here is as likely to be a mistyped
    // secret as a mistyped npub, and the two are indistinguishable at this point.
    return { ok: false, reason: 'that is not an npub or a 64-character hex public key. Never paste a private key here.' }
  }

  if (decoded.type !== 'npub') {
    return {
      ok: false,
      reason: `that is a ${decoded.type}, and this field takes a public key. ` +
        (decoded.type === 'nsec'
          ? 'A private key must never be pasted here — it was not read, kept, or shown.'
          : 'Give the identity\'s npub or its 64-character hex public key.'),
    }
  }

  const pubkeyHex = String(decoded.data || '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(pubkeyHex)) {
    return { ok: false, reason: 'that npub does not decode to a 64-character public key.' }
  }
  // Re-encoded rather than echoed back: what is displayed is then derived from the key that will
  // actually be pinned, so a value that round-trips differently cannot be shown as if it matched.
  return { ok: true, pubkeyHex, npub: nip19.npubEncode(pubkeyHex) }
}

/// The whole adopt decision, in one place a test can drive.
///
/// THE RESOLVER IS NOT THE DECISION — THE CALL SITE IS, and that is why this function exists.
/// `resolveAdoptedPubkey` was driven hard in both directions while the line that consumes it lived
/// inline in `index.html`, where the only available assertions were "the page imports the module"
/// and "the string appears". Both stay true when the pin is wrong: replacing
/// `expectedPubkeyHex: pubkeyHex` with the URI's own transport hex — the exact failure this path
/// exists to prevent — left the suite reporting 24 passed, 0 failed (#538 review).
///
/// So the pin is computed AND consumed here, with every collaborator injected. A test supplies a
/// pairing whose transport key deliberately differs from the identity being adopted, and the
/// tautological pin then fails outright instead of passing for any bunker that answers.
///
/// Returns a verdict rather than throwing, for the same reason `proveCustody` does: each refusal is
/// a different action for the operator, and `!ok` cannot tell them apart.
///
/// @param {{
///   rawKey: string, uri: string,
///   nip19: { decode: Function, npubEncode: Function },
///   openPairing: (uri: string) => Promise<{ signEvent: Function, close?: Function }>,
///   proveCustody: Function, verifyEvent: Function, nonce: string,
///   onResolved?: () => void,
/// }} deps
/// @returns {Promise<{ok: true, pubkeyHex: string, npub: string, signer: object, reason: string}
///                  | {ok: false, code: string, reason: string}>}
export async function proveAdoptedIdentity({
  rawKey, uri, nip19, openPairing, proveCustody, verifyEvent, nonce, onResolved,
}) {
  const key = String(rawKey == null ? '' : rawKey).trim()
  const bunkerUri = String(uri == null ? '' : uri).trim()
  if (!key) {
    return { ok: false, code: 'NO_KEY', reason: 'Give the identity being admitted — its npub, or its 64-hex public key.' }
  }
  if (!bunkerUri) {
    return { ok: false, code: 'NO_URI', reason: 'Paste the bunker:// URI that signs for that identity.' }
  }

  const resolved = resolveAdoptedPubkey(key, nip19)
  if (!resolved.ok) return { ok: false, code: 'BAD_KEY', reason: resolved.reason }
  const { pubkeyHex, npub } = resolved

  // ONLY ONCE THE INPUT IS GOOD. The page uses this to drop whatever identity it was holding, and
  // doing that on a typo would cost the operator a proved pairing to punish a misspelling.
  try { onResolved?.() } catch { /* the caller's own bookkeeping — never a reason to refuse */ }

  let paired = null
  try {
    paired = await openPairing(bunkerUri)
  } catch (e) {
    try { paired?.close?.() } catch { /* dropping it either way */ }
    return { ok: false, code: 'UNREACHABLE', reason: `Could not reach that bunker (${e && e.message ? e.message : e}). Nothing was adopted.` }
  }

  const verdict = await proveCustody({
    // THE PIN. Not `bunkerUri` — `bunker://<hex>` names the signer's TRANSPORT key, and NIP-46
    // permits that to differ from the identity it holds, so pinning to it would prove nothing and
    // pass for any bunker that answers.
    expectedPubkeyHex: pubkeyHex,
    sign: (event) => paired.signEvent(event),
    verifyEvent,
    nonce,
    keySource: 'adopted',
  })

  if (!verdict.proven) {
    // Dropped, never kept "in case" — same rule as the minted path. Keeping an unproven pairing is
    // how a signer that was NOT shown to hold this key ends up signing the claim that admits it.
    try { paired?.close?.() } catch { /* dropping it either way */ }
    return { ok: false, code: verdict.code, reason: verdict.reason }
  }

  return { ok: true, pubkeyHex, npub, signer: paired, reason: verdict.reason }
}
