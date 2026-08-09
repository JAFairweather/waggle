// agent_lifecycle.mjs — the closed catalogue of agent lifecycle commands (#309).
//
// The lifecycle plane needs no new transport. It rides the SAME approver-signed on-relay
// control-command lane the watchlist, trust and moderation verbs already use (NIP-78, kind 30078,
// `authors: PUB.approvers`, addressed to this bridge). This file is the part of that lane which is
// worth testing in isolation: the catalogue, the body validation, and the reach classification.
//
// It is deliberately NOT the off-box policy service (`src/buzz_policy_*`). That lane's defining
// property is "evidence, not instructions" — a third party observes and the bridge acts on what it
// observed. Lifecycle is the opposite: owner intent IS the instruction. Do not carry that lane's
// reasoning across; the safety here comes from the approver signature and this closed catalogue,
// not from evidence.
//
// Three rules shape the catalogue:
//
//   1. CLOSED. An operation not named here is refused, never defaulted. A default branch on a
//      lifecycle command is a way to invent an authority nobody granted.
//   2. NO CREDENTIAL EVER CROSSES. A lifecycle command is a public, signed, on-relay event — it is
//      readable by anyone. A body carrying a key would be publishing that key. Secret-bearing
//      fields are refused by shape, not by the caller remembering.
//   3. REACH IS CLASSIFIED. Some operations widen what an agent can reach and some narrow it. They
//      are not symmetric risks and must not be presented or logged as if they were.

export const LIFECYCLE_VERSION = 1
export const LIFECYCLE_COMMAND_D = 'waggle-agent-lifecycle'

// What an operation does to the agent's reach. Narrowing is always safe to apply; widening is the
// thing an approver is actually being asked to decide, and the console must say so.
// The closed set of statuses a row may hold. Exported because the signed public projection filters
// on it: a row with a status nobody defined must not reach a browser as if it were meaningful.
export const AGENT_STATUSES = Object.freeze(['admitted', 'paused', 'revoked'])

export const REACH = Object.freeze({ WIDENS: 'widens', NARROWS: 'narrows', NEUTRAL: 'neutral' })

/**
 * The closed catalogue.
 *
 * `limits` is not documentation — it is the honest statement of what the bridge can and cannot do,
 * and the console renders it. This exists because the tempting lie in a lifecycle UI is a "destroy
 * agent" button: the bridge can withdraw the admission IT issued, and it cannot reach into the
 * agent's own runtime and delete a key it never held. A UI that implies otherwise teaches an owner
 * that a revoked agent is a disarmed one.
 */
export const LIFECYCLE_OPERATIONS = Object.freeze({
  agent_admit: Object.freeze({
    fields: Object.freeze(['agent']),
    reach: REACH.WIDENS,
    destructive: false,
    summary: 'admit this key as a first-class member — it may post in under its own signature',
    limits: 'grants the WRITE half only. The community relay will not serve an external key, so ' +
      'this does not give the agent read access to the community; what reaches it is the return ' +
      'lane, which carries mentions only.',
  }),
  agent_revoke: Object.freeze({
    fields: Object.freeze(['agent']),
    reach: REACH.NARROWS,
    destructive: false,
    summary: 'withdraw bridge-side admission — the bridge stops routing for this key',
    limits: 'withdraws ONLY the admission this bridge issued and can revoke. It does not reach the ' +
      "agent's runtime, does not delete or rotate the agent's key, and does not retract anything " +
      'that key already published. Revoked is not disarmed.',
  }),
  agent_rename: Object.freeze({
    fields: Object.freeze(['agent', 'label']),
    reach: REACH.NEUTRAL,
    destructive: false,
    summary: 'change the display label the console shows for this agent',
    limits: 'a local label only. It is not the agent\'s Nostr profile and changes nothing another ' +
      'party sees.',
  }),
  agent_return_lane: Object.freeze({
    fields: Object.freeze(['agent', 'enabled']),
    reach: REACH.WIDENS,
    destructive: false,
    summary: 'carry mentions of this agent out to it over the return lane',
    limits: 'mentions only, and only where the community relay would not serve the key directly. ' +
      'It is not read access and must never be labelled as such.',
  }),
  agent_pause: Object.freeze({
    fields: Object.freeze(['agent']),
    reach: REACH.NARROWS,
    destructive: false,
    summary: 'stop routing for this agent without withdrawing its admission',
    limits: 'reversible by agent_resume. The admission record is untouched, so this is a lane ' +
      'decision, not a membership one.',
  }),
  agent_resume: Object.freeze({
    fields: Object.freeze(['agent']),
    reach: REACH.WIDENS,
    destructive: false,
    summary: 'resume routing for a paused agent',
    limits: 'restores exactly what agent_pause stopped. It cannot restore an admission that was ' +
      'revoked — that needs a fresh agent_admit, and a fresh approver decision.',
  }),
  agent_forget: Object.freeze({
    fields: Object.freeze(['agent']),
    reach: REACH.NARROWS,
    destructive: true,
    summary: 'remove this agent from the projection entirely, after revocation',
    limits: 'a console-side erasure of the row. Everything the agent published is still public and ' +
      'is not retracted. Requires the agent to be revoked first — forgetting a live agent would ' +
      'leave the bridge routing for something the owner can no longer see.',
  }),
})

