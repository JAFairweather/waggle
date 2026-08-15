// channel_seat_runner.mjs — the broker-side actuator for #488. Console-signed intent in, receipt
// out, one line appended to authorized_keys and nothing else.
//
// Shaped after `buzz_policy_runner.mjs`: deployment fixes the config path and the executable, stdin
// is the only caller-controlled input, and no argv is accepted. What differs is the authority. The
// policy lane's rule is "evidence, not instructions" — a third party observes and the bridge acts on
// what it observed. A seat is the opposite: owner intent IS the instruction, exactly as
// `agent_lifecycle.mjs` says. So the safety here is the approver signature, the closed operation,
// and a config that owns every byte the requester does not.
//
// THE REPLAY THIS GUARDS. A signed intent is a bearer artifact: whoever holds the bytes can present
// them again. Re-presenting one after the owner removed a key would re-seat it, and nothing in the
// resulting file would look wrong. Two things stop it — a freshness window on `created_at`, and an
// O_EXCL journal entry per event id, which also makes an honest retry idempotent: the same intent
// delivered twice returns the recorded receipt rather than deciding again.

import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { verifyEvent } from 'nostr-tools/pure'
import { canonicalJson } from './buzz_policy_core.mjs'
import { parseSeatIntent, seatDecision, seatReceipt } from './channel_seat.mjs'

export const SEAT_COMMAND_D = 'waggle-channel-seat'
export const SEAT_EVENT_KIND = 30078

const HEX64 = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const fail = message => { throw new Error(`channel-seat-runner: ${message}`) }

// Same private-file discipline as the policy runner: a regular file, not a symlink, not readable by
// group or other, with a size floor — a scan of an empty file once reported everything clean.
function privateText(path, maxBytes = 64 * 1024) {
  let fd
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch { fail('config cannot be read as a regular non-symlink file') }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || (st.mode & 0o077) || st.size < 2 || st.size > maxBytes) fail('private input must be a bounded private regular file')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

export function loadSeatConfig(path) {
  let config
  try { config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(privateText(path))) } catch (error) {
    if (String(error?.message || '').startsWith('channel-seat-runner:')) throw error
    fail('config is not valid UTF-8 JSON')
  }
  const want = ['approvers', 'authorized_keys_path', 'forced_command', 'instance', 'journal_path', 'version'].join(',')
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).sort().join(',') !== want) fail('config has an invalid shape')
  if (config.version !== 1 || !ID.test(String(config.instance || ''))) fail('config version or instance is invalid')
  if (!Array.isArray(config.approvers) || !config.approvers.length || !config.approvers.every(key => HEX64.test(String(key || '')))) fail('approvers must be a non-empty list of 64-hex public keys')
  if (!isAbsolute(String(config.forced_command || '')) || !isAbsolute(String(config.authorized_keys_path || '')) || !isAbsolute(String(config.journal_path || ''))) fail('paths must be absolute')
  return Object.freeze({ ...config, approvers: Object.freeze(config.approvers.map(key => key.toLowerCase())) })
}

