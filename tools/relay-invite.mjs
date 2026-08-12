#!/usr/bin/env node
// relay-invite.mjs — mint and claim a Buzz relay invite (#357).
//
// WHY THIS EXISTS. Getting an agent's `@Name` to resolve needs a kind:0 authored by the agent's
// own key, on the community relay — and the relay refuses that key at NIP-42 AUTH because it is
// not in `relay_members` (#344). Buzz ships the way out already: `POST /api/invites` mints an
// invite, and `POST /api/invites/claim` is *deliberately exempt from the relay-membership gate*
// and inserts the `relay_members` row that the AUTH gate reads. So a claimed key becomes a real
// relay member with nobody granting it anything by hand.
//
// That chain is source-verified twice and LIVE-UNVERIFIED. Two facts are open, and this tool is
// the instrument for both:
//
//   1. Does the key you sign with hold `owner` or `admin` in `relay_members`? `mint` answers it.
//      A 403 is as useful as a code — it turns an open-ended ask into one line for the operator.
//   2. Does a claimed key actually pass AUTH on the deployed build? `claim` sets that up.
//
//   BUZZ_RELAY_URL=<same value the buzz CLI uses>  node tools/relay-invite.mjs mint \
//       --key ~/.nvoy/owner.nsec --ttl 3600 --uses 1 --out ~/.nvoy/invite.code
//   BUZZ_RELAY_URL=…                               node tools/relay-invite.mjs claim \
//       --key ~/.nvoy/agent.nsec --code-file ~/.nvoy/invite.code \
//       [--accept-terms --confirm-age]
//
// THE JOIN POLICY IS NOT OPTIONAL WHERE ONE IS CONFIGURED. The v2 claim path refuses without a
// `policy_receipt` whenever the deployment has a join policy, and the community relay has one
// today with age attestation required — so `claim` without it is a guaranteed
// `403 join_policy_required`, not a maybe. `GET /api/join-policy` is unauthenticated and says
// whether one applies; `POST /api/invites/accept-policy` needs no auth either and returns the
// receipt. This tool does that handshake, but only when you say so.
//
// `age_confirmed` IS A LEGAL ATTESTATION BY A PERSON. It is behind `--confirm-age`, it is never
// inferred, and the policy version being accepted is printed before it is sent. A tool that
// quietly attests to a human's age on their behalf is a worse defect than the 403 it fixes.
//
// TWO SECRETS, NEITHER OF THEM PRINTED. The signing key is read from a FILE and never from argv or
// an environment variable, because argv is visible in `ps` and shell history. The invite code is a
// reusable bearer secret — anyone holding it can join the relay — so it is written to a 0600 file
// and this tool prints the PATH. There is no flag that prints either value.
//
// NIP-98 replay: `created_at` is second-granularity and the relay keeps a replay cache, so two
// identical calls inside the same second produce the same event id and the second is refused.
// Irrelevant by hand, real in a retry loop — so a retry here waits out the second rather than
// hammering, and the refusal is named rather than reported as a signature failure.
//
// Exit: 0 ok · 1 bad input · 2 relay/network · 3 INCONCLUSIVE (it ran, and could not tell you)
//       4 the relay answered, and its answer is a refusal — that IS the result, not a failure.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { nip19 } from 'nostr-tools'
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { nip98Template, nip98Header, expectedUrl } from '../console/nip98.mjs'
import { refusal, checkMintBounds } from '../src/relay_invite.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const arg = (name, fallback = null) => {
  // `--name=value` first, because it is unambiguous: the separated form below cannot tell a
  // value that begins with `--` from the next flag, so `--out --weird` reads as "missing".
  const eq = argv.find(a => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)
const die = (msg, code = 1) => { console.error(`relay-invite: ${msg}`); process.exit(code) }
const expand = (p) => (String(p).startsWith('~/') ? resolve(homedir(), String(p).slice(2)) : resolve(String(p)))

const USAGE = `usage:
  BUZZ_RELAY_URL=… node tools/relay-invite.mjs mint  --key <path> [--ttl 3600] [--uses 1] [--out <path>]
  BUZZ_RELAY_URL=… node tools/relay-invite.mjs claim --key <path> --code-file <path>
                                                     [--accept-terms] [--confirm-age]

  --accept-terms   accept this deployment's join policy (required where one is configured)
  --confirm-age    attest, as a person, that the age requirement is met. Never inferred.`

if (!cmd || !['mint', 'claim'].includes(cmd)) die(USAGE)

