// connect-plan.mjs — turn what the owner MEANS into the grants that mean it.
//
// The problem this exists to remove. To seat an agent today an operator issues kind-440s by
// filling in two fields: a grantee (`--to`) and a subject (`--agent` / `--channel`). Those two
// fields are not symmetric and nothing on the form says which way round they go. For the task
// family the subject is the agent BEING INSTRUCTED and the grantee is whoever MAY INSTRUCT IT —
// so "let my agent take orders from me" and "let my agent give orders to something else" are the
// same two boxes with the values swapped, and both look equally plausible while you are typing.
//
// That is not a labelling problem, it is a modelling problem. A form that asks for a grantee is
// asking the operator to do the translation from intent to protocol, every time, silently, with
// no way to check the answer. During one onboarding it was got wrong: the intent was "agent A may
// instruct agent B" and what was signed was "the operator may instruct agent A". Well-formed,
// verifying, live, and backwards.
//
// So this module takes INTENTS — sentences about who does what to whom — and assigns the parties
// itself. The operator never chooses a grantee. There is exactly one place in the codebase where
// intent becomes direction, it is this file, and tests/connect_plan.mjs holds it to the direction
// tools/attention.mjs actually enforces.
//
//   node tests/connect_plan.mjs

import { describeGrant, capEnforcer, capPlane, capSubject, PLANE_COPY } from './capability-vocabulary.mjs'

const HEX64 = /^[0-9a-f]{64}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The four things an owner can actually want. Each names both ends explicitly in its own key, so
// a reader of a call site can see the direction without holding this file in their head.
//
// `grantee` and `subject` are FUNCTIONS of the parties, not fields the caller supplies. That is
// the whole point: a caller cannot pass them the wrong way round because a caller cannot pass
// them at all.
export const INTENTS = {
  // The door. The agent is the one gaining the ability to post, so the agent is the grantee.
  'admit-agent-to-channel': {
    cap: 'admit',
    question: 'Let this agent post into the channel',
    detail: 'It becomes a member and writes under its own key. It does not gain the ability to read the channel.',
    grantee: p => p.agent,
    subject: p => p.channel,
  },
  // Orders, inbound. The OWNER gains the ability to instruct, so the owner is the grantee and the
  // agent is the subject. This is the one that was signed backwards.
  'owner-directs-agent': {
    cap: 'task',
    question: 'Let me give this agent instructions',
    detail: 'Your signed messages become instructions it will act on. Checked by the agent, not by this bridge.',
    grantee: p => p.owner,
    subject: p => p.agent,
  },
  'owner-directs-agent-acting': {
    cap: 'task+act',
    question: 'Let me give this agent instructions it may act on',
    detail: 'As above, and it may take action rather than only answer. Its own approval path still applies.',
    grantee: p => p.owner,
    subject: p => p.agent,
  },
  // Orders, outbound. The AGENT gains the ability to instruct something else, so now the agent is
  // the grantee and the other party is the subject — the exact mirror of the two above.
  'agent-directs-other': {
    cap: 'task',
    question: 'Let this agent give instructions to another agent',
    detail: 'Its signed messages become instructions to the agent you name. Checked by that agent, not by this bridge.',
    grantee: p => p.agent,
    subject: p => p.other,
    needs: ['other'],
  },
  // Transport. The carrier gains the ability to carry, addressed to the agent.
  'carrier-relays-to-agent': {
    cap: 'task-relay',
    question: 'Let the bridge carry signed instructions to this agent',
    detail: 'Transport only. A carried message is actionable solely if its original signer separately holds a grant.',
    grantee: p => p.carrier,
    subject: p => p.agent,
    needs: ['carrier'],
  },
}

export const INTENT_KEYS = Object.keys(INTENTS)

// A party is either a 64-hex pubkey or a channel uuid. Names are display only and never reach a
// grant, because a grant binds to a key — a surface that let a typo'd name through would produce
// a grant that verifies and admits nobody.
const partyKind = (v) => HEX64.test(String(v || '')) ? 'key' : (UUID.test(String(v || '')) ? 'channel' : 'invalid')

