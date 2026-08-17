// return_lane_notify — the wake signal, and the one line it must never cross (#548).
//
// THE HOLE THIS SUITE EXISTS TO HOLD SHUT. The proposal said the hook should fire for
// "trusted/mentioned" messages. Anyone may seal mail to this agent's key, so a mention that fires a
// command hands every stranger on the open internet a trigger on this session — not code execution,
// the body is never executed, but an unauthenticated wake-up on demand. The gate is the trust list
// and nothing else, and the load-bearing assertion below is the one where a message IS addressed to
// this agent, IS well-formed, IS attributed to a real key, and still must not run anything.
//
// Asserted in both directions throughout. A gate that only ever refuses is indistinguishable from
// one that refuses everything, so every refusal here is paired with a legitimate message that still
// gets through — that pairing is what a green suite missed the last time this project shipped an
// outage, when a slot validator correctly rejected an attack and also silently dropped every real
// message to one recipient.
//
// THE HOOK IS DRIVEN WITH THE REAL `spawn`, against a real executable on disk, whose directory name
// contains a SPACE. Nothing here asserts that a string contains the right flags: a lost quote passes
// every string assertion and dies when something actually runs it, and the production names in this
// project have spaces in them ("Pi Dog", "My Dude"). The child reports back what it received on
// stdin, so the envelope's arrival is observed and not assumed.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCarriageReceipt, invokeHook, notifyDecision, notifyLine, wakeVerdict } from '../src/return_lane_notify.mjs'
// The BRIDGE's own renderer, so the fixtures below are the strings the lane really sends. A suite
// that hand-copies the prose cannot notice the renderer changing, and the failure that hides is a
// real mention silently waking nobody.
import { buildBody } from '../src/nostr_egress.mjs'

let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

console.log('\nreturn_lane_notify\n')

const A = 'a'.repeat(64)
const STRANGER = 'b'.repeat(64)

// Shaped exactly like what `rumorVerdict` returns, because that is this module's only input.
const verdict = o => Object.freeze({ ok: true, author: A, content: 'hello', forMe: false, at: 1_800_000_000, disposition: 'trusted', mayAct: true, reason: 'on the trust list', ...o })

// ---------------------------------------------------------------- the gate

console.log('the gate is the trust list, and only the trust list')

check(notifyDecision(verdict({ disposition: 'trusted', mayAct: true })).invoke === true,
  'a trusted sender fires the hook — the positive control, without which every refusal below is meaningless')

// THE LOAD-BEARING ONE. Everything about this message is legitimate except who sent it.
const mentionedStranger = verdict({ author: STRANGER, disposition: 'data', mayAct: false, forMe: true })
check(notifyDecision(mentionedStranger).invoke === false,
  'a message that ADDRESSES this agent, from a key not on the trust list, does NOT fire the hook')
check(/being addressed is not authority/.test(notifyDecision(mentionedStranger).why),
  'and it says why in those terms — a hook that silently does not fire is indistinguishable from one that fired and did nothing')

check(notifyDecision(verdict({ disposition: 'data', mayAct: false, forMe: false })).invoke === false,
  'an untrusted sender that merely copied this agent does not fire it either')
check(notifyDecision(verdict({ disposition: 'self', mayAct: false })).invoke === false,
  'this agent\'s own echo does not fire it')
check(notifyDecision({ ok: false, reason: 'attributed to nobody' }).invoke === false,
  'a refused message — one whose claimed author disagrees with the seal — does not fire it')
check(notifyDecision(verdict(), { hasCommand: false }).invoke === false,
  'and with no --on-message given, nothing fires at all')

// `mayAct` is the field the gate reads. If a caller ever hands over a verdict whose disposition says
// trusted but whose mayAct does not, the safe half must win.
check(notifyDecision(verdict({ disposition: 'trusted', mayAct: false })).invoke === false,
  'disposition alone cannot open the gate — mayAct is the field that decides')

// ---------------------------------------------------------------- the envelope

console.log('\none message, one line')

