// console_hive_grid.mjs — the hive as one grid of who can give work to whom (#662, #664).
//
// What this suite holds:
//
//  1. The rows are every identity that might give work, grouped by where it runs, you first; the
//     bridge has none, and an identity that runs nowhere known, gives nothing and takes nothing is
//     quiet: its row and its column fold away together.
//  2. The columns are the agents the page knows where they run and anyone that takes work, so
//     reading across a row says whom it can give work to (#664). A quiet identity's column comes
//     last, folded, so a newly found key can still be given its first work.
//  3. A square the owner cannot change says why, and is never offered: a voice's reach, someone
//     else's approval, an approval someone else also gave, a card that does not count the owner.
//     An approval from a grantor the agent does not count locks nothing: the agent ignores it.
//  4. Clicking a square waits for a signature, and clicking it again takes that back.
//  5. Old channel passes and waggle carrying, which nothing reads since #658, are offered for
//     withdrawal: the owner's live ones only.
//
//   node tests/console_hive_grid.mjs

import { PLATFORMS } from '../console/hive-list.mjs'
import { gridOf, reachOf, agentsOf, cellOf, cellKey, toggle, squareOf, changeWords, summaryOf, leftovers } from '../console/hive-grid.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const key = id => PLATFORMS.find(p => p.id === id).keys
const [dj, mc, dev] = key('lab'), [pi] = key('third-party'), [mydude, dennis] = key('buzz')
const owner = '01'.repeat(32), voice = '02'.repeat(32), other = '03'.repeat(32), bridge = '04'.repeat(32), stray = '05'.repeat(32), giver = '06'.repeat(32)

let n = 0
const grant = (grantor, grantee, cap, subject, live = true) => ({ id: (++n).toString(16).padStart(64, '0'), grantor, grantee, cap, hash: subject, live })
const grants = [
  grant(owner, owner, 'task', pi), grant(owner, dev, 'task', pi),
  grant(owner, dj, 'task', pi), grant(other, dj, 'task', pi),
  grant(other, mydude, 'task', pi), grant(other, giver, 'task', pi),
  grant(owner, pi, 'admit', 'channel'), grant(owner, mc, 'admit', 'channel', false), grant(owner, bridge, 'task-relay', pi),
  grant(other, pi, 'admit', 'channel'),
]
const subjectOf = hash => hash
const giving = pks => pks.map(pk => ({ pubkey: pk, caps: ['task'], voice: pk === voice }))
const row = (pubkey, { givers = [], grantors = [owner], ...extra } = {}) =>
  ({ pubkey, roles: [], card: grantors ? { grantors } : null, answers: { work: { givers: giving(givers) } }, ...extra })
const rows = [
  row(owner, { isOwner: true }), row(bridge, { isBridge: true }), row(voice, { roles: [{ role: 'voice' }] }),
  row(stray), row(giver),
  row(pi, { givers: [owner, dev, dj, mydude, voice, giver], grantors: [owner, other] }),
  row(mc), row(dev), row(dj), row(mydude), row(dennis, { grantors: [other] }),
]
const at = pk => rows.find(r => r.pubkey === pk)
const ctx = { owner, grants, subjectOf }

// 1. Rows.
const { lines, takers, quiet, columns } = gridOf(rows)
check(JSON.stringify(lines.map(g => g.platform.id)) === JSON.stringify(['you', 'lab', 'third-party', 'buzz', 'other']), 'rows group by where they run, you first')
check(lines[0].rows[0].pubkey === owner && lines[0].rows[1].pubkey === voice, 'you head the first row, your voice the second')
check(lines.at(-1).rows.map(r => r.pubkey).join() === giver, 'an identity that gives work but runs nowhere known keeps its row')
const rowKeys = lines.flatMap(g => g.rows).map(r => r.pubkey)
check(!rowKeys.includes(bridge) && !rowKeys.includes(stray), 'the bridge has no row, and a quiet identity folds away')
check(quiet.map(r => r.pubkey).join() === stray, 'only the identity that gives, takes and runs nothing is quiet')
check(JSON.stringify(reachOf(rows, at(dev)).map(r => r.pubkey)) === JSON.stringify([pi]) && !reachOf(rows, at(mc)).length,
  'reading across a row counts whom it can give work to')

