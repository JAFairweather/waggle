// scope-hash.mjs — the one construction, in one place.
//
// A NIP-DA grant never names its subject publicly. It carries a salted hash instead:
//
//     sha256( "waggle/da-scope/v1" || 0x00 || <subject> || <salt> )
//
// with a fresh 16-byte salt per grant, so two grants over the same subject are not linkable by
// anyone watching the relays.
//
// WHY THIS IS ITS OWN FILE. The construction was written out by hand in `tools/grant.mjs` (the
// issuer, node:crypto), in `console/index.html` (the reader, WebCrypto), and a third copy was
// about to be added by `console/connect.html`. Three hand-written copies of a hash construction
// is not a style problem — it is a correctness cliff with no guard rail at the bottom:
//
//   * if the ISSUER drifts, every grant it signs binds to a subject nothing can match. The grant
//     verifies. It is live. It admits nobody, forever, and the failure is silent on both sides.
//   * if a READER drifts, live grants stop resolving in that surface while remaining perfectly
//     valid everywhere else — so the console shows an agent as unadmitted when it is admitted.
//
// Neither failure produces an error. Both produce a hash, and one hash looks exactly like
// another. There is no test that can catch a drifted copy except one that compares the copies,
// which is what tests/scope_hash.mjs does — including against a hash taken from a grant that is
// live on the relays right now, because agreeing with ourselves is not the same as agreeing with
// what was already signed.
//
// The subject is a STRING and is hashed as its UTF-8 bytes exactly as given. It is a 64-hex
// pubkey for an agent scope and a lowercase uuid for a channel scope; `tools/grant.mjs`
// normalises npub → hex before it gets here, so callers must pass the normalised form. Passing an
// npub would hash the npub, produce a valid-looking grant, and match nothing.

const LABEL = 'waggle/da-scope/v1'

const hexToBytes = (hex) => {
  const s = String(hex || '')
  if (s === '') return new Uint8Array(0)
  if (!/^([0-9a-f]{2})+$/i.test(s)) throw new Error('salt must be an even-length hex string')
  return Uint8Array.from(s.match(/../g).map(h => parseInt(h, 16)))
}
const bytesToHex = (bytes) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')

/**
 * The scope hash for a subject under a salt.
 *
 * subject: 64-hex pubkey (agent) or lowercase uuid (channel), as a string
 * saltHex: hex salt, 16 bytes in every grant this project issues
 *
 * `digest` is injectable only so the suite can prove the byte layout independently of WebCrypto;
 * production callers never pass it.
 */
export async function scopeHash(subject, saltHex, { digest } = {}) {
  const enc = new TextEncoder()
  const salt = hexToBytes(saltHex)
  const prefix = enc.encode(LABEL)
  const subj = enc.encode(String(subject))
  const buf = new Uint8Array(prefix.length + 1 + subj.length + salt.length)
  buf.set(prefix, 0)
  buf[prefix.length] = 0
  buf.set(subj, prefix.length + 1)
  buf.set(salt, prefix.length + 1 + subj.length)
  if (digest) return bytesToHex(await digest(buf))
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
}

// The exact byte layout, exported so a test can assert it without re-deriving it — and so a
// reviewer can see what is hashed without reading the packing arithmetic.
export function scopePreimage(subject, saltHex) {
  const enc = new TextEncoder()
  const salt = hexToBytes(saltHex)
  const prefix = enc.encode(LABEL)
  const subj = enc.encode(String(subject))
  const buf = new Uint8Array(prefix.length + 1 + subj.length + salt.length)
  buf.set(prefix, 0)
  buf[prefix.length] = 0
  buf.set(subj, prefix.length + 1)
  buf.set(salt, prefix.length + 1 + subj.length)
  return buf
}

export const SCOPE_LABEL = LABEL
