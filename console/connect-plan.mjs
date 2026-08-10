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

// ── The party slots, in the operator's words ─────────────────────────────────────────────────
//
// `owner`, `agent`, `other` and `carrier` are variable names. They are meaningful to the code and
// meaningless to the person signing, and for a while this module leaked them straight onto the
// screen — "Missing other — this is required by one of the things you chose." That sentence names
// no field the operator can see, no choice that caused it, and nothing they can do about it.
//
// So the vocabulary lives HERE, next to the slots it names, rather than in the page. A surface
// that renders a slot renders its `prompt`; a message that mentions a slot uses its `label`. The
// suite asserts that every slot an intent can require has an entry, which is what stops a new
// intent from introducing a party no screen can ask for and no message can name.
export const PARTY = {
  owner: { label: 'your public key', prompt: 'Your public key', kind: 'key',
    note: 'The key that signs these approvals.' },
  agent: { label: "the agent's public key", prompt: 'Its public key', kind: 'key',
    note: 'The identity being connected.' },
  channel: { label: 'the channel', prompt: 'Channel', kind: 'channel',
    note: 'Stored as a salted hash — the id itself never rides publicly.' },
  other: { label: 'the agent it may instruct', prompt: 'The agent it may instruct', kind: 'key',
    note: 'A second agent, the one receiving instructions. Not you, and not the agent above.' },
  carrier: { label: 'the carrier', prompt: 'The carrier', kind: 'key',
    note: 'Whoever transports the message. Carrying is not authoring — a carried instruction is actionable only if its original signer separately holds a grant.' },
}

// Slots that no fixed field covers, derived from the intent table rather than hand-listed — the
// same rule the plane rendering follows. Hand-listing is exactly how `other` and `carrier` came to
// be required by two intents while no input for either existed anywhere on the page: the planner
// asked for them, the surface never offered them, and the flow dead-ended with the choice ticked.
export const EXTRA_PARTIES = [...new Set(Object.values(INTENTS).flatMap(i => i.needs || []))]

// A party is either a 64-hex pubkey or a channel uuid. Names are display only and never reach a
// grant, because a grant binds to a key — a surface that let a typo'd name through would produce
// a grant that verifies and admits nobody.
const partyKind = (v) => HEX64.test(String(v || '')) ? 'key' : (UUID.test(String(v || '')) ? 'channel' : 'invalid')

// ── CASE. Every key and uuid is lowercased HERE, once, at the boundary. ──────────────────────
//
// The regexes above are case-insensitive, so an uppercase pubkey validates. If it then reaches
// the scope hash unchanged, the two halves of the grant are treated differently downstream and
// only one of them dies:
//
//   the p-tag  survives — `attention.mjs` does String(grantee).toLowerCase() when it keys the
//                         permitted-senders map, so an uppercase grantee still matches
//   the SCOPE  dies     — the subject is hashed as its raw bytes, and the enforcer recomputes
//                         over `ME`, which is always lowercase hex. The hashes differ.
//
// The result is a grant that signs, publishes, reads back green from every relay, renders a
// correct sentence on screen, and is permanently invisible to the only software that has to see
// it. Every check on the page passes. It is the same "binds to a subject nothing can match"
// failure as a drifted hash construction, arriving through case normalisation instead.
//
// Reproduced 2026-08-10 with an uppercase agent key: console signs 5c15c378…, enforcer recomputes
// b6c00312…, p-tag fine. Normalising at the boundary means no downstream surface has to remember.
const normaliseParties = (parties) => Object.fromEntries(
  Object.entries(parties || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim().toLowerCase() : v]))

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
export function planConnection({ intents: rawIntents = [], parties: rawParties = {}, names = {} } = {}) {
  const parties = normaliseParties(rawParties)
  const intents = rawIntents
  const problems = []
  const chosen = [...new Set(intents)]
  if (!chosen.length) problems.push('Choose at least one thing this agent may do — an agent with no grants is admitted to nothing.')
  for (const key of chosen) if (!INTENTS[key]) problems.push(`"${key}" is not something this surface knows how to grant.`)

  // party -> the choice that made it necessary, or null when every approval needs it. Carrying the
  // reason is what turns "something is missing" into a sentence the operator can act on, because
  // the fix is always either "fill this in" or "untick that".
  const need = new Map([['owner', null], ['agent', null]])
  for (const key of chosen) {
    const intent = INTENTS[key]
    if (!intent) continue
    if (capSubject(intent.cap) === 'channel' && !need.has('channel')) need.set('channel', intent.question)
    for (const extra of intent.needs || []) if (!need.has(extra)) need.set(extra, intent.question)
  }
  for (const [party, because] of need) {
    const what = PARTY[party]?.label || party
    const value = parties[party]
    if (!value) {
      problems.push(because
        ? `Missing ${what} — “${because}” needs it. Fill it in, or untick that choice.`
        : `Missing ${what} — every approval needs it.`)
      continue
    }
    const kind = partyKind(value)
    const wanted = PARTY[party]?.kind || 'key'
    if (kind !== wanted) {
      problems.push(wanted === 'channel'
        ? 'The channel must be a uuid.'
        : `${what[0].toUpperCase()}${what.slice(1)} must be a 64-character public key — paste the hex, or let the page convert an npub1… first. A name is not enough: a grant binds to a key.`)
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

  // ── The self-loop invariant, asserted over the BUILT STEPS ────────────────────────────────
  //
  // This was first written as a per-intent check on `agent-directs-other`, which is where the
  // footgun was imagined. Three of the four intents happily signed one anyway — most obviously
  // `owner-directs-agent` with owner === agent, which is not exotic at all: it is what happens
  // when someone seats an agent using the key they are already signing with, the single most
  // likely paste error on this form. The sentence even rendered the same fragment on both sides,
  // so the surface DISPLAYED the defect and did not refuse it.
  //
  // The property is universal — `grantee !== subject` for anything in the orders plane — so it is
  // asserted once, here, on the steps rather than on the intents. That covers intents nobody has
  // written yet, which a per-intent guard by construction cannot.
  const loops = steps.filter(s => s.plane === 'orders' && s.grantee === s.subject)
  if (loops.length) {
    return {
      ok: false,
      steps: [],
      problems: loops.map(s => `"${s.question}" would make an identity instruct itself — the same key is on both ends. Every signature in that loop is valid, so nothing downstream would refuse it.`),
    }
  }

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
