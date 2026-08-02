#!/usr/bin/env node
// propose-admission.mjs — put a waggle channel-admit into nact's approval queue.
//
// The waggle console approves an admission by signing the 440 directly. nact is the OTHER approval
// surface: a Director reviews the exact bytes (WYSIWYS), the action carries a risk tier, and the
// enact is a single signed act in the Director's own hand. This tool is the bridge — it builds the
// SAME 440 the console builds (byte-for-byte scope construction, so the running bridge matches it)
// and proposes it to nact's /api/propose. The Director then enacts it in nact; the enacted 440 is
// published and the bridge admits the session exactly as if the console had signed it.
//
// WHY THIS IS SAFE TO PROPOSE, NOT SIGN. A proposal is an UNSIGNED draft — it does nothing until a
// Director enacts it. So this tool never holds or needs the grantor key; it only needs enough
// access to LODGE the draft (a Director or an activated nact identity — nact#51). The authority to
// admit stays with whoever signs in nact.
//
// THE SIGNER MUST BE A BRIDGE GRANTOR. The bridge admits on a 440 signed by a key in
// cfg.public.grantors (the maintainer). So the nact `--identity` that ENACTS this must resolve to
// that key — in practice a director-path identity the maintainer signs in their own hand. If it is
// enacted under some other key, the 440 is valid but the bridge will not honour it. This tool
// cannot check that (it does not know nact's identity table); it prints the reminder instead.
//
// Usage:
//   NACT_AUTH_NSEC=nsec1…  node tools/propose-admission.mjs \
//       --to <npub|hex> --channel <uuid> --identity <nact-identity> [--purpose "…"] [--nact https://nact.nave.pub]
//   DRY_RUN=1 …            build the 440 + request body, POST nothing
//
// NACT_AUTH_NSEC is the key that AUTHENTICATES the propose call (NIP-98). It is never the grantor
// key and never signs the 440 — it only proves to nact who is lodging the draft. Env only, not argv.

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { createHash } from 'node:crypto'
import { randomBytes } from 'node:crypto'

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d }
const die = (m) => { console.error(`propose-admission: ${m}`); process.exit(1) }
const HEX64 = /^[0-9a-f]{64}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const toHex = (v, label) => {
  const s = String(v || '').trim()
  if (s.startsWith('npub1')) { const d = nip19.decode(s); if (d.type !== 'npub') die(`${label} is not an npub`); return d.data }
  if (HEX64.test(s)) return s.toLowerCase()
  die(`${label} must be an npub or 64-hex key: got '${s || '(nothing)'}'`)
}

const grantee = toHex(arg('--to'), '--to')
const channel = (arg('--channel') || '').toLowerCase()
if (!UUID.test(channel)) die(`--channel must be the channel UUID (the bridge resolves names, this tool cannot): got '${channel || '(nothing)'}'`)
const identity = arg('--identity') || die('--identity <nact-identity> is required — the nact identity that will ENACT (sign) the 440; it must resolve to a bridge grantor key')
const purpose = arg('--purpose', 'waggle channel admission')
const NACT = (arg('--nact', process.env.NACT_BASE || 'https://nact.nave.pub')).replace(/\/$/, '')
const DRY = !!process.env.DRY_RUN

// The scope hash — IDENTICAL construction to tools/grant.mjs and the console. If this drifts, the
// bridge computes a different hash from its own channel id and the admission silently never matches.
const salt = randomBytes(16).toString('hex')
const scopeHash = createHash('sha256').update(Buffer.concat([
  Buffer.from('waggle/da-scope/v1'), Buffer.from([0]), Buffer.from(channel), Buffer.from(salt, 'hex'),
])).digest('hex')

// The UNSIGNED 440 draft. Same shape grant.mjs signs: p=grantee, da-scope=(hash,salt), da-cap=admit.
const draft = {
  kind: 440,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['p', grantee], ['da-scope', scopeHash, salt], ['da-cap', 'admit']],
  content: '',
}

console.error(`propose-admission: 440 admit draft`)
console.error(`  grantee  ${grantee.slice(0, 12)}…`)
console.error(`  channel  ${channel} (as salted hash ${scopeHash.slice(0, 12)}… — the id never rides public)`)
console.error(`  → nact   ${NACT}/api/propose   as identity '${identity}'`)
console.error(`  purpose  ${purpose}`)

const body = JSON.stringify({ identity, event: draft, context: purpose })

if (DRY) {
  console.error('propose-admission: DRY_RUN — nothing sent. Request body:')
  console.log(body)
  process.exit(0)
}

// NIP-98: sign a kind-27235 pinning method + full URL + body hash. Mirrors nact's app.html.
const raw = process.env.NACT_AUTH_NSEC || die('set NACT_AUTH_NSEC — the key that authenticates the propose (a Director or activated nact identity). Env only.')
let sk
try { sk = raw.startsWith('nsec1') ? nip19.decode(raw).data : Uint8Array.from(Buffer.from(raw.trim(), 'hex')) } catch { die('NACT_AUTH_NSEC is not a valid nsec/hex') }
if (!sk || sk.length !== 32) die('NACT_AUTH_NSEC is not a 32-byte key')
const authPk = getPublicKey(sk)
const url = `${NACT}/api/propose`
const path = new URL(url).pathname
const payload = createHash('sha256').update(body).digest('hex')
const authEv = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000),
  tags: [['u', url], ['method', 'POST'], ['payload', payload]], content: '' }, sk)
const authHeader = 'Nostr ' + Buffer.from(JSON.stringify(authEv)).toString('base64')

console.error(`  auth     NIP-98 as ${authPk.slice(0, 12)}… (authenticates the lodge, NEVER signs the 440)`)

const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: authHeader }, body })
let out = null
try { out = await res.json() } catch { /* non-json */ }

if (!res.ok) {
  console.error(`propose-admission: nact refused (${res.status}) ${JSON.stringify(out)}`)
  if (res.status === 403) console.error('  → the auth key is neither a Director nor an activated identity, or it tried to propose as another identity (nact#51).')
  process.exit(1)
}
console.error(`propose-admission: queued in nact ✓  ${JSON.stringify(out)}`)
console.error(`  next: the Director reviews and ENACTS it in nact — and the enacting identity '${identity}'`)
console.error(`        MUST resolve to a bridge grantor key, or the published 440 will be valid but not honoured.`)
console.log(out?.id || '')
