// console_admission — the console can admit an agent, and reaches the CLI's verdicts (#487).
//
// Admission is what makes an agent a first-class member: the claim inserts the `relay_members` row
// the NIP-42 AUTH gate reads. Until now `tools/relay-invite.mjs` was the only way to walk it, so
// the operator dropped to a terminal in the middle of a flow that has no other command in it.
//
// The decisions now live in `src/relay_admission.mjs` with a browser copy in
// `console/relay-admission.mjs`, under the bind this repo has three times over: the page cannot
// import ../src/ (serve-console pins DOCROOT), and shipped code cannot import console/ (not in the
// ship list). Two copies, one obligation — prove they agree.
//
// THE THREE REFUSALS THIS SUITE EXISTS FOR. Each is a flag in the CLI and a checkbox in the page,
// and each has a failure mode that looks like success:
//
//   1. Consent is never inferred. A pre-ticked box, or an age attestation derived from accepting
//      terms, makes a statement about a person on their behalf.
//   2. A failed policy read is not "no policy". Guessing yields a 403 at claim time that nothing
//      explains — being unable to check is not the same as being fine.
//   3. "Joined" and "already a member" are different facts. Collapsed, a re-run that consumed
//      nothing is indistinguishable from a first claim that consumed a finite slot.
//
// Both directions on every guard: a refusal assertion is paired with one that the legitimate value
// still gets through, because a gate that refuses everything and a gate that refuses the right
// thing fail identically in a suite that only checks `!ok`.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as node from '../src/relay_admission.mjs'
import * as web from '../console/relay-admission.mjs'
import * as nodeNip98 from '../src/nip98.mjs'
import * as webNip98 from '../console/nip98.mjs'
import { ADMISSION_PLAN, claimInvite, mintInvite, readPolicy } from '../console/admission-client.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('\nconsole_admission\n')

// ------------------------------------------------------------------------------------------
console.log('0. the two modules expose the same surface')
// FIRST, because it is the cheapest way to catch the whole class. The first twin was missing
// `refusal`'s table and the node copy was missing `refusal` itself — one blew up mid-suite, the
// other threw a TypeError. Neither was a logic bug; both were a surface that had drifted.
const nodeNames = Object.keys(node).sort(), webNames = Object.keys(web).sort()
check(same(nodeNames, webNames),
  `both export the same ${webNames.length} names — ${webNames.join(' ')}`)
check(nodeNames.every(n => typeof node[n] === typeof web[n]),
  'and each name is the same KIND in both — a function on one side and a constant on the other would pass a names-only check')
const n98 = Object.keys(nodeNip98).sort(), w98 = Object.keys(webNip98).sort()
check(same(n98, w98), `nip98 likewise — ${w98.join(' ')}`)

// ------------------------------------------------------------------------------------------
console.log('1. NIP-98 — the two copies build the same envelope')
// The payload tag is the one that bites: it must be the SHA-256 of the bytes actually SENT. A
// twin that re-serialised, or hashed a different encoding, would sign one set of bytes and send
// another — refused as "payload tag SHA-256 mismatch", which reads like a signing bug.
const URL_ = 'https://relay.example.com/api/invites'
for (const body of ['', '{}', '{"ttl_secs":3600,"max_uses":1}', '{"n":"café"}']) {
  const a = await nodeNip98.nip98Template({ url: URL_, method: 'POST', body, now: 1_700_000_000 })
  const b = await webNip98.nip98Template({ url: URL_, method: 'POST', body, now: 1_700_000_000 })
  check(same(a, b), `nip98Template agrees on a ${body.length}-byte body, payload tag included`)
  check(a.body === body, 'and hands back the EXACT string it hashed, so the caller cannot re-serialise')
}
// A multi-byte character is the case btoa throws on if the header wraps the raw string. Both
// copies encode UTF-8 bytes first; if one ever stops, this is where it shows.
const signed = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), sig: 'c'.repeat(128), kind: 27235, created_at: 1, tags: [['u', 'https://x/café']], content: '' }
check(nodeNip98.nip98Header(signed) === webNip98.nip98Header(signed),
  'nip98Header agrees, including on a tag carrying a multi-byte character')