// --- the signing key: from a file, mode-checked, never echoed -----------------------------------
function readSecret(pathArg) {
  if (!pathArg) die(`--key <path> is required. The key is read from a file, never from argv.\n${USAGE}`)
  const p = expand(pathArg)
  if (!existsSync(p)) die(`no key file at ${p}`)
  const mode = statSync(p).mode & 0o777
  // A world- or group-readable key file is a finding, not a warning to scroll past.
  if (mode & 0o077) die(`${p} is mode ${mode.toString(8)} — a signing key must be 0600. Fix it before using this.`, 1)
  const raw = readFileSync(p, 'utf8').trim()
  if (/^nsec1/i.test(raw)) { try { return nip19.decode(raw).data } catch { die(`${p} does not contain a decodable nsec`) } }
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw.toLowerCase(), 'hex')
  die(`${p} holds neither an nsec nor a 64-character hex key`)
}

async function post(path, bodyObj, secret) {
  const url = expectedUrl(process.env.BUZZ_RELAY_URL, path)
  // console/nip98.mjs deliberately does not sign — the console signs through the operator's own
  // signer and this tool signs with a key from a file, so neither can be baked into the builder.
  // It lives in console/ because the page is its other caller; see the header there.
  const { template, body } = await nip98Template({ url, method: 'POST', body: JSON.stringify(bodyObj) })
  const header = nip98Header(finalizeEvent(template, secret))
  let res
  try {
    // The SAME string that was hashed. Re-serialising here would sign one set of bytes and send
    // another, and the relay's refusal ("payload tag SHA-256 mismatch") reads like a signing bug.
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: header }, body })
  } catch (e) { die(`could not reach the relay: ${e.message}`, 2) }
  let json = null
  const text = await res.text().catch(() => '')
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: res.status, json, text }
}

// Unauthenticated GET — `/api/join-policy` takes no auth, and asking for one would be the tool
// inventing a requirement the relay does not have.
async function get(path) {
  const url = expectedUrl(process.env.BUZZ_RELAY_URL, path)
  let res
  try { res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } }) }
  catch (e) { die(`could not reach the relay: ${e.message}`, 2) }
  const text = await res.text().catch(() => '')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: res.status, json, text }
}

// `refusal()` and the bounds live in ../src/relay_invite.mjs so the test can call them directly.

// --- mint --------------------------------------------------------------------------------------
if (cmd === 'mint') {
  const secret = readSecret(arg('key'))
  const ttl = Number(arg('ttl', '3600'))
  const uses = Number(arg('uses', '1'))
  // Caught here rather than at the relay: a 400 comes back as exit 2, "relay/network", which
  // sends the operator looking at their connection over a number they typed.
  const bad = checkMintBounds(ttl, uses)
  if (bad) die(bad)
  const out = expand(arg('out', '~/.nvoy/relay-invite.code'))
  if (existsSync(out)) die(`${out} already exists. Refusing to overwrite — an invite code file is a bearer secret; move it aside if you mean to replace it.`)

  console.log(`relay-invite: minting as ${nip19.npubEncode(getPublicKey(secret))}`)
  const { status, json, text } = await post('/api/invites', { ttl_secs: ttl, max_uses: uses }, secret)

  if (status === 403) {
    console.error('relay-invite: 403 — this key does not hold owner or admin in relay_members.')
    console.error('  That IS the answer to the first open question in #357: minting needs the role,')
    console.error('  and the ask to the relay operator is one line — put this key in relay_members as admin.')
    // Exit 4, not 1. The tool worked perfectly and delivered its answer; 1 means "you invoked it
    // wrong", which in a script reads as operator error over a correct, complete result.
    process.exit(4)
  }
  if (status === 401) die(`401 — the relay rejected the signature: ${refusal(status, json, text)}`, 1)
  if (status === 429) die(`429 — ${refusal(status, json, text)}`, 4)
  if (status < 200 || status >= 300) die(`${status} — ${refusal(status, json, text)}`, 2)

  const code = json?.code
  if (!code) die(`${status} but no code in the response — cannot tell whether an invite was created. Check the relay before minting again.`, 3)

  const dir = dirname(out)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(out, `${code}\n`, { mode: 0o600 })
  const mode = (statSync(out).mode & 0o777).toString(8)
  if (mode !== '600') die(`wrote ${out} but its mode is ${mode}, not 600. Delete it and fix the permissions.`, 3)

  console.log('')
  console.log('  Invite minted. The code is a BEARER SECRET — anyone holding it can join this relay.')
  console.log(`  Written to (mode 600 — never paste it into a chat, an issue, or a log):`)
  console.log(`    ${out}`)
  if (json.expires_at) console.log(`  Expires: ${new Date(Number(json.expires_at) * 1000).toISOString()}`)
  if (json.max_uses != null) console.log(`  Uses: ${json.max_uses}`)
  console.log('')
  process.exit(0)
}

