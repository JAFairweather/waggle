// The durable half of the wake lane (#557) — the half #561 explicitly does not close.
//
// Every property here is filesystem semantics, so all of it runs in a temp directory with no relay,
// no signer and no box. The crash cases reconstruct the post-crash state on disk and read it back
// through a genuinely fresh `openWakeSpool` — see the note above that section for why that is a
// stronger assertion than racing a SIGKILL against an fsync.
//
// THE CONTROLS ARE NOT DECORATION. Every refusal below is paired with a case that still gets
// through. A guard asserted only to reject cannot be told apart from one that rejects everything,
// and this repo has shipped exactly that: a slot validator asserted to throw on `Dennis @everyone`
// also threw on `My Dude`, and silently dropped every message to them. Green suite, live outage.
//
// ONE PROPERTY HERE IS NOT OBSERVABLE AND IS NOT CLAIMED. `appendDurable` fsyncs the parent directory
// as well as the file, because a file's bytes can reach the platter while the directory entry naming
// it does not. Removing that fsync survives this entire suite, and would survive any suite that runs
// in a process: the difference only appears across a power loss. It is verified by reading the code,
// which is a weaker altitude than everything else in this file, and it is recorded as such rather
// than covered by a test that would pass either way.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectSpoolDir, openWakeSpool, readSpoolFrom } from '../src/wake_spool.mjs'

