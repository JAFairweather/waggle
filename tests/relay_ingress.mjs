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
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.FORWARD_MODE = 'buzz'
process.env.WB_STUB_SEND = '1'
process.env.WB_NO_BOOT = '1'

const bridge = await import('../src/bridge.mjs')
const { handleRelayIngress, route, grantSet, relaySeen, addRelaySeen, dropRelaySeen, relayDropCounts, relayDropTotalPreAuth, resolveRelayDest, rateOk, relayRateOk, PUB } = bridge

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
  return { wrap, senderPk: senderPk.toLowerCase() }
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
  // dedup-before-decrypt: replaying the SAME wrap does nothing
  handleRelayIngress(wrap); await tick()
  ok('replaying the same wrap carries nothing new (§6 dedup)', delta().length === 0)
}

// --- the claim/rollback primitive that makes concurrent delivery safe ----------------------
// HONEST SCOPE: this suite CANNOT reproduce the concurrency itself. Under WB_STUB_SEND the stub
// branch marks synchronously — there is no async window — while the bug lives in the execFile
// callback. A "two relays deliver at once" test written here passes with OR without the fix, so
// it would be a check that has only ever passed. What IS testable is the primitive: a claim taken
// at dispatch suppresses a re-entry, and a rollback restores retryability. The concurrency proof
// is the live run (one wrap must produce exactly one channel post), not this file.
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

// --- route() dispatches the branch ------------------------------------------
{
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
