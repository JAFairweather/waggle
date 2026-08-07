// Fresh-install regression for the resumable #263 alarm enrollment wrapper.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SETUP = join(ROOT, 'deploy', 'setup-tripwire-alarm.sh')
const work = mkdtempSync(join(tmpdir(), 'waggle-tripwire-setup-'))
const state = join(work, 'state')
const systemd = join(work, 'systemd')
const bin = join(work, 'bin')
mkdirSync(bin)
const calls = join(work, 'systemctl.calls')
const fakeSystemctl = join(bin, 'systemctl')
writeFileSync(fakeSystemctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nexit 0\n`)
chmodSync(fakeSystemctl, 0o755)
const env = { ...process.env, WAGGLE_ROOT: ROOT, WAGGLE_TRIPWIRE_STATE: state,
  WAGGLE_SYSTEMD_DIR: systemd, WAGGLE_SYSTEMCTL: fakeSystemctl }
let failed = 0
const check = (condition, label) => { console.log(`${condition ? '  ✓' : '  ✗'} ${label}`); if (!condition) failed++ }
const run = (args, input = '') => {
  try { return { code: 0, out: execFileSync('sh', [SETUP, ...args], { env, input, encoding: 'utf8', stderr: 'pipe' }) } }
  catch (error) { return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` } }
}

try {
  const bunker = `bunker://${'a'.repeat(64)}?relay=${encodeURIComponent('wss://relay.nave.pub')}`
  const args = ['enroll', '--recipient', 'b'.repeat(64), '--poster', 'c'.repeat(64), '--relay', 'wss://relay.nave.pub']
  const enrolled = run(args, `${bunker}\n`)
  check(enrolled.code === 0, 'one enrollment command succeeds')
  const staged = ['alarm.bunker-uri', 'alarm.client-nsec', 'alarm.to', 'drill.env']
  check(staged.every(name => existsSync(join(state, name))), 'enrollment creates every required staged file')
  check(staged.every(name => (statSync(join(state, name)).mode & 0o777) === 0o600), 'all staged files are owner-only')
  check(existsSync(join(systemd, 'waggle-tripwire.service.d', 'alarm.conf')) &&
    existsSync(join(systemd, 'waggle-tripwire-drill.service')), 'enrollment installs both systemd artifacts')
  check(readFileSync(calls, 'utf8').includes('daemon-reload'), 'enrollment reloads systemd')

  const repeated = run(args, `${bunker}\n`)
  check(repeated.code !== 0 && /refusing to replace credentials/.test(repeated.out),
    'repeat enrollment fails closed without rotating a working pairing')
  const checked = run(['check'])
  check(checked.code === 0 && /credentials private/.test(checked.out), 'check validates resumable installed state')
  const drilled = run(['drill'])
  const systemctlCalls = readFileSync(calls, 'utf8')
  check(drilled.code === 0 && /confirm the labelled DM/.test(drilled.out), 'drill demands recipient confirmation')
  check(systemctlCalls.includes('start waggle-tripwire-drill.service') && !systemctlCalls.includes('stop waggle-tripwire'),
    'drill starts only the isolated one-shot and never stops production detection')
  const bad = run(['enroll', '--recipient', 'b'.repeat(64), '--poster', 'c'.repeat(64), '--relay', 'https://relay.nave.pub'], `${bunker}\n`)
  check(bad.code === 2, 'non-WebSocket relay input is rejected')
} finally { rmSync(work, { recursive: true, force: true }) }

console.log(failed ? `\ntripwire_setup: ${failed} failure(s)` : '\ntripwire_setup: all checks passed')
process.exit(failed ? 1 : 0)
