// agent_lifecycle.mjs — the closed catalogue of lifecycle commands (#309).
//
// Drives the REAL parser and admissibility check. What this suite is for:
//
//   - the catalogue is CLOSED: an operation nobody defined is refused, including the ones that
//     arrive free on every JavaScript object;
//   - no lifecycle command can carry a credential — these events are PUBLIC, so a body with a key
//     in it is a publication, not a leak;
//   - reach is classified, and the widening operations are actually marked as widening;
//   - ordering is enforced where it is load-bearing: resume must not undo a revocation, and forget
//     must not remove the owner's only view of a live agent.
//
// Every refusal below is paired with a case that must still get through. A validator asserted only
// to reject cannot be told apart from one that rejects everything — that pairing is in this repo
// because the un-paired version shipped a live outage (2026-08-01, a name with a space in it).
//
//   node tests/agent_lifecycle.mjs

import { parseLifecycleCommand, lifecycleAdmissible, lifecycleReceipt, LIFECYCLE_OPERATIONS,
  LIFECYCLE_OPERATION_NAMES, LIFECYCLE_VERSION, LIFECYCLE_COMMAND_D, REACH } from '../src/agent_lifecycle.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
// A refusal assertion must name the reason it expects. Without that, a body that blew up for an
// entirely unrelated reason still counts as "refused" and the assertion proves nothing.
// It also must never THROW here. A parser that throws on a hostile body is a parser a stranger can
// stop, and — found by mutation-testing this suite — a throw inside the helper kills the runner and
// hides every assertion after it, so a disarmed guard reads as a crash rather than as a failure.
// Fail, report, continue.
const refused = (body, label, want) => {
  let r
  try { r = parseLifecycleCommand(body) } catch (e) { return check(false, `${label} — THREW instead of refusing: ${e.message}`) }
  if (r.ok !== false) return check(false, `${label} (was accepted)`)
  check(r.reason.includes(want), r.reason.includes(want) ? label : `${label} — wrong reason: ${r.reason}`)
}

const AGENT = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const admit = { v: 1, op: 'agent_admit', agent: AGENT }

// ---- the catalogue is closed and self-describing ------------------------------------------------
check(Object.isFrozen(LIFECYCLE_OPERATIONS), 'the catalogue is frozen — a caller cannot add an operation at runtime')
check(LIFECYCLE_OPERATION_NAMES.length === 7, 'seven operations are defined')
check(LIFECYCLE_OPERATION_NAMES.every(n => LIFECYCLE_OPERATIONS[n].limits.length > 20),
  'every operation states its limits — the console renders these, so an empty one is a UI that overclaims')
check(LIFECYCLE_COMMAND_D === 'waggle-agent-lifecycle', 'the lane has its own d-tag, distinct from the watchlist and trust lanes')

// ---- the honest-limits claims this repo has got wrong before -------------------------------------
// These are assertions about WORDING because the wording is the safety property: a console that
// says an agent can read the community has told an owner something untrue about their walls.
check(/mentions only/i.test(LIFECYCLE_OPERATIONS.agent_return_lane.limits),
  'the return lane states MENTIONS ONLY — it is not read access')
check(!/\bread access\b/i.test(LIFECYCLE_OPERATIONS.agent_return_lane.summary),
  'and its summary does not claim read access')
check(/WRITE half/i.test(LIFECYCLE_OPERATIONS.agent_admit.limits),
  'admit states it grants the write half only')
check(/does not.*runtime|not reach the agent/i.test(LIFECYCLE_OPERATIONS.agent_revoke.limits),
  'revoke states it cannot reach the agent\'s own runtime — revoked is not disarmed')
// Scoped to `summary`, which is where a CLAIM lives. `limits` is scanned separately below, because
// the phrase we want there is the negated one — "does not delete or rotate the agent's key" is the
// honest disclaimer, and an assertion blunt enough to fail on it would push the wording the wrong way.
check(!LIFECYCLE_OPERATION_NAMES.some(n => /(delete|destroy|rotate|erase)[^.]*\bkey\b/i.test(LIFECYCLE_OPERATIONS[n].summary)),
  'no operation SUMMARY claims to delete, rotate or destroy a key the bridge never held')
check(LIFECYCLE_OPERATION_NAMES.every(n => {
  const m = LIFECYCLE_OPERATIONS[n].limits.match(/[^.]*\b(delete|destroy|rotate|erase)\b[^.]*/gi) || []
  // Every sentence that mentions destroying a key must be a denial of doing so.
  return m.every(s => /\b(does not|cannot|never|not)\b/i.test(s))
}), 'PAIR: where limits mention deleting or rotating a key at all, it is always a denial')

