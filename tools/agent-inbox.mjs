#!/usr/bin/env node
// agent-inbox.mjs — the agent's end of the return lane (#505).
//
// waggle carries a mention out as NIP-17 sealed mail to this agent's own kind:10050 relays. Nothing
// in this repo read it, so the last leg of "a mention reaches the agent" was a person at a relay
// client. This subscribes, opens what it can, and says plainly what it could not open.
//
//   node tools/agent-inbox.mjs --pubkey <64-hex> --trust <64-hex>[,<64-hex>…]
//   node tools/agent-inbox.mjs --pubkey <64-hex> --since 3600 --watch
//   node tools/agent-inbox.mjs --pubkey <64-hex> --trust <64-hex> --watch --jsonl --on-message ./wake
//
// --watch holds the subscription open instead of exiting at EOSE. That is the difference between
// this and polling, and it is the whole point: an event arrives when it arrives, and the agent is
// not choosing an interval at which to be late.
//
// THE SIGNER IS NEVER HELD HERE. It comes from `loadNostrSigner`, which is either a local key or a
// NIP-46 pairing to a bunker; this file calls `nip44Decrypt` and never sees key material. A bunker
// that signs but does not implement `nip44_decrypt` cannot open this mail, and that is reported as
// INCONCLUSIVE rather than as an empty inbox — see the exit codes below.
//
// Exit: 0 read cleanly · 3 INCONCLUSIVE — no relay answered, or something could not be opened.
// There is deliberately no exit code that means "no mail", because this tool cannot distinguish a
// quiet inbox from a broken read without saying which it observed, and it always says.

// `ws` IS IMPORTED, NOT ASSUMED (#576). Every other relay-touching tool in this directory imports
// it; these two reached for a global `WebSocket` instead, which only exists on newer Node. That
// would be a version note and nothing more, except for the shape it fails in:
//
//   try { ws = new WebSocket(url) } catch { return end() }
//
// The catch swallows a ReferenceError exactly as it swallows a bad URL, so on a runtime without the
// global this reports NO CONNECTION rather than reporting that it cannot open one — and an agent
// reading an empty inbox has no way to tell that from no mail. Found onboarding an agent on Node 20.
import WebSocket from '../src/ws_runtime.mjs'
import { readFileSync } from 'node:fs'
import { verifyEvent } from 'nostr-tools/pure'
import { loadNostrSigner } from '../src/nostr_signer.mjs'
import { spawn } from 'node:child_process'
import { invokeHook, notifyLine } from '../src/return_lane_notify.mjs'
import { inboxSummary, openTracker, rumorVerdict, sealAuthor, wrapAddressedTo } from '../src/return_lane_inbox.mjs'
import { openWakeSpool } from '../src/wake_spool.mjs'
import { makeCoalescer, notifyOnlyRecord } from '../src/notify_only.mjs'
import { DEFAULT_PUBLIC_RELAYS, parseRelaySet, thinRelaySet } from '../src/relays.mjs'

const flag = n => { const i = process.argv.indexOf(n); return i < 0 ? '' : (process.argv[i + 1] || '') }
const has = n => process.argv.includes(n)
const HEX64 = /^[0-9a-f]{64}$/
const die = m => { console.error(`agent-inbox: ${m}`); process.exit(3) }

const self = String(flag('--pubkey') || '').toLowerCase()
if (!HEX64.test(self)) die('--pubkey <64-hex> is required — this tool reads one identity\'s mail and will not guess which')

// Trust is a list this agent is GIVEN, never one it derives from the mail. A sender that could add
// itself to the allowlist by sending is not an allowlist.
const trustArg = flag('--trust') || (flag('--trust-file') ? readFileSync(flag('--trust-file'), 'utf8') : '')
const trustTokens = trustArg.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
const trusted = trustTokens.map(s => s.toLowerCase()).filter(k => HEX64.test(k))
const droppedTrust = trustTokens.filter(s => !HEX64.test(s.toLowerCase()))
// KEYED ON *PROVIDED*, NOT ON *EMPTY* (#597). No `--trust` at all is a legitimate mode — the tool
// becomes a recorder, says so, and refuses `--on-message` outright at :125. But a `--trust` that was
// given and kept nothing is the silent-loss shape: every token was dropped by the HEX64 filter above
// without a word, the watcher started, the spool filled, and every message came through
// `mayAct: false` while the operator believed they had named a truster. That is how DJ Codex's lane
// ran for a day. The generated startup file prints `--trust '<waggle 64-hex>'` when it does not know
// the key, and tells the reader it will be refused by name — this is the line that makes that true.
// Same shape as `--relays` below: die when an explicit value survived nothing, warn when it survived
// some.
if ((has('--trust') || has('--trust-file')) && !trusted.length) {
  die(`--trust was given and named no usable key${droppedTrust.length ? `: ${droppedTrust.join(' ')}` : ' (it was empty)'}\n` +
    '  A trust list must be 64-hex pubkeys, separated by spaces or commas.\n' +
    '  Refusing rather than starting untrusted — a watcher with an empty trust list records every\n' +
    '  message as data, wakes nobody, and reports itself healthy. Omit --trust entirely if that is\n' +
    '  what you want; the tool will say it is running as a recorder.')
}
if (droppedTrust.length) console.error(`agent-inbox: DROPPED ${droppedTrust.join(' ')} — not 64-hex; trusting the rest of what you named`)

