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
// THE TERMS STEP IS NOT OPTIONAL AND IT IS NOT OURS TO ANSWER. A relay may carry a join policy;
// this one does, live, with an 18+ attestation. Its own terms say an admin may not invite anyone
// under 18, so the person doing the inviting is the person the question is for. `acceptPolicy` is
// therefore a caller-supplied callback whose default answer is NO — a console that forgets to wire
// a consent surface refuses to join rather than accepting on the operator's behalf. It is asked
// BEFORE the mint, so declining leaves no unclaimed invitation on the relay.
//
// TWO DIFFERENT SIGNERS, and they are not interchangeable. The mint is signed by the OWNER, through
// whatever signer the console is holding — an extension or a bunker, never a key this page has. The
// claim is signed by the AGENT's freshly minted key, because the whole point is that the joining
// key proves control of itself. Passing one where the other belongs produces a request that is
// perfectly valid and does the wrong thing, so they are separate parameters with separate names.

import { nip98Template, nip98Header, expectedUrl } from './nip98.mjs'

const MINT_PATH = '/api/invites'
const CLAIM_PATH = '/api/invites/claim'
const POLICY_PATH = '/api/join-policy'
const ACCEPT_PATH = '/api/invites/accept-policy'
const TERMS_PATH = '/api/join-policy/terms'
const PRIVACY_PATH = '/api/join-policy/privacy'

// The relay's own error strings, turned into sentences an operator can act on. Left as-is when
// unrecognised: an unfamiliar code shown verbatim is a lead, and a friendly paraphrase of something
// we did not anticipate is a lie.
const EXPLAIN = {
  join_policy_required: 'This community asks whoever invites a key to accept its terms first, and no acceptance reached the relay.',
  join_policy_not_accepted: 'The relay would not take the acceptance — its terms have changed since this page read them. Reload the page and try again.',
  join_policy_not_configured: 'The relay says it has no terms, but refused the join for wanting them. Nothing here can settle that — ask whoever runs the relay.',
  invite_expired: 'The invitation expired before it was used. Try again — this makes a fresh one.',
  invite_exhausted: 'The invitation had already been used. Try again — this makes a fresh one.',
  invite_invalid: 'The relay did not recognise the invitation.',
}
const explain = (code, fallback) => EXPLAIN[String(code || '')] || code || fallback

// The default answer to "do you accept these terms?" is NO. Accepting terms is an act with legal
// weight and it belongs to a person, so a caller that forgets to wire consent must fail closed —
// never sail through on a default that says yes on the operator's behalf.
const REFUSE_BY_DEFAULT = () => ({ accepted: false })

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

// Unsigned. `accept-policy` takes no Authorization header — the receipt it returns is bound by HMAC
// to the invite code and the policy version, so possession of the code is what it proves, and a
// signature would add nothing. Do not "harden" this by signing it: the claim that follows is signed
// by the agent, and signing the acceptance with the OWNER's key would put the owner's signature on
// the agent's acceptance.
async function plainPost({ relayBase, path, bodyObj, fetchFn }) {
  const url = expectedUrl(relayBase, path)
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyObj),
  })
  const text = await res.text().catch(() => '')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: res.status, json, text }
}

/// What this community asks of anyone joining it. Public — no key, no signature.
///
/// It returns LINKS to the documents, never their text. The relay serves both as real HTML pages
/// for exactly this purpose, and sending the operator there means the thing they read is the thing
/// the relay is asking them to accept. A page that re-renders 100KB of somebody else's terms and
/// then asks you to accept them is a page that could be showing you something else.
export async function joinPolicy({ relayBase, fetchFn = fetch }) {
  const res = await fetchFn(expectedUrl(relayBase, POLICY_PATH), { method: 'GET' })
  const text = await res.text().catch(() => '')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  const p = json && json.policy
  // No policy configured is the documented shape `{}`, not an error. A relay that asks nothing is
  // a relay this whole step skips.
  if (!p || !p.version) return { required: false }
  return {
    required: true,
    version: String(p.version),
    ageAttestationRequired: p.age_attestation_required === true,
    termsUrl: expectedUrl(relayBase, TERMS_PATH),
    privacyUrl: expectedUrl(relayBase, PRIVACY_PATH),
  }
}