let nodeThrew = null, webThrew = null
try { nodeNip98.nip98Header({ id: 'a', pubkey: 'b' }) } catch (e) { nodeThrew = e.message }
try { webNip98.nip98Header({ id: 'a', pubkey: 'b' }) } catch (e) { webThrew = e.message }
check(nodeThrew !== null && nodeThrew === webThrew,
  `NEGATIVE CONTROL — both refuse an UNSIGNED template, identically: "${nodeThrew}"`)
for (const [relay, path, want] of [
  ['wss://r.example.com', '/api/invites', 'https://r.example.com/api/invites'],
  ['ws://r.example.com:8080', '/api/invites/claim', 'http://r.example.com:8080/api/invites/claim'],
]) {
  check(nodeNip98.expectedUrl(relay, path) === want && webNip98.expectedUrl(relay, path) === want,
    `expectedUrl agrees: ${relay} → ${want.split('://')[0]}://…`)
}

// ------------------------------------------------------------------------------------------
console.log('\n2. every status the relay can answer, both copies, same verdict')
// Driven off a table rather than a happy path: the exit codes ARE the tool's contract, and a twin
// that agreed on 200 while disagreeing on 403 would pass a one-case check.
const MINTS = [
  [{ status: 200, json: { code: 'inv_abc', expires_at: 1 } }, true, undefined],
  [{ status: 403, json: null, text: 'forbidden' }, false, 4],
  [{ status: 401, json: null, text: 'bad sig' }, false, 1],
  [{ status: 429, json: null, text: 'slow down' }, false, 4],
  [{ status: 500, json: null, text: 'boom' }, false, 2],
  [{ status: 200, json: {} }, false, 3],
]
for (const [res, ok, exitCode] of MINTS) {
  const a = node.mintOutcome(res), b = web.mintOutcome(res)
  check(same(a, b), `mintOutcome agrees on ${res.status}${ok ? '' : ` → exit ${exitCode}`}`)
  check(a.ok === ok && (ok || a.exitCode === exitCode), `and it is right: ok=${a.ok}${ok ? '' : `, exit=${a.exitCode}`}`)
}
check(node.mintOutcome({ status: 200, json: { code: 'inv_abc' } }).code === 'inv_abc',
  'a successful mint returns the code for the caller to hand onward')
check(node.mintOutcome({ status: 403 }).role === true,
  'and a 403 is flagged as a ROLE problem, not a signature one — the ask is one line to the relay operator')
check(node.mintOutcome({ status: 200, json: {} }).inconclusive === true,
  'a 2xx with no code is INCONCLUSIVE — it may have consumed a mint, so it is not reported as either')

const CLAIMS = [
  [{ status: 200, json: { status: 'joined' } }, true, undefined],
  [{ status: 200, json: { status: 'already a member' } }, true, undefined],
  [{ status: 401, text: 'bad sig' }, false, 1],
  [{ status: 403, text: 'no receipt' }, false, 4],
  [{ status: 429, text: 'slow' }, false, 4],
  [{ status: 503, text: 'down' }, false, 2],
]
for (const [res, ok, exitCode] of CLAIMS) {
  const a = node.claimOutcome(res), b = web.claimOutcome(res)
  check(same(a, b), `claimOutcome agrees on ${res.status} ${res.json?.status || ''}`.trim())
  check(a.ok === ok && (ok || a.exitCode === exitCode), `and it is right: ok=${a.ok}${ok ? '' : `, exit=${a.exitCode}`}`)
}