// The default set comes from `src/relays.mjs`, the same place `agent-send.mjs` takes it from. These
// two lines used to disagree — send defaulted to two relays, listen to three, and neither list was
// the module's four — so an onboarded agent spoke on one set and listened on another, and a reply
// carried to a relay it does not subscribe to is lost with nothing anywhere reporting a failure
// (#589). `WAGGLE_RELAY_RELAYS` is honoured here as well as in `agent-send.mjs`, so one variable
// configures both halves of the lane; it was previously read by the speaking half only.
// `allowLoopbackWs` keeps a capability this line had before it took its default from the module:
// an explicitly-passed `ws://127.0.0.1:PORT`, which is how this tool is driven against a local relay.
// Everything else is still wss-only, so the net effect is stricter than the hand-rolled parse — that one
// admitted `ws://` to any host on the internet.
//
// `parseRelaySet`, and it DIES on an explicit set that is entirely refused, the same as the sending
// half (#591). The reviewer's read was that a warning is arguably enough here because this tool only
// reads — the reason it is a refusal anyway is that this tool IS the notification mechanism. A
// watcher that falls back to relays the operator did not name is listening in the wrong place while
// reporting itself healthy, which is the exact silent-loss shape #585 is about; a watcher that
// refuses to start is at least visible. This only fires on a value that was never dialable, and
// `WAGGLE_RELAY_RELAYS` was ignored here entirely until this change, so no working setup can hit it.
const RELAY_ARG = flag('--relays') || process.env.WAGGLE_RELAY_RELAYS
const parsedRelays = parseRelaySet(RELAY_ARG, { allowLoopbackWs: true })
if (parsedRelays.dropped.length && !parsedRelays.kept.length) {
  die(`--relays named ${parsedRelays.dropped.length} relay(s) and none of them are dialable: ${parsedRelays.dropped.join(' ')}\n` +
    '  Refusing rather than falling back to the public defaults — a watcher subscribed somewhere you did\n' +
    '  not name reports itself healthy and hears nothing.\n' +
    '  Relays must be wss:// (or ws:// on 127.0.0.1 / localhost / [::1] for a local relay).')
}
if (parsedRelays.dropped.length) console.error(`agent-inbox: DROPPED ${parsedRelays.dropped.join(' ')} — not dialable; listening on the rest of what you named`)
const RELAYS = parsedRelays.kept.length ? parsedRelays.kept : [...DEFAULT_PUBLIC_RELAYS]
const thin = thinRelaySet(RELAYS)
if (thin) console.error(`agent-inbox: THIN RELAY SET — ${thin}`)
console.error(`agent-inbox: relays ${RELAYS.join(' ')}`)
// TWO CLOCKS, AND THEY ARE NOT THE SAME ONE (#554).
//
// A relay filters kind 1059 on the WRAP's created_at, and NIP-59 says that value is randomised into
// the past on purpose, to stop an observer correlating send times. So `since` on the wire does not
// mean "recent mail"; it means "wraps that happen to be stamped recently", and fresh mail is
// routinely stamped a day and a half ago. Measured on a live lane: of 48 wraps, the NEWEST was
// stamped 5.9h old, the median 34.1h, and `--since 30` matched none of them.
//
// That made a short window structurally blind while the tool reported "Nothing new — and that is a
// measured answer, not a failed read." A `--watch --since 30` waker ran two hours against a live
// lane and could not have fired; a 4h read returned zero over a window that provably held two
// messages. Widening `--since` until mail appears — which is what the Pi runtime did to get its
// waker working — treats the symptom and then replays the whole backfill.
//
// So: ask the wire for the full randomisation horizon always, and answer "is this recent" from the
// RUMOR's own created_at, which is the real send time and is already parsed further down.
const WIRE_FLOOR = 172800
const sinceArg = Number(flag('--since')) || WIRE_FLOOR
const wireSince = Math.floor(Date.now() / 1000) - WIRE_FLOOR
const freshAfter = Math.floor(Date.now() / 1000) - sinceArg
const watch = has('--watch')
let stale = 0

// --jsonl puts one opened message per line on STDOUT and moves every human sentence to stderr, so a
// reader can consume stdout without parsing prose out of it. --on-message names an EXECUTABLE, not a
// command line: there is no argument splitting anywhere in this tool, because a command string is a
// quoting bug waiting for a display name with a space in it, and this project has already shipped
// that outage once. The envelope arrives on the hook's stdin. If you need arguments, write a
// two-line wrapper — that is a deliberate refusal to build a shell-string interface.
//
// KNOW WHAT --trust BUYS. On the return lane the seal author is always the bridge, so trusting the
// bridge key is the only configuration in which the hook fires at all — and from there it fires for
// every mention any community member sends. The trust list authenticates the COURIER, not the
// author: mayAct means a trusted courier delivered this, never a trusted party said it.
const jsonl = has('--jsonl')
const onMessage = flag('--on-message')
if (has('--on-message') && !onMessage) die('--on-message needs a path to an executable')

