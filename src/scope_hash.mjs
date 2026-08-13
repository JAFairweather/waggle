// scope_hash.mjs — the one node-side construction (#328).
//
// A NIP-DA grant never names its subject publicly. It carries a salted hash instead:
//
//     sha256( "waggle/da-scope/v1" || 0x00 || <subject> || <salt> )
//
// with a fresh 16-byte salt per grant, so two grants over the same subject are not linkable by
// anyone watching the relays.
//
// WHY THIS FILE EXISTS. Five node copies wrote that preimage out by hand:
//
//     tools/grant.mjs:168 (issue) and :217 (verify), tools/mint-consent.mjs:87,
//     tools/propose-admission.mjs:59, src/bridge.mjs:835
//
// Both drift directions are silent and both still produce a hash. If the ISSUER drifts, every
// grant it signs binds to a subject nothing can match — it verifies, it goes live, it admits
// nobody, forever. If a READER drifts, live grants stop resolving in that surface while remaining
// valid everywhere else, so a console shows an admitted agent as unadmitted. Neither raises an
// error, and one hash looks exactly like another.
//
// WHY NOT ONE FILE FOR THE WHOLE PROJECT. `console/scope-hash.mjs` is the browser copy and cannot
// be collapsed into this one: the deploy ship list is `src tests tools …` and does NOT include
// `console/` (deploy/deploy-runner.sh:63, deploy/deploy.sh:36), so shipped code importing from
// there would fail to load on the box with ERR_MODULE_NOT_FOUND. It is also the wrong direction —
// nothing under `src/` is served to a browser. So the project keeps two copies on purpose, the
// same arrangement `console/consent-vocabulary.mjs` documents, and `tests/scope_hash.mjs` holds
// them together by comparing both against a longhand third construction and against a hash taken
// from a grant that is live on the relays. Six hand-written copies became two that a test binds.
import { createHash } from 'node:crypto'

const LABEL = 'waggle/da-scope/v1'

// Deliberately NOT `Buffer.from(saltHex, 'hex')`, which is what the five copies used. That decodes
// as much as it can and silently drops the rest, so '', 'zz' and 'ZZZZ' all became zero bytes and
// hashed IDENTICALLY — while console/scope-hash.mjs threw on two of the three. A grant carrying
// such a salt was resolvable by the bridge and unresolvable by the console, with no error on
// either side. Matching the console's stricter rule is the behaviour change #328 asked for.
const hexToBytes = (hex) => {
  const s = String(hex || '')
  if (s === '') return new Uint8Array(0)
  if (!/^([0-9a-f]{2})+$/i.test(s)) throw new Error('salt must be an even-length hex string')
  return Uint8Array.from(s.match(/../g).map(h => parseInt(h, 16)))
}

// The exact byte layout. The subject is hashed as its UTF-8 bytes exactly as given: a 64-hex
// pubkey for an agent scope, a lowercase uuid for a channel scope. Callers must pass the
// normalised form — `tools/grant.mjs` decodes npub → hex before it gets here, and passing an npub
// would hash the npub, produce a valid-looking grant, and match nothing.
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

// Synchronous, unlike the console's, which hashes through WebCrypto to stay browser-safe. Every
// node caller here is synchronous and two of them sit inside filters, so they cannot await.
export const scopeHashSync = (subject, saltHex) =>
  createHash('sha256').update(scopePreimage(subject, saltHex)).digest('hex')

// For the two callers whose salt arrives OVER THE WIRE — `tools/grant.mjs list --agent/--channel`
// and the bridge's grant handler — where a malformed salt is ordinary hostile input rather than a
// bug in our own code. There it must mean "this grant matches nothing", never an exception thrown
// out of a filter or an event handler. A grant whose salt nobody can decode binds to no subject,
// so no-match is the correct answer and not merely the safe one.
export const scopeHashOrNull = (subject, saltHex) => {
  try { return scopeHashSync(subject, saltHex) } catch { return null }
}

export const SCOPE_LABEL = LABEL
