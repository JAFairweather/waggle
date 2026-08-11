// #357 — the console lets an agent onto the community relay: owner mints, agent claims.
//
// The property worth guarding is not "it makes two HTTP calls". It is that a **bearer secret**
// exists between them — anyone holding the invite code can join this relay — and that the code is
// created, used and dropped inside one function. So the headline assertion is a search for the
// code's own characters across everything the function hands back. A caller cannot leak what it is
// never given.
//
// The other half is that the two signers are not interchangeable. The mint must be signed by the
// OWNER and the claim by the AGENT; swapping them produces requests that are perfectly valid and
// do the wrong thing, which no status code would reveal. So the test watches WHICH key signed
// WHICH call, not just that both were signed.
//
//   node tests/console_relay_invite.mjs

import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { letOntoRelay, joinPolicy } from '../console/relay-invite.mjs'

let fails = 0
const ok = (n, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}${c || !d ? '' : ` — ${d}`}`); if (!c) fails++ }

const ownerSk = generateSecretKey(), ownerPk = getPublicKey(ownerSk)
const agentSk = generateSecretKey(), agentPk = getPublicKey(agentSk)
const ownerSign = async (t) => finalizeEvent(t, ownerSk)
const agentSign = async (t) => finalizeEvent(t, agentSk)
const RELAY = 'wss://relay.example.test'
const CODE = 'v2.a-bearer-secret-nobody-else-should-ever-see'

// A fetch stand-in that records every call and replays scripted responses. `signer` is the pubkey
// that signed the NIP-98 header, or null for the calls that carry none — which is itself something
// the tests below assert, since signing the acceptance with the wrong key would be invisible.
const harness = (responses) => {
  const calls = []
  const fetchFn = async (url, init) => {
    const auth = (init.headers && init.headers.authorization) || ''
    const ev = auth ? JSON.parse(Buffer.from(auth.slice(6), 'base64').toString('utf8')) : null
    calls.push({ url, method: init.method, body: init.body, signer: ev && ev.pubkey, event: ev })
    const r = responses[calls.length - 1]
    return { status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) }
  }
  return { calls, fetchFn }
}
const okMint = { status: 200, body: { code: CODE, expires_at: 1786470000, max_uses: 1 } }
// A relay that asks nothing. The documented shape is a bare `{}`, not a 404.
const noPolicy = { status: 200, body: {} }
// The shape the production relay actually returns, read live on 2026-08-11.
const POLICY_VERSION = 'a7b4425bfb6ffd909da7bb50a49b4cc818e09d74dbae20207b9f6cc9ef64920d'
const hasPolicy = { status: 200, body: { policy: {
  version: POLICY_VERSION, age_attestation_required: true,
  terms_markdown: '# Terms\n\nYou must be at least 18 years old.', privacy_markdown: '# Privacy',
} } }
const okReceipt = { status: 200, body: { receipt: 'rcpt.abc' } }
const agrees = async () => ({ accepted: true, ageConfirmed: true })

// --- the happy path, on a relay that asks nothing ------------------------------------------------
{
  const { calls, fetchFn } = harness([noPolicy, okMint, { status: 200, body: { status: 'joined', role: 'member' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })

  ok('it reports success', res.ok === true && res.outcome === 'joined')
  ok('…and does NOT claim the key has been proved to authenticate', res.proven === false)
  ok('a relay with no policy is not asked to accept one', calls.length === 3)
  ok('the first is the policy read, and it is a GET', calls[0].url === 'https://relay.example.test/api/join-policy' && calls[0].method === 'GET')
  ok('the second is the mint', calls[1].url === 'https://relay.example.test/api/invites')
  ok('the third is the claim', calls[2].url === 'https://relay.example.test/api/invites/claim')

  // The swap that no status code would reveal.
  ok('the mint is signed by the OWNER', calls[1].signer === ownerPk)
  ok('the claim is signed by the AGENT', calls[2].signer === agentPk)
  ok('…and they really are different keys', ownerPk !== agentPk)
  ok('both auth events verify', verifyEvent(calls[1].event) && verifyEvent(calls[2].event))

  // THE headline property. Search everything handed back for the code's own characters.
  const handedBack = JSON.stringify(res)
  ok('the invite code appears NOWHERE in the result', !handedBack.includes(CODE))
  ok('…not even a distinctive fragment of it', !handedBack.includes('bearer-secret'))
  ok('…and the result has no field that could carry one',
    Object.keys(res).every(k => ['ok', 'step', 'status', 'outcome', 'proven', 'detail'].includes(k)),
    `unexpected keys: ${Object.keys(res).join(', ')}`)

  // NEGATIVE CONTROL: the search above only means something if it CAN find the code.
  ok('NEGATIVE CONTROL — the same search finds the code when it is genuinely present',
    JSON.stringify({ ...res, leaked: CODE }).includes(CODE))

  // The code does have to reach the claim, or nothing was redeemed.
  ok('the code IS sent to the claim endpoint', JSON.parse(calls[2].body).code === CODE)
  ok('…and is not smuggled into the mint request', !String(calls[1].body).includes(CODE))
  ok('…and no receipt is invented for a relay that asked for none',
    JSON.parse(calls[2].body).policy_receipt === undefined)
}

// --- the terms. This is the live shape: the production relay DOES carry a join policy ------------
{
  const { calls, fetchFn } = harness([hasPolicy, okMint, okReceipt, { status: 200, body: { status: 'joined' } }])
  let shown = null
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn,
    acceptPolicy: async (p) => { shown = p; return { accepted: true, ageConfirmed: true } } })

  ok('a relay that asks for terms still gets the key on', res.ok === true && res.outcome === 'joined')
  ok('the acceptance is exchanged for a receipt, between the mint and the claim',
    calls[2].url === 'https://relay.example.test/api/invites/accept-policy')
  ok('…and the receipt is carried into the claim', JSON.parse(calls[3].body).policy_receipt === 'rcpt.abc')
  ok('…bound to the version the operator was actually shown',
    JSON.parse(calls[2].body).policy_version === POLICY_VERSION && shown.version === POLICY_VERSION)
  ok('…and to the age they actually confirmed', JSON.parse(calls[2].body).age_confirmed === true)

  // Signing the acceptance with the owner's key would put the owner's signature on the agent's
  // acceptance, and nothing in a 200 would say so.
  ok('the acceptance carries NO signature at all', calls[2].signer === null || calls[2].signer === undefined)

  // The operator is asked BEFORE anything exists, so declining costs nothing. Prove the order.
  ok('the question was put before the mint',
    calls.findIndex(c => c.url.endsWith('/api/invites')) === 1 && shown !== null)

  ok('the operator is handed LINKS to the relay\'s own documents, not a re-render',
    shown.termsUrl === 'https://relay.example.test/api/join-policy/terms' &&
    shown.privacyUrl === 'https://relay.example.test/api/join-policy/privacy')
  ok('…and is told an age attestation is wanted', shown.ageAttestationRequired === true)
  ok('the terms text is NOT handed to the caller to render itself',
    !('terms_markdown' in shown) && !('termsMarkdown' in shown) && !JSON.stringify(shown).includes('18 years old'))
  ok('still no code anywhere in the result', !JSON.stringify(res).includes(CODE))
}

// --- consent fails CLOSED. This is the one that must never be satisfied by a default -------------
{
  const { calls, fetchFn } = harness([hasPolicy])
  // No acceptPolicy passed at all — the shape a console has when somebody forgets to wire it.
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('with no consent surface wired, it REFUSES rather than accepting on the operator\'s behalf',
    res.ok === false && res.outcome === 'policy_declined')
  ok('…and nothing was created — no invitation is left lying on the relay', calls.length === 1)
  ok('…and it says so, so the operator does not go hunting for one', /nothing was created/i.test(res.detail))
}
{
  const { calls, fetchFn } = harness([hasPolicy])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn,
    acceptPolicy: async () => ({ accepted: false }) })
  ok('an explicit decline is honoured, at the policy step', res.ok === false && res.step === 'policy' && res.outcome === 'policy_declined')
  ok('…and still mints nothing', calls.length === 1)
}
{
  const { calls, fetchFn } = harness([hasPolicy])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn,
    acceptPolicy: async () => ({ accepted: true, ageConfirmed: false }) })
  ok('accepting the terms while declining the age attestation does NOT join',
    res.ok === false && res.outcome === 'age_not_confirmed')
  ok('…and does not quietly send age_confirmed:false to see what happens', calls.length === 1)
}
{
  // …and the same fixture with the attestation given still joins, so the refusals above are
  // selective rather than a function that refuses whenever a policy exists.
  const { fetchFn } = harness([hasPolicy, okMint, okReceipt, { status: 200, body: { status: 'joined' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn, acceptPolicy: agrees })
  ok('a confirmed operator still gets through', res.ok === true)
}
{
  // A relay that does not require the attestation must not demand one.
  const relaxed = { status: 200, body: { policy: { version: 'v9', age_attestation_required: false } } }
  const { calls, fetchFn } = harness([relaxed, okMint, okReceipt, { status: 200, body: { status: 'joined' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn,
    acceptPolicy: async () => ({ accepted: true }) })
  ok('where no age attestation is asked for, none is demanded', res.ok === true)
  // The other direction. Without this, `age_confirmed: true` hard-coded passes every assertion
  // above — the console would be attesting to something the operator never said.
  ok('…and an attestation the operator did not give is sent as FALSE, not invented',
    JSON.parse(calls[2].body).age_confirmed === false)
}

// --- the live failure that sent us here ----------------------------------------------------------
{
  const { fetchFn } = harness([noPolicy, okMint, { status: 403, body: { error: 'join_policy_required' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn, acceptPolicy: agrees })
  ok('a bare join_policy_required is turned into a sentence, not shown as a code',
    res.ok === false && /accept its terms/i.test(res.detail) && !/join_policy_required/.test(res.detail))
  ok('…and is attributed to the claim, which is where it came from', res.step === 'claim')
}
{
  const { fetchFn } = harness([hasPolicy, okMint, { status: 400, body: { error: 'join_policy_not_accepted' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn, acceptPolicy: agrees })
  ok('a stale policy version is reported at the POLICY step and says to reload',
    res.ok === false && res.step === 'policy' && res.outcome === 'refused' && /reload/i.test(res.detail))
}
{
  const { fetchFn } = harness([hasPolicy, okMint, { status: 200, body: { ok: true } }])   // 2xx, no receipt
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn, acceptPolicy: agrees })
  ok('a 2xx acceptance with no receipt is INCONCLUSIVE, and warns an invitation may exist',
    res.ok === false && res.step === 'policy' && res.outcome === 'inconclusive' && /may have been created/i.test(res.detail))
}
{
  // An error string we did not anticipate is shown VERBATIM. A friendly paraphrase of something
  // unknown is a lie, and the raw code is the lead.
  const { fetchFn } = harness([noPolicy, okMint, { status: 403, body: { error: 'some_new_gate_v3' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn, acceptPolicy: agrees })
  ok('an unrecognised relay error is passed through untouched', res.detail === 'some_new_gate_v3')
}

// --- already a member: success, but a DIFFERENT fact --------------------------------------------
{
  const { fetchFn } = harness([noPolicy, okMint, { status: 200, body: { status: 'already_member', role: 'member' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('an already-a-member claim is success, and says so distinctly',
    res.ok === true && res.outcome === 'already_a_member')
}

// --- the refusals. Each names its own step and reason -------------------------------------------
{
  const { calls, fetchFn } = harness([noPolicy, { status: 403, body: { error: 'only relay owners and admins can create invites' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('a 403 on the mint is reported as a missing ROLE, at the mint step',
    res.ok === false && res.step === 'mint' && res.outcome === 'not_an_admin')
  ok('…in words an operator can act on, without protocol nouns',
    /owner or admin/.test(res.detail) && !/relay_members|403 Forbidden/.test(res.detail))
  ok('…and it never attempts the claim', calls.length === 2)
}
{
  const { fetchFn } = harness([noPolicy, { status: 401, body: { error: 'NIP-98: invalid Schnorr signature' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('a 401 is reported as a signature problem, NOT as a missing role',
    res.ok === false && res.outcome === 'rejected_signature' && res.step === 'mint')
}
{
  const { fetchFn } = harness([noPolicy, { status: 200, body: { expires_at: 1 } }])   // 2xx, no code
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('a 2xx with no invitation is INCONCLUSIVE, not a failure and not a success',
    res.ok === false && res.outcome === 'inconclusive')
  ok('…and warns that one may have been created anyway', /may have created/.test(res.detail))
}
{
  // The relay ECHOES THE CODE it refused — which real relays and proxies do, and which is the only
  // fixture under which the leak assertion below can fail at all. With `{error:'invite_expired'}`
  // there was no code in the response to leak, so the check passed on an input it never tested.
  const { calls, fetchFn } = harness([noPolicy, okMint,
    { status: 403, body: { error: 'invite_expired', code: CODE, detail: `invite ${CODE} expired at 1786470000` } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('a refusal on the CLAIM is attributed to the claim step, not the mint',
    res.ok === false && res.step === 'claim' && res.outcome === 'refused' && res.status === 403)
  ok('…in a sentence that says what to do about it', /try again/i.test(res.detail))
  ok('…after all three calls were genuinely made', calls.length === 3)
  ok('…and still leaks no code', !JSON.stringify(res).includes(CODE))
}
{
  const boom = async () => { throw new Error('Failed to fetch') }
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn: boom })
  ok('an unreachable relay is its own outcome, at the step that could not be reached',
    res.ok === false && res.step === 'policy' && res.outcome === 'unreachable')
}
{
  // Reachable for the policy read, gone by the mint — the step must follow the failure, not a guess.
  let n = 0
  const fetchFn = async () => {
    if (++n === 1) return { status: 200, text: async () => '{}' }
    throw new Error('Failed to fetch')
  }
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('a relay that dies after the policy read is reported at the MINT step',
    res.ok === false && res.step === 'mint' && res.outcome === 'unreachable')
}

// --- the three routes the code escapes by, each driven with a response that carries it -----------
// Everything after the mint has the code in scope, and every string on those paths came from
// somewhere else: a relay naming what it rejected, a proxy echoing the request it blocked, a
// rejected promise carrying the body. Each is asserted with a fixture that genuinely contains the
// code, so a missing scrub fails rather than passing on an input that had nothing to find.
{
  const { fetchFn } = harness([noPolicy, okMint,
    { status: 400, body: { error: `invite_invalid: no such invite ${CODE}` } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('a relay that names the code in its error does NOT get it repeated back',
    res.ok === false && !JSON.stringify(res).includes(CODE))
  ok('…and the operator is told something was removed rather than shown a truncated mess',
    /redacted/i.test(res.detail))
  ok('…while the part that was actually informative survives', /no such invite/.test(res.detail))
}
{
  // A WAF or reverse proxy: not JSON at all, an HTML page quoting the request it blocked.
  const html = `<html><body><h1>403 Forbidden</h1><p>Request blocked: {"code":"${CODE}"}</p></body></html>`
  const fetchFn = async (url, init) => {
    const n = (fetchFn.n = (fetchFn.n || 0) + 1)
    if (n === 1) return { status: 200, text: async () => '{}' }
    if (n === 2) return { status: 200, text: async () => JSON.stringify(okMint.body) }
    return { status: 403, text: async () => html }
  }
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('a proxy echoing the request body as HTML does not leak the code either',
    res.ok === false && !JSON.stringify(res).includes(CODE))
  ok('…and the page is still shown, so the operator can see it was a proxy and not the relay',
    /403 Forbidden/.test(res.detail))
}
{
  // The caller's own fetch rejecting with the body in the message — a real axios/undici shape.
  const fetchFn = async (url) => {
    if (url.endsWith('/api/join-policy')) return { status: 200, text: async () => '{}' }
    if (url.endsWith('/api/invites')) return { status: 200, text: async () => JSON.stringify(okMint.body) }
    throw new Error(`request failed: POST /api/invites/claim {"code":"${CODE}"}`)
  }
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('a rejected fetch carrying the body in its message does not leak the code',
    res.ok === false && res.outcome === 'unreachable' && !JSON.stringify(res).includes(CODE))
}
{
  // NEGATIVE CONTROL for all three. The scrub only replaces THIS code — an unrelated secret-looking
  // string in a relay error must still come through, or "nothing leaks" is just "nothing is shown".
  const { fetchFn } = harness([noPolicy, okMint,
    { status: 400, body: { error: 'rejected by rule v2.some-other-token-entirely' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('NEGATIVE CONTROL — a string that is not the code is passed through untouched',
    /v2\.some-other-token-entirely/.test(res.detail))
}

// --- the duplicated signer: the failure that reports success -------------------------------------
// Two signers arrive as two parameters, and on the bunker route both are read off the same object.
// Hand the owner's signer to both halves and the claim succeeds — the owner IS a relay member — so
// the relay returns 200 and the result reads `already_a_member`, the outcome added to be reassuring
// about a re-run. The agent never joined. No status code anywhere says so.
{
  const { calls, fetchFn } = harness([noPolicy, okMint, { status: 200, body: { status: 'already_member' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign: ownerSign,
    expectAgentPubkey: agentPk, fetchFn })
  ok('the owner\'s signer passed for BOTH halves is REFUSED, not reported as success',
    res.ok === false && res.outcome === 'wrong_signer')
  ok('…and it says plainly that nobody joined', /Nobody joined/i.test(res.detail))
  ok('…and the claim was never sent, so the invitation was not spent on the wrong key',
    calls.length === 2)
  ok('…and it still leaks no code', !JSON.stringify(res).includes(CODE))
}
{
  // The same relay answer, reached honestly: the AGENT's key really was already a member. Without
  // this, the refusal above is indistinguishable from refusing `already_member` outright — and that
  // outcome is a legitimate, common re-run.
  const { fetchFn } = harness([noPolicy, okMint, { status: 200, body: { status: 'already_member' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('the SAME already_member answer, signed by the agent, is still a success',
    res.ok === true && res.outcome === 'already_a_member')
  ok('…so the two are genuinely different results and not one blanket refusal',
    res.ok === true)
}
{
  // And the other direction on the mint: an agent cannot invite itself.
  const { calls, fetchFn } = harness([noPolicy])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign: agentSign, agentSign,
    expectAgentPubkey: agentPk, fetchFn })
  ok('the agent\'s own key minting its own invitation is refused at the MINT step',
    res.ok === false && res.step === 'mint' && res.outcome === 'wrong_signer')
  ok('…before anything is created', calls.length === 1)
}
{
  // `already` must key on the relay's status FIELD, not a sweep of the serialised body. A detail
  // line mentioning the word does not make this a re-run, and calling it one hides a real join.
  const { fetchFn } = harness([noPolicy, okMint,
    { status: 200, body: { status: 'joined', note: 'this key was already known to the directory' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('the word "already" elsewhere in the body does NOT turn a real join into a re-run',
    res.ok === true && res.outcome === 'joined')
}

// --- the key being invited is required, and named ------------------------------------------------
{
  let threw = null
  try {
    await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign,
      fetchFn: async () => ({ status: 200, text: async () => '{}' }) })
  } catch (e) { threw = e.message }
  ok('omitting the key being invited is refused up front, not skipped as optional',
    /expectAgentPubkey/.test(String(threw)))
  ok('…and says what goes wrong without it', /looks like success/.test(String(threw)))
}

// --- and the same fixture minus the one defect still succeeds -----------------------------------
// Without this, every refusal above is equally satisfied by the function refusing everything.
{
  const { fetchFn } = harness([noPolicy, okMint, { status: 200, body: { status: 'joined' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, expectAgentPubkey: agentPk, fetchFn })
  ok('a clean run still succeeds — the refusals above are selective', res.ok === true)
}

// --- reading the policy on its own, which the console does to render the consent panel -----------
{
  const { calls, fetchFn } = harness([hasPolicy])
  const p = await joinPolicy({ relayBase: RELAY, fetchFn })
  ok('joinPolicy needs no key and sends no signature', calls[0].signer === null || calls[0].signer === undefined)
  ok('…and reports what is required', p.required === true && p.ageAttestationRequired === true)
}
{
  const { fetchFn } = harness([noPolicy])
  const p = await joinPolicy({ relayBase: RELAY, fetchFn })
  ok('a relay with no policy reports none, rather than erroring', p.required === false)
}

// --- the signers are required, and named ---------------------------------------------------------
let refused = null
try { await letOntoRelay({ relayBase: RELAY, agentSign, expectAgentPubkey: agentPk, fetchFn: async () => ({ status: 200, text: async () => '{}' }) }) }
catch (e) { refused = e.message }
ok('a missing owner signer is refused, and says the mint is the owner\'s', /ownerSign/.test(String(refused)) && /owner/.test(String(refused)))
refused = null
try { await letOntoRelay({ relayBase: RELAY, ownerSign, expectAgentPubkey: agentPk, fetchFn: async () => ({ status: 200, text: async () => '{}' }) }) }
catch (e) { refused = e.message }
ok('a missing agent signer is refused, and says the claim is the agent\'s', /agentSign/.test(String(refused)) && /agent key itself/.test(String(refused)))

console.log(fails ? `\nCONSOLE RELAY INVITE FAIL — ${fails}` : '\nCONSOLE RELAY INVITE PASS — the code never leaves, consent fails closed, and the two signers stay apart')
process.exit(fails ? 1 : 0)