// ---- reach classification ------------------------------------------------------------------------
const widens = LIFECYCLE_OPERATION_NAMES.filter(n => LIFECYCLE_OPERATIONS[n].reach === REACH.WIDENS)
check(widens.sort().join(',') === 'agent_admit,agent_resume,agent_return_lane',
  'exactly the three operations that grow an agent\'s reach are marked as widening')
check(LIFECYCLE_OPERATIONS.agent_revoke.reach === REACH.NARROWS && LIFECYCLE_OPERATIONS.agent_pause.reach === REACH.NARROWS,
  'PAIR: the withdrawing operations are marked as narrowing, so the classification distinguishes')
check(parseLifecycleCommand(admit).reach === REACH.WIDENS, 'a parsed command carries its reach to the caller')

// ---- happy paths, stated FIRST so every refusal below has a working counterpart ------------------
check(parseLifecycleCommand(admit).ok === true, 'a well-formed admit is accepted')
check(parseLifecycleCommand(admit).agent === AGENT, 'and carries the agent through')
const renamed = parseLifecycleCommand({ v: 1, op: 'agent_rename', agent: AGENT, label: 'My Dude' })
check(renamed.ok === true && renamed.label === 'My Dude',
  'a label with a SPACE in it is accepted — the fixture that a one-sided validator once dropped in production')
const lane = parseLifecycleCommand({ v: 1, op: 'agent_return_lane', agent: AGENT, enabled: false })
check(lane.ok === true && lane.enabled === false, 'enabled:false is accepted and not confused with absent')
check(LIFECYCLE_OPERATION_NAMES.filter(n => LIFECYCLE_OPERATIONS[n].fields.join() === 'agent')
  .every(n => parseLifecycleCommand({ v: 1, op: n, agent: AGENT }).ok === true),
  'PAIR: every single-field operation in the catalogue parses — none is unreachable')

// ---- the catalogue refuses what it does not name --------------------------------------------------
refused({ v: 1, op: 'agent_delete', agent: AGENT }, 'refuses an operation nobody defined', 'unknown lifecycle operation')
// The sharp one: these resolve through Object.prototype on a bare index or an `in` check.
for (const inherited of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
  refused({ v: 1, op: inherited, agent: AGENT }, `refuses the inherited property '${inherited}' as an operation`, 'unknown lifecycle operation')
}
refused({ v: 1, op: 'AGENT_ADMIT', agent: AGENT }, 'refuses a case-varied operation name rather than normalising it', 'unknown lifecycle operation')
refused({ v: 1, op: 42, agent: AGENT }, 'refuses a non-string operation', 'unknown lifecycle operation')

// ---- no credential ever crosses -------------------------------------------------------------------
// These events are published to public relays. A body with a key in it is not a leak — it is a
// publication, and it is not undoable.
for (const field of ['nsec', 'privkey', 'private_key', 'secret', 'seed', 'mnemonic', 'bunker_uri', 'client_key', 'token']) {
  refused({ v: 1, op: 'agent_admit', agent: AGENT, [field]: 'x' }, `refuses a body carrying '${field}'`, '')
}
check(parseLifecycleCommand(admit).ok === true,
  'PAIR: the same body without a secret-bearing field is still accepted, so the screen is not refusing everything')
// And the exact-key-set rule catches the ones the pattern does not name.
refused({ v: 1, op: 'agent_admit', agent: AGENT, extra: 'x' }, 'refuses an unrecognised extra field rather than ignoring it', 'invalid command body')
refused({ v: 1, op: 'agent_rename', agent: AGENT }, 'refuses a rename with its label missing', 'invalid command body')

// ---- shape --------------------------------------------------------------------------------------
refused(null, 'refuses a null body', 'invalid command body')
refused([1, 2], 'refuses an array body', 'invalid command body')
refused({ v: 2, op: 'agent_admit', agent: AGENT }, 'refuses a future version rather than guessing', 'unsupported lifecycle version')
refused({ op: 'agent_admit', agent: AGENT }, 'refuses a body with no version', 'unsupported lifecycle version')
refused({ v: 1, op: 'agent_admit', agent: 'not-hex' }, 'refuses a malformed agent key', '64-hex')
refused({ v: 1, op: 'agent_admit', agent: AGENT.slice(0, 63) }, 'refuses a short agent key', '64-hex')
refused({ v: 1, op: 'agent_rename', agent: AGENT, label: '' }, 'refuses an empty label', 'label must be')
refused({ v: 1, op: 'agent_rename', agent: AGENT, label: 'x'.repeat(65) }, 'refuses an over-long label', 'label must be')
refused({ v: 1, op: 'agent_rename', agent: AGENT, label: 'two\nlines' }, 'refuses a newline in a label', 'label must be')
refused({ v: 1, op: 'agent_return_lane', agent: AGENT, enabled: 'true' }, 'refuses a stringy boolean', 'must be a boolean')
check(parseLifecycleCommand({ v: 1, op: 'agent_admit', agent: AGENT.toUpperCase() }).agent === AGENT,
  'PAIR: an upper-case key is accepted and normalised — the hex check is not merely case-strict')

