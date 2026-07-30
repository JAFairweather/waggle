#!/usr/bin/env node
// NIP-DA admission issuer — the maintainer's grant pen (annex §4.1.1, S3 tier).
//
//   grant.mjs issue  --to <npub|hex> --channel <uuid|name> [--cap admit]   sign + publish a 440
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
import { randomBytes, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, getPublicKey, generateSecretKey } from 'nostr-tools/pure'
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46'
import * as nip19 from 'nostr-tools/nip19'

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
    if (!bp) die('GRANTOR_BUNKER is not a valid bunker:// connection string')
    const clientSk = generateSecretKey() // ephemeral transport key; not the signing identity
    const bunker = new BunkerSigner(clientSk, bp)
    await bunker.connect()
    const pubkey = await bunker.getPublicKey()
    return { pubkey, sign: (tmpl) => bunker.signEvent(tmpl), close: () => bunker.close?.() }
  }
  const raw = process.env.GRANTOR_NSEC
  if (!raw) die('set GRANTOR_BUNKER (remote signer, recommended) or GRANTOR_NSEC (local key)')
  const sk = raw.startsWith('nsec1') ? nip19.decode(raw).data : Uint8Array.from(Buffer.from(raw, 'hex'))
  const pubkey = getPublicKey(sk)
  return { pubkey, sign: (tmpl) => finalizeEvent(tmpl, sk), close: () => {} }
}
const signer = await resolveSigner()
const pk = signer.pubkey

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1] }
const HEX64 = /^[0-9a-f]{64}$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function relays() {
  try { const c = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); if (c.public?.relays?.length) return c.public.relays } catch { /* fall through */ }
  return ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']
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
  const toRaw = flag('--to') || die('issue needs --to <npub|hex>')
  const grantee = toRaw.startsWith('npub1') ? nip19.decode(toRaw).data : (HEX64.test(toRaw) ? toRaw.toLowerCase() : die('--to must be npub or 64-hex'))
  const chan = channelId(flag('--channel') || die('issue needs --channel <uuid>'))
  const cap = flag('--cap') || 'admit'
  if (cap !== 'admit') die(`only --cap admit is implemented (S3 tier); admit+read (S2) rides the 30440 work`)
  const salt = randomBytes(16).toString('hex')
  const hash = createHash('sha256').update(Buffer.concat([
    Buffer.from('waggle/da-scope/v1'), Buffer.from([0]), Buffer.from(chan), Buffer.from(salt, 'hex'),
  ])).digest('hex')
  const ev = await signer.sign({
    kind: NIPDA.grant,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', grantee], [NIPDA.scopeTag, hash, salt], [NIPDA.capTag, cap]],
    content: '',
  })
  console.log(`440 ${ev.id}\n  grantee ${grantee}\n  scope   ${hash.slice(0, 16)}… (salted; channel never public)\n  cap     ${cap}\n  grantor ${pk}`)
  for (const line of await publish(ev)) console.log('  ' + line)
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
  for (const e of evs) {
    if (e.kind === NIPDA.grant) {
      const grantee = e.tags.find(t => t[0] === 'p')?.[1] || '?'
      console.log(`${revoked.has(e.id) ? 'REVOKED' : 'ACTIVE '} 440 ${e.id.slice(0, 12)}… -> ${grantee.slice(0, 12)}… (${new Date(e.created_at * 1000).toISOString()})`)
    }
  }
  if (!evs.length) console.log('(no grants published by this key)')
} else {
  die('usage: grant.mjs issue --to <npub> --channel <uuid> | revoke --grant <id> | list')
}
