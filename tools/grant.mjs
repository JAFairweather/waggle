#!/usr/bin/env node
// NIP-DA admission issuer — the maintainer's grant pen (annex §4.1.1, S3 tier).
//
//   grant.mjs issue  --to <npub|hex> --channel <uuid> [--cap admit]    admit to a channel (440)
//   grant.mjs issue  --to <npub|hex> --agent <npub|hex> [--cap task]   may TASK that agent (440)
//   grant.mjs revoke --grant <440 event id>                                sign + publish a 441
//   grant.mjs list                                                          own 440/441s off the relays
//
// A 440 is a PLAIN PUBLIC signed event: ["p", grantee], ["da-scope", <salted hash>, <salt>],
// ["da-cap", "admit"]. The channel id never rides publicly — a fresh 16-byte salt per grant
// keeps two grants into the same channel unlinkable, while the bridge (which knows its own
// channel id) recomputes and matches. Revocation is a 441 e-tagging the 440. The bridge
// consumes both statelessly off the relays; no restart needed for either direction.
//
// Signing, in precedence order:
//   GRANTOR_BUNKER=bunker://<pubkey>?relay=…&secret=…  — REMOTE signer (NIP-46): the key stays
//     in your signer app (Amber / nsec.app / Alby); grant.mjs never sees it. The bunker's
//     own pubkey becomes the grantor — run `grant.mjs whoami` to read it, then set it in
//     cfg.public.grantors. This is the zero-custody, spec-correct path.
//   GRANTOR_NSEC=nsec1…|hex — LOCAL key (demos/CI only; the key is in this process).
// The bridge honors grantor keys in
// cfg.public.grantors, defaulting to the approvers set). Kinds are provisional and read
// from config/nipda_kinds.json when present (NIPDA_KINDS_PATH to override).

import WebSocket from 'ws'
import { randomBytes } from 'node:crypto'
import { scopeHashSync, scopeHashOrNull } from '../src/scope_hash.mjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, getPublicKey, generateSecretKey } from 'nostr-tools/pure'
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46'
import * as nip19 from 'nostr-tools/nip19'
import { DEFAULT_PUBLIC_RELAYS } from '../src/relays.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NIPDA = (() => {
  const d = { grant: 440, revocation: 441, index: 10440, scopeTag: 'da-scope', capTag: 'da-cap' }
  try { return { ...d, ...JSON.parse(readFileSync(process.env.NIPDA_KINDS_PATH || resolve(ROOT, 'config', 'nipda_kinds.json'), 'utf8')) } } catch { return d }
})()
const CONFIG_PATH = process.env.CONFIG_PATH || resolve(ROOT, 'config.json')
const die = (m) => { console.error(`grant: ${m}`); process.exit(1) }

// Resolve a signer: a remote bunker (key never local) or a local key. Returns
// { pubkey, sign(template) } so the rest of the tool is signer-agnostic.
async function resolveSigner() {
  if (process.env.GRANTOR_BUNKER) {
    const bp = await parseBunkerInput(process.env.GRANTOR_BUNKER)
    if (!bp || !bp.pubkey) die('GRANTOR_BUNKER is not a valid bunker:// URI or name@domain — expected bunker://<pubkey>?relay=wss://…&secret=…')
    // PERSIST the client key: a NIP-46 bunker authorizes a specific CLIENT keypair, not
    // just anyone holding the secret. A fresh key each run is a new "app" the signer has
    // never seen ("Unknown client"). We pair ONCE (you approve in the signer), then reuse
    // the same client key for every later issue/revoke. Not the signing identity — just
    // this tool's stable connection identity to your bunker.
    const keyDir = process.env.WAGGLE_HOME || resolve(homedir(), '.waggle')
    const keyPath = resolve(keyDir, 'grant-client.key')
    let clientSk
    if (existsSync(keyPath)) {
      clientSk = Uint8Array.from(Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex'))
    } else {
      clientSk = generateSecretKey()
      mkdirSync(keyDir, { recursive: true })
      writeFileSync(keyPath, Buffer.from(clientSk).toString('hex'), { mode: 0o600 })
      console.error(`(new client key saved to ${keyPath} — approve this app in your signer once; later runs reuse it)`)
    }
    // fromBunker is the factory that populates the pointer (the constructor is private);
    // onauth surfaces the approval URL some signers require on first connect.
    const bunker = BunkerSigner.fromBunker(clientSk, bp, { onauth: (url) => console.error(`approve this connection in your signer: ${url}`) })
    try {
      await bunker.connect()
    } catch (e) {
      const m = String(e && e.message || e)
      if (/unknown client/i.test(m)) die('bunker rejected the connection ("Unknown client"). This usually means the bunker:// string is incomplete or its secret is missing/expired. Copy the FULL string from your signer\'s "connect an app" flow — it must look like bunker://<64-hex-pubkey>?relay=wss://<relay>&secret=<secret> — and approve the request in the signer when it pops. If your signer only offers a nostrconnect:// URI instead, tell me and I will add that flow.')
      die(`bunker connect failed: ${m}`)
    }
    const pubkey = await bunker.getPublicKey()
    return { pubkey, sign: (tmpl) => bunker.signEvent(tmpl), close: () => bunker.close?.() }
  }
  const raw = process.env.GRANTOR_NSEC
  if (!raw) die('set GRANTOR_BUNKER (remote signer, recommended) or GRANTOR_NSEC (local key)')
  const sk = raw.startsWith('nsec1') ? nip19.decode(raw).data : Uint8Array.from(Buffer.from(raw, 'hex'))
  const pubkey = getPublicKey(sk)
  return { pubkey, sign: (tmpl) => finalizeEvent(tmpl, sk), close: () => {} }
}
const args = process.argv.slice(2)
const cmd = args[0]
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1] }
const HEX64 = /^[0-9a-f]{64}$/i

