// pow_wiring.mjs — the half of #346 that was missing: something that calls the miner.
//
// `src/pow.mjs` landed complete and with no caller. A miner nobody invokes is the same gap one
// layer down — the relay still refuses, the message still vanishes, and now there is code that
// looks like a fix. This suite covers the three things that turn it into one:
//
//   1. REMEMBERING what each relay demanded (`pow_targets.mjs`), because pow.mjs says the target
//      comes "from the last refusal that relay gave" and nothing was keeping it.
//   2. MINING OFF THE EVENT LOOP (`mineAsync` + `pow_worker.mjs`). This is the assertion the whole
//      design rests on, and §2 proves it the only way that means anything: by starving a timer with
//      the synchronous miner first, then showing the async one does not.
//   3. MINING BEFORE THE SIGNATURE (`sealAndWrap`). A nonce changes the id; the id is what
//      journalSend, markRelaySeen, markLatency and the dedup stores key on. The signed wrap's own
//      id must be the mined one, or the work is a decoration on an event that never had it.

import { getPublicKey, generateSecretKey } from 'nostr-tools/pure'
import { POW_CAP, powDifficulty, mineSync, mineAsync } from '../src/pow.mjs'
import { powTargets } from '../src/pow_targets.mjs'

let pass = true
const ok = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}${cond || !detail ? '' : `  [${detail}]`}`)
  if (!cond) pass = false
}

// ── 1. What each relay asked for ─────────────────────────────────────────────────────────────
console.log('\n1. remembering the demand')
{
  const t = powTargets({ cap: 16 })
  const NOSLOL = 'wss://nos.lol', PRIMAL = 'wss://relay.primal.net', DAMUS = 'wss://relay.damus.io'

  // The real string, from the real relay, since 2026-08-08. `(12)` is what the event HAD; 28 is
  // what it wants. A parser that took the bracketed number would mine to a target nobody asked for.
  ok('a real nos.lol refusal is understood', t.record({ relay: NOSLOL, accepted: false, reason: 'pow: 28 bits needed. (12)' }) === 28)
  ok('a non-proof-of-work refusal teaches nothing',
    t.record({ relay: PRIMAL, accepted: false, reason: 'blocked: not on the whitelist' }) === null && t.demandFor(PRIMAL) === null)
  ok('and neither does an accept that happens to mention pow',
    t.record({ relay: DAMUS, accepted: true, reason: 'duplicate: have this event, pow fine' }) === null && t.demandFor(DAMUS) === null)

  // The one that is tempting to get wrong. Forgetting on success sends the next wrap bare, earns a
  // fresh refusal, and mines again — one refused message per send, forever, reading in the log as a
  // relay that flaps.
  t.record({ relay: PRIMAL, accepted: false, reason: 'difficulty 12 required' })
  t.record({ relay: PRIMAL, accepted: true, reason: '' })
  ok('an ACCEPT does not forget the demand — the accept is very likely BECAUSE we mined', t.demandFor(PRIMAL) === 12)
  t.record({ relay: PRIMAL, accepted: false, reason: 'pow: 8 bits needed.' })
  ok('BOTH DIRECTIONS — a relay lowering its demand is followed down, so this is memory and not a ratchet',
    t.demandFor(PRIMAL) === 8)

  const plan = t.targetFor([NOSLOL, PRIMAL, DAMUS])
  ok('the target is the HIGHEST demand at or below the cap — proof-of-work is monotone, so one mine serves them all',
    plan.target === 8, String(plan.target))
  ok('CRITICAL — an over-cap relay does not drag the target up; each bit doubles the cost and it refuses either way',
    plan.overCap.join() === NOSLOL && !plan.satisfies.includes(NOSLOL), JSON.stringify(plan))
  ok('a relay that never refused for pow is listed as unknown, not as satisfied',
    plan.unknown.join() === DAMUS)
  ok('NEGATIVE CONTROL — a fan-out to relays that asked for nothing mines nothing',
    t.targetFor([DAMUS]).target === null)
  ok('and one to an over-cap relay alone also mines nothing, rather than mining to the cap and hoping',
    t.targetFor([NOSLOL]).target === null)
}

// ── 2. Off the event loop ────────────────────────────────────────────────────────────────────
//
// The claim is not "there is a worker file". It is that the thread carrying messages keeps running
// while the hashing happens. Measured by starving a 5ms interval, and — this is the part that makes
// it evidence rather than decoration — by first showing the SAME work on the same thread starves it.
console.log('\n2. off the event loop, with the control that proves the measurement works')
{
  const wsk = generateSecretKey()
  // A payload in the size class the cap was measured against, so the timing means something.
  const template = { kind: 1059, pubkey: getPublicKey(wsk), created_at: 1700000000,
    tags: [['p', 'b'.repeat(64)]], content: 'x'.repeat(3000) }
  const TARGET = 14   // heavy enough to take real time, far below the cap

  const countTicks = async (run) => {
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 5)
    const result = await run()
    clearInterval(timer)
    return { ticks, result }
  }

  // NEGATIVE CONTROL, and it runs FIRST. If the synchronous miner does not starve the timer, the
  // measurement is not sensitive enough to prove anything about the async one, and the assertion
  // below would pass for the wrong reason.
  const sync = await countTicks(async () => mineSync(template, TARGET))
  ok('NEGATIVE CONTROL — mining on this thread starves a 5ms timer, so the measurement can detect a stall',
    sync.result.mined && sync.ticks <= 1, `${sync.ticks} ticks during ${sync.result.iterations} nonces`)

  const async_ = await countTicks(async () => mineAsync(template, TARGET))
  ok('mining on a worker leaves the event loop free — the timer keeps firing throughout',
    async_.result.mined && async_.ticks > 3, `${async_.ticks} ticks during ${async_.result.iterations} nonces`)
  ok('and the worker reaches at least the difficulty it was asked for',
    powDifficulty(async_.result.event.id) >= TARGET, `${powDifficulty(async_.result.event.id)} bits`)
  ok('while committing to what was ASKED, never to what was reached — a tag claiming difficulty an id lacks is worse than none',
    async_.result.event.tags.find(t => t[0] === 'nonce')?.[2] === String(TARGET),
    JSON.stringify(async_.result.event.tags.find(t => t[0] === 'nonce')))

  // The cheap refusals must not cost a thread. ~30ms of worker startup to be told "no" would make
  // the refusal dearer than the mining it declined.
  const t0 = Date.now()
  const over = await mineAsync(template, POW_CAP + 8)
  ok('an over-cap ask is refused without starting a thread', over.code === 'over_cap' && Date.now() - t0 < 25,
    `${Date.now() - t0}ms`)
  ok('and the async refusal reads exactly like the sync one — one wording, so the two paths cannot explain the same fault differently',
    over.reason === mineSync(template, POW_CAP + 8).reason)
  ok('a signed event is refused rather than silently invalidated',
    (await mineAsync({ ...template, sig: 'ff' }, 4)).code === 'already_signed')
  // Two DISTINCT ways a worker fails to start, because they are two branches. A missing file
  // surfaces as an `error` EVENT — the constructor returns fine and the failure arrives later —
  // while a bad argument THROWS out of the constructor. Only asserting the first left the throw
  // branch free to fall back to inline mining, which a mutation proved it could.
  ok('a worker whose file does not exist is a refusal, never a quiet fall back to mining inline',
    (await mineAsync(template, 4, { workerUrl: new URL('./no-such-worker.mjs', import.meta.url) })).code === 'worker_failed')
  ok('and so is one whose constructor throws outright — the other branch, and the one that hid a fallback',
    (await mineAsync(template, 4, { workerUrl: {} })).code === 'worker_failed')
}

// ── 3. Mined BEFORE the signature ────────────────────────────────────────────────────────────
//
// sealAndWrap generates the wrap key on one line and drops it on the next. Everything downstream
// keys on `wrap.id`. So the only correct place is between the template and finalizeEvent, and the
// only proof is that the SIGNED event's own id carries the work.
console.log('\n3. mined before the signature, so the id everything keys on is the mined one')
{
  process.env.BUZZ_PRIVATE_KEY = Buffer.from(generateSecretKey()).toString('hex')
  const { sealAndWrap } = await import('../src/nostr_egress.mjs')
  const { verifyEvent } = await import('nostr-tools/pure')
  const to = getPublicKey(generateSecretKey())
  const send = (extra) => sealAndWrap(
    { template: 'relay_ack_err', to, slots: { channel: 'c', reason: 'rate cap', ts: 1700000000 }, ...extra },
    async () => 1)

  // Default off. Every relay that has not refused us is in this state, which is almost all of them.
  const plain = await send({})
  ok('with no target the wrap carries no nonce tag at all', !plain.wrap.tags.some(t => t[0] === 'nonce'),
    JSON.stringify(plain.wrap.tags))
  ok('and reports no mining rather than an empty success', plain.pow === null)

  // NEGATIVE CONTROL for the assertion below. An id is a hash, so an unmined one clears 12 bits by
  // luck once in 4096 — asserting on a single sample would be a control that fails a CI run a year
  // for no reason. Eight samples, allowing one fluke, puts that at about one in a million while
  // still proving the difficulty check is not something every id passes.
  const unmined = []
  for (let i = 0; i < 8; i++) unmined.push(powDifficulty((await send({})).wrap.id))
  ok('NEGATIVE CONTROL — unmined wraps do NOT meet the difficulty, so section 3 is not passing on any id',
    unmined.filter(d => d >= 12).length <= 1, unmined.join(','))

  const mined = await send({ powTarget: 12 })
  ok('with a target the SIGNED wrap id meets it — mining happened before finalizeEvent, not after',
    powDifficulty(mined.wrap.id) >= 12, `${powDifficulty(mined.wrap.id)} bits`)
  ok('and the signature is valid over the mined tags', verifyEvent(mined.wrap))
  ok('the committed target rides on the signed event, where a relay can read it',
    mined.wrap.tags.find(t => t[0] === 'nonce')?.[2] === '12')
  ok('exactly one nonce tag — two is an event a relay may reject and a target nobody can read',
    mined.wrap.tags.filter(t => t[0] === 'nonce').length === 1)
  ok('the recipient tag survives mining, so the wrap is still addressed to anyone',
    mined.wrap.tags.some(t => t[0] === 'p' && t[1] === to))

  // A mine that could not happen must still publish. Being refused by one relay is the outcome we
  // already have; not sending at all is a new failure invented by the fix.
  const refused = await send({ powTarget: POW_CAP + 8 })
  ok('an over-cap target still publishes, unmined — the cap declines the work, not the message',
    !!refused.wrap && verifyEvent(refused.wrap) && refused.pow?.mined === false)
  ok('and says which refusal it was, rather than reporting a silent absence of proof-of-work',
    refused.pow.code === 'over_cap')
}

// ── 4. THE WIRING — the two lines this PR is named for ───────────────────────────────────────
//
// Sections 1–3 drive `pow_targets.mjs` in isolation and `sealAndWrap` with a target the TEST hands
// in. Neither says `bridge.mjs` connects them, and review proved the gap by mutation: neutering both
// call sites at once —
//
//     src/bridge.mjs:2499   const learned = powDemands.record({...})  ->  const learned = null
//     src/bridge.mjs:3056   powTarget: powPlan.target                 ->  powTarget: null
//
// — left `npm test` at exit 0 with the same assertion count. Correct modules, tested, reachable only
// through two lines nothing exercised. That is the same defect class #346 exists to close, one layer
// up, so it is closed here the same way: by driving the real functions.
//
// The load-bearing assertion is the second one. It is the only one in the repo that fails when the
// miner stops being called.
console.log('\n4. bridge.mjs actually connects the two — learn from a refusal, then mine to it')
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { verifyEvent } = await import('nostr-tools/pure')

  // bridge.mjs boots on import; the same env fence tests/relay_refusal.mjs uses.
  const dir = mkdtempSync(join(tmpdir(), 'wb-pow-wiring-'))
  process.env.WB_NO_BOOT = '1'
  process.env.FORWARD_MODE = 'dryrun'
  process.env.SEEN_PATH = join(dir, 'seen.log')
  process.env.PUB_WATERMARK_PATH = join(dir, 'watermark')
  process.env.SEND_JOURNAL_PATH = join(dir, 'send-journal.log')
  process.env.BUZZ_PRIVATE_KEY = 'c'.repeat(64)   // returnLaneSend refuses to seal with no bridge key
  delete process.env.WB_STUB_SEND                 // the stub short-circuits the publisher entirely

  const { publishWrapToRelayList, powDemands, returnLaneSend, PUB } = await import('../src/bridge.mjs')

  // ── 4a. the LEARN half: a pow refusal arriving on a real socket reaches the demand store ────
  {
    const made = []
    const mkSocket = (url) => {
      const h = {}
      const s = {
        url, closed: false, sent: [],
        on(ev, fn) { (h[ev] ||= []).push(fn); return this },
        send(payload) { this.sent.push(payload) },
        close() { this.closed = true },
        emit(ev, ...a) { for (const fn of h[ev] || []) fn(...a) },
        frame(o) { this.emit('message', { toString: () => JSON.stringify(o) }) },
      }
      made.push(s)
      return s
    }
    const wrap = { id: 'a'.repeat(64), kind: 1059, content: 'x', tags: [], pubkey: 'b'.repeat(64), created_at: 1, sig: 'c'.repeat(128) }
    const DEMANDER = 'wss://learn-demander.invalid'
    const OTHER = 'wss://learn-other.invalid'
    const ACCEPTER = 'wss://learn-accepter.invalid'

    const p = publishWrapToRelayList(wrap, [DEMANDER, OTHER, ACCEPTER], mkSocket)
    made[0].emit('open'); made[1].emit('open'); made[2].emit('open')
    made[0].frame(['OK', wrap.id, false, 'pow: 12 bits needed. (4)'])
    made[1].frame(['OK', wrap.id, false, 'blocked: not on the allow list'])
    // An accept whose message mentions pow. `duplicate: have this event` is the healthiest answer a
    // relay gives, and a store keyed on "the message says pow" would mine for a relay that is happy.
    made[2].frame(['OK', wrap.id, true, 'duplicate: have this event, pow ok'])
    await p

    ok('the REAL publisher teaches the demand store what a relay asked for',
      powDemands.demandFor(DEMANDER) === 12, String(powDemands.demandFor(DEMANDER)))
    ok('  BOTH DIRECTIONS — a refusal for some other reason teaches it nothing',
      powDemands.demandFor(OTHER) === null, String(powDemands.demandFor(OTHER)))
    ok('  BOTH DIRECTIONS — an ACCEPT that mentions pow teaches it nothing either',
      powDemands.demandFor(ACCEPTER) === null, String(powDemands.demandFor(ACCEPTER)))
  }

  // ── 4b. the MINE half: a known demand puts real work on the wrap that is actually published ──
  //
  // THE assertion. `powTarget: powPlan.target -> powTarget: null` is invisible to every other test
  // in this repo and fails here. Asserted on the wrap the publisher RECEIVED, not on a return value:
  // what a relay sees is the only thing that settles whether the miner ran.
  {
    const savedRelays = PUB.relays
    const MINE_FOR = 'wss://mine-for-this.invalid'
    PUB.relays = [MINE_FOR]
    const captured = []
    const capturingPublish = async (wrap) => { captured.push(wrap); return 1 }
    const descriptor = { template: 'return_carry', slots: { mention: 'someone', why: 'mention', body: 'hello there', author: null } }

    const realLog = console.log, realErr = console.error
    const hush = () => { console.log = () => {}; console.error = () => {} }
    const speak = () => { console.log = realLog; console.error = realErr }

    try {
      // NEGATIVE CONTROL FIRST, and it is not optional: an unconditional mine would satisfy every
      // assertion below while ignoring the demand store entirely. "Mines when asked" and "always
      // mines" are the two states this section exists to tell apart.
      hush()
      await returnLaneSend('a'.repeat(64), descriptor, {}, capturingPublish)
      speak()
      ok('NEGATIVE CONTROL — with nothing demanded, the published wrap carries no nonce tag',
        captured.length === 1 && !captured[0].tags.some(t => t[0] === 'nonce'),
        JSON.stringify(captured[0]?.tags))

      // Now teach it, through the same public entry point the socket path uses.
      powDemands.record({ relay: MINE_FOR, accepted: false, reason: 'pow: 12 bits needed. (4)' })
      hush()
      await returnLaneSend('a'.repeat(64), descriptor, {}, capturingPublish)
      speak()

      const wrap = captured[1]
      ok('the send published a wrap at all — a capture that caught nothing proves nothing',
        !!wrap && wrap.kind === 1059)
      ok('THE WIRING — a demand this bridge learned puts a committed target on the published wrap',
        !!wrap && wrap.tags.find(t => t[0] === 'nonce')?.[2] === '12',
        JSON.stringify(wrap?.tags?.find(t => t[0] === 'nonce')))
      ok('  …and the work is REAL — the signed id a relay hashes meets the demand',
        !!wrap && powDifficulty(wrap.id) >= 12, `${wrap ? powDifficulty(wrap.id) : '?'} bits`)
      ok('  …and the wrap is still a valid signed event after mining',
        !!wrap && verifyEvent(wrap))
    } finally {
      speak()
      PUB.relays = savedRelays
    }
  }
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
