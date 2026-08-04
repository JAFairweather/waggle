// Privacy-safe latency trace (#237).
//
// A correlation identifier must survive several independent systems, but none of them need a
// message body, a recipient, or even the source event id to measure time.  Derive a one-way
// opaque handle from the source id, write only named stages + milliseconds, and retain the raw
// id solely in the caller's memory.  This makes a trace useful in a bridge journal without
// turning that journal into another copy of private conversation metadata.

import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
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

export function flushLatency(path = latencyPath()) {
  return chains.get(path) || Promise.resolve()
}

// Stage is deliberately a closed-ish operational identifier, not a caller supplied sentence.
// A later report can group it safely and no content can be smuggled into logs through a label.
export function markLatency(sourceId, stage, at = Date.now()) {
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(String(stage || ''))) throw new Error('latency trace stage is invalid')
  if (!Number.isFinite(at) || at <= 0) throw new Error('latency trace timestamp is invalid')
  const key = traceKey()
  if (!key) return { ok: false, error: 'latency tracing disabled: LATENCY_TRACE_KEY unavailable' }
  const record = { v: 1, trace: correlationId(sourceId, key), stage, at: Math.floor(at) }
  const path = latencyPath()
  const count = pending.get(path) || 0
  if (count >= maxPending()) return { ok: false, error: 'trace queue full', record }
  pending.set(path, count + 1)
  const previous = chains.get(path) || Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await appendFile(path, JSON.stringify(record) + '\n', { mode: 0o600 })
    } catch { /* telemetry is never a delivery dependency */ }
    finally { pending.set(path, Math.max(0, (pending.get(path) || 1) - 1)) }
  })
  chains.set(path, next)
  return { ok: true, record }
}

export function readLatency(path = latencyPath()) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').flatMap(line => {
    try {
      const x = JSON.parse(line)
      return x?.v === 1 && /^[0-9a-f]{24}$/.test(x.trace || '') && /^[a-z][a-z0-9_.-]{1,63}$/.test(x.stage || '') && Number.isFinite(x.at) ? [x] : []
    } catch { return [] }
  })
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
    const stages = byTrace.get(r.trace) || new Map()
    if (!stages.has(r.stage)) stages.set(r.stage, r.at)
    byTrace.set(r.trace, stages)
  }
  return (pairs || []).map(([from, to]) => {
    const samples = []
    for (const stages of byTrace.values()) {
      const a = stages.get(from), b = stages.get(to)
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) samples.push(b - a)
    }
    return { from, to, count: samples.length, p50_ms: percentile(samples, 0.5), p95_ms: percentile(samples, 0.95), max_ms: samples.length ? Math.max(...samples) : null }
  })
}