/// Mint an invite as the owner and claim it as the agent. Returns what happened and nothing that
/// could be replayed.
///
/// `step` is always set, so a failure names which half broke — "mint" and "claim" fail for entirely
/// different reasons and send the operator to different places.
export async function letOntoRelay({ relayBase, ownerSign, agentSign, acceptPolicy = REFUSE_BY_DEFAULT, ttlSecs = 3600, fetchFn = fetch }) {
  if (typeof ownerSign !== 'function') throw new Error('ownerSign must be a function — the mint is signed by the owner, through your signer')
  if (typeof agentSign !== 'function') throw new Error('agentSign must be a function — the claim is signed by the agent key itself')

  // Ask about the terms BEFORE anything is created. The receipt has to be bound to a code that does
  // not exist yet, but the human decision does not — and gathering it first means declining leaves
  // no unclaimed invitation lying on the relay. That ordering is the whole reason this is two steps
  // rather than one.
  let policy
  try { policy = await joinPolicy({ relayBase, fetchFn }) }
  catch (e) { return { ok: false, step: 'policy', outcome: 'unreachable', detail: e.message } }

  let consent = null
  if (policy.required) {
    consent = await acceptPolicy(policy)
    if (!consent || consent.accepted !== true) {
      return { ok: false, step: 'policy', outcome: 'policy_declined',
        detail: 'The terms were not accepted, so nothing was created and nobody was invited.' }
    }
    if (policy.ageAttestationRequired && consent.ageConfirmed !== true) {
      return { ok: false, step: 'policy', outcome: 'age_not_confirmed',
        detail: 'This community requires whoever invites a key to confirm they are 18 or older, and that was not confirmed. Nothing was created.' }
    }
  }

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
    return { ok: false, step: 'mint', outcome: 'refused', status: mint.status, detail: explain(mint.json?.error, mint.text.slice(0, 160)) }
  }

  // From here the code exists. It never leaves this scope.
  const code = mint.json?.code
  if (!code) {
    // A 2xx with no code means an invitation may or may not have been created, and saying either
    // would be a guess. INCONCLUSIVE is its own outcome for exactly this.
    return { ok: false, step: 'mint', outcome: 'inconclusive', status: mint.status,
      detail: 'The relay accepted the request but returned no invitation. Check the relay before trying again — this may have created one.' }
  }

  // Exchange the decision already taken for a receipt bound to THIS code. Nothing is asked of the
  // operator here — the question was put before the mint, and asking again after would be a second
  // acceptance they never gave.
  let receipt = null
  if (policy.required) {
    let acc
    try {
      acc = await plainPost({ relayBase, path: ACCEPT_PATH, fetchFn,
        bodyObj: { code, policy_version: policy.version, age_confirmed: consent.ageConfirmed === true } })
    } catch (e) { return { ok: false, step: 'policy', outcome: 'unreachable', detail: e.message } }

    if (acc.status < 200 || acc.status >= 300) {
      return { ok: false, step: 'policy', outcome: 'refused', status: acc.status,
        detail: explain(acc.json?.error, acc.text.slice(0, 160)) }
    }
    receipt = acc.json?.receipt
    if (!receipt) {
      return { ok: false, step: 'policy', outcome: 'inconclusive', status: acc.status,
        detail: 'The relay accepted the terms but returned no proof of it, so the join cannot be completed. An invitation may have been created — check the relay before trying again.' }
    }
  }

  let claim
  try {
    const body = receipt ? { code, policy_receipt: receipt } : { code }
    claim = await signedPost({ relayBase, path: CLAIM_PATH, bodyObj: body, sign: agentSign, fetchFn })
  } catch (e) { return { ok: false, step: 'claim', outcome: 'unreachable', detail: e.message } }

  if (claim.status < 200 || claim.status >= 300) {
    return { ok: false, step: 'claim', outcome: 'refused', status: claim.status,
      detail: explain(claim.json?.error, claim.text.slice(0, 160)) }
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
