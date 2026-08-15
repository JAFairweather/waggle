// agent-liveness.mjs — what has actually been OBSERVED about an agent, from the one surface that
// can observe it (#497, S6 of #486).
//
// `connect-agent --check` runs on the agent's own machine and four of its rows are unobservable
// from there by construction — it exits 3 at best, and #492 is the change that makes it say so.
// This is the other side of those rows. The console holds the bridge's signed control state, and a
// browser can open a WebSocket to a public relay, so it can make the one observation that decides
// whether an agent is addressable at all: a cold read-back of its kind:0.
//
// THE FOUR STATES ARE THE POINT, and they are the same four `src/agent_install_state.mjs` uses.
// The page cannot import ../src/ (`tools/serve-console.mjs` pins DOCROOT) and src/ cannot import
// console/ (it is not in the ship list), so they are a twin held equal by the suite — the precedent
// `console/scope-hash.mjs` set. Collapsing any two of them is the whole defect this module exists
// to avoid:
//
//   present     — something looked AND saw it doing its job
//   unverified  — it exists, or is claimed, and nothing checked it. NOT the same as fine.
//   missing     — something looked, and it is not there
//   unknown     — nothing looked, or nothing here CAN look. NOT the same as missing.
//
// WHAT THE ROSTER STATUS IS WORTH. `status` is claimed, not observed, and `console/agent-roster.mjs`
// already says why: the bridge decides on `grantSet` — 440 grants in, 441 revocations out — and
// `applyLifecycle`, the only writer of `status`, never touches it. Neither predicts the other in
// either direction. So the single thing the console shows about an agent today is the thing that
// does not predict whether it works, and it is rendered here as UNVERIFIED however green it looks.
//
// A RELAY THAT NEVER ANSWERED IS NOT A RELAY THAT SERVED NOTHING. `readPublic` counts `answered`
// apart from the events it collected for exactly this: reporting a name as MISSING because four
// sockets timed out would send the operator to publish a second profile for a key that already has
// one, and a second kind:0 is not a harmless no-op.

export const PRESENT = 'present'
export const UNVERIFIED = 'unverified'
export const MISSING = 'missing'
export const UNKNOWN = 'unknown'
export const STATES = Object.freeze([PRESENT, UNVERIFIED, MISSING, UNKNOWN])

/// The rows, in the order an operator needs them answered. `decides` is what breaks if the row is
/// wrong — kept next to the row because "the agent has no kind:0" means nothing to a reader who
/// does not know that an at-word resolves against it.
export const LIVENESS_ROWS = Object.freeze([
  Object.freeze({ key: 'name', title: 'Name published (kind 0)',
    decides: 'Whether an at-word resolves. Without it the agent is on the list and nobody can address it.' }),
  Object.freeze({ key: 'roster', title: 'On the bridge roster',
    decides: 'Claimed admission. The grant set decides the door, and neither predicts the other (#440).' }),
  Object.freeze({ key: 'community-write', title: 'Can write to the community',
    decides: 'Whether the name reaches the walled side. Membership buys write, not read (#399).' }),
  Object.freeze({ key: 'channel-answers', title: 'Its MCP channel answers',
    decides: 'Whether a session can become this agent at all.' }),
  Object.freeze({ key: 'broker-seat', title: 'Seated on the broker',
    decides: 'The other box\'s authorized_keys, under its forced command. Nothing here can see it (#488).' }),
])

/// Rows no browser can observe, and where each IS settled. Same discipline as #492's allowlist: a
/// row nothing here can check must not read as a failure of the agent, and must not read as fine.
/// Naming the remedy is the part that stops an operator hunting on the wrong machine.
export const NOT_OBSERVABLE_HERE = Object.freeze({
  'community-write': 'settled by publishing the profile from this page — the community relay answers accepted:true or refuses',
  'channel-answers': 'settled on the agent\'s machine by an initialize + tools/list handshake',
  'broker-seat': 'settled on the broker by an operator confirming the public half under its forced command',
})

