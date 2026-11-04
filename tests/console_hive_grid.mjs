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
//  6. The owner says which identities are active (#666): only their own newest signed list counts,
//     an identity left off it folds away, row and column together, and the list drafts as one
//     replaceable event naming public keys only. Without one, the grid decides as before. A list
//     read from fewer than every relay is unknown, and no tick may replace it.
//  7. Above the names, one label spans each run of neighbouring agents in the same harness (#668);
//     folded columns share one blank span that folds with them. Each harness shows its logo.
//  8. Approvals that do nothing read as one plain item per kind (#670): who let whom do what, when,
//     what holds today, and one withdrawal per approval for the owner's own; never an approval id.
//  9. A Buzz agent's column is Buzz Desktop's allow-list as the owner last copied it (#672): only
//     their own newest signed copy counts, its squares say "set in Buzz" and are never offered, a
//     copy read from fewer than every relay is unknown, and the copy tool and its link carry public
//     keys only.
//  3. A square the owner cannot change says why, and is never offered: a voice's reach, someone
//     else's approval, an approval someone else also gave, a card that does not count the owner.
//     An approval from a grantor the agent does not count locks nothing: the agent ignores it.
//  4. Clicking a square waits for a signature, and clicking it again takes that back.
// 10. Once the rooms are read, the grid groups by room (docs/DESIGN_HIVE_CONSOLE.md, "Groups once
//     the rooms are read"): a room is a group only with two agents the grid shows, not you; each
//     agent sits in its smallest such room, ties to the room id; you first, the rest in "Other
//     agents"; the columns follow the rows; and the line above the grid says how it is grouped.
//  5. Old channel passes and waggle carrying, which nothing reads since #658, are offered for
//     withdrawal: the owner's live ones only.
//
//   node tests/console_hive_grid.mjs

import { existsSync, readFileSync } from 'node:fs'
import { PLATFORMS, RUNS_ON, RUNS_LOGO } from '../console/hive-list.mjs'
import { buzzLists, buzzLink } from '../tools/buzz-allow.mjs'
import { parseIntent } from '../console/deep-link.mjs'
import { gridOf, reachOf, agentsOf, readActive, activeNow, draftActive, activeOf, tickChange, runsOf, idleOf, ACTIVE_KIND, ACTIVE_D, BUZZ_D, readBuzz, buzzOf, draftBuzz, sameBuzz, buzzWords, cellOf, cellKey, toggle, squareOf, changeWords, summaryOf, leftovers, roomLinesOf, groupingLine, roomsOfAgent, OTHER_AGENTS } from '../console/hive-grid.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const key = id => PLATFORMS.find(p => p.id === id).keys
const [mc, dev] = key('lab'), [dj, pi] = key('third-party'), [mydude, dennis] = key('buzz')
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
check(JSON.stringify(takers.map(r => r.pubkey)) === JSON.stringify([mc, dev, pi, dj, mydude, dennis]), 'agents head the columns in platform order')
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

// 6. Active.
const listed = (pubkey, keys, created_at, d = ACTIVE_D) => ({ kind: ACTIVE_KIND, pubkey, created_at, tags: [['d', d], ...keys.map(k => ['p', k])], content: '' })
const yes = () => true
const mine = readActive([listed(owner, [pi], 10), listed(owner, [pi, stray], 20), listed(other, [mc], 30), listed(owner, [dev], 40, 'something-else')], { owner, verify: yes })
check(mine.signedAt === 20 && [...mine.keys].sort().join() === [pi, stray].sort().join(), "only the owner's own newest list counts")
check(readActive([listed(owner, [pi], 10)], { owner, verify: () => false }) === null && readActive([], { owner, verify: yes }) === null, 'a list that does not verify is no list, and no list leaves the grid to decide')
const chosen = gridOf(rows, mine.keys)
check(chosen.lines.flatMap(g => g.rows).map(r => r.pubkey).sort().join() === [owner, pi, stray].sort().join(), 'with a list, you and the active identities have rows')
check(chosen.takers.map(r => r.pubkey).join() === pi && chosen.columns.at(-1).pubkey !== pi && chosen.columns.length === rows.length - 3,
  'an identity set aside folds its column too, so it can still be given work')
