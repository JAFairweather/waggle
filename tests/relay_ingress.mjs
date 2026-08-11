// Relay lane (DESIGN_RELAY_INGRESS, #122/#123) — an admitted agent seals a request to waggle's OWN
// key and waggle relays it into an allowlisted channel as the member it already is, then seals an
// ack back. This proves the parts the design and its adversarial review turn on:
//
//   • authorship proof: verifyEvent(seal) + rumor.pubkey === seal.pubkey (§2.4) — a bad signature
//     or a rumor claiming a different author is dropped PRE-AUTH (counted, unackable, no post),
//   • the gates fail closed: unlisted destination and ungranted signer are ACKED ok:false (§5),
//   • MUST-FIX 2: the per-sender rate cap keys on the AUTHENTICATED seal.pubkey, not the ephemeral
//     wrap key, so it actually bites,
//   • §7 flood surface: a hard wrap-size cap and the global decrypt budget both drop PRE-AUTH and
//     UNACKABLY, and bump the loud pre-auth drop counter the #116 alarm watches,
//   • §6 dedup-before-decrypt on the wrap id, and the routing discriminator (kind:14 + relay tag).
//
//   node tests/relay_ingress.mjs

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { getPublicKey, generateSecretKey, finalizeEvent, getEventHash } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'

const dir = mkdtempSync(resolve(tmpdir(), 'wb-relay-'))
const bridgeSk = generateSecretKey()
const bridgePk = getPublicKey(bridgeSk)
const CHAN = 'a8186b53-537d-46ad-a7e7-b6486c58970e' // an allowlisted destination (already a UUID)
const OTHER = 'ffffffff-0000-0000-0000-000000000000' // NOT allowlisted

writeFileSync(resolve(dir, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: ['wss://example.invalid'], inbox: 'chan', staging_inbox: 'chan',
    watch_authors: [], watch_events: [], approvers: [], grantors: [],
    scan_authors: [], scan_channels: [],
    relay_channels: [CHAN],
    replier_per_min: 5, channel_per_min: 20, lane_per_hour: 200, max_content_bytes: 16384,
    return_lane: [],
  },
}, null, 2))

process.env.CONFIG_PATH = resolve(dir, 'config.json')
process.env.SEND_JOURNAL_PATH = resolve(dir, 'send-journal.log')
process.env.SEEN_PATH = resolve(dir, 'seen.log')
process.env.POSTED_MAP_PATH = resolve(dir, 'posted.log')
process.env.RLSEEN_PATH = resolve(dir, 'return-lane-seen.log')
process.env.RELAYSEEN_PATH = resolve(dir, 'relay-lane-seen.log')
process.env.LATENCY_PATH = resolve(dir, 'latency-trace.jsonl')
process.env.UNDELIVERED_PATH = resolve(dir, 'undelivered.log')
process.env.LATENCY_TRACE_KEY = 'relay-ingress-test-key-that-is-long-enough-to-be-secret'
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.FORWARD_MODE = 'buzz'
process.env.WB_STUB_SEND = '1'
process.env.WB_NO_BOOT = '1'

const bridge = await import('../src/bridge.mjs')
const { handleRelayIngress, route, grantSet, relaySeen, addRelaySeen, dropRelaySeen, relayDropCounts, relayDropTotalPreAuth, resolveRelayDest, rateOk, relayRateOk, PUB } = bridge
const { flushLatency, readLatency, summarizeLatency } = await import('../src/latency.mjs')

