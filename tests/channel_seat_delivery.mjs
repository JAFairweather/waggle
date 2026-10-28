// channel_seat_delivery — carrying a signed seat intent from the console to the broker (#502).
//
// #488 built both ends and nothing in between: the console could sign a seat, the broker's forced
// command could apply one, and what moved the intent from one to the other was an operator running
// `ssh` by hand. That is manual step two of a flow that is allowed exactly one.
//
// Three properties carry this, and each is asserted in BOTH directions, because a gate that only
// ever refuses cannot be told from a gate that refuses everything:
//
//   1. THE BRIDGE IS A WIRE, NOT A SECOND APPROVER. What goes down the pipe is the signed event,
//      byte for byte. The broker verifies the same signature against its own roster, so a bridge
//      that could rewrite the intent would be an authority nobody granted.
//   2. UNKNOWN IS NOT REFUSED. A transport that failed, a receipt that would not parse, and a
//      receipt for somebody else's key are three facts, and none of them is "the broker said no".
//      Reporting any of them as a refusal sends an operator to re-mint a key that is fine.
//   3. THE CONSOLE AND THE BRIDGE AGREE ON THE WIRE. Key order, the `d` tag, and what counts as an
//      ssh public key are each declared in two places that cannot import each other. Every one of
//      those pairs is compared here against the real function, not asserted as a claim.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { canonicalJson } from '../src/buzz_policy_core.mjs'
import { SEAT_OP, SEAT_VERSION, keyFingerprint, parseSeatIntent, seatReceipt, seatDecision } from '../src/channel_seat.mjs'
import { SEAT_COMMAND_D } from '../src/channel_seat_runner.mjs'
import { readSeatReceipt, seatIntentToForward, seatLogLine } from '../src/channel_seat_delivery.mjs'
import { SEAT_D, LIFECYCLE_D, canonical as consoleCanonical, draftBridgeCommand, bridgeVerdict } from '../console/hive-bridge.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

console.log('\nchannel_seat_delivery\n')

const NOW = 1_800_000_000
const AGENT = 'a'.repeat(64)
const OTHER_AGENT = 'b'.repeat(64)

// A REAL key, minted the way connect-agent mints one. Every fixture below is this key, so a shape
// check that passes here has passed against something ssh-keygen actually produced rather than
// against this file's idea of what one looks like.
const tmp = mkdtempSync(join(tmpdir(), 'waggle-seatd-'))
execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'nvoy-mcp-channel test', '-f', join(tmp, 'id_ed25519')], { stdio: 'ignore' })
const KEY = readFileSync(join(tmp, 'id_ed25519.pub'), 'utf8').trim()
execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'other', '-f', join(tmp, 'other')], { stdio: 'ignore' })
const OTHER_KEY = readFileSync(join(tmp, 'other.pub'), 'utf8').trim()

const approverSk = generateSecretKey()
const APPROVER = getPublicKey(approverSk)
const strangerSk = generateSecretKey()
const STRANGER = getPublicKey(strangerSk)
const bridgeSk = generateSecretKey()
const BRIDGE = getPublicKey(bridgeSk)

const body = (over = {}) => ({ v: SEAT_VERSION, op: SEAT_OP, agent: AGENT, key: KEY, ...over })
const sign = (sk, content, { d = SEAT_COMMAND_D, p = BRIDGE, at = NOW, tags = null } = {}) =>
  finalizeEvent({ kind: 30078, created_at: at, tags: tags || [['d', d], ['p', p]],
    content: typeof content === 'string' ? content : canonicalJson(content) }, sk)
const opts = (over = {}) => ({ approvers: [APPROVER], bridgePubkey: BRIDGE, commandD: SEAT_COMMAND_D, now: NOW, ...over })

// ---------------------------------------------------------------------------------------------
console.log('§1 what may be forwarded')

const good = seatIntentToForward(sign(approverSk, body()), opts())
check(good.ok === true, 'an approver-signed, canonical, bridge-addressed seat intent is forwarded')
check(good.intent?.agent === AGENT, '  …and the parsed agent is carried through for the log and the receipt bind')
check(good.fingerprint === keyFingerprint(good.intent.keyBlob), '  …with the fingerprint the receipt will be checked against')