check(JSON.stringify([...activeNow(rows)].sort()) === JSON.stringify(lines.flatMap(g => g.rows).filter(r => r.pubkey !== owner).map(r => r.pubkey).sort()),
  'before any list, the active identities are the ones the grid shows')
const drafted = draftActive(new Set([pi, dev]), 99)
check(drafted.kind === ACTIVE_KIND && drafted.created_at === 99 && drafted.content === '' &&
  JSON.stringify(drafted.tags) === JSON.stringify([['d', ACTIVE_D], ...[pi, dev].sort().map(k => ['p', k])]), 'the list drafts as one replaceable event of public keys')

const full = activeOf({ events: [listed(owner, [pi], 10)], full: true }, { owner, verify: yes })
const short = activeOf({ events: [], full: false }, { owner, verify: yes })
check(full.known && full.keys.has(pi) && !short.known && short.keys === null, 'a list is known only from a read every relay answered in full')
const ticked = new Map([[pi, false], [dev, true]])
check(tickChange({ active: new Set([pi, mc]), ticks: ticked, known: false }, nameOf) === null,
  'while the list is unknown, no tick can replace it, so ticks signed before are never undone by a guess')
const change = tickChange({ active: new Set([pi, mc]), ticks: ticked, known: true }, pk => ({ [pi]: 'Pi Dog', [dev]: 'waggle-dev' })[pk])
check([...change.keys].sort().join() === [mc, dev].sort().join() && change.words === 'mark waggle-dev active; set Pi Dog aside',
  'once known, the ticks replace the list it holds now')

// 7. Runs on.
const runs = runsOf(columns, quiet)
check(JSON.stringify(runs) === JSON.stringify([
  { label: 'Claude Code', span: 2, more: false }, { label: 'Pi', span: 1, more: false }, { label: 'Hermes', span: 1, more: false },
  { label: 'Buzz', span: 2, more: false }, { label: '', span: 1, more: true }]), 'neighbours in one harness share one label, and folded columns one blank')
check(runs.reduce((n, r) => n + r.span, 0) === columns.length, 'the labels span every column exactly once')
check([...new Set(Object.values(RUNS_ON))].every(h => RUNS_LOGO[h] && existsSync(new URL(`../console/${RUNS_LOGO[h]}`, import.meta.url))), 'every harness named over a column has its logo, and the file is there')

// 8. Approvals that do nothing.
const pk = c => c.repeat(64), me = pk('a'), names = { [pk('b')]: 'Pi Dog', [pk('c')]: 'DJ Codex', [pk('d')]: 'MC Claude', [pk('e')]: 'Dennis' }
const say = k => k === me ? 'you' : names[k] || k.slice(0, 8)
const oct19 = Date.UTC(2026, 9, 19, 12) / 1000
const old = (id, kind, subject, cap = 'task+act', grantor = me, grantee = me, at = oct19) => ({ kind, subject, text: 'raw', grant: { id, grantor, grantee, cap, at } })
const idle = idleOf([
  old('1', 'replaced', pk('c')), old('2', 'replaced', pk('b')), old('3', 'replaced', pk('d')),
  old('4', 'duplicate', pk('b'), 'task', me, pk('c'), oct19 - 86400 * 3),
  old('5', 'expired', pk('d'), 'task', pk('e'), pk('e')),
  { kind: 'no-card', pubkey: pk('c'), text: 'no card' },
], { owner: me, nameOf: say })
check(idle.groups.length === 3 && idle.rest.map(n => n.kind).join() === 'no-card', 'one item per kind of approval; anything else is left as it was')
check(idle.groups[0].text === 'On 19 Oct you let DJ Codex, MC Claude and Pi Dog act on your work without asking. That later ended, so today they ask before acting. These 3 old approvals were left behind and do nothing.',
  'replaced approvals say who, when, what holds today, and that they do nothing, in one sentence')
check(idle.groups[1].text === 'On 16 Oct you let Pi Dog take work from DJ Codex more than once. Only the newest counts, so the older copy does nothing.', 'an older copy says only the newest counts')
check(idle.groups[2].text === "On 19 Oct Dennis let MC Claude take work from Dennis, but it has run out. The expired approval is still published and does nothing. Only Dennis can withdraw it." && !idle.groups[2].can,
  "someone else's approval is explained but not offered: only they can withdraw it")
