// #237: correlation is opaque and reports per-hop percentiles without payload/ids in the journal.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { correlationId, latencyHealth, markLatency, flushLatency, readLatency, readLatencyWindow, summarizeLatency } from '../src/latency.mjs'

let failed = 0
const ok = (name, yes) => { console.log(yes ? '  ok' : 'FAIL', name); if (!yes) failed++ }
const root = mkdtempSync(join(tmpdir(), 'waggle-latency-'))
process.env.LATENCY_PATH = join(root, 'trace.jsonl')
process.env.LATENCY_TRACE_KEY = 'test-only-latency-key-that-is-long-enough-to-be-secret'
const a = 'a'.repeat(64), b = 'b'.repeat(64)
try {
  const trace = correlationId(a)
  ok('correlation is keyed, opaque, stable, and does not expose the source event id', /^[0-9a-f]{24}$/.test(trace) && trace === correlationId(a) && trace !== a.slice(0, 24) && trace !== correlationId(b) && trace !== correlationId(a, 'different-test-key-that-is-also-long-enough'))
  markLatency(a, 'relay.observed', 1000); markLatency(a, 'relay.admitted', 1025); markLatency(a, 'relay.posted', 1100); markLatency(a, 'return.published', 1150)
  markLatency(b, 'relay.observed', 2000); markLatency(b, 'relay.admitted', 2050); markLatency(b, 'relay.posted', 2200); markLatency(b, 'return.published', 2300)
  await flushLatency()
  const raw = readFileSync(process.env.LATENCY_PATH, 'utf8')
  ok('journal contains only opaque trace/stage/time records', !raw.includes(a) && !raw.includes(b) && !/content|body|recipient|secret|nsec/i.test(raw))
  const rows = summarizeLatency(readLatency(), [['relay.observed', 'relay.admitted'], ['relay.admitted', 'relay.posted'], ['relay.posted', 'return.published']])
  ok('report calculates repeatable p50/p95 hop timings', rows[0].count === 2 && rows[0].p50_ms === 25 && rows[0].p95_ms === 50 && rows[1].p50_ms === 75 && rows[1].p95_ms === 150 && rows[2].p50_ms === 50 && rows[2].p95_ms === 100)
  markLatency(a, 'sealed.observed', 3000, 0); markLatency(a, 'sealed.forwarded', 3020, 0)
  markLatency(a, 'sealed.observed', 3000, 1)
  await flushLatency()
  const fanout = summarizeLatency(readLatency(), [['sealed.observed', 'sealed.forwarded']])[0]
  ok('fan-out reports every recipient attempt including a failed recipient', fanout.attempted === 2 && fanout.count === 1 && fanout.missing_to === 1 && fanout.p50_ms === 20)
  process.env.LATENCY_MAX_PENDING = '1'
  const queued = markLatency(a, 'sealed.observed', 4000)
  const dropped = markLatency(b, 'sealed.observed', 4000)
  ok('a bounded telemetry queue drops measurement rather than extending a delivery backlog', queued.ok && !dropped.ok && dropped.error === 'trace queue full')
  ok('dropped telemetry is surfaced through bounded health counters', latencyHealth().queue_full === 1)
  await flushLatency()
  delete process.env.LATENCY_MAX_PENDING
  const bounded = readLatencyWindow(process.env.LATENCY_PATH, 4096)
  ok('report reads a bounded tail window', bounded.bytes <= 4096 && Array.isArray(bounded.records))
  const cappedPath = join(root, 'capped.jsonl')
  writeFileSync(cappedPath, 'x'.repeat(4095))
  process.env.LATENCY_PATH = cappedPath
  process.env.LATENCY_MAX_FILE_BYTES = '4096'
  markLatency(a, 'relay.observed', 5000)
  await flushLatency(cappedPath)
  ok('a record that would cross the hard trace cap is dropped and surfaced', latencyHealth(cappedPath).file_full === 1 && readFileSync(cappedPath).length === 4095)
  delete process.env.LATENCY_MAX_FILE_BYTES
} finally { delete process.env.LATENCY_TRACE_KEY; rmSync(root, { recursive: true, force: true }) }
if (failed) process.exit(1)
console.log('latency_trace: all checks passed')