let fails = 0
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }
const tick = () => new Promise(r => setImmediate(r))
const journal = () => existsSync(process.env.SEND_JOURNAL_PATH)
  ? readFileSync(process.env.SEND_JOURNAL_PATH, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []
let jbase = 0
const delta = () => { const j = journal(); const d = j.slice(jbase); jbase = j.length; return d }
const relayPost = d => d.find(e => e.kind === 9 && e.lane === 'relay')
const ack = d => d.find(e => e.kind === 1059 && e.lane === 'relay-ack')

// Build a 1059 gift-wrap addressed to waggle's key: rumor (kind:14, relay tag) → seal (13, signed
// by the sender) → wrap (1059, signed by a throwaway). Mirrors returnLaneSend's construction.
function wrapFor(senderSk, { body = 'hello team', channel = CHAN, kind = 14, tags, rumorPubkey, breakSig = false } = {}) {
  const senderPk = getPublicKey(senderSk)
  const now = Math.floor(Date.now() / 1000)
  const rumor = { kind, pubkey: rumorPubkey || senderPk, created_at: now,
    tags: tags !== undefined ? tags : [['relay', channel]], content: body }
  rumor.id = getEventHash(rumor)
  const seal = finalizeEvent({ kind: 13, created_at: now, tags: [],
    content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(senderSk, bridgePk)) }, senderSk)
  if (breakSig) seal.sig = seal.sig.replace(/.$/, c => (c === '0' ? '1' : '0'))
  const wsk = generateSecretKey()
  const wrap = finalizeEvent({ kind: 1059, created_at: now, tags: [['p', bridgePk]],
    content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wsk, bridgePk)) }, wsk)
  return { wrap, seal, rumor, senderPk: senderPk.toLowerCase() }
}
const admit = pk => grantSet.set(pk.toLowerCase(), { grantId: 'g-' + pk.slice(0, 8), grantor: 'test' })

// --- config -----------------------------------------------------------------
ok('relay_channels parsed', PUB.relayChannels.length === 1 && PUB.relayChannels[0] === CHAN)
ok('resolveRelayDest accepts the allowlisted channel', resolveRelayDest(CHAN) === CHAN)
ok('resolveRelayDest rejects an unlisted channel', resolveRelayDest(OTHER) === null)
ok('resolveRelayDest rejects empty', resolveRelayDest('') === null)

// --- happy path: granted sender, allowlisted channel ------------------------
{
  const sk = generateSecretKey(); const { wrap, senderPk } = wrapFor(sk)
  admit(senderPk)
  handleRelayIngress(wrap); await tick()
  const d = delta()
  ok('granted+allowlisted → posts kind:9 to the destination', !!relayPost(d) && relayPost(d).dest === CHAN)
  ok('granted+allowlisted → seals an ack back', !!ack(d))
  ok('the carried wrap is now deduped (relaySeen)', relaySeen.has(wrap.id))
  await flushLatency()
  const trace = readLatency()
  const hops = summarizeLatency(trace, [['relay.observed', 'relay.admitted'], ['relay.admitted', 'relay.posted'], ['relay.posted', 'return.published']])
  ok('the relay path leaves an opaque, stage-by-stage latency trace with no event id', trace.length >= 4 && !readFileSync(process.env.LATENCY_PATH, 'utf8').includes(wrap.id) && hops.every(h => h.count >= 1))
  // dedup-before-decrypt: replaying the SAME wrap does nothing
  handleRelayIngress(wrap); await tick()
  ok('replaying the same wrap carries nothing new (§6 dedup)', delta().length === 0)
}

// --- remote decrypt yields: concurrent delivery still posts once -----------------------------
{
  const sk = generateSecretKey(); const { wrap, seal, rumor, senderPk } = wrapFor(sk, { body: 'delayed remote decrypt' })
  admit(senderPk); delta()
  let release, opens = 0, posts = 0
  const gate = new Promise(resolveGate => { release = resolveGate })
  const deps = {
    openSealFn: async () => { opens++; await gate; return seal },
    openRumorFn: async () => rumor,
    postRelayFn: async ev => { posts++; bridge.markRelaySeen(ev.id) },
  }
  const first = handleRelayIngress(wrap, deps)
  await tick() // first invocation is suspended inside remote decrypt with the in-flight claim held
  const second = handleRelayIngress(wrap, deps)
  await tick()
  release()
  await Promise.all([first, second])
  ok('two relay deliveries during delayed NIP-46 decrypt open the wrap once', opens === 1)
  ok('two relay deliveries during delayed NIP-46 decrypt post exactly once', posts === 1)
}

// --- the durable claim/rollback primitive preserves retryability ----------------------------
{
  const sk = generateSecretKey(); const { wrap, senderPk } = wrapFor(sk, { body: 'claim/rollback' })
  admit(senderPk); delta()
  addRelaySeen(wrap.id)
  handleRelayIngress(wrap); await tick()
  ok('a claimed wrap is not carried again', delta().filter(e => e.kind === 9 && e.lane === 'relay').length === 0)
  dropRelaySeen(wrap.id)
  ok('rollback clears the claim, so a failed send can retry', !relaySeen.has(wrap.id))
  handleRelayIngress(wrap); await tick()
  ok('after rollback the same wrap carries exactly once', delta().filter(e => e.kind === 9 && e.lane === 'relay').length === 1)
}

