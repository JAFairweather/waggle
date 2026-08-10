// connect_plan.mjs — the one place intent becomes direction, held to the direction that is
// actually enforced.
//
// tools/attention.mjs is the enforcement site for the task family:
//
//     if (scope[1] !== scopeHash(ME, scope[2] || '')) continue  // authorises tasking some other agent
//     putGrant(String(grantee).toLowerCase(), …)
//
// ME — the agent running that runtime — is the SUBJECT. The `p` grantee is the party whose
// messages are promoted to instructions. So:
//
//     "the owner may instruct the agent"  →  grantee = OWNER,  subject = AGENT
//     "the agent may instruct another"    →  grantee = AGENT,  subject = OTHER
//
// Those two are the same protocol event with the parties swapped, and getting them the wrong way
// round produces a grant that is well-formed, verifies, goes live, and authorises the opposite of
// what was meant. That happened. This suite is the barrier.
//
// The assertions below are about the ASSIGNMENT, not about the labels — a sentence can read
// correctly while the event underneath is inverted, and it is the event that gets enforced.
//
//   node tests/connect_plan.mjs

import { readFileSync } from 'node:fs'
import { planConnection, planSummary, INTENTS, INTENT_KEYS, PARTY, EXTRA_PARTIES } from '../console/connect-plan.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const OWNER = '4010ac438206dc10018b814be3ea01ca6c92bcc22e9719e841d2413b287ea84d'
const AGENT = 'ebc6eec1a7c36304c8093d2f60337045b60678e858fe3997eb9740215bfdd2f3'
const OTHER = '84753207f2c6ae73af247da174e8e7c91a7d939a8eb0b4c2b98b54ea567786e6'
const CARRIER = '2efa3bd029621111111111111111111111111111111111111111111111111111'
const CHANNEL = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
const parties = { owner: OWNER, agent: AGENT, other: OTHER, carrier: CARRIER, channel: CHANNEL }
const names = { owner: 'you', agent: 'Oliver', other: 'waggle', carrier: 'waggle', channel: '#waggle-test' }

const one = (intent, extra = {}) => planConnection({ intents: [intent], parties: { ...parties, ...extra }, names })
const stepOf = (intent, extra) => { const p = one(intent, extra); return p.ok ? p.steps[0] : null }

// ── The assignment, per intent. This is the whole file. ─────────────────────────────────────
{
  const s = stepOf('admit-agent-to-channel')
  check(s?.grantee === AGENT, 'admit — the AGENT is the grantee: it is the one gaining the ability to post')
  check(s?.subject === CHANNEL, 'admit — the CHANNEL is the subject')
  check(s?.cap === 'admit' && s?.plane === 'door', 'admit — door plane')
}
{
  const s = stepOf('owner-directs-agent')
  check(s?.grantee === OWNER, 'owner-directs-agent — the OWNER is the grantee (the instructor)')
  check(s?.subject === AGENT, 'owner-directs-agent — the AGENT is the subject (the instructed)')
  check(s?.cap === 'task' && s?.plane === 'orders', 'owner-directs-agent — orders plane, cap task')
}
{
  const s = stepOf('owner-directs-agent-acting')
  check(s?.grantee === OWNER && s?.subject === AGENT, 'owner-directs-agent-acting — same direction, cap task+act')
  check(s?.cap === 'task+act', 'and it is the acting capability')
}
{
  const s = stepOf('agent-directs-other')
  check(s?.grantee === AGENT, 'agent-directs-other — the AGENT is now the grantee')
  check(s?.subject === OTHER, 'agent-directs-other — the OTHER agent is the subject')
}
{
  const s = stepOf('carrier-relays-to-agent')
  check(s?.grantee === CARRIER, 'carrier-relays-to-agent — the CARRIER is the grantee')
  check(s?.subject === AGENT, 'carrier-relays-to-agent — the agent it delivers to is the subject')
  check(s?.cap === 'task-relay', 'and the capability is task-relay')
}

