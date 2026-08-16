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