/**
 * Build the set of grants that expresses these intents.
 *
 * parties: { owner, agent, channel, other?, carrier? } — all 64-hex except `channel` (uuid)
 * names:   optional display names, keyed the same way, used only for the sentences
 *
 * Returns { ok, steps, problems }. `steps` is ordered door-first, because an agent that can be
 * instructed but cannot post is a configuration nobody wants and reading it in that order makes
 * the omission obvious.
 */
export function planConnection({ intents = [], parties = {}, names = {} } = {}) {
  const problems = []
  const chosen = [...new Set(intents)]
  if (!chosen.length) problems.push('Choose at least one thing this agent may do — an agent with no grants is admitted to nothing.')
  for (const key of chosen) if (!INTENTS[key]) problems.push(`"${key}" is not something this surface knows how to grant.`)

  const need = new Set(['owner', 'agent'])
  for (const key of chosen) {
    const intent = INTENTS[key]
    if (!intent) continue
    if (capSubject(intent.cap) === 'channel') need.add('channel')
    for (const extra of intent.needs || []) need.add(extra)
  }
  for (const party of need) {
    const value = parties[party]
    if (!value) { problems.push(`Missing ${party} — this is required by one of the things you chose.`); continue }
    const kind = partyKind(value)
    const wanted = party === 'channel' ? 'channel' : 'key'
    if (kind !== wanted) {
      problems.push(party === 'channel'
        ? 'The channel must be a uuid.'
        : `The ${party} must be a 64-character public key. A name is not enough — a grant binds to a key.`)
    }
  }

  // Self-direction is a real footgun: an agent granted the ability to instruct itself creates a
  // loop that nothing downstream refuses, because every signature on it is valid.
  for (const key of chosen) {
    if (key !== 'agent-directs-other') continue
    if (parties.other && parties.agent && String(parties.other).toLowerCase() === String(parties.agent).toLowerCase()) {
      problems.push('An agent cannot be granted the ability to instruct itself.')
    }
  }

  if (problems.length) return { ok: false, steps: [], problems }

  const label = (party) => {
    const raw = parties[party]
    const given = String(names[party] || '').trim()
    if (given) return given
    return party === 'channel' ? String(raw) : `${String(raw).slice(0, 8)}…`
  }
  // Which party slot a resolved value came from, so a sentence can name it the way the operator
  // named it rather than as a key fragment.
  const slotOf = (value) => ['owner', 'agent', 'channel', 'other', 'carrier']
    .find(p => parties[p] && String(parties[p]).toLowerCase() === String(value).toLowerCase())

  const steps = chosen.map(key => {
    const intent = INTENTS[key]
    const grantee = intent.grantee(parties)
    const subject = intent.subject(parties)
    const granteeName = label(slotOf(grantee) || 'agent')
    const subjectName = label(slotOf(subject) || 'agent')
    return {
      intent: key,
      cap: intent.cap,
      plane: capPlane(intent.cap),
      grantee,
      subject,
      subjectKind: capSubject(intent.cap),
      sentence: describeGrant({ cap: intent.cap, grantee: granteeName, subject: subjectName }),
      enforcer: capEnforcer(intent.cap),
      enforcedHere: PLANE_COPY[capPlane(intent.cap)]?.enforcedBy === 'this bridge',
      question: intent.question,
      detail: intent.detail,
    }
  }).sort((a, b) => (a.plane === 'door' ? 0 : 1) - (b.plane === 'door' ? 0 : 1))

  return { ok: true, steps, problems: [] }
}

// A one-line summary for a confirmation the operator reads before signing anything. Deliberately
// counts the two planes separately: they are enforced by different software, and a total that
// merges them tells the owner they have four gates when they have two here and two elsewhere.
export function planSummary(plan) {
  if (!plan?.ok) return 'Nothing to sign yet.'
  const door = plan.steps.filter(s => s.plane === 'door').length
  const orders = plan.steps.filter(s => s.plane === 'orders').length
  const parts = []
  if (door) parts.push(`${door} enforced by this bridge`)
  if (orders) parts.push(`${orders} enforced by the agent's own runtime`)
  return `${plan.steps.length} approval${plan.steps.length === 1 ? '' : 's'} to sign — ${parts.join(', ')}.`
}
