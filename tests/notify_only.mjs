// notify_only.mjs — the keyless wake.
//
// Two things are being asserted, and only one of them is about the happy path.
//
// 1. CONSERVATION. A coalescer exists to drop WAKES, never ARRIVALS. Too many wakes cost turns; one
//    lost arrival costs a message and looks exactly like a quiet lane, which is the failure mode
//    every other guard in this repo was written after. So the suite drives bursts and asserts that
//    the arrivals spoken for by all fires equal the arrivals offered — not that the rate looks right.
//
// 2. THE GATE DID NOT WIDEN. `notifyDecision` grew a branch for these records. A branch added to a
//    security gate is only safe if it is unreachable from the path it must not affect, so this
//    drives the keyed refusals again THROUGH THE NEW CODE and asserts each still refuses, and for
//    its own original reason rather than merely `!invoke`.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { makeCoalescer, notifyOnlyRecord } from '../src/notify_only.mjs'
import { notifyDecision, wakeVerdict } from '../src/return_lane_notify.mjs'

let pass = true
const check = (cond, label, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}${detail ? `  [${detail}]` : ''}`)
  if (!cond) pass = false
}

// ── 1. Conservation ────────────────────────────────────────────────────────────────────────────
console.log('\n-- 1. the coalescer drops wakes, never arrivals --')
{
  const c = makeCoalescer({ windowMs: 1000 })
  let fires = 0, spokenFor = 0
  // A burst of 40 inside one window, then the window edge.
  for (let i = 0; i < 40; i++) { const d = c.offer(1_000_000 + i); if (d.fire) { fires++; spokenFor += d.count } }
  const tail = c.flush(1_002_000)
  if (tail.fire) { fires++; spokenFor += tail.count }
  check(spokenFor === 40, 'a 40-arrival burst is spoken for in full', `arrivals=40 spokenFor=${spokenFor} fires=${fires}`)
  check(fires === 2, 'and costs 2 wakes, not 40 — the first arrival plus the window edge', `fires=${fires}`)
  check(c.pending() === 0, 'nothing is left outstanding', `pending=${c.pending()}`)
}
{
  // The property over a long, irregular run — the case a hand-picked burst can miss.
  const c = makeCoalescer({ windowMs: 500 })
  let offered = 0, spokenFor = 0, fires = 0
  let t = 0
  for (let i = 0; i < 500; i++) {
    t += (i * 37) % 300            // deterministic, uneven spacing; no Math.random in a suite
    offered++
    const d = c.offer(t)
    if (d.fire) { fires++; spokenFor += d.count }
  }
  const tail = c.flush(t + 10_000)
  if (tail.fire) { fires++; spokenFor += tail.count }
  check(spokenFor === offered, 'over 500 irregularly spaced arrivals, every one is spoken for', `offered=${offered} spokenFor=${spokenFor} fires=${fires}`)
  check(fires < offered, 'and strictly fewer wakes than arrivals were emitted, so it coalesced at all', `fires=${fires} offered=${offered}`)
}
{
  const c = makeCoalescer({ windowMs: 1000 })
  check(c.offer(0).fire === true, 'the very first arrival always fires — a watcher silent through its own first message is indistinguishable from a dead one')
  check(c.flush(10).fire === false, 'and a flush on a quiet lane manufactures nothing', 'fire=false expected')
}
{
  // NEGATIVE CONTROL for the conservation assertion itself. A coalescer that dropped the suppressed
  // arrivals would still look healthy to "did it fire?" — so prove the assertion above can fail.
  const lossy = (() => {
    let last = null
    return { offer(now) { if (last === null || now - last >= 1000) { last = now; return { fire: true, count: 1 } } return { fire: false, count: 0 } }, flush: () => ({ fire: false, count: 0 }) }
  })()
  let spokenFor = 0
  for (let i = 0; i < 40; i++) { const d = lossy.offer(1_000_000 + i); if (d.fire) spokenFor += d.count }
  const t = lossy.flush(1_002_000); if (t.fire) spokenFor += t.count
  check(spokenFor !== 40, 'NEGATIVE CONTROL: a coalescer that drops suppressed arrivals fails the same assertion', `a dropping implementation spoke for ${spokenFor} of 40`)
}
{
  check.threw = false
  try { makeCoalescer({ windowMs: -1 }); check(false, 'a negative window is refused') }
  catch { check(true, 'a negative window is refused rather than silently accepted') }
}

// ── 2. The record is honest about what it does not know ────────────────────────────────────────
console.log('\n-- 2. the record states what was never checked --')
{
  const r = notifyOnlyRecord({ id: 'a'.repeat(64), receivedAt: 1787000000, live: true })
  check(r.trust_evaluated === false, 'trust_evaluated is false — a separate key from mayAct, because "we checked and no" and "we could not check" are different states')
  check(r.mayAct === false, 'mayAct is false')
  check(r.author === null && r.content === '', 'no author and no content are carried, because neither was read', `author=${r.author} content=${JSON.stringify(r.content)}`)
  check(r.wake === true, 'a first-seen live arrival wakes')
  check(r.mode === 'notify-only', 'the record names its own mode, so an adapter can tell the two streams apart')
}
{
  // THE TWO GATES MUST AGREE WITH THE KEYED PATH, and this asserts agreement rather than trusting
  // that the rules were copied correctly — the two live in different files.
  const keyedFirstSeen = wakeVerdict({ ok: true, mayAct: true, author: 'b'.repeat(64) }, { firstSeen: false })
  const mineFirstSeen = notifyOnlyRecord({ id: 'a'.repeat(64), firstSeen: false })
  check(keyedFirstSeen.wake === false && mineFirstSeen.wake === false,
    'a replay wakes nobody on either path', `keyed=${keyedFirstSeen.wake} notifyOnly=${mineFirstSeen.wake}`)
  check(mineFirstSeen.wake_reason === keyedFirstSeen.why,
    'and gives the SAME reason, not merely the same answer', mineFirstSeen.wake_reason)

  const keyedBoot = wakeVerdict({ ok: true, mayAct: true, author: 'b'.repeat(64) }, { bootstrap: true })
  const mineBoot = notifyOnlyRecord({ id: 'a'.repeat(64), bootstrap: true })
  check(keyedBoot.wake === false && mineBoot.wake === false, 'a first-start backfill wakes nobody on either path')
  check(mineBoot.wake_reason === keyedBoot.why, 'and gives the same reason', mineBoot.wake_reason)
}
{
  const one = notifyOnlyRecord({ id: 'a'.repeat(64) })
  const many = notifyOnlyRecord({ id: 'a'.repeat(64), arrivals: 12 })
  check(/a wrap/.test(one.wake_reason) && /12 wraps/.test(many.wake_reason),
    'the reason says how many arrivals the wake stands for', many.wake_reason)
}

// ── 3. The gate grew a branch and did not widen ────────────────────────────────────────────────
console.log('\n-- 3. the keyed refusals still refuse, through the new code --')
{
  const d = notifyDecision(notifyOnlyRecord({ id: 'a'.repeat(64) }), { hasCommand: true })
  check(d.invoke === true, 'a notify-only record fires the hook')
  check(/pull it with a signer/i.test(d.why), 'and the reason tells the operator what to do next, not just that it fired', d.why)
}
{
  // Each of these is a keyed record. None of them may take the new branch.
  const stranger = { ok: true, mayAct: false, forMe: true, author: 'c'.repeat(64), content: 'hello' }
  const d = notifyDecision(stranger, { hasCommand: true })
  check(d.invoke === false, 'a stranger is still refused')
  check(/not on the trust list/.test(d.why), 'and still for the trust reason, not a new one', d.why)
}
{
  // `mode` IS ON THIS FIXTURE DELIBERATELY. Without it, hoisting the notify-only branch above the
  // `v.ok !== true` check passes every assertion in this file — nothing pins the order. With it, a
  // hoisted branch would wave a REFUSED record through as a keyless arrival.
  const refused = { ok: false, mayAct: true, author: 'c'.repeat(64), mode: 'notify-only', trust_evaluated: false }
  check(notifyDecision(refused, { hasCommand: true }).invoke === false, 'a refused message is still refused')
  const noCmd = notifyDecision(notifyOnlyRecord({ id: 'a'.repeat(64) }), { hasCommand: false })
  check(noCmd.invoke === false && /no --on-message/.test(noCmd.why),
    'and with no hook configured, a notify-only record fires nothing — hasCommand is still checked first', noCmd.why)
}
{
  // THE BRANCH IS NOT REACHABLE BY DECLARATION ALONE. A record that claims the mode but has had its
  // trust evaluated is not this branch's record, and must not be waved through.
  const forged = { ...notifyOnlyRecord({ id: 'a'.repeat(64) }), trust_evaluated: true, mayAct: false }
  const d = notifyDecision(forged, { hasCommand: true })
  check(d.invoke === false, 'a record claiming mode notify-only but trust_evaluated:true is refused')
  check(/must declare trust_evaluated:false/.test(d.why), 'and says exactly why', d.why)
}
{
  // POSITIVE CONTROL for the block above: the keyed happy path still fires, so these assertions
  // distinguish "refuses the dangerous thing" from "refuses everything".
  const trusted = { ok: true, mayAct: true, forMe: true, author: 'd'.repeat(64), content: 'a real message' }
  const d = notifyDecision(trusted, { hasCommand: true })
  check(d.invoke === true, 'POSITIVE CONTROL: a trusted keyed message still fires the hook', d.why)
}

// ── 4. The caller's loop, which is where the real defect was ───────────────────────────────────
//
// The coalescer conserved perfectly and the tool still lost 194 of 195 arrivals, because the CALLER
// emitted a record only when the coalescer fired. Every arrival had already made an irreversible
// durable dedupe claim, so those 194 ids were claimed forever with nothing on disk — they would
// never be delivered again by anything. Sections 1-3 were all green while that was true.
//
// This drives the loop's shape: one record per arrival, one wake per window.
console.log('\n-- 4. one record per arrival, one wake per window --')
{
  const c = makeCoalescer({ windowMs: 1000 })
  const records = [], wakes = []
  const arrivals = 195
  for (let i = 0; i < arrivals; i++) {
    const now = 1_000_000 + i            // all inside one window, as a relay backfill is
    const d = c.offer(now)
    records.push(notifyOnlyRecord({ id: String(i).padStart(64, '0'), arrivals: d.fire ? d.count : 1, coalesced: !d.fire }))
    if (d.fire) wakes.push(d.count)
  }
  const tail = c.flush(1_100_000)
  if (tail.fire) wakes.push(tail.count)

  check(records.length === arrivals, 'every arrival produced a record, so no id is claimed with nothing on disk', `arrivals=${arrivals} records=${records.length}`)
  check(wakes.reduce((a, n) => a + n, 0) === arrivals, 'and the wakes between them speak for every one', `wakes=[${wakes}] sum=${wakes.reduce((a, n) => a + n, 0)}`)
  check(wakes.length === 2, 'at a cost of 2 wakes, not 195', `wakes=${wakes.length}`)
  check(records.filter(r => r.wake).length === 1 && records.filter(r => r.coalesced).length === arrivals - 1,
    'exactly one record carries the wake; the rest say they were coalesced, not that they were already delivered',
    `wake=${records.filter(r => r.wake).length} coalesced=${records.filter(r => r.coalesced).length}`)
  check(records.every(r => r.first_seen === true),
    'and none of them claims first_seen:false — a coalesced arrival is new mail, and saying otherwise would be a false claim about the index')
}
{
  // NEGATIVE CONTROL: the loop as it was originally written — a record only when the wake fires.
  // If this assertion ever stops failing, section 4 has stopped testing anything.
  const c = makeCoalescer({ windowMs: 1000 })
  const records = []
  for (let i = 0; i < 195; i++) { const d = c.offer(1_000_000 + i); if (d.fire) records.push(1) }
  check(records.length !== 195, 'NEGATIVE CONTROL: emitting a record only when the wake fires loses arrivals, and fails the assertion above', `that loop wrote ${records.length} records for 195 arrivals`)
}

// ── 5. THE TOOL'S OWN LOOP, DRIVEN ─────────────────────────────────────────────────────────────
//
// Sections 1-4 test the PRIMITIVES, and a review proved that is not the same thing: the caller's
// defective shape was restored in `tools/agent-inbox.mjs` — a record written only when the wake
// fires, the 194-of-195 silent loss — and the full 124-suite run stayed rc=0 with a byte-identical
// count of `ok` lines. Two more mutations of the keyless arm survived the same run: deleting the
// `--trust` refusal outright, and loading the signer unconditionally.
//
// The reason is structural. `tests/tool_relay_defaults.mjs` is the only suite that executes this
// tool at all and it never passes `--notify-only`, so the single guard on the whole arm was a source
// grep. A source grep does not see a body change.
//
// So this drives the built tool against a LOOPBACK RELAY and reads what it actually wrote. `ws://`
// on 127.0.0.1 is accepted by the tool by design, for exactly this.
console.log('\n-- 5. the tool itself, against a loopback relay --')
{
  const TOOL = fileURLToPath(new URL('../tools/agent-inbox.mjs', import.meta.url))
  const ME = getPublicKey(generateSecretKey())
  const N = 40
  const nowSec = () => Math.floor(Date.now() / 1000)
  // Real 1059 wraps, each signed by its own throwaway key, because the tool runs `verifyEvent`
  // before it counts anything. Nothing is ever decrypted, so the content can be junk — which is
  // itself the point of the mode.
  const batch = n => Array.from({ length: n }, () =>
    finalizeEvent({ kind: 1059, created_at: nowSec(), tags: [['p', ME]], content: 'not-openable' }, generateSecretKey()))

  let serve = []
  // THREE of them, because the tool refuses a relay set below a floor of 3 — a real guard, and the
  // first thing this section discovered. All three serve the SAME population, so this also proves the
  // dedupe holds across relays: 40 arrivals delivered three times must still be 40 records.
  const servers = Array.from({ length: 3 }, () => new WebSocketServer({ host: '127.0.0.1', port: 0 }))
  for (const wss of servers) {
    wss.on('connection', ws => {
      ws.on('message', raw => {
        let m
        try { m = JSON.parse(raw.toString()) } catch { return }
        if (m[0] !== 'REQ') return
        for (const w of serve) ws.send(JSON.stringify(['EVENT', m[1], w]))
        ws.send(JSON.stringify(['EOSE', m[1]]))
      })
    })
  }
  await Promise.all(servers.map(w => new Promise(r => w.once('listening', r))))
  const RELAY = servers.map(w => `ws://127.0.0.1:${w.address().port}`).join(',')
  const spoolDir = mkdtempSync(join(tmpdir(), 'notify-only-driven-'))

  // A CLEAN ENVIRONMENT, so "it never loads a signer" is being observed rather than assumed: no
  // credential variable is in scope for the tool to find even if it looked.
  const CLEAN = { PATH: process.env.PATH, HOME: spoolDir }
  // ⚠ ASYNC `spawn`, NEVER `spawnSync`. The relay servers live in THIS process, and `spawnSync`
  // blocks this event loop until the child exits — so the servers cannot accept the connection the
  // child is making, and the child reports "0 relay(s) answered". That is not a failing tool, it is
  // a test that never delivered its own input, and it read as a real defect for three runs. The same
  // class as the heredoc that silently dropped a non-breaking space: confirm the input arrived
  // before believing the output. The `answered` assertion below is what pins it.
  const run = (args, env = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TOOL, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...CLEAN, ...env } })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('error', reject)
    child.on('close', status => {
      clearTimeout(timer)
      const records = out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      resolve({ status, records, stderr: err })
    })
  })
  const BASE = ['--pubkey', ME, '--notify-only', '--relays', RELAY, '--jsonl', '--spool', spoolDir, '--coalesce-ms', '600000']

  // Run 1 — a first-ever start. The index is empty, so this whole population is history: recorded,
  // and announced to nobody.
  serve = batch(N)
  const first = await run(BASE)
  check(first.status === 0, 'the tool runs keyless against a relay and exits 0', `status=${first.status} ${first.stderr.slice(0, 120)}`)
  // THE PROBE DELIVERED ITS OWN INPUT. Without this line every assertion below is satisfied by a
  // relay that answered nothing, which is how this section reported a tool defect that was mine.
  check(/3 relay\(s\) answered/.test(first.stderr), '  …and all three loopback relays actually answered it',
    (first.stderr.match(/\d+ relay\(s\) answered/) || ['no "relay(s) answered" line at all'])[0])
  check(first.records.length === N, `a first start writes one record per arrival — ${N} arrivals, ${first.records.length} records`)
  const all = (rows, fn) => rows.length > 0 && rows.every(fn)
  check(all(first.records, r => r.wake === false), '  …and wakes nobody, because seeding an index is not mail arriving', `over ${first.records.length} records`)

  // Run 2 — the same spool, a NEW population. This is the live case, and the one the defect hid in.
  serve = batch(N)
  const second = await run(BASE)
  check(second.status === 0, 'a second start against the same durable spool exits 0', `status=${second.status}`)
  // THE ASSERTION THE MUTATION SURVIVED. Records are per arrival; only the wake is coalesced.
  check(second.records.length === N,
    `ONE RECORD PER ARRIVAL, from the tool's own loop — ${N} arrivals, ${second.records.length} records`,
    'a caller that writes only when the wake fires produces 1 here')
  const woke = second.records.filter(r => r.wake === true)
  check(woke.length === 1, `  …and exactly one of them woke anybody — ${woke.length}`, 'the window is 10 minutes, so the whole batch shares one wake')
  check(second.records.filter(r => r.coalesced === true).length === N - 1,
    `  …with the other ${N - 1} saying they were coalesced, not that they were already delivered`)
  // THE SERIALISER, OBSERVED ON THE WIRE. Deleting the notify-only branch of `notifyLine` used to
  // change nothing any test could see; it changes these two fields.
  check(all(second.records, r => r.mode === 'notify-only'),
    'every record the tool writes names its mode — an adapter can tell the two streams apart')
  check(all(second.records, r => r.trust_evaluated === false && r.mayAct === false && r.author === null),
    '  …and states that nothing was authenticated, with no author on any of them')
  // Replay: the same population a third time. Every id is claimed, so nothing may wake again.
  const third = await run(BASE)
  check(third.records.length === 0 && third.status === 0,
    'serving the same population again writes NOTHING — the tool returns before it records, so the durable claim holds across processes',
    `records=${third.records.length} status=${third.status}`)

  // THE REFUSALS, DRIVEN. Both of these survived a full suite run as source-only guards.
  const withTrust = await run([...BASE, '--trust', ME])
  check(withTrust.status === 3 && /never opens one/.test(withTrust.stderr),
    'the tool refuses --notify-only with --trust, exit 3, and says why', `status=${withTrust.status}`)
  const withGarbageTrust = await run([...BASE, '--trust', 'not-a-key'])
  check(withGarbageTrust.status === 3 && /never opens one/.test(withGarbageTrust.stderr),
    '  …and refuses it for the MODE before complaining about the hex, so the operator is not sent to fix a value this mode cannot take',
    withGarbageTrust.stderr.split('\n')[0].slice(0, 90))

  // THE SIGNER, AS A PAIR. Unreadable credential paths: notify-only must not care, and the keyed
  // path with the same environment must die — which is what makes the first half mean anything.
  serve = batch(N)
  const badSigner = { WAGGLE_BUNKER_URI_FILE: join(spoolDir, 'nope'), WAGGLE_NIP46_CLIENT_NSEC_FILE: join(spoolDir, 'nope2') }
  const keyless = await run(BASE, badSigner)
  check(keyless.status === 0, 'with unreadable signer credentials, --notify-only completes — the loader is never reached', `status=${keyless.status} ${keyless.stderr.slice(0, 120)}`)
  const keyed = await run(['--pubkey', ME, '--relays', RELAY, '--jsonl', '--trust', ME, '--spool', join(spoolDir, 'keyed')], badSigner)
  check(keyed.status !== 0,
    'POSITIVE CONTROL: the KEYED path with the same environment does not — so the line above is an observation, not a tautology',
    `keyed status=${keyed.status}`)

  for (const w of servers) w.close()
  rmSync(spoolDir, { recursive: true, force: true })
}

console.log(`\n${pass ? 'PASS' : 'FAIL'} — tests/notify_only.mjs`)
process.exit(pass ? 0 : 1)
