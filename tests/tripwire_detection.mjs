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

const quiet0 = (out) => !/^QUIET/m.test(out)
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

  // --- the size floor: a run that OBSERVED NOTHING has cleared nothing ---
  //
  // This is the case that was reporting green in production. With an empty observation set,
  // "every on-relay post was emitted by our process" is vacuously true — every one of zero
  // events was accounted for — so exit 0 reports our eyesight, not the world.
  console.log('\nsize floor (0 observed must not be OK)')
  const noEvents = resolve(dir, 'none.jsonl')
  writeFileSync(noEvents, '')

  const empty = run(full, noEvents)
  check('0 observed + a non-empty journal -> INCONCLUSIVE, not OK', empty.code === 3, `exit ${empty.code}`)
  check('it refuses to print OK', !/^OK/m.test(empty.out))
  check('it says nothing was checked', /0 on-relay event\(s\) observed/.test(empty.out))
  check('it names the read path as the suspect, not a quiet key',
    /read path is not seeing/.test(empty.out))
  // The two cases must not collapse back together: blind still nags, quiet does not.
  check('blind (journal non-empty) and quiet (journal empty) get DIFFERENT exit codes',
    empty.code === 3 && quiet0(empty.out), 'both must not be 3')
  check('it states plainly that this is not an all-clear', /NOT an all-clear/.test(empty.out))

  // Both halves of the floor: an empty journal too is a quiet period, still not an all-clear.
  const emptyJournal = resolve(dir, 'empty-journal.log')
  writeFileSync(emptyJournal, '')
  const quiet = run(emptyJournal, noEvents)
  // #176: an idle hour must NOT fail the unit, or the detector cries wolf every tick and gets
  // muted — the same end state as having no detector. But exit 0 here must never read like the
  // OK it sits next to: no evidence of wrongdoing is not evidence of no wrongdoing.
  check('0 observed + an EMPTY journal -> QUIET, exit 0 (no alert fatigue)', quiet.code === 0, `exit ${quiet.code}`)
  check('the quiet line does not claim an all-clear', /not an all-clear/.test(quiet.out))
  check('the quiet line says nothing was checked or claimed', /nothing is claimed/.test(quiet.out))
  check('QUIET is visibly distinct from OK', /^QUIET/m.test(quiet.out) && !/^OK/m.test(quiet.out))

  // NEGATIVE CONTROL for the floor itself. A tool that returned INCONCLUSIVE unconditionally
  // would pass every check above. The clean run at line ~79 is the counterpart — it observed
  // two events and exited 0 — so assert the floor did not swallow it.
  check('NEGATIVE CONTROL — a run that DID observe events still reports OK (exit 0)',
    neg.code === 0 && /^OK/m.test(neg.out), `exit ${neg.code}`)
  check('NEGATIVE CONTROL — the OK states how many events it actually checked',
    /all 2 on-relay post\(s\)/.test(neg.out))

  // --- alerting: an alarm with nowhere to go must say so ---
  console.log('\nalarm delivery')
  check('an unconfigured alarm path is reported on a CLEAN run, before an incident',
    /no alarm delivery path configured/.test(neg.out))
  check('a firing alarm with no delivery path says nobody was told',
    /ALARM NOT DELIVERED/.test(pos.out))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')