// ------------------------------------------------------------------------------------------
console.log('\n2b. every branch of refusal(), which is where the lift broke')
// Found by running, not by reading: the first twin lifted `refusal` without its REFUSALS table and
// `node --check` passed on it — syntax valid, identifier undefined. Only a case that reached the
// table failed. So every branch is driven here, in both copies, including the ones an operator
// most needs the wording of.
const REFUSAL_CASES = [
  [400, { error: 'join_policy_required' }, '', 'a claim with no receipt'],
  [400, { error: 'invite_expired' }, '', 'an expired invite'],
  [400, { error: 'invite_exhausted' }, '', 'an invite with no uses left'],
  [400, { error: 'invite_invalid' }, '', 'a code this relay does not know'],
  [400, { error: 'auth event replay detected' }, '', 'a NIP-98 replay'],
  [429, null, '', 'the rate limiter'],
  [500, null, 'upstream exploded', 'an unmapped failure, falling back to the text'],
  [500, null, '', 'nothing at all'],
]
for (const [status, json, text, what] of REFUSAL_CASES) {
  const a = node.refusal(status, json, text), b = web.refusal(status, json, text)
  check(a === b, `refusal() agrees on ${what}`)
  check(typeof a === 'string' && a.length > 0,
    `and never returns an empty string — a refusal nobody can act on is the failure this prevents`)
}
check(/allows \d+ claim attempts/.test(node.refusal(429, null, '')),
  'the 429 wording carries the actual rate limit, so CLAIM_RATE_LIMIT came across with it')
check(node.CLAIM_RATE_LIMIT === web.CLAIM_RATE_LIMIT,
  `and the constant itself matches (${web.CLAIM_RATE_LIMIT})`)

// ------------------------------------------------------------------------------------------
console.log('\n3. "joined" and "already a member" stay different facts')
const joined = node.claimOutcome({ status: 200, json: { status: 'joined' } })
const already = node.claimOutcome({ status: 200, json: { status: 'already a member' } })
check(joined.ok && already.ok, 'both are successes — a re-run is not an error')
check(joined.already === false && already.already === true,
  'and they are DISTINGUISHED: one consumed a slot, one did not')
check(joined.note !== already.note && /consumed a slot/.test(joined.note) && /consumed no slot/.test(already.note),
  `and each says which, in words the operator reads — "${already.note}"`)
check(joined.proven === false && already.proven === false,
  'neither claims the key is PROVEN — membership is what the relay says, not evidence it can authenticate')

// ------------------------------------------------------------------------------------------
console.log('\n4. NEGATIVE CONTROL — a failed policy read is not "no policy"')
check(node.policyReadVerdict({ status: 404 }).state === 'none',
  'a 404 IS "no policy configured" — the one status that genuinely means it')
check(node.policyReadVerdict({ status: 200, json: {} }).state === 'none',
  'and so is a 2xx carrying no policy object')
check(node.policyReadVerdict({ status: 200, json: { policy: { version: '1' } } }).state === 'present',
  'a 2xx carrying one is "present" — the guard does not refuse everything')
for (const s of [500, 502, 0, 403]) {
  const a = node.policyReadVerdict({ status: s }), b = web.policyReadVerdict({ status: s })
  check(same(a, b) && a.state === 'inconclusive' && a.exitCode === 3,
    `${s} is INCONCLUSIVE and exits 3 — never rounded to "no policy"`)
}

// ------------------------------------------------------------------------------------------
console.log('\n5. NEGATIVE CONTROL — consent is never inferred')
const POLICY = { version: '2026-01', age_attestation_required: true }
const NOAGE = { version: '2026-01', age_attestation_required: false }
check(node.policyGate({ policy: null }).ok === true,
  'no policy — the gate lets a claim straight through, so it is not refusing everything')
check(node.policyGate({ policy: NOAGE, accepted: true }).ok === true,
  'terms accepted where no attestation is required — allowed (POSITIVE CONTROL)')
check(node.policyGate({ policy: POLICY, accepted: false, ageConfirmed: true }).ok === false,
  'age confirmed but terms NOT accepted — refused')