// --notify-only IS THE KEYLESS WATCHER (see src/notify_only.mjs). It subscribes to the same filter,
// opens nothing, and emits a content-free wake. That lets a watcher run on a host we do not control,
// because there is no signer on it to lose.
//
// IT REFUSES A TRUST LIST RATHER THAN IGNORING ONE. Trust is evaluated on the seal's author, and
// this mode never decrypts a seal, so a --trust here could only be accepted and dropped. That is the
// exact shape of every defect in this file's history: a configuration that looks like a gate, reads
// as healthy, and gates nothing. Refusing is the only answer that cannot be misread.
const notifyOnly = has('--notify-only')
if (notifyOnly && (has('--trust') || has('--trust-file'))) {
  die('--notify-only cannot apply a trust list: the sender is inside the seal and this mode never opens one. Drop --trust here and apply the trust list where the mail is pulled, or drop --notify-only and give this watcher a signer')
}
// The keyed path's guard, and the reason it does not apply above: there, an empty trust list means
// the hook can never fire. Here the hook fires on arrival and the trust list is somebody else's job.
if (!notifyOnly && onMessage && trusted.length === 0) die('--on-message with an empty trust list can never fire — pass --trust/--trust-file, or drop the hook. A hook that cannot fire is indistinguishable from one that is not working')

const COALESCE_MS = Number(flag('--coalesce-ms')) > 0 ? Number(flag('--coalesce-ms')) : 30_000
const say = jsonl ? (...a) => console.error(...a) : (...a) => console.log(...a)

// NOT LOADED AT ALL under --notify-only, rather than loaded and unused. "Keyless" is the property
// this mode exists to have, and a process that read a bunker pairing into memory and then chose not
// to use it does not have it. The suite asserts the signer loader is never reached.
const signer = notifyOnly ? null : loadNostrSigner()
if (!notifyOnly && !signer) die('no signer configured — set WAGGLE_BUNKER_URI_FILE (and WAGGLE_NIP46_CLIENT_NSEC_FILE) or BUZZ_PRIVATE_KEY. Without one, sealed mail cannot be opened and this is INCONCLUSIVE, not empty')

// --spool TURNS THE DEDUPE INDEX DURABLE (#557). Without it this tool keeps an in-memory `seen`
// set, which dies with the process — so every restart is a first-ever start, the whole relay
// backfill reads as unseen, and it is seeded without waking. That is the correct rule for a first
// start and the wrong one for the 400th restart, and in memory there is no difference between them.
// The pilot unit runs `Restart=always` with `RestartSec=5`.
//
// Absent, behaviour is exactly what it was: in-memory dedupe, per-connection bootstrap. Present,
// both facts come from disk and survive a restart.
const spoolDir = flag('--spool')
if (has('--spool') && !spoolDir) die('--spool needs a directory')
const spool = spoolDir ? openWakeSpool({ dir: spoolDir, log: m => console.error(`  ${m}`) }) : null
// EXIT 3, NOT 1, AND BEFORE ANY MAIL IS READ. An inconclusive spool directory is one whose two
// records of what has been delivered disagree — a wiped index, an interrupted bootstrap. Continuing
// would either re-wake everything or seed a backlog into permanent silence, and the second is
// unrecoverable. Being unable to check is not the same as being fine.
if (spool && spool.state === 'inconclusive') die(`the spool at ${spoolDir} cannot be trusted — ${spool.reason}`)

let failed = 0
let hookFailed = 0
const verdicts = []
const seen = new Set()

// Two decrypts with a signature check BETWEEN them, exactly as src/nostr_egress.mjs insists: the
// seal's signature is the authorship proof, and doing the second (expensive) decrypt before it holds
// would run unauthenticated input through the signer.
// The two fields an adapter needs and this module is the only place that has (#559): the VERIFIED
// wrap id, and when this process saw it. `wrap.id` is only safe to use after `verifyEvent` below —
// until then it is a field in unauthenticated relay JSON, and a relay that could choose it could
// choose which record a spool cursor believes it has already delivered. Every call site here is
// downstream of that check.
//
// `received_at` is deliberately not `at`. `at` is rumor time, set by the sender, and `--since` is
// answered from it; ordering a spool by it would let a sender reorder the spool.
const stamp = wrap => ({ id: String(wrap?.id || ''), receivedAt: Math.floor(Date.now() / 1000) })