// --- #336: the lane declares an explicit mention identity, so an agent can name people ---------
//
// The bug: Buzz resolves every at-word in the body against the channel roster and refuses the
// WHOLE post if one fails. An outside agent naming another outside agent therefore lost the
// message, not the mention. `--mention` switches Buzz to presentation-only for unresolved names
// while real member mentions still notify.
//
// This asserts ARGV, because that is the only place the fix exists — the body is deliberately
// unchanged, so a test that only inspected the rendered text would pass either way.
{
  const { __setTransportForTests } = await import('../src/egress.mjs')
  const stub = process.env.WB_STUB_SEND
  delete process.env.WB_STUB_SEND    // the stub short-circuits before emit; we need the real argv
  const HEX64 = /^[0-9a-f]{64}$/

  let argv = null
  const restore = __setTransportForTests(async (a) => { argv = a; return JSON.stringify({ event_id: 'c'.repeat(64) }) })
  const sk = generateSecretKey()
  const { wrap, senderPk } = wrapFor(sk, { body: 'ping @oliver and @claude — neither is a Buzz member' })
  admit(senderPk); delta()
  await handleRelayIngress(wrap); await tick()
  restore()
  if (stub) process.env.WB_STUB_SEND = stub

  const at = argv ? argv.indexOf('--mention') : -1
  ok('the relay lane passes --mention, so an unresolvable @name cannot destroy the post', at !== -1)
  ok('  the declared identity is a real pubkey, not a name or a placeholder',
    at !== -1 && HEX64.test(String(argv[at + 1] || '')))
  // WHICH key matters: it must be one Buzz will accept, and the sender is not a channel member.
  ok('  it is the bridge\'s own key — a channel member — not the external sender\'s',
    at !== -1 && argv[at + 1] === bridgePk && argv[at + 1] !== senderPk)
  // The fix must not touch the message. If it rewrote or stripped the at-words, the agent's words
  // would arrive altered — a different bug wearing this fix's clothes.
  const ci = argv ? argv.indexOf('--content') : -1
  ok('  the body is carried through UNCHANGED — at-words intact, not stripped or rewritten',
    ci !== -1 && argv[ci + 1].includes('@oliver') && argv[ci + 1].includes('@claude'))
}

