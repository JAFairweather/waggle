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

import WebSocket from '../src/ws_runtime.mjs'
import { readFileSync, appendFileSync, mkdirSync, existsSync, lstatSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { loadBunkerSignerFiles, makeLocalSigner } from '../src/nostr_signer.mjs'
import { buildTripwireAlarmWrap } from './tripwire_alarm_lib.mjs'
import { credentialModeIsPrivate } from '../src/credential_file.mjs'
import { DEFAULT_PUBLIC_RELAYS } from '../src/relays.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1] }
const die = (m) => { console.error(`tripwire: ${m}`); process.exit(1) }

// Validate the public, credential-free drill target before reading any secret file or constructing
// either signer. A malformed target must not be able to trigger secret access or Bunker traffic.
const DRILL_ALARM = process.argv.includes('--drill-alarm')
let DRILL_RELAY = null
if (DRILL_ALARM) {
  const raw = String(process.env.BUZZ_RELAY_URL || '').trim()
  if (!raw) die('--drill-alarm requires exactly one explicit BUZZ_RELAY_URL')
  try {
    const parsed = new URL(raw)
    if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error('not a credential-free WebSocket URL')
    DRILL_RELAY = parsed.toString()
  } catch {
    die('--drill-alarm requires exactly one explicit credential-free ws:// or wss:// BUZZ_RELAY_URL')
  }
}

// systemd credentials keep the alarm nsec out of EnvironmentFile, process listings, the repo,
// and logs. Direct env remains for local drills/backward compatibility, but a unit that supplies
// BOTH is a migration error: silently preferring one could leave an old secret live indefinitely.
function credential(name) {
  const direct = String(process.env[name] || '').trim()
  const path = String(process.env[`${name}_FILE`] || '').trim()
  if (direct && path) die(`${name} and ${name}_FILE are both set — remove the legacy environment secret`)
  if (!path) return direct
  let st
  try { st = lstatSync(path) } catch (e) { die(`${name}_FILE cannot be read: ${e.message}`) }
  if (!st.isFile() || st.isSymbolicLink()) die(`${name}_FILE must be a regular non-symlink file`)
  if (!credentialModeIsPrivate(path, st)) die(`${name}_FILE must not be group/world accessible outside systemd's protected credential mount`)
  if (st.size < 1 || st.size > 512) die(`${name}_FILE has an invalid size`)
  try { return readFileSync(path, 'utf8').trim() } catch (e) { die(`${name}_FILE cannot be read: ${e.message}`) }
}
const ALARM_NSEC = credential('ALARM_NSEC')
const ALARM_TO = credential('ALARM_TO')

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
// key, never the poster. Prefer a Bunker pairing so the dedicated alarm nsec is absent even from
// the watcher. ALARM_NSEC remains a disposable local-key fallback for simple/offline installs.
const alarmBunker = loadBunkerSignerFiles(
  String(process.env.ALARM_BUNKER_URI_FILE || '').trim(),
  String(process.env.ALARM_NIP46_CLIENT_NSEC_FILE || '').trim(),
  {},
  { uriLabel: 'ALARM_BUNKER_URI_FILE', clientLabel: 'ALARM_NIP46_CLIENT_NSEC_FILE' },
)
let alarmLocal = null
if (ALARM_NSEC) {
  if (alarmBunker) die('configure either the Bunker alarm signer or ALARM_NSEC, never both')
  alarmLocal = makeLocalSigner(ALARM_NSEC, 'ALARM_NSEC')
}
const alarmSigner = alarmBunker || alarmLocal
const alarmPubkey = alarmSigner?.pubkey || null
if (alarmPubkey === posterHex) die('the alarm signer is the POSTER key — the alarm must use a SEPARATE, zero-authority identity (rule 1). An alarm signed by the identity under suspicion proves nothing.')

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
  // A delivery drill proves one named path. Falling through to the normal fan-out would let a
  // different relay accept the wrap and mask failure of the path the operator intended to test.
  if (DRILL_ALARM) return [DRILL_RELAY]
  const out = new Set()
  if (process.env.BUZZ_RELAY_URL) out.add(process.env.BUZZ_RELAY_URL)
  try { const c = JSON.parse(readFileSync(resolve(ROOT, 'config.json'), 'utf8')); for (const r of c.public?.relays || []) out.add(r) } catch { /* fall through */ }
  if (!out.size) DEFAULT_PUBLIC_RELAYS.forEach(r => out.add(r))
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
const alarmConfigured = () => !!(alarmPubkey && ALARM_TO)

async function alarmDM(text) {
  if (!alarmConfigured()) {
    console.error('tripwire: ⚠ ALARM NOT DELIVERED — no alarm signer/ALARM_TO is configured, so this alarm exists only in this log and data/tripwire-alarms.log. Nobody has been told.')
    return 0
  }
  try {
    const to = ALARM_TO.startsWith('npub1') ? nip19.decode(ALARM_TO).data : ALARM_TO.toLowerCase()
    // NIP-17 seal+wrap (signer = the ALARM identity, NOT the poster identity).
    const wrap = await buildTripwireAlarmWrap(text, to, alarmSigner)
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
    return accepted
  } catch (e) { console.error(`tripwire: ⚠ ALARM NOT DELIVERED — alarm DM failed: ${e.message}`); return 0 }
}

// Exercise the exact production seal/publish path without manufacturing an unauthorized poster
// event. This is delivery evidence, not a detector all-clear: the ordinary positive/negative diff
// drill proves detection, while this proves that a firing detector can actually reach its owner.
if (DRILL_ALARM) {
  console.error('tripwire: DRILL — sending a labelled test alarm through the production sealed-DM path')
  const delivered = await alarmDM(`🚨 TRIPWIRE DRILL — test alert from ${posterHex.slice(0, 12)}… at ${new Date().toISOString()}. This is a delivery test, not a signing incident.`)
  if (delivered < 1) process.exit(4)
  console.log(`DRILL OK — sealed test alarm accepted by ${delivered} relay(s). Confirm arrival at the configured operator identity.`)
  process.exit(0)
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
if (!alarmConfigured()) console.error('tripwire: ⚠ no alarm delivery path configured (Bunker or ALARM_NSEC plus ALARM_TO) — if this run had found something, nobody would have been told.')

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
    // BLIND vs QUIET — the same observation, two very different meanings, and #176 is right that
    // collapsing them costs the alarm its credibility. An INCONCLUSIVE on every idle hour is a
    // detector crying wolf, and this repo already knows where that ends: it gets muted, which is
    // the same end state as having no detector at all.
    //
    // The journal is what separates them, and the tool already computed it — it was in the
    // message text and not in the exit code.
    if (journal.size) {
      // Sends recorded, nothing seen on the wire: the read path is not looking at the surface the
      // poster key is used on. Not a quiet key — a blind check. This is the one that must nag.
      console.log(
        `INCONCLUSIVE — 0 on-relay event(s) observed in the last ${sinceMin}m, so nothing was checked, ` +
        `while the journal recorded ${journal.size} send(s) in the same period.\n` +
        `Zero observed against a non-empty journal means the read path is not seeing the surface the ` +
        `poster key is used on. This is NOT an all-clear.`)
      process.exit(3)
    }
    // Nothing sent, nothing seen: consistent with a genuinely idle window. Exit 0 so an idle
    // bridge does not fail its unit every tick — but say plainly that nothing was CLEARED. The
    // distinction the wording has to carry: "no evidence of wrongdoing" is not "evidence of no
    // wrongdoing", and this line must never read like the OK below it.
    console.log(
      `QUIET — 0 on-relay event(s) observed and 0 journaled in the last ${sinceMin}m. ` +
      `Consistent with an idle poster key.\nNothing was checked and nothing is claimed: this is ` +
      `not an all-clear, it is an absence of activity to clear.`)
    process.exit(0)
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