// The fingerprint is compared by an operator against ssh-keygen's own output, so it is compared
// against ssh-keygen's own output here.
const sshFp = execFileSync('ssh-keygen', ['-lf', join(tmp, 'id_ed25519.pub')], { encoding: 'utf8' }).split(/\s+/)[1]
check(good.fingerprint === sshFp, `  …and that fingerprint is byte-identical to \`ssh-keygen -lf\` (${sshFp.slice(0, 20)}…)`)

const refusals = [
  ['a stranger is not an approver', sign(strangerSk, body()), opts(), 'author is not an approver'],
  ['an approver on ANOTHER bridge is refused here', sign(approverSk, body(), { p: OTHER_AGENT }), opts(), 'not addressed to this bridge'],
  ['the moderation tag does not reach the seat lane', sign(approverSk, body(), { d: 'waggle-moderation' }), opts(), 'not addressed to this bridge'],
  ['a third tag is refused rather than read past', sign(approverSk, body(), { tags: [['d', SEAT_COMMAND_D], ['p', BRIDGE], ['x', 'y']] }), opts(), 'not addressed to this bridge'],
  ['a stale command is refused', sign(approverSk, body(), { at: NOW - 1000 }), opts(), 'stale command'],
  ['content that is not JSON is refused', sign(approverSk, 'not json'), opts(), 'invalid body'],
  ['content that is equivalent but not canonical is refused', sign(approverSk, JSON.stringify(body())), opts(), 'intent content is not canonical JSON'],
  ['an options prefix in the key is refused', sign(approverSk, body({ key: `restrict,command="/bin/sh" ${KEY}` })), opts(), 'options come from the broker'],
  ['a second line in the key is refused by name', sign(approverSk, body({ key: `${KEY}\nssh-ed25519 AAAAC3Nz` })), opts(), 'would seat a second, unbounded entry'],
  ['an extra body field is refused, not ignored', sign(approverSk, body({ options: 'restrict' })), opts(), 'invalid seat intent'],
  ['no configured seat tag means nothing is forwarded', sign(approverSk, body()), opts({ commandD: '' }), 'no seat command tag configured'],
  ['no bridge identity means nothing is forwarded', sign(approverSk, body()), opts({ bridgePubkey: '' }), 'no bridge identity to address'],
]
for (const [what, ev, o, reason] of refusals) {
  const r = seatIntentToForward(ev, o)
  check(r.ok === false && String(r.reason).includes(reason), `${what} — "${reason}"`)
}

// A future-dated command and an old one are DIFFERENT diagnoses. Reporting a signer whose clock is
// ahead as "stale" sends an operator hunting for a delay that is not there.
const future = seatIntentToForward(sign(approverSk, body(), { at: NOW + 4000 }), opts())
check(future.ok === false && /future/.test(future.reason) && !/stale/.test(future.reason),
  'a future-dated command says FUTURE, not stale — two clocks, two diagnoses')

// POSITIVE CONTROLS for the boundaries above. A window that rejects everything and a window that is
// correctly sized fail identically when only the rejections are asserted.
check(seatIntentToForward(sign(approverSk, body(), { at: NOW - 800 }), opts()).ok === true,
  '  …and a command 800s old is still INSIDE the 900s window — the clamp is a window, not a wall')
check(seatIntentToForward(sign(approverSk, body(), { at: NOW + 120 }), opts()).ok === true,
  '  …and 120s of forward skew is tolerated')
check(seatIntentToForward(sign(approverSk, body()), opts({ approvers: [STRANGER, APPROVER] })).ok === true,
  '  …and an approver who is second in the roster is still an approver')
check(seatIntentToForward(sign(approverSk, body({ key: OTHER_KEY })), opts()).ok === true,
  '  …and a DIFFERENT real ed25519 key is forwarded — the shape check reads the key, it is not a constant')
check(seatIntentToForward(sign(approverSk, body({ agent: OTHER_AGENT })), opts()).ok === true,
  '  …and a different agent is forwarded — nothing here is pinned to one identity')

// The bridge does not verify the signature inside this function — `handleChannelSeatCommand` does,
// before calling it. Stated as an assertion so the split is deliberate rather than an omission a
// reader has to infer: what this function decides is whether spending an ssh call is warranted.
const forged = { ...sign(approverSk, body()), content: canonicalJson(body({ agent: OTHER_AGENT })) }
check(seatIntentToForward(forged, opts()).ok === true,
  'a tampered event still passes THIS function — signature verification is the caller\'s job, and it does it first')
