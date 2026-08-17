// console_dm_relays — the agent's INBOX, published from the console (#581).
//
// The step that did not exist. A kind:10050 is the only thing that tells the bridge where sealed
// mail may be delivered; `src/bridge.mjs:3230` has no public-relay fallback by design, so with no
// list the return lane logs `RETURN not sent -> …: no valid kind:10050 recipient DM relay list` and
// drops the message. The agent's symptom is an empty inbox, indistinguishable from no mail. An
// agent was admitted, named, and unreachable for a day on exactly this, while `console/connect.html`
// rendered the gap as "not observable from the console" — a fact a public relay answers in nine
// seconds.
//
// THE PROPERTY THIS SUITE EXISTS FOR, and it is not the one `console_profile` has: a kind:10050's
// content is the EMPTY STRING by construction. Comparing a read-back on content — which is what the
// profile publisher does, correctly, because its community copy has a different id — would match
// every kind:10050 this key ever published, including the stale short list this publish exists to
// replace. So the read-back is BY ID, and the fixture that proves it is a stale event whose content
// is identical and whose tags are not.
//
// Both directions on every guard: each refusal is paired with a case that still gets through. A
// guard asserted only to refuse cannot tell "refuses the dangerous thing" from "refuses everything",
// and that exact shape shipped here once and dropped every message to one recipient.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PUBLIC_RELAYS } from '../src/relays.mjs'
import { MAX_DM_RELAYS as SRC_MAX, normalizeDmRelayList as srcNormalize, safeRelayUrl } from '../src/dm_relays.mjs'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as dm from '../console/dm-relay-publish.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

console.log('\nconsole_dm_relays\n')

const PUB = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

// ------------------------------------------------------------------------------------------
console.log('1. the relay set is the one the BRIDGE reads, not a second list')
// `fetchRecipientDmRelays` (src/bridge.mjs:1609) discovers a kind:10050 on the same read relays it
// discovers a kind:0 on. Publishing the name to one set and the inbox to another is a silent
// partial reachability: the at-word resolves, the mail does not, and neither publish reports a
// problem. The page cannot import ../src/, so the equality is asserted rather than assumed.
check(JSON.stringify(dm.PUBLIC_RELAYS) === JSON.stringify([...DEFAULT_PUBLIC_RELAYS]),
  'console/dm-relay-publish.mjs publishes to exactly src/relays.mjs DEFAULT_PUBLIC_RELAYS')
check(readFileSync(join(ROOT, 'console/dm-relay-publish.mjs'), 'utf8').includes(`from './profile-publish.mjs'`),
  '  …by IMPORTING the name step\'s list rather than declaring a second copy that can drift from it')
check(dm.MAX_DM_RELAYS === SRC_MAX, `and the NIP-17 cap matches src/dm_relays.mjs (${SRC_MAX})`)

