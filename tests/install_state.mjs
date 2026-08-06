import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildInstallReceipt, createInstallState, INSTALL_STEPS, loadInstallState,
  saveInstallState, transitionInstallStep, validateInstallState } from '../src/install_state.mjs'

let fails = 0
const ok = (name, pass) => { console.log(`${pass ? 'ok  ' : 'FAIL'} — ${name}`); if (!pass) fails++ }
const refuses = (name, fn, pattern) => { try { fn(); ok(name, false) } catch (error) { ok(name, pattern.test(error.message)) } }
const clock = value => () => new Date(value)
const base = {
  owner_pubkey: '1'.repeat(64), hive: { id: '2'.repeat(64), name: "James's hive", handle: 'jaf@dequalsf.com' },
  topology: { console_host: 'nave.pub', runtime_host: 'waggle.nave.pub', console_separate: true },
  channels: { inbox: 'a8186b53-537d-46ad-a7e7-b6486c58970e', staging: 'a8186b53-537d-46ad-a7e7-b6486c58970e' },
  relays: ['wss://relay.nave.pub', 'wss://nos.lol/'], features: { tripwire: true, codex: true, claude: true },
}
const state = createInstallState(base, { now: clock('2026-08-06T15:00:00.000Z'), random: () => Buffer.alloc(12, 0xab) })
ok('a stable installation id and complete closed step catalogue are generated',
  state.installation_id === `waggle-${'ab'.repeat(12)}` && Object.keys(state.steps).join(',') === INSTALL_STEPS.join(','))
ok('relay URLs are normalized and deduplicated without credentials', state.relays.join(',') === 'wss://relay.nave.pub,wss://nos.lol')
ok('multiple agent families and a separated console/runtime topology are first-class manifest facts',
  state.features.codex && state.features.claude && state.topology.console_separate)

const passed = transitionInstallStep(state, 'local_preflight', { status: 'passed', evidence: ['node 22.16.0', 'clock synchronized'] },
  { now: clock('2026-08-06T15:01:00.000Z') })
ok('step transition is immutable, timestamped, and evidence-bound',
  state.steps.local_preflight.status === 'pending' && passed.steps.local_preflight.status === 'passed' && passed.updated_at.endsWith('15:01:00.000Z'))
refuses('a pass without evidence cannot create a green checkbox',
  () => transitionInstallStep(state, 'host_bootstrap', { status: 'passed' }), /requires evidence/)
refuses('the step catalogue is closed',
  () => transitionInstallStep(state, 'click_some_more', { status: 'waiting', action: 'no' }), /unknown step/)
refuses('relay credentials never enter the manifest',
  () => createInstallState({ ...base, relays: ['wss://user:pass@relay.example'] }), /must not contain credentials/)
refuses('secret-shaped fields are refused recursively',
  () => validateInstallState({ ...state, identities: [{ role: 'Codex', pubkey: '3'.repeat(64), bunker_uri: 'bunker://bearer' }] }), /secret-bearing field/)
refuses('credential material is refused even when hidden under an innocent field name',
  () => transitionInstallStep(state, 'identity_custody', { status: 'waiting', action: 'paste bunker://bearer here' }), /credential material/)
refuses('wrong-channel shapes fail before host bootstrap',
  () => createInstallState({ ...base, channels: { ...base.channels, inbox: 'waggle-test' } }), /channel UUID/)

const root = mkdtempSync(join(tmpdir(), 'waggle-install-state-')), path = join(root, 'state.json')
saveInstallState(path, passed)
ok('durable state is mode 0600 and round-trips through validation',
  (statSync(path).mode & 0o777) === 0o600 && loadInstallState(path).installation_id === state.installation_id)
ok('the state file contains no credential material', !/nsec|bunker:\/\/|private_key/i.test(readFileSync(path, 'utf8')))
const receipt = buildInstallReceipt(passed)
ok('receipt is explicitly incomplete until every proof passes', !receipt.complete && receipt.proofs.local_preflight.status === 'passed')

const wizardRoot = mkdtempSync(join(tmpdir(), 'waggle-init-state-'))
const wizardConfig = join(wizardRoot, 'config.json'), wizardState = join(wizardRoot, 'install-state.json')
writeFileSync(wizardConfig, JSON.stringify({ relays: [], recipients: [], public: {
  relays: base.relays, inbox: base.channels.inbox, staging_inbox: base.channels.staging,
  owner_pubkey: base.owner_pubkey, approvers: [base.owner_pubkey], grantors: [base.owner_pubkey], watch_events: ['4'.repeat(64)], watch_authors: [],
} }))
const wizard = spawnSync(process.execPath, ['tools/waggle-init.mjs'], { cwd: process.cwd(), encoding: 'utf8',
  env: { ...process.env, CONFIG_PATH: wizardConfig, WAGGLE_INSTALL_STATE_PATH: wizardState } })
const generated = existsSync(wizardState) ? loadInstallState(wizardState) : null
if (wizard.status !== 0) console.error(wizard.stderr || wizard.stdout)
ok('waggle-init creates and advances the same durable state without prompting on complete config',
  wizard.status === 0 && generated?.steps.local_preflight.status === 'passed' && generated?.steps.public_config.status === 'passed')
const check = spawnSync(process.execPath, ['tools/waggle-init.mjs', '--check'], { cwd: process.cwd(), encoding: 'utf8',
  env: { ...process.env, CONFIG_PATH: wizardConfig, WAGGLE_INSTALL_STATE_PATH: wizardState } })
ok('--check resumes state without changing its stable installation id',
  check.status === 0 && loadInstallState(wizardState).installation_id === generated.installation_id)
const receiptRun = spawnSync(process.execPath, ['tools/waggle-init.mjs', '--state', wizardState, '--receipt'],
  { cwd: process.cwd(), encoding: 'utf8' })
ok('--receipt emits machine-readable secret-free state for Console Setup',
  receiptRun.status === 0 && JSON.parse(receiptRun.stdout).installation_id === generated.installation_id && !/nsec|bunker:\/\//i.test(receiptRun.stdout))

console.log(fails ? `\ninstall_state: ${fails} FAILED` : '\ninstall_state: all checks passed')
process.exit(fails ? 1 : 0)