check(/verifyEvent\(ev\)/.test(readFileSync(join(ROOT, 'src/bridge.mjs'), 'utf8').split('async function handleChannelSeatCommand')[1].slice(0, 900)),
  '  …and handleChannelSeatCommand verifies the signature before it forwards anything')

// ---------------------------------------------------------------------------------------------
console.log('\n§2 what the broker is allowed to make the bridge believe')

const receiptFor = (result, over = {}) => canonicalJson({
  ...seatReceipt(good.intent, seatDecision(good.intent, result === 'seated' ? '' : '', { command: '/opt/b/channel', instance: 'pi' }),
    { instance: 'pi', at: NOW }),
  result, ...over,
})

// THE PRODUCER AND THE READER, HELD TOGETHER. `seatReceipt` lives in channel_seat.mjs and
// RECEIPT_KEYS lives here, so a field added to one and not the other merges with no conflict and
// turns every honest receipt into "not the shape this bridge understands". That happened: #488's
// `unreadable` landed upstream and 14 checks here went red. They went red because this key set is
// load-bearing, which is the reason to bind it rather than restate it.
check(Object.keys(JSON.parse(receiptFor('seated'))).sort().join(',') === 'agent,at,fingerprint,instance,op,reason,result,unreadable,v',
  'the reader\'s pinned key set is exactly what seatReceipt produces — drift between the two files is a red suite, not a silent INCONCLUSIVE')

for (const [result, seated] of [['seated', true], ['already-seated', true], ['conflict', false], ['refused', false]]) {
  const r = readSeatReceipt(receiptFor(result), good)
  check(r.ok === true && r.terminal === true && r.seated === seated && r.result === result,
    `a ${result} receipt is terminal, and seated=${seated}`)
}

const unknowns = [
  ['nothing on stdout', '', 'returned nothing'],
  ['whitespace only', '   \n  ', 'returned nothing'],
  ['not JSON at all', 'ssh: connect to host port 22: Connection refused', 'did not return a receipt'],
  ['a JSON array', '[]', 'did not return a receipt'],
  ['a receipt missing a field', canonicalJson({ v: 1, op: SEAT_OP, result: 'seated' }), 'not the shape this bridge understands'],
  ['a receipt with an extra field', receiptFor('seated', { extra: 1 }), 'not the shape this bridge understands'],
  ['a receipt for another verb', receiptFor('seated').replace(SEAT_OP, 'policy_write'), 'not a channel_seat receipt'],
  ['an outcome word nobody defined', receiptFor('probably'), 'names no outcome this bridge understands'],
  ['a receipt answering for a different agent', receiptFor('seated', { agent: OTHER_AGENT }), 'a different agent'],
  ['a receipt seating a different key', receiptFor('seated', { fingerprint: keyFingerprint(parseSeatIntent(body({ key: OTHER_KEY })).keyBlob) }), 'INCONCLUSIVE'],
  ['a megabyte of stdout', 'x'.repeat(9000), 'more than a receipt'],
]
for (const [what, stdout, reason] of unknowns) {
  const r = readSeatReceipt(stdout, good)
  check(r.ok === false && r.terminal === false && String(r.reason).includes(reason), `${what} → UNKNOWN — "${reason}"`)
}

// THE PROPERTY, not the mechanism: no input to this function may produce a refusal that the broker
// did not itself return. Asserted over every unknown above at once, because the failure mode is one
// new branch quietly returning terminal.
check(unknowns.every(([, stdout]) => readSeatReceipt(stdout, good).terminal !== true),
  'NO unreadable answer is ever terminal — "we could not ask" never becomes "the answer was no"')
check(readSeatReceipt(receiptFor('refused'), good).terminal === true,
  '  …while a receipt that really does say refused IS terminal — the two are distinguishable')

// A refusal may legitimately carry no fingerprint: the broker can refuse before it has a key to
// fingerprint. Only a receipt claiming an outcome ON a key has to name the right one.
check(readSeatReceipt(receiptFor('refused', { fingerprint: null }), good).ok === true,
  'a refusal with no fingerprint is still readable — the broker refused before it had a key to name')

