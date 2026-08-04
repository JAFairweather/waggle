#!/usr/bin/env node
// Report the privacy-safe #237 trace.  It reads only opaque trace ids and stage times.
import { readLatency, summarizeLatency } from '../src/latency.mjs'

const arg = flag => { const i = process.argv.indexOf(flag); return i < 0 ? '' : process.argv[i + 1] || '' }
const file = arg('--file') || process.env.LATENCY_PATH
if (!file) {
  console.error('usage: node tools/latency-report.mjs --file <latency-trace.jsonl>')
  process.exit(2)
}
const rows = summarizeLatency(readLatency(file), [
  ['relay.observed', 'relay.admitted'],
  ['relay.admitted', 'relay.posted'],
  ['relay.posted', 'return.published'],
  ['sealed.observed', 'sealed.forwarded'],
])
console.log(JSON.stringify({ v: 1, file, samples: rows }, null, 2))
