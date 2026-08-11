// agent_lifecycle_lane.mjs — the lifecycle command's ENVELOPE, on the real bridge (#309).
//
// `tests/agent_lifecycle.mjs` drives the pure catalogue. This one drives `handleAgentLifecycleCommand`
// itself, with a real signer and a real config, because the envelope is the half that decides WHO may
// speak — and it is the half the catalogue cannot check.
//
// The events are signed here, not hand-built, and every one is passed through a JSON round trip
// before the handler sees it. That is not tidiness: `finalizeEvent` stamps nostr-tools' internal
// `verifiedSymbol` on the object it returns, and `verifyEvent` short-circuits on it — so a handler
// fed the raw object verifies a signature it never actually checked. A tampered event would pass.
// The round trip is what makes the signature assertions mean anything.
//
// Every refusal is paired with an acceptance.
//
//   node tests/agent_lifecycle_lane.mjs

import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'

const tmp = mkdtempSync(join(tmpdir(), 'wb-lifecycle-lane-'))
const CFG = join(tmp, 'config.json')
const ROWS = join(tmp, 'agent-rows.json')
const CHANNEL = '77777777-7777-7777-7777-777777777777'

const bridgeSk = generateSecretKey()
const bridgePk = getPublicKey(bridgeSk)
const approverSk = generateSecretKey(), approver = getPublicKey(approverSk)
const strangerSk = generateSecretKey()
const AGENT = 'a'.repeat(64)

