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
// ONE identity, MANY trees. The read lane and the sealed/return lanes run from separate
// deployments with separate data dirs, and both sign as the same poster key. Diffing against a
// single tree's journal therefore reads the OTHER lane's legitimate sends as theft — a false
// alarm on day one (#87). So the journal is the UNION of every lane's log.
//
// Accepts --journal repeatedly, and comma/colon-separated values in either --journal or
// SEND_JOURNAL_PATH.
function journalPaths() {
  const raw = []
  for (let i = 2; i < process.argv.length - 1; i++) {
    if (process.argv[i] === '--journal') raw.push(process.argv[i + 1])
  }
  if (!raw.length && process.env.SEND_JOURNAL_PATH) raw.push(process.env.SEND_JOURNAL_PATH)
  const split = raw.flatMap(s => String(s).split(/[,:]/)).map(s => s.trim()).filter(Boolean)
  return split.length ? split : [resolve(ROOT, 'data', 'send-journal.log')]
}
const JOURNALS = journalPaths()
// Overridable so a drill can write somewhere disposable. A test that appends to the real alarm
// log leaves fake alarms in the record an operator is meant to trust — and the suite's own rule
// is that it touches no production state.
const ALARMS = process.env.ALARM_LOG_PATH || resolve(ROOT, 'data', 'tripwire-alarms.log')

function loadRelays() {
  const out = new Set()
  if (process.env.BUZZ_RELAY_URL) out.add(process.env.BUZZ_RELAY_URL)
  try { const c = JSON.parse(readFileSync(resolve(ROOT, 'config.json'), 'utf8')); for (const r of c.public?.relays || []) out.add(r) } catch { /* fall through */ }
  if (!out.size) ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'].forEach(r => out.add(r))
  return [...out]
}

// Returns the union, plus the paths that were not there. A MISSING journal is not an empty one:
// it means part of this identity's legitimate output is unaccounted for, so "no anomalies" would
// be a conclusion the evidence cannot support. The caller reports INCONCLUSIVE rather than clean
// — being unable to check is not the same as being fine.
function loadJournal() {
  const ids = new Set()
  const missing = []
  for (const path of JOURNALS) {
    if (!existsSync(path)) {
      console.error(`tripwire: WARNING — no journal at ${path}. This lane's legitimate sends will look unauthorized.`)
      missing.push(path)
      continue
    }
    let n = 0
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      try { const r = JSON.parse(line); if (r.id) { ids.add(r.id); n++ } } catch { /* skip */ }
    }
    console.error(`tripwire: journal ${path} — ${n} entries`)
  }
  return { ids, missing }
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

// Is there anywhere for an alarm to GO? Detection that fires into the void is not detection, and
// the absence of a delivery path is exactly the kind of thing discovered during an incident rather
// than before one. Reported on every run, clean or not — a 30-minute timer saying so is cheap
// compared to finding out when it matters.
const alarmConfigured = () => !!(process.env.ALARM_NSEC && process.env.ALARM_TO)

async function alarmDM(text) {
  if (!alarmConfigured()) {
    console.error('tripwire: ⚠ ALARM NOT DELIVERED — ALARM_NSEC/ALARM_TO are unset, so this alarm exists only in this log and data/tripwire-alarms.log. Nobody has been told.')
    return
  }
  try {
    const ask = process.env.ALARM_NSEC.startsWith('nsec1') ? nip19.decode(process.env.ALARM_NSEC).data : Uint8Array.from(Buffer.from(process.env.ALARM_NSEC, 'hex'))
    const to = process.env.ALARM_TO.startsWith('npub1') ? nip19.decode(process.env.ALARM_TO).data : process.env.ALARM_TO.toLowerCase()
    // NIP-17 seal+wrap (signer = the ALARM key, NOT the poster key).
    const now = () => Math.floor(Date.now() / 1000 - Math.random() * 172800)
    const rumor = { kind: 14, pubkey: getPublicKey(ask), created_at: Math.floor(Date.now() / 1000), tags: [['p', to]], content: text }
    const seal = finalizeEvent({ kind: 13, created_at: now(), tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(ask, to)) }, ask)
    const wsk = generateSecretKey()
    const wrap = finalizeEvent({ kind: 1059, created_at: now(), tags: [['p', to]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wsk, to)) }, wsk)
    // Count what was ACCEPTED, not what was attempted. The previous version resolved on the first
    // frame of any kind — including an `["OK", id, false, "..."]` rejection — and on timeouts and
    // socket errors too, then printed "alarm DM sent" unconditionally. That is the same
    // relay-OK-is-not-proof trap the rest of this project is built around, in the one place where
    // believing a false success is worst: the alarm.
    const relays = loadRelays()
    const results = await Promise.all(relays.map(url => new Promise(r => {
      let ws
      try { ws = new WebSocket(url) } catch { return r(false) }
      const done = (v) => { clearTimeout(t); try { ws.close() } catch { /* */ } r(v) }
      const t = setTimeout(() => done(false), 6000)
      ws.on('open', () => ws.send(JSON.stringify(['EVENT', wrap])))
      ws.on('message', (d) => {
        let m
        try { m = JSON.parse(d.toString()) } catch { return done(false) }
        if (m[0] === 'OK' && m[1] === wrap.id) return done(m[2] === true)
        // NOTICE or anything else: keep waiting for the OK until the timeout.
      })
      ws.on('error', () => done(false))
    })))
    const accepted = results.filter(Boolean).length
    if (accepted > 0) console.error(`tripwire: alarm DM delivered ${accepted}/${relays.length} relay(s)`)
    else console.error(`tripwire: ⚠ ALARM NOT DELIVERED — 0/${relays.length} relay(s) accepted the alarm DM. The alarm exists only in this log and data/tripwire-alarms.log.`)
  } catch (e) { console.error(`tripwire: ⚠ ALARM NOT DELIVERED — alarm DM failed: ${e.message}`) }
}