check(node.policyGate({ policy: POLICY, accepted: true, ageConfirmed: false }).ok === false,
  'terms accepted but age NOT confirmed — refused; accepting terms does not imply the attestation')
const bothMissing = node.policyGate({ policy: POLICY })
check(bothMissing.ok === false && bothMissing.missing.length === 2,
  'neither given — refused, and it names BOTH rather than stopping at the first')
check(/statement about yourself/.test(bothMissing.reason),
  `and says why the attestation is not ours to make — "${bothMissing.missing[1].slice(0, 52)}…"`)
const allowed = node.policyGate({ policy: POLICY, accepted: true, ageConfirmed: true })
check(allowed.ok === true && allowed.body.age_confirmed === true && allowed.body.policy_version === '2026-01',
  'both given — allowed, carrying the version and the attestation as stated')
// The subtle one: where an attestation is NOT required, the operator's actual answer must go, not
// a convenient true.
const notRequired = node.policyGate({ policy: NOAGE, accepted: true, ageConfirmed: false })
check(notRequired.ok === true && notRequired.body.age_confirmed === false,
  'and where it is not required, `false` is sent — the operator\'s answer, not a convenient true')
check(node.policyGate({ policy: { age_attestation_required: false }, accepted: true }).ok === false,
  'an UNVERSIONED policy is refused — a receipt for it could not be tied to what was agreed')
for (const args of [{ policy: POLICY }, { policy: POLICY, accepted: true }, { policy: NOAGE, accepted: true }]) {
  check(same(node.policyGate(args), web.policyGate(args)), 'and both copies gate identically')
}

// ------------------------------------------------------------------------------------------
console.log('\n6. accept-policy — a receipt, or an inconclusive')
check(node.acceptOutcome({ status: 200, json: { receipt: 'r1' } }).receipt === 'r1',
  'a receipt comes back for the claim to carry (POSITIVE CONTROL)')
const noReceipt = node.acceptOutcome({ status: 200, json: {} })
check(noReceipt.ok === false && noReceipt.inconclusive === true && noReceipt.exitCode === 3,
  'a 2xx with NO receipt is inconclusive and exits 3 — nothing can tell whether it was recorded')
for (const res of [{ status: 200, json: { receipt: 'r' } }, { status: 429 }, { status: 400 }, { status: 500 }]) {
  check(same(node.acceptOutcome(res), web.acceptOutcome(res)), `acceptOutcome agrees on ${res.status}`)
}

// ------------------------------------------------------------------------------------------
console.log('\n7. the bounds, and that the twin carries the same ones')
check(node.MIN_TTL_SECS === web.MIN_TTL_SECS && node.MAX_TTL_SECS === web.MAX_TTL_SECS && node.MAX_USES === web.MAX_USES,
  `the bounds match: ttl ${web.MIN_TTL_SECS}–${web.MAX_TTL_SECS}s, uses ≤ ${web.MAX_USES}`)
check(node.checkMintBounds(3600, 1) === null && web.checkMintBounds(3600, 1) === null,
  'an ordinary mint passes both (POSITIVE CONTROL — the bounds do not refuse everything)')
for (const [ttl, uses] of [[1, 1], [99e9, 1], [3600, 0], [3600, 1e9]]) {
  const a = node.checkMintBounds(ttl, uses), b = web.checkMintBounds(ttl, uses)
  check(a !== null && a === b, `ttl=${ttl} uses=${uses} refused identically by both`)
}

// ------------------------------------------------------------------------------------------
console.log('\n8. the CLI reaches these verdicts from the same code, not its own copy')
const cli = readFileSync(join(ROOT, 'tools/relay-invite.mjs'), 'utf8')
check(/from '\.\.\/src\/relay_admission\.mjs'/.test(cli),
  'tools/relay-invite.mjs imports the decision layer')