process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'dryrun'
process.env.CONFIG_PATH = CFG
process.env.AGENTROWS_PATH = ROWS
process.env.SEEN_PATH = join(tmp, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(tmp, 'watermark')
process.env.POSTED_MAP_PATH = join(tmp, 'posted.log')
process.env.MIRRORASKED_PATH = join(tmp, 'asked.log')
process.env.RELAYSEEN_PATH = join(tmp, 'relay-lane-seen.log')
writeFileSync(CFG, JSON.stringify({
  relays: [], recipients: [],
  public: { relays: [], inbox: CHANNEL, staging_inbox: CHANNEL, watch_authors: [], watch_events: [],
    approvers: [approver], grantors: [approver], owner_pubkey: approver },
}))

const { handleAgentLifecycleCommand, loadAgentRows, CONTROL_COMMAND_KIND, LIFECYCLE_COMMAND_D } =
  await import('../src/bridge.mjs')

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

// The round trip described in the header. Never "tidy" this away.
const wire = ev => JSON.parse(JSON.stringify(ev))
const now = () => Math.floor(Date.now() / 1000)
const sign = (body, { sk = approverSk, d = LIFECYCLE_COMMAND_D, p = bridgePk, at = now(), tags } = {}) =>
  wire(finalizeEvent({ kind: CONTROL_COMMAND_KIND, created_at: at,
    tags: tags || [['d', d], ['p', p]], content: JSON.stringify(body) }, sk))

// Each command needs a created_at strictly newer than the watermark the last one set, so the
// monotonic check does not reject a legitimate follow-up. Stepping forward one second per command
// keeps that explicit rather than relying on wall-clock luck.
let clock = now() - 200
const at = () => ++clock

const admit = { v: 1, op: 'agent_admit', agent: AGENT }

// ---- the positive control, stated before any refusal --------------------------------------------
const first = handleAgentLifecycleCommand(sign(admit, { at: at() }))
check(first.ok === true, 'an approver-signed, correctly addressed, fresh lifecycle command is ACCEPTED')
check(loadAgentRows()[AGENT]?.status === 'admitted', 'and the agent row is persisted as admitted')
check(first.receipt?.reach === 'widens', 'the result carries the reach, so a log or console cannot hide that reach grew')

// ---- who may speak ------------------------------------------------------------------------------
const byStranger = handleAgentLifecycleCommand(sign({ v: 1, op: 'agent_revoke', agent: AGENT }, { sk: strangerSk, at: at() }))
check(byStranger.ok === false && /not an approver/.test(byStranger.reason),
  'a correctly-formed command from a NON-approver is refused')
check(loadAgentRows()[AGENT]?.status === 'admitted', 'and it changed nothing — the row is untouched')

// A forged signature: take a valid approver event and swap the content underneath it.
const valid = sign({ v: 1, op: 'agent_revoke', agent: AGENT }, { at: at() })
const tampered = { ...valid, content: JSON.stringify({ v: 1, op: 'agent_admit', agent: 'b'.repeat(64) }) }
const forged = handleAgentLifecycleCommand(tampered)
check(forged.ok === false && /invalid signature/.test(forged.reason),
  'a tampered body is refused — the signature is actually checked, not merely present')

// ---- addressing ---------------------------------------------------------------------------------
const wrongLane = handleAgentLifecycleCommand(sign(admit, { d: 'waggle-watchlist', at: at() }))
check(wrongLane.ok === false && /addressed/.test(wrongLane.reason),
  'a command on ANOTHER lane\'s d-tag is refused — lanes do not bleed into each other')
const wrongBridge = handleAgentLifecycleCommand(sign(admit, { p: 'c'.repeat(64), at: at() }))
check(wrongBridge.ok === false && /addressed/.test(wrongBridge.reason),
  'a command addressed to a DIFFERENT bridge is refused')
const extraTag = handleAgentLifecycleCommand(sign(admit, { at: at(), tags: [['d', LIFECYCLE_COMMAND_D], ['p', bridgePk], ['x', 'y']] }))
check(extraTag.ok === false && /addressed/.test(extraTag.reason), 'an extra tag is refused rather than ignored')

// ---- freshness and replay -----------------------------------------------------------------------
const stale = handleAgentLifecycleCommand(sign(admit, { at: now() - 3600 }))
check(stale.ok === false && /stale/.test(stale.reason), 'an hour-old command is refused')
const future = handleAgentLifecycleCommand(sign(admit, { at: now() + 3600 }))
check(future.ok === false, 'a command from the future is refused')
// Same refusal, DIFFERENT diagnosis. Reporting a future-dated event as 'stale' is the misleading
// string an operator reads while chasing clock skew — the future case almost always means the
// signer's clock is ahead, not that anything is old.
check(/future/.test(future.reason) && !/stale/.test(future.reason),
  'and says it is FUTURE-dated rather than stale — the two are different diagnoses for an operator')
check(stale.reason !== future.reason, 'so the two refusals are actually distinguishable, not the same string twice')

// Replay: re-submitting the accepted revoke below must not take effect twice.
const revokeAt = at()
const revoke = sign({ v: 1, op: 'agent_revoke', agent: AGENT }, { at: revokeAt })
check(handleAgentLifecycleCommand(revoke).ok === true, 'PAIR: a fresh revoke IS accepted')
check(loadAgentRows()[AGENT]?.status === 'revoked', 'and the row is now revoked')
const replayed = handleAgentLifecycleCommand(revoke)
check(replayed.ok === false && /superseded/.test(replayed.reason),
  'replaying that exact event is refused — the watermark is monotonic, so an old relay copy cannot turn a decision back over')

// ---- ordering reaches the lane, not just the pure module ------------------------------------------
const resumeRevoked = handleAgentLifecycleCommand(sign({ v: 1, op: 'agent_resume', agent: AGENT }, { at: at() }))
check(resumeRevoked.ok === false && /cannot resume a revoked agent/.test(resumeRevoked.reason),
  'resume cannot quietly undo a revocation THROUGH THE LANE either')
check(loadAgentRows()[AGENT]?.status === 'revoked', 'and the row stayed revoked')

// ---- forget removes the row, and only after revocation --------------------------------------------
check(handleAgentLifecycleCommand(sign({ v: 1, op: 'agent_forget', agent: AGENT }, { at: at() })).ok === true,
  'PAIR: forget is accepted once the agent is revoked')
check(!(AGENT in loadAgentRows()), 'and the row is gone from the projection')

// ---- a body the catalogue rejects never reaches the store ------------------------------------------
const unknownOp = handleAgentLifecycleCommand(sign({ v: 1, op: 'agent_nuke', agent: AGENT }, { at: at() }))
check(unknownOp.ok === false && /unknown lifecycle operation/.test(unknownOp.reason),
  'an operation outside the catalogue is refused at the lane')
const withSecret = handleAgentLifecycleCommand(sign({ v: 1, op: 'agent_admit', agent: AGENT, nsec: 'x' }, { at: at() }))
check(withSecret.ok === false, 'a body carrying a secret-bearing field is refused at the lane')
check(!(AGENT in loadAgentRows()), 'and neither wrote a row')

// ---- the closing pair: after every refusal above, a legitimate command still works ----------------
const finalAdmit = handleAgentLifecycleCommand(sign(admit, { at: at() }))
check(finalAdmit.ok === true && loadAgentRows()[AGENT]?.status === 'admitted',
  'PAIR: after all of the above, a legitimate command is still accepted — the lane refuses duplicates and forgeries, not everything')

// ---- same-second commands: the watermark keeps an id set, not just a timestamp -------------------
// Nostr timestamps are one-second resolution and lifecycle commands target INDEPENDENT rows, so a
// same-second pair is legitimate work, not a duplicate. A timestamp-only watermark dropped the
// second one silently — and defeated this handler's own no-op path, because an owner clicking twice
// lands inside a single second. Note this suite deliberately steps a synthetic clock everywhere
// else; that is exactly why the defect could hide, so it is pinned explicitly here.
const AGENT_B = 'd'.repeat(64), AGENT_C = 'e'.repeat(64)
const sameSecond = at()
const firstOfSecond = handleAgentLifecycleCommand(sign({ v: 1, op: 'agent_admit', agent: AGENT_B }, { at: sameSecond }))
check(firstOfSecond.ok === true, 'the first command in a second is accepted')
const secondOfSecond = sign({ v: 1, op: 'agent_admit', agent: AGENT_C }, { at: sameSecond })
const secondResult = handleAgentLifecycleCommand(secondOfSecond)
check(secondResult.ok === true,
  'a DISTINCT second command signed in the SAME second is also accepted — two console actions one second apart in wall-clock terms are not a replay')
check(loadAgentRows()[AGENT_B]?.status === 'admitted' && loadAgentRows()[AGENT_C]?.status === 'admitted',
  'and BOTH rows are persisted — the second decision was not silently dropped')
// PAIR: the id set must still close the replay door it exists to hold. Same second, same id.
const sameSecondReplay = handleAgentLifecycleCommand(secondOfSecond)
check(sameSecondReplay.ok === false && /superseded/.test(sameSecondReplay.reason),
  'PAIR: replaying that exact same-second event IS still refused — the id set widens the watermark without opening it')
// And a genuinely older command is still refused, so the monotonic floor survives the change.
const older = handleAgentLifecycleCommand(sign({ v: 1, op: 'agent_admit', agent: AGENT_B }, { at: sameSecond - 5 }))
check(older.ok === false && /superseded/.test(older.reason), 'PAIR: a command older than the watermark is still refused')

// ---- widening reach must not apply to a revoked row ----------------------------------------------
// agent_return_lane WIDENS reach. On a revoked row it is an undone revocation by the side door:
// the projection would publish return_lane true for a key the owner believes is cut off.
check(handleAgentLifecycleCommand(sign({ v: 1, op: 'agent_revoke', agent: AGENT_B }, { at: at() })).ok === true,
  'AGENT_B is revoked, to set up the widening case')
const widenRevoked = handleAgentLifecycleCommand(sign({ v: 1, op: 'agent_return_lane', agent: AGENT_B, enabled: true }, { at: at() }))
check(widenRevoked.ok === false && /revoked/.test(widenRevoked.reason),
  'enabling the return lane on a REVOKED agent is refused — revocation cannot be undone by the side door')
check(loadAgentRows()[AGENT_B]?.return_lane !== true, 'and the row did not gain the widened reach')
// PAIR: the same op on a live agent still works, so this refuses the dangerous case, not the feature.
const widenLive = handleAgentLifecycleCommand(sign({ v: 1, op: 'agent_return_lane', agent: AGENT_C, enabled: true }, { at: at() }))
check(widenLive.ok === true, 'PAIR: the same op on an ADMITTED agent is still accepted')
// PAIR: a rename — which does NOT widen reach — stays admissible on a revoked row.
const renameRevoked = handleAgentLifecycleCommand(sign({ v: 1, op: 'agent_rename', agent: AGENT_B, label: 'retired probe' }, { at: at() }))
check(renameRevoked.ok === true,
  'PAIR: renaming a revoked agent is still allowed — the refusal is about REACH, not about the row being revoked')

// ---- an unreadable ledger is not an empty one ----------------------------------------------------
// Reading a torn or permission-denied rows file as {} let the next accepted command rename a
// single-row object over the top, erasing every other agent including revoked markers.
const goodRows = readFileSync(ROWS, 'utf8')
writeFileSync(ROWS, '{ this is not json')
const onTornRows = handleAgentLifecycleCommand(sign({ v: 1, op: 'agent_admit', agent: AGENT }, { at: at() }))
check(onTornRows.ok === false && /unreadable/.test(onTornRows.reason),
  'a command against a TORN rows file is refused, not applied against an empty ledger')
check(readFileSync(ROWS, 'utf8') === '{ this is not json',
  'and the torn file was not overwritten — the other agents\' rows are still recoverable')
// PAIR: restore the file and the identical command is accepted, so this refuses the fault, not the op.
writeFileSync(ROWS, goodRows)
const afterRestore = handleAgentLifecycleCommand(sign({ v: 1, op: 'agent_admit', agent: AGENT }, { at: at() }))
check(afterRestore.ok === true, 'PAIR: with the ledger readable again, the same command is accepted')
check(loadAgentRows()[AGENT_C]?.status === 'admitted',
  'and the previously-written rows survived — nothing was erased by the refused command')

if (existsSync(ROWS)) unlinkSync(ROWS)
console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