// Only the commands that SIGN need a signer. `list` just reads relays, so given --grantor it
// runs with no signer at all — no connection, no approval prompt, no wait. That matters: a tool
// that asks your signer for permission it does not need trains you to approve without reading.
let signer, pk
const listOnly = cmd === 'list' && flag('--grantor')
if (listOnly) {
  const g = flag('--grantor')
  pk = g.startsWith('npub1') ? nip19.decode(g).data : (HEX64.test(g) ? g.toLowerCase() : die('--grantor must be npub or 64-hex'))
  signer = { pubkey: pk, sign: () => die('list is read-only'), close: () => {} }
} else {
  signer = await resolveSigner()
  pk = signer.pubkey
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function relays() {
  try { const c = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); if (c.public?.relays?.length) return c.public.relays } catch { /* fall through */ }
  return [...DEFAULT_PUBLIC_RELAYS]
}

function publish(ev) {
  return Promise.all(relays().map(url => new Promise(res => {
    let ws
    try { ws = new WebSocket(url) } catch { return res(`${url} CONNECT-FAIL`) }
    const done = m => { try { ws.close() } catch { /* closed */ } res(`${url.padEnd(26)} ${m}`) }
    const t = setTimeout(() => done('TIMEOUT'), 12000)
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', ev])))
    ws.on('message', d => { try { const m = JSON.parse(d.toString()); if (m[0] === 'OK' && m[1] === ev.id) { clearTimeout(t); done(m[2] ? 'OK' : `REJECTED: ${m[3]}`) } } catch { /* ignore */ } })
    ws.on('error', e => { clearTimeout(t); done(`ERR ${e.message}`) })
  })))
}

function channelId(v) {
  if (UUID_RE.test(v)) return v.toLowerCase()
  // resolve by name via the bridge config's resolved channels is a runtime concern; the
  // issuer accepts a name only when config.json's inbox/staging carries the mapping hint.
  die(`--channel must be the channel UUID (names resolve inside the bridge, not the issuer): got '${v}'`)
}