async function open(wrap, live = true, bootstrap = false) {
  // VERIFY BEFORE DEDUPING. `seen` is keyed on `wrap.id`, and until this line nothing had proved
  // that id was the event's own hash — it was a field in unauthenticated relay JSON. An event
  // carrying a colliding id, delivered first, would take the slot and silently suppress the real
  // message (#505 review, should-fix 3). `verifyEvent` recomputes the hash and checks the schnorr
  // signature, so the id becomes a value the relay cannot choose.
  //
  // This is NOT an authorship check and must never be read as one: the wrap is signed by a
  // throwaway ephemeral key that says nothing about who wrote the message. Authorship is the seal's
  // signature, checked by `sealAuthor` below, and that ordering is the whole point of the module.
  if (!verifyEvent(wrap)) {
    failed++
    console.error(`  a wrap did not verify — its id or signature is not the event it claims to be; not counted as read`)
    return
  }
  // THE FIRST-SEEN CLAIM, and with --spool it is the durable one. This is the fact `notifyLine`
  // serialises as `first_seen` and gates `wake` on, so it is claimed once, here, and carried rather
  // than re-derived downstream.
  //
  // THE CLAIM IS CHECKED HERE AND COMMITTED AFTER THE RECORD IS DURABLE, never the other way round.
  // A claim is irreversible — once the index holds an id no replay ever surfaces that message again
  // — so a crash between the two must leave a duplicate, which somebody notices, and never a
  // dropped wake, which nobody does. `spool.deliver()` enforces that ordering; all this line does
  // is ask.
  //
  // BOTH INDEXES ARE CONSULTED. The in-memory one still runs even with a spool, because two relays
  // delivering the same wrap microseconds apart would both pass a durable check that neither has
  // committed to yet.
  if (seen.has(wrap.id)) return
  if (spool && !spool.firstSeen(wrap.id)) return
  seen.add(wrap.id)
  // Stamped ONCE per message, not once per emit site: three calls to Date.now() would put three
  // different `received_at` values on records describing the same arrival.
  // With a spool, bootstrap is a DURABLE per-run fact — true only on a first-ever start, latched
  // for the whole run. Without one it is the per-connection approximation computed at the
  // subscription, which is the best an in-memory index can do.
  const meta = { ...stamp(wrap), firstSeen: true, live, bootstrap: spool ? spool.bootstrap : bootstrap }
  if (wrapAddressedTo(wrap, self).ok !== true) return
  let seal
  try { seal = JSON.parse(await signer.nip44Decrypt(wrap.pubkey, wrap.content)) }
  catch (e) {
    // Never counted as "no mail". This is the branch a bunker without nip44_decrypt lands in.
    // The in-memory claim is released because no durable record was written; otherwise a transient
    // NIP-46 timeout suppresses every relay replay for the life of this watcher.
    seen.delete(wrap.id)
    failed++
    console.error(`  could not open a wrap — ${String(e?.message || e).slice(0, 160)}; the in-memory claim is released`)
    return
  }
  const author = sealAuthor(seal, verifyEvent)
  if (author.ok !== true) {
    verdicts.push(author)
    // EMITTED, not dropped. This is the forgery class — a seal whose signature does not hold names
    // nobody — and it used to return before the emit below. A lane being fed forged seals then put
    // zero lines on stdout and looked exactly like a quiet one, which is the sentence this record
    // stream exists to prevent. The spool gets it for the same reason: under `--spool` with no
    // `--jsonl` this record was written nowhere at all, which is the exact silence the branch
    // exists to break, moved from stdout to disk.
    const forged = notifyLine(author, meta)
    if (spool) {
      const w = spool.deliver({ id: wrap.id, line: forged })
      if (!w.ok) { failed++; seen.delete(wrap.id); console.error(`  the spool refused a forgery record — ${w.reason}; the in-memory claim is released`) }
    }
    if (jsonl) process.stdout.write(forged + '\n')
    return
  }
  let rumor
  try { rumor = JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content)) }
  catch (e) { seen.delete(wrap.id); failed++; console.error(`  could not open a seal from ${author.author.slice(0, 12)}… — ${String(e?.message || e).slice(0, 160)}; the in-memory claim is released`); return }
  const verdict = rumorVerdict(rumor, { author: author.author, self, trusted })

  // THE MESSAGE CLOCK. `--since` is answered here, from the rumor, not on the wire — see WIRE_FLOOR.
  // Counted rather than dropped: a run that discarded 40 messages for age and one that received
  // none are different states, and only one of them means the lane is quiet.
  if (Number(verdict.at) > 0 && Number(verdict.at) < freshAfter) { stale++; return }

  verdicts.push(verdict)
  if (jsonl || spool) {
    // One record per line, refusals included. Dropping a refusal silently would leave a reader
    // unable to tell a quiet lane from one being fed forgeries.
    const line = notifyLine(verdict, meta)
    // THE SPOOL RUNS FIRST because it is the durable copy, and its result decides whether the
    // in-memory claim above survives. It is NOT a gate on the stdout line below: at-least-once
    // favours firing, so a record that failed to reach disk is still emitted and still wakes.
    if (spool) {
      const w = spool.deliver({ id: wrap.id, line })
      if (!w.ok) {
        failed++
        // ROLL THE MEMORY CLAIM BACK. `deliver()` is careful to claim nothing when the append
        // fails — but `seen.add` above already claimed it, and that claim outlives the failure.
        // Without this the next replay returns at the `seen.has` check, above the spool, above the
        // hook, and the message is never written again for the life of the process. `Restart=always`
        // does not save it: ENOSPC and a read-only remount do not kill the process.
        //
        // `src/stores.mjs` already holds this sentence — `durableSet.commit` undoes its own claim
        // with `if (!already) mem.delete(k)`, and `durableQueue` states it outright: memory may
        // never claim durability that failed. #121 added that rollback after a wrap posted twice,
        // because an entry check and a durable write sat on opposite sides of an async send. The
        // direction here is the other one, and it is worse: silent loss rather than a duplicate.
        seen.delete(wrap.id)
        console.error(`  the spool refused a record — ${w.reason}; the in-memory claim is released, so a replay re-offers this message`)
      }
      else if (!w.claimed) console.error(`  ${w.reason}`)
    }
    if (jsonl) process.stdout.write(line + '\n')
  } else if (verdict.ok === true) {
    const mark = verdict.disposition === 'trusted' ? 'TRUSTED' : verdict.disposition.toUpperCase()
    console.log(`\n[${mark}] ${verdict.author.slice(0, 16)}…${verdict.forMe ? '' : '  (this agent was copied, not addressed)'}`)
    console.log(`  ${verdict.reason}`)
    // Printed as content, never interpreted. A newline-prefixed body cannot forge the header above
    // it because the header is already written and this is one indented block.
    console.log(String(verdict.content).split('\n').map(l => `  | ${l}`).join('\n'))
  } else {
    console.log(`\n[REFUSED] ${verdict.reason}`)
  }
  // THE BACKFILL MUST NOT WAKE ANYONE (#554), AND THE RECONNECT REPLAY MUST (#557 review). This
  // line used to read `if (onMessage && (live || !watch))`, gating the hook on liveness. That stops
  // the first-start flood, and it also drops mail: the replay after a reconnect holds two
  // populations the relay does not distinguish — messages already delivered, and messages that
  // ARRIVED DURING THE DISCONNECT, never seen by anyone. Both land pre-EOSE with `live === false`.
  // Suppressing the second is the bug #557 was filed about, and the backoff runs to 60s.
  //
  // So liveness no longer gates. `invokeHook` applies the same `wakeVerdict` the record stream is
  // serialised from, and its gate is the first-seen claim above: an already-delivered replay never
  // reaches this line at all, because the dedupe returned early. What liveness still owns is
  // `bootstrap` — the history a relay owes us on a FIRST connection, which is all-unseen and would
  // otherwise be all-wake. That is a per-run fact, computed at the subscription, and it is the only
  // thing standing between an arm and a flood.
  //
  // A ONE-SHOT RUN IS THE OTHER CASE and it deliberately still fires: `bootstrap` is false there,
  // because a read with no --watch IS an intentional drain of the mailbox into whatever the hook
  // does with it.
  if (onMessage) track(runHook(verdict, meta))
}

