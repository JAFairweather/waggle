// install_state.mjs — the shared, non-secret state machine for owner setup.
//
// The CLI and Console must render the same facts. This file is deliberately UI-free and
// host-free: it defines the durable manifest, legal transitions, evidence boundary, and receipt.
// A later host bootstrap consumes this state; it does not invent a second setup vocabulary.

import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync, chmodSync,
  fsyncSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export const INSTALL_STATE_VERSION = 1
export const INSTALL_STEPS = Object.freeze([
  'local_preflight', 'public_config', 'host_bootstrap', 'identity_custody',
  'buzz_nvoy_grants', 'agent_runtimes', 'live_proofs', 'installation_receipt',
])
export const STEP_STATUSES = Object.freeze(['pending', 'waiting', 'passed', 'failed'])

const HEX64 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SECRET_FIELD = /(^|_)(nsec|private_?key|secret|password|token|bunker_?uri|client_?nsec)($|_)/i
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/
const clone = value => JSON.parse(JSON.stringify(value))
const fail = message => { throw new Error(`install-state: ${message}`) }
const cleanText = (value, label, max = 256) => {
  if (typeof value !== 'string') fail(`${label} must be text`)
  const out = String(value || '').trim()
  if (!out || out.length > max || /[\u0000-\u001f\u007f]/.test(out)) fail(`${label} must be non-empty printable text (${max} chars max)`)
  return out
}
const optionalHex = (value, label) => {
  if (value == null || value === '') return null
  const out = String(value).toLowerCase()
  if (!HEX64.test(out)) fail(`${label} must be a 64-hex public key`)
  return out
}
const channel = (value, label) => {
  if (value == null || value === '') return null
  const out = String(value).toLowerCase()
  if (!UUID.test(out)) fail(`${label} must be a channel UUID`)
  return out
}
const relay = value => {
  let parsed
  try { parsed = new URL(String(value)) } catch { fail('relay must be a valid URL') }
  if (parsed.protocol !== 'wss:') fail('relay must use wss://')
  if (parsed.username || parsed.password) fail('relay URL must not contain credentials')
  parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}
const iso = (value, label) => {
  const out = String(value || '')
  if (!ISO.test(out) || Number.isNaN(Date.parse(out))) fail(`${label} must be an ISO timestamp`)
  return out
}
function rejectSecrets(value, path = '$') {
  if (typeof value === 'string' && /(?:\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}|\bbunker:\/\/)/i.test(value)) {
    fail(`${path} contains credential material and cannot enter installation state`)
  }
  if (Array.isArray(value)) return value.forEach((item, index) => rejectSecrets(item, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) fail(`${path}.${key} is a secret-bearing field and cannot enter installation state`)
    rejectSecrets(item, `${path}.${key}`)
  }
}

export function createInstallState(input, { now = () => new Date(), random = randomBytes } = {}) {
  const createdAt = now().toISOString()
  const relays = [...new Set((input.relays || []).map(relay))]
  if (!relays.length) fail('at least one relay is required')
  const suffix = Buffer.from(random(12)).toString('hex')
  if (!/^[0-9a-f]{24}$/.test(suffix)) fail('random source did not return 12 bytes')
  const state = {
    schema: 'waggle-owner-install', version: INSTALL_STATE_VERSION,
    installation_id: `waggle-${suffix}`, created_at: createdAt, updated_at: createdAt,
    owner: { pubkey: optionalHex(input.owner_pubkey, 'owner_pubkey') },
    hive: {
      id: optionalHex(input.hive?.id, 'hive.id'),
      name: input.hive?.name ? cleanText(input.hive.name, 'hive.name') : null,
      handle: input.hive?.handle ? cleanText(input.hive.handle, 'hive.handle') : null,
    },
    topology: {
      console_host: input.topology?.console_host ? cleanText(input.topology.console_host, 'topology.console_host') : null,
      runtime_host: input.topology?.runtime_host ? cleanText(input.topology.runtime_host, 'topology.runtime_host') : null,
      console_separate: Boolean(input.topology?.console_separate),
    },
    channels: { inbox: channel(input.channels?.inbox, 'channels.inbox'), staging: channel(input.channels?.staging, 'channels.staging') },
    relays,
    features: {
      consent: Boolean(input.features?.consent), following: Boolean(input.features?.following),
      tripwire: Boolean(input.features?.tripwire), codex: Boolean(input.features?.codex), claude: Boolean(input.features?.claude),
    },
    identities: [],
    steps: Object.fromEntries(INSTALL_STEPS.map(id => [id, { status: 'pending', updated_at: createdAt, evidence: [], action: null }])),
  }
  return validateInstallState(state)
}

