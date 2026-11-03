// add-agent-flow.mjs — the seven steps of the "Add an agent" page (#649, docs/DESIGN_ADD_AN_AGENT.md).
//
// The owner signs three times: the tools (step 3), the hive invite (step 5) and who gives it work
// (step 6). Each is a newer add_agent request for the same agent, so each carries everything chosen
// so far; nvoy-onboard continues the install when the identity fields match, and its join step waits,
// "pending", until a request carries the invite. A step is done only when the page has read its
// request back cold from the relays, never because a relay said OK.

import { SETUP_KIND, requestD } from './hive-add-agent.mjs'

export const STEPS = Object.freeze([
  { n: 1, label: 'Name it', sub: 'who it is and where it runs' },
  { n: 2, label: 'Make its key', sub: 'in your Bunker' },
  { n: 3, label: 'Set up its tools', sub: 'on the server, one signature' },
  { n: 4, label: 'Start it on its box', sub: 'one line on its box' },
  { n: 5, label: 'Join the hive', sub: 'you agree, it joins itself' },
  { n: 6, label: 'Who can give it work', sub: 'one signature' },
  { n: 7, label: 'Prove it works', sub: 'read back from the relay' },
])

// Steps the page cannot carry out yet, and what each waits on. Shown as such, never as done.
export const NOT_BUILT = Object.freeze({
  4: 'The install line is not built yet (nvoy #294). Until it is, the operator starts it on its box.',
  7: 'The checks are not built yet. Until they are, look for its hello in #waggle-test.',
})

const tagOf = (ev, k) => ev.tags.find(t => t[0] === k)?.[1]

// The newest add_agent for this name, signed by the owner, valid, and naming this agent.
export function newestAdd(events, { owner, name, agent, verify }) {
  const d = requestD(name, 'add_agent')
  return (events || []).filter(ev => {
    if (ev?.kind !== SETUP_KIND || ev.pubkey !== owner || tagOf(ev, 'd') !== d || tagOf(ev, 'p') !== agent) return false
    // A plain copy, so a verification nostr-tools cached on an object that was edited since cannot vouch for it.
    try { return verify(JSON.parse(JSON.stringify(ev))) === true } catch { return false }
  }).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))[0] || null
}

// How the agent joins, as the request already holds it: the sealed invite, never the code.
export function joinOf(ev) {
  const invite = ev && tagOf(ev, 'invite')
  if (!invite) return null
  const age = tagOf(ev, 'age')
  return { invite, policy: tagOf(ev, 'policy') || '', ...(age ? { age } : {}) }
}

// What the newest request read back proves. Step 6 is done only when that newest request is the
// one the page sent from step 6 (`sixth`, its id): a giver list alone does not say the owner chose it.
export function readBackSteps(ev, { sixth = null } = {}) {
  if (!ev) return { 3: false, 5: false, 6: false, givers: [] }
  const givers = ev.tags.filter(t => t[0] === 'giver').map(t => t[1])
  return { 3: true, 5: !!joinOf(ev), 6: !!sixth && ev.id === sixth, givers }
}

// Step 6 picks from the hive grid's own groups, so it reads the same at 8 agents or 50: a search,
// the chosen as chips, and groups that fold, each with a count. `groups` and `groupOf` come from
// the page, so this stays free of the hive's lists.
export function pickerOf(choices, { chosen = [], q = '', folded = {}, groups, groupOf }) {
  const query = q.trim().toLowerCase(), on = new Set(chosen)
  const hit = c => !query || `${c.label} ${c.where}`.toLowerCase().includes(query)
  const shown = groups.map(g => {
    const all = choices.filter(c => groupOf(c) === g.id)
    const rows = all.filter(hit).map(c => ({ ...c, on: on.has(c.pubkey) }))
    return { id: g.id, label: g.label, n: all.length, picked: all.filter(c => on.has(c.pubkey)).length, open: query ? rows.length > 0 : !folded[g.id], rows }
  }).filter(g => g.n && (!query || g.rows.length))
  return { groups: shown, chips: choices.filter(c => on.has(c.pubkey)), none: !!query && !shown.length }
}

// "Same as {Works like}": who gives that agent work, as the hive last read it in this tab. Public
// keys only. Unknown (null) unless that read was of this owner's hive and names the agent.
export const HANDOFF = 'waggle-hive-givers'
export function sameAs(handoff, { owner, like }, choices) {
  if (!handoff || handoff.owner !== owner || !like || !Array.isArray(handoff.givers?.[like])) return null
  const offered = new Set(choices.map(c => c.pubkey))
  return handoff.givers[like].filter(pk => offered.has(pk))
}