// --- Buzz's own retryable flag decides whether a refusal replays (#342) ----------------------
//
// The defect: EVERY send failure rolled the claim back and logged "will retry", so a
// `retryable:false` user_error — an @name Buzz will never resolve — re-posted on every restart
// forever. Observed 2026-08-10 as a queue replaying since the day it was written.
//
// BOTH directions are asserted on purpose. A "fix" that simply stopped retrying everything would
// pass a one-sided test identically, and would silently drop every message a transient failure
// touched. The refusal case and the retry case have to be told apart.
{
  const { __setTransportForTests } = await import('../src/egress.mjs')
  const stub = process.env.WB_STUB_SEND
  delete process.env.WB_STUB_SEND     // exercise the real emit path, not the stub short-circuit
  const undelivered = () => existsSync(process.env.UNDELIVERED_PATH)
    ? readFileSync(process.env.UNDELIVERED_PATH, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []
  const BUZZ_REFUSAL = "mention '@claude' does not match a current channel member; retry with --mention <pubkey>"

  // (a) permanent — Buzz declares it non-retryable, so the wrap must be committed, not replayed.
  const skA = generateSecretKey(); const wA = wrapFor(skA, { body: 'a post naming someone Buzz cannot resolve' })
  admit(wA.senderPk); delta()
  let restore = __setTransportForTests(async () => {
    throw new Error(JSON.stringify({ error: 'user_error', message: BUZZ_REFUSAL, retryable: false }))
  })
  // AWAIT the carry, do not just tick. `addRelaySeen` stakes the claim BEFORE the send, so a wrap
  // still in flight is indistinguishable from one this fix committed — asserting `relaySeen` on an
  // unfinished carry passes for the wrong reason. Found exactly that way while writing this block.
  // Capture the lane's own output: the ack is ATTEMPTED here, but whether it seals depends on the
  // sender having published a kind:10050, which a synthetic test key has not. That precondition
  // belongs to the return lane and has its own suite — asserting delivery here would assert the
  // wrong module. What this block owns is that the refusal is not silent.
  const said = []
  const realErr = console.error, realLog = console.log
  console.error = (...a) => { said.push(a.join(' ')); realErr(...a) }
  console.log = (...a) => { said.push(a.join(' ')); realLog(...a) }
  await handleRelayIngress(wA.wrap); await new Promise(r => setTimeout(r, 100))
  console.error = realErr; console.log = realLog
  restore()
  const dA = delta()
  ok('retryable:false → the wrap is marked seen, so it does NOT replay', relaySeen.has(wA.wrap.id))
  ok('  the refusal is not silent — an ack to the sender is attempted',
    said.some(l => l.includes('RETURN') && l.includes(wA.senderPk.slice(0, 12))))
  ok('  and the journal says WHY it was not retried, naming Buzz\'s verdict',
    said.some(l => l.includes('RELAY[buzz] REFUSED') && l.includes('retryable:false')))
  ok('  and nothing was posted', !relayPost(dA))
  const rec = undelivered().find(r => r.id === wA.wrap.id)
  // Assert the REASON, not merely that a row exists: the Buzz message is the only actionable
  // thing in this failure, and a record that lost it sends an operator hunting.
  ok('  the loss is recorded with Buzz\'s own reason, so it is diagnosable', !!rec && rec.reason.includes('does not match a current channel member'))
  ok('  the record names the relay lane and the destination', !!rec && rec.lane === 'relay' && rec.dest === CHAN)

  // (b) transient — a failure carrying no verdict we can read MUST still retry. Being unable to
  // classify a refusal is not evidence that it is permanent.
  const skB = generateSecretKey(); const wB = wrapFor(skB, { body: 'a post that hits a flaky transport' })
  admit(wB.senderPk); delta()
  restore = __setTransportForTests(async () => { throw new Error('connection reset by peer') })
  await handleRelayIngress(wB.wrap); await tick()
  restore()
  ok('an unclassifiable failure rolls the claim back, so it DOES retry', !relaySeen.has(wB.wrap.id))
  ok('  and it is not recorded as an undelivered loss', !undelivered().some(r => r.id === wB.wrap.id))

  // (c) the flag is read, not guessed at: retryable:true is JSON we CAN parse and must still retry.
  const skC = generateSecretKey(); const wC = wrapFor(skC, { body: 'a post refused but retryable' })
  admit(wC.senderPk); delta()
  restore = __setTransportForTests(async () => {
    throw new Error(JSON.stringify({ error: 'upstream', message: 'relay busy', retryable: true }))
  })
  await handleRelayIngress(wC.wrap); await tick()
  restore()
  ok('an explicit retryable:true still retries', !relaySeen.has(wC.wrap.id))

  // (d) AMBIGUOUS — `retryable:false` is necessary but not sufficient to call something a refusal.
  // buzz-cli returns `delivery_unknown` (error.rs:127) for a timeout / body loss / 502-504 that
  // happened AFTER the POST, so the write may already have landed. It shares `retryable:false`
  // with a definite user_error, and a first version of this fix read only that boolean — so it
  // recorded a possibly-delivered message as an undelivered loss and acked the sender "refused".
  // Telling a sender to ask again about a post that landed is how a duplicate gets written.
  //
  // The retry decision is the SAME as (a) — commit, do not re-send, because a re-send is what
  // would duplicate. What must differ is everything the sender and the operator are told. Both
  // halves are asserted, because a test that only checked "not retried" cannot tell this case
  // apart from (a) at all — which is exactly how the defect survived being written.
  const skD = generateSecretKey(); const wD = wrapFor(skD, { body: 'a post whose fate buzz never reported' })
  admit(wD.senderPk); delta()
  const saidD = []
  restore = __setTransportForTests(async () => {
    throw new Error(JSON.stringify({
      error: 'delivery_unknown',
      message: 'relay may have stored the event; response body lost after POST',
      retryable: false,
    }))
  })
  const realErrD = console.error, realLogD = console.log
  console.error = (...a) => { saidD.push(a.join(' ')); realErrD(...a) }
  console.log = (...a) => { saidD.push(a.join(' ')); realLogD(...a) }
  await handleRelayIngress(wD.wrap); await new Promise(r => setTimeout(r, 100))
  console.error = realErrD; console.log = realLogD
  restore()
  ok('delivery_unknown is NOT retried — a re-send would risk a duplicate, not a rescue',
    relaySeen.has(wD.wrap.id))
  ok('  but it is NOT recorded as an undelivered loss — it may well have landed',
    !undelivered().some(r => r.id === wD.wrap.id))
  ok('  and the sender is NOT told "refused" about a message that may have posted',
    !saidD.some(l => l.includes('RELAY[buzz] REFUSED')))
  ok('  the journal says plainly that the outcome is unknown, not that it failed',
    saidD.some(l => l.includes('RELAY[buzz] UNCONFIRMED')))
  // The two retryable:false cases must be TOLD APART, not merely both handled. Pinning (a) again
  // here is what makes that a real distinction rather than two assertions that would pass if the
  // code collapsed both back into one branch.
  ok('  and a definite user_error is still recorded as a loss — the two are not one bucket',
    undelivered().some(r => r.id === wA.wrap.id) && !undelivered().some(r => r.id === wD.wrap.id))


  // (e) THE CASE THE FLAG GETS WRONG. `retryable:false` is not one thing, and the second version
  // of this fix still read it as "anything that is not delivery_unknown is a definite refusal".
  // Buzz also returns it for `relay_error: restricted: not a channel member` — captured from the
  // live binary at exit 2, not composed here. That refusal is the MOST fixable one there is:
  // waggle is not in the channel yet, an operator adds it, and the same message lands a minute
  // later. Dropping it permanently is the very failure this handler exists to prevent, run
  // backwards. It is also exactly what the comment at the top of the handler promises will retry.
  const skE = generateSecretKey(); const wE = wrapFor(skE, { body: 'a post to a channel waggle has not joined yet' })
  admit(wE.senderPk); delta()
  const saidE = []
  restore = __setTransportForTests(async () => {
    throw new Error(JSON.stringify({
      error: 'relay_error',
      message: 'relay error 400: restricted: not a channel member',
      retryable: false,
    }))
  })
  const realErrE = console.error, realLogE = console.log
  console.error = (...a) => { saidE.push(a.join(' ')); realErrE(...a) }
  console.log = (...a) => { saidE.push(a.join(' ')); realLogE(...a) }
  await handleRelayIngress(wE.wrap); await new Promise(r => setTimeout(r, 100))
  console.error = realErrE; console.log = realLogE
  restore()
  ok('a relay_error carrying retryable:false STILL RETRIES — the category decides, not the flag',
    !relaySeen.has(wE.wrap.id))
  ok('  and it is not recorded as an undelivered loss, because nothing has been lost yet',
    !undelivered().some(r => r.id === wE.wrap.id))
  ok('  and the sender is not told "refused" about something an operator is about to fix',
    !saidE.some(l => l.includes('RELAY[buzz] REFUSED')))
  // Assert the REASON, not just the rollback. `!relaySeen` alone cannot tell "classified as
  // retryable" from "the handler threw before it reached the classifier at all".
  ok('  and the journal says the claim was rolled back and will retry',
    saidE.some(l => l.includes('RELAY[buzz] ERR') && l.includes('will retry')))

  // (f) An unrecognised category — one buzz-cli adds next year — must fall through to retry too.
  // The table is an ALLOWLIST: membership is a claim that a category is definitely terminal, and
  // absence is not a claim about anything.
  const skF = generateSecretKey(); const wF = wrapFor(skF, { body: 'a post refused by a category we have never seen' })
  admit(wF.senderPk); delta()
  restore = __setTransportForTests(async () => {
    throw new Error(JSON.stringify({ error: 'quota_error', message: 'community over quota', retryable: false }))
  })
  await handleRelayIngress(wF.wrap); await tick()
  restore()
  ok('an UNKNOWN retryable:false category falls through to retry rather than being assumed terminal',
    !relaySeen.has(wF.wrap.id))

  // BOTH DIRECTIONS, one more time and at the end on purpose. Everything from (e) and (f) is
  // equally satisfied by a classifier that has stopped classifying anything at all — which is the
  // regression this change is most likely to cause, and it would restore the compounding queue
  // that #343 exists to drain. So re-pin the two categories that MUST still commit.
  ok('  …while a user_error is still committed, so the live replaying queue still drains',
    relaySeen.has(wA.wrap.id) && undelivered().some(r => r.id === wA.wrap.id))
  ok('  …and delivery_unknown is still committed, so a possible duplicate is still not re-sent',
    relaySeen.has(wD.wrap.id))

  if (stub) process.env.WB_STUB_SEND = stub
}

// --- route() dispatches the branch ------------------------------------------
{
  // A real read lane has owner approvers as well as relay ingress. Prove the encrypted control
  // discriminator hands a non-owner seal through without consuming or double-decrypting it.
  PUB.approvers.push(getPublicKey(generateSecretKey()))
  const sk = generateSecretKey(); const { wrap, senderPk } = wrapFor(sk, { body: 'via route' })
  admit(senderPk)
  route(wrap); await tick()
  ok('route() dispatches a waggle-addressed wrap into the relay lane', !!relayPost(delta()))
}

// --- gate: ungranted signer is ACKED ok:false, never posted -----------------
{
  const sk = generateSecretKey(); const { wrap } = wrapFor(sk) // NOT admitted
  handleRelayIngress(wrap); await tick()
  const d = delta()
  ok('ungranted signer → NO channel post', !relayPost(d))
  ok('ungranted signer → still ACKED (refusal is not silent, §5)', !!ack(d))
}

// --- gate: unlisted destination is ACKED ok:false, never posted -------------
{
  const sk = generateSecretKey(); const { wrap, senderPk } = wrapFor(sk, { channel: OTHER })
  admit(senderPk)
  handleRelayIngress(wrap); await tick()
  const d = delta()
  ok('unlisted destination → NO channel post', !relayPost(d))
  ok('unlisted destination → ACKED ok:false', !!ack(d))
}

// --- empty body is rejected (post-auth, acked) ------------------------------
{
  const sk = generateSecretKey(); const { wrap, senderPk } = wrapFor(sk, { body: '' })
  admit(senderPk)
  handleRelayIngress(wrap); await tick()
  const d = delta()
  ok('empty body → NO post, but ACKED', !relayPost(d) && !!ack(d))
}

// --- authorship: rumor claiming a DIFFERENT author than the seal is dropped --
{
  const sk = generateSecretKey(); const other = getPublicKey(generateSecretKey())
  const { wrap } = wrapFor(sk, { rumorPubkey: other }) // seal signed by sk, rumor claims `other`
  admit(getPublicKey(sk)) // admitted — proving the drop is on the BIND, not the gate
  const before = relayDropCounts.mismatch
  handleRelayIngress(wrap); await tick()
  const d = delta()
  ok('rumor.pubkey ≠ seal.pubkey → dropped, NO post, NO ack (pre-auth)', !relayPost(d) && !ack(d))
  ok('  and the mismatch counter incremented', relayDropCounts.mismatch === before + 1)
}

// --- authorship: a tampered seal signature is dropped pre-auth --------------
{
  const sk = generateSecretKey(); const { wrap } = wrapFor(sk, { breakSig: true })
  admit(getPublicKey(sk))
  const before = relayDropCounts.verify
  handleRelayIngress(wrap); await tick()
  ok('bad seal signature → verify drop, NO post/ack', !relayPost(delta()) && relayDropCounts.verify === before + 1)
}

// --- decrypt failure on garbage ciphertext is dropped pre-auth --------------
{
  const wsk = generateSecretKey()
  const junk = finalizeEvent({ kind: 1059, created_at: Math.floor(Date.now() / 1000),
    tags: [['p', bridgePk]], content: 'not-nip44-ciphertext' }, wsk)
  const before = relayDropCounts.decrypt
  handleRelayIngress(junk); await tick()
  ok('undecryptable wrap → decrypt drop, NO post/ack', !relayPost(delta()) && relayDropCounts.decrypt === before + 1)
}

// --- routing discriminator: a well-formed DM to waggle with NO relay tag -----
{
  const sk = generateSecretKey(); const { wrap, senderPk } = wrapFor(sk, { tags: [] }) // kind:14, no relay tag
  admit(senderPk)
  const beforeNR = relayDropCounts.notRelay; const beforeTotal = relayDropTotalPreAuth()
  handleRelayIngress(wrap); await tick()
  const d = delta()
  ok('kind:14 without a relay tag → left silent (real DM), NO post, NO ack', !relayPost(d) && !ack(d))
  ok('  notRelay counter bumped', relayDropCounts.notRelay === beforeNR + 1)
  ok('  but notRelay is EXCLUDED from the pre-auth flood total', relayDropTotalPreAuth() === beforeTotal)
}

// --- §7 hard wrap-size cap drops pre-auth -----------------------------------
{
  const saved = PUB.relayMaxWrapBytes; PUB.relayMaxWrapBytes = 200 // any real wrap exceeds this
  const sk = generateSecretKey(); const { wrap, senderPk } = wrapFor(sk)
  admit(senderPk)
  const before = relayDropCounts.size
  handleRelayIngress(wrap); await tick()
  ok('oversize wrap → size drop before decrypt, NO post', !relayPost(delta()) && relayDropCounts.size === before + 1)
  PUB.relayMaxWrapBytes = saved
}

// --- §7 decrypt budget: exhaustion drops pre-auth and does NOT dedup --------
{
  const saved = PUB.relayDecryptBudget; PUB.relayDecryptBudget = 0 // every attempt is over budget
  const sk = generateSecretKey(); const { wrap, senderPk } = wrapFor(sk)
  admit(senderPk)
  const before = relayDropCounts.budget
  handleRelayIngress(wrap); await tick()
  ok('over decrypt budget → budget drop, NO post', !relayPost(delta()) && relayDropCounts.budget === before + 1)
  ok('  a budget drop does NOT mark the wrap seen (may retry)', !relaySeen.has(wrap.id))
  PUB.relayDecryptBudget = saved
  // and now, budget restored, the same wrap goes through
  handleRelayIngress(wrap); await tick()
  ok('  once budget is restored, the same wrap posts', !!relayPost(delta()))
}

// --- MUST-FIX 2: the per-sender rate cap keys on seal.pubkey and bites -------
{
  const sk = generateSecretKey(); const senderPk = getPublicKey(sk).toLowerCase()
  admit(senderPk)
  let posts = 0, rejects = 0
  // replier_per_min = 5; the 6th distinct wrap from the SAME authenticated sender must be rejected,
  // even though each wrap's outer (ephemeral) key differs — proving the cap keys on seal.pubkey.
  for (let i = 0; i < 6; i++) {
    const { wrap } = wrapFor(sk, { body: `msg ${i}` })
    handleRelayIngress(wrap); await tick()
    const d = delta()
    if (relayPost(d)) posts++
    else if (ack(d)) rejects++
  }
  ok('same-sender cap bites at replier_per_min (5 post, 6th rejected)', posts === 5 && rejects === 1)
}

// --- the two lanes must not share counters (#152) -------------------------------------------
// The relay lane keeps its own three windows precisely so a public-lane flood cannot starve an
// admitted agent, and vice versa. Both lanes read the SAME PUB.* caps, so that independence lives
// entirely in the state being separate — which nothing asserted until now. It became worth stating
// when the two limiters were merged into one factory: the whole point of building it twice is that
// each call owns its counters, and a refactor that accidentally shared them would still pass every
// other check in this file.
// It must be the CHANNEL window that is saturated, not the per-subject one. Filling one subject's
// window and then querying a different subject passes whether or not the lanes share state, so that
// version of this check proves nothing — it was written that way first and the negative control
// caught it by refusing to fail. The channel window is the state both lanes would actually collide
// on, so that is the one to fill.
{
  const nowMs = Date.now()
  const dest = 'shared-channel-uuid'
  // Distinct authors, so the per-replier cap never bites before the per-channel one does.
  let publicAccepted = 0
  for (let i = 0; i < PUB.channelPerMin + 2; i++) {
    const pubkey = String(i).padStart(64, 'c')
    if (rateOk({ id: String(i).padEnd(64, '0'), pubkey }, dest, nowMs)) publicAccepted++
  }
  ok('  public lane saturates its per-channel window', publicAccepted === PUB.channelPerMin)
  // Same channel, relay lane. Independent counters mean this is untouched by the flood above.
  ok('  a saturated public channel does NOT block the relay lane', relayRateOk('d'.repeat(64), dest, nowMs))
}

console.log(fails ? `\n${fails} FAIL` : '\nall passed')
process.exit(fails ? 1 : 0)