export function validateInstallState(candidate) {
  rejectSecrets(candidate)
  const state = clone(candidate)
  if (state.schema !== 'waggle-owner-install' || state.version !== INSTALL_STATE_VERSION) fail('unsupported schema or version')
  if (!/^waggle-[0-9a-f]{24}$/.test(state.installation_id || '')) fail('invalid installation_id')
  iso(state.created_at, 'created_at'); iso(state.updated_at, 'updated_at')
  optionalHex(state.owner?.pubkey, 'owner.pubkey'); optionalHex(state.hive?.id, 'hive.id')
  channel(state.channels?.inbox, 'channels.inbox'); channel(state.channels?.staging, 'channels.staging')
  if (!Array.isArray(state.relays) || !state.relays.length) fail('relays must be a non-empty array')
  state.relays = [...new Set(state.relays.map(relay))]
  if (!Array.isArray(state.identities)) fail('identities must be an array')
  for (const identity of state.identities) {
    optionalHex(identity.pubkey, 'identity.pubkey'); cleanText(identity.role, 'identity.role', 64)
    if (identity.runtime != null) cleanText(identity.runtime, 'identity.runtime', 128)
  }
  if (!state.steps || Object.keys(state.steps).sort().join(',') !== [...INSTALL_STEPS].sort().join(',')) fail('steps must contain the complete closed step catalogue')
  for (const id of INSTALL_STEPS) {
    const step = state.steps[id]
    if (!STEP_STATUSES.includes(step?.status)) fail(`${id}.status is invalid`)
    iso(step.updated_at, `${id}.updated_at`)
    if (!Array.isArray(step.evidence)) fail(`${id}.evidence must be an array`)
    for (const item of step.evidence) cleanText(item, `${id}.evidence`, 512)
    if ((step.status === 'passed' || step.status === 'failed') && !step.evidence.length) fail(`${id} ${step.status} requires evidence`)
    if (step.action != null) cleanText(step.action, `${id}.action`, 512)
  }
  return state
}

export function transitionInstallStep(candidate, id, { status, evidence = [], action = null }, { now = () => new Date() } = {}) {
  const state = validateInstallState(candidate)
  if (!INSTALL_STEPS.includes(id)) fail(`unknown step ${id}`)
  if (!STEP_STATUSES.includes(status)) fail(`invalid status ${status}`)
  const stamp = now().toISOString()
  state.steps[id] = { status, updated_at: stamp, evidence: [...evidence], action }
  state.updated_at = stamp
  return validateInstallState(state)
}

export function buildInstallReceipt(candidate) {
  const state = validateInstallState(candidate)
  return {
    schema: 'waggle-installation-receipt', version: 1, installation_id: state.installation_id,
    generated_at: state.updated_at, owner: state.owner, hive: state.hive, topology: state.topology,
    channels: state.channels, relays: state.relays, features: state.features, identities: state.identities,
    proofs: Object.fromEntries(INSTALL_STEPS.map(id => [id, clone(state.steps[id])])),
    complete: INSTALL_STEPS.every(id => state.steps[id].status === 'passed'),
  }
}

export function loadInstallState(path) {
  const st = lstatSync(path)
  if (!st.isFile() || st.isSymbolicLink()) fail('state path must be a regular non-symlink file')
  if ((st.mode & 0o077) !== 0) fail('state file must not be group/world accessible')
  if (st.size > 1024 * 1024) fail('state file exceeds 1 MiB')
  return validateInstallState(JSON.parse(readFileSync(path, 'utf8')))
}

export function saveInstallState(path, candidate) {
  const state = validateInstallState(candidate)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.tmp-${process.pid}`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`); fsyncSync(fd); closeSync(fd)
    chmodSync(temp, 0o600); renameSync(temp, path)
    const dirFd = openSync(dirname(path), 'r')
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  } catch (error) {
    try { closeSync(fd) } catch { /* closed */ }
    try { unlinkSync(temp) } catch { /* renamed or absent */ }
    throw error
  }
  return state
}