/// The name row, from a `readPublic` result. Pure, so every branch is assertable without a socket.
///
/// `read` is null when nobody looked. That is not the same as a read that came back empty, and it is
/// not the same as a read where no relay answered — three different sentences, three different next
/// actions for the operator.
export function nameRow({ read, agent }) {
  if (!read) return { state: UNKNOWN, note: 'not read yet' }
  if (!read.answered) {
    return { state: UNKNOWN,
      note: `no relay answered (0 of ${read.asked}) — a browser cannot tell an unreachable relay from a profile that is not there, so this is not "no name"` }
  }
  const newest = (read.events || []).slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0]
  if (!newest) {
    return { state: MISSING,
      note: `${read.answered} of ${read.asked} relays answered and none served a kind:0 — this key has no published name` }
  }
  let content = null
  try { content = JSON.parse(newest.content) } catch { content = null }
  const display = String(content?.display_name || content?.name || '').trim()
  if (!display) {
    // A kind:0 with no name writes a `users` row with no `display_name`. It is indistinguishable
    // from never having published — except that it looks like it worked.
    return { state: MISSING, note: 'a kind:0 is published but carries no name, so an at-word still resolves to nothing' }
  }
  // The label is owner-set; the at-word has to match `display_name`. They are allowed to differ and
  // usually should not, and an operator who types the label because it is what the console showed
  // them addresses nobody. Reported, never corrected here.
  const label = String(agent?.label || '').trim()
  const note = label && label !== display
    ? `published as “${display}” — the roster label is “${label}”, and the at-word has to match the PUBLISHED name`
    : `published as “${display}”, read back cold from ${read.answered} of ${read.asked} relays`
  return { state: PRESENT, name: display, note }
}

/// The roster row. Claimed, never observed — whatever colour the status is.
export function rosterRow({ agent }) {
  if (!agent) return { state: UNKNOWN, note: 'no roster entry — nothing here claims this key is admitted' }
  if (agent.status === 'revoked') return { state: MISSING, note: 'the roster marks this key removed' }
  if (agent.status === 'paused') return { state: MISSING, note: 'the roster marks this key paused' }
  return { state: UNVERIFIED,
    note: 'the roster claims admitted — the grant set is what the bridge actually enforces, and neither predicts the other' }
}

/// The whole report for one agent. `profileRead` is a `readPublic` result or null.
export function livenessReport({ agent, profileRead = null }) {
  const observed = {
    name: nameRow({ read: profileRead, agent }),
    roster: rosterRow({ agent }),
  }
  const rows = LIVENESS_ROWS.map(row => {
    if (observed[row.key]) return { ...row, ...observed[row.key] }
    return { ...row, state: UNKNOWN, note: NOT_OBSERVABLE_HERE[row.key] || 'not checked here' }
  })
  const by = state => rows.filter(r => r.state === state).map(r => r.key)
  const unknown = by(UNKNOWN)
  // At the ceiling when every outstanding row is one this surface never checks — the same sentence
  // #492 puts on `--check`, for the same reason: a permanent UNKNOWN otherwise reads as a fault.
  const atCeiling = !by(MISSING).length && unknown.length > 0 && unknown.every(k => k in NOT_OBSERVABLE_HERE)
  const name = rows.find(r => r.key === 'name')

  let headline
  if (name.state === PRESENT && atCeiling) {
    headline = `${name.name} is published and reads back cold. Everything still open is settled off this page, not on it.`
  } else if (name.state === PRESENT) {
    headline = `${name.name} is published and reads back cold — but ${by(MISSING).length} row${by(MISSING).length === 1 ? '' : 's'} came back negative.`
  } else if (name.state === MISSING) {
    headline = 'This key has no published name, so nothing can address it — publish its kind:0 before anything else.'
  } else {
    headline = 'Nothing has been observed about this agent yet. That is not the same as nothing being wrong.'
  }

  return {
    rows, headline, atCeiling,
    counts: { present: by(PRESENT).length, unverified: by(UNVERIFIED).length, missing: by(MISSING).length, unknown: unknown.length },
    // Deliberately not an "ok" flag. The only row this surface PROVES is the name; a boolean here
    // would be read as "the agent works", which no observation on this page supports.
    nameProven: name.state === PRESENT,
  }
}

/// Render for the page. Kept beside the report so the suite can assert an UNVERIFIED row never
/// prints as a tick — the single most likely way this panel lies.
export const MARK = Object.freeze({ [PRESENT]: '✓', [UNVERIFIED]: '?', [MISSING]: '✕', [UNKNOWN]: '–' })
