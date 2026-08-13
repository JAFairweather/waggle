// pow_worker.mjs — the mining loop, on a thread that is not the one carrying messages (#346).
//
// `mineSync` is correct and unusable on the hot path: 16 bits on a real 8.7KB wrap is ~3s here and
// ~15s on the droplet, and this box has one vCPU. Three seconds of inline hashing stalls the read
// lane, the relay lane and every timer at once — the cure being worse than the refusal it avoids is
// exactly why #346 asked for a worker rather than a bigger budget.
//
// This file is the whole worker: it takes one job, answers once, and exits. No pool, no queue, no
// long-lived thread holding a copy of the bridge's module graph. A sealed send happens on the order
// of seconds apart, so a thread per mine is the cheap option, and a thread that cannot outlive its
// job cannot leak one.
//
// It imports ONLY pow.mjs. That is deliberate: importing bridge.mjs here would re-run the bridge's
// module top level in a second thread — reading config, opening journals, seating state — which is
// a whole second bridge, quietly.

import { parentPort, workerData } from 'node:worker_threads'
import { mineSync } from './pow.mjs'

// `workerData` crosses the thread boundary by structured clone, so what arrives is data, never a
// live object. Nothing here trusts it beyond handing it to mineSync, which validates its own input
// and refuses rather than throwing.
const { template, target, cap, maxIterations } = workerData || {}
const started = Date.now()
const result = mineSync(template, target, {
  ...(Number.isInteger(cap) ? { cap } : {}),
  ...(Number.isInteger(maxIterations) ? { maxIterations } : {}),
})
parentPort?.postMessage({ ...result, elapsedMs: Date.now() - started })