const line = notifyLine(verdict({ content: 'first\nsecond\r\nthird' }))
check(line.split('\n').length === 1 && line.split('\r').length === 1,
  'a body with newlines still yields exactly one line — a hostile body cannot forge a second record')
check(JSON.parse(line).content === 'first\nsecond\r\nthird',
  'and the body survives the round trip intact, newlines included')

const U2028 = String.fromCharCode(0x2028), U2029 = String.fromCharCode(0x2029)
const sepLine = notifyLine(verdict({ content: `a${U2028}b${U2029}c` }))
check(sepLine.indexOf(U2028) === -1 && sepLine.indexOf(U2029) === -1,
  'U+2028/U+2029 are escaped — valid inside JSON, but line terminators to some readers, which would split one record into two halves')
check(JSON.parse(sepLine).content === `a${U2028}b${U2029}c`,
  'and they still decode back to the characters the sender actually sent')

// The probe must not lose its own input: if the fixture above did not really contain the separators,
// the two assertions would pass without testing anything.
check([...`a${U2028}b${U2029}c`].filter(c => c.codePointAt(0) === 0x2028 || c.codePointAt(0) === 0x2029).length === 2,
  'the separator fixture really does contain both characters — a probe that loses its input has told you nothing')

const rec = JSON.parse(notifyLine(mentionedStranger))
check(rec.forMe === true && rec.mayAct === false,
  'the envelope carries forMe and mayAct as separate fields — being addressed is reported, never conflated with authority')
check(JSON.parse(notifyLine({ ok: false, reason: 'attributed to nobody' })).ok === false,
  'a refusal is emitted as a record too — dropping it would leave a reader unable to tell a quiet lane from one being fed forgeries')

// --------------------------------------------- the field an adapter filters on, and only that (#559)

console.log('\nthe wake verdict travels on the record')

// THE DEFECT THIS SECTION EXISTS FOR. The record stream is deliberately ungated — every record
// reaches stdout so a lane being fed forgeries cannot look quiet — and a Claude Code adapter filtered
// it with `grep '"receipt":false'`. A stranger's ordinary message is ok:true, mayAct:false,
// receipt:false, so that woke on mail from anyone who can seal a wrap to this key, which under NIP-59
// is everyone. The hook path refused precisely what the adapter woke on. Proven live on `ab65e477`
// before this field existed; the fix is that both are now the SAME CALL, not two rules kept in step.
const wakeOf = v => JSON.parse(notifyLine(v))
const wakeOf2 = (v, id, receivedAt = null) => JSON.parse(notifyLine(v, { id, receivedAt }))

check(wakeOf(verdict()).wake === true,
  'a trusted sender wakes — the positive control, without which every refusal below proves nothing')

// The exact record the broken filter matched. This is the assertion that would have caught it.
const strangerRec = wakeOf(mentionedStranger)
check(strangerRec.receipt === false && strangerRec.ok === true,
  'a mentioning stranger still serialises as ok:true and receipt:false — the shape the old filter matched, unchanged')
check(strangerRec.wake === false,
  '  …and wake is false, so an adapter filtering ONE field refuses what `receipt` alone let through')

check(wakeOf(verdict({ disposition: 'self', mayAct: false })).wake === false,
  'this agent\'s own echo does not wake')
check(wakeOf({ ok: false, reason: 'attributed to nobody' }).wake === false,
  'a refusal does not wake, and still carries the field rather than omitting it')
check(Object.prototype.hasOwnProperty.call(wakeOf({ ok: false, reason: 'x' }), 'wake'),
  '  …present as a key on the refusal branch — an absent key and a false read the same to a filter that greps')

// THE PROPERTY THAT MAKES THE BOUNDARY REAL. Not "wake agrees with notifyDecision" — they are the
// same call, and this asserts that across every case rather than on one fixture.
const cases = [
  ['trusted', verdict()],
  ['mentioning stranger', mentionedStranger],
  ['copied stranger', verdict({ disposition: 'data', mayAct: false, forMe: false })],
  ['own echo', verdict({ disposition: 'self', mayAct: false })],
  ['refusal', { ok: false, reason: 'attributed to nobody' }],
  // The trusted-carriage-receipt case is asserted in the #550 section below, against the BRIDGE's own
  // renderer rather than a hand-copied string — it cannot be listed here because that fixture is
  // built further down the file.
]
check(cases.every(([, v]) => wakeOf(v).wake === wakeVerdict(v).wake),
  `the record's wake equals wakeVerdict for all ${cases.length} cases — the hook gate and the wake filter cannot disagree because they are one call`)
