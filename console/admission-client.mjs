// admission-client.mjs — the invite sequence, walked from a browser (#487).
//
// `tools/relay-invite.mjs` was the only way to admit an agent, so the connect flow dropped the
// operator into a terminal in the middle of a sequence that has no other command in it. This is the
// same sequence over the same decisions (`./relay-admission.mjs`) and the same signed envelope
// (`./nip98.mjs`) — the only difference is who holds the socket.
//
// TWO KEYS, TWO JOBS, and they must not be the same one:
//
//   * MINT is signed by the OPERATOR's key, which needs owner or admin in `relay_members`.
//   * CLAIM is signed by the AGENT's key, because the claim is what inserts THAT key's row. An
//     operator-signed claim admits the operator a second time and leaves the agent outside, and the
//     relay answers 200 to it — so nothing downstream would report the mistake.
//
// Each step takes its signer as an argument for exactly that reason: there is no ambient "the
// signer" here, so the caller cannot get the two confused by omission. `admissionPlan()` states the
// pairing in words for the page to render, because the operator is the one who has to notice.
//
// NOTHING IS CACHED. The invite code is a bearer secret and stays in the caller's memory for the
// life of the flow; this module never writes it to storage, a URL, or a log line. `mintOutcome`
// keeps it out of every message it builds for the same reason.
//
// CORS: `buzz-relay`'s router applies `CorsLayer::permissive()` when `BUZZ_CORS_ORIGINS` is empty
// and an allow-list when it is set (`crates/buzz-relay/src/router.rs:438`, read 2026-08-15). A
// browser blocked by that layer sees a TypeError with no status, which is indistinguishable from
// the relay being down — so `reachFailure()` names both possibilities rather than picking one.
import { expectedUrl, nip98Header, nip98Template } from './nip98.mjs'
import {
  MAX_SIGN_SKEW_SECS, NIP98_WINDOW_SECS, SIGN_TIMEOUT_MS,
  acceptOutcome, claimOutcome, mintOutcome, policyGate, policyReadVerdict,
} from './relay-admission.mjs'

/// Which key signs which call. Rendered on the page: the operator is the only one who can see that
/// the two pairings are the two they intended, and a mistake here is a 200 that admits nobody.
export const ADMISSION_PLAN = Object.freeze([
  Object.freeze({ step: 'mint', path: '/api/invites', signedBy: 'operator',
    why: 'minting needs owner or admin in relay_members, which is your key and not the agent\'s' }),
  Object.freeze({ step: 'accept-policy', path: '/api/invites/accept-policy', signedBy: 'agent',
    why: 'the receipt is tied to the key that will claim, so the acceptance has to come from that key' }),
  Object.freeze({ step: 'claim', path: '/api/invites/claim', signedBy: 'agent',
    why: 'the claim inserts the SIGNING key\'s relay_members row — sign it as yourself and you admit yourself again' }),
])