check(idle.groups[0].can && idle.groups[0].grants.map(g => g.grant.id).join() === '1,2,3' && idle.groups[0].grants[0].words === 'withdraw an old approval that let DJ Codex act on your work without asking',
  'the owner withdraws each approval in the group, each change in plain words')
check(!idle.groups.some(g => /[0-9a-f]{10}|from you to you/.test(g.text)), 'no approval ids and no "from you to you"')

// 9. Buzz allow-lists.
const lists = new Map([[mydude, new Set([owner, dj, voice])], [dennis, new Set(['*'])]])
const copy = { ...draftBuzz(lists, 200), pubkey: owner }
check(copy.kind === ACTIVE_KIND && copy.tags[0].join() === `d,${BUZZ_D}` && copy.tags.slice(1).every(t => t.slice(1).every(v => /^[0-9a-f]{64}$/.test(v) || v === '*')),
  'the copy drafts as one replaceable event of public keys only')
const signedBy = (ev, pubkey, at) => ({ ...ev, pubkey, created_at: at })
const older = signedBy(draftBuzz(new Map([[mydude, new Set([owner])]]), 100), owner, 100)
const read = readBuzz([older, copy, signedBy(draftBuzz(new Map(), 300), other, 300), { ...copy, tags: [['d', ACTIVE_D]], created_at: 400 }], { owner, verify: () => true })
check(read.signedAt === 200 && sameBuzz(read.lists, lists), "only the owner's own newest copy counts; another key's, or the Active list, is no copy")
check(!readBuzz([copy], { owner, verify: () => false }), 'an unverified copy is no copy')
const whole = buzzOf({ events: [copy], full: true }, { owner, verify: () => true })
const bctx = { ...ctx, buzz: whole }
const on = cellOf(at(mydude), at(dj), bctx), off = cellOf(at(mydude), at(dev), bctx), any = cellOf(at(dennis), at(dev), bctx)
check(on.on && on.buzz && !on.can && /Buzz Desktop/.test(on.why) && !off.on && off.buzz && !off.can && any.on,
  "a Buzz agent's square is its allow-list, marked as Buzz's, and never offered")
check(squareOf(on) === 'on' && cellOf(at(pi), at(dev), bctx).buzz === undefined, 'an agent with no Buzz list is still answered by nvoy')
check(JSON.stringify(reachOf(rows, at(dj), whole).map(r => r.pubkey)) === JSON.stringify([pi, mydude, dennis]) && !reachOf(rows, at(dennis), whole).some(r => r.pubkey === dennis),
  'reading across a row counts the Buzz agents that answer it, and never itself')
const part = { ...ctx, buzz: buzzOf({ events: [copy], full: false }, { owner, verify: () => true }) }
const unknown = cellOf(at(mydude), at(dj), part)
check(unknown.unknown && !unknown.on && !unknown.can && cellOf(at(dennis), at(dev), { ...ctx, buzz: buzzOf({ events: [], full: false }, { owner, verify: () => true }) }).unknown,
  'a copy read from fewer than every relay is unknown, even when no copy came back')
const none = buzzOf({ events: [], full: true }, { owner, verify: () => true }), bare = cellOf(at(mydude), at(owner), { ...ctx, buzz: none })
check(cellOf(at(mydude), at(owner), ctx).can && bare.buzz && bare.unknown && !bare.can && !bare.on && /not been copied/.test(bare.why) && !reachOf(rows, at(owner), none).some(r => [mydude, dennis].includes(r.pubkey)),
  'with no copy signed, a Buzz square is unknown and never offered, and counts for nobody, where nvoy alone would offer a grant')
