// The hive as one grid (#662): a row per identity that can give work, a column per agent that takes
// it, and a square where they meet, so reading across a row says whom it can give work to (#664).
// Pure, so the page and the tests read the same answers.
import { WORK_CAPS, PASS_CAPS, approvalsOf } from './hive-change.mjs'
import { PLATFORMS, RUNS_ON, platformOf } from './hive-list.mjs'

const AGENT_PLATFORMS = ['lab', 'third-party', 'grok', 'buzz']
const rank = row => row.isOwner ? -1 : PLATFORMS.findIndex(p => p.id === platformOf(row))
const givesWork = rows => new Set(rows.flatMap(r => r.answers?.work.givers.map(g => g.pubkey) || []))

// Columns: every agent the page knows where it runs, and anyone else that takes work. The rest
// take nothing, so they fold away.
export function agentsOf(rows) {
  const shown = [], folded = []
  for (const r of rows) {
    if (r.isOwner || r.isBridge) continue
    ;(AGENT_PLATFORMS.includes(platformOf(r)) || r.answers?.work.givers.length ? shown : folded).push(r)
  }
  const groups = PLATFORMS.map(platform => ({ platform, rows: shown.filter(r => platformOf(r) === platform.id) })).filter(g => g.rows.length)
  return { groups, folded }
}

// The whole grid. Rows: every identity but the bridge, grouped by where it runs, you first. One that
// is not active folds away, its row and its column together, last, so the top holds the agents and a
// new key can still be given its first work (#664). The owner says which are active (#666); until
// they do, one that runs nowhere known, gives no work and takes none is not.
export function gridOf(rows, active = null) {
  const giving = givesWork(rows)
  const { groups, folded } = agentsOf(rows)
  const quiet = active ? rows.filter(r => !r.isOwner && !r.isBridge && !active.has(r.pubkey))
    : folded.filter(r => platformOf(r) === 'other' && !giving.has(r.pubkey))
  const lines = PLATFORMS.map(platform => ({ platform,
    rows: rows.filter(r => !r.isBridge && !quiet.includes(r) && platformOf(r) === platform.id).sort((a, b) => rank(a) - rank(b)) }))
    .filter(g => g.rows.length)
  const takers = groups.flatMap(g => g.rows).filter(r => !quiet.includes(r))
  return { lines, takers, quiet, columns: [...takers, ...quiet] }
}

// The row above the names: one label over each run of neighbouring columns that share a harness
// (#668). Folded columns share one blank span, folded with them.
export function runsOf(columns, quiet = []) {
  const spans = []
  for (const r of columns) {
    const more = quiet.includes(r), label = more ? '' : RUNS_ON[r.pubkey] || ''
    const last = spans.at(-1)
    if (last && last.label === label && last.more === more) last.span++
    else spans.push({ label, span: 1, more })
  }
  return spans
}

// The owner's say over which identities are active (#666): one replaceable event, signed by the owner
// alone, naming each active key. The newest valid one wins; without one, the grid decides.
export const ACTIVE_KIND = 30078, ACTIVE_D = 'waggle-hive-active'
const HEX64 = /^[0-9a-f]{64}$/
export function readActive(events, { owner, verify }) {
  let best = null
  for (const ev of events || []) {
    try {
      if (ev?.kind !== ACTIVE_KIND || ev.pubkey !== owner || !ev.tags.some(t => t[0] === 'd' && t[1] === ACTIVE_D) || !verify(ev)) continue
      if (!best || best.signedAt < ev.created_at) best = { keys: new Set(ev.tags.filter(t => t[0] === 'p' && HEX64.test(t[1])).map(t => t[1])), signedAt: ev.created_at }
    } catch { /* an unreadable list is no list */ }
  }
  return best
}
// Only a read that every relay answered in full says what the list holds now: a relay that did not
// answer may hold a newer one. Until then the ticks show the grid's guess and cannot change it.
export const activeOf = (read, ctx) => ({ keys: readActive(read.events, ctx)?.keys || null, known: !!read.full })
// The ticks waiting to be signed, as one replacement of the whole list, or nothing while it is unknown.
export function tickChange({ active, ticks, known }, nameOf) {
  if (!known || !ticks.size) return null
  const keys = new Set(active), on = [], off = []
  for (const [pk, want] of ticks) { if (want) keys.add(pk); else keys.delete(pk); (want ? on : off).push(nameOf(pk)) }
  return { keys, words: [on.length && `mark ${on.join(', ')} active`, off.length && `set ${off.join(', ')} aside`].filter(Boolean).join('; ') }
}
export const activeNow = (rows, active = null) => new Set(gridOf(rows, active).lines.flatMap(g => g.rows).filter(r => !r.isOwner).map(r => r.pubkey))
export const draftActive = (keys, now = Math.floor(Date.now() / 1000)) =>
  ({ kind: ACTIVE_KIND, created_at: now, content: '', tags: [['d', ACTIVE_D], ...[...keys].sort().map(k => ['p', k])] })