// And that shared call still reduces to the trust gate when the two delivery facts say nothing. This
// is what stops the first-seen work from having quietly widened or narrowed who may wake anybody.
check(cases.every(([, v]) => wakeVerdict(v).wake === notifyDecision(v, { hasCommand: true }).invoke),
  '  …and for a first-seen, non-bootstrap message it is exactly notifyDecision — the trust gate is unchanged by #557')

// A wake:false whose stated cause is this daemon's own configuration would send an operator to fix a
// flag when the truth is about the sender. The spool is not a hook and must never say otherwise.
check(!/no --on-message command was given/.test(wakeOf(mentionedStranger).wake_reason),
  'wake_reason never blames a missing --on-message — the record answers the gate\'s question, not "is a hook configured"')
check(/not on the trust list/.test(wakeOf(mentionedStranger).wake_reason),
  '  …it names the real cause, because this string is what an operator acts on')

// ------------------------------- what gates the wake, and what only explains it (#557 review)

console.log('\nfirst-seen gates the wake; liveness only annotates it')

const wake3 = (v, o) => JSON.parse(notifyLine(v, o))
const T = verdict()   // trusted, mayAct, not a receipt — wakes whenever the delivery facts allow it

// CASE 1 — the flood. A first-ever start reads a relay full of history, every message of it unseen,
// and must seed the index without announcing any of it. Its control is the line above: the SAME
// verdict with bootstrap off wakes, so this is measuring the flag and not a fixture that never wakes.
check(wake3(T, { bootstrap: false }).wake === true,
  'the bootstrap control: this exact verdict wakes when it is not history')
check(wake3(T, { bootstrap: true }).wake === false,
  'a first-start backfill record does not wake — the #554 flood, which a Monitor answers by stopping itself, so the flood ends as silence')
check(/seeding the dedupe index/.test(wake3(T, { bootstrap: true }).wake_reason),
  '  …and says it was history, not that the sender was untrusted — those send an operator to different places')

// CASE 2 — the one the strict formula fails. A relay's reconnect replay holds two populations it
// cannot separate: already-delivered mail, and mail that ARRIVED DURING THE DISCONNECT. Both come
// pre-EOSE, so both have live:false. Gating on liveness would suppress the second permanently, which
// is the bug #557 was filed about, rebuilt inside the field meant to fix it.
check(wake3(T, { live: false, firstSeen: true }).wake === true,
  'a never-seen message replayed pre-EOSE DOES wake — mail that arrived during a disconnect is not history, and liveness cannot tell them apart')
check(wake3(T, { live: false, firstSeen: false }).wake === false,
  '  …while the already-delivered half of that same replay does not, because the dedupe claim is what separates them')
check(/already delivered/.test(wake3(T, { firstSeen: false }).wake_reason),
  '  …named as a re-delivery rather than a trust refusal')

// The audit facts are on the record, distinctly. One `wake:false` cannot say whether a message was
// history, a re-delivery, or a stranger, and an operator debugging a quiet lane needs to know which.
const hist = wake3(T, { bootstrap: true, live: false })
check(hist.bootstrap === true && hist.live === false && hist.first_seen === true,
  'bootstrap, live and first_seen are three separate serialised facts — a bootstrap record is still first-seen, and a spool that said otherwise would lie about what the index now holds')
check(wake3(T, {}).live === null,
  'live is null when the emitter has no notion of a connection — absent and false are different claims')
check([wake3(T, { firstSeen: false }), wake3({ ok: false, reason: 'nobody' }, { bootstrap: true })]
  .every(r => ['wake', 'wake_reason', 'first_seen', 'bootstrap', 'live'].every(k => Object.prototype.hasOwnProperty.call(r, k))),
  'all five keys are present on both branches — a refusal that omits them is indistinguishable from one that denies them, to an adapter that greps')

