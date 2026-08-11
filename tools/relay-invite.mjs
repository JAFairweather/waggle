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
//       --key ~/.nvoy/agent.nsec --code-file ~/.nvoy/invite.code
//
// TWO SECRETS, NEITHER OF THEM PRINTED. The signing key is read from a FILE and never from argv or
// an environment variable, because argv is visible in `ps` and shell history. The invite code is a
// reusable bearer secret — anyone holding it can join the relay — so it is written to a 0600 file
// and this tool prints the PATH. There is no flag that prints either value.
//
// Exit: 0 ok · 1 bad input · 2 relay/network · 3 INCONCLUSIVE (it ran, and could not tell you).

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { nip19 } from 'nostr-tools'
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { nip98Template, nip98Header, expectedUrl } from '../src/nip98.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const die = (msg, code = 1) => { console.error(`relay-invite: ${msg}`); process.exit(code) }
const expand = (p) => (String(p).startsWith('~/') ? resolve(homedir(), String(p).slice(2)) : resolve(String(p)))

const USAGE = `usage:
  BUZZ_RELAY_URL=… node tools/relay-invite.mjs mint  --key <path> [--ttl 3600] [--uses 1] [--out <path>]
  BUZZ_RELAY_URL=… node tools/relay-invite.mjs claim --key <path> --code-file <path>`

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
  // src/nip98.mjs deliberately does not sign — the egress ban keeps `finalizeEvent` out of src/,
  // so the key stays with the caller that holds it. That is here.
  const { template, body } = nip98Template({ url, method: 'POST', body: JSON.stringify(bodyObj) })
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

// --- mint --------------------------------------------------------------------------------------
if (cmd === 'mint') {
  const secret = readSecret(arg('key'))
  const ttl = Number(arg('ttl', '3600'))
  const uses = Number(arg('uses', '1'))
  if (!Number.isFinite(ttl) || ttl <= 0) die('--ttl must be a positive number of seconds')
  if (!Number.isFinite(uses) || uses < 1) die('--uses must be at least 1')
  const out = expand(arg('out', '~/.nvoy/relay-invite.code'))
  if (existsSync(out)) die(`${out} already exists. Refusing to overwrite — an invite code file is a bearer secret; move it aside if you mean to replace it.`)

  console.log(`relay-invite: minting as ${nip19.npubEncode(getPublicKey(secret))}`)
  const { status, json, text } = await post('/api/invites', { ttl_secs: ttl, max_uses: uses }, secret)

  if (status === 403) {
    console.error('relay-invite: 403 — this key does not hold owner or admin in relay_members.')
    console.error('  That IS the answer to the first open question in #357: minting needs the role,')
    console.error('  and the ask to the relay operator is one line — put this key in relay_members as admin.')
    process.exit(1)
  }
  if (status === 401) die(`401 — the relay rejected the signature: ${json?.error || text.slice(0, 200)}`, 1)
  if (status < 200 || status >= 300) die(`${status} — ${json?.error || text.slice(0, 200)}`, 2)

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
  const { status, json, text } = await post('/api/invites/claim', { code }, secret)

  if (status === 401) die(`401 — the relay rejected the signature: ${json?.error || text.slice(0, 200)}`, 1)
  if (status < 200 || status >= 300) die(`${status} — ${json?.error || text.slice(0, 200)}`, 2)

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
  process.exit(0)
}