// ── The keyless arrival path (--notify-only) ───────────────────────────────────────────────────
//
// Everything `open()` does that needs no key, and nothing that does. The order matters and is the
// same order for the same reasons: verify the event so the id is a hash the relay cannot choose,
// confirm the p-tag actually names us, and only then make the dedupe claim.
const coalescer = makeCoalescer({ windowMs: COALESCE_MS })
let arrived = 0
let suppressed = 0

// ONE RECORD PER ARRIVAL, ALWAYS. The dedupe claim above is per arrival and irreversible, so an
// arrival written nowhere is an id claimed forever with nothing on disk — silent loss, not a missed
// alarm. Only the WAKE is coalesced, and a suppressed one says so in its own words.
async function writeNotify(meta, { arrivals = 1, coalesced = false } = {}) {
  const record = notifyOnlyRecord({ ...meta, arrivals, coalesced })
  if (spool && meta.id) {
    const w = spool.deliver({ id: meta.id, line: JSON.stringify(record) })
    // Same rollback as the keyed path, for the same reason: a memory claim must never outlive the
    // durable write it stood in for, or a replay returns early and the wake is lost for good.
    if (!w.ok) { failed++; seen.delete(meta.id); console.error(`  the spool refused a notify record — ${w.reason}; the in-memory claim is released`) }
  }
  if (jsonl) process.stdout.write(JSON.stringify(record) + '\n')
  else if (record.wake) console.log(`\n[MAIL] ${record.wake_reason}`)
  return record
}

async function fireWake(meta, arrivals) {
  const record = notifyOnlyRecord({ ...meta, arrivals })
  if (!onMessage || !record.wake) return
  const r = await invokeHook({ command: onMessage, verdict: record, spawn, ...meta, hasCommand: true })
  if (!r.ok) { hookFailed++; console.error(`  ${r.why}`) }
}

async function notify(wrap, live = true, bootstrap = false) {
  if (!verifyEvent(wrap)) {
    failed++
    console.error('  a wrap did not verify — its id or signature is not the event it claims to be; not counted as read')
    return
  }
  if (seen.has(wrap.id)) return
  if (spool && !spool.firstSeen(wrap.id)) return
  seen.add(wrap.id)
  const meta = { ...stamp(wrap), firstSeen: true, live, bootstrap: spool ? spool.bootstrap : bootstrap }
  if (wrapAddressedTo(wrap, self).ok !== true) return
  arrived++
  // The two gates short-circuit the coalescer entirely: a replay and a first-start backfill are
  // recorded and wake nobody, so they must not consume a window slot either.
  if (!meta.firstSeen || meta.bootstrap) { await writeNotify(meta); return }
  const d = coalescer.offer(Date.now())
  await writeNotify(meta, { arrivals: d.fire ? d.count : 1, coalesced: !d.fire })
  if (d.fire) await fireWake(meta, d.count)
  else suppressed++
}