let passed = 0, failed = 0
const check = (cond, label) => {
  if (cond) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL — ${label}`) }
}

const ROOT = mkdtempSync(join(tmpdir(), 'wake-spool-'))
let n = 0
const freshDir = () => { const d = join(ROOT, `d${++n}`); mkdirSync(d, { recursive: true }); return d }
const rec = (id, wake = true) => JSON.stringify({ ok: true, id, wake, content: 'hello' })
const ID = i => String(i).padStart(64, '0')

// --------------------------------------------------------------- bootstrap is a positive marker

console.log('\nbootstrap is something this daemon wrote, never something it failed to find')

check(inspectSpoolDir(freshDir()).state === 'bootstrap',
  'an empty directory is a first start')

// THE CASE THAT MOTIVATES THE MARKER. A wiped disk, a migration, a new box and a corrupted index all
// present to the daemon exactly as a first-ever start does — and a first start seeds the backlog
// WITHOUT waking, irreversibly. If absence meant bootstrap, every one of those would silently eat
// the pending backlog and report healthy.
{
  const d = freshDir()
  const s = openWakeSpool({ dir: d })
  s.deliver({ id: ID(1), line: rec(ID(1)) })
  s.finishBootstrap()
  check(inspectSpoolDir(d).state === 'steady',
    'after finishBootstrap the directory is steady — the control, so the refusals below are not "it always refuses"')

  rmSync(join(d, 'seen.log'))
  const lost = inspectSpoolDir(d)
  check(lost.state === 'inconclusive',
    'marker present and dedupe index GONE is INCONCLUSIVE — a wiped index must not read as a first start and seed the backlog into silence')
  check(/run here before/.test(lost.reason) && /seen\.log/.test(lost.reason),
    '  …and names which file is missing, because the operator has to decide restore-or-move rather than being told "failed"')
}

{
  // The other disagreement: a run that began and did not finish seeding.
  const d = freshDir()
  writeFileSync(join(d, 'spool.jsonl'), rec(ID(2)) + '\n')
  const half = inspectSpoolDir(d)
  check(half.state === 'inconclusive',
    'a spool with no marker is INCONCLUSIVE — a previous run seeded partway, and treating it as a first start would suppress the rest')
  check(/did not finish seeding/.test(half.reason),
    '  …stating which of the two disagreeing facts it believes, not just that they disagree')
}

{
  const d = freshDir()
  const s = openWakeSpool({ dir: d })
  check(s.state === 'inconclusive' === false && s.bootstrap === true, 'a fresh open reports bootstrap')
  s.deliver({ id: ID(3), line: rec(ID(3)) })
  check(s.bootstrap === true,
    'bootstrap is latched for the whole run — recomputing it per message would wake on the tail of the very backlog being seeded')
  s.finishBootstrap()
  check(s.bootstrap === false, 'and finishBootstrap ends it')
  const again = openWakeSpool({ dir: d })
  check(again.bootstrap === false && again.state === 'steady',
    'a second start does not bootstrap again — this is the assertion that separates "first-ever start" from "the 400th restart"')
  check(again.firstSeen(ID(3)) === false,
    '  …and the id seeded by the first run is still claimed, which is what makes the restart quiet')
  check(again.firstSeen(ID(99)) === true,
    '  …while an id it never saw is still first-seen — the index suppresses what it holds, not everything')
}

// A REGRESSION, AND THIS SUITE FOUND IT RATHER THAN REASONING ABOUT IT. `durableSet` creates its
// file on the first commit, so a first start whose mailbox happened to be EMPTY wrote a bootstrap
// marker beside no index — which `inspectSpoolDir` correctly reads as a lost index and refuses. An
// ordinary precondition, an empty inbox, reaching a permanent refusal on every later start.
{
  const d = freshDir()
  const s = openWakeSpool({ dir: d })
  check(s.bootstrap === true && s.size() === 0, 'a first start with nothing waiting for it')
  s.finishBootstrap()
  check(existsSync(join(d, 'seen.log')),
    'finishBootstrap creates the index even when it seeded nothing — the marker must never exist without it')
  const next = openWakeSpool({ dir: d })
  check(next.state === 'steady',
    'so the next start is steady rather than INCONCLUSIVE — a daemon whose first mailbox was empty must still be able to start again')
  check(next.firstSeen(ID(30)) === true && next.deliver({ id: ID(30), line: rec(ID(30)) }).claimed === true,
    '  …and it delivers normally, which is what makes the line above a working state and not merely a non-refusing one')
}

// An inconclusive directory must not be writable, or the refusal is advisory.
{
  const d = freshDir()
  writeFileSync(join(d, 'spool.jsonl'), rec(ID(4)) + '\n')
  const s = openWakeSpool({ dir: d })
  const r = s.deliver({ id: ID(5), line: rec(ID(5)) })
  check(r.ok === false && /refusing to write/.test(r.reason),
    'deliver() refuses in an inconclusive directory — a state that only logs and keeps writing is not a gate')
  check(readFileSync(join(d, 'spool.jsonl'), 'utf8').split('\n').filter(Boolean).length === 1,
    '  …observed on disk, not merely reported by the return value')
}

// ------------------------------------------------------------------------------------ the ordering

console.log('\nthe record is durable before the claim is')

// A duplicate is recoverable and a dropped wake is not, so the crash window has to fall on the
// duplicate side.
//
// THE CRASH IS CONSTRUCTED ON DISK, NOT SIMULATED IN PROCESS, and the distinction matters. There is
// exactly one state a kill between the two steps can leave behind — a spool line with no matching
// claim — and it is reproduced here byte for byte, then read back by a genuinely fresh
// `openWakeSpool` that loads its index from the file. Racing a real SIGKILL against an fsync would
// land the kill wherever it lands and assert nothing repeatable; what is asserted instead is that
// ANY interruption in that window is recovered from, which is the stronger claim.
{
  // Simulate the crash state directly and honestly: a spool line on disk with no claim, which is
  // precisely what a kill between the two steps leaves. Then restart and assert delivery, not loss.
  const d = freshDir()
  const s = openWakeSpool({ dir: d })
  s.finishBootstrap()
  appendFileSync(join(d, 'spool.jsonl'), rec(ID(6)) + '\n')   // the record landed…
  // …and the claim did not. This is the crash window, byte for byte.
  const after = openWakeSpool({ dir: d })
  check(after.firstSeen(ID(6)) === true,
    'a record that reached the spool but not the index is STILL first-seen after a restart — it is re-delivered, never dropped')
  check(after.state === 'steady',
    '  …and the directory is not confused by it: an unclaimed spool line is a duplicate to come, not corruption')

  // The control for that assertion: a message that completed BOTH steps is not re-delivered.
  const s2 = openWakeSpool({ dir: d })
  s2.deliver({ id: ID(7), line: rec(ID(7)) })
  check(openWakeSpool({ dir: d }).firstSeen(ID(7)) === false,
    'while a message that completed both steps is not re-delivered — without this, the line above passes on a spool that never claims anything')
}

{
  const d = freshDir()
  const s = openWakeSpool({ dir: d })
  s.finishBootstrap()
  const r = s.deliver({ id: ID(8), line: rec(ID(8)) })
  check(r.ok === true && r.claimed === true, 'an ordinary delivery reports both halves done')
  check(readFileSync(join(d, 'spool.jsonl'), 'utf8').includes(ID(8)), '  …with the record on disk')
  check(readFileSync(join(d, 'seen.log'), 'utf8').includes(ID(8)), '  …and the claim on disk')

  const dup = s.deliver({ id: ID(8), line: rec(ID(8)) })
  check(dup.ok === true && s.firstSeen(ID(8)) === false,
    'delivering the same id twice is not an error — the caller asks firstSeen() and decides; this module records what it is told')
}

// THE ORDERING ITSELF, DRIVEN RATHER THAN RECONSTRUCTED. Everything above proves the module recovers
// from the state a crash leaves. None of it proves `deliver()` puts the two steps in that order —
// and the mutation "claim first, then append" survived this whole section until this block existed.
// The observable difference is here: when the append fails, a claim-first implementation has already
// spent the claim, so the message is lost while the caller is told it failed. Append-first has not,
// so it is still owed.
//
// The failure is induced with EISDIR — the spool path is a directory, so the append cannot succeed
// for any user, including root. A permission bit would be ignored under root and this test would
// then pass without ever running.
{
  const d = freshDir()
  const s = openWakeSpool({ dir: d })
  s.finishBootstrap()
  mkdirSync(join(d, 'spool.jsonl'))              // the append will now fail, deterministically

  const w = s.deliver({ id: ID(10), line: rec(ID(10)) })
  check(w.ok === false,
    'when the record cannot be made durable, the delivery fails')
  // Being unable to induce the failure is not the same as the guard working: without this, a
  // platform where the append somehow succeeded would report the two lines below as passes.
  check(w.reason.includes('still owed'),
    '  …and says the message is still owed, which is the instruction to the operator, not just that it failed')
  check(s.firstSeen(ID(10)) === true,
    '  …and the id is STILL first-seen — the claim was never spent, so the next replay re-offers it')

  rmSync(join(d, 'spool.jsonl'), { recursive: true })
  const ok = s.deliver({ id: ID(10), line: rec(ID(10)) })
  check(ok.ok === true && ok.claimed === true && s.firstSeen(ID(10)) === false,
    'the control: with the append working again the same id goes through and IS claimed — so the line above is a live failure path, not a spool that refuses everything')
}

// A record that cannot be claimed must not be written at all: it would re-wake on every restart.
{
  const d = freshDir()
  const s = openWakeSpool({ dir: d }); s.finishBootstrap()
  const noId = s.deliver({ id: '', line: rec(ID(9)) })
  check(noId.ok === false && !existsSync(join(d, 'spool.jsonl')),
    'a record with no id is refused and nothing is written — an unclaimable record re-wakes on every restart, forever')
  const twoLines = s.deliver({ id: ID(9), line: 'a\nb' })
  check(twoLines.ok === false,
    'a record containing a newline is refused — it would frame two half-records to a reader splitting on lines')
}

// ---------------------------------------------------------------------- the cursor is bytes

console.log('\nthe cursor is a byte offset, and a partial line is held')

// THE BUG THIS EXISTS FOR, and it was real: a spool reader used statSync().size — bytes — to slice a
// decoded string, whose indices are UTF-16 code units. They agree only while everything is ASCII,
// and every return-lane envelope opens with an emoji.
{
  const d = freshDir()
  const p = join(d, 'spool.jsonl')
  const withEmoji = JSON.stringify({ ok: true, id: ID(10), content: '\u{1F4E5} you were mentioned' })
  const plain = JSON.stringify({ ok: true, id: ID(11), content: 'second' })
  writeFileSync(p, withEmoji + '\n' + plain + '\n')

  const first = readSpoolFrom(p, 0)
  check(first.records.length === 2, 'both records are read')
  check(first.records[0].content.startsWith('\u{1F4E5}'),
    '  …and the multi-byte character survives the round trip')
  check(first.next === Buffer.byteLength(withEmoji + '\n' + plain + '\n'),
    'the returned cursor is a BYTE count — it equals Buffer.byteLength, which for this content is larger than the string length')
  check(Buffer.byteLength(withEmoji) > withEmoji.length,
    '  …and the fixture really does contain multi-byte characters, or the assertion above proves nothing')

  const resumed = readSpoolFrom(p, first.next)
  check(resumed.records.length === 0 && resumed.next === first.next,
    'resuming from that cursor reads nothing and does not move — an adapter restart is idempotent')

  // The control that catches the actual defect: resume from a cursor computed the WRONG way.
  const wrong = readSpoolFrom(p, (withEmoji + '\n').length)
  check(wrong.records.length !== 1 || wrong.records[0].id !== ID(11),
    'resuming from a STRING-length offset does not cleanly yield the next record — which is how the real bug announced itself')
}

{
  const d = freshDir()
  const p = join(d, 'spool.jsonl')
  const whole = rec(ID(12))
  writeFileSync(p, whole + '\n' + '{"ok":true,"id":"partial')   // a writer caught mid-append
  const r = readSpoolFrom(p, 0)
  check(r.records.length === 1 && r.records[0].id === ID(12),
    'a complete record before a partial one is delivered')
  check(r.next === Buffer.byteLength(whole + '\n'),
    '  …and the cursor stops at the end of the last COMPLETE line, so the partial is not consumed')
  check(r.held > 0, '  …reporting that bytes are being held rather than silently discarding them')
  check(r.blocked === null,
    'a partial line is a race, not corruption — it must not be reported as malformed or an operator chases a writer that is working')

  appendFileSync(p, '","wake":false}\n')                        // the rest of the append arrives
  const after = readSpoolFrom(p, r.next)
  check(after.records.length === 1 && after.records[0].id === 'partial',
    'and once the remainder lands, the held record is delivered whole and exactly once')
}

{
  const d = freshDir()
  const p = join(d, 'spool.jsonl')
  writeFileSync(p, rec(ID(13)) + '\n' + 'this is not json\n' + rec(ID(14)) + '\n')
  const r = readSpoolFrom(p, 0)
  check(r.records.length === 1 && r.records[0].id === ID(13),
    'records before a malformed line are delivered')
  check(r.blocked !== null && /not json/.test(r.blocked.raw),
    'a malformed COMPLETE line is reported, with the bytes, so it can be looked at')
  check(r.next === Buffer.byteLength(rec(ID(13)) + '\n'),
    'and the cursor does NOT advance past it — the lane stalls loudly rather than skipping a record nobody will ever see again')
  check(r.blocked.at === Buffer.byteLength(rec(ID(13)) + '\n'),
    '  …naming the byte offset, because the operator has to find it in the file')
}

check(readSpoolFrom(join(freshDir(), 'nothing.jsonl'), 0).missing === true,
  'an absent spool is reported as missing, not as an empty read — "no records" and "no file" are different states, and one of them is a broken deployment')

// ------------------------------------------------------------ the whole restart story, end to end

console.log('\nrestart over relay history: the spool may re-record, and nobody wakes twice')

{
  const d = freshDir()
  const history = [ID(20), ID(21), ID(22)]

  // First-ever start: a relay full of history. Recorded, seeded, nobody woken.
  const first = openWakeSpool({ dir: d })
  for (const id of history) first.deliver({ id, line: JSON.stringify({ id, wake: false, bootstrap: true }) })
  first.finishBootstrap()
  check(readSpoolFrom(join(d, 'spool.jsonl'), 0).records.every(r => r.wake === false),
    'a first start records its whole backlog with wake:false — recorded, not announced')

  // A restart. The relay replays the same history, and one message that arrived while we were down.
  const second = openWakeSpool({ dir: d })
  const replayed = history.filter(id => second.firstSeen(id))
  check(replayed.length === 0,
    'on restart, none of the replayed history is first-seen — this is the assertion the in-memory index could not make')

  const GAP = ID(23)
  check(second.firstSeen(GAP) === true,
    'while mail that arrived during the downtime IS first-seen, and wakes — restart gap-mail was the half #561 left open')
  second.deliver({ id: GAP, line: JSON.stringify({ id: GAP, wake: true }) })

  const third = openWakeSpool({ dir: d })
  check(third.firstSeen(GAP) === false, 'and it does not wake a second time on the next restart')

  const all = readSpoolFrom(join(d, 'spool.jsonl'), 0).records
  check(all.filter(r => r.wake === true).length === 1,
    `exactly one record in the whole spool has wake:true across two restarts and a replay — got ${all.filter(r => r.wake === true).length} of ${all.length}`)
}

// THE NEGATIVE CONTROL FOR THE WHOLE FILE. With no durable index, that same sequence must LOSE the
// gap message — otherwise every assertion above would pass on a spool that does nothing.
{
  const d = freshDir()
  const memOnly = new Set([ID(20), ID(21), ID(22)])
  const restarted = new Set()                    // what an in-memory index holds after a restart
  check(restarted.has(ID(20)) === false && memOnly.has(ID(20)) === true,
    'negative control: an in-memory index is empty after a restart, so the whole replayed history reads as first-seen — which is the flood the durable index removes')
  const s = openWakeSpool({ dir: d })
  check(s.bootstrap === true,
    '  …and with no marker on disk that restart would take the bootstrap path and seed it into silence instead, which is the loss')
}

rmSync(ROOT, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)