// AND THE OTHER HALF, which the prose above claimed and this suite did not check. The exemption was
// written against every falsy fingerprint, so a receipt claiming a SEAT and naming no key came back
// terminal and seated — a completed seat on nothing, with the watermark advanced behind it. Both
// results that mean "a key is in place now" are asserted; only `refused` gets the exemption.
for (const claim of ['seated', 'already-seated']) {
  const v = readSeatReceipt(receiptFor(claim, { fingerprint: null }), good)
  check(v.ok === false && v.terminal !== true && v.seated !== true,
    `a receipt claiming ${claim} and naming NO key is INCONCLUSIVE — not a completed seat on nothing`)
  check(/names no key/.test(String(v.reason || '')),
    `  …and it says why — !ok cannot tell a correct refusal from one with a misleading reason (${claim})`)
}
// The pairing. A seat that DOES name its key is still terminal, or the guard above would read as
// correct while refusing every real seat this bridge will ever make.
check(readSeatReceipt(receiptFor('seated'), good).terminal === true,
  'a seat that names its key is still terminal — the guard narrows the claim, it does not close the lane')

// ---------------------------------------------------------------------------------------------
console.log('\n§3 the line somebody reads at 2am')

const okLine = seatLogLine(readSeatReceipt(receiptFor('seated'), good), { agent: AGENT, approver: APPROVER, eventId: 'f'.repeat(64) })
const unLine = seatLogLine(readSeatReceipt('', good), { agent: AGENT, approver: APPROVER, eventId: 'f'.repeat(64) })
const noLine = seatLogLine(readSeatReceipt(receiptFor('refused'), good), { agent: AGENT })
check(/seated/.test(okLine) && !/UNKNOWN/.test(okLine), 'a seat logs as seated')
check(/UNKNOWN/.test(unLine) && !/refused/.test(unLine), 'an unreachable broker logs UNKNOWN, and never the word refused')
check(/refused/.test(noLine) && !/UNKNOWN/.test(noLine), 'a real refusal logs refused, and never UNKNOWN')
check(okLine.includes(AGENT.slice(0, 12)) && okLine.includes(APPROVER.slice(0, 12)),
  'the line names both the agent and the approver who asked — a seat is attributable')
check(!okLine.includes(KEY.split(' ')[1]) && !unLine.includes(KEY.split(' ')[1]),
  'no log line carries the key blob — a fingerprint is what a person compares, and it is shorter')

// ---------------------------------------------------------------------------------------------
console.log('\n§4 the console signs what this bridge reads')
//
// console/ is served to a browser and src/ is Node; they cannot import each other, so the wire
// format is declared twice. Each pair is compared against the REAL function here — a divergence has
// to be a failing suite, because in production it is a command that publishes fine and is then
// refused somewhere the operator cannot see.

// The hive page drafts the seat (#613 M4c). Its drafting module is importable, so everything below
// calls the real function rather than lifting literals out of a page.
const draftSeat = k => { try { return draftBridgeCommand({ bridge: BRIDGE, agent: AGENT, op: 'channel_seat', extra: { key: k }, now: NOW }) } catch (e) { return e } }

check(SEAT_D === SEAT_COMMAND_D, `the console's SEAT_D is the tag the broker filters on ("${SEAT_COMMAND_D}")`)
check(LIFECYCLE_D === 'waggle-agent-lifecycle' && LIFECYCLE_D !== SEAT_D, '  …and the lifecycle lane keeps its own, separate tag')
const drafted = draftSeat(KEY)
check(drafted.tags?.[0]?.[1] === SEAT_D && drafted.tags?.[1]?.[1] === BRIDGE, 'a seat is drafted on SEAT_D, addressed to the bridge, not on the lifecycle lane')
check(JSON.stringify(Object.keys(JSON.parse(drafted.content))) === '["agent","key","op","v"]', '  …and carries exactly agent, key, op and v: no label, no options')

// KEY ORDER. The bridge compares content bytes against canonicalJson, so an object literal spread in
// the wrong order publishes a command that is refused at the far end for a reason nobody can see.
check(drafted.content === canonicalJson(body()), "the console's draft is byte-identical to canonicalJson")
check(seatIntentToForward(sign(approverSk, drafted.content), opts()).ok === true,
  '  …and an event carrying exactly those bytes is forwarded — the round trip is closed, not asserted')
// NEGATIVE CONTROL for that claim: the pre-#502 unsorted form is what the check above is protecting
// against, and it must actually fail.
check(seatIntentToForward(sign(approverSk, JSON.stringify({ v: 1, op: 'channel_seat', agent: AGENT, key: KEY })), opts()).ok === false,
  '  …and the unsorted form the page used to send is refused — the sort is load-bearing')
check(consoleCanonical({ v: 1, op: 'agent_rename', agent: AGENT, label: 'x' }) === canonicalJson({ v: 1, op: 'agent_rename', agent: AGENT, label: 'x' }),
  '  …and the console sorts every command, not only this one')