// ------------------------------------------------------------------------------------------
console.log('\n2. the console WRITES what the bridge will READ — one fixture table, both copies')
// A publisher that accepts what the reader discards writes an inbox with fewer relays in it than
// the operator was shown, and nothing anywhere says so. Driving both implementations over the same
// inputs is the check; asserting the two sources look alike is not.
const TABLE = [
  ['wss://nos.lol', true, 'an ordinary public relay'],
  ['wss://relay.primal.net/', true, 'a trailing slash, which normalises away'],
  ['ws://nos.lol', false, 'plaintext ws://'],
  ['https://nos.lol', false, 'an http scheme'],
  ['wss://localhost:7777', false, 'localhost'],
  ['wss://box.local', false, 'an mDNS .local name'],
  ['wss://127.0.0.1:7777', false, 'loopback by address'],
  ['wss://10.0.0.4', false, 'RFC1918 10/8'],
  ['wss://192.168.1.9', false, 'RFC1918 192.168/16'],
  ['wss://172.16.0.9', false, 'RFC1918 172.16/12'],
  ['wss://169.254.1.1', false, 'link-local'],
  ['wss://user:pw@nos.lol', false, 'credentials in the URL'],
  ['wss://nos.lol#frag', false, 'a fragment a relay never sees'],
  ['not a url', false, 'not a URL at all'],
  // IPv6 (#584 review). Every row below ACCEPTED before the fix, on both sides: WHATWG
  // `URL.hostname` returns an IPv6 host bracketed, so `host === '::1'` compared against `[::1]`
  // and matched nothing. The old table was 14 rows of IPv4 and hostnames, so deleting the whole
  // IPv6 clause left the suite green — that mutation is what found this.
  ['wss://[::1]', false, 'IPv6 loopback'],
  ['wss://[::1]:7777', false, 'IPv6 loopback with a port'],
  ['wss://[fc00::1]', false, 'IPv6 unique-local, fc00::/7'],
  ['wss://[fd12:3456::1]', false, 'IPv6 unique-local, fd prefix'],
  ['wss://[fe80::1]', false, 'IPv6 link-local, fe80::/10'],
  ['wss://[::ffff:127.0.0.1]', false, 'IPv4-mapped loopback, which normalises to ::ffff:7f00:1'],
  // And the other direction, which the fix could very easily have broken: an arm that refuses
  // everything bracketed, or every name starting with fc/fd, is not a guard — it is an outage.
  ['wss://[2606:4700::1111]', true, 'a public IPv6 relay'],
  ['wss://fd-relay.example.com', true, 'a hostname that merely BEGINS with fd — the old `startsWith` refused this'],
  ['wss://fcrelay.example.com', true, 'a hostname that merely begins with fc'],
]
let agreed = 0, accepted = 0, refused = 0
for (const [value, want, why] of TABLE) {
  const consoleSays = dm.refuseReason(value) === null
  const srcSays = safeRelayUrl(value) !== null
  if (consoleSays === want && srcSays === want) agreed++
  else check(false, `  the two copies disagree, or disagree with the intent, on ${why}: console=${consoleSays} src=${srcSays} want=${want}`)
  if (want) accepted++; else refused++
}
check(agreed === TABLE.length, `console and src agree on all ${TABLE.length} inputs`)
// BOTH DIRECTIONS, stated as counts so a table that drifted to all-refusals cannot pass.
check(accepted >= 2 && refused >= 10,
  `  …and the table exercises both directions (${accepted} accepted, ${refused} refused) — a guard only ever asserted to refuse cannot tell "refuses the dangerous thing" from "refuses everything"`)
check(JSON.stringify(dm.normalizeDmRelayList(TABLE.map(t => t[0]))) ===
      JSON.stringify(srcNormalize(TABLE.map(t => t[0]))),
  'and the whole list normalises identically through both implementations')

// ------------------------------------------------------------------------------------------
console.log('\n3. a refusal states its REASON, because the reason is the actionable part')
// `!ok` cannot distinguish a correct refusal from a correct refusal with a misleading explanation.
// An operator told only "invalid" about wss://localhost:7777 hunts for a typo in a URL that has
// none. This repo has paid for that: a guard once sent someone looking for an invisible character
// in a message whose fault was a visible extra line, and every assertion still passed.
const localReason = dm.refuseReason('wss://localhost:7777')
check(/deliver/i.test(localReason) && /local/i.test(localReason),
  'a local address is refused BECAUSE other machines deliver to this list, not merely "invalid"')
const wsReason = dm.refuseReason('ws://nos.lol')
check(/wss/i.test(wsReason) && !/local/i.test(wsReason),
  'and a plaintext relay gets a DIFFERENT reason — two faults, two messages, or the operator guesses which')
check(new Set(TABLE.filter(t => !t[1]).map(t => dm.refuseReason(t[0]))).size >= 5,
  '  …across the refusal table, at least five distinct reasons rather than one string reused')
check(dm.refuseReason('wss://nos.lol') === null,
  'and a good relay is refused for NO reason — the null case, so the reasons above are not universal')

// ------------------------------------------------------------------------------------------
console.log('\n4. nothing is dropped silently — planDmRelays names every casualty')
const plan = dm.planDmRelays(['wss://nos.lol', 'ws://nos.lol', '  ', 'wss://10.0.0.4'])
check(plan.relays.length === 1 && plan.relays[0] === 'wss://nos.lol', 'the good one survives')
check(plan.refused.length === 2, '  …and BOTH bad ones are reported, not just the first')
check(plan.refused.every(r => r.value && r.why), '  …each with the value the operator typed and why it went')
check(!plan.refused.some(r => r.value === ''), 'an empty field between two commas is not reported as a casualty — it is not one')
// Over-cap is the drop that reads most like nothing happened: nine valid relays in, eight out, no
// error anywhere. NIP-17's cap is real and the operator has to be told which one did not make it.
const nine = Array.from({ length: 9 }, (_, i) => `wss://r${i}.example.com`)
const capped = dm.planDmRelays(nine)
check(capped.relays.length === MAXED(), `nine valid relays publish ${MAXED()} — the NIP-17 cap`)
check(capped.refused.length === 1 && /cap/i.test(capped.refused[0].why),
  '  …and the ninth is named with the cap as its reason, instead of vanishing')
