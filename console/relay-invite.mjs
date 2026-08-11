// Letting an agent onto the community relay, from the console (#357).
//
// WHY IT IS TWO CALLS AND ONE FUNCTION. An agent's `@Name` only resolves if the agent's own key has
// published a kind:0 to the community relay, and the relay refuses that key at NIP-42 AUTH until it
// is in `relay_members` (#344). Buzz's invite routes are the supported way in: the owner mints
// (`POST /api/invites`, owner/admin only) and the agent claims (`POST /api/invites/claim`, which is
// deliberately exempt from the membership gate and inserts the row the AUTH gate reads).
//
// Between those two calls sits a **bearer secret**. Anyone holding the invite code can join this
// relay. So the code is created, used and dropped inside this one function: it is never returned,
// never rendered, never stored, and never logged. The result object has no field that could carry
// it, which is what makes that a property rather than a promise — a caller cannot leak what it is
// never given. That is the same shape as `mint-agent-key.mjs`'s split, for the same reason.
//
// TWO DIFFERENT SIGNERS, and they are not interchangeable. The mint is signed by the OWNER, through
// whatever signer the console is holding — an extension or a bunker, never a key this page has. The
// claim is signed by the AGENT's freshly minted key, because the whole point is that the joining
// key proves control of itself. Passing one where the other belongs produces a request that is
// perfectly valid and does the wrong thing, so they are separate parameters with separate names.

import { nip98Template, nip98Header, expectedUrl } from './nip98.mjs'

const MINT_PATH = '/api/invites'
const CLAIM_PATH = '/api/invites/claim'

async function signedPost({ relayBase, path, bodyObj, sign, fetchFn }) {
  const url = expectedUrl(relayBase, path)
  const { template, body } = await nip98Template({ url, method: 'POST', body: JSON.stringify(bodyObj) })
  const signed = await sign(template)
  // The SAME string that was hashed. Re-serialising here would sign one set of bytes and send
  // another, and the relay's refusal for that reads as a signing failure rather than this.
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: nip98Header(signed) },
    body,
  })
  const text = await res.text().catch(() => '')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: res.status, json, text }
}

/// Mint an invite as the owner and claim it as the agent. Returns what happened and nothing that
/// could be replayed.
///
/// `step` is always set, so a failure names which half broke — "mint" and "claim" fail for entirely
/// different reasons and send the operator to different places.
export async function letOntoRelay({ relayBase, ownerSign, agentSign, ttlSecs = 3600, fetchFn = fetch }) {
  if (typeof ownerSign !== 'function') throw new Error('ownerSign must be a function — the mint is signed by the owner, through your signer')
  if (typeof agentSign !== 'function') throw new Error('agentSign must be a function — the claim is signed by the agent key itself')

  let mint
  try {
    mint = await signedPost({ relayBase, path: MINT_PATH, bodyObj: { ttl_secs: ttlSecs, max_uses: 1 }, sign: ownerSign, fetchFn })
  } catch (e) { return { ok: false, step: 'mint', outcome: 'unreachable', detail: e.message } }

  if (mint.status === 403) {
    return { ok: false, step: 'mint', outcome: 'not_an_admin', status: 403,
      detail: 'Your key is not an owner or admin on this relay, so it cannot create invitations. That is the only thing missing — ask whoever runs the relay to add it.' }
  }
  if (mint.status === 401) {
    return { ok: false, step: 'mint', outcome: 'rejected_signature', status: 401,
      detail: `The relay would not accept the signature: ${mint.json?.error || mint.text.slice(0, 160)}` }
  }
  if (mint.status < 200 || mint.status >= 300) {
    return { ok: false, step: 'mint', outcome: 'refused', status: mint.status, detail: mint.json?.error || mint.text.slice(0, 160) }
  }

  // From here the code exists. It never leaves this scope.
  const code = mint.json?.code
  if (!code) {
    // A 2xx with no code means an invitation may or may not have been created, and saying either
    // would be a guess. INCONCLUSIVE is its own outcome for exactly this.
    return { ok: false, step: 'mint', outcome: 'inconclusive', status: mint.status,
      detail: 'The relay accepted the request but returned no invitation. Check the relay before trying again — this may have created one.' }
  }

  let claim
  try {
    claim = await signedPost({ relayBase, path: CLAIM_PATH, bodyObj: { code }, sign: agentSign, fetchFn })
  } catch (e) { return { ok: false, step: 'claim', outcome: 'unreachable', detail: e.message } }

  if (claim.status < 200 || claim.status >= 300) {
    return { ok: false, step: 'claim', outcome: 'refused', status: claim.status,
      detail: claim.json?.error || claim.text.slice(0, 160) }
  }

  // "Joined" and "already a member" are both success and are DIFFERENT facts — one consumed the
  // invitation, the other did not. Collapsing them hides a re-run.
  const already = /already/i.test(JSON.stringify(claim.json || {}))
  return {
    ok: true, step: 'claim', status: claim.status,
    outcome: already ? 'already_a_member' : 'joined',
    // Deliberately NOT proof. The claim's 200 says a row was written; it does not say the key can
    // authenticate. That needs one kind:0 published and read back cold.
    proven: false,
  }
}
