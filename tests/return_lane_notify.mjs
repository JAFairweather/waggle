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
import { invokeHook, notifyDecision, notifyLine } from '../src/return_lane_notify.mjs'

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