/// The message for a fetch that never got a status. Deliberately does not choose between the two
/// causes: a CORS block and an unreachable host are the same TypeError to a page, and guessing one
/// sends the operator to fix the wrong thing.
export function reachFailure(relayUrl, err) {
  const host = String(relayUrl || '').replace(/^[a-z]+:\/\//i, '').split('/')[0] || 'the relay'
  return `the browser could not complete the request to ${host} (${err?.message || err}). ` +
    'Two different things look like this and the browser cannot tell them apart: the relay is ' +
    'unreachable, or it answered and its CORS policy withheld the response from this page. Check ' +
    'BUZZ_CORS_ORIGINS on the relay before concluding it is down.'
}

// One signed POST. Returns `{ status, json, text }` — the exact shape every `*Outcome` reads — or
// throws with `.reach`/`.sign` set so the caller can tell a transport failure from a relay answer.
async function signedPost(relayUrl, path, bodyObj, sign, { fetchImpl = globalThis.fetch, now } = {}) {
  const url = expectedUrl(relayUrl, path)
  // The builder returns the body it hashed, and that same STRING is what gets sent. Re-serialising
  // between signing and sending signs one set of bytes and sends another; the relay refuses it as
  // "payload tag SHA-256 mismatch", which reads like a signing bug rather than a serialisation one.
  const { template, body } = await nip98Template({ url, method: 'POST', body: JSON.stringify(bodyObj) })
  const stamped = Number(template.created_at)
  let signed
  try { signed = await sign(template, { timeoutMs: SIGN_TIMEOUT_MS }) }
  catch (e) {
    const err = new Error(`the signer did not sign: ${e?.message || e}`)
    err.sign = true
    throw err
  }
  if (!signed?.sig) { const err = new Error('the signer returned an event with no signature'); err.sign = true; throw err }
  // How stale the signature is by the time we hold it — measured against the created_at that was
  // actually hashed, not against a fresh reading. A NIP-46 approval waits on a human, so this is
  // the browser's normal failure and it must not go out and come back as 401.
  const age = (now ? now() : Math.floor(Date.now() / 1000)) - stamped
  if (age > MAX_SIGN_SKEW_SECS) {
    const err = new Error(
      `the signature came back ${age}s after the request was stamped, and NIP-98 allows ` +
      `±${NIP98_WINDOW_SECS}s against the relay's clock. Nothing was sent — the relay would have ` +
      'refused it as stale and blamed the key. Approve the signing prompt more promptly and try again.')
    err.sign = true
    throw err
  }
  let res
  try { res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: nip98Header(signed) }, body }) }
  catch (e) { const err = new Error(reachFailure(relayUrl, e)); err.reach = true; throw err }
  const text = await res.text().catch(() => '')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: res.status, json, text }
}

/// Mint an invite. Signed by the OPERATOR — see ADMISSION_PLAN.
export async function mintInvite({ relayUrl, sign, ttlSecs, maxUses, fetchImpl, now }) {
  return mintOutcome(await signedPost(relayUrl, '/api/invites',
    { ttl_secs: Number(ttlSecs), max_uses: Number(maxUses) }, sign, { fetchImpl, now }))
}

/// Read the join policy. UNAUTHENTICATED — `/api/join-policy` takes no auth, and sending one would
/// invent a requirement the relay does not have. A transport failure is INCONCLUSIVE, not "none":
/// being unable to check is not the same as being fine.
export async function readPolicy({ relayUrl, fetchImpl = globalThis.fetch }) {
  const url = expectedUrl(relayUrl, '/api/join-policy')
  let res
  try { res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } }) }
  catch (e) {
    return { state: 'inconclusive', exitCode: 3, reason: reachFailure(relayUrl, e) }
  }
  const text = await res.text().catch(() => '')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return policyReadVerdict({ status: res.status, json })
}

/// Claim the invite. Signed by the AGENT.
///
/// `accepted` and `ageConfirmed` are what the OPERATOR stated, passed through as stated. They are
/// never derived from each other and never from what the policy requires — `policyGate` refuses in
/// both directions, and this function does not get a chance to soften that, because it asks the
/// gate before it opens a socket.
export async function claimInvite({ relayUrl, code, policy = null, accepted = false, ageConfirmed = false, sign, fetchImpl, now }) {
  const gate = policyGate({ policy, accepted, ageConfirmed })
  if (!gate.ok) {
    return { ok: false, gate: true, exitCode: 4, missing: gate.missing || [],
      reason: `not claiming — ${gate.reason}. Accepting a deployment's terms is your act, not this page's.` }
  }
  let policyReceipt = null
  if (gate.body) {
    const acc = acceptOutcome(await signedPost(relayUrl, '/api/invites/accept-policy',
      { code, ...gate.body }, sign, { fetchImpl, now }))
    if (!acc.ok) return acc
    policyReceipt = acc.receipt
  }
  const body = policyReceipt ? { code, policy_receipt: policyReceipt } : { code }
  const claimed = claimOutcome(await signedPost(relayUrl, '/api/invites/claim', body, sign, { fetchImpl, now }))
  if (!claimed.ok) return claimed
  // `proven: false` comes from claimOutcome and is carried, not overwritten. The relay now says this
  // key is a member; that is NOT the same as having watched it authenticate, and the difference has
  // cost this project days. The proof is a kind:0 from this key against the community relay, read
  // back cold — which is the step after this one, not this one.
  return { ...claimed, acceptedPolicy: policyReceipt !== null }
}