// ── The mirror property, stated as one assertion ────────────────────────────────────────────
// The two task intents must be EXACT inverses of each other in their party assignment. If a
// future edit makes them agree, one of them is wrong and this is the check that says so.
{
  const inbound = stepOf('owner-directs-agent')
  const outbound = stepOf('agent-directs-other')
  check(inbound.subject === AGENT && outbound.grantee === AGENT,
    'the agent is the SUBJECT when being instructed and the GRANTEE when instructing — the two intents are mirrors')
  check(inbound.grantee !== outbound.grantee && inbound.subject !== outbound.subject,
    'and no party occupies the same slot in both')
}

// ── A caller cannot supply a grantee at all ─────────────────────────────────────────────────
// The defect was an operator filling in two symmetric-looking boxes. Passing them through would
// reintroduce it, so prove the planner ignores an attempt.
{
  const p = planConnection({
    intents: ['owner-directs-agent'],
    parties: { ...parties, grantee: AGENT, subject: OWNER },
    names,
  })
  check(p.ok && p.steps[0].grantee === OWNER && p.steps[0].subject === AGENT,
    'a caller passing its own grantee/subject is IGNORED — direction comes from the intent, never from the caller')
}

// ── Sentences name both parties, using the operator's own words ─────────────────────────────
{
  const s = stepOf('owner-directs-agent')
  check(s.sentence === 'you may send instructions to Oliver', `reads: ${s.sentence}`)
  const t = stepOf('agent-directs-other')
  check(t.sentence === 'Oliver may send instructions to waggle', `reads: ${t.sentence}`)
  const a = stepOf('admit-agent-to-channel')
  check(a.sentence === 'Oliver may post into #waggle-test', `reads: ${a.sentence}`)
}

// ── Enforcement is never overstated ─────────────────────────────────────────────────────────
{
  check(stepOf('admit-agent-to-channel').enforcedHere === true, 'the door grant says this bridge enforces it')
  for (const intent of ['owner-directs-agent', 'owner-directs-agent-acting', 'agent-directs-other', 'carrier-relays-to-agent']) {
    check(stepOf(intent).enforcedHere === false, `"${intent}" does NOT claim this bridge enforces it`)
    check(/runtime/.test(stepOf(intent).enforcer), `and names the agent's runtime`)
  }
}

// ── Refusals, each with the reason the operator acts on ─────────────────────────────────────
{
  const p = planConnection({ intents: [], parties, names })
  check(!p.ok && p.problems.some(x => /at least one/.test(x)), 'no intents is refused, and says why')
}
{
  const p = planConnection({ intents: ['owner-directs-agent'], parties: { owner: OWNER, agent: 'Oliver' }, names })
  check(!p.ok && p.problems.some(x => /public key/.test(x)),
    'a NAME where a key belongs is refused — a grant binds to a key, and a typo would verify and admit nobody')
}
{
  const p = planConnection({ intents: ['admit-agent-to-channel'], parties: { owner: OWNER, agent: AGENT }, names })
  check(!p.ok && p.problems.some(x => /channel/.test(x)), 'a door grant with no channel is refused')
}