if (cmd === 'whoami') {
  console.log(`grantor pubkey: ${pk}`)
  console.log(`         npub:  ${nip19.npubEncode(pk)}`)
  console.log(`\nSet this in the bridge's config.public.grantors to authorize it, e.g.:`)
  console.log(`  "grantors": ["${pk}"]`)
  await signer.close()
} else if (cmd === 'issue') {
  // --to accepts a comma-separated list so a batch signs over ONE signer connection. Each
  // invocation is a fresh process and therefore a fresh NIP-46 session; issuing five grants as
  // five commands means five approval prompts, which trains an operator to approve without
  // reading — the opposite of what an approval is for.
  const toRaw = flag('--to') || die('issue needs --to <npub|hex>[,<npub|hex>…]')
  const grantees = toRaw.split(',').map(s => s.trim()).filter(Boolean).map(t =>
    t.startsWith('npub1') ? nip19.decode(t).data : (HEX64.test(t) ? t.toLowerCase() : die(`--to entry is not an npub or 64-hex: ${t}`)))
  if (!grantees.length) die('issue needs at least one --to')
  // Two things can be granted, and they differ only in what the scope binds to:
  //   --channel <uuid>  cap admit  — this grantee may enter that channel  (the S3 tier)
  //   --agent <npub>    cap task   — this grantee may TASK that agent     (attention as a scope)
  // The second exists because an agent's own allowlist is an honour system: whatever list it
  // reads, it must choose to obey. Issued as a grant instead, the policy is authenticated,
  // revocable, and enforced by the delivery code before the agent ever sees the message.
  const agentRaw = flag('--agent')
  const chanRaw = flag('--channel')
  if (!agentRaw && !chanRaw) die('issue needs --channel <uuid> (admit) or --agent <npub|hex> (task)')
  if (agentRaw && chanRaw) die('--channel and --agent are different scopes; pass one')
  const subject = agentRaw
    ? (agentRaw.startsWith('npub1') ? nip19.decode(agentRaw).data : (HEX64.test(agentRaw) ? agentRaw.toLowerCase() : die('--agent must be npub or 64-hex')))
    : channelId(chanRaw)
  const cap = flag('--cap') || (agentRaw ? 'task' : 'admit')
  // The console offers the same sets (console/index.html ISSUABLE), so the two signing
  // surfaces cannot disagree about what is grantable. `task-relay` is a carrier grant
  // over an agent, enforced by the agent's runtime rather than by this bridge; `admit+read`
  // stays out of both because conveying it means handling channel key material.
  const allowed = agentRaw ? ['task', 'task+act', 'task-relay'] : ['admit']
  if (!allowed.includes(cap)) die(`--cap ${cap} is not valid for this scope; expected one of: ${allowed.join(', ')}`)
  // One fresh salt PER grant, never one for the batch: a shared salt would make two grants into
  // the same subject linkable, which is the exact property the salt exists to prevent.
  for (const g of grantees) {
    const salt = randomBytes(16).toString('hex')
    const hash = scopeHashSync(subject, salt)
    const ev = await signer.sign({
      kind: NIPDA.grant,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', g], [NIPDA.scopeTag, hash, salt], [NIPDA.capTag, cap]],
      content: '',
    })
    console.log(`440 ${ev.id}\n  grantee ${g}\n  scope   ${hash.slice(0, 16)}… (salted; subject never public)\n  cap     ${cap}\n  grantor ${pk}`)
    for (const line of await publish(ev)) console.log('  ' + line)
  }
  await signer.close()
} else if (cmd === 'revoke') {
  const target = flag('--grant') || die('revoke needs --grant <440 event id>')
  if (!HEX64.test(target)) die('--grant must be a 64-hex event id')
  const ev = await signer.sign({
    kind: NIPDA.revocation,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['e', target.toLowerCase()]],
    content: '',
  })
  console.log(`441 ${ev.id} revoking ${target.slice(0, 12)}…`)
  for (const line of await publish(ev)) console.log('  ' + line)
} else if (cmd === 'list') {
  const found = new Map()
  await Promise.all(relays().map(url => new Promise(res => {
    let ws
    try { ws = new WebSocket(url) } catch { return res() }
    const t = setTimeout(() => { try { ws.close() } catch { } res() }, 8000)
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'g', { kinds: [NIPDA.grant, NIPDA.revocation], authors: [pk], limit: 200 }])))
    ws.on('message', d => { try { const m = JSON.parse(d.toString()); if (m[0] === 'EVENT') found.set(m[2].id, m[2]); if (m[0] === 'EOSE') { clearTimeout(t); ws.close(); res() } } catch { /* ignore */ } })
    ws.on('error', () => { clearTimeout(t); res() })
  })))
  const evs = [...found.values()].sort((a, b) => a.created_at - b.created_at)
  const revoked = new Set(evs.filter(e => e.kind === NIPDA.revocation).flatMap(e => e.tags.filter(t => t[0] === 'e').map(t => t[1])))
  // Optional scope filter. The scope is a salted hash, so only someone who knows the subject
  // can tell what a grant is FOR — which is the privacy property working as intended. The salt
  // rides publicly in the tag, so the holder of the subject can recompute and match. Pass
  // --agent/--channel to see only the grants that bind to that subject.
  const filterRaw = flag('--agent') || flag('--channel')
  const filterSubject = !filterRaw ? null
    : (flag('--agent')
        ? (filterRaw.startsWith('npub1') ? nip19.decode(filterRaw).data : filterRaw.toLowerCase())
        : channelId(filterRaw))
  const matchesScope = (e) => {
    if (!filterSubject) return true
    const tag = e.tags.find(t => t[0] === NIPDA.scopeTag)
    if (!tag) return false
    // The salt is WIRE-SUPPLIED here — anyone can publish a 440 with a salt that is not hex.
    // A grant nobody can decode a salt for binds to no subject, so it matches nothing; it must
    // not throw out of a filter and kill the listing.
    const recomputed = scopeHashOrNull(filterSubject, tag[2] || '')
    return recomputed !== null && tag[1] === recomputed
  }
  let shown = 0
  for (const e of evs) {
    if (e.kind !== NIPDA.grant || !matchesScope(e)) continue
    shown++
    const grantee = e.tags.find(t => t[0] === 'p')?.[1] || '?'
    const cap = e.tags.find(t => t[0] === NIPDA.capTag)?.[1] || '?'
    console.log(`${revoked.has(e.id) ? 'REVOKED' : 'ACTIVE '} 440 ${e.id} -> ${grantee} (${cap}, ${new Date(e.created_at * 1000).toISOString()})`)
  }
  if (!evs.length) console.log('(no grants published by this key)')
  else if (!shown) console.log(filterSubject ? '(none bound to that subject)' : '(no grants)')
} else {
  die('usage: grant.mjs issue --to <npub> (--channel <uuid> | --agent <npub>) | revoke --grant <id> | list')
}
