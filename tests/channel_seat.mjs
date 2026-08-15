// channel_seat — seating an agent's channel key on the broker (#488).
//
// The row this exists for is `channel-authorized`. It was UNKNOWN forever and had no path by which
// it could ever be anything else, so a fresh agent finished install with a correct stanza, a correct
// keypair, and a channel that could not connect.
//
// Two properties carry the whole thing, and both are asserted in both directions:
//
//   1. THE REQUESTER CONTRIBUTES A KEY AND NOTHING ELSE. An authorized_keys line is a grant of
//      execution and its options field is where that grant is bounded. Every byte of the options
//      comes from the broker's root-owned config; an intent carrying its own is refused rather than
//      sanitised.
//   2. A SEAT IS EVIDENCE, NOT AN ASSERTION. No receipt leaves the row UNKNOWN. A receipt for a
//      different key is a real negative. Only a receipt naming THIS key promotes it — and even then
//      it is a saved capture, which the row says out loud rather than implying more.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { canonicalJson } from '../src/buzz_policy_core.mjs'
import { authorizedKeysLine, keyFingerprint, parseSeatIntent, seatDecision, seatReceipt, seatVerdict } from '../src/channel_seat.mjs'
import { SEAT_COMMAND_D, SEAT_EVENT_KIND, loadSeatConfig, runChannelSeat, verifySeatEvent } from '../src/channel_seat_runner.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

console.log('\nchannel_seat\n')

const AGENT = 'a'.repeat(64)
const OTHER_AGENT = 'b'.repeat(64)
const COMMAND = '/opt/waggle-broker/bin/channel'
const INSTANCE = 'pi-oliver'
const tmp = mkdtempSync(join(tmpdir(), 'waggle-seat-'))

// A REAL key, minted the way connect-agent mints one, so the fingerprint check below compares
// against ssh-keygen's own answer rather than against this module's idea of it.
execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'nvoy-mcp-channel test', '-f', join(tmp, 'id_ed25519')], { stdio: 'ignore' })
const PUB_LINE = readFileSync(join(tmp, 'id_ed25519.pub'), 'utf8').trim()
const BLOB = PUB_LINE.split(/\s+/)[1]

