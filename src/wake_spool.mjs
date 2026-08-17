// wake_spool.mjs — the durable half of the wake lane (#557).
//
// #561 built the record: one classified JSON line per opened message, with `wake` gated on a
// first-seen claim rather than on relay liveness. It left the claim in memory, where it dies with
// the process — so on a fresh start the whole backfill is unseen, is treated as bootstrap, and is
// seeded without waking. That is the correct rule for a first-ever start and the wrong one for the
// 400th restart, and with an in-memory index there is no difference between them. The pilot unit
// runs `Restart=always` with `RestartSec=5`. This module is what tells those two apart.
//
// It owns three files and nothing else. No relay, no signer, no network: every property below is
// filesystem semantics, which is why it is drivable in a temp directory rather than on a box.
//
//   spool.jsonl   append-only, one record per line, never rewritten or truncated in place
//   seen.log      the dedupe index — `durableSet` from stores.mjs, which already fsyncs the file
//                 and then its parent directory, the ordering this needs
//   started       the bootstrap marker: an explicit positive fact, written once
//
// THE ORDERING IS THE WHOLE POINT, and it has a direction that is not a matter of taste. A
// first-seen claim is IRREVERSIBLE by construction — once the index holds an id, no relay replay
// will ever surface that message again. So the crash window between "record it" and "claim it" has
// to fall on the recoverable side:
//
//   claim, then append   crash between them = permanent silent loss. No replay recovers it, and
//                        the lane reports healthy while the message is simply gone.
//   append, then claim   crash between them = a duplicate on the next start. Noisy, visible,
//                        recoverable.
//
// At-least-once, not at-most-once. A duplicate wake is noise somebody notices; a dropped wake is
// the entire bug #557 exists for. `deliver()` below is written in that order, and the suite proves
// the order rather than the comment: it makes the append fail and asserts the id is still first-seen
// afterwards, which is false for every claim-first implementation.

import { existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { durableSet } from './stores.mjs'
import { err } from './log.mjs'

const SPOOL = 'spool.jsonl'
const INDEX = 'seen.log'
const MARKER = 'started'

/**
 * Append one line and make it durable before returning.
 *
 * fsync on the FILE is not enough. The file's bytes can be on the platter while the directory entry
 * that names it is not, and after a power loss the file is then unreachable — so the parent
 * directory is fsynced too. `durableSet` already does this for the index; the spool gets the same
 * treatment rather than a weaker one, because the spool is the half that must survive.
 */
function appendDurable(path, dir, text) {
  let fileFd = null, dirFd = null
  try {
    fileFd = openSync(path, 'a', 0o600)
    writeFileSync(fileFd, text)
    fsyncSync(fileFd)
    closeSync(fileFd); fileFd = null
    dirFd = openSync(dir, 'r')
    fsyncSync(dirFd)
    closeSync(dirFd); dirFd = null
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 200) }
  } finally {
    if (fileFd !== null) { try { closeSync(fileFd) } catch { /* already gone */ } }
    if (dirFd !== null) { try { closeSync(dirFd) } catch { /* already gone */ } }
  }
}

/**
 * What state is this spool directory in, and is the daemon allowed to run?
 *
 * "EMPTY INDEX" IS NOT "FIRST-EVER START", and conflating them is the failure this function exists
 * to refuse. A new box, a disk wipe, a migration, a botched deploy, a corrupted file — every one of
 * those presents to a daemon exactly as a first-ever start does. In that state the bootstrap rule
 * seeds the entire pending backlog WITHOUT waking, and because the claim is irreversible, that
 * backlog is then gone permanently while the lane reports healthy.
 *
 * That is this repo's oldest shape: a quiet result reachable from a broken precondition. It is the
 * same sentence as "a zero-record read must not be reachable from a missing credential pair",
 * against a different resource. So bootstrap is keyed on an explicit POSITIVE marker that this
 * daemon wrote itself, never on the absence of something.
 *
 * The disagreeing states are INCONCLUSIVE and loud, never a guess:
 *
 *   marker, no index     the daemon has run before and its dedupe index is gone. Continuing would
 *                        re-wake everything the index was suppressing, or — if the operator
 *                        "fixed" it by clearing the marker too — seed the backlog into silence.
 *   index or spool,      something ran here and did not finish its bootstrap. Treating that as a
 *   no marker            first start would seed a partly-seeded backlog into silence.
 *
 * Exit 3, not 1: this is the INCONCLUSIVE contract `tripwire.mjs` and `verify-firewall.sh` already
 * use here. Being unable to check is not the same as being fine.
 */