// THE SSH KEY SHAPE, declared in the console and in src/channel_seat.mjs. Compared on real keys and
// on the rejections, because a client check that is merely stricter is a check that refuses keys the
// broker would have taken.
const cases = [
  [KEY, true], [OTHER_KEY, true],
  [`${KEY.split(' ').slice(0, 2).join(' ')}`, true],
  ['ssh-rsa AAAAB3NzaC1yc2EAAAA', false],
  [`restrict,command="/bin/sh" ${KEY}`, false],
  ['ssh-ed25519', false],
  ['', false],
]
for (const [k, want] of cases) {
  const src = parseSeatIntent(body({ key: k })).ok === true
  check(!(draftSeat(k) instanceof Error) === want && src === want,
    `console and src/ agree that ${want ? 'this IS' : 'this is NOT'} a seatable key: "${k.slice(0, 34).replace(/\n/g, '\\n') || '(empty)'}…"`)
}

// The private-key check runs FIRST. Ordering it second would meet the worst paste with "that is not
// an ed25519 public key", which reads as a typo and invites a retry.
for (const bad of ['-----BEGIN OPENSSH PRIVATE KEY-----', 'nsec1qqqqq', 'bunker://abc?relay=wss://x', 'PuTTY-User-Key-File-3: ssh-ed25519']) {
  check(/PRIVATE key/.test(draftSeat(bad).message), `the private-key refusal names "${bad.slice(0, 28)}…" as a private key, before any shape complaint`)
}
check(!(draftSeat(KEY) instanceof Error) && !(draftSeat(OTHER_KEY) instanceof Error),
  '  …and a real PUBLIC key is not caught by it — the guard is not simply refusing everything')

// A seat does not appear in the roster, so its result must not borrow the roster's proof.
const seatVerdict = bridgeVerdict(JSON.parse(drafted.content), { observed_at: NOW, agents: [] }, [{ observed_at: NOW + 60, agents: [] }])
check(seatVerdict.done === null, 'a seat is never called done from the roster — the roster will look identical either way')
check(/connection check is the proof/.test(seatVerdict.text), '  …and the message says where the proof is instead')

// ---------------------------------------------------------------------------------------------
console.log('\n§5 the bridge wiring')

const bridge = readFileSync(join(ROOT, 'src/bridge.mjs'), 'utf8')
check(/if \(d === SEAT_COMMAND_D\) \{/.test(bridge), 'the control-command dispatch routes the seat tag')
check(/'#d': \[CONTROL_COMMAND_D, WATCHLIST_COMMAND_D, TRUST_COMMAND_D, MODERATION_COMMAND_D, LIFECYCLE_COMMAND_D, SEAT_COMMAND_D\]/.test(bridge),
  '  …and the REQ filter subscribes to it, so a dispatched tag is one that actually arrives')
check(/runChannelSeatSsh\(JSON\.stringify\(ev\), PUB\.channelSeat\)/.test(bridge),
  'the WHOLE SIGNED EVENT goes down the pipe — the bridge forwards, it does not re-author')
const handler = bridge.split('async function handleChannelSeatCommand')[1].slice(0, 3000)
check(/outcome = \{ ok: false, terminal: false/.test(handler),
  'a transport throw is caught as UNKNOWN inside the handler, not left to become a refusal')
check(handler.indexOf('seat_command_at') > handler.indexOf('if (outcome.ok !== true)'),
  'the watermark advances only AFTER a terminal answer — an unreachable broker leaves the command replayable')
check(/mode !== 'remote-only'/.test(handler) && /err\(`channel-seat: refusing/.test(handler),
  'a bridge with the lane off refuses WITH A REASON in the log, rather than silently not matching')

// One module owns every external process. A second `execFile` for this would make the egress ban a
// convention rather than a boundary.
check(/export function runChannelSeatSsh/.test(readFileSync(join(ROOT, 'src/egress.mjs'), 'utf8')),
  'the ssh call lives in src/egress.mjs with every other external process')
check(!/execFile|spawn|child_process/.test(readFileSync(join(ROOT, 'src/channel_seat_delivery.mjs'), 'utf8')),
  '  …and the decision module spawns nothing at all')

console.log(`\nchannel_seat_delivery: ${fail ? `${fail} FAILED, ` : ''}${pass} checks passed`)
process.exit(fail ? 1 : 0)