export const LIFECYCLE_OPERATION_NAMES = Object.freeze(Object.keys(LIFECYCLE_OPERATIONS).sort())

// Matches `install_state.mjs`'s field screen. A lifecycle command is published to public relays, so
// a body carrying one of these is not a leak risk — it is a publication.
const SECRET_FIELD = /(nsec|privkey|private_key|secret|seed|mnemonic|password|token|bunker|client_key)/i
const HEX64 = /^[0-9a-f]{64}$/i
// Deliberately narrow: printable ASCII, no control characters, no newlines. A label is rendered in
// the console, and the rendering suite already carries the lesson that a hostile string reaches the
// approver's screen. Keeping it boring here means the renderer is not the only thing standing up.
const LABEL = /^[\x20-\x7e]{1,64}$/

const refuse = reason => Object.freeze({ ok: false, reason })

/**
 * Validate a lifecycle command body. Pure: no clock, no config, no I/O — the caller supplies the
 * envelope checks (approver roster, signature, addressing, freshness, watermark) exactly as the
 * existing control-command handlers do.
 *
 * Returns `{ ok: true, op, agent, ... }` or `{ ok: false, reason }`. It never throws on hostile
 * input, because a handler that throws on a malformed relay event is a handler a stranger can stop.
 */
export function parseLifecycleCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('invalid command body')
  if (body.v !== LIFECYCLE_VERSION) return refuse('unsupported lifecycle version')

  const op = body.op
  // Own-property lookup, not `in` and not a bare index: `LIFECYCLE_OPERATIONS['toString']` would
  // otherwise resolve through the prototype chain and admit an operation that does not exist.
  if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(LIFECYCLE_OPERATIONS, op)) {
    return refuse('unknown lifecycle operation')
  }
  const spec = LIFECYCLE_OPERATIONS[op]

  // Exact key set — the house idiom. An extra field is a refusal, not something to ignore: a body
  // the bridge half-reads is a body whose meaning the sender and the bridge disagree about.
  const want = ['op', 'v', ...spec.fields].sort().join(',')
  if (Object.keys(body).sort().join(',') !== want) return refuse('invalid command body')

  for (const key of Object.keys(body)) {
    if (SECRET_FIELD.test(key)) return refuse('secret-bearing field in a public command')
  }

  const agent = String(body.agent || '').toLowerCase()
  if (!HEX64.test(agent)) return refuse('agent must be a 64-hex public key')

  const out = { ok: true, op, agent, reach: spec.reach, destructive: spec.destructive }

  if (spec.fields.includes('label')) {
    if (typeof body.label !== 'string' || !LABEL.test(body.label)) return refuse('label must be 1–64 printable characters')
    out.label = body.label
  }
  if (spec.fields.includes('enabled')) {
    if (typeof body.enabled !== 'boolean') return refuse('enabled must be a boolean')
    out.enabled = body.enabled
  }

  return Object.freeze(out)
}

