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
// A BUNKER-HELD KEY CAN CLAIM (#477). This tool shipped signing only with `finalizeEvent` over a
// key read from disk — so the one class of identity #367 mandates, an agent whose key lives in the
// owner's Bunker and never on this host, could not claim the invite that would admit it. The whole
// chain above was reachable by every key except the ones it was built for. `--key` still works, for
// the owner minting and for a direct-nsec agent; a NIP-46 pairing is now the alternative:
//
//   WAGGLE_BUNKER_URI_FILE=… WAGGLE_NIP46_CLIENT_NSEC_FILE=… BUZZ_RELAY_URL=… \
//       node tools/relay-invite.mjs claim --code-file ~/.nvoy/invite.code --accept-terms
//
// ONE SOURCE, NEVER A PREFERENCE. `--key` and a pairing together is refused rather than resolved by
// precedence — see `chooseSigningSource` in ../src/relay_invite.mjs for why that refusal is the
// safe behaviour and a silent winner is not. Every signature is verified and pinned to one identity
// (`withPinnedCustody`), because a bunker answers each `sign_event` as an independent round trip:
// proving the accept-policy signature proves nothing about the claim signature that follows it.
//
// WHICH identity that is gets ASKED, never read off the URI. `bunker://<hex>` names the remote
// signer, and NIP-46 lets that key differ from the user identity it holds — so the hex is a
// transport address, and `get_public_key` is what resolves who actually signs. Set EXPECT_PUBKEY to
// pin explicitly; unset, it pins to the resolved identity.
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

