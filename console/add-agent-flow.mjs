// add-agent-flow.mjs — the seven steps of the "Add an agent" page (#649, docs/DESIGN_ADD_AN_AGENT.md).
//
// The owner signs three times: the tools (step 3), the hive invite (step 5) and who gives it work
// (step 6). Each is a newer add_agent request for the same agent, so each carries everything chosen
// so far. Step 6 also signs a task approval (a 440) from the owner for each giver who lacks one (#716); nvoy-onboard continues the install when the identity fields match, and its join step waits,
// "pending", until a request carries the invite. A step is done only when the page has read its
// request back cold from the relays, never because a relay said OK.

import { SETUP_KIND, requestD } from './hive-add-agent.mjs'
import { readGrants, scopeTable } from './hive-list.mjs'
import { foldGrantsWith } from './vendor/nvoy-admission.mjs'
import { WORK_CAPS } from './hive-change.mjs'

export const STEPS = Object.freeze([
  { n: 1, label: 'Name it', sub: 'who it is and where it runs' },
  { n: 2, label: 'Make its key', sub: 'in your Bunker' },
  { n: 3, label: 'Set up its tools', sub: 'on the server, one signature' },
  { n: 4, label: 'Start it on its box', sub: 'one line on its box' },
  { n: 5, label: 'Join the hive', sub: 'you agree, it joins itself' },
  { n: 6, label: 'Who can give it work', sub: 'one click, then your signer' },
  { n: 7, label: 'Prove it works', sub: 'read back from the relay' },
])

// Steps the page cannot carry out yet, and what each waits on. Shown as such, never as done.
export const NOT_BUILT = Object.freeze({
  7: 'The checks are not built yet. Until they are, look for its hello in #waggle-test.',
})