// THE DEFAULTS POINT AT WAKING, and that is a decision rather than an accident. A caller who forgets
// a flag gets a duplicate wake, which is noise somebody notices; under the opposite defaults they get
// silence, and a first-seen claim is irreversible, so no replay ever surfaces that message again.
check(wake3(T, {}).wake === true && wake3(T, {}).first_seen === true && wake3(T, {}).bootstrap === false,
  'omitting both delivery facts wakes — the failure mode of a forgotten flag is a duplicate, never a permanent suppression')

// Neither fact can OPEN the gate. They are only ever able to take away, the same property that makes
// the content-shaped receipt test safe — otherwise `bootstrap:false` would be a way past the trust list.
check([mentionedStranger, verdict({ disposition: 'self', mayAct: false }), { ok: false, reason: 'x' }]
  .every(v => [{ firstSeen: true }, { bootstrap: false }, { live: true }, { firstSeen: true, bootstrap: false, live: true }]
    .every(o => wake3(v, o).wake === false)),
  'no combination of first_seen, bootstrap or live wakes an untrusted sender, an echo or a refusal — the delivery facts narrow the trust gate and can never widen it')

// ------------------------------------------------------- the id an adapter is idempotent on (#559)

console.log('\nthe record can be named')

const ID1 = '1'.repeat(64), ID2 = '2'.repeat(64)

// THE ONE THAT MATTERS MORE THAN "an id is present". Two distinct messages must not collapse: a
// re-send is how this crew retries a message that reached nobody, so identical bodies from the same
// author at the same second are a real case, not a contrived one.
const same = { content: 'ping', author: A, at: 1_800_000_000 }
check(wakeOf2(verdict(same), ID1).id !== wakeOf2(verdict(same), ID2).id,
  'two wraps with IDENTICAL author, body and timestamp still get different ids — otherwise dedupe silently eats a deliberate re-send')
check(wakeOf2(verdict(same), ID1).id === wakeOf2(verdict(same), ID1).id,
  'and the same wrap seen twice gets the same id, which is what makes an adapter restart idempotent')

check(wakeOf(verdict()).id === null,
  'with no id passed the key is null, not undefined — "this daemon emits no ids" and "this record has none" are different states')
check(Object.prototype.hasOwnProperty.call(wakeOf(verdict()), 'id'),
  '  …and the key is present either way, so a reader can tell them apart at all')
check(wakeOf2({ ok: false, reason: 'attributed to nobody' }, ID1).id === ID1,
  'a refusal carries an id too — an adapter that cannot dedupe refusals re-wakes forever on a lane being fed forgeries')

// `at` is the SENDER's clock and `--since` is answered from it. A spool ordered by that is a spool a
// sender can reorder, so the daemon's own observation is a separate field.
const stamped = JSON.parse(notifyLine(verdict({ at: 1_800_000_000 }), { id: ID1, receivedAt: 1_900_000_000 }))
check(stamped.at === 1_800_000_000 && stamped.received_at === 1_900_000_000,
  'rumor time and receive time are separate fields — a spool ordered by sender-controlled time is one a sender can reorder')
check(JSON.parse(notifyLine(verdict(), { id: ID1, receivedAt: 1.5 })).received_at === null,
  'a non-integer received_at lands as null rather than being written through — a cursor comparing it would silently misorder')

// ------------------------------------------------- a trusted courier's echo is not news (#550)

console.log('\nthe bridge acknowledging our own send')

// FOUND BY BEING WOKEN BY ONE. The wake path fired end to end for the first time and what it
// delivered was the carriage receipt for a message this session had just sent. Sealed by the bridge,
// so trusted, so mayAct — and nobody said it. Every send makes one, so the lane wakes the session
// once per thing it says, and an agent woken by its own echo stops reading the wakes that are real.
const CHANNEL = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
const RECEIPT = buildBody('relay_ack_ok', {
  channel: CHANNEL,
  buzzEventId: '2dbf78737aff49b090f8ce1649d55322ba2a74f2cdb5585238480bbaf46664b5',
  ts: 1786903763,
})
check(RECEIPT.includes('"buzz_event_id"') && JSON.parse(RECEIPT).ok === true,
  'the fixture came out of the real relay_ack_ok renderer — a probe that lost its input has told you nothing')