// ── CASE NORMALISATION ──────────────────────────────────────────────────────────────────────
// Found in review, 2026-08-10, and it is the worst shape of bug this project has: every check on
// the page passes and the grant is dead.
//
// The party regexes are case-insensitive, so an UPPERCASE pubkey validates. If it reaches the
// scope hash unchanged the two halves of the grant are treated differently downstream:
//
//   p-tag  survives — attention.mjs lowercases the grantee when keying the permitted map
//   SCOPE  dies     — the subject is hashed raw, and the enforcer recomputes over ME, which is
//                     always lowercase hex
//
// So the grant signs, publishes, reads back green from every relay, renders a correct sentence,
// and is permanently invisible to the only software that has to see it. Reproduced before the
// fix: console signed 5c15c378…, enforcer recomputed b6c00312….
{
  const p = planConnection({ intents: ['owner-directs-agent'], parties: { owner: OWNER.toUpperCase(), agent: AGENT.toUpperCase() }, names })
  check(p.ok, 'an uppercase key is still accepted — rejecting it would just move the problem to the paste')
  check(p.steps[0].grantee === OWNER && p.steps[0].subject === AGENT,
    'and BOTH parties come out lowercase, so the scope hashes over the same bytes the enforcer does')
  check(!/[A-F]/.test(p.steps[0].subject), 'no uppercase survives into the subject at all')
}
{
  const mixed = 'EbC6eEc1a7C36304c8093D2f60337045b60678e858fe3997eb9740215bfdd2f3'
  const p = planConnection({ intents: ['owner-directs-agent'], parties: { owner: OWNER, agent: mixed }, names })
  check(p.ok && p.steps[0].subject === AGENT, 'mixed case is normalised too, not just fully-uppercase')
}
{
  const p = planConnection({ intents: ['admit-agent-to-channel'], parties: { ...parties, channel: CHANNEL.toUpperCase() }, names })
  check(p.ok && p.steps[0].subject === CHANNEL,
    'a channel uuid is lowercased on the same path — it is hashed as a string exactly like a key')
}
{
  const p = planConnection({ intents: ['owner-directs-agent'], parties: { owner: `  ${OWNER}  `, agent: AGENT }, names })
  check(p.ok && p.steps[0].grantee === OWNER, 'and surrounding whitespace is trimmed, because paste adds it')
}

// ── THE SELF-LOOP INVARIANT, OVER STEPS ─────────────────────────────────────────────────────
// This was first written as a per-intent guard on `agent-directs-other` — the intent where the
// footgun was imagined. Three of the four intents signed one anyway. `owner === agent` is not
// exotic: it is what happens when someone seats an agent with the key they are already signing
// with, the most likely paste error on this form.
{
  const p = planConnection({ intents: ['agent-directs-other'], parties: { ...parties, other: AGENT }, names })
  check(!p.ok && p.problems.some(x => /itself/.test(x)),
    'an agent granted the ability to instruct ITSELF is refused — every signature in that loop is valid')
}
for (const [intent, parts] of [
  ['owner-directs-agent', { owner: AGENT, agent: AGENT }],
  ['owner-directs-agent-acting', { owner: AGENT, agent: AGENT }],
  ['carrier-relays-to-agent', { owner: OWNER, agent: AGENT, carrier: AGENT }],
]) {
  const p = planConnection({ intents: [intent], parties: parts, names })
  check(!p.ok && p.problems.some(x => /itself/.test(x)),
    `"${intent}" with the same key on both ends is refused — the invariant is over steps, not per intent`)
}
{
  // THE INTERACTION CASE. Raised in review as the one worth a fixture of its own, because it is
  // where two individually-correct fixes could have combined into a wrong one.
  //
  // Normalising case CREATES self-loops that did not exist in the input: `owner` uppercase and
  // `agent` lowercase are different strings on the way in and the same key on the way out. If the
  // invariant compared raw values it would not see it, and the case fix would have manufactured
  // exactly the defect the loop guard exists to catch. It doesn't, because normalisation happens
  // at the boundary and the invariant runs on the normalised steps — but that ordering is load
  // bearing and nothing else in this file would notice if it were swapped.
  const p = planConnection({ intents: ['owner-directs-agent'], parties: { owner: AGENT.toUpperCase(), agent: AGENT }, names })
  check(!p.ok && p.problems.some(x => /itself/.test(x)),
    'MIXED CASE self-loop is refused — normalisation runs BEFORE the invariant, so case cannot smuggle one past it')
  check(AGENT.toUpperCase() !== AGENT,
    'and the two inputs really are different strings before normalisation, so this case is not vacuous')
}
{
  // The door plane is exempt on purpose: grantee and subject are a key and a uuid, so they can
  // never be equal, and asserting it there would be a check that has only ever passed.
  const p = planConnection({ intents: ['admit-agent-to-channel'], parties, names })
  check(p.ok, 'the door plane is unaffected — its two parties are different kinds of thing')
}
{
  const p = planConnection({ intents: ['make-it-do-whatever'], parties, names })
  check(!p.ok && p.problems.some(x => /knows how to grant/.test(x)), 'an unknown intent is refused rather than skipped')
}