// The window edge. Without this a burst's tail would sit in `pending()` until the next arrival,
// which on a quiet lane is never — the coalescer would have turned a delivered message into a
// silent one, which is the failure this whole tool exists to remove.
if (notifyOnly && watch) {
  const timer = setInterval(async () => {
    const d = coalescer.flush(Date.now())
    // A WAKE ONLY. The arrivals it speaks for are already on disk, each with its own record; writing
    // another here would double-count them in any reader that sums the stream.
    if (d.fire) await fireWake({ id: null, receivedAt: Math.floor(Date.now() / 1000), firstSeen: true, live: true, bootstrap: false }, d.count)
  }, Math.max(1000, COALESCE_MS))
  timer.unref?.()
}

// The wake hook. Gated on notifyDecision, which is gated on the trust list and NOTHING else — a
// mention must never fire this, because anyone may seal mail to this key and a mention that runs a
// command hands every stranger a trigger on this session.
//
// The envelope goes in on STDIN. It is never interpolated into argv and never near a shell:
// `shell: false` is explicit rather than merely the default, because this is the line that would
// turn a display name into a command.
//
// A hook that cannot be spawned is counted as FAILED, not ignored. An alarm that never fires and
// one that always fires are indistinguishable from outside, and a wake adapter that silently is not
// there is the exact failure this tool exists to remove.
async function runHook(verdict, meta) {
  const r = await invokeHook({ command: onMessage, verdict, spawn, ...meta })
  // ITS OWN COUNTER, NEVER `failed`. `failed` is what inboxSummary renders as "could not be opened",
  // whose stated cause is a signer that signs but will not decrypt. A hook that exits non-zero AFTER
  // the message was opened and emitted would have sent the operator to debug their bunker about a
  // read that was perfect. Worse in --watch, where the counter never resets: one bad hook made every
  // later summary INCONCLUSIVE for the life of the process.
  if (!r.ok) { hookFailed++; console.error(`  ${r.why}`) }
  else if (!r.ran && !jsonl) console.error(`  hook not run — ${r.why}`)
}

let answered = 0

// THE OPENS MUST BE AWAITED BEFORE THE SUMMARY, and nothing used to await them (#505 review,
// must-fix 1). `ws.onmessage` was `async` and its promise was dropped on the floor: `open()`
// suspended at the first `nip44Decrypt`, the very next frame was EOSE, EOSE resolved the relay's
// promise, `Promise.all` settled, and `inboxSummary` ran with an empty verdict list. A trusted
// message from the bridge — present on the relay, decryptable with the key in hand — was reported
// as "Nothing new" with exit 0. That is the one sentence this module exists to prevent.
//
// It passed every test and the cold read-back because a LOCAL key settles the decrypt in a
// microtask, which drains before the EOSE frame is dispatched. With a bunker, `nip44Decrypt` is an
// RPC over a relay (`src/nostr_signer.mjs`) and it loses every time — 1 ms of latency is enough.
// The production signer is the one that triggers it, and the tests used the other one.
// The tracker itself lives in src/return_lane_inbox.mjs, where a suite drives it. That placement is
// the point: this defect survived because the logic sat in a file nothing tested.
const { track, drain } = openTracker()

const report = async () => {
  const stillOpen = await drain()
  // THE TAIL OF A ONE-SHOT DRAIN. Without this, every arrival after the first sits in `pending()`
  // and the run exits having recorded them and woken nobody — which for a `--notify-only` read with
  // a hook is the whole point of the run, silently not done.
  if (notifyOnly) {
    const d = coalescer.flush(Date.now())
    if (d.fire) await fireWake({ id: null, receivedAt: Math.floor(Date.now() / 1000), firstSeen: true, live: true, bootstrap: false }, d.count)
  }
  // A ONE-SHOT RUN SEALS ITS BOOTSTRAP TOO. Without this a `--spool` read with no `--watch` would
  // record its backfill, never write the marker, and refuse to start ever again — index without
  // marker is exactly the "began and did not finish seeding" state `inspectSpoolDir` stops on.
  await endBootstrap('the read finished')
  if (stillOpen) console.error(`  ${stillOpen} wrap(s) were still being opened when the read ended — counted as unread, not as absent`)
  if (notifyOnly) {
    // Its own sentence. `inboxSummary` counts OPENED messages and would report "nothing new" for a
    // run that recorded forty arrivals — the false all-clear this tool exists to remove, reached
    // from a new direction. Wakes and arrivals are both named because "1 wake" alone is unreadable
    // next to 40 arrivals, and an operator cannot derive one from the other.
    console.error(`\n${answered} relay(s) answered; ${arrived} wrap(s) addressed to this key, ${suppressed} coalesced into an earlier wake. Nothing was opened: this is a KEYLESS watcher and no sender was authenticated. Pull with a signer to learn who wrote them.`)
    if (hookFailed > 0) console.error(`${hookFailed} wake(s) failed to run the --on-message hook. The ARRIVALS are recorded; the WAKE-UP is what did not happen.`)
    if (failed > 0) console.error(`${failed} wrap(s) could not be recorded.`)
    process.exit(answered === 0 || failed > 0 || hookFailed > 0 ? 3 : 0)
  }
  const summary = inboxSummary({ verdicts, failed: failed + stillOpen, reachable: answered, scanned: seen.size })
  say(`\n${summary.text}`)
  // Said out loud. "Nothing new" next to 40 messages held back for age is the same false all-clear
  // this whole change exists to remove, just arrived at from the other direction.
  if (stale > 0) console.error(`${stale} message(s) were opened and held back as older than --since ${sinceArg}s. They are NOT absent — widen --since to see them.`)
  // Said separately from the read, because they are different failures with different remedies: the
  // read is about the signer, this is about the command. Still exit 3 — a wake that did not happen
  // is not a clean run — but the operator is now told which one to go and look at.
  if (hookFailed > 0) {
    console.error(`${hookFailed} message(s) were read and emitted, but the --on-message hook failed for them. The READ is fine; the WAKE-UP is what did not happen. Check the hook, not the signer.`)
  }
  process.exit(summary.inconclusive || hookFailed > 0 ? 3 : 0)
}