// The point of the refactor: if the tool still formatted its own refusals, the console's wording
// could drift from the CLI's with nothing to catch it.
check(!/\brefusal\(/.test(cli.replace(/^\/\/.*$/gm, '')),
  'and no longer calls refusal() itself — one decision surface, not two')
for (const gone of ['--accept-terms once you have read it. Accepting', 'process.exit(4)\n  }\n  if (status === 401)']) {
  check(!cli.includes(gone), `the inlined copy of "${gone.slice(0, 34)}…" is gone from the tool`)
}

// ------------------------------------------------------------------------------------------
console.log('\n9. the browser client walks the sequence — against a relay that is a function')
// `console/admission-client.mjs` holds the socket the decision layer refuses to. Everything below
// injects `fetch` and `sign`, so the ORDER of calls, the bodies, and WHICH KEY SIGNED EACH ONE are
// assertable without a relay. That last one is the property with no other detector: the relay
// answers 200 to a claim signed by the operator, and it admits the operator a second time.
const OPERATOR = '1'.repeat(64)
const AGENT = '2'.repeat(64)

// A signer that stamps who it is into the event it returns, so a request can be traced to a key.
const fakeSigner = pubkey => async (template) => ({ ...template, pubkey, id: 'f'.repeat(64), sig: 'e'.repeat(128) })

// Reads the NIP-98 header back off the request the client actually sent. This is the only way to
// know which key signed: the body says nothing about it.
function signedBy(init) {
  const b64 = String(init.headers.authorization).replace(/^Nostr /, '')
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).pubkey
}

// A relay that records everything and answers from a table.
function fakeRelay(answers) {
  const calls = []
  const impl = async (url, init = {}) => {
    const path = new URL(url).pathname
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null,
      signer: init.headers?.authorization ? signedBy(init) : null })
    const a = answers[path]
    if (typeof a === 'function') return a()
    return { status: a?.status ?? 200, text: async () => JSON.stringify(a?.json ?? {}) }
  }
  return { impl, calls }
}

const RELAY = 'wss://relay.example'
const HAPPY = {
  '/api/invites': { status: 200, json: { code: 'INVITE-CODE', expires_at: 1 } },
  '/api/join-policy': { status: 404, json: { error: 'not found' } },
  '/api/invites/claim': { status: 200, json: { status: 'joined' } },
}

{
  const r = fakeRelay(HAPPY)
  const mint = await mintInvite({ relayUrl: RELAY, sign: fakeSigner(OPERATOR), ttlSecs: 3600, maxUses: 1, fetchImpl: r.impl })
  check(mint.ok && mint.code === 'INVITE-CODE', 'a mint returns the code, and the code is not folded into any message')
  check(r.calls[0].path === '/api/invites' && r.calls[0].method === 'POST', 'it POSTs /api/invites')
  check(same(r.calls[0].body, { ttl_secs: 3600, max_uses: 1 }), 'with the ttl and uses it was given, named as the relay names them')
  check(r.calls[0].signer === OPERATOR, 'SIGNED BY THE OPERATOR — minting needs owner/admin, which the agent does not hold')

  const pol = await readPolicy({ relayUrl: RELAY, fetchImpl: r.impl })
  check(pol.state === 'none', 'a 404 join-policy reads as "none" — the deployment has no policy')
  check(r.calls[1].signer === null, 'and the policy read carries NO auth header — asking for one would invent a relay requirement')

  const claim = await claimInvite({ relayUrl: RELAY, code: mint.code, policy: null, sign: fakeSigner(AGENT), fetchImpl: r.impl })
  check(claim.ok && claim.already === false, 'the claim succeeds and reports it JOINED')
  check(claim.proven === false, 'and carries proven:false — a relay_members row is not a key that has been seen to authenticate')
  check(r.calls[2].path === '/api/invites/claim' && same(r.calls[2].body, { code: 'INVITE-CODE' }),
    'the claim body is the code alone where no policy applies — no receipt invented')
  check(r.calls[2].signer === AGENT,
    'SIGNED BY THE AGENT — the claim inserts the SIGNING key\'s row, so an operator-signed claim admits the wrong key')
  check(r.calls.length === 3, 'and three calls in total — nothing extra was sent')
}