// ── Ordering and summary ────────────────────────────────────────────────────────────────────
{
  const p = planConnection({ intents: ['owner-directs-agent', 'admit-agent-to-channel'], parties, names })
  check(p.ok && p.steps[0].plane === 'door', 'the door is listed first, so an agent that cannot post is obvious')
  const summary = planSummary(p)
  check(/1 enforced by this bridge/.test(summary) && /runtime/.test(summary),
    `the summary counts the two planes SEPARATELY — they are enforced by different software: ${summary}`)
}

// ── Every declared intent is complete ───────────────────────────────────────────────────────
for (const key of INTENT_KEYS) {
  const i = INTENTS[key]
  check(typeof i.question === 'string' && i.question.trim() !== '', `"${key}" asks the operator a question`)
  check(typeof i.detail === 'string' && i.detail.trim() !== '', `"${key}" says what it does and does not convey`)
  check(typeof i.grantee === 'function' && typeof i.subject === 'function',
    `"${key}" derives both parties — neither is a field a caller fills in`)
  check(one(key).ok, `"${key}" plans successfully with a complete party set`)
}

// ── NEGATIVE CONTROL ────────────────────────────────────────────────────────────────────────
// Every assertion above has only been asked to pass. An assignment check is worthless if it would
// also accept the assignment reversed — which is the failure that shipped. Run the real checks
// against a deliberately inverted intent table and prove they reject it.
{
  const inverted = { ...INTENTS['owner-directs-agent'], grantee: p => p.agent, subject: p => p.owner }
  const g = inverted.grantee(parties), s = inverted.subject(parties)
  check(!(g === OWNER && s === AGENT),
    'NEGATIVE CONTROL — the owner-directs-agent assignment check REJECTS the inverted table')
  const real = INTENTS['owner-directs-agent']
  check(real.grantee(parties) === OWNER && real.subject(parties) === AGENT,
    'and the real table still passes, so the control is not passing because the check is broken')
}
{
  // And prove the refusal checks can fail: a valid plan must NOT report problems.
  const p = one('admit-agent-to-channel')
  check(p.ok && p.problems.length === 0,
    'NEGATIVE CONTROL — a legitimate plan is accepted, so the refusals above are not "refuses everything"')
}
{
  // The case assertions above would pass trivially if the fixtures were already lowercase. Prove
  // the uppercase input really is uppercase before normalisation, and that comparing raw strings
  // would have FAILED — this is the probe-loses-its-own-input trap, and it has bitten here before.
  const upper = AGENT.toUpperCase()
  check(upper !== AGENT && /[A-F]/.test(upper),
    'NEGATIVE CONTROL — the uppercase fixture really is uppercase, so the case checks are not vacuous')
  check(planConnection({ intents: ['owner-directs-agent'], parties: { owner: OWNER, agent: upper }, names }).steps[0].subject !== upper,
    'and the planner genuinely CHANGES it rather than passing it through')
}
{
  // The self-loop invariant must not be "refuses everything in the orders plane".
  const p = planConnection({ intents: ['owner-directs-agent'], parties: { owner: OWNER, agent: AGENT }, names })
  check(p.ok && p.steps.length === 1,
    'NEGATIVE CONTROL — two DIFFERENT keys in the orders plane are still accepted')
}

