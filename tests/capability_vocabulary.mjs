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

import { CAP_LABEL, capLabel, CAP_ENFORCER, capEnforcer, ISSUABLE, BRIDGE_ENFORCED, isBridgeEnforced,
  CAP_SENTENCE, describeGrant, CAP_SUBJECT, PLANE, PLANE_COPY }
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

// ── DIRECTION ───────────────────────────────────────────────────────────────────────────────
// The defect this section exists for: `task` was labelled "Take tasks from you", which describes
// the GRANTEE as the task-taker. tools/attention.mjs enforces the opposite — the grantee is the
// party permitted to SEND instructions, and the scope subject is the agent receiving them. An
// operator read the inverted sentence and signed a grant authorising the reverse of their intent.
// It verified, it was live, and no surface could show it; it was found by recomputing salted
// scope hashes by hand.
//
// So direction is asserted here as RENDERED OUTPUT for named parties, not as a property of a
// table. A label can be wrong in a way a schema check cannot see.
const sentenced = Object.keys(CAP_SENTENCE).sort()
check(sentenced.join() === labelled.join(),
  `every capability with a label has a sentence and vice versa (${sentenced.length} caps)`)
for (const cap of sentenced) {
  check(CAP_SENTENCE[cap].includes('{grantee}') && CAP_SENTENCE[cap].includes('{subject}'),
    `"${cap}" names BOTH parties — a template mentioning one has picked a direction the reader cannot check`)
  check(typeof CAP_SUBJECT[cap] === 'string' && ['channel', 'agent'].includes(CAP_SUBJECT[cap]),
    `"${cap}" says whether its subject is a channel or an agent`)
  check(['door', 'orders'].includes(PLANE[cap]), `"${cap}" belongs to a named plane`)
}

// The exact strings. Written out in full on purpose: this is the regression barrier, and a future
// edit that flips a direction has to change a line here that reads as an English claim.
const RENDERED = {
  'admit': 'Oliver may post into #waggle-test',
  'admit+read': 'Oliver may post into #waggle-test, and read it',
  'task': 'Oliver may send instructions to Dennis',
  'task+act': 'Oliver may send instructions to Dennis, and Dennis may act on them',
  'task-relay': 'Oliver may carry instructions addressed to Dennis',
  'mirror': "#waggle-test may mirror Oliver's public posts",
}
for (const [cap, expected] of Object.entries(RENDERED)) {
  const subject = CAP_SUBJECT[cap] === 'channel' ? '#waggle-test' : 'Dennis'
  const got = describeGrant({ cap, grantee: 'Oliver', subject })
  check(got === expected, `"${cap}" renders exactly: ${got}`)
  check(!/\{grantee\}|\{subject\}/.test(got), `"${cap}" leaves no unsubstituted placeholder`)
}

// The specific inversion, barred by name. "Take tasks from you" put the grantee on the receiving
// end; in the task family the grantee is always the one SENDING.
for (const cap of ['task', 'task+act', 'task-relay']) {
  const s = describeGrant({ cap, grantee: 'Oliver', subject: 'Dennis' })
  check(s.indexOf('Oliver') < s.indexOf('Dennis'),
    `"${cap}" puts the grantee (the instructor) before the subject (the instructed)`)
  check(!/\btakes?\b/i.test(s) && !/\bfrom you\b/i.test(s),
    `"${cap}" never describes the grantee as taking orders — that phrasing caused a misissued grant`)
  check(!/\btakes?\b/i.test(CAP_LABEL[cap]),
    `and the short label for "${cap}" agrees, so a dropdown cannot contradict the sentence`)
}

// Unknown caps must not be given an invented direction — the original defect with extra steps.
{
  const s = describeGrant({ cap: UNKNOWN, grantee: 'Oliver', subject: 'Dennis' })
  check(s.includes('Oliver') && s.includes('Dennis'), 'an unknown cap still names both parties')
  check(/does not recognise/.test(s), 'and says plainly that it does not recognise the capability')
  check(!/may send|may post|may carry/.test(s), 'without asserting any direction it cannot know')
}

// Missing parties degrade to a placeholder word rather than to an empty gap. "may post into"
// with nothing after it reads as a complete sentence about nothing.
{
  const s = describeGrant({ cap: 'admit' })
  check(/someone/.test(s) && /something/.test(s), 'a sentence with no parties supplied still reads as incomplete, not as blank')
}

// The two planes are distinguishable and each states its own enforcer, because "who checks this"
// is the difference between them and the reason they must not be shown as one list.
check(PLANE_COPY.door.enforcedBy !== PLANE_COPY.orders.enforcedBy,
  'the door and orders planes name DIFFERENT enforcers')
check(/runtime/.test(PLANE_COPY.orders.enforcedBy) && /bridge/.test(PLANE_COPY.door.enforcedBy),
  'and each names the right one')
for (const plane of ['door', 'orders']) {
  for (const field of ['title', 'question', 'enforcedBy', 'caution']) {
    check(typeof PLANE_COPY[plane][field] === 'string' && PLANE_COPY[plane][field].trim() !== '',
      `plane "${plane}" has ${field}`)
  }
}
// Every cap's plane agrees with its enforcer. Two tables saying different things about who checks
// a grant is precisely the drift this file was created to prevent.
for (const cap of sentenced) {
  const byPlane = PLANE_COPY[PLANE[cap]].enforcedBy
  const bridgeish = /bridge/.test(byPlane)
  check(bridgeish === isBridgeEnforced(cap) || cap === 'mirror',
    `"${cap}" — its plane's enforcer agrees with isBridgeEnforced()`)
}

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

// The direction assertions above have also only been asked to pass. An assertion that a sentence
// reads correctly is worthless if it would also accept the sentence read backwards — which is the
// exact failure that shipped. So render the INVERTED template and prove the same checks reject it.
{
  const inverted = '{subject} may send instructions to {grantee}'
  const rendered = inverted.replaceAll('{grantee}', 'Oliver').replaceAll('{subject}', 'Dennis')
  const orderCheck = rendered.indexOf('Oliver') < rendered.indexOf('Dennis')
  check(!orderCheck,
    'NEGATIVE CONTROL — the grantee-before-subject check REJECTS an inverted task sentence')
  const historical = 'Take tasks from you'
  check(/\btakes?\b/i.test(historical) && /\bfrom you\b/i.test(historical),
    'NEGATIVE CONTROL — the phrasing bar still matches the exact label that caused the misissued grant')
  check(!/\btakes?\b/i.test(CAP_LABEL.task),
    'and the real label does not match it, so the bar is not passing by matching nothing')
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
