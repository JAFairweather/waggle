// Extracted from bridge.mjs by #154. Behaviour is byte-identical; only the file boundary is new.
//
// Depends only on node:fs, node:path and the logger — no config, no lane knowledge.
import { readFileSync, appendFileSync, existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs'
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
  const append = (text, durable = false) => {
    let fileFd = null, dirFd = null
    try {
      const directory = dirname(path)
      mkdirSync(directory, { recursive: true })
      if (!durable) { appendFileSync(path, text); return true }
      fileFd = openSync(path, 'a', 0o600)
      writeFileSync(fileFd, text); fsyncSync(fileFd); closeSync(fileFd); fileFd = null
      dirFd = openSync(directory, 'r'); fsyncSync(dirFd); closeSync(dirFd); dirFd = null
      return true
    } catch (e) {
      err(`${label}: append failed: ${e.message}`)
      return false
    } finally {
      if (fileFd !== null) { try { closeSync(fileFd) } catch {} }
      if (dirFd !== null) { try { closeSync(dirFd) } catch {} }
    }
  }
  return {
    mem,
    has: (k) => mem.has(k),
    claim: (k) => { mem.add(k) },
    rollback: (k) => { mem.delete(k) },
    commit(k, durable = false) {
      const already = mem.has(k)
      mem.add(k)
      // Truncated at 64 so a full event id still prints whole, while a long composite key
      // (source × recipient) cannot flood the journal the tripwire reads.
      if (append(k + '\n', durable)) return true
      if (!already) mem.delete(k)
      return false
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

// --- durable QUEUE ----------------------------------------------------------
// The sibling of durableSet, for the case a set cannot serve: work that must OUTLIVE the window
// it was discovered in. A set remembers "already handled"; this remembers "still owed", which
// needs the payload, an attempt count, and a way to give up.
//
// The return lane is the motivating case (#117). A carry that reaches 0 relays is rolled back so
// the overlap re-read retries it — but the scan cursor advances regardless, so that retry only
// happens while the message stays inside the overlap window. An outage sustained past it ages the
// carry out and it is lost, silently, after having been loud for a while.
//
// Holding the cursor instead was considered and rejected upstream: one permanently-unreachable
// recipient would pin the cursor forever and stall the lane for EVERYONE — a rare, loud,
// per-recipient miss traded for an unbounded, silent, lane-wide stall. A queue keeps liveness
// (cursor advances) and no-miss (retries come from durable storage, not from the window).
//
// Append-only JSONL, replayed in order, exactly like durableSet: {k, v} enqueues, {k, a} records
// an attempt, {k, d:1} tombstones. Last-write-wins on replay, so a compaction is just a truncation
// to the last `cap` records.
function durableQueue({ path, cap, label }) {
  const mem = new Map()   // key -> { item, attempts }
  const append = (rec, durable = false) => {
    let fileFd = null, dirFd = null
    try {
      const directory = dirname(path), text = JSON.stringify(rec) + '\n'
      mkdirSync(directory, { recursive: true })
      if (!durable) { appendFileSync(path, text); return true }
      fileFd = openSync(path, 'a', 0o600)
      writeFileSync(fileFd, text); fsyncSync(fileFd); closeSync(fileFd); fileFd = null
      dirFd = openSync(directory, 'r'); fsyncSync(dirFd); closeSync(dirFd); dirFd = null
      return true
    } catch (e) {
      err(`${label}: append failed for ${String(rec.k).slice(0, 64)}: ${e.message}`)
      return false
    } finally {
      if (fileFd !== null) { try { closeSync(fileFd) } catch {} }
      if (dirFd !== null) { try { closeSync(dirFd) } catch {} }
    }
  }
  return {
    mem,
    size: () => mem.size,
    has: (k) => mem.has(k),
    entries: () => [...mem.entries()].map(([k, v]) => ({ key: k, item: v.item, attempts: v.attempts })),
    enqueue(k, item, durable = false) {
      if (mem.has(k)) return true                  // already owed; do not reset its attempt count
      mem.set(k, { item, attempts: 0 })
      if (append({ k, v: item }, durable)) return true
      mem.delete(k)                                // memory may never claim durability that failed
      return false
    },
    update(k, item, durable = false) {
      const current = mem.get(k)
      if (!current) return false
      const previous = current.item
      current.item = item
      if (append({ k, v: item, a: current.attempts }, durable)) return true
      current.item = previous
      return false
    },
    // Recording the attempt BEFORE the retry is deliberate: a crash mid-retry must not buy a free
    // attempt, or a permanently-failing item could loop forever across restarts and never reach
    // the dead-letter bound that exists to stop exactly that.
    attempt(k) {
      const e = mem.get(k)
      if (!e) return 0
      const next = e.attempts + 1
      if (!append({ k, a: next })) return e.attempts
      e.attempts = next
      return next
    },
    remove(k, durable = false) {
      const existing = mem.get(k)
      if (!existing) return false
      if (!append({ k, d: 1 }, durable)) return false
      mem.delete(k)
      return true
    },
    load() {
      if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); return }
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      const kept = lines.slice(-cap)
      for (const line of kept) {
        let r
        try { r = JSON.parse(line) } catch { continue }   // a torn final write is skipped, not fatal
        if (!r || !r.k) continue
        if (r.d) { mem.delete(r.k); continue }
        if (r.v !== undefined) { mem.set(r.k, { item: r.v, attempts: Number.isSafeInteger(r.a) && r.a >= 0 ? r.a : 0 }); continue }
        if (r.a !== undefined && mem.has(r.k)) mem.get(r.k).attempts = r.a
      }
      log(`${label}: loaded ${mem.size} owed item(s) from ${path}${lines.length > kept.length ? ` (pruned ${lines.length - kept.length})` : ''}`)
    },
  }
}

export { durableSet, durableQueue }