// ── EVERY REQUIRED PARTY CAN BE ASKED FOR, AND NAMED ────────────────────────────────────────
// Shipped defect, found by using the page: `agent-directs-other` and `carrier-relays-to-agent`
// each require a party — `other`, `carrier` — that no input on connect.html collected. Ticking
// either produced "Missing other — this is required by one of the things you chose": a demand
// naming a field that did not exist, a choice it did not identify, and no way forward except
// untick. The planner was right and the surface could not satisfy it.
//
// Both halves are asserted here, because either alone lets it back in: a slot needs a WORD for
// the message and a FIELD for the operator, and the field is checked against the actual page.
{
  const html = readFileSync(new URL('../console/connect.html', import.meta.url), 'utf8')
  const required = [...new Set(Object.values(INTENTS).flatMap(i => i.needs || []))]

  check(required.length > 0, `some intents require an extra party (${required.join(', ')}) — otherwise this whole section is vacuous`)
  check(EXTRA_PARTIES.length === required.length && required.every(p => EXTRA_PARTIES.includes(p)),
    'EXTRA_PARTIES is derived from the intent table, so it cannot drift from what the planner asks for')

  for (const p of ['owner', 'agent', 'channel', ...required]) {
    const meta = PARTY[p]
    check(!!meta?.label && !!meta?.prompt && !!meta?.kind,
      `party "${p}" has a label, a prompt and a kind — a slot with no words gets its variable name printed at the operator`)
    check(meta?.label !== p, `party "${p}" is named in words, not as the identifier "${p}"`)
  }

  // The page must actually build an input for each one. Asserting against the real file is the
  // only version of this check that could have caught the defect — a fixture would have passed.
  for (const p of required) {
    check(html.includes(`data-extra-key="${p}"`) || html.includes('data-extra-key="${esc(p)}"'),
      `connect.html renders a key input for "${p}"`)
  }
  check(html.includes('EXTRA_PARTIES'), 'connect.html builds those inputs from EXTRA_PARTIES rather than hand-listing them')
}

// ── THE MESSAGE NAMES THE FIELD AND THE CHOICE ──────────────────────────────────────────────
// Asserting the REASON, not only the refusal. `!ok` cannot tell a correct refusal from a correct
// refusal that sends the operator looking for something that is not there — which is exactly what
// happened. So: the sentence must contain the human label, must NOT contain the raw slot name,
// and must say which ticked choice caused it.
{
  const partial = planConnection({
    intents: ['agent-directs-other'],
    parties: { owner: OWNER, agent: AGENT },  // `other` deliberately absent
  })
  check(!partial.ok, 'a plan missing a required extra party is refused')
  const msg = partial.problems.join(' | ')
  check(msg.includes(PARTY.other.label), `the message names the field in words: "${PARTY.other.label}"`)
  check(!/Missing other\b/.test(msg), 'the message does NOT print the raw slot name "other"')
  check(msg.includes(INTENTS['agent-directs-other'].question),
    'the message names the CHOICE that requires it, so the fix is visible without guessing')
  check(/untick/i.test(msg), 'and offers the other way out — untick the choice')

  // Same slot, when nothing requires it, must not be demanded at all.
  const unrelated = planConnection({
    intents: ['admit-agent-to-channel'],
    parties: { owner: OWNER, agent: AGENT, channel: CHANNEL },
  })
  check(unrelated.ok, 'NEGATIVE CONTROL — a plan that needs no extra party is accepted, so the demand above is conditional and not blanket')

  // And supplying it clears the refusal — pairing the rejection with an acceptance, so this
  // cannot pass by refusing everything.
  const complete = planConnection({
    intents: ['agent-directs-other'],
    parties: { owner: OWNER, agent: AGENT, other: OTHER },
  })
  check(complete.ok, 'NEGATIVE CONTROL — supplying the extra party clears the refusal')
  check(complete.steps.length === 1 && complete.steps[0].subject === OTHER,
    'and the resulting grant has the OTHER agent as subject, which is the direction that matters')
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