export async function readBoundedIntent(stream, maxBytes = 16 * 1024) {
  const chunks = []; let total = 0
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk); total += bytes.length
    if (total > maxBytes) fail(`intent exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  if (!total) fail('intent is empty')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }
  catch { fail('intent is not valid UTF-8') }
}

/**
 * Verify the envelope: a complete, signed kind:30078 from an approver on this broker's roster,
 * addressed to this catalogue by its `d` tag, and recent.
 *
 * Returns `{ ok: true, event, intent }` or `{ ok: false, reason }`. It does not throw on hostile
 * input — a runner that throws on a malformed line is a runner a stranger can stop.
 */
export function verifySeatEvent(raw, { approvers = [], now = Math.floor(Date.now() / 1000), maxAgeSeconds = 900, maxFutureSkew = 60 } = {}) {
  const refuse = reason => Object.freeze({ ok: false, reason })
  let event
  try { event = JSON.parse(raw) } catch { return refuse('intent is not JSON') }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return refuse('intent is not an event')
  if (event.kind !== SEAT_EVENT_KIND) return refuse('intent is not a kind:30078 control event')
  if (!HEX64.test(String(event.pubkey || '').toLowerCase())) return refuse('intent has no author')
  const author = String(event.pubkey).toLowerCase()
  if (!approvers.includes(author)) return refuse('intent is not signed by an approver on this broker')
  if (!Number.isSafeInteger(event.created_at) || event.created_at < now - maxAgeSeconds || event.created_at > now + maxFutureSkew) {
    return refuse('intent is outside the freshness window — a signed seat is a bearer artifact and does not stay valid')
  }
  if (!Array.isArray(event.tags) || !event.tags.some(tag => Array.isArray(tag) && tag[0] === 'd' && tag[1] === SEAT_COMMAND_D)) {
    return refuse(`intent is not addressed to ${SEAT_COMMAND_D}`)
  }
  let valid = false
  try { valid = verifyEvent(JSON.parse(JSON.stringify(event))) } catch { valid = false }
  if (!valid) return refuse('intent signature or id is invalid')
  let body
  try { body = JSON.parse(String(event.content || '')) } catch { return refuse('intent content is not JSON') }
  if (canonicalJson(body) !== event.content) return refuse('intent content is not canonical JSON')
  const intent = parseSeatIntent(body)
  if (intent.ok !== true) return refuse(intent.reason)
  return Object.freeze({ ok: true, event: Object.freeze(event), intent })
}

// The journal entry IS the replay guard, so it is written with O_EXCL before the seat is applied and
// never rewritten. An entry that exists is the answer; deciding again would be the second write this
// guard exists to prevent.
function recallOrClaim(journalPath, eventId) {
  try { mkdirSync(journalPath, { recursive: true, mode: 0o700 }) } catch { fail('journal directory cannot be created') }
  const file = resolve(journalPath, `${eventId}.json`)
  let fd
  try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600) }
  catch {
    let prior = null
    try { prior = JSON.parse(readFileSync(file, 'utf8')) } catch { prior = null }
    // A claimed-but-unwritten entry means a previous run died between claim and receipt. Reporting
    // it as a completed seat would be the worst available answer; reporting it as unknown is the
    // honest one, and the operator can read the broker's own file.
    return { replay: true, prior, file }
  }
  return { replay: false, fd, file }
}

// authorized_keys is opened O_NOFOLLOW and appended in one write. It must already exist: the broker
// install creates it, and a runner that creates it would happily seat into a file sshd never reads.
function appendLine(path, line) {
  let fd
  try { fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW) } catch { fail('authorized_keys cannot be opened as a regular non-symlink file for append') }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) fail('authorized_keys is not a regular file')
    if (st.mode & 0o022) fail('authorized_keys is group- or world-writable — sshd would refuse it and so does this')
    // A file whose last byte is not a newline would otherwise get this line glued to the previous
    // one, producing a single unparseable entry that disables the seat above it too.
    const needsNewline = st.size > 0 && readFileSync(path).subarray(-1)[0] !== 0x0a
    writeSync(fd, `${needsNewline ? '\n' : ''}${line}\n`)
  } finally { closeSync(fd) }
}

function readExisting(path) {
  let fd
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch { fail('authorized_keys cannot be read as a regular non-symlink file') }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > 1024 * 1024) fail('authorized_keys is not a bounded regular file')
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}

/**
 * One intent, start to finish. Returns the receipt text the caller writes to stdout.
 *
 * The order is deliberate: verify, claim the journal entry, decide, write, record. Claiming before
 * deciding means a crash mid-run leaves a claimed entry and no seat, which reports as unknown on the
 * next presentation — the failure this project prefers, because the alternative reports a seat that
 * may not exist.
 */
export function runChannelSeat(raw, config, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (!config || config.version !== 1) fail('verified config is required')
  const verdict = verifySeatEvent(raw, { approvers: config.approvers, now })
  if (verdict.ok !== true) {
    // A refused envelope is never journalled: the id of an event this runner would not verify is not
    // a fact worth keeping, and writing one would let an unsigned caller fill the journal directory.
    return `${canonicalJson({ v: 1, op: 'channel_seat', result: 'refused', agent: null, fingerprint: null, instance: config.instance, reason: verdict.reason, at: now })}\n`
  }
  const claim = recallOrClaim(config.journal_path, verdict.event.id)
  if (claim.replay) {
    return `${canonicalJson(claim.prior || { v: 1, op: 'channel_seat', result: 'refused', agent: verdict.intent.agent, fingerprint: null, instance: config.instance, reason: 'this intent was already presented and its outcome was not recorded — read the broker file rather than trusting this', at: now })}\n`
  }
  let receipt
  try {
    const decision = seatDecision(verdict.intent, readExisting(config.authorized_keys_path), { command: config.forced_command, instance: config.instance })
    if (decision.result === 'seated') appendLine(config.authorized_keys_path, decision.line)
    receipt = seatReceipt(verdict.intent, decision, { instance: config.instance, at: now })
  } finally {
    if (receipt) { try { writeSync(claim.fd, canonicalJson(receipt)) } catch { /* the entry stays claimed, which reads as unknown */ } }
    closeSync(claim.fd)
  }
  return `${canonicalJson(receipt)}\n`
}