// The two keys, stated as data the page can render. Every entry names the key that signs it.
check(ADMISSION_PLAN.length === 3 && ADMISSION_PLAN.map(s => s.signedBy).join(',') === 'operator,agent,agent',
  'ADMISSION_PLAN says operator mints and the agent does both policy steps')

// ------------------------------------------------------------------------------------------
console.log('\n10. the policy path — a receipt, tied to the key that will claim')
{
  const r = fakeRelay({ ...HAPPY,
    '/api/join-policy': { status: 200, json: { policy: { version: 'v3', age_attestation_required: true } } },
    '/api/invites/accept-policy': { status: 200, json: { receipt: 'RCPT-1' } } })
  const pol = await readPolicy({ relayUrl: RELAY, fetchImpl: r.impl })
  check(pol.state === 'present' && pol.policy.version === 'v3', 'a configured policy reads as present, with its version')

  const claim = await claimInvite({ relayUrl: RELAY, code: 'C', policy: pol.policy,
    accepted: true, ageConfirmed: true, sign: fakeSigner(AGENT), fetchImpl: r.impl })
  check(claim.ok && claim.acceptedPolicy === true, 'the claim goes through, and says a policy was accepted on the way')
  const acc = r.calls.find(c => c.path === '/api/invites/accept-policy')
  check(same(acc.body, { code: 'C', policy_version: 'v3', age_confirmed: true }),
    'accept-policy sends the version and the operator\'s OWN answer on age')
  check(acc.signer === AGENT, 'and is signed by the AGENT — the receipt is tied to the key that claims')
  check(same(r.calls.at(-1).body, { code: 'C', policy_receipt: 'RCPT-1' }), 'the claim then carries that receipt')
  check(r.calls.indexOf(acc) < r.calls.length - 1, 'in that order — accept, then claim')
}

