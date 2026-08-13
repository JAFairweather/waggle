// The console already knows who is admitted. This module is what lets it say so (#413).
//
// The task-route panel asked the operator to paste an npub into "Agent identity". The failure mode
// is not a rejected paste — 63 characters of base32 have no prefix a human reads, so a wrong one
// decodes cleanly, signs, publishes, and routes a channel's mentions to a DIFFERENT admitted agent.
// Nothing downstream can catch that, because routing to another admitted participant is a
// legitimate operation. The only place it can be caught is before the paste.
//
// No new round trip and no new trust assumption: `freshBridge()` already fetches, verifies and
// parses the bridge's signed control state, and then throws away everything but the bridge key.
// `state.agents` was in that same event.
//
// WHY THE VOCABULARY LIVES HERE. `agents.html` had its own `STATUSES` / `STATUS_LABEL` pair. A
// second surface rendering the same statuses would have grown a second translation, and two
// translations of one wire value drift in exactly the direction where a `revoked` agent reads as
// something reassuring on one page. `tests/console_agent_roster.mjs` asserts this module is the
// only place under console/ that defines them.
//
// WHAT IS NOT DERIVED FROM THE ROSTER: the mention handle. It is tempting to prefill it from
// `label`, and mostly that is right — but `label` is owner-set and constrained to printable ASCII,
// while the mention must match what Buzz writes into the channel body from the member's
// `display_name`, which since #404 may hold any letter. A label therefore cannot always carry the
// name that has to match, so the picker must never lock that field.

import { nip19 } from 'nostr-tools'

// Wire values, as the bridge publishes them.
export const STATUSES = Object.freeze(['admitted', 'paused', 'revoked'])

// What each status READS as (#348). An unlisted status renders as its raw wire value — a state the
// console has never heard of must LOOK unfamiliar rather than borrow a friendly word.
export const STATUS_LABEL = Object.freeze({ admitted: 'in', paused: 'paused', revoked: 'removed' })

export const statusLabel = (status) => STATUS_LABEL[status] || String(status)

const HEX64 = /^[0-9a-f]{64}$/
const LABEL = /^[\x20-\x7e]{1,64}$/

// The same shape `agents.html` validates before rendering a row. `freshBridge()` checks the
// envelope — signature, bridge key, freshness — but not this, so a picker built from the state has
// to check it here rather than trust that somebody upstream did.
export function validAgent(agent) {
  if (!agent || typeof agent !== 'object') return false
  if (!HEX64.test(String(agent.pubkey || ''))) return false
  if (!STATUSES.includes(agent.status)) return false
  if (agent.label != null && (typeof agent.label !== 'string' || !LABEL.test(agent.label))) return false
  return true
}

// Live agents first, then paused, then removed — but NONE of them dropped. A paused agent that
// vanishes from the list sends the operator hunting for an identity that is right there; showing it
// marked is the difference between "cannot be picked" and "is not here".
const RANK = new Map(STATUSES.map((status, index) => [status, index]))

export function rosterAgents(state) {
  const agents = Array.isArray(state?.agents) ? state.agents.filter(validAgent) : []
  return agents.slice().sort((a, b) => {
    const rank = (RANK.get(a.status) ?? STATUSES.length) - (RANK.get(b.status) ?? STATUSES.length)
    if (rank !== 0) return rank
    return (a.label || '').localeCompare(b.label || '') || a.pubkey.localeCompare(b.pubkey)
  })
}

export const npubOf = (pubkey) => { try { return nip19.npubEncode(pubkey) } catch { return pubkey } }

// npub1 + 58 more characters, and the middle of it carries nothing a person can check. Show both
// ends so two roster entries can be told apart, and never elide so far that they cannot.
export function shortNpub(pubkey, head = 12, tail = 6) {
  const encoded = npubOf(pubkey)
  if (encoded.length <= head + tail + 1) return encoded
  return `${encoded.slice(0, head)}…${encoded.slice(-tail)}`
}

// An admitted agent reads as its name. Anything else carries its status in the row, because the
// operator is choosing a routing target and "removed" is the part that changes the decision.
export function agentOptionText(agent) {
  const name = agent.label || 'unnamed agent'
  const suffix = agent.status === 'admitted' ? '' : ` — ${statusLabel(agent.status)}`
  return `${name} — ${shortNpub(agent.pubkey)}${suffix}`
}