// Registered BEFORE the subscription, not after: in --watch the promise below never settles, so a
// handler installed after it would never be installed at all. This is what makes the summary and
// the exit-3 contract reachable in --watch, which they were not — `Promise.all` only settled on the
// 24-day timer.
if (watch) process.on('SIGINT', () => { console.error('\n  interrupted — draining what is in flight, then reporting'); report() })

const BOOTSTRAP_DEADLINE_MS = 30_000

// SEALING THE BOOTSTRAP IS ITS OWN FUNCTION BECAUSE TWO THINGS CAN END IT, and which one did is
// worth saying. Once it is sealed, this directory never bootstraps again — every later start reads
// the marker and lets the durable index decide what wakes.
//
// THE MARKER IS WRITTEN LAST, AND "LAST" INCLUDES WHAT IS STILL IN FLIGHT. `wake_spool.mjs` argues
// marker-last so a crash can never leave a marker beside a half-filled index — that state reads as
// steady, and the unseeded remainder of the backlog then wakes, which is the flood. EOSE does not
// mean the backfill is recorded: every `open()` for it is suspended inside two awaited
// `nip44Decrypt` calls, which with a bunker are round trips over a relay. Sealing on the EOSE frame
// wrote the marker after 1 of 8 seeded ids and reported "1 id(s)" for a backlog of 8. So the drain
// lives in here, where every caller gets it, rather than in the one call site that remembered.
//
// THE LATCH IS A PROMISE, SO A SECOND CALLER WAITS RATHER THAN SKIPPING PAST. It was a boolean that
// returned early, which quietly broke `report()`'s contract: it awaits this call precisely so a
// one-shot `--spool` read seals before exiting, and a boolean let that await return while the EOSE
// caller was still inside `drain()`. The process then exited holding an index and no marker —
// `inspectSpoolDir`'s "began seeding and did not finish" — and every later start on that directory
// dies at exit 3, permanently. Unmodified that ordering did not occur, because the EOSE call starts
// first and resumes a microtask ahead; but that guarantee lives in `openTracker.drain` in another
// module, where an early `if (!pending.size) return 0` would flip it with nothing in either file to
// notice. A bricked spool directory is too much to rest on hop-counting across a module boundary.
//
// `finally`, not a trailing assignment, because both call sites already `.catch()` this. A throw
// under the boolean left the latch set and `bootstrap` true, so every later message was seeded
// without waking — a permanently silent lane, in a process `Restart=always` never restarts because
// it never died. That is #557's own sentence, re-entered through the seal path.
//
// The deadline exists so a relay that never answers cannot hold bootstrap open forever. Nothing
// wakes while it is open, so "waiting for the last relay" and "silently not delivering anything" are
// the same observable state, and this lane exists to remove exactly that ambiguity.
let sealing = null
function endBootstrap(why) {
  if (!spool || !spool.bootstrap) return Promise.resolve()
  if (sealing) return sealing
  sealing = (async () => {
    const stillOpen = await drain()
    if (stillOpen > 0) console.error(`  ${stillOpen} message(s) were still opening when the bootstrap was sealed — they are recorded, but the count below undercounts them`)
    const r = spool.finishBootstrap()
    if (!r.ok) { console.error(`  the bootstrap marker could not be written — ${r.reason}`); return }
    console.error(`  bootstrap complete (${why}) — ${r.seeded} id(s) recorded without waking anybody; from here the durable index decides`)
  })().finally(() => { sealing = null })
  return sealing
}
if (spool && spool.bootstrap && watch) {
  const deadline = setTimeout(() => {
    endBootstrap(`${BOOTSTRAP_DEADLINE_MS / 1000}s deadline — ${answered}/${RELAYS.length} relay(s) had reached EOSE`)
      .catch(err => console.error(`  sealing the bootstrap threw — ${String(err?.message || err).slice(0, 160)}`))
  }, BOOTSTRAP_DEADLINE_MS)
  deadline.unref?.()
}