check(notifyDecision(verdict({ content: RECEIPT })).invoke === false,
  'a carriage receipt does not run the hook, even though the bridge that sealed it is trusted')
check(/nobody said it/.test(notifyDecision(verdict({ content: RECEIPT })).why),
  '...and it says WHY — a hook that silently does not fire reads as one that fired and did nothing')

// THE NULL ID, which the first version of this let through (#550, caught in review). `relay_ack_ok`
// renders `buzz_event_id: null` whenever the caller's id is falsy, and `bridge.mjs` passes exactly
// that when `parseBuzzEventId` comes back empty — an already-logged, real condition (#334) that
// falls through to the ack. Requiring 64-hex closed #550 for ordinary sends and left it open for
// precisely the sends that lost their id: the ones least worth being woken by.
const NULL_ID = buildBody('relay_ack_ok', { channel: CHANNEL, buzzEventId: null, ts: 1786903763 })
check(JSON.parse(NULL_ID).buzz_event_id === null,
  'the renderer really does emit a null id when the caller has none — the fixture is the lane\'s own output')
check(notifyDecision(verdict({ content: NULL_ID })).invoke === false,
  'an ack that lost its event id is still a carriage receipt, and still does not wake anyone')

// A FAILED carriage is the other ack the same lane sends, and it is the one an agent most needs.
const ERR_ACK = buildBody('relay_ack_err', { channel: CHANNEL, reason: 'not admitted', ts: 1786903763 })
check(notifyDecision(verdict({ content: ERR_ACK })).invoke === true,
  'a FAILED carriage DOES wake — a send that did not land is news, not an echo')

// The key set is pinned, so a shape that merely resembles an ack is not swallowed. `ok:true` and a
// null id on their own are a shape anything could take.
check(isCarriageReceipt(JSON.stringify({ ok: true, buzz_event_id: null })) === false,
  'ok and a null id alone are not an ack — the whole key set is pinned, which is what makes accepting null safe')
check(isCarriageReceipt(JSON.stringify({ ...JSON.parse(RECEIPT), extra: 1 })) === false,
  'an ack that grew a field stops matching — it fails toward waking somebody, which is noisy rather than silent')

// THE PAIRING, and the direction that costs more if it breaks. A real carried mention must still
// wake, or this change trades a noisy lane for a silent one and looks identical to a quiet lane.
// The body is the one that actually arrived, not a placeholder.
const AUTHOR = '0a8e0720c3ec' + 'd'.repeat(52)
const CARRIED = buildBody('return_carry', {
  mention: 'claude', why: 'mention', author: AUTHOR,
  body: '@MC Claude - all three read. Full reviews are on the PRs.',
})
check(notifyDecision(verdict({ content: CARRIED })).invoke === true,
  'a real carried mention still wakes the session — the pairing, and the expensive direction')

// THE HOSTILE CASE. A community member cannot suppress their own wake by writing a receipt as their
// message text: the bridge quotes them inside its own prose, so their words are never the whole
// content and the top level never parses as JSON. Reasoning about that is not enough — the failure
// is a real mention silently waking nobody, which is indistinguishable from a quiet lane.
const HOSTILE = buildBody('return_carry', { mention: 'claude', why: 'mention', author: AUTHOR, body: RECEIPT })
check(notifyDecision(verdict({ content: HOSTILE })).invoke === true,
  'a member who writes a receipt as their message text is still carried through and still wakes')
check(HOSTILE.includes('"buzz_event_id"'),
  '...and the fixture really does carry a whole receipt inside it — a probe that loses its input has told you nothing')

