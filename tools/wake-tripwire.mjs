#!/usr/bin/env node
// wake-tripwire.mjs — the session half of the wake lane (#557).
//
// Claude Code has no inbound wake. The only event that reaches a running session is "a background
// task this session started has exited", so the thing that wakes it must DIE to do it. Today the
// same process holds the relay subscription, which means every wake closes the lane and nothing
// reopens it but the agent noticing. A missed re-arm is therefore silence, not delay: the messages
// that arrive in the gap are never seen as new.
//
// This is the half that dies. It holds no relay connection, no credential and no decryption — it
// blocks on a file and exits. That is the entire point: re-arming it is cheap and unconditional, so
// forgetting to re-arm costs a delay rather than a mailbox.
//
//   node tools/wake-tripwire.mjs --spool <dir> --cursor <path> [--timeout <sec>]
//
//   0    a wake:true record sits past the cursor. THE EXIT IS THE WAKE.
//   3    INCONCLUSIVE — could not tell. See below; this is never "nothing arrived".
//   4    waited the full timeout, the daemon was provably alive, and nothing woke. A real quiet.
//   2    usage.
//   130
//   143  stopped by SIGINT / SIGTERM. A teardown, not a verdict. Deliberately not 3.
//
// WHAT THE CALLER OWES, because two of these answer instantly and "re-arm unconditionally" would
// then spin hot (#569 review):
//   · on 0 — read the spool, ACT, then write the cursor. Never before acting.
//   · on 3 — BACK OFF before re-arming. An unseeded directory and a disagreeing one both answer in
//     milliseconds and will keep doing so until an operator intervenes.
//   · on 4 — re-arm immediately. The lane is healthy and was quiet.
//   · on 128+n — do not re-arm. Somebody asked for this to stop.
//
// IT NEVER WRITES THE CURSOR. The session advances it after reading, and that ordering is not a
// style choice — it is the same one `wake_spool.mjs` makes one layer down, for the same reason. A
// tripwire that advanced the cursor would mark a message consumed before anything consumed it, and
// a session that died between the two would lose it with the lane still reporting healthy. Consumed
// twice is noise somebody notices; consumed zero times is #557. At-least-once, both layers.
//
// WHY EXIT 4 EXISTS, AND WHY IT IS HARD TO REACH. "Nothing arrived" and "the daemon that would have
// told me is dead" are byte-identical at the spool: an empty file, an unmoved cursor, silence. That
// is #557's own failure re-entering one layer up, and a tripwire that reported the second as the
// first would be a lane-down alarm that never fires. So a timeout only reports quiet — exit 4 —
// when a liveness signal proves the durable half was running while this waited. With no such signal
// the honest answer is 3, because being unable to check is not the same as being fine.
import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import { inspectSpoolDir, readSpoolFrom } from '../src/wake_spool.mjs'

const argv = process.argv.slice(2)
const has = f => argv.includes(f)
const flag = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const num = (f, d) => { const v = flag(f); if (v === null) return d; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d }

const die = (msg, code = 2) => { console.error(`wake-tripwire: ${msg}`); process.exit(code) }
// INCONCLUSIVE IS LOUD AND HAS ITS OWN CODE. A caller that treats 3 as 0 wakes for nothing; one
// that treats it as "no mail" rebuilds the bug. Neither is silent, which is the property that matters.
const inconclusive = why => { console.error(`wake-tripwire: INCONCLUSIVE — ${why}`); process.exit(3) }

if (has('--help') || !argv.length) {
  console.error('usage: node tools/wake-tripwire.mjs --spool <dir> --cursor <path> [--timeout <sec>]')
  console.error('       [--poll <ms>] [--heartbeat <path>] [--heartbeat-max <sec>]')
  console.error('exits: 0 woke · 3 inconclusive · 4 provably quiet · 2 usage')
  process.exit(has('--help') ? 0 : 2)
}

const spoolDir = flag('--spool')
const cursorPath = flag('--cursor')
if (!spoolDir) die('--spool <dir> is required — this tool reads one identity\'s spool and will not guess which')
if (!cursorPath) die('--cursor <path> is required — without it every arm would re-read the whole spool and wake on history')

const pollMs = Math.max(50, num('--poll', 1000))
const timeoutSec = num('--timeout', 0)
const heartbeatPath = flag('--heartbeat')
const heartbeatMaxSec = num('--heartbeat-max', 90)

const spoolPath = join(spoolDir, 'spool.jsonl')

