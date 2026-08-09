// host_bootstrap.mjs — the idempotent host consumer of the #305 install state.
//
// Drives the REAL planner. The properties that matter and their failure modes:
//   - re-running converges: a host that already satisfies everything plans NOTHING (an installer
//     that re-does satisfied work is how a live directory gets recreated empty);
//   - an unreadable fact is BLOCKED, never treated as absent — a failed probe that looks like a
//     missing directory gets "fixed" by overwriting a live one;
//   - blocked outranks satisfied in the verdict, so a plan we could not fully see never exits 0;
//   - users are planned before the directories they own, and the deploy runner last;
//   - nothing ever plans to write a credential.
//
// Every refusal is paired with a case that must still get through.
//
//   node tests/host_bootstrap.mjs

import { planHostBootstrap, pendingActions, bootstrapVerdict, bootstrapEvidence, ACTION_KINDS } from '../src/host_bootstrap.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const refuses = (fn, label, want) => {
  try { fn(); check(false, `${label} (no refusal)`) } catch (e) {
    const named = e.message.startsWith('host-bootstrap: ') && e.message.includes(want)
    check(named, named ? label : `${label} — wrong error: ${e.message}`)
  }
}

// A realistic installation id — `install_state.mjs` mints `waggle-<24 hex>`, and `hive.id` beside it
// is a 64-hex PUBLIC KEY. Both are carried here so the "no identity in a path" assertion below is
// tested against the shape the wizard actually produces, not a convenient stand-in.
const HIVE_PUBKEY = 'c'.repeat(64)
const state = { installation_id: 'waggle-0123456789abcdef01234567', hive: { id: HIVE_PUBKEY } }
const plan = planHostBootstrap(state)
const byId = id => plan.find(a => a.id === id)
const idx = id => plan.findIndex(a => a.id === id)

// ---- the plan is well-formed ------------------------------------------------------------------
check(plan.length > 0, 'a bare install state produces a plan')
check(plan.every(a => ACTION_KINDS.includes(a.kind)), 'every action names a kind from the closed catalogue')
check(Object.isFrozen(plan) && plan.every(Object.isFrozen), 'the plan and its actions are frozen')
check(plan.every(a => a.destructive === false), 'no action in a fresh plan is destructive')

// ---- ordering is a safety property, not cosmetics ----------------------------------------------
for (const role of ['watcher', 'broker', 'adapter', 'worker']) {
  check(idx(`user:${role}`) >= 0, `plans the ${role} system user`)
}
check(idx('user:broker') < idx('dir:state'), 'users are planned BEFORE the directories they own')
check(idx('time:ntp') < idx('unit:waggle-read'), 'the clock is planned BEFORE anything that signs')
check(idx('deploy:runner') === plan.length - 1, 'the deploy runner is planned LAST — it must not run before the host is formed')

// ---- no identity ever lands in a path ----------------------------------------------------------
// A directory name is not a secret store, but it is copied into backups, logs, ps output and every
// error message that prints a path. The hive id is a public key; it does not belong in any of them.
const asText = JSON.stringify(plan)
check(!asText.includes(HIVE_PUBKEY), 'the hive public key appears nowhere in the plan — paths key on the installation id')
check(plan.filter(a => a.kind === 'directory').every(a => a.want.path.includes(state.installation_id)),
  'PAIR: every data directory IS keyed on the installation id, so the check above is not vacuously true')

// ---- the credential directory is created, never populated --------------------------------------
const cred = byId('dir:credentials')
check(cred?.kind === 'directory' && cred.mode === '0700', 'the credential directory is planned as an empty 0700 directory')
check(!plan.some(a => /credential/i.test(a.id) && a.kind !== 'directory'),
  'nothing plans to WRITE a credential — seating them is an operator act')

// ---- idempotence: a satisfied host plans nothing ------------------------------------------------
const allSatisfied = { present: Object.fromEntries(plan.map(a => [a.id, true])) }
const second = planHostBootstrap(state, allSatisfied)
check(second.every(a => a.state === 'satisfied'), 'a host that already satisfies everything reports every action satisfied')
check(pendingActions(second).length === 0, 'and plans NO work on the second run — re-running converges')
check(bootstrapVerdict(second).exit === 0, 'a fully satisfied host exits 0')

