// Privacy-safe latency trace (#237).
//
// A correlation identifier must survive several independent systems, but none of them need a
// message body, a recipient, or even the source event id to measure time.  Derive a one-way
// opaque handle from the source id, write only named stages + milliseconds, and retain the raw
// id solely in the caller's memory.  This makes a trace useful in a bridge journal without
// turning that journal into another copy of private conversation metadata.

import { createHmac } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { appendFile, mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const validId = value => /^[0-9a-f]{64}$/i.test(String(value || ''))

const traceKey = () => {
  const key = String(process.env.LATENCY_TRACE_KEY || '')
  // This is local measurement state, not an optional public fingerprint. A
  // missing or weak key disables tracing rather than emitting a reversible
  // hash of an observable relay event id.
  return key.length >= 32 ? key : null
}

export function correlationId(sourceId, key = traceKey()) {
  if (!validId(sourceId)) throw new Error('latency trace source must be a 64-hex event id')
  if (!key) throw new Error('latency tracing requires a local LATENCY_TRACE_KEY (at least 32 characters)')
  return createHmac('sha256', key).update('waggle/latency/v1\0').update(String(sourceId).toLowerCase()).digest('hex').slice(0, 24)
}

export function latencyPath() {
  return resolve(process.env.LATENCY_PATH || 'data/latency-trace.jsonl')
}

// The telemetry path is deliberately lossy under pressure. A synchronous append (or an unbounded
// promise chain) would let an unauthenticated relay flood turn measurement into a new latency or
// memory DoS. The queue is bounded per path; delivery never waits for it.
const chains = new Map()
const pending = new Map()
const maxPending = () => Math.max(1, Number(process.env.LATENCY_MAX_PENDING || 1000) || 1000)
const maxFileBytes = () => Math.max(4096, Number(process.env.LATENCY_MAX_FILE_BYTES || 16 * 1024 * 1024) || 16 * 1024 * 1024)
const health = new Map()
const lastHealthLog = new Map()

function noteHealth(path, reason) {
  const row = health.get(path) || { queue_full: 0, file_full: 0, write_error: 0 }
  row[reason]++
  health.set(path, row)
  const key = `${path}:${reason}`, now = Date.now()
  if (now - (lastHealthLog.get(key) || 0) >= 60_000) {
    lastHealthLog.set(key, now)
    console.error(`latency trace health: ${reason}=${row[reason]} path=${path}`)
  }
}

export function latencyHealth(path = latencyPath()) {
  return { ...(health.get(path) || { queue_full: 0, file_full: 0, write_error: 0 }), pending: pending.get(path) || 0 }
}

export function flushLatency(path = latencyPath()) {
  return chains.get(path) || Promise.resolve()
}

// Stage is deliberately a closed-ish operational identifier, not a caller supplied sentence.
// A later report can group it safely and no content can be smuggled into logs through a label.
export function markLatency(sourceId, stage, at = Date.now(), attempt = 0) {
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(String(stage || ''))) throw new Error('latency trace stage is invalid')
  if (!Number.isFinite(at) || at <= 0) throw new Error('latency trace timestamp is invalid')
  const key = traceKey()
  if (!key) return { ok: false, error: 'latency tracing disabled: LATENCY_TRACE_KEY unavailable' }
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 10_000) throw new Error('latency trace attempt is invalid')
  const record = { v: 1, trace: correlationId(sourceId, key), attempt, stage, at: Math.floor(at) }
  const path = latencyPath()
  const count = pending.get(path) || 0
  if (count >= maxPending()) { noteHealth(path, 'queue_full'); return { ok: false, error: 'trace queue full', record } }
  pending.set(path, count + 1)
  const previous = chains.get(path) || Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      let bytes = 0
      try { bytes = (await stat(path)).size } catch (e) { if (e?.code !== 'ENOENT') throw e }
      if (bytes >= maxFileBytes()) { noteHealth(path, 'file_full'); return }
      await appendFile(path, JSON.stringify(record) + '\n', { mode: 0o600 })
    } catch { noteHealth(path, 'write_error') /* telemetry is never a delivery dependency */ }
    finally { pending.set(path, Math.max(0, (pending.get(path) || 1) - 1)) }
  })
  chains.set(path, next)
  return { ok: true, record }
}

export function readLatencyWindow(path = latencyPath(), limit = maxFileBytes()) {
  if (!existsSync(path)) return { records: [], bytes: 0, total_bytes: 0, truncated: false }
  const total = statSync(path).size
  const bytes = Math.min(total, Math.max(4096, Number(limit) || maxFileBytes()))
  const buffer = Buffer.alloc(bytes)
  const fd = openSync(path, 'r')
  try { readSync(fd, buffer, 0, bytes, total - bytes) } finally { closeSync(fd) }
  let text = buffer.toString('utf8')
  if (total > bytes) text = text.slice(text.indexOf('\n') + 1)
  const records = text.split('\n').flatMap(line => {
    try {
      const x = JSON.parse(line)
      return x?.v === 1 && /^[0-9a-f]{24}$/.test(x.trace || '') && Number.isInteger(x.attempt ?? 0) && (x.attempt ?? 0) >= 0 && /^[a-z][a-z0-9_.-]{1,63}$/.test(x.stage || '') && Number.isFinite(x.at) ? [{ ...x, attempt: x.attempt ?? 0 }] : []
    } catch { return [] }
  })
  return { records, bytes, total_bytes: total, truncated: total > bytes }
}

export function readLatency(path = latencyPath(), limit) {
  const result = readLatencyWindow(path, limit)
  return Array.isArray(result) ? result : result.records
}

const percentile = (xs, p) => {
  if (!xs.length) return null
  const i = Math.max(0, Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1))
  return xs.slice().sort((a, b) => a - b)[i]
}

// Pair adjacent named stages for each trace.  Duplicate delivery/retry marks do not manufacture a
// lower latency: only the first occurrence of each stage participates and negative clocks drop.
export function summarizeLatency(records, pairs) {
  const byTrace = new Map()
  for (const r of records || []) {
    if (!r || !/^[0-9a-f]{24}$/.test(r.trace || '') || !Number.isFinite(r.at)) continue
    const traceAttempt = `${r.trace}:${Number.isInteger(r.attempt) ? r.attempt : 0}`
    const stages = byTrace.get(traceAttempt) || new Map()
    if (!stages.has(r.stage)) stages.set(r.stage, r.at)
    byTrace.set(traceAttempt, stages)
  }
  return (pairs || []).map(([from, to]) => {
    const samples = []
    let attempted = 0
    for (const stages of byTrace.values()) {
      const a = stages.get(from), b = stages.get(to)
      if (Number.isFinite(a)) attempted++
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) samples.push(b - a)
    }
    return { from, to, attempted, count: samples.length, missing_to: attempted - samples.length, p50_ms: percentile(samples, 0.5), p95_ms: percentile(samples, 0.95), max_ms: samples.length ? Math.max(...samples) : null }
  })
}
