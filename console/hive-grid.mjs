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

// The agents a giver can give work to now, by nvoy's fold.
export const reachOf = (rows, giver) => rows.filter(r => r.answers?.work.givers.some(g => g.pubkey === giver.pubkey))

// One square. `on` is what nvoy's fold says now; `mine` are the owner's own approvals behind it,
// the only ones the owner can withdraw. A square that cannot change says why.
export function cellOf(row, giver, { owner, grants, subjectOf }) {
  if (row.pubkey === giver.pubkey) return { on: false, self: true }
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
