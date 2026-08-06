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

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, lstatSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { WebSocketServer } from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TOOL = resolve(ROOT, 'tools', 'tripwire.mjs')
const INIT = resolve(ROOT, 'tools', 'tripwire-alarm-init.mjs')
const BUNKER_INIT = resolve(ROOT, 'tools', 'tripwire-alarm-bunker-init.mjs')
const DROP_IN = resolve(ROOT, 'deploy', 'tripwire-alarm.conf')
const BUNKER_DROP_IN = resolve(ROOT, 'deploy', 'tripwire-alarm-bunker.conf')
const BASE_UNIT = resolve(ROOT, 'deploy', 'tripwire.service')
const TIMER_UNIT = resolve(ROOT, 'deploy', 'tripwire.timer')
const DRILL_UNIT = resolve(ROOT, 'deploy', 'waggle-tripwire-drill.service')
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

function runAsync(args, env) {
  return new Promise(resolve => {
    const child = spawn('node', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('exit', code => resolve({ code, out: stdout + stderr }))
  })
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

  console.log('\nalarm credential files')
  const credentials = resolve(dir, 'credentials')
  const init = spawnSync('node', [INIT, '--directory', credentials, '--recipient', POSTER], { encoding: 'utf8' })
  check('initializer succeeds without accepting a secret', init.status === 0, init.stderr)
  check('initializer output never prints an nsec', !/nsec1/i.test((init.stdout || '') + (init.stderr || '')))
  const alarmNsecPath = resolve(credentials, 'alarm.nsec')
  const alarmToPath = resolve(credentials, 'alarm.to')
  check('alarm nsec is written mode 0600', (lstatSync(alarmNsecPath).mode & 0o777) === 0o600)
  check('recipient is written mode 0600', (lstatSync(alarmToPath).mode & 0o777) === 0o600)
  const alarmSecret = nip19.decode(readFileSync(alarmNsecPath, 'utf8').trim()).data
  check('initializer mints a separate identity', getPublicKey(alarmSecret) !== nip19.decode(POSTER).data)
  check('initializer refuses to overwrite a live credential directory',
    spawnSync('node', [INIT, '--directory', credentials, '--recipient', POSTER], { encoding: 'utf8' }).status === 1)

  const bunkerDirectory = resolve(dir, 'bunker-credentials')
  const bunkerPub = getPublicKey(generateSecretKey())
  const bunkerUri = `bunker://${bunkerPub}?relay=wss%3A%2F%2Frelay.nave.pub&secret=pairing-secret`
  const bunkerInit = spawnSync('node', [BUNKER_INIT, '--directory', bunkerDirectory,
    '--recipient', POSTER, '--poster', nip19.decode(POSTER).data], { encoding: 'utf8', input: bunkerUri + '\n' })
  const bunkerUriPath = resolve(bunkerDirectory, 'alarm.bunker-uri')
  const bunkerClientPath = resolve(bunkerDirectory, 'alarm.client-nsec')
  const bunkerToPath = resolve(bunkerDirectory, 'alarm.to')
  check('keyless initializer stages a Bunker pairing from stdin', bunkerInit.status === 0, bunkerInit.stderr)
  check('keyless initializer output exposes neither URI nor client nsec',
    !bunkerInit.stdout.includes(bunkerUri) && !/pairing-secret|nsec1/i.test((bunkerInit.stdout || '') + (bunkerInit.stderr || '')))
  check('all keyless pairing files are mode 0600', [bunkerUriPath, bunkerClientPath, bunkerToPath]
    .every(path => (lstatSync(path).mode & 0o777) === 0o600))
  check('keyless initializer preserves the exact URI without ever minting the alarm identity locally',
    readFileSync(bunkerUriPath, 'utf8').trim() === bunkerUri && nip19.decode(readFileSync(bunkerClientPath, 'utf8').trim()).type === 'nsec')
  check('keyless initializer refuses the bridge poster as the alarm identity',
    spawnSync('node', [BUNKER_INIT, '--directory', resolve(dir, 'same-poster'), '--recipient', POSTER, '--poster', POSTER],
      { encoding: 'utf8', input: `bunker://${nip19.decode(POSTER).data}?relay=wss%3A%2F%2Frelay.nave.pub\n` }).status === 1)
  check('keyless initializer refuses a Bunker URI on argv',
    spawnSync('node', [BUNKER_INIT, '--directory', resolve(dir, 'argv-uri'), '--recipient', POSTER, bunkerUri],
      { encoding: 'utf8' }).status === 1)
  check('keyless initializer refuses to overwrite a live pairing directory',
    spawnSync('node', [BUNKER_INIT, '--directory', bunkerDirectory, '--recipient', POSTER],
      { encoding: 'utf8', input: bunkerUri + '\n' }).status === 1)

  const credentialRun = spawnSync('node', [TOOL, '--since-min', '60', '--journal', full, '--events-from', eventsFile], {
    env: { ...process.env, POSTER, ALARM_NSEC: '', ALARM_TO: '', ALARM_NSEC_FILE: alarmNsecPath, ALARM_TO_FILE: alarmToPath, ALARM_LOG_PATH: ALARMS },
    encoding: 'utf8',
  })
  const credentialOut = (credentialRun.stdout || '') + (credentialRun.stderr || '')
  check('credential-file configuration is accepted on a clean run', credentialRun.status === 0, `exit ${credentialRun.status}`)
  check('configured credential files remove the no-delivery warning', !/no alarm delivery path configured/.test(credentialOut))

  chmodSync(alarmNsecPath, 0o644)
  const loose = spawnSync('node', [TOOL, '--journal', full, '--events-from', eventsFile], {
    env: { ...process.env, POSTER, ALARM_NSEC: '', ALARM_TO: '', ALARM_NSEC_FILE: alarmNsecPath, ALARM_TO_FILE: alarmToPath, ALARM_LOG_PATH: ALARMS },
    encoding: 'utf8',
  })
  check('group/world-readable secret is rejected', loose.status === 1 && /must not be group\/world accessible/.test((loose.stderr || '') + (loose.stdout || '')))
  chmodSync(alarmNsecPath, 0o600)

  const symlink = resolve(dir, 'alarm-link.nsec')
  symlinkSync(alarmNsecPath, symlink)
  const linked = spawnSync('node', [TOOL, '--journal', full, '--events-from', eventsFile], {
    env: { ...process.env, POSTER, ALARM_NSEC: '', ALARM_TO: '', ALARM_NSEC_FILE: symlink, ALARM_TO_FILE: alarmToPath, ALARM_LOG_PATH: ALARMS },
    encoding: 'utf8',
  })
  check('symlinked secret is rejected', linked.status === 1 && /non-symlink/.test((linked.stderr || '') + (linked.stdout || '')))

  const publicHex = nip19.decode(POSTER).data
  const hexInit = spawnSync('node', [INIT, '--directory', resolve(dir, 'hex-recipient'), '--recipient', publicHex], { encoding: 'utf8' })
  check('a public 64-hex recipient is not mistaken for an nsec', hexInit.status === 0, hexInit.stderr)

  let relayAccept = true, receivedWrap = null
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => { relay.once('listening', resolve); relay.once('error', reject) })
  relay.on('connection', socket => socket.on('message', bytes => {
    let frame
    try { frame = JSON.parse(bytes.toString()) } catch { return }
    if (frame[0] !== 'EVENT') return
    receivedWrap = frame[1]
    socket.send(JSON.stringify(['OK', frame[1].id, relayAccept, relayAccept ? '' : 'drill refusal']))
  }))
  const relayUrl = `ws://127.0.0.1:${relay.address().port}`
  const drillEnv = { ...process.env, POSTER, ALARM_NSEC: '', ALARM_TO: '', ALARM_NSEC_FILE: alarmNsecPath,
    ALARM_TO_FILE: alarmToPath, BUZZ_RELAY_URL: relayUrl, ALARM_LOG_PATH: ALARMS }
  const drill = await runAsync([TOOL, '--poster', POSTER, '--drill-alarm'], drillEnv)
  check('live drill exits 0 only after relay acceptance', drill.code === 0 && /DRILL OK/.test(drill.out), `exit ${drill.code}`)
  check('live drill sends one valid sealed kind:1059 to the configured recipient',
    receivedWrap?.kind === 1059 && verifyEvent(receivedWrap) && receivedWrap.tags.length === 1 &&
    receivedWrap.tags[0][0] === 'p' && receivedWrap.tags[0][1] === nip19.decode(POSTER).data)
  check('live drill output never exposes its signing secret', !/nsec1/i.test(drill.out))
  relayAccept = false; receivedWrap = null
  const refusedDrill = await runAsync([TOOL, '--poster', POSTER, '--drill-alarm'], drillEnv)
  check('live drill exits 4 when no relay accepts the alert', refusedDrill.code === 4 && /ALARM NOT DELIVERED/.test(refusedDrill.out), `exit ${refusedDrill.code}`)
  receivedWrap = null
  const noExplicitRelay = await runAsync([TOOL, '--poster', POSTER, '--drill-alarm'], {
    ...drillEnv, BUZZ_RELAY_URL: '',
  })
  check('live drill refuses a missing explicit relay before any publication',
    noExplicitRelay.code === 1 && /requires exactly one explicit BUZZ_RELAY_URL/.test(noExplicitRelay.out) && receivedWrap === null,
    `exit ${noExplicitRelay.code}`)
  const queryCredentialRelay = await runAsync([TOOL, '--poster', POSTER, '--drill-alarm'], {
    ...drillEnv, BUZZ_RELAY_URL: `${relayUrl}/?token=secret`,
  })
  check('live drill refuses relay query credentials before any publication',
    queryCredentialRelay.code === 1 && /credential-free/.test(queryCredentialRelay.out) && receivedWrap === null,
    `exit ${queryCredentialRelay.code}`)
  const fragmentCredentialRelay = await runAsync([TOOL, '--poster', POSTER, '--drill-alarm'], {
    ...drillEnv, BUZZ_RELAY_URL: `${relayUrl}/#credential`,
  })
  check('live drill refuses relay fragment credentials before any publication',
    fragmentCredentialRelay.code === 1 && /credential-free/.test(fragmentCredentialRelay.out) && receivedWrap === null,
    `exit ${fragmentCredentialRelay.code}`)
  const badRelayBeforeSecret = await runAsync([TOOL, '--poster', POSTER, '--drill-alarm'], {
    ...drillEnv,
    BUZZ_RELAY_URL: `${relayUrl}/?token=secret`,
    ALARM_NSEC_FILE: resolve(dir, 'must-not-be-read.nsec'),
  })
  check('invalid drill relay is refused before any alarm credential is read',
    badRelayBeforeSecret.code === 1 && /credential-free/.test(badRelayBeforeSecret.out) &&
      !/ALARM_NSEC_FILE cannot be read/.test(badRelayBeforeSecret.out) && receivedWrap === null,
    `exit ${badRelayBeforeSecret.code}`)
  await new Promise(resolve => relay.close(resolve))

  const dropIn = readFileSync(DROP_IN, 'utf8')
  check('the live-safe drop-in loads both systemd credentials',
    dropIn.includes('LoadCredential=alarm.nsec:/etc/waggle-tripwire/alarm.nsec') &&
    dropIn.includes('LoadCredential=alarm.to:/etc/waggle-tripwire/alarm.to'))
  check('the drop-in maps systemd credential paths without replacing the detector command',
    dropIn.includes('Environment=ALARM_NSEC_FILE=%d/alarm.nsec') &&
    dropIn.includes('Environment=ALARM_TO_FILE=%d/alarm.to') && !dropIn.includes('ExecStart='))

  const baseUnit = readFileSync(BASE_UNIT, 'utf8')
  const timerUnit = readFileSync(TIMER_UNIT, 'utf8')
  check('the base detector unit contains no signer credential mode',
    !baseUnit.includes('LoadCredential=alarm.') &&
    !baseUnit.includes('Environment=ALARM_NSEC_FILE=') &&
    !baseUnit.includes('Environment=ALARM_BUNKER_URI_FILE='))
  check('the shipped unit templates require the canonical waggle-tripwire installed names',
    baseUnit.includes('install as waggle-tripwire.service') &&
    timerUnit.includes('/etc/systemd/system/waggle-tripwire.service') &&
    timerUnit.includes('/etc/systemd/system/waggle-tripwire.timer') &&
    timerUnit.includes('enable --now waggle-tripwire.timer') &&
    !timerUnit.includes('enable --now tripwire.timer'))

  const bunkerDropIn = readFileSync(BUNKER_DROP_IN, 'utf8')
  check('the preferred Bunker drop-in loads only pairing and recipient credential files',
    bunkerDropIn.includes('LoadCredential=alarm.bunker-uri:/etc/waggle-tripwire/alarm.bunker-uri') &&
    bunkerDropIn.includes('LoadCredential=alarm.client-nsec:/etc/waggle-tripwire/alarm.client-nsec') &&
    bunkerDropIn.includes('LoadCredential=alarm.to:/etc/waggle-tripwire/alarm.to') &&
    !bunkerDropIn.includes('LoadCredential=alarm.nsec:'))
  check('the preferred drop-in passes only systemd credential paths and never replaces detection',
    bunkerDropIn.includes('Environment=ALARM_BUNKER_URI_FILE=%d/alarm.bunker-uri') &&
    bunkerDropIn.includes('Environment=ALARM_NIP46_CLIENT_NSEC_FILE=%d/alarm.client-nsec') &&
    bunkerDropIn.includes('Environment=ALARM_TO_FILE=%d/alarm.to') &&
    !bunkerDropIn.includes('ExecStart=') && !/bunker:\/\//.test(bunkerDropIn))

  const drillUnit = readFileSync(DRILL_UNIT, 'utf8')
  check('the production alarm drill is an isolated static unit with no persistent activation',
    drillUnit.includes('ExecStart=/usr/bin/node /opt/waggle-read/tools/tripwire.mjs --drill-alarm') &&
    !drillUnit.includes('[Install]') && !drillUnit.includes('WantedBy='))
  check('process loss cannot disable detection or leave a manager-wide drill flag',
    !/systemctl|waggle-tripwire\.timer|TRIPWIRE_DRILL|set-environment|unset-environment/.test(drillUnit))
  check('the isolated drill receives only credential paths, never signer values',
    drillUnit.includes('LoadCredential=alarm.bunker-uri:/etc/waggle-tripwire/alarm.bunker-uri') &&
    drillUnit.includes('LoadCredential=alarm.client-nsec:/etc/waggle-tripwire/alarm.client-nsec') &&
    drillUnit.includes('LoadCredential=alarm.to:/etc/waggle-tripwire/alarm.to') &&
    !/bunker:\/\/|nsec1/.test(drillUnit))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')