import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { generateSecretKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { checkPastedBunkerUri, findBunkerUriExposure, planClientKey } from '../src/bunker_paste.mjs'
import { nip98Template, nip98Header, expectedUrl } from '../src/nip98.mjs'
import { loadBunkerSignerFiles, makeBunkerSigner, makeLocalSigner, withPinnedCustody } from '../src/nostr_signer.mjs'
// `refusal` is no longer imported here: every status this tool acts on now goes through
// src/relay_admission.mjs, which formats the reason. An import left behind would be the only
// remaining way for the CLI's wording to drift from the console's.
import { checkMintBounds,
  SIGN_TIMEOUT_MS, MAX_SIGN_SKEW_SECS, NIP98_WINDOW_SECS } from '../src/relay_invite.mjs'
import { resolveSigner, signerBanner } from '../src/relay_invite_signer.mjs'
import { acceptOutcome, claimOutcome, mintOutcome, policyGate, policyReadVerdict } from '../src/relay_admission.mjs'

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
  BUZZ_RELAY_URL=… node tools/relay-invite.mjs mint  --bunker [--ttl 3600] [--uses 1] [--out <path>]
  BUZZ_RELAY_URL=… node tools/relay-invite.mjs claim --bunker --code-file <path>
                                                     [--accept-terms] [--confirm-age]

  --accept-terms   accept this deployment's join policy (required where one is configured)
  --confirm-age    attest, as a person, that the age requirement is met. Never inferred.

  ONE signing source, named explicitly — never two. A claim writes a relay_members row that
  cannot be removed without whichever key signs (#366), so an ambiguous run is refused.

    --bunker              paste a bunker:// URI at a hidden prompt (#480). Not echoed, not saved;
                          only the NIP-46 client key persists, so later runs need no re-approval.
                          A URI in argv or an env var is REFUSED — both are recorded.
    --key <path>          a mode-0600 file holding an nsec or 64-hex key.
    WAGGLE_BUNKER_URI_FILE=<path>  WAGGLE_NIP46_CLIENT_NSEC_FILE=<path>
                          a pairing an administrator seated for an agent runtime (#477/#367).

    EXPECT_PUBKEY=<64-hex>  optional with any source; pins which identity may sign.`

if (!cmd || !['mint', 'claim'].includes(cmd)) die(USAGE)

// --- the signing key: from a file, mode-checked, never echoed -----------------------------------
// Returns the file's TEXT, not a decoded key — `makeLocalSigner` does the decoding, and this stays
// the place that checks the file itself, which a signer built from an env var has no path to check.
function readKeyText(pathArg) {
  const p = expand(pathArg)
  if (!existsSync(p)) die(`no key file at ${p}`)
  const mode = statSync(p).mode & 0o777
  // A world- or group-readable key file is a finding, not a warning to scroll past.
  if (mode & 0o077) die(`${p} is mode ${mode.toString(8)} — a signing key must be 0600. Fix it before using this.`, 1)
  const raw = readFileSync(p, 'utf8').trim()
  // Decoded here and thrown away, only so the failure names the file. `makeLocalSigner`'s own
  // message is about a credential, and the operator needs to know WHICH file is wrong.
  //
  // Lower-cased on the way out because bech32 is case-insensitive and `nip19.decode` accepts an
  // all-uppercase NSEC1…, but `makeLocalSigner` tests `startsWith('nsec1')` case-sensitively — so an
  // uppercase key file would pass this check, fall through to the hex branch, and be refused as
  // "not a valid nsec or 64-hex key", which is untrue of the file it is describing.
  if (/^nsec1/i.test(raw)) { try { nip19.decode(raw) } catch { die(`${p} does not contain a decodable nsec`) } return raw.toLowerCase() }
  if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase()
  die(`${p} holds neither an nsec nor a 64-character hex key`)
}

// --- pasting a bunker URI (#480) ----------------------------------------------------------------
// The prompt REQUIRES an interactive terminal, and reads from `process.stdin` rather than opening
// /dev/tty. Both halves of that are load-bearing:
//
//   - A pipe or a heredoc is refused rather than accepted, because both are routes by which the
//     connect secret ends up in a file or a history. Falling back to stdin when there is no
//     terminal would quietly defeat the reason this prompt exists.
//   - Echo suppression only works on a stream readline can put in raw mode. A stream opened from
//     /dev/tty has no `setRawMode`, so readline cannot take over the echoing, the terminal driver
//     keeps doing it, and the pasted URI appears on screen — while the prompt says it will not.
//     `process.stdin` on a TTY has it. Found by running this through a pty; it is invisible to
//     every check that does not.
function promptHidden(question) {
  return new Promise((ok, no) => {
    const input = process.stdin, output = process.stdout
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      return no(new Error('--bunker needs an interactive terminal. stdin here is not one, and this ' +
        'tool will not read a bunker URI from a pipe or a heredoc:\n' +
        '  the URI carries a connect secret, and both of those put it in a file.\n' +
        '  Run it from a shell, or use --key / WAGGLE_BUNKER_URI_FILE instead.'))
    }
    const rl = createInterface({ input, output, terminal: true })
    let muted = false, settled = false
    // Nothing is echoed — not even asterisks, which leak the length. Announced, because a prompt
    // that swallows keystrokes with no warning reads as a hung tool.
    rl._writeToOutput = (s) => { if (!muted) output.write(s) }
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      muted = false
      output.write('\n')
      rl.close()
      fn(arg)
    }
    // A closed input has to REJECT. Without this the promise never settles, and Ctrl-D or Ctrl-C
    // at the prompt exits 13 on an unsettled top-level await rather than saying anything.
    rl.on('close', () => finish(no, new Error('the prompt was closed before a URI was entered — nothing was signed')))
    rl.on('SIGINT', () => finish(no, new Error('cancelled at the prompt — nothing was signed')))
    output.write(`${question}\n(nothing will appear as you paste)\n> `)
    muted = true
    rl.question('', (answer) => finish(ok, answer))
  })
}

// The CLIENT key, persisted; the URI never is. A NIP-46 bunker authorizes a specific client
// keypair, so a fresh one each run is an app the signer has never seen — some refuse it outright
// as "Unknown client", and the rest ask for approval again. Same reasoning and same 0600 file as
// tools/grant.mjs:56-66.
function clientKeyHex() {
  const dir = process.env.WAGGLE_HOME ? expand(process.env.WAGGLE_HOME) : resolve(homedir(), '.waggle')
  const path = resolve(dir, 'relay-invite-client.key')
  let existing = null
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777
    if (mode & 0o077) die(`${path} is mode ${mode.toString(8)} — the NIP-46 client key must be 0600.`, 1)
    existing = readFileSync(path, 'utf8')
  }
  const plan = planClientKey(existing)
  if (plan.error) die(`${path}: ${plan.error}`, 1)
  if (!plan.create) return plan.hex

  const hex = Buffer.from(generateSecretKey()).toString('hex')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path, `${hex}\n`, { mode: 0o600 })
  console.error(`relay-invite: new NIP-46 client key saved to ${path}`)
  console.error('  Approve this app in your signer once — later runs reuse it and will not ask again.')
  return hex
}

async function loadPastedBunker() {
  const answer = await promptHidden('Paste the bunker:// URI from your signer\'s "connect an app" flow.')
  const parsed = checkPastedBunkerUri(answer)
  if (parsed.error) die(parsed.error, 1)
  if (!parsed.hasSecret) {
    // Not fatal: a URI re-copied after this client key was already authorized has no secret left,
    // and that run is legitimate. Said out loud because if the pairing ISN'T established the
    // bunker answers "Unknown client", which reads as a broken tool rather than a missing secret.
    console.error('relay-invite: the URI carries no secret. That is expected on a re-run with an ' +
      'already-approved client key,\n  and is the cause of "Unknown client" if this is the first pairing.')
  }
  // The client key is resolved BEFORE the connecting message, so "a new key was saved, approve it
  // once" is read before "approve the prompt" rather than after it.
  const client = clientKeyHex()
  console.error(`relay-invite: connecting to the signer over ${parsed.relays.length} relay(s) — approve the prompt.`)
  return makeBunkerSigner(parsed.uri, nip19.nsecEncode(Uint8Array.from(Buffer.from(client, 'hex'))), {
    uriLabel: 'the pasted bunker URI',
    clientLabel: 'the saved NIP-46 client key',
  })
}

/**
 * The one signer for this run — pasted bunker, local file, or seated pairing; chosen explicitly,
 * custody pinned.
 *
 * The decisions live in ../src/relay_invite_signer.mjs so they can be driven with a signer whose
 * identity differs from its pairing address. What stays here is the environment, the file checks,
 * and turning a refusal into an exit code — none of which is a choice about which key signs.
 */
async function buildSigner(what) {
  const keyArg = arg('key')
  // Before the prompt, not after: a URI already in argv or the environment is a secret already
  // recorded, and prompting for a second one would leave the operator believing it was not.
  const exposed = findBunkerUriExposure(argv, process.env)
  if (exposed.error) die(exposed.error, 1)

  const result = await resolveSigner({
    keyArg,
    uriFile: String(process.env.WAGGLE_BUNKER_URI_FILE || '').trim(),
    clientFile: String(process.env.WAGGLE_NIP46_CLIENT_NSEC_FILE || '').trim(),
    paste: flag('bunker'),
    expect: process.env.EXPECT_PUBKEY,
    what,
  }, {
    loadBunker: (uriFile, clientFile) => loadBunkerSignerFiles(uriFile, clientFile),
    loadLocal: (path) => makeLocalSigner(readKeyText(path), expand(path)),
    loadPaste: () => loadPastedBunker(),
    pin: withPinnedCustody,
  })

  if (result.error) {
    // Close first: a bunker pool holds the process open, and this path exits without publishing.
    try { result.signer?.close() } catch { /* nothing published; a quiet close is fine */ }
    die(result.usage ? `${result.error}\n\n${USAGE}` : result.error, result.code)
  }
  return result
}

async function post(path, bodyObj, signer) {
  const url = expectedUrl(process.env.BUZZ_RELAY_URL, path)
  // src/nip98.mjs deliberately does not sign — the console signs through the operator's own
  // signer and this tool signs with a key from a file or a bunker pairing, so none of them can be
  // baked into the builder. It lives in console/ because the page is its other caller.
  const { template, body } = await nip98Template({ url, method: 'POST', body: JSON.stringify(bodyObj) })
  let signed
  // A custody mismatch or an unverifiable signature carries its own exit code from the wrapper (1
  // and 2). Anything else — a bunker timeout, a refused approval — is the signer failing to sign,
  // which is exit 2 and not a relay result.
  try { signed = await signer.signEvent(template, { timeoutMs: SIGN_TIMEOUT_MS }) }
  catch (e) { die(e.message, e.exitCode || 2) }
  // How old the signature is by the time we hold it. The relay checks this against ITS clock and
  // answers 401, which reads as "your key is wrong" — so it is named here, before the request goes,
  // in terms of the thing that was actually slow.
  const age = Math.floor(Date.now() / 1000) - Number(signed.created_at)
  if (age > MAX_SIGN_SKEW_SECS) {
    die(`the signature came back ${age}s after the request was stamped, and NIP-98 allows ` +
      `±${NIP98_WINDOW_SECS}s against the relay's clock.\n` +
      '  Nothing was sent — the relay would have refused it as stale and blamed the key.\n' +
      `  ${signer.remote ? 'Approve the bunker prompt more promptly and re-run.' : 'Check this host\'s clock against the relay\'s.'}`, 2)
  }
  const header = nip98Header(signed)
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
  const chosen = await buildSigner('minting an invite')
  const signer = chosen.signer
  const ttl = Number(arg('ttl', '3600'))
  const uses = Number(arg('uses', '1'))
  // Caught here rather than at the relay: a 400 comes back as exit 2, "relay/network", which
  // sends the operator looking at their connection over a number they typed.
  const bad = checkMintBounds(ttl, uses)
  if (bad) die(bad)
  const out = expand(arg('out', '~/.nvoy/relay-invite.code'))
  if (existsSync(out)) die(`${out} already exists. Refusing to overwrite — an invite code file is a bearer secret; move it aside if you mean to replace it.`)

  // Built in src/relay_invite_signer.mjs from the RESOLVED identity. As a bare console.log here it
  // was untestable, and printing the pairing's transport address instead went unnoticed.
  console.log(signerBanner('minting', chosen))
  const res = await post('/api/invites', { ttl_secs: ttl, max_uses: uses }, signer)
  const json = res.json
  // Every status the relay can answer, and the exit code for each, live in src/relay_admission.mjs
  // so the console reaches the same verdicts from the same code (#487). Exit 4 on a 403, not 1:
  // the tool worked perfectly and delivered its answer, and 1 means "you invoked it wrong", which
  // in a script reads as operator error over a correct, complete result.
  const minted = mintOutcome(res)
  if (!minted.ok) die(minted.reason, minted.exitCode)
  const code = minted.code

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
  signer.close()
  process.exit(0)
}