// It must not throw on hostile input: a handler a stranger can crash is a handler a stranger can stop.
let threw = false
for (const hostile of [undefined, 0, '', 'string', true, Object.create(null), { v: 1, op: { toString () { throw new Error('boom') } } }]) {
  try { parseLifecycleCommand(hostile) } catch { threw = true }
}
check(!threw, 'never throws on hostile input — including a body whose op stringifies by throwing')

// ---- admissibility: ordering, which is a different failure from shape ---------------------------
const row = status => ({ agent: AGENT, status })
check(lifecycleAdmissible(parseLifecycleCommand(admit), null).ok === true,
  'an unknown agent may be admitted — that is what admission is for')
check(lifecycleAdmissible(parseLifecycleCommand({ v: 1, op: 'agent_revoke', agent: AGENT }), null).ok === false,
  'PAIR: an unknown agent may NOT be revoked, so "unknown" is not a blanket pass')

// The sharp case: resume must not quietly undo a revocation.
const resume = parseLifecycleCommand({ v: 1, op: 'agent_resume', agent: AGENT })
const undoRevoke = lifecycleAdmissible(resume, row('revoked'))
check(undoRevoke.ok === false && /cannot resume a revoked agent/.test(undoRevoke.reason),
  'resume REFUSES a revoked agent — pausing and revoking are different decisions')
check(lifecycleAdmissible(resume, row('paused')).ok === true && lifecycleAdmissible(resume, row('paused')).noop === false,
  'PAIR: resume still works on a paused agent, so the refusal is about revocation, not about resume')

// And forget must not remove the owner's only view of something still being routed.
const forget = parseLifecycleCommand({ v: 1, op: 'agent_forget', agent: AGENT })
check(lifecycleAdmissible(forget, row('admitted')).ok === false, 'forget REFUSES a live agent')
check(/revoke this agent before/.test(lifecycleAdmissible(forget, row('admitted')).reason), 'and says what to do instead')
check(lifecycleAdmissible(forget, row('revoked')).ok === true, 'PAIR: forget works once the agent is revoked')
check(forget.destructive === true, 'forget is the only operation marked destructive')
check(LIFECYCLE_OPERATION_NAMES.filter(n => LIFECYCLE_OPERATIONS[n].destructive).join() === 'agent_forget',
  'PAIR: and nothing else is, so the flag distinguishes')

// A retried command is a no-op, not an error — an owner clicking twice must not see an alarm.
check(lifecycleAdmissible(parseLifecycleCommand(admit), row('admitted')).noop === true, 're-admitting is a no-op, not a failure')
check(lifecycleAdmissible(parseLifecycleCommand({ v: 1, op: 'agent_revoke', agent: AGENT }), row('revoked')).noop === true,
  're-revoking is a no-op, not a failure')
check(lifecycleAdmissible(parseLifecycleCommand(admit), row('admitted')).ok === true, 'and a no-op still reports ok')
check(lifecycleAdmissible({ ok: false, reason: 'x' }, row('admitted')).ok === false, 'a refused parse is never admissible')

// ---- the receipt names the reach --------------------------------------------------------------
const receipt = lifecycleReceipt(parseLifecycleCommand(admit), { approver: OTHER, at: '2026-08-08T00:00:00.000Z', eventId: 'e'.repeat(64) })
check(receipt.reach === REACH.WIDENS, 'the receipt names the reach — a log line saying only "agent_admit" hides that reach grew')
check(receipt.limits === LIFECYCLE_OPERATIONS.agent_admit.limits, 'and carries the operation\'s limits verbatim')
check(!/[0-9a-f]{40}/.test(JSON.stringify(receipt)), 'the receipt truncates keys — presentation, since these are public keys anyway')
check(receipt.v === LIFECYCLE_VERSION && receipt.at === '2026-08-08T00:00:00.000Z', 'the receipt is versioned and timestamped')

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