// The classifier on its own, at the edges, because the gate above can only narrow and a false
// positive here is a message that never wakes anyone.
check(isCarriageReceipt(RECEIPT) === true, 'the classifier recognises the receipt it was built from')
check(isCarriageReceipt('') === false, 'an empty body is not a receipt')
check(isCarriageReceipt('{') === false, 'an unparseable fragment is not a receipt')
check(isCarriageReceipt('[1,2,3]') === false, 'a JSON array is not a receipt')
check(isCarriageReceipt('null') === false, 'JSON null is not a receipt')
check(isCarriageReceipt(JSON.stringify({ ok: true, channel: 'c' })) === false,
  'ok and a channel are not enough without an event id — all four conditions, so it fails safe toward waking')
// WITH `ts`, so the key-set pin is satisfied and this reaches the `ok` check. Without it the shape
// check rejected first and the assertion proved nothing about `ok` at all — a mutation that made the
// classifier ignore `ok` entirely survived, which is how this was found.
check(isCarriageReceipt(JSON.stringify({ ok: false, channel: 'c', buzz_event_id: 'a'.repeat(64), ts: 1 })) === false,
  'a FAILED carriage in the EXACT ack shape is not swallowed either — the classifier keys on ok, not only on the key set')

// The record still carries it. The wake is what a receipt loses, not the delivery.
const recRec = JSON.parse(notifyLine(verdict({ content: RECEIPT })))
check(recRec.receipt === true && recRec.content === RECEIPT,
  'the receipt is still emitted as a record, flagged — suppressing the record would break a send/ack tally')
// The third case the wake verdict has to carry, listed with the others in the #559 section above but
// asserted here, against the renderer's own output rather than a hand-copied string.
check(recRec.wake === false && recRec.wake === notifyDecision(verdict({ content: RECEIPT }), { hasCommand: true }).invoke,
  '  …and it does not wake, by the same call the hook path uses — spooled and visible, but nobody said it')
check(JSON.parse(notifyLine(verdict({ content: CARRIED }))).receipt === false,
  'and a real message is flagged as not a receipt')

// ---------------------------------------------------------------- the hook, actually run

console.log('\nthe hook, run for real')

// A directory with a SPACE in it. Every fixture in the suite that missed the last outage used a name
// with no space; the production names here are "Pi Dog" and "My Dude".
const root = mkdtempSync(join(tmpdir(), 'waggle-notify-'))
const dir = join(root, 'wake dir')
mkdirSync(dir)
const seen = join(dir, 'what the hook got.json')
const hook = join(dir, 'wake me')
writeFileSync(hook, `#!/bin/sh\ncat > ${JSON.stringify(seen)}\n`)
chmodSync(hook, 0o755)

const ran = await invokeHook({ command: hook, verdict: verdict({ content: 'wake up' }), spawn })
check(ran.ran === true && ran.ok === true, 'a trusted message runs the hook, through a path containing a space')
let got = null
try { got = JSON.parse(readFileSync(seen, 'utf8')) } catch { /* asserted below */ }
check(got !== null, 'the hook received something on stdin — observed in the child, not assumed from the parent')
check(got?.content === 'wake up' && got?.author === A,
  'and what it received is this message\'s envelope, parsed by the child as JSON')

// The refusal direction, through the same real path: the hook exists and is runnable, and must not run.
writeFileSync(seen, 'NOT OVERWRITTEN')
const skipped = await invokeHook({ command: hook, verdict: mentionedStranger, spawn })
check(skipped.ran === false && skipped.ok === true, 'an addressed message from an untrusted key does not run it')
check(readFileSync(seen, 'utf8') === 'NOT OVERWRITTEN',
  'and the file the hook would have written is untouched — the refusal is observed at the child, not just reported by the parent')

// A hook that is not there must be loud. A wake adapter that is silently absent is the failure this
// whole feature exists to remove.
const absent = await invokeHook({ command: join(dir, 'no such hook'), verdict: verdict(), spawn })
check(absent.ok === false && /could not be started/.test(absent.why),
  'a hook that does not exist is reported as a failure, not passed over in silence')

