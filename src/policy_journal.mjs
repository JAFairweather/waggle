// policy_journal.mjs — atomic, cross-process idempotency for the off-box Buzz policy
// service (#54). One immutable file per policy-derived key is the claim. O_EXCL makes the
// first claim atomic across forced-command processes; an atomic rename makes completion
// terminal. Nothing here signs or interprets evidence.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'

const HEX64 = /^[0-9a-f]{64}$/
const MAX_RECORD_BYTES = 96 * 1024
const fail = message => { throw new Error(`policy-journal: ${message}`) }
const hex = (value, label) => {
  const text = String(value || '').toLowerCase()
  if (!HEX64.test(text)) fail(`${label} must be 64-hex`)
  return text
}
const integer = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`)
  return value
}
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`)
  const actual = Object.keys(value).sort().join(',')
  const expected = [...keys].sort().join(',')
  if (actual !== expected) fail(`${label} has an invalid shape`)
}
const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return String(integer(value, 'record number'))
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (!value || typeof value !== 'object') fail('record contains a non-JSON value')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

const INFLIGHT = new Set(['version', 'status', 'key', 'request_digest', 'claimed_at'])
const TERMINAL = new Set(['version', 'status', 'key', 'request_digest', 'receipt', 'receipt_digest', 'buzz_event_id', 'result', 'completed_at'])

function validate(record, expectedKey = '') {
  if (record?.version !== 1 || !['in-flight', 'terminal'].includes(record?.status)) fail('record has an invalid version or status')
  exactKeys(record, record.status === 'in-flight' ? INFLIGHT : TERMINAL, 'record')
  record.key = hex(record.key, 'record key')
  record.request_digest = hex(record.request_digest, 'request_digest')
  if (expectedKey && record.key !== expectedKey) fail('record key does not match its filename')
  if (record.status === 'in-flight') integer(record.claimed_at, 'claimed_at')
  else {
    if (typeof record.receipt !== 'string' || !record.receipt || Buffer.byteLength(record.receipt) > 64 * 1024) fail('receipt must be 1..65536 bytes')
    record.receipt_digest = hex(record.receipt_digest, 'receipt_digest')
    if (createHash('sha256').update(record.receipt).digest('hex') !== record.receipt_digest) fail('receipt_digest does not match receipt bytes')
    if (record.buzz_event_id !== null) record.buzz_event_id = hex(record.buzz_event_id, 'buzz_event_id')
    if (!['accepted', 'refused', 'ambiguous'].includes(record.result)) fail('terminal result is invalid')
    if (record.result === 'accepted' && !record.buzz_event_id) fail('an accepted record requires buzz_event_id')
    if (record.result !== 'accepted' && record.buzz_event_id !== null) fail('a non-accepted record cannot name a Buzz event')
    integer(record.completed_at, 'completed_at')
  }
  return Object.freeze(record)
}

function readRecord(path, key) {
  let fd
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (e) {
    if (e.code === 'ENOENT') return null
    if (e.code === 'ELOOP') fail('record is not a private regular file')
    throw e
  }
  let raw
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || (st.mode & 0o077)) fail('record is not a private regular file')
    if (st.size < 2 || st.size > MAX_RECORD_BYTES) fail('record size is outside the allowed range')
    raw = readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
  let record
  try { record = JSON.parse(raw) } catch { fail('record is not JSON') }
  if (`${canonical(record)}\n` !== raw) fail('record is not canonical')
  return validate(record, key)
}

function fsyncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export class PolicyJournal {
  constructor(directory, { recoverySecret = '' } = {}) {
    if (!directory || typeof directory !== 'string') fail('directory is required')
    this.directory = resolve(directory)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const st = lstatSync(this.directory)
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700) fail('directory must be private, real, and mode 0700')
    this.owned = new Set()
    this.recoverySecret = String(recoverySecret || '')
    if (this.recoverySecret && !/^[A-Za-z0-9_-]{32,128}$/.test(this.recoverySecret)) fail('recoverySecret must be 32..128 URL-safe characters')
  }

  path(key) { return resolve(this.directory, `${hex(key, 'key')}.json`) }

  get(key) { const k = hex(key, 'key'); return readRecord(this.path(k), k) }

  claim(key, requestDigest, claimedAt = Math.floor(Date.now() / 1000)) {
    const k = hex(key, 'key'), digest = hex(requestDigest, 'request_digest')
    const record = validate({ version: 1, status: 'in-flight', key: k, request_digest: digest, claimed_at: integer(claimedAt, 'claimed_at') }, k)
    const path = this.path(k)
    let fd, created = false
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      created = true
      writeFileSync(fd, `${canonical(record)}\n`)
      fsyncSync(fd)
      closeSync(fd); fd = undefined
      fsyncDirectory(this.directory)
      this.owned.add(k)
      return Object.freeze({ claimed: true, record })
    } catch (e) {
      if (fd !== undefined) { try { closeSync(fd) } catch { /* best effort */ } }
      if (created) {
        try { unlinkSync(path); fsyncDirectory(this.directory) } catch (cleanup) {
          if (cleanup.code !== 'ENOENT') throw cleanup
        }
      }
      if (e.code !== 'EEXIST') throw e
      const existing = readRecord(path, k)
      if (!existing || existing.request_digest !== digest) fail('idempotency key already belongs to another request digest')
      return Object.freeze({ claimed: false, record: existing })
    }
  }

  commit(key, requestDigest, { receipt, buzzEventId = null, result, completedAt = Math.floor(Date.now() / 1000) } = {}) {
    const k = hex(key, 'key'), digest = hex(requestDigest, 'request_digest')
    const path = this.path(k), existing = readRecord(path, k)
    if (!existing) fail('cannot commit an unclaimed key')
    if (existing.request_digest !== digest) fail('request digest does not own this claim')
    if (existing.status === 'terminal') return existing
    if (!this.owned.has(k)) fail('this process does not own the in-flight claim')
    const receiptText = typeof receipt === 'string' ? receipt : ''
    const terminal = validate({ version: 1, status: 'terminal', key: k, request_digest: digest, receipt: receiptText,
      receipt_digest: createHash('sha256').update(receiptText).digest('hex'), buzz_event_id: buzzEventId === null ? null : hex(buzzEventId, 'buzz_event_id'),
      result, completed_at: integer(completedAt, 'completed_at') }, k)
    const tmp = resolve(this.directory, `.${k}.${randomBytes(8).toString('hex')}.tmp`)
    let fd
    try {
      fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      writeFileSync(fd, `${canonical(terminal)}\n`)
      fsyncSync(fd)
      closeSync(fd); fd = undefined
      renameSync(tmp, path)
      fsyncDirectory(this.directory)
      this.owned.delete(k)
      return terminal
    } finally {
      if (fd !== undefined) { try { closeSync(fd) } catch { /* best effort */ } }
      try { unlinkSync(tmp) } catch (e) { if (e.code !== 'ENOENT') throw e }
    }
  }

  // Explicit crash resolution. The recovery secret belongs only to the policy host;
  // the untrusted bridge never receives it. An operator uses this after proving the
  // former worker is dead. The exact claimed_at comparison prevents resolving a stale
  // observation, and `ambiguous` burns the key without claiming the external post failed.
  resolveOrphan(key, requestDigest, expectedClaimedAt, { recoverySecret, receipt, completedAt = Math.floor(Date.now() / 1000) } = {}) {
    const k = hex(key, 'key'), digest = hex(requestDigest, 'request_digest')
    if (!this.recoverySecret) fail('orphan recovery is disabled')
    const supplied = String(recoverySecret || '')
    const left = Buffer.from(this.recoverySecret), right = Buffer.from(supplied)
    if (left.length !== right.length || !timingSafeEqual(left, right)) fail('orphan recovery authorization failed')
    const existing = readRecord(this.path(k), k)
    if (!existing) fail('cannot resolve an unclaimed key')
    if (existing.request_digest !== digest) fail('request digest does not own this claim')
    if (existing.status === 'terminal') return existing
    if (existing.claimed_at !== integer(expectedClaimedAt, 'expectedClaimedAt')) fail('in-flight claim changed since operator inspection')
    this.owned.add(k)
    try { return this.commit(k, digest, { receipt, result: 'ambiguous', completedAt }) }
    finally { this.owned.delete(k) }
  }
}
