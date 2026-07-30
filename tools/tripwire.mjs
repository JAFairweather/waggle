#!/usr/bin/env node
// Tripwire — out-of-process detection of unauthorized signing by the bridge poster key.
// (Q1, waggle's finding 2026-07-30. Process rate-limits cannot catch key theft: a thief with
// the raw nsec signs DIRECT, bypassing our code. This watches the wire instead of the process.)
//
// Principle: the bridge journals every event id it publishes (data/send-journal.log). This
// watcher fetches the poster identity's recent on-relay events and diffs them against that
// journal. Any event AUTHORED BY OUR KEY that is not in the journal was signed by something
// other than our process — theft, a second signer, an impersonation. That is the alarm.
//
// Runs on-box OR off-box. OFF-BOX IS STRONGER: a box compromise can kill an on-box watcher,
// but not one running on your Mac / a separate host. Point SEND_JOURNAL_PATH at a synced copy
// of the journal (rsync/scp on a timer) and run this anywhere.
//
//   POSTER=<npub|hex> node tools/tripwire.mjs [--since-min 120] [--journal <path>]
//   (POSTER defaults to the pubkey of BUZZ_PRIVATE_KEY if that env is present.)
//
// Alarm: loud stderr, an appended data/tripwire-alarms.log, and exit code 2. If ALARM_NSEC +
// ALARM_TO are set, it also sends a NIP-17 DM — signed by a SEPARATE alarm key, never the
// poster key (which may be the compromised one). Wire it to a systemd timer; alert on exit 2.

import WebSocket from 'ws'
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPublicKey, finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import * as nip44 from 'nostr-tools/nip44'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1] }
const die = (m) => { console.error(`tripwire: ${m}`); process.exit(1) }

// Poster identity — the key whose signing we are policing.
let poster = arg('--poster', process.env.POSTER)
if (!poster && process.env.BUZZ_PRIVATE_KEY) {
  const raw = process.env.BUZZ_PRIVATE_KEY
  const sk = raw.startsWith('nsec1') ? nip19.decode(raw).data : Uint8Array.from(Buffer.from(raw, 'hex'))
  poster = getPublicKey(sk)
}
if (!poster) die('set POSTER=<npub|hex> (or provide BUZZ_PRIVATE_KEY to derive it)')
const posterHex = poster.startsWith('npub1') ? nip19.decode(poster).data : poster.toLowerCase()

// Rule 1 as a property of the code, not just the docs: the alarm must be signed by a SEPARATE
// key, never the poster. If ALARM_NSEC derives to the poster, a thief holding that nsec could
// forge the all-clear too — so refuse to run rather than offer that false assurance.
if (process.env.ALARM_NSEC) {
  const alarmSk = process.env.ALARM_NSEC.startsWith('nsec1') ? nip19.decode(process.env.ALARM_NSEC).data : Uint8Array.from(Buffer.from(process.env.ALARM_NSEC, 'hex'))
  if (getPublicKey(alarmSk) === posterHex) die('ALARM_NSEC derives to the POSTER key — the alarm must be signed by a SEPARATE, zero-authority key (rule 1). An alarm signed by the identity under suspicion proves nothing.')
}

const sinceMin = Number(arg('--since-min', 120))
const since = Math.floor(Date.now() / 1000) - sinceMin * 60
const JOURNAL = arg('--journal', process.env.SEND_JOURNAL_PATH || resolve(ROOT, 'data', 'send-journal.log'))
const ALARMS = resolve(ROOT, 'data', 'tripwire-alarms.log')

function loadRelays() {
  const out = new Set()
  if (process.env.BUZZ_RELAY_URL) out.add(process.env.BUZZ_RELAY_URL)
  try { const c = JSON.parse(readFileSync(resolve(ROOT, 'config.json'), 'utf8')); for (const r of c.public?.relays || []) out.add(r) } catch { /* fall through */ }
  if (!out.size) ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'].forEach(r => out.add(r))
  return [...out]
}

function loadJournal() {
  const ids = new Set()
  if (!existsSync(JOURNAL)) { console.error(`tripwire: WARNING — no journal at ${JOURNAL}; every post will look unauthorized. Point --journal at the bridge's send-journal.`); return ids }
  for (const line of readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean)) {
    try { const r = JSON.parse(line); if (r.id) ids.add(r.id) } catch { /* skip */ }
  }
  return ids
}