const failing = join(dir, 'exits nonzero')
writeFileSync(failing, '#!/bin/sh\ncat > /dev/null\nexit 7\n')
chmodSync(failing, 0o755)
const bad = await invokeHook({ command: failing, verdict: verdict(), spawn })
check(bad.ran === true && bad.ok === false && bad.code === 7,
  'a hook that exits non-zero is reported as a failure — the message was delivered and the wake-up was not')

// No shell — asserted by the side effect a shell WOULD have, not by the exit code. Under
// `shell: true` this whole path is handed to /bin/sh, which runs the first word as a command and
// then runs the `touch` as a second statement; the last statement succeeds, so the exit status is 0
// EITHER WAY. An earlier version of this check asserted only that exit status, was therefore true
// in both worlds, survived the `shell: false` -> `shell: true` mutation, and proved nothing.
//
// The marker is relative and the cwd is moved into the temp dir, so a shell that did run would
// drop the file somewhere this test can see and nowhere near the checkout.
const shellish = join(dir, 'wake me; touch pwned')
writeFileSync(shellish, '#!/bin/sh\ncat > /dev/null\n')
chmodSync(shellish, 0o755)
const cwd = process.cwd()
process.chdir(dir)
const noShell = await invokeHook({ command: shellish, verdict: verdict(), spawn })
const leaked = existsSync(join(dir, 'pwned'))
process.chdir(cwd)
check(noShell.ran === true && noShell.ok === true,
  'a filename containing shell metacharacters is still executed — the positive half, so the assertion below cannot pass by nothing having run')
check(leaked === false,
  'and the shell statement embedded in that filename did NOT execute — spawn runs with shell: false')

// ---------------------------------------------------------------- the record stream

console.log('\nthe hook cannot corrupt the record stream')

// #549 review, must-fix 1: the child inherited OUR stdout, which under --jsonl IS the record stream.
// A wake script that prints anything — and "echo waking session" is the first thing anyone writes —
// put a non-JSON line between two records.
//
// This has to be observed on a REAL stdout, so it runs in a subprocess: the driver writes records
// around a hook that deliberately prints, and the parent asserts every line it got back parses.
// Asserting the stdio option instead would assert the mechanism, and the mechanism is what changed.
const modulePath = new URL('../src/return_lane_notify.mjs', import.meta.url).href
const noisy = join(dir, 'noisy hook')
writeFileSync(noisy, '#!/bin/sh\ncat > /dev/null\necho "waking claude session 7"\n')
chmodSync(noisy, 0o755)

const driver = join(dir, 'driver.mjs')
writeFileSync(driver, [
  "import { spawn } from 'node:child_process'",
  `import { invokeHook, notifyLine } from '${modulePath}'`,
  "const v = { ok: true, author: 'a'.repeat(64), content: 'x', forMe: false, at: 1, disposition: 'trusted', mayAct: true, reason: 'r' }",
  'process.stdout.write(notifyLine(v) + String.fromCharCode(10))',
  `await invokeHook({ command: ${JSON.stringify(noisy)}, verdict: v, spawn })`,
  'process.stdout.write(notifyLine(v) + String.fromCharCode(10))',
].join('\n'))

// spawnSync, not execFileSync: execFileSync RETURNS stdout and gives you stderr only by throwing,
// so a first version of this check read driverErr as empty on every successful run and reported a
// failure for a stream it had never looked at.
const driven = spawnSync(process.execPath, [driver], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const driverOut = driven.stdout || ''
const driverErr = driven.stderr || ''

const outLines = driverOut.split('\n').filter(Boolean)
check(outLines.length === 2,
  `stdout carries exactly the two records and nothing else — got ${outLines.length}`)
check(outLines.every(l => { try { JSON.parse(l); return true } catch { return false } }),
  'every line on stdout parses as JSON — the hook\'s own output did not land between two records')
check(driverOut.includes('waking claude session 7') === false,
  'and the hook\'s line is not on stdout at all')

// The positive half: the operator must not LOSE that output, only have it moved.
check(driverErr.includes('waking claude session 7'),
  'the hook\'s output is still visible on stderr — moved, not suppressed, or an operator loses their own logging')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
