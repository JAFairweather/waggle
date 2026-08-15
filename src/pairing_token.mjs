// pairing_token.mjs — the artifact that turns an approved join request into a working session,
// without the credential ever passing through a chat window (#489).
//
// WHY THIS EXISTS. `docs/DESIGN_JOIN.md` ends with a session that has been approved and still
// cannot act: `tools/join.mjs` emits the request, waits, and burns the request key, and its own
// closing line says pairing "is not built yet". The obvious way to finish it — paste the
// `bunker://` URI into the prompt the operator hands the new session — is the one route this
// project forbids outright. A pairing URI is a credential; `src/agent_startup.mjs` fails closed on
// exactly that shape, and it should. So the pairing has to arrive sealed, addressed to a key only
// the requesting session holds.
//
// THE TWO KEYS, because the whole design rests on them being different things:
//
//   R — the request key. Minted in the session, signs the join request, receives THIS token, then
//       burned. Never granted anything, never in the roster. Its only job is to be an address the
//       owner can reply to, once.
//   A — the agent identity. Lives in the owner's bunker and never in the session at all. What
//       crosses is a NIP-46 pairing to A, which is revocable; the key itself does not move.
//
// So this module carries a credential on purpose, and every rule below follows from that:
//
//   1. THE PLAINTEXT IS NEVER RETURNED AS A PLAIN FIELD. `readPairingToken` hands back a take-once
//      container, the same shape `console/mint-agent-key.mjs` uses for a freshly minted nsec. A
//      value that can be read twice is a value that ends up in a log line the second time.
//   2. BOUND TO THE REQUEST. The token names the request id it answers. A session that asked in
//      request X must not be paired by a token minted for request Y — otherwise one owner
//      approval releases a pairing that any listener holding any request key can spend.
//   3. BOUND TO THE IDENTITY THE OWNER APPROVED. The token names A. Opening it does not prove the
//      bunker actually controls A — only a signature does — so this module returns the expected
//      pubkey and says so, and the caller runs the challenge before writing anything to disk.
//      Possession of a URI is not control; that is the one gate in
//      `docs/DESIGN_AGENT_LIFECYCLE_PLANE.md` and this module must not appear to satisfy it.
//   4. AN NSEC IS REFUSED BY NAME. The dangerous slip is an owner pasting the identity's secret
//      where the pairing goes: it works, so nothing would report it, and it silently converts the
//      design into the one it exists to prevent — a session holding a key rather than a pairing.
//      It gets its own refusal, because "not a valid pairing URI" would send them looking for a
//      typo in the thing they should not have pasted at all.
//
// This module holds no crypto. Sealing is the caller's, as it is in `join_request.mjs`, so the
// same code can be exercised in node against synthetic values and in a browser against a signer.

/** Ephemeral range, alongside the join request (27493) and the challenge kind. */
export const PAIRING_TOKEN_KIND = 27494

const HEX64 = /^[0-9a-f]{64}$/
/** A NIP-46 pairing URI, and nothing else that could be mistaken for one. */
const PAIRING_URI = /^bunker:\/\/[0-9a-f]{64}(\?[^\s]*)?$/i
const NSEC = /^nsec1[02-9ac-hj-np-z]+$/i
const NCRYPTSEC = /^ncryptsec1[02-9ac-hj-np-z]+$/i

/** The only keys a token body may carry. A pairing token is not an extension point. */
const BODY_KEYS = ['v', 'rid', 'a', 'uri', 'exp']

