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

import { readFileSync } from 'node:fs'
import { verifyEvent } from 'nostr-tools/pure'
import { loadNostrSigner } from '../src/nostr_signer.mjs'
import { spawn } from 'node:child_process'
import { invokeHook, notifyLine } from '../src/return_lane_notify.mjs'
import { inboxSummary, openTracker, rumorVerdict, sealAuthor, wrapAddressedTo } from '../src/return_lane_inbox.mjs'

const flag = n => { const i = process.argv.indexOf(n); return i < 0 ? '' : (process.argv[i + 1] || '') }
const has = n => process.argv.includes(n)
const HEX64 = /^[0-9a-f]{64}$/
const die = m => { console.error(`agent-inbox: ${m}`); process.exit(3) }

const self = String(flag('--pubkey') || '').toLowerCase()
if (!HEX64.test(self)) die('--pubkey <64-hex> is required — this tool reads one identity\'s mail and will not guess which')

// Trust is a list this agent is GIVEN, never one it derives from the mail. A sender that could add
// itself to the allowlist by sending is not an allowlist.
const trustArg = flag('--trust') || (flag('--trust-file') ? readFileSync(flag('--trust-file'), 'utf8') : '')
const trusted = trustArg.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(k => HEX64.test(k))

const relayArg = flag('--relays')
const RELAYS = (relayArg ? relayArg.split(',') : ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.ditto.pub'])
  .map(s => s.trim()).filter(Boolean)
const since = Math.floor(Date.now() / 1000) - (Number(flag('--since')) || 172800)
const watch = has('--watch')

// --jsonl puts one opened message per line on STDOUT and moves every human sentence to stderr, so a
// reader can consume stdout without parsing prose out of it. --on-message names an EXECUTABLE, not a
// command line: there is no argument splitting anywhere in this tool, because a command string is a
// quoting bug waiting for a display name with a space in it, and this project has already shipped
// that outage once. The envelope arrives on the hook's stdin. If you need arguments, write a
// two-line wrapper — that is a deliberate refusal to build a shell-string interface.
const jsonl = has('--jsonl')
const onMessage = flag('--on-message')
if (has('--on-message') && !onMessage) die('--on-message needs a path to an executable')
if (onMessage && trusted.length === 0) die('--on-message with an empty trust list can never fire — pass --trust/--trust-file, or drop the hook. A hook that cannot fire is indistinguishable from one that is not working')
const say = jsonl ? (...a) => console.error(...a) : (...a) => console.log(...a)

const signer = loadNostrSigner()
if (!signer) die('no signer configured — set WAGGLE_BUNKER_URI_FILE (and WAGGLE_NIP46_CLIENT_NSEC_FILE) or BUZZ_PRIVATE_KEY. Without one, sealed mail cannot be opened and this is INCONCLUSIVE, not empty')

let failed = 0
const verdicts = []
const seen = new Set()

// Two decrypts with a signature check BETWEEN them, exactly as src/nostr_egress.mjs insists: the
// seal's signature is the authorship proof, and doing the second (expensive) decrypt before it holds
// would run unauthenticated input through the signer.
async function open(wrap) {
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
  if (seen.has(wrap.id)) return
  seen.add(wrap.id)
  if (wrapAddressedTo(wrap, self).ok !== true) return
  let seal
  try { seal = JSON.parse(await signer.nip44Decrypt(wrap.pubkey, wrap.content)) }
  catch (e) {
    // Never counted as "no mail". This is the branch a bunker without nip44_decrypt lands in.
    failed++
    console.error(`  could not open a wrap — ${String(e?.message || e).slice(0, 160)}`)
    return
  }
  const author = sealAuthor(seal, verifyEvent)
  if (author.ok !== true) { verdicts.push(author); return }
  let rumor
  try { rumor = JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content)) }
  catch (e) { failed++; console.error(`  could not open a seal from ${author.author.slice(0, 12)}… — ${String(e?.message || e).slice(0, 160)}`); return }
  const verdict = rumorVerdict(rumor, { author: author.author, self, trusted })
  verdicts.push(verdict)
  if (jsonl) {
    // One record per line on stdout, refusals included. Dropping a refusal silently would leave a
    // reader unable to tell a quiet lane from one being fed forgeries.
    process.stdout.write(notifyLine(verdict) + '\n')
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
  if (onMessage) track(runHook(verdict))
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
async function runHook(verdict) {
  const r = await invokeHook({ command: onMessage, verdict, spawn })
  if (!r.ok) { failed++; console.error(`  ${r.why}`) }
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
  if (stillOpen) console.error(`  ${stillOpen} wrap(s) were still being opened when the read ended — counted as unread, not as absent`)
  const summary = inboxSummary({ verdicts, failed: failed + stillOpen, reachable: answered, scanned: seen.size })
  say(`\n${summary.text}`)
  process.exit(summary.inconclusive ? 3 : 0)
}

// Registered BEFORE the subscription, not after: in --watch the promise below never settles, so a
// handler installed after it would never be installed at all. This is what makes the summary and
// the exit-3 contract reachable in --watch, which they were not — `Promise.all` only settled on the
// 24-day timer.
if (watch) process.on('SIGINT', () => { console.error('\n  interrupted — draining what is in flight, then reporting'); report() })

// --watch had no `onclose` and no reconnect (#505 review, must-fix 2). When a relay closed cleanly —
// a restart, an idle reap, the ordinary case over the days this mode is meant to run — the promise
// never settled, the timer held the process open, and the tool sat with no subscription printing
// nothing. That is worse than the polling it replaces, because a poll reconnects on the next tick.
await Promise.all(RELAYS.map(url => new Promise(resolve => {
  let ws, done = false, backoff = 1000
  const end = () => { if (done) return; done = true; try { ws?.close() } catch { /* already gone */ } resolve() }
  const t = setTimeout(end, watch ? 0x7fffffff : 12000)

  const connect = () => {
    try { ws = new WebSocket(url) } catch { return end() }
    ws.onopen = () => {
      backoff = 1000
      ws.send(JSON.stringify(['REQ', 'inbox', { kinds: [1059], '#p': [self], since, limit: 200 }]))
    }
    ws.onmessage = e => {
      let m
      try { m = JSON.parse(e.data) } catch { return /* a relay that speaks nonsense is one relay, not a crash */ }
      if (m[0] === 'EVENT' && m[2]) {
        track(open(m[2]).catch(err => {
          failed++
          console.error(`  an opener threw — ${String(err?.message || err).slice(0, 160)}`)
        }))
        return
      }
      if (m[0] === 'EOSE') { answered++; if (!watch) { clearTimeout(t); end() } }
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