// --watch had no `onclose` and no reconnect (#505 review, must-fix 2). When a relay closed cleanly —
// a restart, an idle reap, the ordinary case over the days this mode is meant to run — the promise
// never settled, the timer held the process open, and the tool sat with no subscription printing
// nothing. That is worse than the polling it replaces, because a poll reconnects on the next tick.
await Promise.all(RELAYS.map(url => new Promise(resolve => {
  let ws, done = false, backoff = 1000
  const end = () => { if (done) return; done = true; try { ws?.close() } catch { /* already gone */ } resolve() }
  const t = setTimeout(end, watch ? 0x7fffffff : 12000)

  let live = false
  // Per RELAY, and it NEVER goes back to false — which is the whole reason it is separate from
  // `live`, which does reset below. A relay owes us its entire history once, on the first
  // connection. After this flips, a pre-EOSE envelope from that relay can no longer be assumed to be
  // history: it may be mail that arrived while we were away, and nothing on the wire tells them apart.
  //
  // TWO FLAGS RATHER THAN ONE, so `bootstrap` stays correct whichever way `live` behaves. Until this
  // change `live` was declared here, outside `connect()` — and `connect()` is re-invoked from
  // `onclose`, so it was never reset and stayed true for the life of the process, while the comment
  // below asserted the opposite. Anything deriving "is this backfill" from `live` alone was therefore
  // inert after the first reconnect. Found by My Dude in #557 review, correcting his own first
  // reading of it; this flag is monotonic by construction and does not depend on the answer.
  let everSynced = false
  const connect = () => {
    // Reset per connection, so the field means what its name and the comment below claim: arrived
    // after THIS connection's EOSE. It is an AUDIT fact and nothing gates on it — an audit field that
    // quietly means something other than its name is worse than no field, because a reader acts on it.
    live = false
    try { ws = new WebSocket(url) } catch { return end() }
    ws.onopen = () => {
      backoff = 1000
      ws.send(JSON.stringify(['REQ', 'inbox', { kinds: [1059], '#p': [self], since: wireSince, limit: 200 }]))
    }
    ws.onmessage = e => {
      let m
      try { m = JSON.parse(e.data) } catch { return /* a relay that speaks nonsense is one relay, not a crash */ }
      if (m[0] === 'EVENT' && m[2]) {
        // Bootstrap is the first connection's backfill and nothing else. In a one-shot read it is
        // always false: that whole run is a deliberate drain.
        const bootstrap = watch && !live && !everSynced
        // `live` is per-connection and flips at THIS relay's EOSE, so an envelope is live only if it
        // arrived after the backfill that relay owed us. On a reconnect it goes false again and the
        // subscription replays — but that replay is NOT simply "old messages arriving a second time",
        // which is what this comment used to say and what a review took from it instead of from the
        // code. It holds two populations the relay does not distinguish: messages already delivered,
        // and messages that arrived DURING the disconnect and have been seen by nobody. Only the
        // dedupe index separates them, which is why the wake gates on that and not on this.
        // BOTH ARMS ARE TRACKED, and they are written as two statements rather than one ternary
        // because `tests/return_lane_inbox.mjs` counts the literal `track(open(` to prove the opener
        // is never started untracked (#505). A ternary inside `track(...)` is still correct and still
        // invisible to that check, which would have retired the guard silently.
        const onThrow = err => {
          failed++
          console.error(`  an opener threw — ${String(err?.message || err).slice(0, 160)}`)
        }
        if (notifyOnly) track(notify(m[2], live, bootstrap).catch(onThrow))
        else track(open(m[2], live, bootstrap).catch(onThrow))
        return
      }
      if (m[0] === 'EOSE') {
        answered++; live = true; everSynced = true
        // BOOTSTRAP ENDS WHEN EVERY RELAY HAS DRAINED ITS HISTORY, not at the first EOSE. Ending it
        // early would mark a second relay's still-arriving backfill as live, and wake once per
        // message of it — the flood, arriving through the correct gate.
        //
        // A relay that never answers must not hold bootstrap open forever, because nothing wakes
        // while it is open and that is a silent lane. `endBootstrap` is therefore also called from
        // the deadline below, and says which of the two ended it.
        // NOT `track`ed, deliberately. `endBootstrap` awaits `drain()`, and a promise inside the
        // tracker that waits on the tracker never settles. It is fired and caught instead.
        if (spool && spool.bootstrap && answered >= RELAYS.length) {
          endBootstrap('every relay reached EOSE').catch(err =>
            console.error(`  sealing the bootstrap threw — ${String(err?.message || err).slice(0, 160)}`))
        }
        if (!watch) { clearTimeout(t); end() }
      }
    }
    // `ws` emits 'close' after 'error', so the close handler is the single place this is decided.
    ws.onerror = () => {}
    ws.onclose = () => {
      if (!watch) { clearTimeout(t); return end() }   // a close before EOSE is a read that did not happen
      console.error(`  ${url} closed the subscription — reconnecting in ${Math.round(backoff / 1000)}s`)
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 60000)
    }
  }
  connect()
})))

await report()
