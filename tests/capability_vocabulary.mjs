// capability_vocabulary.mjs — the tables that tell an owner what a capability means must agree.
//
// This suite exists because the vocabulary just stopped being single-reader. It lived inline in
// console/index.html; the join approval card (docs/DESIGN_JOIN.md) is the second reader, and two
// screens rendering the same grant from two tables is how an approval screen ends up describing
// a grant it does not issue — the owner reads one sentence and signs another.
//
// The properties here are about what a PERSON is told, and each has a way of being wrong that
// still renders perfectly:
//
//   - a cap with a label but no enforcer renders as an action with nobody checking it, which is
//     the exact "recording intent and implying enforcement" defect the enforcer table exists for
//   - an issuable cap missing from the label table renders as a raw protocol string in a dropdown
//   - a confident fallback tells an owner their bridge checks something it has never heard of
//
//   node tests/capability_vocabulary.mjs

import { CAP_LABEL, capLabel, CAP_ENFORCER, capEnforcer, ISSUABLE, BRIDGE_ENFORCED, isBridgeEnforced }
  from '../console/capability-vocabulary.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const labelled = Object.keys(CAP_LABEL).sort()
const enforced = Object.keys(CAP_ENFORCER).sort()

// ── The two tables cover exactly the same capabilities ──────────────────────────────────────
check(labelled.length > 0 && labelled.join() === enforced.join(),
  `every capability with a label has an enforcer and vice versa (${labelled.length} caps)`)
for (const cap of labelled) {
  check(typeof CAP_LABEL[cap] === 'string' && CAP_LABEL[cap].trim() !== '' && CAP_LABEL[cap] !== cap,
    `"${cap}" is translated into something a person reads, not echoed back as protocol`)
  check(typeof CAP_ENFORCER[cap] === 'string' && CAP_ENFORCER[cap].trim() !== '',
    `"${cap}" names who checks it`)
}

// ── Everything offerable is describable ─────────────────────────────────────────────────────
const issuable = Object.values(ISSUABLE).flat()
check(issuable.length > 0, `${issuable.length} issuable option(s) across ${Object.keys(ISSUABLE).length} subject shapes`)
for (const option of issuable) {
  check(Object.prototype.hasOwnProperty.call(CAP_LABEL, option.cap),
    `issuable "${option.cap}" has a human label — a dropdown must never show a raw protocol string`)
  check(option.ok === true || (typeof option.reason === 'string' && option.reason.trim() !== ''),
    `disabled option "${option.cap}" carries its reason — a greyed option with a reason teaches, a bare one confuses`)
}

// ── The two deliberate exclusions stay excluded ─────────────────────────────────────────────
// Both are load-bearing, and both would be easy to "fix" by someone tidying the table.
const channelCaps = ISSUABLE.channel.filter(o => o.ok).map(o => o.cap)
check(!channelCaps.includes('admit+read'),
  'admit+read is NOT issuable — it would convey channel key material and make revoke a Concord rotation')
check(ISSUABLE.channel.some(o => o.cap === 'admit+read' && o.ok === false),
  'but it is still OFFERED and disabled, with its reason, rather than silently missing')
check(!issuable.some(o => o.cap === 'mirror'),
  'mirror is absent entirely — it is authored by the participant about themselves, never granted by the operator')

// ── Who enforces what: the claim that must not drift ────────────────────────────────────────
// The bridge consumes admit and admit+read. The task family is enforced by the agent's runtime.
// Saying otherwise on a console tells an owner a gate exists where none does.
check(BRIDGE_ENFORCED.slice().sort().join() === ['admit', 'admit+read'].join(),
  'exactly the admit family is bridge-enforced')
for (const cap of ['task', 'task+act', 'task-relay']) {
  check(!isBridgeEnforced(cap), `"${cap}" is NOT claimed as bridge-enforced`)
  check(/runtime/.test(CAP_ENFORCER[cap]), `and "${cap}" names the agent's runtime as its checker`)
}
for (const cap of BRIDGE_ENFORCED) {
  check(isBridgeEnforced(cap) && /bridge/.test(CAP_ENFORCER[cap]),
    `"${cap}" is bridge-enforced and says so — the pair, so this cannot pass by refusing everything`)
}

// ── Unknown capabilities: visible, never confidently described ──────────────────────────────
const UNKNOWN = 'admit+something-invented-later'
check(capLabel(UNKNOWN) === UNKNOWN,
  'an unknown cap falls back to its raw protocol name, so it LOOKS unfamiliar instead of being given invented prose')
check(!/bridge|runtime/.test(capEnforcer(UNKNOWN)),
  'and its enforcer is the cautious answer — never "this bridge", which would claim a gate that does not exist')
check(capEnforcer(UNKNOWN).trim() !== '',
  'but it is not blank either — a missing enforcer must read as unknown, not as nothing to say')

// ── NEGATIVE CONTROL ────────────────────────────────────────────────────────────────────────
// Every check above has only been asked to pass. Prove the coverage comparison can actually see
// a one-sided table, by running it against a deliberately broken pair.
{
  const brokenLabels = { ...CAP_LABEL, 'task+future': 'Do a future thing' }
  const same = Object.keys(brokenLabels).sort().join() === Object.keys(CAP_ENFORCER).sort().join()
  check(!same,
    'NEGATIVE CONTROL — a cap added to the label table with no enforcer is DETECTED by the same comparison')
  check(Object.keys(CAP_LABEL).sort().join() === Object.keys(CAP_ENFORCER).sort().join(),
    'and the real tables still agree, so the control is not passing because the comparison is broken')
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