/**
 * The cursor, as a byte offset. Read-only, always.
 *
 * ABSENT IS 0 AND THAT IS DELIBERATE. A first arm reads the whole spool, which sounds like the flood
 * this project keeps rebuilding and is not: the bootstrap population carries `wake:false`, so it is
 * read and ignored. What a first arm DOES surface is genuine undelivered mail already on disk, which
 * is exactly what it should surface.
 *
 * A cursor that will not parse is not 0. That would silently re-read everything and look like a
 * flood of new mail; it is INCONCLUSIVE instead.
 */
function readCursor() {
  if (!existsSync(cursorPath)) return 0
  let raw
  try { raw = readFileSync(cursorPath, 'utf8') } catch (e) { return { bad: `the cursor at ${cursorPath} could not be read — ${e?.message || e}` } }
  const t = raw.trim()
  if (t === '') return 0
  const n = Number(t)
  if (!Number.isSafeInteger(n) || n < 0) return { bad: `the cursor at ${cursorPath} holds ${JSON.stringify(t.slice(0, 40))}, which is not a byte offset. Refusing to treat it as 0 — that would re-read the whole spool and report history as new mail` }
  return n
}

/**
 * Was the durable half alive while we waited?
 *
 * `null` when there is no signal to consult, which is NOT the same as "no". The distinction is the
 * whole reason exit 4 is separate from exit 3: a heartbeat that only appears when there is traffic
 * cannot tell a quiet lane from a dead one, and an alarm that never fires and one that always fires
 * fail identically.
 */
function daemonAlive() {
  if (!heartbeatPath) return null
  if (!existsSync(heartbeatPath)) return false
  let age
  try { age = (Date.now() - statSync(heartbeatPath).mtimeMs) / 1000 } catch { return false }
  return age <= heartbeatMaxSec
}

/** One look. Returns a verdict or null for "nothing yet, keep waiting". */
function look() {
  const state = inspectSpoolDir(spoolDir)
  if (state.state === 'inconclusive') return { stop: inconclusive, why: state.reason }
  // A bootstrap directory means the durable half has not finished its first seeding — or has never
  // run. Blocking here would wait forever on a daemon that may not exist.
  if (state.state === 'bootstrap') return { stop: inconclusive, why: `${spoolDir} has not been seeded yet — ${state.reason}. The durable half has not completed a first start here, so there is nothing to wait on` }

  const cursor = readCursor()
  if (typeof cursor === 'object') return { stop: inconclusive, why: cursor.bad }

  // A CURSOR PAST THE END OF THE FILE IS INVISIBLE, and this tool's own repair instruction leads
  // there. `readSpoolFrom` clamps `from = Math.min(offset, size)`, so a cursor beyond the file
  // returns no records, no block and `missing:false` — byte-identical to "nothing new". The spool
  // gets shorter in three ordinary ways: rotation, a disk-full truncation, and an operator deleting
  // the corrupt line that the `blocked` message above tells them to repair. In every one of them the
  // stored cursor is now past EOF and mail sits readable on disk while this blocks forever.
  //
  // Found by My Dude reviewing #569, driven rather than reasoned about: cursor 999999 against three
  // wake records blocked indefinitely under the documented invocation, which has no --timeout.
  //
  // WHAT THIS DOES NOT CATCH (#573): a spool truncated and refilled to the SAME byte count. An
  // offset is the only evidence the cursor file carries, so that case is indistinguishable from a
  // consumed one and reads as quiet. Detecting it needs a generation marker on the spool, which is
  // the durable half's to publish.
  const size = existsSync(spoolPath) ? statSync(spoolPath).size : 0
  if (cursor > size) return { stop: inconclusive, why: `the cursor at ${cursorPath} is ${cursor} but ${spoolPath} is only ${size} bytes — the spool was rotated, truncated, or repaired under it. Refusing to treat that as no mail: reset the cursor to 0 to re-read what is there, or to ${size} to resume from the end` }

  const read = readSpoolFrom(spoolPath, cursor)
  // A steady directory with no spool file is legitimately empty: `durableSet` writes its index on
  // the first commit, and the spool only exists once something has been delivered. Keep waiting.
  if (read.missing) return null

  // `wake` AND NOTHING ELSE. The record carries `ok`, `disposition`, `mayAct`, `receipt` and
  // `first_seen` too, and an adapter that consults any of them is re-deriving protocol semantics
  // the core already decided — which is how two adapters come to disagree about the same message.
  const woke = read.records.filter(r => r && r.wake === true)

  // A WAKE THAT ARRIVED BEFORE THE BLOCK IS STILL A WAKE, and it is checked first for that reason.
  // `readSpoolFrom` stops the cursor at an unparseable line and returns everything before it, so
  // reporting INCONCLUSIVE here would discard mail that is sitting readable on disk — the corrupt
  // line one record later would swallow it. Wake now; the session advances to `next`, which stops
  // at the block, and the NEXT arm reports it with nothing left to lose.
  if (woke.length) return { woke, next: read.next, scanned: read.records.length }

  // THE CURSOR STOPS AT A RECORD THAT WILL NOT PARSE, by design, and everything after it is
  // unreachable. Treating that as "nothing new" turns one corrupt line into permanent silence —
  // #557 through a different door.
  if (read.blocked) return { stop: inconclusive, why: `a record at byte ${read.blocked.at} of ${spoolPath} will not parse, so nothing after it can be read — every later record is unreachable until this is repaired: ${JSON.stringify(read.blocked.raw.slice(0, 120))}` }

  return null
}