// NEGATIVE CONTROLS, all four, each made to fire.
{
  // (a) terms not accepted: nothing is sent at all.
  const r = fakeRelay(HAPPY)
  const out = await claimInvite({ relayUrl: RELAY, code: 'C', policy: { version: 'v3' },
    accepted: false, sign: fakeSigner(AGENT), fetchImpl: r.impl })
  check(!out.ok && out.gate === true, 'terms unaccepted REFUSES')
  check(/terms have not been accepted/.test(out.reason) && /your act, not this page/.test(out.reason),
    `and says which consent is missing, and whose act it is — "${out.reason.slice(0, 48)}…"`)
  check(r.calls.length === 0, 'and NOTHING was sent — the gate runs before a socket is opened')
}
{
  // (b) age required, terms accepted, age not: the derivation the checkbox makes easy.
  const r = fakeRelay(HAPPY)
  const out = await claimInvite({ relayUrl: RELAY, code: 'C', policy: { version: 'v3', age_attestation_required: true },
    accepted: true, ageConfirmed: false, sign: fakeSigner(AGENT), fetchImpl: r.impl })
  check(!out.ok && /age attestation/.test(out.reason),
    'accepting the terms does NOT carry the age attestation — the one is not derived from the other')
  check(r.calls.length === 0, 'and again nothing was sent')
}
{
  // (c) the failed policy read. This is the case that must not become "none".
  const r = { impl: async () => { throw new TypeError('Failed to fetch') } }
  const pol = await readPolicy({ relayUrl: RELAY, fetchImpl: r.impl })
  check(pol.state === 'inconclusive' && pol.exitCode === 3,
    'a policy read that never got a status is INCONCLUSIVE, not "no policy"')
  check(/unreachable, or it answered and its CORS policy/.test(pol.reason),
    'and names BOTH causes, because a browser cannot tell a CORS block from a dead host')
  check(!/no join policy|claiming directly/.test(pol.reason), 'and never says the deployment has no policy')
}
{
  // (d) POSITIVE CONTROL for (c): a policy read that DOES resolve is not reported as inconclusive.
  const r = fakeRelay(HAPPY)
  const pol = await readPolicy({ relayUrl: RELAY, fetchImpl: r.impl })
  check(pol.state === 'none', 'a reachable relay with no policy still reads as "none" — the guard does not refuse everything')
}
{
  // (e) a slow signer. The browser's own failure: a NIP-46 approval waits on a human, and NIP-98 is
  // checked against the RELAY's clock, so a stale signature comes back 401 and blames the key.
  const r = fakeRelay(HAPPY)
  let out = null, err = null
  try {
    out = await mintInvite({ relayUrl: RELAY, sign: fakeSigner(OPERATOR), ttlSecs: 3600, maxUses: 1,
      fetchImpl: r.impl, now: () => Math.floor(Date.now() / 1000) + web.MAX_SIGN_SKEW_SECS + 5 })
  } catch (e) { err = e }
  check(err !== null && out === null, `a signature ${web.MAX_SIGN_SKEW_SECS + 5}s stale REFUSES before the request goes`)
  check(/Nothing was sent/.test(err.message) && /±60s against the relay's clock/.test(err.message),
    'and says nothing was sent, and why the relay would have blamed the key')
  check(r.calls.length === 0, 'and the relay was never called')
  // POSITIVE CONTROL — the same signer inside the window still gets through.
  const ok = await mintInvite({ relayUrl: RELAY, sign: fakeSigner(OPERATOR), ttlSecs: 3600, maxUses: 1, fetchImpl: r.impl })
  check(ok.ok === true, 'while a prompt answered promptly still mints (POSITIVE CONTROL)')
}

// ------------------------------------------------------------------------------------------
console.log('\n11. the page wires it, and keeps the two signers apart')
const page = readFileSync(join(ROOT, 'console/index.html'), 'utf8')
// Only the module script, and only its code. Blanking string literals across the WHOLE file lets
// an apostrophe in HTML prose ("the agent's bunker") open a span that runs to the next one and
// swallows real code — which is how the positive control below caught this version of the check
// reporting clean over lines it had eaten.
const pageCode = [...page.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).join('\n').replace(/^\s*\/\/.*$/gm, '')
check(/from '\.\/admission-client\.mjs'/.test(page), 'index.html imports the client rather than assembling requests inline')
// The lift (#487/S1). The pairing used to be a `const signer` INSIDE the custody handler — which
// both threw it away and shadowed the operator's session under the same name.
check(/let agentSigner = null/.test(page), 'the proved pairing is held at flow scope as `agentSigner`')
// Against CODE, not prose: the comment that records why the shadow was removed quotes the old
// line verbatim, and reading the raw page here reported a shadow that no longer exists.
check(!/const signer = await nip46Signer/.test(pageCode),
  'and no longer shadows the operator\'s `signer` — a shadow the relay answers 200 to')
check(/agentSigner = paired/.test(page) && page.indexOf('agentSigner = paired') > page.indexOf('minted.secret.take()'),
  'it is assigned only AFTER custody proves — never a signer that failed the check')
