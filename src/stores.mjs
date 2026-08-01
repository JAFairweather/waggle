// Extracted from bridge.mjs by #154. Behaviour is byte-identical; only the file boundary is new.
//
// Depends only on node:fs, node:path and the logger — no config, no lane knowledge.
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { log, err } from './log.mjs'

// --- durable dedup ----------------------------------------------------------
// Three lanes each keep a durable "already handled this" set, and all three want the same three
// things: an in-memory Set for the hot check, an append-only file so a restart cannot re-deliver,
// and a cap so that file cannot grow forever. They were written three times, and they drifted —
// only two grew the claim/rollback split that #121 added after one wrap posted twice, 423ms
// apart, because the entry check and the durable write sat on opposite sides of an async send.
// Whether the third is safe without it is a timing argument someone had to re-derive by hand on
// every visit, which is exactly the kind of reasoning that decays.
//
// One primitive makes the whole vocabulary available to every lane. Which parts a lane USES stays
// that lane's decision, argued at its own call sites — this changes what is *available*, never
// what any lane currently does:
//
//   has       the hot check
//   claim     in-memory only — suppress a duplicate while an async send is in flight
//   rollback  undo a claim, so a failed send retries instead of being silently suppressed
//   commit    claim + durable append — survives a restart
//
// `mem` is the Set itself, exposed because the lanes (and the suites) check it directly.
function durableSet({ path, cap, label, noun }) {
  const mem = new Set()
  return {
    mem,
    has: (k) => mem.has(k),
    claim: (k) => { mem.add(k) },
    rollback: (k) => { mem.delete(k) },
    commit(k) {
      mem.add(k)
      // Truncated at 64 so a full event id still prints whole, while a long composite key
      // (source × recipient) cannot flood the journal the tripwire reads.
      try { appendFileSync(path, k + '\n') }
      catch (e) { err(`${label}: append failed for ${String(k).slice(0, 64)}: ${e.message}`) }
    },
    load() {
      // The mkdir on the missing-file path is what guarantees the directory exists for every
      // later append, which is why commit() does not repeat it per write.
      if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); return }
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      const kept = lines.slice(-cap)
      for (const k of kept) mem.add(k)
      log(`${label}: loaded ${mem.size} ${noun} from ${path}${lines.length > kept.length ? ` (pruned ${lines.length - kept.length})` : ''}`)
    },
  }
}

export { durableSet }
