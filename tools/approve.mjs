#!/usr/bin/env node
// Quarantine approval CLI — the human half of the A1 gate.
//
// A stranger's reply lands in the STAGING channel and goes nowhere else. This tool is the
// explicit approve act: it re-fetches the original event from the public relays (never
// trusting the staged copy), verifies the signature, and reposts it into the community
// channel through the bridge's own forwardPublic — so the label format, A6 rate caps, and
// A7 posted-map bookkeeping are the real ones, not a copy.
//
//   node tools/approve.mjs --event <64-hex id>            approve this one note
//   node tools/approve.mjs --event <64-hex id> --watch    …and trust the author from now on
//   node tools/approve.mjs --mute <64-hex pubkey>         reject durably: replies stop reaching staging
//
// Approving once and trusting an author are DELIBERATELY separate acts: --watch widens the
// allowlist (the moderation decision §4 reserves for the maintainer) and requires a bridge
// restart to take effect. Every approval is appended to data/approvals.log.
//
// Env: BUZZ_PRIVATE_KEY (the bridge posting identity, same as the lane), CONFIG_PATH,
// APPROVALS_PATH overrides for tests.

import WebSocket from 'ws'
import { verifyEvent } from 'nostr-tools/pure'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const CONFIG_PATH = process.env.CONFIG_PATH || resolve(ROOT, 'config.json')
const APPROVALS_PATH = process.env.APPROVALS_PATH || resolve(ROOT, 'data', 'approvals.log')

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : (args[i + 1] || true) }
const eventId = flag('--event')
const mutePk = flag('--mute')
const watch = args.includes('--watch')
const hex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s)

const die = (msg) => { console.error(`approve: ${msg}`); process.exit(1) }
if (!eventId && !mutePk) die('usage: approve.mjs --event <id> [--watch] | --mute <pubkey>')
if (eventId && !hex64(eventId)) die('--event must be a 64-hex event id')
if (mutePk && !hex64(mutePk)) die('--mute must be a 64-hex pubkey')

const loadCfg = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const saveCfg = (cfg) => writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n')

// --- --mute: durable reject, no relay round-trip needed ----------------------
if (mutePk) {
  const cfg = loadCfg()
  if (!cfg.public) die('no public read lane configured')
  cfg.public.muted_authors = cfg.public.muted_authors || []
  const pk = mutePk.toLowerCase()
  if (cfg.public.muted_authors.includes(pk)) { console.log(`already muted: ${pk}`); process.exit(0) }
  cfg.public.muted_authors.push(pk)
  saveCfg(cfg)
  console.log(`muted ${pk} — replies will stop reaching staging.\nRestart the bridge to apply.`)
  process.exit(0)
}

// --- --event: fetch → verify → repost through the bridge's own path ----------
process.env.WB_NO_BOOT = '1' // import the real routing/delivery code without booting the lane
const { forwardPublic, rateOk, PUB, resolveChannels } = await import('../src/bridge.mjs')
if (!PUB) die('no public read lane configured (cfg.public.inbox)')
if (!PUB.relays.length) die('cfg.public.relays is empty — nowhere to fetch from')
await new Promise(res => resolveChannels(res)) // names -> UUIDs, same rules as the lane

const id = eventId.toLowerCase()
console.log(`fetching ${id.slice(0, 12)}… from ${PUB.relays.length} relay(s)`)

// Keyless anonymous REQ by id — first relay to serve it wins. Never trust the staged copy:
// what we repost is exactly what the public network holds, signature-checked.
const fetched = await new Promise((done) => {
  const socks = []
  let settled = false
  const finish = (ev) => {
    if (settled) return
    settled = true
    for (const w of socks) { try { w.close() } catch { /* already closed */ } }
    done(ev || null)
  }
  setTimeout(() => finish(null), 10000)
  for (const url of PUB.relays) {
    try {
      const w = new WebSocket(url)
      socks.push(w)
      w.on('open', () => w.send(JSON.stringify(['REQ', 'ap', { ids: [id] }])))
      w.on('message', (d) => {
        try {
          const m = JSON.parse(d.toString())
          if (m[0] === 'EVENT' && m[2] && m[2].id === id) finish(m[2])
        } catch { /* ignore non-JSON frames */ }
      })
      w.on('error', () => { /* a dead relay just doesn't answer */ })
    } catch { /* bad URL — skip */ }
  }
})

if (!fetched) die(`event not found on any configured relay — cannot approve what the public network doesn't hold`)
if (!verifyEvent(fetched)) die('signature verification FAILED — refusing to approve')
if (fetched.kind !== 1) die(`kind ${fetched.kind} is not a kind:1 note — refusing`)

// Refuse silent duplicates: a note already released to the community channel is never
// re-posted by accident. --watch on an already-released note grants trust WITHOUT
// reposting; --force is the explicit re-release override.
const force = args.includes('--force')
const POSTED_MAP_PATH = process.env.POSTED_MAP_PATH || resolve(ROOT, 'data', 'posted-map.log')
let released = null
try {
  for (const line of readFileSync(POSTED_MAP_PATH, 'utf8').split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(line)
      if (!r || r.id !== id) continue
      if (r.deleted) released = null
      else if (r.dest === PUB.inbox) released = r
    } catch { /* skip corrupt line */ }
  }
} catch { /* no map yet */ }

if (released && !force) {
  if (!watch) die(`already released to the community channel (buzz ${String(released.buzz).slice(0, 12)}…) — re-releasing would post a duplicate. Use --force to do it anyway.`)
  console.log(`already released (buzz ${String(released.buzz).slice(0, 12)}…) — skipping repost, applying --watch only`)
} else {
  if (!rateOk(fetched, PUB.inbox, Date.now())) die('A6 rate cap would be exceeded — try again later')
  forwardPublic(fetched, 'released from quarantine', PUB.inbox, false)
  console.log(`approved ${id.slice(0, 12)}… by ${fetched.pubkey.slice(0, 12)}… -> community inbox ${PUB.inbox}`)
}

try {
  mkdirSync(dirname(APPROVALS_PATH), { recursive: true })
  appendFileSync(APPROVALS_PATH, JSON.stringify({ id, author: fetched.pubkey, watch, ts: Math.floor(Date.now() / 1000) }) + '\n')
} catch (e) { console.error(`warn: approvals.log append failed: ${e.message}`) }

if (watch) {
  const cfg = loadCfg()
  cfg.public.watch_authors = cfg.public.watch_authors || []
  const pk = fetched.pubkey.toLowerCase()
  if (!cfg.public.watch_authors.includes(pk)) {
    cfg.public.watch_authors.push(pk)
    saveCfg(cfg)
    console.log(`now watching author ${pk} — this widens the allowlist. Restart the bridge to apply.`)
  } else {
    console.log(`author ${pk} is already watched`)
  }
}