// PAIR: the same planner on a bare host still finds work, so "plans nothing" is not "always nothing".
check(pendingActions(plan).length === plan.length, 'PAIR: on a bare host every action is still pending')
check(bootstrapVerdict(plan).exit === 1, 'PAIR: a bare host does not exit 0')

// ---- unreadable facts are blocked, never assumed absent -----------------------------------------
const blind = planHostBootstrap(state, { present: {}, unreadable: ['dir:state'] })
const blindState = blind.find(a => a.id === 'dir:state')
check(blindState.state === 'blocked', 'an unreadable fact is BLOCKED, not planned as missing')
check(!pendingActions(blind).some(a => a.id === 'dir:state'), 'a blocked action is not actionable — it is never applied blind')
check(/refusing to act blind/.test(blindState.reason), 'the blocked action says why it refused')

// The sharp case: everything else satisfied, one thing unreadable. This must NOT read as success.
const mostlyDone = planHostBootstrap(state,
  { present: Object.fromEntries(plan.filter(a => a.id !== 'dir:state').map(a => [a.id, true])), unreadable: ['dir:state'] })
const v = bootstrapVerdict(mostlyDone)
check(v.status === 'inconclusive' && v.exit === 3,
  'one unreadable fact makes the whole run INCONCLUSIVE (exit 3), even with everything else satisfied')
// PAIR: make that same fact readable and satisfied, and it exits 0 — so exit 3 is about sight, not
// about an always-failing check.
const nowVisible = planHostBootstrap(state, { present: Object.fromEntries(plan.map(a => [a.id, true])) })
check(bootstrapVerdict(nowVisible).exit === 0, 'PAIR: with that fact readable and satisfied, the same host exits 0')

// ---- drift is reported, not silently corrected --------------------------------------------------
const drift = planHostBootstrap(state, { present: { 'code:waggle': { ref: 'some-other-ref' } } })
const drifted = drift.find(a => a.id === 'code:waggle')
check(drifted.state === 'drifted', 'a host fact that disagrees with the desired state is DRIFT')
check(/host reports/.test(drifted.reason), 'drift reports what the host actually said')
check(bootstrapVerdict(drift).status === 'drifted', 'drift is its own verdict, not folded into incomplete')

// ---- pinned ref ----------------------------------------------------------------------------------
const pinned = planHostBootstrap({ ...state, pinned_ref: 'v1.2.3' })
check(pinned.find(a => a.id === 'code:waggle').want.ref === 'v1.2.3', 'a pinned ref is carried into the checkout')
check(pinned.find(a => a.id === 'deploy:runner').want.pinned === true, 'and the deploy runner records that it is pinned')
check(planHostBootstrap(state).find(a => a.id === 'deploy:runner').want.pinned === false,
  'PAIR: unpinned installs report unpinned, so the flag means something')

// ---- evidence -------------------------------------------------------------------------------------
const ev = bootstrapEvidence(second, bootstrapVerdict(second), { at: '2026-08-09T02:00:00.000Z' })
check(ev.checked_at === '2026-08-09T02:00:00.000Z' && ev.status === 'satisfied',
  'evidence records WHEN the check ran and what it found')
check(ev.actions_satisfied === second.length, 'evidence counts what was actually satisfied')
const blindEv = bootstrapEvidence(mostlyDone, v)
check(blindEv.actions_blocked === 1, 'evidence carries the blocked count rather than hiding it')

// ---- shape refusals ---------------------------------------------------------------------------
refuses(() => planHostBootstrap(null), 'refuses a missing install state', 'install state is required')
refuses(() => planHostBootstrap({}), 'refuses a state with no installation id', 'usable installation id')
refuses(() => planHostBootstrap({ installation_id: 'Not Valid!' }), 'refuses a malformed installation id', 'usable installation id')
check(planHostBootstrap({ installation_id: 'ok-id' }).length > 0, 'PAIR: a well-formed installation id still plans')

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