// 2. Columns.
check(JSON.stringify(takers.map(r => r.pubkey)) === JSON.stringify([mc, dev, dj, pi, mydude, dennis]), 'agents head the columns in platform order')
check(!takers.some(r => r.isOwner || r.isBridge || r.pubkey === voice), 'you, your voice and the bridge head no column')
check(JSON.stringify(columns.map(r => r.pubkey)) === JSON.stringify([...takers, ...quiet].map(r => r.pubkey)) && columns.at(-1).pubkey === stray,
  'a quiet identity heads the last column, folded with its row')
const first = cellOf(at(stray), at(owner), ctx)
check(!first.on && first.can, 'a newly found key can be given its first work from its column')
const { folded } = agentsOf(rows)
check(folded.map(r => r.pubkey).sort().join() === [voice, stray, giver].sort().join(), 'identities that take no work and run nowhere known head no agent column')

// 3. Squares.
check(cellOf(at(pi), at(pi), ctx).self, 'an agent meets itself in a square that does nothing')
const yours = cellOf(at(pi), at(owner), ctx)
check(yours.on && yours.can && yours.mine.length === 1, 'your own approval is on, and yours to withdraw')
check(cellOf(at(pi), at(dev), ctx).can, "an approval only you gave can be withdrawn")
const shared = cellOf(at(pi), at(dj), ctx)
check(shared.on && !shared.can && /also approved/i.test(shared.why), 'an approval someone else also gave is locked, and says so')
const theirs = cellOf(at(pi), at(mydude), ctx)
check(theirs.on && !theirs.can && /someone else/.test(theirs.why), "someone else's approval is locked, and says only they can withdraw it")
const asVoice = cellOf(at(pi), at(voice), ctx)
check(asVoice.on && !asVoice.can && /voice/.test(asVoice.why), "your voice's reach is locked, and says why")
const open = cellOf(at(mc), at(dev), ctx)
check(!open.on && open.can, 'an empty square can be filled')
// Its card counts only you, and the fold shows DJ Codex; another grantor's approval sits alongside, ignored.
const mcCounted = row(mc, { givers: [dj] })
const ignored = cellOf(mcCounted, at(dj), { ...ctx, grants: [...grants, grant(owner, dj, 'task', mc), grant(other, dj, 'task', mc)] })
check(ignored.on && ignored.can && ignored.mine.length === 1 && !ignored.others?.length, "an approval from someone the agent's card does not count never locks your square")
const uncounted = cellOf(at(dennis), at(owner), ctx)
check(!uncounted.on && !uncounted.can && /card/.test(uncounted.why), "a card that does not count your approvals locks its column's squares")

// 4. Waiting changes.
let pending = new Map()
pending = toggle(pending, cellKey(at(mc), at(dev)), open)
check(pending.get(cellKey(at(mc), at(dev))) === 'add' && squareOf(open, 'add') === 'add', 'clicking an empty square waits to add')
pending = toggle(pending, cellKey(at(pi), at(owner)), yours)
check(pending.get(cellKey(at(pi), at(owner))) === 'remove', 'clicking a filled square waits to remove')
pending = toggle(pending, cellKey(at(mc), at(dev)), open)
check(!pending.has(cellKey(at(mc), at(dev))) && pending.size === 1, 'clicking again takes the change back')
check(toggle(pending, cellKey(at(pi), at(mydude)), theirs).size === 1, 'a locked square waits for nothing')
check(squareOf(yours) === 'on' && squareOf(open) === 'off' && squareOf({ self: true }) === 'self', 'squares at rest show what holds now')
const nameOf = pk => ({ [dev]: 'waggle-dev', [mc]: 'MC Claude' })[pk]
check(changeWords({ action: 'add', giver: dev, agent: mc }, nameOf) === 'waggle-dev may give MC Claude work', 'an addition reads as one plain sentence')
check(changeWords({ action: 'remove', giver: dev, agent: mc }, nameOf) === 'waggle-dev stops giving MC Claude work', 'a removal reads as one plain sentence')
check(summaryOf(3) === 'Gives work to 3' && summaryOf(0) === 'Gives work to nobody' && /as far as/.test(summaryOf(0, true)), 'each row sums up in words')

// 5. Leftovers.
const left = leftovers(grants, { owner })
check(left.length === 2 && left.every(g => g.grantor === owner && g.live), "only the owner's live passes and carrying are offered for withdrawal")

if (!pass) { console.log('\nconsole_hive_grid: FAIL'); process.exit(1) }
console.log('\nconsole_hive_grid: ok')
