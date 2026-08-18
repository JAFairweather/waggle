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
  const refused = { ok: false, mayAct: true, author: 'c'.repeat(64) }
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

console.log(`\n${pass ? 'PASS' : 'FAIL'} — tests/notify_only.mjs`)
process.exit(pass ? 0 : 1)