// ------------------------------------------------------------------------------------------
console.log('1. the intent carries a key, and refuses to carry anything else')
{
  const ok = parseSeatIntent({ v: 1, op: 'channel_seat', agent: AGENT, key: PUB_LINE })
  check(ok.ok === true && ok.keyBlob === BLOB && ok.agent === AGENT, 'a bare ssh-ed25519 line with a comment parses')

  const withOptions = parseSeatIntent({ v: 1, op: 'channel_seat', agent: AGENT, key: `command="/bin/sh" ${PUB_LINE}` })
  check(withOptions.ok === false, 'a key carrying its own command= option is REFUSED')
  check(/options come from the broker/.test(withOptions.reason),
    '  …and the refusal names the reason, so an operator who pasted a whole authorized_keys line knows which half to keep')
  check(parseSeatIntent({ v: 1, op: 'channel_seat', agent: AGENT, key: `restrict ${PUB_LINE}` }).ok === false,
    'and `restrict` too — a prefix this runner happens to agree with is still a prefix the requester chose')

  const twoLines = parseSeatIntent({ v: 1, op: 'channel_seat', agent: AGENT, key: `${PUB_LINE}\ncommand="/bin/sh" ${PUB_LINE}` })
  check(twoLines.ok === false && /second, unbounded entry/.test(twoLines.reason),
    'a newline is refused as what it is — an attempt to write a SECOND line whose options nobody bounded')

  check(parseSeatIntent({ v: 1, op: 'channel_seat', agent: AGENT, key: PUB_LINE, options: 'restrict' }).ok === false,
    'an extra `options` field is refused rather than ignored — the exact key set is the screen')
  check(parseSeatIntent({ v: 2, op: 'channel_seat', agent: AGENT, key: PUB_LINE }).ok === false, 'a version this build does not know is refused')
  check(parseSeatIntent({ v: 1, op: 'agent_admit', agent: AGENT, key: PUB_LINE }).ok === false, 'and an operation from another catalogue is not admitted by this one')
  check(parseSeatIntent({ v: 1, op: 'channel_seat', agent: 'nope', key: PUB_LINE }).ok === false, 'the agent must be a 64-hex public key')
  check(parseSeatIntent({ v: 1, op: 'channel_seat', agent: AGENT, key: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ' }).ok === false,
    'and only ed25519 — accepting another algorithm could only ever admit a key this project did not mint')
  check(parseSeatIntent(null).ok === false && parseSeatIntent('x').ok === false, 'and nothing at all is a refusal, not a throw')
}

// ------------------------------------------------------------------------------------------
console.log('\n2. the fingerprint is the one ssh-keygen prints')
{
  const theirs = execFileSync('ssh-keygen', ['-lf', join(tmp, 'id_ed25519.pub')], { encoding: 'utf8' }).trim().split(/\s+/)[1]
  check(keyFingerprint(BLOB) === theirs, `keyFingerprint equals \`ssh-keygen -lf\` — the operator's way of checking is a string compare, and it has to match`)
  check(keyFingerprint('not base64!') === null, 'and a blob that is not a blob has no fingerprint rather than a plausible one')
}

// ------------------------------------------------------------------------------------------
console.log('\n3. every byte of the options comes from the broker')
{
  const intent = parseSeatIntent({ v: 1, op: 'channel_seat', agent: AGENT, key: PUB_LINE })
  const line = authorizedKeysLine(intent, { command: COMMAND, instance: INSTANCE })
  check(line === `restrict,command="${COMMAND} ${INSTANCE}" ssh-ed25519 ${BLOB} ${AGENT}`, 'the line is restrict + the forced command + the key + the agent as its comment')
  check(line.split('"').length === 3, 'and the quoted command contains exactly one pair of quotes — nothing in it can end the string early')

  // The instance lands INSIDE that quoted string, so it is the byte-level break-out to try.
  for (const hostile of ['pi"; /bin/sh #', 'pi oliver', 'pi\nx', '../../etc/passwd', '']) {
    let threw = false
    try { authorizedKeysLine(intent, { command: COMMAND, instance: hostile }) } catch { threw = true }
    check(threw, `an instance of ${JSON.stringify(hostile)} is refused before it can reach the command string`)
  }
  let threwCommand = false
  try { authorizedKeysLine(intent, { command: 'sh -c "id"', instance: INSTANCE }) } catch { threwCommand = true }
  check(threwCommand, 'and a forced command that is not an absolute path in a closed character set is refused too')
  // POSITIVE CONTROL on all of the above: the legitimate pair still builds a line.
  check(authorizedKeysLine(intent, { command: COMMAND, instance: 'pi-2' }).includes('pi-2'), 'POSITIVE CONTROL — a legitimate instance still produces its line')
}

// ------------------------------------------------------------------------------------------
console.log('\n4. seated, already-seated and conflict are three different answers')
{
  const intent = parseSeatIntent({ v: 1, op: 'channel_seat', agent: AGENT, key: PUB_LINE })
  const opts = { command: COMMAND, instance: INSTANCE }
  const line = authorizedKeysLine(intent, opts)

  check(seatDecision(intent, '', opts).result === 'seated', 'an empty file seats')
  check(seatDecision(intent, `# a comment\n\n`, opts).result === 'seated', 'and so does one holding only comments and blank lines')
  check(seatDecision(intent, `${line}\n`, opts).result === 'already-seated', 'the exact line present is already-seated — a retry is not an alarm')

  // The conflict this is really for: the tempting implementation appends whenever the exact line is
  // absent, which double-seats a rotated key. The old line still authenticates, and nothing about
  // the file looks wrong.
  const otherBlob = readFileSync(join(tmp, 'id_ed25519.pub'), 'utf8').trim().split(/\s+/)[1].replace(/^.{4}/, 'AAAB')
  const rotated = seatDecision(intent, `restrict,command="${COMMAND} ${INSTANCE}" ssh-ed25519 ${otherBlob} ${AGENT}\n`, opts)
  check(rotated.result === 'conflict', 'this agent with a DIFFERENT key already seated is a conflict, not an append')
  check(/both able to connect/.test(rotated.reason), '  …and the reason says why: appending would leave the old key working')

  const shared = seatDecision(intent, `restrict,command="${COMMAND} ${INSTANCE}" ssh-ed25519 ${BLOB} ${OTHER_AGENT}\n`, opts)
  check(shared.result === 'conflict' && /different agent/.test(shared.reason), 'the same key seated for a different agent is a conflict — one key, one identity')

  const rebound = seatDecision(intent, `restrict,command="${COMMAND} other-instance" ssh-ed25519 ${BLOB} ${AGENT}\n`, opts)
  check(rebound.result === 'conflict' && /different options/.test(rebound.reason), 'and the right key under different options is a conflict — the existing grant is not the one being asked for')

  // POSITIVE CONTROL. Every assertion above is a refusal, and a decision function that refused
  // everything would satisfy all of them. This is the one that says it does not.
  const busy = [`restrict,command="${COMMAND} ${INSTANCE}" ssh-ed25519 ${otherBlob} ${OTHER_AGENT}`, '# operator note', ''].join('\n')
  const fresh = seatDecision(intent, busy, opts)
  check(fresh.result === 'seated', 'POSITIVE CONTROL — a new agent still seats into a file that already holds someone else')
  check(fresh.line === line, '  …with exactly the line the builder produces, not a variant assembled here')

  check(seatDecision(parseSeatIntent({ v: 1, op: 'channel_seat', agent: 'x', key: PUB_LINE }), '', opts).result === 'refused',
    'and an inadmissible intent is `refused`, which is not one of the other three')
}

// ------------------------------------------------------------------------------------------
console.log('\n5. the receipt promotes the row, or leaves it UNKNOWN — never a pass by default')
{
  const intent = parseSeatIntent({ v: 1, op: 'channel_seat', agent: AGENT, key: PUB_LINE })
  const fp = keyFingerprint(BLOB)
  const receipt = seatReceipt(intent, seatDecision(intent, '', { command: COMMAND, instance: INSTANCE }), { instance: INSTANCE, at: 1_700_000_000 })

  check(receipt.fingerprint === fp && !('key' in receipt), 'the receipt carries a fingerprint, never the key line')
  check(!JSON.stringify(receipt).includes(COMMAND), 'and no path, no host, no command — it is handed to the agent\'s machine, so it names the least it can')

  check(seatVerdict(receipt, { fingerprint: fp, agent: AGENT }).seated === true, 'a receipt for THIS key promotes the row')
  check(/saved capture/.test(seatVerdict(receipt, { fingerprint: fp, agent: AGENT }).reason),
    '  …and says it is a saved capture — it proves the seat happened, not that it still stands')

  check(seatVerdict(null, { fingerprint: fp }).seated === null, 'no receipt is UNKNOWN — INCONCLUSIVE is not a softer MISSING and is certainly not a pass')
  check(seatVerdict({}, { fingerprint: fp }).seated === null, 'and neither is a receipt this build does not recognise')
  check(seatVerdict(receipt, { fingerprint: '' }).seated === null, 'no local key to compare against is UNKNOWN too — a comparison with nothing is not a match')

  check(seatVerdict({ ...receipt, fingerprint: 'SHA256:elsewhere' }, { fingerprint: fp, agent: AGENT }).seated === false,
    'a receipt naming a DIFFERENT key is a real negative — something was seated, and it was not this')
  check(seatVerdict({ ...receipt, agent: OTHER_AGENT }, { fingerprint: fp, agent: AGENT }).seated === false, 'and a receipt for a different agent is refused before the fingerprint is even reached')
  check(seatVerdict({ ...receipt, result: 'conflict', reason: 'a different key is seated' }, { fingerprint: fp, agent: AGENT }).seated === false,
    'a conflict receipt does NOT promote — the broker refused, and the row must show that')
  check(seatVerdict({ ...receipt, result: 'already-seated' }, { fingerprint: fp, agent: AGENT }).seated === true,
    'BOTH DIRECTIONS — already-seated promotes, because the key is in the file either way')
}

// ------------------------------------------------------------------------------------------
console.log('\n6. the envelope: an approver signed it, recently, for this catalogue')
const approverSk = generateSecretKey()
const approver = getPublicKey(approverSk)
const strangerSk = generateSecretKey()
const NOW = 1_700_000_000
const sign = (sk, body, { kind = SEAT_EVENT_KIND, d = SEAT_COMMAND_D, at = NOW } = {}) =>
  JSON.stringify(finalizeEvent({ kind, created_at: at, tags: [['d', d]], content: typeof body === 'string' ? body : canonicalJson(body) }, sk))
const BODY = { v: 1, op: 'channel_seat', agent: AGENT, key: PUB_LINE }
{
  const good = verifySeatEvent(sign(approverSk, BODY), { approvers: [approver], now: NOW })
  check(good.ok === true && good.intent.keyBlob === BLOB, 'an approver-signed, fresh, correctly addressed intent verifies')

  check(verifySeatEvent(sign(strangerSk, BODY), { approvers: [approver], now: NOW }).ok === false, 'a stranger\'s signature is refused')
  const stale = verifySeatEvent(sign(approverSk, BODY, { at: NOW - 4000 }), { approvers: [approver], now: NOW })
  check(stale.ok === false && /bearer artifact/.test(stale.reason),
    'a stale intent is refused, and the reason names why a signed seat expires: whoever holds the bytes can present them again')
  check(verifySeatEvent(sign(approverSk, BODY, { at: NOW + 4000 }), { approvers: [approver], now: NOW }).ok === false, 'and one from the future too')
  check(verifySeatEvent(sign(approverSk, BODY, { d: 'waggle-agent-lifecycle' }), { approvers: [approver], now: NOW }).ok === false,
    'an intent addressed to a different catalogue is not admitted by this one')
  check(verifySeatEvent(sign(approverSk, BODY, { kind: 1 }), { approvers: [approver], now: NOW }).ok === false, 'and a kind:1 note is not a control event')

  const tampered = JSON.parse(sign(approverSk, BODY))
  tampered.content = canonicalJson({ ...BODY, agent: OTHER_AGENT })
  check(verifySeatEvent(JSON.stringify(tampered), { approvers: [approver], now: NOW }).ok === false, 'a body edited after signing fails the signature')
  check(verifySeatEvent(sign(approverSk, JSON.stringify(BODY) + ' '), { approvers: [approver], now: NOW }).ok === false,
    'and a validly signed but NON-canonical body is refused — two encodings of one body are two things the signer and the runner could disagree about')
  check(verifySeatEvent('{oops', { approvers: [approver], now: NOW }).ok === false, 'garbage is a refusal, not a throw — a runner a stranger can stop is a runner a stranger controls')
}

// ------------------------------------------------------------------------------------------
console.log('\n7. the runner writes one line, once')
{
  const dir = mkdtempSync(join(tmpdir(), 'waggle-seat-run-'))
  const keysPath = join(dir, 'authorized_keys')
  const journal = join(dir, 'journal')
  // Deliberately WITHOUT a trailing newline. A file whose last byte is not one is how an appended
  // line gets glued to the entry above it, producing a single unparseable line that disables both.
  const PRIOR = `restrict,command="${COMMAND} someone-else" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreExisting ${OTHER_AGENT}`
  writeFileSync(keysPath, PRIOR, { mode: 0o600 })
  const configPath = join(dir, 'seat.json')
  writeFileSync(configPath, JSON.stringify({
    version: 1, instance: INSTANCE, forced_command: COMMAND,
    authorized_keys_path: keysPath, journal_path: journal, approvers: [approver],
  }), { mode: 0o600 })
  chmodSync(configPath, 0o600)
  const config = loadSeatConfig(configPath)
  check(config.instance === INSTANCE && config.approvers[0] === approver, 'a 0600 config with the exact key set loads')
  const loose = join(dir, 'loose.json')
  writeFileSync(loose, readFileSync(configPath), { mode: 0o644 })
  chmodSync(loose, 0o644)
  let threwLoose = false
  try { loadSeatConfig(loose) } catch { threwLoose = true }
  check(threwLoose, 'and a world-readable one does not — the approver roster is not public reading')

  const raw = sign(approverSk, BODY)
  const first = JSON.parse(runChannelSeat(raw, config, { now: NOW }))
  check(first.result === 'seated' && first.fingerprint === keyFingerprint(BLOB), 'the first presentation seats the key')
  const afterFirst = readFileSync(keysPath, 'utf8')
  check(afterFirst.split('\n').filter(Boolean).length === 2, '  …appending exactly one line, leaving the entry that was already there')
  check(afterFirst.endsWith(`ssh-ed25519 ${BLOB} ${AGENT}\n`), '  …and ending with a newline, so the next seat cannot be glued onto this one')
  check(afterFirst.startsWith(`${PRIOR}\n`),
    '  …and the entry that had no trailing newline is still its own line — an append onto an unterminated file destroys the entry above it too')

  const second = JSON.parse(runChannelSeat(raw, config, { now: NOW }))
  check(second.result === 'seated' && canonicalJson(second) === canonicalJson(first), 'the SAME intent presented twice returns the recorded receipt')
  check(readFileSync(keysPath, 'utf8') === afterFirst, '  …and writes nothing the second time — the journal entry is the replay guard, not a hope')

  // A fresh signature for the same key is a different event id, so the journal does not stop it —
  // the file does, and it must say already-seated rather than appending a duplicate.
  const again = JSON.parse(runChannelSeat(sign(approverSk, BODY, { at: NOW + 1 }), config, { now: NOW + 1 }))
  check(again.result === 'already-seated', 'a fresh intent for a key already in the file is already-seated')
  check(readFileSync(keysPath, 'utf8') === afterFirst, '  …and still writes nothing')

  const rotated = JSON.parse(runChannelSeat(sign(approverSk, { ...BODY, key: PUB_LINE.replace(/AAAAC3/, 'AAAAC4') }, { at: NOW + 2 }), config, { now: NOW + 2 }))
  check(rotated.result === 'conflict', 'a second key for the same agent is a conflict')
  check(readFileSync(keysPath, 'utf8') === afterFirst, '  …and the file is untouched, so the old key is not silently left beside a new one')

  const before = readdirSync(journal).length
  const refused = JSON.parse(runChannelSeat(sign(strangerSk, BODY, { at: NOW + 3 }), config, { now: NOW + 3 }))
  check(refused.result === 'refused' && refused.fingerprint === null, 'an unsigned-by-an-approver intent is refused')
  check(readdirSync(journal).length === before,
    '  …and is NOT journalled — an event this runner would not verify is not a fact worth keeping, and writing it would let a stranger fill the directory')
  check(readFileSync(keysPath, 'utf8') === afterFirst, '  …and writes nothing, which is the only part that matters')
}

// ------------------------------------------------------------------------------------------
console.log('\n8. the forced command takes no argv, and the agent side never defaults to a pass')
{
  const toolSrc = readFileSync(join(ROOT, 'tools', 'channel-seat.mjs'), 'utf8')
  check(/process\.argv\.length !== 2/.test(toolSrc), 'tools/channel-seat.mjs refuses arguments — a forced command that reads argv is one whose caller chose part of the operation')
  check(/WAGGLE_SEAT_CONFIG_FILE/.test(toolSrc) && !/process\.argv\[2\]/.test(toolSrc), 'and takes its config path from the environment the unit sets, never from the caller')

  const connectSrc = readFileSync(join(ROOT, 'tools', 'connect-agent.mjs'), 'utf8')
  const row = /see\('channel-authorized',([^)]*)\)/.exec(connectSrc)
  check(row && /seat\.seated/.test(row[1]), 'connect-agent reports the row from the receipt verdict')
  check(row && !/,\s*true\s*,/.test(row[1]), '  …and never hardcodes a pass into it')
  check(/--seat-receipt/.test(connectSrc) && /the seat is UNCHECKED, not absent/.test(connectSrc),
    'and an unreadable receipt warns that the seat is UNCHECKED — a read that failed is not a seat that is missing')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