/**
 * Whether a parsed command may be applied against the agent's current row.
 *
 * Separated from parsing because these are ORDERING facts, not shape facts, and the two fail for
 * different reasons — collapsing them would report "invalid command" for a perfectly well-formed
 * command that simply arrived out of order.
 *
 * `row` is the projection row for this agent, or null if the bridge has never seen it.
 */
export function lifecycleAdmissible(command, row) {
  if (!command || command.ok !== true) return refuse('not a valid command')
  const known = row && typeof row === 'object'
  const status = known ? String(row.status || '') : 'unknown'

  switch (command.op) {
    case 'agent_admit':
      // Re-admitting an already-admitted agent is a no-op, not an error: a retried command must not
      // read as a failure, or an owner clicking twice sees an alarm where nothing is wrong.
      if (status === 'admitted') return Object.freeze({ ok: true, noop: true, reason: 'already admitted' })
      return Object.freeze({ ok: true, noop: false })
    case 'agent_revoke':
      if (!known) return refuse('no such agent')
      if (status === 'revoked') return Object.freeze({ ok: true, noop: true, reason: 'already revoked' })
      return Object.freeze({ ok: true, noop: false })
    case 'agent_resume':
      if (!known) return refuse('no such agent')
      // The sharp case: resume must not silently undo a revocation. Pausing and revoking are
      // different decisions and only one of them is reversible by this operation.
      if (status === 'revoked') return refuse('cannot resume a revoked agent — admit it again explicitly')
      if (status !== 'paused') return Object.freeze({ ok: true, noop: true, reason: 'not paused' })
      return Object.freeze({ ok: true, noop: false })
    case 'agent_pause':
      if (!known) return refuse('no such agent')
      if (status === 'revoked') return refuse('cannot pause a revoked agent — it is already not routed')
      if (status === 'paused') return Object.freeze({ ok: true, noop: true, reason: 'already paused' })
      return Object.freeze({ ok: true, noop: false })
    case 'agent_forget':
      if (!known) return refuse('no such agent')
      // Forgetting a live agent removes the owner's view of something the bridge is still routing
      // for. The row is the only place that routing is visible, so this ordering is the safety.
      if (status !== 'revoked') return refuse('revoke this agent before forgetting it')
      return Object.freeze({ ok: true, noop: false })
    case 'agent_rename':
      if (!known) return refuse('no such agent')
      // A rename is a label change on a row the owner can already see, so it stays admissible at any
      // status — including revoked, where correcting a misleading label is legitimate work.
      return Object.freeze({ ok: true, noop: false })
    case 'agent_return_lane':
      if (!known) return refuse('no such agent')
      // This op WIDENS reach, so it must not apply to a revoked row. Enabling the return lane on a
      // revoked agent is an undone revocation by the side door: the projection publishes
      // return_lane true for a key the owner believes is cut off, and the moment anything routes on
      // that flag the revocation is silently reversed. Revocation is the one decision this
      // catalogue makes deliberately hard to walk back — see agent_resume above.
      if (status === 'revoked') return refuse('cannot change the return lane of a revoked agent — admit it again explicitly')
      return Object.freeze({ ok: true, noop: false })
    default:
      // Unreachable while `parseLifecycleCommand` gates the catalogue, and kept as a refusal rather
      // than a fallthrough precisely so it stays unreachable.
      return refuse('unknown lifecycle operation')
  }
}

/**
 * The log/receipt line for an applied command. Names the reach explicitly, because "waggle applied
 * agent_return_lane" does not tell an owner reading a log that their agent's reach just grew.
 */
export function lifecycleReceipt(command, { approver, at, eventId } = {}) {
  const spec = LIFECYCLE_OPERATIONS[command.op]
  return Object.freeze({
    v: LIFECYCLE_VERSION,
    op: command.op,
    // Truncated in the receipt for readability; these are PUBLIC keys, so this is presentation,
    // not redaction — nothing here is a secret being hidden.
    agent: command.agent.slice(0, 16),
    reach: command.reach,
    destructive: command.destructive,
    limits: spec.limits,
    approver: approver ? String(approver).slice(0, 16) : null,
    event: eventId ? String(eventId).slice(0, 16) : null,
    at: at || null,
  })
}