// --- run ---
const { ids: journal, missing } = loadJournal()

// --events-from <file> substitutes the WIRE, never the judgement. It replaces only where events
// come from; the diff against the journal, the alarm log, the DM and the exit codes stay the code
// a real run uses. That is the point — a drill exercising a parallel path proves nothing about
// the path that matters. Opt-in, and announced loudly, so a substituted run can never be mistaken
// for a live one when someone reads the log later.
const EVENTS_FROM = arg('--events-from', null)
let events
if (EVENTS_FROM) {
  console.error(`tripwire: DRILL — events read from ${EVENTS_FROM}, NOT from the relays. This run says nothing about live state.`)
  events = readFileSync(EVENTS_FROM, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
} else {
  events = await fetchPosterEvents()
}

const anomalies = events.filter(e => !journal.has(e.id))
const iso = (s) => new Date(s * 1000).toISOString()

console.error(`tripwire: poster ${posterHex.slice(0, 12)}… · window ${sinceMin}m · ${events.length} on-relay event(s) · ${journal.size} journaled across ${JOURNALS.length - missing.length}/${JOURNALS.length} lane(s) · ${anomalies.length} unaccounted`)

// Said on EVERY run, not only when something fires. An operator who learns during an incident
// that the alarm had nowhere to go has learned it too late, and a detector whose alarm is
// undeliverable is a detector in name only.
if (!alarmConfigured()) console.error('tripwire: ⚠ no alarm delivery path configured (ALARM_NSEC/ALARM_TO unset) — if this run had found something, nobody would have been told.')

if (!anomalies.length) {
  // A half-synced union cannot produce an all-clear. With a lane's journal absent, "nothing
  // unaccounted" only means nothing was found in the part we could see, and reporting that as OK
  // is precisely the shape of check that passes because it examined nothing.
  if (missing.length) {
    console.log(`INCONCLUSIVE — no anomalies found, but ${missing.length} of ${JOURNALS.length} lane journal(s) were missing:\n  ${missing.join('\n  ')}\nFix the sync before trusting this result. This is NOT an all-clear.`)
    process.exit(3)
  }
  // SIZE FLOOR. A check that observed NOTHING has cleared nothing. "Every on-relay post was
  // emitted by our process" is vacuously true over an empty set — every one of zero events was
  // accounted for — so an all-clear here reports the strength of our eyesight, not the state of
  // the world. It is the same shape as the scan of an empty file that once reported everything
  // clean, and `CLAUDE.md` names it: put a size floor on fetched input.
  //
  // The journal count is the diagnostic that makes this actionable rather than merely cautious.
  // Zero observed while the journal records sends in the same window does not mean the poster was
  // quiet — it means the read path cannot see the surface the key is actually used on, and every
  // OK it has ever printed was that blindness, not an assurance.
  if (!events.length) {
    console.log(
      `INCONCLUSIVE — 0 on-relay event(s) observed in the last ${sinceMin}m, so nothing was checked.` +
      (journal.size
        ? `\nThe journal recorded ${journal.size} send(s) in the same period. Zero observed against a non-empty journal means the read path is not seeing the surface the poster key is used on — not that the key was idle.`
        : `\nThe journal is also empty for this window, so this may simply be a quiet period — but a run that saw nothing still proves nothing about the read path.`) +
      `\nThis is NOT an all-clear.`)
    process.exit(3)
  }
  console.log(`OK — all ${events.length} on-relay post(s) by the poster key were emitted by our process.`)
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