export function inspectSpoolDir(dir) {
  const marker = existsSync(join(dir, MARKER))
  const index = existsSync(join(dir, INDEX))
  const spool = existsSync(join(dir, SPOOL))
  if (marker && index) return Object.freeze({ state: 'steady', marker, index, spool, reason: 'the dedupe index decides what wakes' })
  if (marker && !index) {
    return Object.freeze({
      state: 'inconclusive', marker, index, spool,
      reason: `this daemon has run here before (${MARKER} exists) but its dedupe index ${INDEX} is gone. It cannot tell new mail from mail already delivered, and both guesses lose something: waking replays everything, seeding drops it. Restore the index or move this directory aside deliberately.`,
    })
  }
  if (!marker && (index || spool)) {
    return Object.freeze({
      state: 'inconclusive', marker, index, spool,
      reason: `${index ? INDEX : SPOOL} exists but ${MARKER} does not, so a previous run began and did not finish seeding. Treating this as a first start would seed a partly-seeded backlog without waking anybody, and that suppression cannot be undone.`,
    })
  }
  return Object.freeze({
    state: 'bootstrap', marker, index, spool,
    reason: 'nothing has run here — the relay backlog will be recorded and seeded into the index without waking anybody, which is what a first start is',
  })
}

/**
 * Open a spool directory for one identity.
 *
 * Returns a handle even when the state is `inconclusive`; the caller decides whether to exit 3, and
 * `deliver()` refuses in that state rather than the constructor throwing. A throw here would be
 * caught somewhere and turned into a log line, and a lane that logs and continues past this is
 * exactly the lane that seeds a backlog into silence.
 */
export function openWakeSpool({ dir, cap = 50_000, log = err } = {}) {
  if (!dir || typeof dir !== 'string') throw new TypeError('openWakeSpool needs a directory')
  mkdirSync(dir, { recursive: true })
  const status = inspectSpoolDir(dir)
  const spoolPath = join(dir, SPOOL)
  // THE INDEX LOGS WHERE THIS SPOOL LOGS, never to stdout. `durableSet.load` announces itself on
  // every start, and the caller that owns this spool is `agent-inbox --jsonl`, whose stdout is a
  // record stream. Defaulting to stderr rather than to silence keeps the diagnostic: a lane that
  // loaded a surprising number of ids should say so somewhere.
  const seen = durableSet({ path: join(dir, INDEX), cap, label: 'wake-spool', noun: 'delivered id(s)', log })
  if (status.state !== 'inconclusive') seen.load()

  // `bootstrap` is a per-RUN fact and it is latched here at open, from the marker on disk. It is
  // deliberately not recomputed per message: a run that flipped out of bootstrap partway through
  // would wake on the tail of the very backlog it was seeding.
  let bootstrap = status.state === 'bootstrap'
  let sealed = false          // the marker has been written; bootstrap is over for good

  return {
    dir,
    spoolPath,
    state: status.state,
    reason: status.reason,
    get bootstrap() { return bootstrap },
    /** Has this id already been delivered? The claim `wake` is gated on in #561. */
    firstSeen: id => !seen.has(String(id || '')),
    size: () => seen.mem.size,

    /**
     * Record one message and, only once that is durable, claim it.
     *
     * `line` is the caller's already-serialised record — `notifyLine` from #561. This module never
     * builds one: it owns durability, not classification, and a spool that re-derived the record
     * would be a second place for the wake rule to live.
     */
    deliver({ id, line }) {
      const key = String(id || '')
      if (status.state === 'inconclusive') {
        return Object.freeze({ ok: false, claimed: false, reason: `refusing to write: ${status.reason}` })
      }
      if (!key) return Object.freeze({ ok: false, claimed: false, reason: 'a record with no id cannot be claimed, and writing one that can never be deduped would re-wake on every restart' })
      if (typeof line !== 'string' || line.includes('\n')) {
        return Object.freeze({ ok: false, claimed: false, reason: 'a record must be one line — an embedded newline would frame two half-records to a reader splitting on it' })
      }

      // STEP 1 — the record, durable. If this fails, nothing is claimed, so the message is still
      // owed and the next replay re-offers it. A duplicate is the failure mode here, by design.
      const wrote = appendDurable(spoolPath, dir, line + '\n')
      if (!wrote.ok) return Object.freeze({ ok: false, claimed: false, reason: `the spool append failed, so nothing was claimed and this message is still owed — ${wrote.reason}` })

      // STEP 2 — and only now the claim. A crash in the gap above leaves a spooled record with no
      // claim: on restart the relay replays it, `firstSeen` is true again, and it is delivered a
      // second time. That is the recoverable direction and it is chosen, not tolerated.
      const claimed = seen.commit(key, true)
      if (!claimed) {
        // The record is on disk and the claim is not. Say so rather than reporting success: this is
        // the one state that produces a duplicate later, and an operator seeing the duplicate needs
        // to be able to find the line that predicted it.
        return Object.freeze({ ok: true, claimed: false, reason: 'the record is durable but its claim was not written — expect this message again after a restart' })
      }
      return Object.freeze({ ok: true, claimed: true, reason: bootstrap ? 'seeded without waking' : 'delivered' })
    },

    /**
     * Bootstrap is finished: write the marker, and never bootstrap here again.
     *
     * WRITTEN LAST, after the seeding it describes. The other order looks equivalent and is not: a
     * crash midway through seeding would leave a marker beside a half-filled index, which reads as
     * `steady`, and the unseeded remainder of the backlog would then wake — a flood. Marker-last
     * leaves index-without-marker, which `inspectSpoolDir` refuses loudly. Both orders can be
     * interrupted; only this one is interrupted into a state somebody is told about.
     */
    finishBootstrap() {
      if (sealed) return Object.freeze({ ok: true, already: true })
      // THE INDEX FILE MUST EXIST BEFORE THE MARKER DOES, even when it is empty. `inspectSpoolDir`
      // reads marker-without-index as a lost index and refuses to start — correctly — and
      // `durableSet` only creates its file on the first commit. So a first start whose mailbox
      // happened to be empty wrote a marker beside no index, and every later start refused forever.
      // A perfectly ordinary precondition reaching a loud permanent failure, which is the same
      // family of bug as the quiet one and was caught by the suite rather than reasoned about.
      const indexPath = join(dir, INDEX)
      if (!existsSync(indexPath)) {
        const touched = appendDurable(indexPath, dir, '')
        if (!touched.ok) return Object.freeze({ ok: false, reason: `the dedupe index could not be created — ${touched.reason}` })
      }
      const wrote = appendDurable(join(dir, MARKER), dir, `${new Date().toISOString()} seeded ${seen.mem.size} id(s)\n`)
      if (!wrote.ok) return Object.freeze({ ok: false, reason: `the bootstrap marker could not be written — ${wrote.reason}. This directory will refuse to start rather than seed twice.` })
      sealed = true
      bootstrap = false
      log(`wake-spool: bootstrap complete, ${seen.mem.size} id(s) seeded without waking`)
      return Object.freeze({ ok: true, already: false, seeded: seen.mem.size })
    },
  }
}