// Fetch recent events authored by the poster across the relay set.
function fetchPosterEvents() {
  const seen = new Map()
  return Promise.all(loadRelays().map(url => new Promise(res => {
    let ws
    try { ws = new WebSocket(url) } catch { return res() }
    const t = setTimeout(() => { try { ws.close() } catch { /* */ } res() }, 10000)
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'tw', { authors: [posterHex], since }])))
    ws.on('message', d => { try { const m = JSON.parse(d.toString()); if (m[0] === 'EVENT') seen.set(m[2].id, m[2]); if (m[0] === 'EOSE') { clearTimeout(t); ws.close(); res() } } catch { /* */ } })
    ws.on('error', () => { clearTimeout(t); res() })
  }))).then(() => [...seen.values()])
}

async function alarmDM(text) {
  if (!process.env.ALARM_NSEC || !process.env.ALARM_TO) return
  try {
    const ask = process.env.ALARM_NSEC.startsWith('nsec1') ? nip19.decode(process.env.ALARM_NSEC).data : Uint8Array.from(Buffer.from(process.env.ALARM_NSEC, 'hex'))
    const to = process.env.ALARM_TO.startsWith('npub1') ? nip19.decode(process.env.ALARM_TO).data : process.env.ALARM_TO.toLowerCase()
    // NIP-17 seal+wrap (signer = the ALARM key, NOT the poster key).
    const now = () => Math.floor(Date.now() / 1000 - Math.random() * 172800)
    const rumor = { kind: 14, pubkey: getPublicKey(ask), created_at: Math.floor(Date.now() / 1000), tags: [['p', to]], content: text }
    const seal = finalizeEvent({ kind: 13, created_at: now(), tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(ask, to)) }, ask)
    const wsk = generateSecretKey()
    const wrap = finalizeEvent({ kind: 1059, created_at: now(), tags: [['p', to]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wsk, to)) }, wsk)
    await Promise.all(loadRelays().map(url => new Promise(r => { let ws; try { ws = new WebSocket(url) } catch { return r() } const t = setTimeout(() => { try { ws.close() } catch { /* */ } r() }, 6000); ws.on('open', () => ws.send(JSON.stringify(['EVENT', wrap]))); ws.on('message', () => { clearTimeout(t); ws.close(); r() }); ws.on('error', () => { clearTimeout(t); r() }) })))
    console.error('tripwire: alarm DM sent')
  } catch (e) { console.error(`tripwire: alarm DM failed: ${e.message}`) }
}

// --- run ---
const journal = loadJournal()
const events = await fetchPosterEvents()
const anomalies = events.filter(e => !journal.has(e.id))
const iso = (s) => new Date(s * 1000).toISOString()

console.error(`tripwire: poster ${posterHex.slice(0, 12)}… · window ${sinceMin}m · ${events.length} on-relay event(s) · ${journal.size} journaled · ${anomalies.length} unaccounted`)

if (!anomalies.length) {
  console.log('OK — every on-relay post by the poster key was emitted by our process.')
  process.exit(0)
}

const report = anomalies.map(e => {
  const h = (e.tags || []).find(t => t[0] === 'h')?.[1] || (e.tags || []).find(t => t[0] === 'e')?.[1] || '?'
  return `UNAUTHORIZED  kind ${e.kind}  id ${e.id.slice(0, 16)}…  h/e ${String(h).slice(0, 12)}  ${iso(e.created_at)}  :: ${JSON.stringify(String(e.content || '').slice(0, 80))}`
})
console.error('\n🚨 TRIPWIRE — the poster key signed events this process never emitted:\n' + report.join('\n'))
try { mkdirSync(dirname(ALARMS), { recursive: true }); appendFileSync(ALARMS, JSON.stringify({ ts: Math.floor(Date.now() / 1000), poster: posterHex, anomalies: anomalies.map(e => ({ id: e.id, kind: e.kind, created_at: e.created_at })) }) + '\n') } catch { /* */ }
await alarmDM(`🚨 waggle tripwire: ${anomalies.length} post(s) signed by the bridge key (${posterHex.slice(0, 12)}…) that the bridge process did not emit. Possible key theft — investigate and rotate. First: ${anomalies[0].id.slice(0, 16)}…`)
process.exit(2)