const onlyMyDude = buzzOf({ events: [signedBy(draftBuzz(new Map([[mydude, new Set([owner])]]), 500), owner, 500)], full: true }, { owner, verify: () => true })
const omitted = cellOf(at(dennis), at(owner), { ...ctx, buzz: onlyMyDude })
check(omitted.unknown && !omitted.can && !omitted.on && cellOf(at(mydude), at(owner), { ...ctx, buzz: onlyMyDude }).on, 'a Buzz agent a copy leaves out is unknown, not handed to nvoy')
check(buzzWords(lists, say) === "copy Buzz Desktop's allow-lists: " + [`${say(dennis)} takes work from anyone`, `${say(mydude)} takes work from 3 identities`].sort().join('; '), 'the copy reads as one plain change')
const settings = [
  { name: 'My Dude', respond_to: 'owner-only', definition_respond_to: 'allowlist', system_prompt: 'secret' },
  { name: 'My Dude', pubkey: mydude.toUpperCase(), respond_to: 'allowlist', respond_to_allowlist: [dj, voice, dj, 'npub1junk'], auth_tag: 'tag', system_prompt: 'secret' },
  { name: 'Dennis', pubkey: dennis, respond_to: 'anyone' }, { name: 'Neil', pubkey: dev, respond_to: 'owner-only' }, { name: 'Odd', pubkey: giver, respond_to: 'mentions' },
]
const out = buzzLists(settings), link = buzzLink(out.parts)
check(out.skipped.join() === 'Odd' && out.parts.length === 3 && !/secret|tag|junk/.test(link), 'the tool reads keys only, and names a setting it does not know rather than guess')
const intent = parseIntent(new URL(link).hash)
check(intent.action === 'buzz' && JSON.stringify(intent.lists.find(([a]) => a === mydude)[1]) === JSON.stringify([dj, voice].sort()) && intent.lists.some(([a, s]) => a === dev && s.join() === 'owner'),
  'the link round-trips to the page as whole keys, with the owner and anyone marked')
check(parseIntent(`#buzz=${mydude}:abc`).action === 'invalid' && parseIntent(`#buzz=${mydude}:${dj}:x`).action === 'invalid', 'a link with anything but whole keys is refused')

