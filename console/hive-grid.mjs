// The hive as one grid (#662): a row per agent, a column per identity that can give work, and a
// square where they meet. Pure, so the page and the tests read the same answers.
import { WORK_CAPS, PASS_CAPS, approvalsOf } from './hive-change.mjs'
import { PLATFORMS, platformOf } from './hive-list.mjs'

const AGENT_PLATFORMS = ['lab', 'third-party', 'grok', 'buzz']
const rank = row => row.isOwner ? -1 : PLATFORMS.findIndex(p => p.id === platformOf(row))
const givesWork = rows => new Set(rows.flatMap(r => r.answers?.work.givers.map(g => g.pubkey) || []))

// Columns: you, then every identity the page knows where it runs, then anyone else who gives some
// agent work. The bridge gives no work.
export function giversOf(rows) {
  const giving = givesWork(rows)
  return rows.filter(r => !r.isBridge && (r.isOwner || platformOf(r) !== 'other' || giving.has(r.pubkey)))
    .sort((a, b) => rank(a) - rank(b))
}

// Rows: every agent the page knows where it runs, and anyone else that takes work. The rest have
// an empty row, so they fold into one line; one that gives work still heads its column.
export function agentsOf(rows) {
  const shown = [], folded = []
  for (const r of rows) {
    if (r.isOwner || r.isBridge) continue
    ;(AGENT_PLATFORMS.includes(platformOf(r)) || r.answers?.work.givers.length ? shown : folded).push(r)
  }
  const groups = PLATFORMS.map(platform => ({ platform, rows: shown.filter(r => platformOf(r) === platform.id) })).filter(g => g.rows.length)
  return { groups, folded }
}

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

// "3 can give it work" under each name, counted as it will be once the waiting changes are signed.
export function summaryOf(count, partial = false) {
  if (!count) return partial ? 'Nobody, as far as the relays read show' : 'Nobody can give it work'
  return `${count} can give it work`
}

// The owner's approvals for the two ways in that waggle no longer uses (#658): the channel pass
// and waggle carrying. Nothing reads them since carrying stopped, so the page offers to withdraw them.
export function leftovers(grants, { owner }) {
  return grants.filter(g => g.live && g.grantor === owner && (PASS_CAPS.includes(g.cap) || g.cap === 'task-relay'))
}