/** Why this string is not a pairing URI — the shape, not just the fact. */
export function pairingUriFault(value) {
  const v = String(value ?? '')
  if (!v) return 'no pairing URI'
  // Named before the generic refusal, and named for what it IS. See rule 4 above.
  if (NSEC.test(v)) return 'that is an nsec, not a pairing — the session must hold a pairing to the identity, never the identity itself'
  if (NCRYPTSEC.test(v)) return 'that is an encrypted nsec, not a pairing — the session must hold a pairing to the identity, never the identity itself'
  if (/^nostrconnect:\/\//i.test(v)) return 'that is a nostrconnect:// URI — it points the other way, from signer to client, and cannot be handed to a session'
  if (!/^bunker:\/\//i.test(v)) return 'not a bunker:// pairing URI'
  return 'a bunker:// URI must name a 64-hex remote signer key'
}

/**
 * The body an owner seals to R once they have approved the request.
 *
 * Returns the JSON string to seal. It is a credential from the moment it exists: seal it, and do
 * not log it, render it, or write it anywhere on the way.
 */
export function buildPairingToken({ requestId, identityPubkey, pairingUri, expiresAt }) {
  const rid = String(requestId || '').toLowerCase()
  if (!HEX64.test(rid)) throw new Error('a pairing token must name the 64-hex request it answers')
  const a = String(identityPubkey || '').toLowerCase()
  if (!HEX64.test(a)) throw new Error('a pairing token must name the 64-hex identity it pairs to')
  const uri = String(pairingUri ?? '')
  if (!PAIRING_URI.test(uri)) throw new Error(`refusing to seal a pairing token: ${pairingUriFault(uri)}`)
  if (!Number.isFinite(expiresAt)) throw new Error('a pairing token must expire — an unbounded one is a standing credential')
  return JSON.stringify({ v: 1, rid, a, uri, exp: Math.floor(expiresAt) })
}

/**
 * Open a token that arrived sealed to R. `plaintext` is already decrypted by the caller.
 *
 * `requestId` is the id THIS session actually sent, not one read out of the token — checking a
 * token against a value it supplied itself would check nothing.
 *
 * @returns {{ok: true, identityPubkey: string, expiresAt: number, pairing: {take(): string|null, taken(): boolean, forget(): void}}
 *          | {ok: false, reason: string}}
 */
export function readPairingToken(plaintext, { requestId, now = Math.floor(Date.now() / 1000) } = {}) {
  const rid = String(requestId || '').toLowerCase()
  if (!HEX64.test(rid)) return { ok: false, reason: 'readPairingToken needs the 64-hex request id this session sent' }
  if (typeof plaintext !== 'string' || plaintext === '') return { ok: false, reason: 'pairing token is not text' }

  let body
  try { body = JSON.parse(plaintext) } catch { return { ok: false, reason: 'pairing token is not valid JSON' } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'pairing token is not an object' }

  // Refuse unknown keys rather than ignore them. A field this module does not understand, sitting
  // in an artifact that carries a credential, is something a future reader will treat as meaningful.
  const extra = Object.keys(body).filter(k => !BODY_KEYS.includes(k))
  if (extra.length) return { ok: false, reason: `pairing token carries fields this build does not understand: ${extra.sort().join(', ')}` }
  if (body.v !== 1) return { ok: false, reason: `pairing token version ${JSON.stringify(body.v)} is not 1` }

  // Rule 2. The refusal does not echo the token's own rid: it is attacker-supplied, and this
  // message is the one a person reads.
  const claimed = String(body.rid || '').toLowerCase()
  if (!HEX64.test(claimed)) return { ok: false, reason: 'pairing token names no request' }
  if (claimed !== rid) return { ok: false, reason: 'pairing token answers a different join request than this session sent' }

  const a = String(body.a || '').toLowerCase()
  if (!HEX64.test(a)) return { ok: false, reason: 'pairing token names no 64-hex identity' }

  const uri = String(body.uri ?? '')
  if (!PAIRING_URI.test(uri)) return { ok: false, reason: `pairing token does not carry a pairing: ${pairingUriFault(uri)}` }

  if (!Number.isFinite(body.exp)) return { ok: false, reason: 'pairing token has no expiry' }
  // Expired and not-yet-valid are the same refusal here on purpose — a token is minted at the
  // moment of approval and spent seconds later, so a future-dated one is not a clock skew story,
  // it is a token that was not minted by this ceremony.
  if (now >= body.exp) return { ok: false, reason: 'pairing token has expired — ask the owner to approve again' }

  // Rule 1. Take-once, and the URI never leaves this closure any other way.
  let held = uri
  return {
    ok: true,
    identityPubkey: a,
    expiresAt: body.exp,
    // NOT proof. Named so that a caller reading this at the call site is told what is still owed.
    custodyUnproven: true,
    pairing: {
      take() { const v = held; held = null; return v },
      taken() { return held === null },
      forget() { held = null },
    },
  }
}