// Steps the page carries out only in part, and what the missing part waits on. Never shown as done:
// step 4 is done only when the fleet's receipt and the agent's presence say so, and the page does not
// read either yet.
export const PART_BUILT = Object.freeze({
  4: 'The page does not show the install line or check the connection yet. The operator gives you the line; run it on the box, then paste the key it prints here and sign it.',
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
// Step 6 is done only when its request is the newest and every giver it names holds a live task
// approval from the owner over the agent (`plan`, from workGrantPlan).
export function readBackSteps(ev, { sixth = null, plan = null } = {}) {
  if (!ev) return { 3: false, 5: false, 6: false, givers: [] }
  const givers = ev.tags.filter(t => t[0] === 'giver').map(t => t[1])
  return { 3: true, 5: !!joinOf(ev), 6: !!sixth && ev.id === sixth && !!plan && !plan.uncertain && plan.missing.length === 0, givers }
}

// Who still needs the owner's approval to give the agent work (#716). A giver on the request is not
// enough: without a live 440 from the owner over the agent, nvoy hears their mentions as data only and
// wakes nothing. `events` are the owner's 440s and 441s, folded with nvoy's own fold, so the page and
// the broker agree: the newest approval per giver and capability wins, and withdrawing it leaves none.
// `full` is false when a relay did not answer in full; then nothing counts as missing for certain, and
// step 6 is not done. The owner comes first, so a signer that stops part way has approved the owner.
export async function workGrantPlan({ owner, agent, givers, events, verify, scopeHash, full = true }) {
  const table = await scopeTable([agent], readGrants(events, { verify }).grants, scopeHash)
  const { live } = foldGrantsWith(events, { me: agent, grantors: [owner], scopeHash: table.hashOf })
  const held = pk => WORK_CAPS.some(cap => live.get(pk)?.has(cap))
  const want = [...new Set(givers || [])].filter(pk => pk !== agent).sort((a, b) => (b === owner) - (a === owner))
  return { held: want.filter(held), missing: want.filter(pk => !held(pk)), uncertain: !full }
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
// keys only. Unknown (null) unless that read was of this owner's hive, was read in full, and names
// the agent: a short read can leave a giver out, and copying it would sign the shorter list.
export const HANDOFF = 'waggle-hive-givers'
export function handoffState(handoff, owner) {
  if (!handoff || !owner) return 'none'
  if (handoff.owner !== owner) return 'other-owner'
  return handoff.complete === true ? 'full' : 'partial'
}
export function sameAs(handoff, { owner, like }, choices) {
  if (handoffState(handoff, owner) !== 'full' || !like || !Array.isArray(handoff.givers?.[like])) return null
  const offered = new Set(choices.map(c => c.pubkey))
  return handoff.givers[like].filter(pk => offered.has(pk))
}

// Chosen givers against the choices the page shows now. A key saved in this tab can drop out of
// them (a newer hive read, another owner), and nothing hidden is ever signed: `gone` must be dropped,
// or offered again, before any signature. `shortOf` names a key that no longer has a label.
export function reconcileGivers(chosen, choices) {
  const offered = new Set(choices.map(c => c.pubkey))
  return { kept: chosen.filter(pk => offered.has(pk)), gone: chosen.filter(pk => !offered.has(pk)) }
}
export function goneLine(gone, shortOf) {
  if (!gone.length) return null
  const one = gone.length === 1
  return `${one ? 'One' : gone.length} chosen earlier ${one ? "isn't" : "aren't"} in this hive's list now: ${gone.map(pk => shortOf(pk)).join(', ')}. Nothing is signed until you drop ${one ? 'it' : 'them'} in step 6, or open the hive again in this tab if ${one ? 'it belongs' : 'they belong'} there.`
}

// Who the hive grid draws, as it last read them in this tab: the people and Buzz agents that have no
// agent card are givers too. Only this owner's hive, and only well-formed entries.
const HEX64 = /^[0-9a-f]{64}$/
export function hiveChoices(handoff, owner) {
  if (handoffState(handoff, owner) === 'none' || handoff.owner !== owner || !Array.isArray(handoff.hive)) return []
  return handoff.hive.filter(c => HEX64.test(c?.pubkey || '') && c.pubkey !== owner && typeof c.label === 'string')
    .map(c => ({ pubkey: c.pubkey, label: c.label.slice(0, 64), where: typeof c.where === 'string' ? c.where.slice(0, 80) : 'in your hive' }))
}

// A reload part way through: the agent this page is adding has published its card since, so it is in
// `installed` under the same name and key. That one entry is not a duplicate when this owner's own
// setup request for that name and key was read back (`latest`, from newestAdd). Any other entry with
// the name or the key still is.
export function othersThan(installed, { name, agent, owner, latest }) {
  if (!latest || latest.pubkey !== owner || tagOf(latest, 'p') !== agent || tagOf(latest, 'd') !== requestD(name, 'add_agent')) return installed
  return installed.filter(e => !(e.id === name && e.pubkey === agent))
}

// A setup request is continued, never edited: nvoy refuses a newer request for the same agent whose
// harness or starting agent differs from the one it is installing. What the newest request fixed, and
// the refusal to show before a signature when the page's choice has drifted from it.
export function fixedBy(latest) {
  const harness = latest && tagOf(latest, 'harness'), like = latest && tagOf(latest, 'like')
  return harness && like ? { harness, like } : null
}
export function changedFrom(latest, { harness, like }) {
  const f = fixedBy(latest)
  const what = f ? [f.harness !== harness && 'what it runs in', f.like !== like && 'the agent it starts like'].filter(Boolean) : []
  return what.length ? `Its setup was already sent, so ${what.join(' and ')} can't change now. Put ${what.length > 1 ? 'them' : 'it'} back in step 1, or add it under a new name.` : null
}

// Step 6, as nvoy carries it out: the fleet adds the new agent to the @mention list of each chosen
// giver with a seat on the server box. A giver with no agent card of yours has no seat, so the fleet
// records the choice and runs nothing for it. You need no list.
export function giverPlan(chips) {
  return { outside: chips.filter(c => c.outside && !c.isOwner) }
}

// The rooms step 5 offers (#683), from a read of the room relay (room-lists.mjs roomsOf). Ticked to
// start: the rooms the agent it works like is in, and the hive's default room (James, 2026-11-06:
// "waggle-test"). A closed room takes no join, so it is offered as one the owner adds it to once it
// has started. `joined` is true only when the room's own signed member list names the agent.
export const DEFAULT_ROOM = 'waggle-test'
export function roomChoices(read, { like = null, agent = null } = {}) {
  if (!read?.names) return []
  const out = []
  for (const [id, name] of read.names) {
    const members = read.rooms?.get(id)
    const shown = name ? name.replace(/^#/, '') : id.slice(0, 8)
    const closed = !!read.closed?.has(id)
    out.push({ id, name: shown, closed, listed: !!members, joined: !!(agent && members?.has(agent)),
      start: !closed && (!!(like && members?.has(like)) || shown.toLowerCase() === DEFAULT_ROOM) })
  }
  return out.sort((a, b) => (b.start - a.start) || (a.closed - b.closed) || a.name.localeCompare(b.name))
}

// The rooms a signed request may carry: only rooms the page read in this visit that are still open to
// join. Saved choices with no read behind them are not signed (rooms: null); saved ones the read no
// longer offers, or that closed since they were ticked, are dropped and named.
export function roomsToSign(saved, read) {
  const want = Array.isArray(saved) ? saved : []
  if (!read) return { rooms: want.length ? null : [], dropped: [] }
  const open = new Set(roomChoices(read).filter(c => !c.closed).map(c => c.id))
  return { rooms: want.filter(id => open.has(id)), dropped: want.filter(id => !open.has(id)) }
}

// fields() runs at steps 2 and 3 too, where no room has been read yet. Only a signature needs a read:
// checking the key and name drafts with no rooms, so a restored form can still walk forward to step 5.
export const ROOMS_UNREAD = 'Read your rooms in step 5 first: the page signs only rooms it has just read.'
export function roomsFor(saved, read, { signing = false } = {}) {
  const picked = roomsToSign(saved, read)
  if (picked.rooms) return picked.rooms
  if (signing) throw new Error(ROOMS_UNREAD)
  return []
}

// Step 6 signs only on top of a signed step 5: a request sent without the invite would leave the agent
// out of its rooms, and the task approvals would follow it. null when it may sign, else why not.
export const workSignGate = joined => joined ? null : 'Sign step 5 first, so this request carries the invite to your rooms. Nothing was signed.'