// 10. Groups once the rooms are read.
{
  const base = gridOf(rows)
  const rooms = new Map([
    ['big', new Set([owner, mc, dev, dj, pi, mydude])],
    ['team', new Set([owner, mc, dev])],
    ['dm', new Set([owner, mc])],
    ['tie-b', new Set([dj, pi, other])],
    ['tie-a', new Set([dj, pi, bridge])],
    ['q', new Set([stray, giver])],
  ])
  const names = new Map([['tie-a', 'Zed'], ['tie-b', 'Alpha'], ['big', 'waggle-test']])
  const g = roomLinesOf(base, { rooms, names, unread: new Map() })
  const ids = l => l.platform.id
  check(JSON.stringify(g.lines.map(ids)) === JSON.stringify(['you', 'room:team', 'room:tie-a', 'room:big', 'other-agents']), 'rooms group the grid: you first, smallest rooms first, the rest last')
  check(g.lines[0] === base.lines[0], 'you and your voice stay first, as when grouped by where they run')
  const at = id => g.lines.find(l => ids(l) === id).rows.map(r => r.pubkey)
  check(JSON.stringify(at('room:team')) === JSON.stringify([mc, dev]), 'an agent sits in the smallest room it is in, not the biggest')
  check(!g.lines.some(l => ids(l) === 'room:dm'), 'a room with one agent the grid shows, not counting you, is no group')
  check(JSON.stringify(at('room:tie-a')) === JSON.stringify([pi, dj]) && !g.lines.some(l => ids(l) === 'room:tie-b'), 'a tie goes to the room id that sorts first, whatever the rooms are named')
  check(!g.lines.some(l => ids(l) === 'room:q'), 'a quiet identity is not an agent the grid shows, so it makes no group')
  check(JSON.stringify(at('room:big')) === JSON.stringify([mydude]), 'an agent left only in a bigger room sits there')
  check(JSON.stringify(at('other-agents')) === JSON.stringify([dennis, giver]), 'an agent in no such room sits in Other agents')
  const label = id => g.lines.find(l => ids(l) === id).platform
  check(label('room:big').label === 'waggle-test' && label('room:big').runs === 'room' && label('room:team').label === 'team', "a room's group is headed by its name, or its id without one, and says room")
  check(label('other-agents').label === OTHER_AGENTS && !/not in any room/.test(label('other-agents').label + (label('other-agents').runs || '')), 'Other agents never says "not in any room"')
  check(JSON.stringify(g.columns.map(r => r.pubkey)) === JSON.stringify([mc, dev, pi, dj, mydude, dennis, stray]), "the columns follow the rows' order, quiet ones last")
  const mixed = roomLinesOf(base, { rooms: new Map([['x', new Set([mc, dennis])], ['y', new Set([dev, pi])]]) })
  check(JSON.stringify(mixed.columns.map(r => r.pubkey)) === JSON.stringify([mc, dennis, dev, pi, dj, mydude, stray]), "rooms that cross harnesses reorder the columns to match the rows")
  check(g.quiet === base.quiet && g.takers.length === base.takers.length, 'grouping by room moves no one in or out of the grid')
  check(roomLinesOf(base, { rooms: new Map([['dm', new Set([owner, mc])], ['q', new Set([stray, giver])]]) }) === null && roomLinesOf(base, null) === null, 'with no room that can be a group, the grid stays grouped by where they run')
  check(JSON.stringify(roomLinesOf(gridOf(rows), { rooms, names })) === JSON.stringify(g), 'the grouping comes from the grid alone, so the same grid groups the same way')

  const twins = roomLinesOf(base, { rooms: new Map([['a1', new Set([mc, dev])], ['a2', new Set([dj, pi])]]), names: new Map([['a1', 'general'], ['a2', 'general']]) })
  const twinIds = twins.lines.filter(l => l.room).map(l => l.platform.id)
  check(twins.lines.filter(l => l.platform.label === 'general').length === 2 && new Set(twinIds).size === 2, 'two rooms with the same name stay two groups, each with its own id')
  check(groupingLine({ read: false }).text === 'Grouped by where they run' && groupingLine({ read: false }).button === null, 'before a read the line says where they run and offers no switch')
  const byRoom = groupingLine({ read: true, grouped: true, at: '09:14' })
  check(byRoom.text === 'Grouped by room, read 09:14' && byRoom.button === 'Group by where they run', 'grouped by room, the line says when it was read and offers the way back')
  check(groupingLine({ read: true, grouped: true, unread: 2, at: '09:14' }).text === "Grouped by the rooms read, 09:14: 2 rooms' lists weren't read"
    && groupingLine({ read: true, grouped: true, unread: 1, at: '09:14' }).text === "Grouped by the rooms read, 09:14: 1 room's list wasn't read", 'a partial read says how many rooms were not read')
  check(groupingLine({ read: true, grouped: false, at: '09:14' }).button === 'Group by room', 'switched back, it offers to group by room again')
  check(groupingLine({ read: true, grouped: false, possible: false, at: '09:14' }).button === null, 'a read with no room that can be a group offers no switch')

  check(JSON.stringify(roomsOfAgent(mc, { rooms })) === JSON.stringify(['big', 'dm', 'team']) && roomsOfAgent(dennis, { rooms }).length === 0 && roomsOfAgent(mc, null) === null, "an agent's panel names the rooms read that it is in, and nothing before a read")

  const page = readFileSync(new URL('../console/hive.html', import.meta.url), 'utf8')
  check(/roomLinesOf\(byRuns, hive\.rooms\)/.test(page) && /id="grouping-go"/.test(page) && /groupingLine\(/.test(page), 'the page groups by room once the rooms are read, with the switch above the grid')
  check(/function regroup\(\)[\s\S]{0,200}const keep = \{ waiting, extras, drafted, ticks \}/.test(page), 'grouping again keeps the changes waiting to be signed')
  check(/section\(platform\.label, platform\.runs, inGroup, null, platform\.id\)/.test(page) && /folds\.get\(g\.key\)/.test(page) && !/folds\.(get|set|has)\((g\.)?label/.test(page), "a group folds by its id, so two rooms with one name don't fold together")
  check(/In the rooms read: /.test(page) && /In none of the rooms read\./.test(page), "an agent's panel names the rooms read that it is in")
}

if (!pass) { console.log('\nconsole_hive_grid: FAIL'); process.exit(1) }
console.log('\nconsole_hive_grid: ok')