// --- claim -------------------------------------------------------------------------------------
if (cmd === 'claim') {
  const secret = readSecret(arg('key'))
  const codePath = arg('code-file')
  if (!codePath) die(`--code-file <path> is required. The code is read from a file, never from argv.\n${USAGE}`)
  const cp = expand(codePath)
  if (!existsSync(cp)) die(`no code file at ${cp}`)
  const code = readFileSync(cp, 'utf8').trim()
  if (!code) die(`${cp} is empty`)

  const joiner = getPublicKey(secret)
  console.log(`relay-invite: claiming as ${nip19.npubEncode(joiner)}`)

  // --- the join policy, before the claim ---------------------------------------------------------
  // The v2 claim path refuses without a receipt wherever a policy is configured, so asking first
  // turns a guaranteed 403 into either a receipt or an accurate explanation of what is needed.
  let policyReceipt = null
  const pol = await get('/api/join-policy')
  const policy = pol.json?.policy ?? null
  if (pol.status >= 200 && pol.status < 300 && policy) {
    const version = String(policy.version || '')
    const needsAge = policy.age_attestation_required === true
    if (!version) die('the relay returned a join policy with no version — cannot accept it safely.', 3)

    console.log('')
    console.log('  This relay has a JOIN POLICY, and a claim without accepting it is refused.')
    console.log(`    policy version:   ${version}`)
    console.log(`    age attestation:  ${needsAge ? 'REQUIRED' : 'not required'}`)
    console.log('')

    if (!flag('accept-terms')) {
      console.error('relay-invite: not accepting the policy on your behalf.')
      console.error('  Re-run with --accept-terms once you have read it. Accepting a deployment\'s')
      console.error('  terms is the operator\'s act, not the tool\'s.')
      process.exit(4)
    }
    if (needsAge && !flag('confirm-age')) {
      console.error('relay-invite: this policy requires an AGE ATTESTATION, which is a statement by a')
      console.error('  person about themselves. It is not inferred from --accept-terms, and this tool')
      console.error('  will not assert it for you. Re-run with --confirm-age if it is true of you.')
      process.exit(4)
    }

    const acc = await post('/api/invites/accept-policy',
      // Exactly what the operator stated — never derived from needsAge. If the policy requires it
      // the flag was already enforced above, so this is true there; where it is not required this
      // sends false rather than a convenient true.
      { code, policy_version: version, age_confirmed: flag('confirm-age') }, secret)
    if (acc.status === 429) die(`429 — ${refusal(acc.status, acc.json, acc.text)}`, 4)
    if (acc.status < 200 || acc.status >= 300)
      die(`accept-policy ${acc.status} — ${refusal(acc.status, acc.json, acc.text)}`,
        acc.status >= 400 && acc.status < 500 ? 4 : 2)
    policyReceipt = acc.json?.receipt
    if (!policyReceipt)
      die(`accept-policy returned ${acc.status} but no receipt — cannot tell whether the acceptance was recorded.`, 3)
    console.log(`  Policy ${version} accepted; receipt held for the claim.`)
  } else if (pol.status === 404 || (pol.status >= 200 && pol.status < 300 && !policy)) {
    console.log('relay-invite: no join policy configured on this deployment — claiming directly.')
  } else {
    // Never guess "probably no policy" from a failed read: that turns into a 403 the operator
    // cannot explain. Being unable to check is not the same as being fine.
    die(`could not read the join policy (${pol.status}) — refusing to guess whether one applies.`, 3)
  }

  const body = policyReceipt ? { code, policy_receipt: policyReceipt } : { code }
  const { status, json, text } = await post('/api/invites/claim', body, secret)

  if (status === 401) die(`401 — the relay rejected the signature: ${refusal(status, json, text)}`, 1)
  if (status === 403 || status === 429) die(`${status} — ${refusal(status, json, text)}`, 4)
  if (status < 200 || status >= 300) die(`${status} — ${refusal(status, json, text)}`, 2)

  // "Joined" and "already a member" are both success, and they are DIFFERENT facts. Collapsing
  // them would hide a re-run that consumed nothing from a first claim that consumed a slot.
  const outcome = json?.status || json?.outcome || (json ? JSON.stringify(json).slice(0, 120) : '(no body)')
  console.log('')
  console.log(`  ${status} — ${outcome}`)
  console.log('')
  console.log('  This key should now be in relay_members. That is NOT the same as having proved it:')
  console.log('  the next step is to publish one kind:0 from this key against the community relay and')
  console.log('  read it back cold. Until that lands, treat AUTH as untested (#357).')
  console.log('')
  // The code outlives the claim, and may still have uses on it. A bearer secret nobody needs is
  // one nobody is guarding.
  console.log('  The invite code is still on disk and is still a bearer secret. If you are done with it:')
  console.log(`    rm ${cp}`)
  console.log('')
  process.exit(0)
}
