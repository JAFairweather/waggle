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
import { letOntoRelay } from '../console/relay-invite.mjs'

let fails = 0
const ok = (n, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}${c || !d ? '' : ` — ${d}`}`); if (!c) fails++ }

const ownerSk = generateSecretKey(), ownerPk = getPublicKey(ownerSk)
const agentSk = generateSecretKey(), agentPk = getPublicKey(agentSk)
const ownerSign = async (t) => finalizeEvent(t, ownerSk)
const agentSign = async (t) => finalizeEvent(t, agentSk)
const RELAY = 'wss://relay.example.test'
const CODE = 'v2.a-bearer-secret-nobody-else-should-ever-see'

// A fetch stand-in that records every call and replays scripted responses.
const harness = (responses) => {
  const calls = []
  const fetchFn = async (url, init) => {
    const auth = init.headers.authorization || ''
    // Decode the header the way the relay does, so the test reads the bytes actually sent.
    const ev = JSON.parse(Buffer.from(auth.slice(6), 'base64').toString('utf8'))
    calls.push({ url, body: init.body, signer: ev.pubkey, event: ev })
    const r = responses[calls.length - 1]
    return { status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) }
  }
  return { calls, fetchFn }
}
const okMint = { status: 200, body: { code: CODE, expires_at: 1786470000, max_uses: 1 } }

// --- the happy path ---------------------------------------------------------------------------
{
  const { calls, fetchFn } = harness([okMint, { status: 200, body: { status: 'Joined', use_count: 1 } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, fetchFn })

  ok('it reports success', res.ok === true && res.outcome === 'joined')
  ok('…and does NOT claim the key has been proved to authenticate', res.proven === false)
  ok('it made exactly two calls', calls.length === 2)
  ok('the first is the mint', calls[0].url === 'https://relay.example.test/api/invites')
  ok('the second is the claim', calls[1].url === 'https://relay.example.test/api/invites/claim')

  // The swap that no status code would reveal.
  ok('the mint is signed by the OWNER', calls[0].signer === ownerPk)
  ok('the claim is signed by the AGENT', calls[1].signer === agentPk)
  ok('…and they really are different keys', ownerPk !== agentPk)
  ok('both auth events verify', verifyEvent(calls[0].event) && verifyEvent(calls[1].event))

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
  ok('the code IS sent to the claim endpoint', JSON.parse(calls[1].body).code === CODE)
  ok('…and is not smuggled into the mint request', !String(calls[0].body).includes(CODE))
}

// --- already a member: success, but a DIFFERENT fact --------------------------------------------
{
  const { fetchFn } = harness([okMint, { status: 200, body: { status: 'AlreadyMember', use_count: 3 } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, fetchFn })
  ok('an already-a-member claim is success, and says so distinctly',
    res.ok === true && res.outcome === 'already_a_member')
}

// --- the refusals. Each names its own step and reason -------------------------------------------
{
  const { calls, fetchFn } = harness([{ status: 403, body: { error: 'only relay owners and admins can create invites' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, fetchFn })
  ok('a 403 on the mint is reported as a missing ROLE, at the mint step',
    res.ok === false && res.step === 'mint' && res.outcome === 'not_an_admin')
  ok('…in words an operator can act on, without protocol nouns',
    /owner or admin/.test(res.detail) && !/relay_members|403 Forbidden/.test(res.detail))
  ok('…and it never attempts the claim', calls.length === 1)
}
{
  const { fetchFn } = harness([{ status: 401, body: { error: 'NIP-98: invalid Schnorr signature' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, fetchFn })
  ok('a 401 is reported as a signature problem, NOT as a missing role',
    res.ok === false && res.outcome === 'rejected_signature' && res.step === 'mint')
}
{
  const { fetchFn } = harness([{ status: 200, body: { expires_at: 1 } }])   // 2xx, no code
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, fetchFn })
  ok('a 2xx with no invitation is INCONCLUSIVE, not a failure and not a success',
    res.ok === false && res.outcome === 'inconclusive')
  ok('…and warns that one may have been created anyway', /may have created/.test(res.detail))
}
{
  const { calls, fetchFn } = harness([okMint, { status: 410, body: { error: 'Expired' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, fetchFn })
  ok('a refusal on the CLAIM is attributed to the claim step, not the mint',
    res.ok === false && res.step === 'claim' && res.outcome === 'refused' && res.status === 410)
  ok('…after both calls were genuinely made', calls.length === 2)
  ok('…and still leaks no code', !JSON.stringify(res).includes(CODE))
}
{
  const boom = async () => { throw new Error('Failed to fetch') }
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, fetchFn: boom })
  ok('an unreachable relay is its own outcome, at the step that could not be reached',
    res.ok === false && res.step === 'mint' && res.outcome === 'unreachable')
}

// --- and the same fixture minus the one defect still succeeds -----------------------------------
// Without this, every refusal above is equally satisfied by the function refusing everything.
{
  const { fetchFn } = harness([okMint, { status: 200, body: { status: 'Joined' } }])
  const res = await letOntoRelay({ relayBase: RELAY, ownerSign, agentSign, fetchFn })
  ok('a clean run still succeeds — the refusals above are selective', res.ok === true)
}

// --- the signers are required, and named ---------------------------------------------------------
let refused = null
try { await letOntoRelay({ relayBase: RELAY, agentSign, fetchFn: async () => ({ status: 200, text: async () => '{}' }) }) }
catch (e) { refused = e.message }
ok('a missing owner signer is refused, and says the mint is the owner\'s', /ownerSign/.test(String(refused)) && /owner/.test(String(refused)))
refused = null
try { await letOntoRelay({ relayBase: RELAY, ownerSign, fetchFn: async () => ({ status: 200, text: async () => '{}' }) }) }
catch (e) { refused = e.message }
ok('a missing agent signer is refused, and says the claim is the agent\'s', /agentSign/.test(String(refused)) && /agent key itself/.test(String(refused)))

console.log(fails ? `\nCONSOLE RELAY INVITE FAIL — ${fails}` : '\nCONSOLE RELAY INVITE PASS — the code never leaves, and the two signers stay apart')
process.exit(fails ? 1 : 0)