/**
 * Read records from a byte offset, for an adapter that keeps a cursor.
 *
 * THE CURSOR IS A BYTE OFFSET AND NEVER A STRING INDEX. This is not a stylistic preference: Pi
 * Dog's reader used `statSync().size` — bytes — to slice a decoded JavaScript string, whose indices
 * are UTF-16 code units. The two agree only while every character is ASCII, and every return-lane
 * envelope carries an emoji. So the file is sliced as a Buffer and decoded after, never the reverse.
 *
 * A TRAILING PARTIAL LINE IS HELD, NOT PARSED. The writer appends; a reader can arrive mid-append.
 * A partial line is not corruption, it is a race, and the cursor must not advance past it — the
 * remainder arrives on the next read and the record is delivered whole, once.
 *
 * A MALFORMED COMPLETE LINE STOPS THE CURSOR. It is reported, and `next` does not advance past it,
 * so the daemon stalls loudly instead of skipping a record nobody will ever see again. That is the
 * deliberate choice: a stall is visible and a silent skip is not, and this lane's whole purpose is
 * that a message is never quietly lost.
 */
export function readSpoolFrom(path, offset = 0) {
  if (!existsSync(path)) return Object.freeze({ records: [], next: 0, held: 0, blocked: null, missing: true })
  const size = statSync(path).size
  const from = Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, size) : 0
  // Read the whole file and slice bytes. `readFileSync` returns a Buffer with no encoding argument,
  // so nothing has been decoded yet and the offset still means what it meant when it was written.
  const bytes = readFileSync(path).subarray(from, size)

  const NL = 0x0a
  const records = []
  let cursor = 0, blocked = null
  while (cursor < bytes.length) {
    const nl = bytes.indexOf(NL, cursor)
    if (nl === -1) break                                    // a partial line: held, not parsed
    const raw = bytes.subarray(cursor, nl).toString('utf8')
    if (raw.trim() === '') { cursor = nl + 1; continue }     // a blank line is not a record
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { parsed = null }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      blocked = Object.freeze({ at: from + cursor, raw: raw.slice(0, 200) })
      break                                                 // the cursor stops HERE, loudly
    }
    records.push(parsed)
    cursor = nl + 1
  }
  return Object.freeze({
    records: Object.freeze(records),
    next: from + cursor,
    held: bytes.length - cursor,
    blocked,
    missing: false,
  })
}
