// hive-what-if.mjs — "what happens if this author mentions this agent here?" (#613 M3, criterion 5).
//
// The answer is nvoy's own decision, not a re-telling of it. The broker gets its grants from
// attention.mjs --policy-only, which flattens the fold into { pubkey, cap, grant_id, grantor, shadow }
// rows, and hands them to nativeGrant with the manifest's grantors. This module flattens the same
// fold the same way and calls the vendored nativeGrant (vendor/nvoy-admission.mjs, hash-pinned by
// tests/console_hive_list.mjs), so the page and the broker cannot disagree about whose mention is
// work. The grantors are the ones the agent's own card attests to, as on the rest of the page.
//
// What it cannot see is said, not guessed: the hourly and hop counters live on the fleet, so it
// reports the limits that apply rather than whether one is spent; the card withholds channel names,
// so "in a channel" means a channel the agent listens in; and work carried in by waggle takes a
// different path, which this does not check.

import { nativeGrant } from './vendor/nvoy-admission.mjs'

// attention.mjs's --policy-only rows, from the fold the page already holds.
export const policyGrants = fold => [...fold.entries()].flatMap(([pubkey, caps]) => [...caps.values()].map(g =>
  ({ pubkey, cap: g.cap, grant_id: g.grantId, grantor: String(g.grantor).toLowerCase(), ...(g.shadow ? { shadow: true } : {}) })))

export function whatIf({ author, row, dm, owner, nameOf }) {
  const agent = nameOf(row.pubkey), who = author === owner ? 'you' : nameOf(author)
  const Who = who === 'you' ? 'You' : who
  const where = dm ? 'in a DM' : 'in a channel it listens in'
  const grantors = row.card ? row.card.grantors : [owner]
  const caveats = []
  if (!row.card) caveats.push(`${agent} has published no agent card, so whether anything runs for this key is not reported, and only your approvals are counted.`)
  if (author === row.pubkey) return { work: false, text: `Not work: ${agent} does not take work from its own messages.`, caveats }

  // The broker's order: a DM from anyone but the owner is refused before any grant is read.
  if (dm && !grantors.includes(author)) return { work: false, grant: null, caveats,
    text: `Not work: chat only. In a DM only ${agent}'s owner can give it work, and ${who} ${who === 'you' ? 'are' : 'is'} not ${grantors.includes(owner) ? 'its owner' : 'among the owners its card names'}.` }

  const grant = nativeGrant({ author, dm, grants: policyGrants(row.answers.fold), grantors })
  if (!grant) return { work: false, grant: null, caveats,
    text: `Not work: chat only, because ${who} hold${who === 'you' ? '' : 's'} no live approval to give ${agent} work. ${Who} can still talk ${where}; ${agent} hears it as conversation.` }

  const through = grant.shadow
    ? `as ${grant.grantor === owner ? 'your' : `${nameOf(grant.grantor)}'s`} voice, through ${grant.grantor === owner ? 'your' : 'their'} own approval`
    : `through ${who === 'you' ? 'your' : `${who}'s`} ${grant.cap === 'task+act' ? 'act-without-asking' : 'work'} approval from ${grant.grantor === owner ? 'you' : nameOf(grant.grantor)}`
  const acts = grant.cap === 'task+act' ? `${agent} may act on it without asking.` : `${agent} asks before acting on it.`
  const limits = row.card?.agent_limits
  if (limits) caveats.push(grantors.includes(author)
    ? `Limits apply: a chain of agent messages stops at ${limits.max_hops} hops. The counters are on the fleet, so whether one is spent is not shown.`
    : `Limits apply: at most ${limits.per_sender_per_hour} admitted an hour from ${who}, and a chain stops at ${limits.max_hops} hops. The counters are on the fleet, so whether one is spent is not shown.`)
  return { work: true, grant, caveats, text: `Admitted as work ${where}, ${through} (approval ${grant.grant_id.slice(0, 10)}…). ${acts}` }
}
