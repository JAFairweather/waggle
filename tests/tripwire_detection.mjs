// tripwire_detection.mjs — the drill (#35). A detector that has never fired is not a detector,
// it is an untested assumption on a schedule.
//
// Proves BOTH controls against the real tool, offline:
//
//   positive — an on-relay event absent from the journal  -> alarm, exit 2, logged
//   negative — the same event, journaled                  -> clean, exit 0
//
// Both halves matter. An alarm that never fires and one that always fires fail identically, and
// only the pair distinguishes "detects theft" from "shouts at everything".
//
// Events are injected with --events-from, which substitutes the wire and nothing else: the diff,
// the alarm log and the exit codes are the same code a live run executes. A drill that exercised
// a parallel path would prove nothing about the path that matters.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TOOL = resolve(ROOT, 'tools', 'tripwire.mjs')
const POSTER = 'npub1s36nypljc6h88tey0kshf688eyd8myu636ctfs4e3d2w54nhsmnqfhaent'
// Written per-run into the temp dir. The real log at data/tripwire-alarms.log is evidence an
// operator is meant to trust; a test must not leave fake alarms in it.
let ALARMS

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) return console.log(`  ok   ${name}`)
  failures++
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

function run(journal, eventsFile) {
  const r = spawnSync('node', [TOOL, '--since-min', '60', '--journal', journal, '--events-from', eventsFile],
    { env: { ...process.env, POSTER, ALARM_NSEC: '', ALARM_TO: '', ALARM_LOG_PATH: ALARMS }, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const dir = mkdtempSync(resolve(tmpdir(), 'waggle-drill-'))
ALARMS = resolve(dir, 'tripwire-alarms.log')
try {
  const stolenId = 'd'.repeat(64)
  const ourId = 'e'.repeat(64)
  const at = Math.floor(Date.now() / 1000) - 60

  // Two events on the wire under the poster key: one we emitted, one we did not.
  const eventsFile = resolve(dir, 'events.jsonl')
  writeFileSync(eventsFile, [
    JSON.stringify({ id: ourId, kind: 9, created_at: at, tags: [['h', 'channel']], content: 'ours' }),
    JSON.stringify({ id: stolenId, kind: 1, created_at: at, tags: [], content: 'signed by something else' }),
  ].join('\n') + '\n')

  console.log('tripwire detection drill (#35)')

  // --- positive control: the unjournalled event must alarm ---
  const partial = resolve(dir, 'partial.log')
  writeFileSync(partial, JSON.stringify({ id: ourId, kind: 9 }) + '\n')

  const before = existsSync(ALARMS) ? readFileSync(ALARMS, 'utf8').length : 0
  const pos = run(partial, eventsFile)
  check('unjournalled event alarms (exit 2)', pos.code === 2, `exit ${pos.code}`)
  check('it names the unaccounted event', pos.out.includes(stolenId.slice(0, 16)))
  check('it does NOT flag the journalled one', !pos.out.includes(ourId.slice(0, 16)))
  const after = existsSync(ALARMS) ? readFileSync(ALARMS, 'utf8').length : 0
  check('the alarm is recorded to disk', after > before, 'tripwire-alarms.log did not grow')

  // --- negative control: journal it, and the alarm must go quiet ---
  const full = resolve(dir, 'full.log')
  writeFileSync(full, [
    JSON.stringify({ id: ourId, kind: 9 }),
    JSON.stringify({ id: stolenId, kind: 1 }),
  ].join('\n') + '\n')

  const neg = run(full, eventsFile)
  check('the same events, fully journalled, are clean (exit 0)', neg.code === 0, `exit ${neg.code}`)
  check('it reports OK', /^OK/m.test(neg.out))

  // A substituted run must never be mistakable for a live one in a log.
  check('a drill run announces that it is a drill', /DRILL/.test(pos.out))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')