// Whom a Buzz agent takes work from (#672). Buzz Desktop keeps each agent's allow-list on the owner's
// machine, and no API reads it, so the owner signs a copy: one replaceable event like the Active list,
// an `agent` tag per Buzz agent and an `allow` tag per sender ('*' for anyone). The page can only copy
// what Buzz holds; changing it stays in Buzz.
export const BUZZ_D = 'waggle-hive-buzz-allow'
export function readBuzz(events, { owner, verify }) {
  let best = null
  for (const ev of events || []) {
    try {
      if (ev?.kind !== ACTIVE_KIND || ev.pubkey !== owner || !ev.tags.some(t => t[0] === 'd' && t[1] === BUZZ_D) || !verify(ev)) continue
      if (best && best.signedAt >= ev.created_at) continue
      const lists = new Map(ev.tags.filter(t => t[0] === 'agent' && HEX64.test(t[1])).map(t => [t[1], new Set()]))
      for (const [k, agent, sender] of ev.tags) if (k === 'allow' && lists.has(agent) && (sender === '*' || HEX64.test(sender))) lists.get(agent).add(sender)
      best = { lists, signedAt: ev.created_at }
    } catch { /* an unreadable copy is no copy */ }
  }
  return best
}
// As with the Active list, only a read every relay answered in full says what the copy holds now.
export function buzzOf(read, ctx) {
  const b = readBuzz(read.events, ctx)
  return { lists: b?.lists || null, signedAt: b?.signedAt || null, known: !!read.full }
}
export const draftBuzz = (lists, now = Math.floor(Date.now() / 1000)) => ({ kind: ACTIVE_KIND, created_at: now, content: '',
  tags: [['d', BUZZ_D], ...[...lists.keys()].sort().flatMap(a => [['agent', a], ...[...lists.get(a)].sort().map(s => ['allow', a, s])])] })
export const sameBuzz = (a, b) => !!a && !!b && a.size === b.size && [...a].every(([k, s]) => b.has(k) && b.get(k).size === s.size && [...s].every(x => b.get(k).has(x)))
export function buzzWords(lists, nameOf) {
  const each = [...lists].map(([a, s]) => `${nameOf(a)} takes work from ${s.has('*') ? 'anyone' : !s.size ? 'nobody' : s.size === 1 ? nameOf([...s][0]) : `${s.size} identities`}`).sort()
  return `copy Buzz Desktop's allow-lists: ${each.join('; ')}`
}
// A Buzz agent is one the page knows runs in Buzz, or one a copy names. Buzz alone decides who gives
// it work, so once the page reads Buzz copies its square never falls back to nvoy: until a full read
// returns a copy naming it, the answer is unknown.
export const isBuzz = (row, buzz) => platformOf(row) === 'buzz' || !!buzz?.lists?.has(row.pubkey)
const buzzList = (row, buzz) => buzz.known ? buzz.lists?.get(row.pubkey) || null : null
const buzzTakes = (list, giver) => list.has('*') || list.has(giver.pubkey)

// The agents a giver can give work to now, by nvoy's fold, or by Buzz for a Buzz agent.
export const reachOf = (rows, giver, buzz = null) => rows.filter(r => {
  if (!buzz || !isBuzz(r, buzz)) return r.answers?.work.givers.some(g => g.pubkey === giver.pubkey)
  const list = buzzList(r, buzz)
  return !!list && r.pubkey !== giver.pubkey && buzzTakes(list, giver)
})