const startedAt = Date.now()
let settled = false

function finish(v) {
  if (settled) return
  settled = true
  if (v.stop) return v.stop(v.why)
  const first = v.woke[0]
  // Everything the session needs to act, on stderr, because stdout belongs to whatever pipes this.
  console.error(`wake-tripwire: ${v.woke.length} wake record(s) past the cursor — ${v.scanned} scanned`)
  console.error(`  first: ${first.id ? `${String(first.id).slice(0, 12)}…` : 'no id'} — ${first.wake_reason || 'no reason recorded'}`)
  console.error(`  the cursor is NOT advanced; read the spool and advance it to ${v.next} once you have`)
  process.exit(0)
}

function tick() {
  if (settled) return
  let v = null
  try { v = look() } catch (e) { return inconclusive(`the spool could not be examined — ${e?.message || e}`) }
  if (v) return finish(v)
  if (timeoutSec > 0 && (Date.now() - startedAt) / 1000 >= timeoutSec) {
    settled = true
    const alive = daemonAlive()
    if (alive === true) {
      console.error(`wake-tripwire: nothing woke in ${timeoutSec}s, and the durable half was alive throughout — a real quiet lane`)
      process.exit(4)
    }
    if (alive === false) return inconclusive(`nothing woke in ${timeoutSec}s AND the durable half's heartbeat at ${heartbeatPath} is missing or older than ${heartbeatMaxSec}s. A dead subscription and a quiet lane look identical from here, so this is not "no mail"`)
    return inconclusive(`nothing woke in ${timeoutSec}s, and with no --heartbeat there is no way to tell a quiet lane from a durable half that died. Being unable to check is not the same as being fine`)
  }
}

// WATCH AND POLL, BOTH. `fs.watch` is the low-latency path and is not reliable enough to be the only
// one: it is silently degraded over network filesystems, drops events under load on some platforms,
// and reports nothing at all if the directory is replaced. The poll is the floor that makes a missed
// event a delay instead of a hang — the same shape as the whole tripwire, one level down.
let watcher = null
try {
  watcher = watch(spoolDir, () => tick())
  watcher.on('error', () => { if (watcher) { watcher.close(); watcher = null } })
} catch { watcher = null }
const timer = setInterval(tick, pollMs)
timer.unref?.()
process.on('exit', () => { try { watcher?.close() } catch { /* already gone */ } })

// A SIGNAL IS A CLEAN STOP, AND IT IS NOT EXIT 3. Exiting 0 would wake the next arm for nothing;
// exiting 3 is worse, because 3 means "could not tell, re-arm" — so a supervisor following the
// contract could never stop this tool, and every teardown would re-arm it. 128+signo is the shell
// convention a supervisor already reads: 130 for SIGINT, 143 for SIGTERM. Raised by My Dude in #569.
const SIGNO = { SIGINT: 2, SIGTERM: 15 }
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { if (!settled) { settled = true; console.error(`wake-tripwire: stopped by ${sig} before anything woke — this is a teardown, NOT a retryable 3`); process.exit(128 + SIGNO[sig]) } })
}

tick()
// Nothing else keeps the loop alive: the interval is unref'd and the watcher may have failed to
// open. This is what makes the process block rather than fall off the end of the script.
setInterval(() => {}, 1 << 30)