// --- claim -------------------------------------------------------------------------------------
if (cmd === 'claim') {
  const chosen = await buildSigner('a claim')
  const signer = chosen.signer
  const codePath = arg('code-file')
  if (!codePath) die(`--code-file <path> is required. The code is read from a file, never from argv.\n${USAGE}`)
  const cp = expand(codePath)
  if (!existsSync(cp)) die(`no code file at ${cp}`)
  const code = readFileSync(cp, 'utf8').trim()
  if (!code) die(`${cp} is empty`)

  console.log(signerBanner('claiming', chosen))
  if (signer.remote) {
    console.log('  Signing through NIP-46 — the bunker will prompt for approval, TWICE where a join')
    console.log('  policy applies (accept-policy, then the claim). An unanswered prompt times out.')
  }

  // --- the join policy, before the claim ---------------------------------------------------------
  // The v2 claim path refuses without a receipt wherever a policy is configured, so asking first
  // turns a guaranteed 403 into either a receipt or an accurate explanation of what is needed.
  let policyReceipt = null
  // The three verdicts — present / none / inconclusive — are in src/relay_admission.mjs, so the
  // console cannot quietly grow a two-way version of this. A failed read is NOT "no policy":
  // guessing turns into a 403 at claim time that nothing explains, and being unable to check is
  // not the same as being fine.
  const verdict = policyReadVerdict(await get('/api/join-policy'))
  if (verdict.state === 'inconclusive') die(verdict.reason, verdict.exitCode)
  if (verdict.state === 'none') {
    console.log('relay-invite: no join policy configured on this deployment — claiming directly.')
  } else {
    const policy = verdict.policy
    const needsAge = policy.age_attestation_required === true

    console.log('')
    console.log('  This relay has a JOIN POLICY, and a claim without accepting it is refused.')
    console.log(`    policy version:   ${policy.version ?? policy.policy_version ?? '(none)'}`)
    console.log(`    age attestation:  ${needsAge ? 'REQUIRED' : 'not required'}`)
    console.log('')

    // What the OPERATOR stated, passed through as stated. `policyGate` never derives the age
    // attestation from accepting the terms — it is a statement by a person about themselves, and
    // no tool asserts it for them.
    const gate = policyGate({ policy, accepted: flag('accept-terms'), ageConfirmed: flag('confirm-age') })
    if (!gate.ok) {
      console.error(`relay-invite: not claiming — ${gate.reason}.`)
      console.error('  Accepting a deployment\'s terms is the operator\'s act, not the tool\'s.')
      console.error('  Re-run with --accept-terms once you have read it' +
        (needsAge ? ', and --confirm-age if that is true of you.' : '.'))
      process.exit(4)
    }

    const acc = acceptOutcome(await post('/api/invites/accept-policy', { code, ...gate.body }, signer))
    if (!acc.ok) die(acc.reason, acc.exitCode)
    policyReceipt = acc.receipt
    console.log(`  Policy ${gate.body.policy_version} accepted; receipt held for the claim.`)
  }

  const body = policyReceipt ? { code, policy_receipt: policyReceipt } : { code }
  const claimRes = await post('/api/invites/claim', body, signer)
  // "Joined" and "already a member" are both success, and they are DIFFERENT facts. Collapsing
  // them would hide a re-run that consumed nothing from a first claim that consumed a slot.
  const claimed = claimOutcome(claimRes)
  if (!claimed.ok) die(claimed.reason, claimed.exitCode)
  console.log('')
  console.log(`  ${claimRes.status} — ${claimed.outcome}`)
  console.log(`  ${claimed.note}`)
  console.log('')
  console.log(`  ${signer.signatures} signature(s), every one verified against ${signer.pinned.slice(0, 8)}….`)
  console.log('  This key should now be in relay_members. That is NOT the same as having proved it:')
  console.log('  the next step is to publish one kind:0 from this key against the community relay and')
  console.log('  read it back cold. Until that lands, treat AUTH as untested (#357).')
  console.log('')
  // The code outlives the claim, and may still have uses on it. A bearer secret nobody needs is
  // one nobody is guarding.
  console.log('  The invite code is still on disk and is still a bearer secret. If you are done with it:')
  console.log(`    rm ${cp}`)
  console.log('')
  signer.close()
  process.exit(0)
}