// `/cap/i` passes on a sentence that contradicts itself, which is what shipped: the reason said
// "only the first 8 are published" while the handler returns before publishing anything, and it
// dropped the one actionable fact — WHICH url fell off the end (#584 review).
check(capped.refused[0].why.includes('wss://r8.example.com'),
  '  …and the reason names the URL, like every other reason here — it is the only actionable part')
check(!/ are published/.test(capped.refused[0].why) && / would be published/.test(capped.refused[0].why),
  '  …in the conditional, because a refusal publishes nothing: the old wording contradicted the sentence it was rendered inside')
const capPage = readFileSync(join(ROOT, 'console/index.html'), 'utf8')
check(!/plan\.relays\.length \? ` Fix or remove/.test(capPage) && /nothing has been published yet/.test(capPage),
  '  …and the page states "nothing has been published yet" unconditionally, because the `return` under it is unconditional')
function MAXED() { return dm.MAX_DM_RELAYS }
// Duplicates: same relay twice is not a casualty the operator needs told about, but it must not
// consume a cap slot either.
const dupes = dm.planDmRelays(['wss://nos.lol', 'wss://nos.lol/', 'wss://relay.ditto.pub'])
check(dupes.relays.length === 2, 'a relay listed twice publishes once')

// ------------------------------------------------------------------------------------------
console.log('\n5. an empty list is REFUSED, and this is the guard that matters most')
// A kind:10050 is REPLACEABLE. Publishing one with no relay tags does not fail to help — it
// supersedes a working list and tells the bridge the agent is not ready to receive. That is a
// working inbox turned off by a step that reported success.
let threw = null
try { dm.dmRelayListTemplate({ relays: [] }) } catch (e) { threw = e.message }
check(threw !== null, 'an empty relay list throws rather than building a kind:10050')
check(/replace/i.test(threw), '  …and says WHY: it replaces any working list this key already has')
// Not just empty — a list of only-refused relays reaches the same place by a different road, and
// that is the one an operator actually types.
let threwAllBad = null
try { dm.dmRelayListTemplate({ relays: ['wss://localhost:1', 'ws://x.example.com'] }) } catch (e) { threwAllBad = e.message }
check(threwAllBad !== null, 'and so does a list whose every entry was refused — the shape an operator actually produces')
// BOTH DIRECTIONS: it still builds a real event for a real list, or the guard above proves nothing.
const tmpl = dm.dmRelayListTemplate({ relays: ['wss://nos.lol', 'wss://relay.ditto.pub'], now: 1_700_000_000 })
check(tmpl.kind === 10050 && tmpl.content === '' && tmpl.created_at === 1_700_000_000,
  'a valid list builds a kind:10050 with empty content')
check(JSON.stringify(tmpl.tags) === JSON.stringify([['relay', 'wss://nos.lol'], ['relay', 'wss://relay.ditto.pub']]),
  '  …carrying one relay tag per relay, in the order given')

// ------------------------------------------------------------------------------------------
console.log('\n6. what is already published is read before it is replaced')
const ev = (tags, created_at, id, pubkey = PUB) => JSON.parse(JSON.stringify({
  kind: 10050, pubkey, created_at, id, content: '', tags: tags.map(u => ['relay', u]),
}))
// These fixtures carry no real signature, so verification is stubbed OPEN for this section — the
// rules under test here are author, kind and recency. Section 6b drives the verification itself
// with genuinely signed events, and asserts it is ON by default.
const OPEN = { verify: () => true }
check(dm.currentDmRelays([], PUB, OPEN).length === 0, 'no events means no inbox — not a fallback')
check(JSON.stringify(dm.currentDmRelays([ev(['wss://nos.lol'], 100, '1')], PUB, OPEN)) === '["wss://nos.lol"]',
  'one event yields its relays')
check(JSON.stringify(dm.currentDmRelays([ev(['wss://nos.lol'], 100, '1'), ev(['wss://relay.ditto.pub'], 200, '2')], PUB, OPEN)) === '["wss://relay.ditto.pub"]',
  'the NEWEST wins, so the console shows what the bridge would use')
check(dm.currentDmRelays([ev(['wss://nos.lol'], 100, '1', OTHER)], PUB, OPEN).length === 0,
  'and another key\'s list is not this key\'s inbox — the negative control on the author filter')
// Same timestamp, different lists: "whichever arrived first" would make the console and the bridge
// disagree about the same key, on the same data.
const tie = [ev(['wss://nos.lol'], 100, 'aa'), ev(['wss://relay.ditto.pub'], 100, 'bb')]
check(JSON.stringify(dm.currentDmRelays(tie, PUB, OPEN)) === JSON.stringify(dm.currentDmRelays([...tie].reverse(), PUB, OPEN)),
  'a timestamp tie resolves the same way whatever order the relays answered in')

// ------------------------------------------------------------------------------------------
console.log('\n6b. the prefill is SIGNATURE-VERIFIED, and the default action re-signs it')
// `currentDmRelays` prefills the publish field, and the default action signs that value under the
// agent's real key through the bunker. Filtering on kind/pubkey/tags alone let a relay serving a
// FORGED kind:10050 — anyone can put any pubkey in an event — choose what the operator would sign.
// `refuseReason` still applies to every entry, so it cannot be pointed at loopback; it can be
// pointed at a relay the attacker chose, which is silent delivery denial. That is the
// empty-inbox-indistinguishable-from-no-mail failure this page exists to end, reintroduced through
// the fix (#584 review). `src/dm_relays.mjs:42` has always verified.
//
// Fixtures are built through JSON on purpose: `verifyEvent` memoises its result on a symbol
// property, so a spread-copied forgery inherits the original's TRUE and the test proves nothing.
const SK = generateSecretKey()
const REAL_PUB = getPublicKey(SK)
const signedList = (urls, created_at) => JSON.parse(JSON.stringify(
  finalizeEvent({ kind: 10050, created_at, content: '', tags: urls.map(u => ['relay', u]) }, SK)))
const honest = signedList(['wss://nos.lol'], 1_700_000_000)
// Same author field, later timestamp, different relays — and a signature that does not verify.
const forged = JSON.parse(JSON.stringify({ ...honest, created_at: 1_800_000_000, tags: [['relay', 'wss://attacker.example.com']] }))
check(dm.currentDmRelays([forged], REAL_PUB).length === 0,
  'a forged kind:10050 carrying this key\'s pubkey prefills NOTHING')
check(JSON.stringify(dm.currentDmRelays([honest], REAL_PUB)) === '["wss://nos.lol"]',
  'BOTH DIRECTIONS: a genuinely signed list still gets through — a verification that refuses everything is an outage, not a guard')
check(JSON.stringify(dm.currentDmRelays([honest, forged], REAL_PUB)) === '["wss://nos.lol"]',
  '  …and the forgery does not win on recency, which is the whole attack: it is NEWER and still ignored')
check(dm.currentDmRelays([honest], REAL_PUB, { verify: () => false }).length === 0,
  'CONTROL on the injection point: a verify that always fails empties the result, so `verify` is genuinely consulted')
// NEGATIVE CONTROL on the fixture itself. If `forged` verified TRUE the assertions above would pass
// for the wrong reason, and the memoisation trap above is exactly how that happens.
check(honest.sig !== forged.sig || JSON.stringify(honest.tags) !== JSON.stringify(forged.tags),
  '  …and the forgery really is a different event from the honest one')
check(dm.newestCreatedAt([honest, forged], REAL_PUB) === 1_700_000_000,
  'newestCreatedAt ignores the forgery too — an unverified maximum would push our own created_at years forward and wedge the key permanently')
check(dm.newestCreatedAt([], REAL_PUB) === null, '  …and no events means no floor, not zero')

// ------------------------------------------------------------------------------------------
console.log('\n6c. created_at is bumped past the list being replaced')
// kind:10050 is REPLACEABLE and NIP-01 breaks a `created_at` tie by lowest id. So a same-second
// retry — exactly what an operator does after reading "not proven" — was not guaranteed to replace,
// and a clock-skewed future-dated stale list was a permanent wedge whose symptom this page blamed
// on the relays (#584 review).
const same = dm.dmRelayListTemplate({ relays: ['wss://nos.lol'], now: 1_700_000_000, supersedes: 1_700_000_000 })
check(same.created_at === 1_700_000_001, 'a same-second retry lands one second LATER, so it actually replaces')
const future = dm.dmRelayListTemplate({ relays: ['wss://nos.lol'], now: 1_700_000_000, supersedes: 1_900_000_000 })
check(future.created_at === 1_900_000_001, 'and a future-dated stale list is superseded rather than being a permanent wedge')
const past = dm.dmRelayListTemplate({ relays: ['wss://nos.lol'], now: 1_700_000_000, supersedes: 1_600_000_000 })
check(past.created_at === 1_700_000_000, 'an older list does not drag the new one backwards — max(now, seen + 1), not seen + 1')
check(dm.dmRelayListTemplate({ relays: ['wss://nos.lol'], now: 1_700_000_000 }).created_at === 1_700_000_000,
  'NEGATIVE CONTROL: with no supersedes the timestamp is the bare clock — which is the defect, and is why the parameter has to be wired at the call site')
const wired = readFileSync(join(ROOT, 'console/index.html'), 'utf8')
check(/dmRelayListTemplate\(\{ relays: plan\.relays, supersedes: inboxSupersedes \}\)/.test(wired),
  '  …and the page passes it — a parameter nothing supplies is a fix nobody gets')
check(/inboxSupersedes = newestCreatedAt\(/.test(wired),
  '  …from the pre-read it already performs, so no extra round trip')

// ------------------------------------------------------------------------------------------
console.log('\n7. the read-back is BY ID — and a content comparison would pass on the stale list')
// This is the assertion the module exists for. Fake relays, so the socket path is real code and the
// network is not involved.
const signed = { ...tmpl, pubkey: PUB, id: 'newid', sig: 'x' }
const stale = ev(['wss://nos.lol'], 1_600_000_000, 'oldid')

class FakeWS {
  static serve = new Map() // url -> event served on REQ, or null
  static accept = new Set()
  constructor(url) {
    this.url = url
    setTimeout(() => this.onopen?.(), 0)
  }
  send(raw) {
    const msg = JSON.parse(raw)
    const emit = m => setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 0)
    if (msg[0] === 'EVENT') emit(['OK', msg[1].id, FakeWS.accept.has(this.url), FakeWS.accept.has(this.url) ? '' : 'no'])
    if (msg[0] === 'REQ') {
      // A LIST, not one event. `limit: 5` is in the real REQ because a relay may hold more than one
      // kind:10050 for a key, and a fake that can only ever serve one cannot exercise that (#584).
      const served = FakeWS.serve.get(this.url)
      for (const e of (Array.isArray(served) ? served : (served ? [served] : []))) emit(['EVENT', msg[1], e])
      emit(['EOSE', msg[1]])
    }
  }
  close() {}
}

const RELAYS = ['wss://one.example.com', 'wss://two.example.com']
FakeWS.accept = new Set(RELAYS)
// One relay serves the event we just pushed. The other serves the STALE list — same author, same
// kind, same (empty) content, older timestamp, different tags. A content comparison counts it as
// confirmation; an id comparison does not.
FakeWS.serve = new Map([[RELAYS[0], signed], [RELAYS[1], stale]])
const out = await dm.publishDmRelays(signed, { relays: RELAYS, WS: FakeWS, timeoutMs: 500 })
check(out.pushed === 2, 'both relays said OK')
check(out.proven === 1, '  …and exactly one PROVED it — the other served a different event')
check(out.servedBy.length === 1 && out.servedBy[0] === RELAYS[0], '  …named, so "which one is missing" is answerable')
check(stale.content === signed.content,
  'CONTROL: the stale event\'s content is IDENTICAL to the new one — a content comparison would have counted it')
check(stale.id !== signed.id && JSON.stringify(stale.tags) !== JSON.stringify(signed.tags),
  '  …and its tags differ, which is the whole difference the id carries and the content cannot')

// The case that reads best and means least: every relay accepts, none serves it back.
FakeWS.serve = new Map()
const dropped = await dm.publishDmRelays(signed, { relays: RELAYS, WS: FakeWS, timeoutMs: 500 })
check(dropped.pushed === 2 && dropped.proven === 0, 'accept-and-drop: two OKs, nothing proven')
check(dropped.answered === 2, '  …and both relays ANSWERED, so this is a real negative and not a reachability failure')

// NEGATIVE CONTROL on the probe itself. A relay that never answers must not be counted as a relay
// that answered and served nothing — those are different facts and only one of them is evidence.
class DeadWS { constructor() { /* never opens, never answers */ } close() {} }
const silent = await dm.publishDmRelays(signed, { relays: RELAYS, WS: DeadWS, timeoutMs: 60 })
check(silent.proven === 0 && silent.answered === 0,
  'NEGATIVE CONTROL: relays that never answer prove nothing AND are not counted as having answered')

// THE SELECTION INSIDE THE PROBE, which the design above does not settle (#584 review). `proven`
// compared against the relay's NEWEST served event, inherited from `profile-publish.mjs` where a
// content comparison made newest-only harmless. Here it means a relay that DID serve our event
// reports 0 whenever it also holds anything newer — and something newer is precisely the
// future-dated stale list this page exists to replace. Wrong in the direction that sends the
// operator at the relays when the fault is their own key's list.
const futureStale = ev(['wss://old.example.com'], Number(signed.created_at) + 10_000, 'futureid')
check(futureStale.created_at > signed.created_at,
  'PRECONDITION: the extra event really is newer than ours, or this arm passes by not being the case it describes')
FakeWS.serve = new Map([[RELAYS[0], [signed]], [RELAYS[1], [signed, futureStale]]])
const both = await dm.publishDmRelays(signed, { relays: RELAYS, WS: FakeWS, timeoutMs: 500 })
check(both.proven === 2,
  'a relay that serves our event ALONGSIDE a newer one still proves it — the id is in the response either way')
check(both.servedBy.length === 2, '  …and both are named')
// Both directions. If `some` had been written as "anything served counts", this passes for the
// wrong reason and the module's whole thesis is gone.
FakeWS.serve = new Map([[RELAYS[0], [futureStale]], [RELAYS[1], [futureStale]]])
const wrongOnly = await dm.publishDmRelays(signed, { relays: RELAYS, WS: FakeWS, timeoutMs: 500 })
check(wrongOnly.proven === 0,
  'and a relay serving ONLY a different event proves nothing — read-back is by id, not by "it answered with something"')

// ------------------------------------------------------------------------------------------
console.log('\n8. the verdict says what was PROVEN, separately from what was accepted')
const vGood = dm.inboxVerdict({ pub: out })
check(vGood.proven === true && /1 of 2/.test(vGood.text), 'a proven publish reports proven, with the count')
check(/single-relay/.test(vGood.text), '  …and a one-relay inbox is called out — it works until it does not, and then the symptom is an empty inbox')
const vDrop = dm.inboxVerdict({ pub: dropped })
check(vDrop.proven === false, 'accept-and-drop is NOT proven')
check(/accept and drop/i.test(vDrop.text) && /not published/i.test(vDrop.text),
  '  …and the sentence says so, instead of counting the two OKs')
const vSilent = dm.inboxVerdict({ pub: silent })
check(vSilent.proven === false && /reachability/i.test(vSilent.text),
  'and "nobody answered" is reported as a reachability problem, not as a refusal — different fix entirely')
check(vDrop.text !== vSilent.text, '  …so the three outcomes produce three different sentences')

// ------------------------------------------------------------------------------------------
console.log('\n9. the page wires it, and gates it on a PROVEN name')
const page = readFileSync(join(ROOT, 'console/index.html'), 'utf8')
check(/from '\.\/dm-relay-publish\.mjs'/.test(page), 'index.html imports the publisher rather than assembling a kind:10050 inline')
check(/id="inbox-go"/.test(page) && /id="inbox-relays"/.test(page), 'and the inbox step exists on the page')
check(/if \(v\.proven\) await openInbox\(\)/.test(page),
  'the inbox opens on a PROVEN name — every step here can report success and leave the agent unreachable, which is what happened')
check(/\$\('inbox-relays'\)\.value = ''/.test(page),
  'and the field resets with the rest of the flow — a list left from the previous identity would be published under the next key')

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