// One square. `on` is what nvoy's fold says now; `mine` are the owner's own approvals behind it,
// the only ones the owner can withdraw. A square that cannot change says why. A Buzz agent's
// square is Buzz's answer, and the page never offers to change it.
export function cellOf(row, giver, { owner, grants, subjectOf, buzz = null }) {
  if (row.pubkey === giver.pubkey) return { on: false, self: true }
  if (buzz && isBuzz(row, buzz)) {
    const list = buzzList(row, buzz)
    if (!list) return { on: false, can: false, buzz: true, unknown: true, why: buzz.known
      ? "Buzz Desktop decides this, and this agent's allow-list has not been copied here yet. Run tools/buzz-allow.mjs on the machine that runs Buzz."
      : 'Not every relay returned your copy of the Buzz allow-lists, so this is unknown. Read again.' }
    const on = buzzTakes(list, giver)
    return { on, can: false, buzz: true, why: `Buzz Desktop decides this: ${on ? 'it is' : 'it is not'} on this agent's allow-list. Change it in Buzz Desktop, then copy the lists here again.` }
  }
  const g = row.answers.work.givers.find(x => x.pubkey === giver.pubkey)
  // Only approvals from grantors the agent counts keep a square on, as in answersFor: its card's
  // grantors, or the owner alone without a card. Another approval it ignores never locks a square.
  const counted = row.card ? row.card.grantors : [owner]
  const held = approvalsOf(grants, { subject: row.pubkey, grantee: giver.pubkey, caps: WORK_CAPS, subjectOf })
    .filter(x => counted.includes(x.grantor))
  const mine = held.filter(x => x.grantor === owner)
  const counts = counted.includes(owner)
  if (!g) return counts ? { on: false, mine, can: true } : { on: false, mine, can: false, why: 'Its card does not count your approvals, so one from you would do nothing.' }
  if (g.voice) return { on: true, mine, can: false, why: 'Gives work as your voice, wherever you can. It stops only if it stops speaking for you.' }
  const others = [...new Set(held.filter(x => x.grantor !== owner).map(x => x.grantor))]
  if (!mine.length) return { on: true, mine, can: false, others, why: 'Approved by someone else; only they can withdraw it.' }
  if (others.length) return { on: true, mine, can: false, others, why: 'Also approved by someone else, so withdrawing yours would not stop it.' }
  return { on: true, mine, can: true }
}

// Clicking a square flips it between what it is and its opposite, waiting for a signature.
export const cellKey = (row, giver) => `${row.pubkey}>${giver.pubkey}`
export function toggle(pending, key, cell) {
  const next = new Map(pending)
  if (next.has(key)) next.delete(key)
  else if (cell.can) next.set(key, cell.on ? 'remove' : 'add')
  return next
}
export const squareOf = (cell, change) => cell.self ? 'self' : change || (cell.on ? 'on' : 'off')

export function changeWords({ action, giver, agent }, nameOf) {
  const who = nameOf(giver), whom = nameOf(agent)
  return action === 'add' ? `${who} may give ${whom} work` : `${who} stops giving ${whom} work`
}

// "Gives work to 3" under each name, counted as it will be once the waiting changes are signed.
export function summaryOf(count, partial = false) {
  if (!count) return partial ? 'Gives work to nobody, as far as the relays read show' : 'Gives work to nobody'
  return `Gives work to ${count}`
}

// The owner's approvals for the two ways in that waggle no longer uses (#658): the channel pass
// and waggle carrying. Nothing reads them since carrying stopped, so the page offers to withdraw them.
export function leftovers(grants, { owner }) {
  return grants.filter(g => g.live && g.grantor === owner && (PASS_CAPS.includes(g.cap) || g.cap === 'task-relay'))
}

