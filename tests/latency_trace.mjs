// #237: correlation is opaque and reports per-hop percentiles without payload/ids in the journal.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { correlationId, markLatency, flushLatency, readLatency, summarizeLatency } from '../src/latency.mjs'

let failed = 0
const ok = (name, yes) => { console.log(yes ? '  ok' : 'FAIL', name); if (!yes) failed++ }
const root = mkdtempSync(join(tmpdir(), 'waggle-latency-'))
process.env.LATENCY_PATH = join(root, 'trace.jsonl')
const a = 'a'.repeat(64), b = 'b'.repeat(64)
try {
  const trace = correlationId(a)
  ok('correlation is opaque, stable, and does not expose the source event id', /^[0-9a-f]{24}$/.test(trace) && trace === correlationId(a) && trace !== a.slice(0, 24) && trace !== correlationId(b))
  markLatency(a, 'relay.observed', 1000); markLatency(a, 'relay.admitted', 1025); markLatency(a, 'relay.posted', 1100); markLatency(a, 'return.published', 1150)
  markLatency(b, 'relay.observed', 2000); markLatency(b, 'relay.admitted', 2050); markLatency(b, 'relay.posted', 2200); markLatency(b, 'return.published', 2300)
  await flushLatency()
  const raw = readFileSync(process.env.LATENCY_PATH, 'utf8')
  ok('journal contains only opaque trace/stage/time records', !raw.includes(a) && !raw.includes(b) && !/content|body|recipient|secret|nsec/i.test(raw))
  const rows = summarizeLatency(readLatency(), [['relay.observed', 'relay.admitted'], ['relay.admitted', 'relay.posted'], ['relay.posted', 'return.published']])
  ok('report calculates repeatable p50/p95 hop timings', rows[0].count === 2 && rows[0].p50_ms === 25 && rows[0].p95_ms === 50 && rows[1].p50_ms === 75 && rows[1].p95_ms === 150 && rows[2].p50_ms === 50 && rows[2].p95_ms === 100)
  process.env.LATENCY_MAX_PENDING = '1'
  const queued = markLatency(a, 'sealed.observed', 3000)
  const dropped = markLatency(b, 'sealed.observed', 3000)
  ok('a bounded telemetry queue drops measurement rather than extending a delivery backlog', queued.ok && !dropped.ok && dropped.error === 'trace queue full')
  await flushLatency()
  delete process.env.LATENCY_MAX_PENDING
} finally { rmSync(root, { recursive: true, force: true }) }
if (failed) process.exit(1)
console.log('latency_trace: all checks passed')
