#!/usr/bin/env node
// setup-state.mjs — secret-free, resumable owner-install state machine.
// It records public facts and proof receipts only. Credentials never belong here.

import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync, chmodSync, fsyncSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import os from 'node:os'

const DEFAULT = process.env.WAGGLE_SETUP_STATE || resolve(os.homedir(), '.waggle', 'setup-state.json')
const STEP_NAMES = new Set(['prepare-local', 'bootstrap-host', 'pair-custody', 'connect-buzz', 'prove-installation', 'finish'])
const STATUS = new Set(['pending', 'pass', 'fail', 'deferred'])
const SECRET = /(nsec1|-----begin|bunker:\/\/|nip46|api[_-]?key|private[_-]?key|secret)/i
const ID = /^[0-9a-f-]{36}$/i
const fail = message => { throw new Error(`setup-state: ${message}`) }
const pathOf = value => resolve(String(value || DEFAULT))
function regularState(path, mustExist = false) {
  if (existsSync(path)) {
    const st = lstatSync(path)
    if (!st.isFile() || st.isSymbolicLink()) fail('state path must be a regular non-symlink file')
    if ((st.mode & 0o777) !== 0o600) fail('state file must be mode 0600')
  } else if (mustExist) fail('state file does not exist')
}
function safe(value, label) { if (SECRET.test(typeof value === 'string' ? value : JSON.stringify(value) || '')) fail(`${label} contains credential-like material`) }
function emptyState() {
  const now = new Date().toISOString()
  return { version: 1, installation_id: randomUUID(), created_at: now, updated_at: now,
    steps: Object.fromEntries([...STEP_NAMES].map(name => [name, { status: 'pending', evidence: [] }])), public: {} }
}
function read(path) {
  regularState(path, true)
  let state
  try { state = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { fail(`invalid JSON: ${e.message}`) }
  if (state.version !== 1 || !ID.test(String(state.installation_id || '')) || !state.steps || typeof state.steps !== 'object') fail('invalid state schema')
  safe(state, 'state')
  return state
}
function write(path, state) {
  safe(state, 'state')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  // Do not follow a pre-existing attacker-controlled temp path. The rename is atomic,
  // but only after the temporary file itself was created exclusively.
  writeFileSync(tmp, JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  chmodSync(tmp, 0o600)
  const fd = openSync(tmp, constants.O_RDONLY); try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, path)
  const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(dir) } finally { closeSync(dir) }
}
function create(path) { if (existsSync(path)) { regularState(path); return read(path) }; const state = emptyState(); write(path, state); return state }
function record(path, step, status, evidence, publicFacts = {}) {
  if (!STEP_NAMES.has(step)) fail(`unknown step: ${step}`)
  if (!STATUS.has(status)) fail(`unknown status: ${status}`)
  const state = read(path); safe(evidence, 'evidence'); safe(publicFacts, 'public facts')
  state.steps[step] = { status, evidence: evidence ? [String(evidence)] : [], recorded_at: new Date().toISOString() }
  state.public = { ...state.public, ...publicFacts }; write(path, state); return state
}
function summary(state) { return { installation_id: state.installation_id, created_at: state.created_at, updated_at: state.updated_at, steps: state.steps, complete: Object.values(state.steps).every(s => s.status === 'pass') } }
function usage() { console.log('usage: setup-state.mjs <init|record|check|report> [--path FILE] [--step NAME --status STATUS --evidence TEXT]') }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), command = args[0] || 'check', get = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
  try {
    const path = pathOf(get('--path'))
    if (command === 'init') console.log(JSON.stringify({ state: path, ...summary(create(path)) }, null, 2))
    else if (command === 'record') console.log(JSON.stringify(summary(record(path, get('--step'), get('--status'), get('--evidence'))), null, 2))
    else if (command === 'check' || command === 'report') console.log(JSON.stringify(summary(read(path)), null, 2))
    else { usage(); process.exitCode = 2 }
  } catch (e) { console.error(e.message); process.exitCode = 1 }
}

export { create, read, record, summary, STEP_NAMES }