// Needs you, for approvals that do nothing (#670): one plain item per kind of approval, naming the
// agents, instead of a line per approval. Only the one who gave them can withdraw them.
const TIDY = ['replaced', 'duplicate', 'expired']
const listed = names => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
export const day = at => new Date(at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
function deed(cap, giver, agents) {
  const whose = giver === 'you' ? 'your' : `${giver}'s`
  if (cap === 'task+act') return `${agents} act on ${whose} work without asking`
  if (cap === 'task') return `${agents} take work from ${giver}`
  return `${agents} hold a "${cap}" approval for ${giver}`
}
export function idleOf(needs, { owner, nameOf }) {
  const groups = new Map(), rest = []
  for (const n of needs) {
    if (!TIDY.includes(n.kind) || !n.grant) { rest.push(n); continue }
    const g = n.grant, key = [n.kind, g.grantor, g.grantee, g.cap].join('|')
    if (!groups.has(key)) groups.set(key, { kind: n.kind, grantor: g.grantor, grantee: g.grantee, cap: g.cap, needs: [] })
    groups.get(key).needs.push(n)
  }
  const named = s => /^[0-9a-f]{64}$/.test(s || '') ? nameOf(s) : s || 'an agent'
  return { rest, groups: [...groups.values()].map(x => {
    const who = nameOf(x.grantor), giver = nameOf(x.grantee), count = x.needs.length, one = count === 1
    const agents = listed([...new Set(x.needs.map(n => named(n.subject)))].sort())
    const days = [...new Set(x.needs.map(n => n.grant.at).sort((a, b) => a - b).map(day))]
    const when = days.length === 1 ? `On ${days[0]}` : `Between ${days[0]} and ${days.at(-1)}`
    const did = `${who} let ${deed(x.cap, giver, agents)}`
    const text = x.kind === 'replaced'
      ? `${when} ${did}. That later ended, so ${x.cap === 'task+act' ? 'today they ask before acting' : 'it no longer holds'}. ${one ? 'This old approval was' : `These ${count} old approvals were`} left behind and ${one ? 'does' : 'do'} nothing.`
      : x.kind === 'duplicate'
        ? `${when} ${did} more than once. Only the newest counts, so ${one ? 'the older copy does' : `the ${count} older copies do`} nothing.`
        : `${when} ${did}, but ${one ? 'it has' : 'they have'} run out. ${one ? 'The expired approval is' : `The ${count} expired approvals are`} still published and ${one ? 'does' : 'do'} nothing.`
    const can = x.grantor === owner
    return { kind: x.kind, text: `${text[0].toUpperCase()}${text.slice(1)}${can ? '' : ` Only ${who} can withdraw ${one ? 'it' : 'them'}.`}`, can,
      grants: x.needs.map(n => ({ grant: n.grant, words: `withdraw an old approval that let ${deed(x.cap, giver, named(n.subject))}` })) }
  }) }
}

// Groups once the rooms are read (docs/DESIGN_HIVE_CONSOLE.md, "Groups once the rooms are read"). A
// room can be a group only if its list was read and trusted and it holds at least two agents the
// grid shows, not counting you; each agent sits in the smallest such room, ties to the room id that
// sorts first. You and your voice stay first, the rest go last in "Other agents", and the columns follow the rows.
// Counted from the grid's own rows, never from what a search or a fold hides, so neither can move
// anyone. Null when no room can be a group, and the grid stays grouped by where they run.
export const OTHER_AGENTS = 'Other agents'
export function roomLinesOf({ lines, takers, quiet }, read) {
  const you = lines.filter(l => l.platform.id === 'you')
  const shown = lines.filter(l => l.platform.id !== 'you').flatMap(l => l.rows), keys = new Set(shown.map(r => r.pubkey))
  const rooms = [...read?.rooms || []].map(([id, members]) => ({ id, members }))
    .filter(g => [...g.members].filter(k => keys.has(k)).length >= 2)
    .sort((a, b) => a.members.size - b.members.size || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (!rooms.length) return null
  const homes = new Map(rooms.map(g => [g.id, []])), other = []
  for (const r of shown) { const g = rooms.find(x => x.members.has(r.pubkey)); (g ? homes.get(g.id) : other).push(r) }
  const out = [
    ...you,
    ...rooms.filter(g => homes.get(g.id).length).map(g => ({ room: g.id, platform: { id: `room:${g.id}`, label: read.names?.get(g.id) || g.id, runs: 'room' }, rows: homes.get(g.id) })),
    ...other.length ? [{ platform: { id: 'other-agents', label: OTHER_AGENTS }, rows: other }] : [],
  ]
  const order = new Map(out.flatMap(l => l.rows).map((r, i) => [r.pubkey, i]))
  const byRow = [...takers].sort((a, b) => (order.get(a.pubkey) ?? Infinity) - (order.get(b.pubkey) ?? Infinity))
  return { lines: out, takers: byRow, quiet, columns: [...byRow, ...quiet] }
}

// The line above the grid: how it is grouped, and the switch if there is one. `read` is whether the
// rooms were read; `grouped` whether the grid is grouped by them; `possible` whether any room can be
// a group; `unread` how many rooms' lists weren't read or trusted; `at` the clock time of the read.
export function groupingLine({ read, grouped, possible = true, unread = 0, at = '' }) {
  if (!read) return { text: 'Grouped by where they run', button: null }
  if (!possible) return { text: `Grouped by where they run: no room read at ${at} holds two of these agents`, button: null }
  if (!grouped) return { text: 'Grouped by where they run', button: 'Group by room' }
  return { text: unread ? `Grouped by the rooms read, ${at}: ${unread === 1 ? "1 room's list wasn't" : `${unread} rooms' lists weren't`} read` : `Grouped by room, read ${at}`, button: 'Group by where they run' }
}

// The rooms read and trusted that an agent is in, for its panel. Never every room it is in.
export function roomsOfAgent(pk, read) {
  if (!read?.rooms) return null
  return [...read.rooms].filter(([, m]) => m.has(pk)).map(([id]) => id).sort()
}