check(/agentSigner = null/.test(page) && /forgetMintedKey/.test(page), 'and is cleared with the rest of the key\'s flow')
// Which signer each call gets. Asserted on the page, because the client cannot enforce it: both
// arguments are functions and either would satisfy the type.
check(/mintInvite\({ relayUrl, sign: t => signFresh\(t, signer\)/.test(page),
  'the MINT is signed by the operator\'s console session')
check(/sign: t => signFresh\(t, agentSigner\)/.test(page),
  'and the CLAIM by the agent\'s bunker — the two are not interchangeable')
// Through the staleness chokepoint like every other signing act here (#418): a stale module graph
// means the body was built by code the operator cannot see, and the signature is the irreversible part.
check(!/signer\.signEvent\(|agentSigner\.signEvent\(/.test(pageCode),
  'neither is asked to sign directly — both go through signFresh')
// Consent. A checked attribute in the markup would tick the box for the operator.
const boxes = page.match(/<input type="checkbox" id="admit-(terms|age)"[^>]*>/g) || []
check(boxes.length === 2, 'there are exactly two consent boxes')
check(boxes.every(b => !/\bchecked\b/.test(b)), 'and NEITHER is pre-ticked in the markup')
check(/accepted: \$\('admit-terms'\)\.checked === true/.test(page) && /ageConfirmed: \$\('admit-age'\)\.checked === true/.test(page),
  'each is read from its own box — neither derived from the other')
// The bearer secret.
check(/let invite = null/.test(page) && !/localStorage[^\n]*invite|invite[^\n]*localStorage/.test(page),
  'the invite code lives in a variable for the flow and is never put in storage')
// An ALLOWLIST of the shapes the code may appear in, not a hunt for sinks. Three versions of a
// sink-scan got this wrong in three different ways — `textContent` alone missed the page's own
// `admitSt()` helper; whole-line matching flagged `if (!invite)`, which is a guard; and blanking
// string literals to tell code from prose ate real lines whenever an apostrophe in English text
// opened a span. Regex is not a JavaScript lexer and this stopped pretending otherwise.
//
// Inverted, it also reads better under review: every use is enumerated, so a NEW one fails here
// until somebody writes it down — which is the moment to ask whether a bearer secret belongs there.
const stripStrings = l => l.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
const ALLOWED_USES = [
  /^let invite = null$/,                       // declared for the flow
  /^invite = null; policyVerdict = null$/,     // cleared with the rest of the key's state
  /^invite = out\.code$/,                      // held, once, from the mint
  /^if \(!invite\) \{ admitSt\(''?, ''?\); return \}$/, // a guard: tested, never rendered
  /^code: invite,$/,                           // handed to the claim, which is its whole purpose
]
const uses = pageCode.split('\n').map(l => stripStrings(l).trim())
  .filter(l => /(?<![A-Za-z])invite(?![A-Za-z-])/.test(l))
const unlisted = uses.filter(l => !ALLOWED_USES.some(re => re.test(l)))
check(unlisted.length === 0,
  `the code is used in ${uses.length} places and every one is on the allowlist${unlisted.length ? ` — UNLISTED: ${unlisted.join(' | ')}` : ''}`)
// POSITIVE CONTROLS. An empty scan, or a page that had stopped holding the code, would each report
// clean — and would read exactly like a correct result.
check(uses.length === ALLOWED_USES.length,
  `and every listed shape is actually present (${uses.length}) — an allowlist longer than the code is a rule nothing enforces`)
check(pageCode.length > 5000, `and the scan read a real script block (${pageCode.length} bytes)`)

// The refusal text the page renders must not answer with a command-line flag — that is the terminal
// this whole change exists to remove.
for (const [name, mod] of [['src', node], ['console', web]]) {
  const r = mod.refusal(403, { error: 'join_policy_required' })
  check(/Accept the terms first/.test(r) && !/--accept-terms|--confirm-age/.test(r),
    `the ${name} copy explains a policy refusal as an ACT, not as a CLI flag`)
}
// And the flag did not vanish with it — the CLI still tells its own operator what to re-run with.
// Removing a switch from a shared string is only correct if the tool that needs it still says it.
check(/Re-run with --accept-terms/.test(cli) && /--accept-terms\s+accept this deployment/.test(cli),
  'while the CLI still names --accept-terms itself, in its guidance and its usage')

console.log(`\n${pass} passed, ${fail} failed`)
assert.equal(fail, 0, `${fail} assertion(s) failed`)
