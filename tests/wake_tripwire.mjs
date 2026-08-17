// `tools/wake-tripwire.mjs` driven as a real subprocess, because THE EXIT CODE IS THE PRODUCT.
//
// This tool's entire output is how it dies. A suite that imported a function and inspected a return
// value would be testing something the session never sees: Claude Code's only inbound event is "a
// background task exited", so 0-vs-3-vs-4 is the whole interface. Every case here spawns the tool
// and asserts on its exit status.
//
// The properties under test, in the order they can bite:
//   · a wake past the cursor exits 0, whether it was already on disk or arrived mid-block
//   · the tool NEVER writes the cursor — claim-before-read is the loss this lane exists to prevent
//   · history does not re-wake: a cursor past the record is respected
//   · every "did not wake" case is paired with a POSITIVE CONTROL on the same directory, because a
//     tripwire that never fires and one that always fires fail identically from one assertion
//   · not-woken and could-not-tell are different exits: 4 requires a fresh heartbeat, and 3 is what
//     you get when nothing proves the durable half was alive
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let passed = 0, failed = 0
const check = (cond, label, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL — ${label}${detail ? `  [${detail}]` : ''}`) }
}

const TOOL = fileURLToPath(new URL('../tools/wake-tripwire.mjs', import.meta.url))
const ROOT = mkdtempSync(join(tmpdir(), 'wake-trip-'))
let n = 0

/**
 * A spool directory in a chosen state. `state` mirrors `inspectSpoolDir`'s vocabulary exactly, and
 * the files are written by name rather than through the module so a rename there shows up here as a
 * failure instead of as a suite that quietly stops exercising the states it claims to.
 */
function makeDir(state, records = []) {
  const dir = join(ROOT, `d${++n}`)
  mkdirSync(dir, { recursive: true })
  if (state === 'steady') { writeFileSync(join(dir, 'started'), 'test\n'); writeFileSync(join(dir, 'seen.log'), '') }
  if (state === 'half-seeded') writeFileSync(join(dir, 'seen.log'), '')   // index, no marker → inconclusive
  if (state === 'lost-index') writeFileSync(join(dir, 'started'), 'test\n') // marker, no index → inconclusive
  // `bootstrap` writes nothing at all — that is what a first start looks like.
  for (const r of records) append(dir, r)
  return dir
}

const append = (dir, r) => appendFileSync(join(dir, 'spool.jsonl'), (typeof r === 'string' ? r : JSON.stringify(r)) + '\n')

/** The record shape `return_lane_notify.mjs` emits. `wake` is the only field the tool may read, and
 *  the extras are here so a tool that started consulting one of them would have something to find. */
let rid = 0
const rec = (wake, extra = {}) => ({
  ok: true, id: `id${String(++rid).padStart(4, '0')}`, received_at: 1700000000 + rid,
  wake, wake_reason: wake ? 'first-seen and invocable' : 'not invocable', first_seen: true,
  bootstrap: false, disposition: 'deliver', ...extra,
})

/** Run the tool to completion. Resolves `{ code, err }` — never rejects, so a crash is a reported
 *  failure with its stderr rather than an unhandled rejection that names no assertion. */
function run(args, { onStart = null, killAfterMs = 8000 } = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [TOOL, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = '', out = '', done = false
    p.stderr.on('data', d => { err += d })
    p.stdout.on('data', d => { out += d })
    const kill = setTimeout(() => { if (!done) { done = true; p.kill('SIGKILL'); resolve({ code: -1, err, out, hung: true }) } }, killAfterMs)
    p.on('exit', code => { if (!done) { done = true; clearTimeout(kill); resolve({ code, err, out, hung: false }) } })
    if (onStart) setTimeout(() => { try { onStart() } catch (e) { err += `\nonStart threw: ${e?.message || e}` } }, 300)
  })
}

const heartbeat = (ageSec = 0) => {
  const p = join(ROOT, `hb${++n}`)
  writeFileSync(p, `${process.pid}\n`)
  if (ageSec) { const t = Date.now() / 1000 - ageSec; utimesSync(p, t, t) }
  return p
}
const cursorAt = v => { const p = join(ROOT, `cur${++n}`); writeFileSync(p, String(v)); return p }
const unwritten = () => join(ROOT, `cur${++n}`)   // a path that does not exist yet

console.log('\nwake tripwire')

// --- it wakes, and the exit IS the wake -------------------------------------------------------
{
  const dir = makeDir('steady', [rec(false), rec(true)])
  const cur = unwritten()
  const r = await run(['--spool', dir, '--cursor', cur, '--poll', '100'])
  check(r.code === 0, 'a wake:true record already on disk past the cursor exits 0', `code ${r.code} ${r.err.slice(0, 160)}`)
  check(/1 wake record/.test(r.err), '  …and says how many woke, so a session knows whether to expect more', r.err.slice(0, 160))

  // THE CENTRAL SAFETY PROPERTY. A tripwire that advanced the cursor would mark the message consumed
  // before anything consumed it, and a session that died in between would lose it with the lane
  // still reporting healthy — the exact shape of #557, rebuilt one layer up.
  check(!existsSync(cur), 'the tool did NOT create the cursor file — advancing it is the session\'s job, after reading')
}

{
  const dir = makeDir('steady', [rec(false)])
  const cur = cursorAt(0)
  const before = readFileSync(cur, 'utf8')
  const r = await run(['--spool', dir, '--cursor', cur, '--poll', '100'], { onStart: () => append(dir, rec(true)) })
  check(r.code === 0, 'a wake arriving WHILE the tool blocks exits 0 — this is the lane working', `code ${r.code} ${r.err.slice(0, 160)}`)
  check(readFileSync(cur, 'utf8') === before, '  …and an EXISTING cursor is left byte-identical', JSON.stringify(readFileSync(cur, 'utf8')))
}

// --- history does not re-wake -----------------------------------------------------------------
{
  const dir = makeDir('steady', [rec(true)])
  const size = statSync(join(dir, 'spool.jsonl')).size
  const r = await run(['--spool', dir, '--cursor', cursorAt(size), '--timeout', '1', '--poll', '100', '--heartbeat', heartbeat()])
  check(r.code === 4, 'a cursor past the wake record does not re-wake — history stays history', `code ${r.code} ${r.err.slice(0, 200)}`)

  // POSITIVE CONTROL, same directory, same cursor. Without this the assertion above cannot tell
  // "respects the cursor" from "never fires at all", and those two fail identically.
  const r2 = await run(['--spool', dir, '--cursor', cursorAt(size), '--poll', '100'], { onStart: () => append(dir, rec(true)) })
  check(r2.code === 0, '  …CONTROL: the same directory and cursor DO wake when a new record lands past it', `code ${r2.code} ${r2.err.slice(0, 160)}`)
}

// --- wake:false is read and ignored -------------------------------------------------------------
{
  // A bootstrap population is dozens of wake:false records. Waking on them is the flood the whole
  // `wake = first_seen && invoke` formula exists to prevent.
  const dir = makeDir('steady', Array.from({ length: 30 }, () => rec(false)))
  const r = await run(['--spool', dir, '--cursor', unwritten(), '--timeout', '1', '--poll', '100', '--heartbeat', heartbeat()])
  check(r.code === 4, '30 wake:false records past the cursor do not wake — a seeded backlog is not mail', `code ${r.code} ${r.err.slice(0, 200)}`)

  const r2 = await run(['--spool', dir, '--cursor', unwritten(), '--poll', '100'], { onStart: () => append(dir, rec(true)) })
  check(r2.code === 0, '  …CONTROL: one wake:true appended to those same 30 fires immediately', `code ${r2.code} ${r2.err.slice(0, 160)}`)
}

{
  // `wake` AND NOTHING ELSE. If the tool started deciding for itself from `first_seen` or
  // `disposition`, this record — plausible in every field but `wake` — would wake it.
  const dir = makeDir('steady', [rec(false, { first_seen: true, disposition: 'deliver', mayAct: true, ok: true })])
  const r = await run(['--spool', dir, '--cursor', unwritten(), '--timeout', '1', '--poll', '100', '--heartbeat', heartbeat()])
  check(r.code === 4, 'a record with first_seen/disposition/mayAct all favourable but wake:false does NOT wake', `code ${r.code} ${r.err.slice(0, 200)}`)
}

// --- a corrupt record stalls loudly, and never swallows a wake in front of it --------------------
{
  const dir = makeDir('steady', [rec(false), '{not json', rec(true)])
  const r = await run(['--spool', dir, '--cursor', unwritten(), '--timeout', '2', '--poll', '100', '--heartbeat', heartbeat()])
  check(r.code === 3, 'an unparseable record with nothing woken before it is INCONCLUSIVE, not "no mail"', `code ${r.code}`)
  check(/will not parse/.test(r.err) && /byte \d+/.test(r.err),
    '  …and names the byte offset, so it can be repaired rather than guessed at', r.err.slice(0, 200))
}

{
  // The wake is BEFORE the corruption. Reporting inconclusive here would discard mail sitting
  // readable on disk because of a line one record later.
  const dir = makeDir('steady', [rec(true), '{not json'])
  const r = await run(['--spool', dir, '--cursor', unwritten(), '--poll', '100'])
  check(r.code === 0, 'a wake sitting BEFORE the corrupt line is still delivered — it is not swallowed by the block', `code ${r.code} ${r.err.slice(0, 200)}`)
}

// --- states where blocking would be a lie -------------------------------------------------------
{
  const r = await run(['--spool', makeDir('bootstrap'), '--cursor', unwritten(), '--poll', '100'])
  check(r.code === 3, 'an unseeded directory exits 3 rather than blocking forever on a daemon that may not exist', `code ${r.code}`)
}
{
  const r = await run(['--spool', makeDir('half-seeded'), '--cursor', unwritten(), '--poll', '100'])
  check(r.code === 3, 'index-without-marker (a run that never finished seeding) exits 3', `code ${r.code}`)
}
{
  const r = await run(['--spool', makeDir('lost-index'), '--cursor', unwritten(), '--poll', '100'])
  check(r.code === 3, 'marker-without-index (the dedupe index is gone) exits 3', `code ${r.code}`)
}
{
  // A steady directory with no spool file yet is legitimately empty and MUST block, or the three
  // assertions above would be satisfied by a tool that exits 3 on everything.
  const dir = makeDir('steady')
  const r = await run(['--spool', dir, '--cursor', unwritten(), '--poll', '100'], { onStart: () => append(dir, rec(true)) })
  check(r.code === 0, '  …CONTROL: a steady directory with no spool file yet BLOCKS, then wakes when the first record lands', `code ${r.code} ${r.err.slice(0, 160)}`)
}

// --- a cursor past the end of the file --------------------------------------------------------
// FOUND BY MY DUDE IN #569 REVIEW, driven not reasoned about: cursor 999999 against three wake
// records blocked indefinitely under the documented invocation. `readSpoolFrom` clamps the offset to
// the file size, so a cursor past EOF returns no records, no block and missing:false — byte-identical
// to "nothing new". The spool gets shorter three ordinary ways: rotation, a disk-full truncation, and
// an operator deleting the corrupt line this tool's own message tells them to repair.
{
  const dir = makeDir('steady', [rec(true), rec(true), rec(true)])
  const r = await run(['--spool', dir, '--cursor', cursorAt(999999), '--poll', '100', '--timeout', '2'])
  check(r.code === 3, 'a cursor past EOF with wake records on disk is INCONCLUSIVE, not silence', `code ${r.code} ${r.err.slice(0, 200)}`)
  check(/rotated, truncated, or repaired/.test(r.err) && /only \d+ bytes/.test(r.err),
    '  …and says the spool shrank under the cursor, with both recovery offsets', r.err.slice(0, 240))

  const control = await run(['--spool', dir, '--cursor', cursorAt(0), '--poll', '100'])
  check(control.code === 0, '  …CONTROL: the same three records with a sane cursor DO wake', `code ${control.code}`)
}
{
  // THE REPAIR PATH THIS TOOL PRINTS, end to end. Arm 1 stops the cursor at the poison line; the
  // operator removes it, which shortens the file below the stored cursor; a fresh wake:true then
  // lands. Before the fix that sequence answered "nothing woke" forever.
  //
  // TWO records before the poison line, not one, so the repaired file is genuinely SHORTER than the
  // stored cursor. With one record the repair landed on the same byte count and the size check could
  // not see it — see the residual recorded below, which is a limit of size-only detection.
  const dir = makeDir('steady', [rec(true), rec(true), '{not json'])
  const cur = unwritten()
  const arm1 = await run(['--spool', dir, '--cursor', cur, '--poll', '100'])
  check(arm1.code === 0, 'REPAIR PATH: arm 1 delivers the wake sitting in front of the poison line', `code ${arm1.code}`)
  const at = Number((arm1.err.match(/advance it to (\d+)/) || [])[1])
  check(Number.isSafeInteger(at) && at > 0, '  …and names the offset to advance to', String(at))

  writeFileSync(cur, String(at))                       // the session advances, as instructed
  const arm2 = await run(['--spool', dir, '--cursor', cur, '--poll', '100', '--timeout', '2', '--heartbeat', heartbeat()])
  check(arm2.code === 3 && /will not parse/.test(arm2.err), '  …arm 2 reports the corruption exactly one arm later', `code ${arm2.code}`)

  // The operator does what arm 2 told them to: remove the corrupt line. The file is now SHORTER than
  // the stored cursor. Then real mail arrives.
  writeFileSync(join(dir, 'spool.jsonl'), '')
  append(dir, rec(true))
  check(statSync(join(dir, 'spool.jsonl')).size < at,
    '  …precondition: the repair really did leave the file shorter than the stored cursor',
    `${statSync(join(dir, 'spool.jsonl')).size} vs ${at}`)
  const arm3 = await run(['--spool', dir, '--cursor', cur, '--poll', '100', '--timeout', '2', '--heartbeat', heartbeat()])
  check(arm3.code === 3, '  …arm 3, after the repair shortened the file under the cursor, refuses to call fresh mail "nothing"', `code ${arm3.code} ${arm3.err.slice(0, 200)}`)

  writeFileSync(cur, '0')
  const arm4 = await run(['--spool', dir, '--cursor', cur, '--poll', '100'])
  check(arm4.code === 0, '  …and the recovery it names — reset the cursor to 0 — actually delivers the mail', `code ${arm4.code}`)
}

// --- a cursor that will not parse is not 0 ------------------------------------------------------
{
  const dir = makeDir('steady', [rec(true)])
  const bad = join(ROOT, `curbad${++n}`)
  writeFileSync(bad, 'offset=1200\n')
  const r = await run(['--spool', dir, '--cursor', bad, '--poll', '100'])
  check(r.code === 3, 'a cursor that is not a byte offset exits 3 — treating it as 0 would replay the spool as new mail', `code ${r.code}`)
  check(readFileSync(bad, 'utf8') === 'offset=1200\n', '  …and the tool did not "repair" it by overwriting')
}
{
  // Empty is not corrupt — a freshly created cursor file is 0, and must still wake.
  const dir = makeDir('steady', [rec(true)])
  const empty = join(ROOT, `curempty${++n}`)
  writeFileSync(empty, '')
  const r = await run(['--spool', dir, '--cursor', empty, '--poll', '100'])
  check(r.code === 0, '  …CONTROL: an EMPTY cursor file means 0, and still wakes', `code ${r.code} ${r.err.slice(0, 160)}`)
}

// --- quiet and dead are different answers -------------------------------------------------------
// This is the reason exit 4 is a separate code. At the spool, "nothing arrived" and "the durable
// half died an hour ago" are byte-identical: an unchanged file and an unmoved cursor. A tool that
// reported the second as the first would be a lane-down alarm that never fires — #557 one layer up.
{
  const dir = makeDir('steady', [rec(false)])
  const args = ['--spool', dir, '--cursor', unwritten(), '--timeout', '1', '--poll', '100']

  const fresh = await run([...args, '--heartbeat', heartbeat()])
  check(fresh.code === 4, 'a timeout with a FRESH heartbeat is exit 4 — a provably quiet lane', `code ${fresh.code} ${fresh.err.slice(0, 200)}`)

  const stale = await run([...args, '--heartbeat', heartbeat(600), '--heartbeat-max', '60'])
  check(stale.code === 3, 'a timeout with a STALE heartbeat is exit 3 — the daemon is dead, not the lane quiet', `code ${stale.code} ${stale.err.slice(0, 200)}`)

  const gone = await run([...args, '--heartbeat', join(ROOT, 'no-such-heartbeat')])
  check(gone.code === 3, 'a timeout with a MISSING heartbeat is exit 3', `code ${gone.code}`)

  const none = await run(args)
  check(none.code === 3, 'a timeout with NO --heartbeat at all is exit 3 — being unable to check is not being fine', `code ${none.code} ${none.err.slice(0, 200)}`)
  check(/not the same as being fine/.test(none.err), '  …and says why, so nobody reads it as "no mail"', none.err.slice(0, 200))
}

// --- usage -------------------------------------------------------------------------------------
{
  const r = await run(['--cursor', unwritten()])
  check(r.code === 2, 'a missing --spool is a usage error, not a silent block', `code ${r.code}`)
}
{
  const r = await run(['--spool', makeDir('steady', [rec(true)])])
  check(r.code === 2, 'a missing --cursor is a usage error — without one every arm would wake on history', `code ${r.code}`)
}

{
  // THE RESIDUAL, stated rather than left for somebody to discover. An offset is the only evidence
  // the cursor file carries, so a spool truncated and refilled to the SAME byte count is invisible:
  // the cursor is not past EOF, and the fresh records behind it read as already consumed. Not
  // hypothetical — one record replaced by one record of equal length does it.
  //
  // This assertion exists so the limit fails loudly if anyone later believes the case is covered.
  const dir = makeDir('steady', [rec(true)])
  const at = statSync(join(dir, 'spool.jsonl')).size
  writeFileSync(join(dir, 'spool.jsonl'), '')
  append(dir, rec(true))
  const same = statSync(join(dir, 'spool.jsonl')).size === at
  const r = await run(['--spool', dir, '--cursor', cursorAt(at), '--poll', '100', '--timeout', '2', '--heartbeat', heartbeat()])
  check(same && r.code === 4,
    'KNOWN LIMIT (#573): a truncate-and-refill to the SAME size is undetectable from an offset alone, and reads as quiet',
    `same-size ${same}, code ${r.code}`)
}

// --- a signal is a teardown, not a verdict ------------------------------------------------------
// Raised by My Dude in #569 review. The contract says a caller re-arms on 3. If a signal also exited
// 3, a supervisor following that contract could never stop this tool: every teardown would re-arm it.
{
  const sigRun = sig => new Promise(resolve => {
    const dir = makeDir('steady', [rec(false)])
    const p = spawn(process.execPath, [TOOL, '--spool', dir, '--cursor', unwritten(), '--poll', '100'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err += d })
    setTimeout(() => p.kill(sig), 400)
    p.on('exit', (code, signal) => resolve({ code, signal, err }))
  })
  const term = await sigRun('SIGTERM')
  check(term.code === 143, 'SIGTERM exits 143, not 3 — a supervisor can stop this tool without it re-arming', `code ${term.code} signal ${term.signal}`)
  const int = await sigRun('SIGINT')
  check(int.code === 130, 'SIGINT exits 130 for the same reason', `code ${int.code} signal ${int.signal}`)
  check(/NOT a retryable 3/.test(term.err), '  …and says so, because the number alone is a thing somebody has to look up', term.err.slice(0, 160))
}

// --- it never blocks on nothing ------------------------------------------------------------------
{
  // A hung process is the failure this whole lane exists to avoid, and `run` reports it as code -1
  // rather than as a passing assertion. Every case above would have surfaced it; this states it.
  const dir = makeDir('steady', [rec(false)])
  const r = await run(['--spool', dir, '--cursor', unwritten(), '--timeout', '1', '--poll', '100'], { killAfterMs: 5000 })
  check(!r.hung, 'a --timeout is honoured — the tool exits rather than hanging past it', `code ${r.code}`)
}

rmSync(ROOT, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
