// pair-check.mjs — can these two reach each other? Every gate between two keys, both directions,
// each line with one state and its source (#691, docs/DESIGN_PAIR_CHECK.md, build step 1).
//
// It reads only what the hive page already holds: the rows and their folds, the approvals, the
// opened owner views and the Buzz allow-list copy. It queries nothing and signs nothing. A gate the
// page has no source for is "Not read yet" and never counts toward a yes; an incomplete read is
// "Can't tell", never Proven or Closed. Pure, so the page and the suite run the same answers.

import { platformOf } from './hive-list.mjs'
import { isBuzz } from './hive-grid.mjs'
import { WHY, mentionGrantsOf, mentionStatus, PENDING } from './owner-view.mjs'

export const STATES = Object.freeze({ proven: 'Proven', claimed: 'Claimed', closed: 'Closed', 'cant-tell': "Can't tell", 'not-read': 'Not read yet' })
export const TITLES = Object.freeze({
  1: 'Approval', 2: 'Taken', 3: 'Connected',
  4: 'Same channel, as configured', 5: 'In the channel now', 6: 'May write to the relay', 7: 'Mention right', 8: 'Hears it',
})
const TASK = ['task', 'task+act']
const AGENT_PLATFORMS = ['lab', 'third-party', 'grok']
const short = id => `${id.slice(0, 8)}…`

const line = (gate, state, says, source, extra = {}) => ({ gate, title: TITLES[gate], state, says, source, ...extra })
const notDrawn = (gate, why) => ({ gate, title: TITLES[gate], notDrawn: why })

// A person, a Buzz agent or an nvoy agent: the table "Which gates are drawn".
export function kindOf(row, buzz = null) {
  if (row.isOwner) return 'person'
  if (buzz && isBuzz(row, buzz)) return 'buzz'
  if (row.card || AGENT_PLATFORMS.includes(platformOf(row))) return 'agent'
  return 'person'
}

const whyNot = v => v?.state === 'reply-only' ? 'it only replies, so its card lists no channels' : WHY[v?.why] || WHY['bad-shape']

// 1. May B give A work?
function approval(A, B, ctx) {
  const [an, bn] = [ctx.nameOf(A.pubkey), ctx.nameOf(B.pubkey)]
  if (A.kind === 'person') return notDrawn(1, 'A person takes no work through the page.')
  if (A.kind === 'buzz') {
    const source = 'your copy of the Buzz allow-lists'
    const list = ctx.buzz?.known ? ctx.buzz.lists?.get(A.pubkey) || null : null
    if (!list) return line(1, 'cant-tell', ctx.buzz?.known ? `Your copy of the Buzz allow-lists has none for ${an}.` : 'Not every relay returned your copy of the Buzz allow-lists.', source)
    if (list.has('*') || list.has(B.pubkey)) return line(1, 'claimed', `Your copy of ${an}'s Buzz allow-list ${list.has('*') ? 'takes work from anyone' : `lists ${bn}`}. It is a copy, not Buzz Desktop's own list.`, source)
    return line(1, 'cant-tell', `Your copy of ${an}'s Buzz allow-list does not list ${bn}, but it is a copy, not Buzz Desktop's live list.`, source)
  }
  const source = `the approval relays, counted as ${an}'s card says`
  if (ctx.partial?.approvals) return line(1, 'cant-tell', `Not every approval or withdrawal relay answered in full, so an approval for ${bn}, or a withdrawal of one, may be missing.`, source)
  // With no card the row folds under your key alone, so a grant there names no grantor the agent counts.
  if (!A.row.card) return line(1, 'cant-tell', `${an} has published no agent card, so the page can't tell whose approvals it counts.`, source)
  const caps = A.row.answers?.fold?.get(B.pubkey)
  const g = caps && TASK.map(c => caps.get(c)).find(Boolean)
  if (g) return line(1, 'proven', `${bn} may give ${an} work, by approval ${short(g.grantId)} signed by ${ctx.nameOf(g.grantor)}.`, source, { fix: 'square', grant: g })
  const ended = A.row.answers?.ended?.get(B.pubkey)
  return line(1, 'closed', ended ? `${bn}'s approval to give ${an} work was ${ended}.` : `${bn} has no approval to give ${an} work.`, source, { fix: 'square' })
}

// 2. Does A's broker count it? The card names whose approvals it counts, not which it took.
function taken(A, B, first, ctx) {
  const [an, bn] = [ctx.nameOf(A.pubkey), ctx.nameOf(B.pubkey)]
  if (A.kind === 'person') return notDrawn(2, 'A person takes no work through the page.')
  if (A.kind === 'buzz') return line(2, 'not-read', 'Buzz Desktop publishes no card saying whose approvals it counts.', 'nothing on the page yet')
  const card = A.row.card, source = `${an}'s card`
  if (!card) return line(2, 'cant-tell', `${an} has published no agent card.`, source)
  if (first.state === 'proven') return line(2, 'claimed', `${an}'s card counts approvals signed by ${ctx.nameOf(first.grant.grantor)}, but does not list which approvals it took.`, source)
  if (first.state === 'cant-tell') return line(2, 'cant-tell', 'It depends on the approval above, which the page could not read in full.', source)
  const uncounted = ctx.grants.find(g => g.live && TASK.includes(g.cap) && g.grantee === B.pubkey && ctx.subjectOf(g.hash) === A.pubkey && !card.grantors.includes(g.grantor))
  if (uncounted) { const x = ctx.nameOf(uncounted.grantor); return line(2, 'closed', `An approval for ${bn} signed by ${x} exists, but ${an}'s card does not count approvals signed by ${x}.`, source) }
  return line(2, 'closed', `There is no approval from ${bn} for ${an} to take.`, source)
}

// 3. Is A connected now? The presence event is designed, not built.
function connected(A, ctx) {
  if (A.kind === 'person') return notDrawn(3, 'A person takes no work through the page.')
  return line(3, 'not-read', `The page does not read presence yet, so it can't tell whether ${ctx.nameOf(A.pubkey)} is connected.`, 'nothing on the page yet',
    { context: { cardSignedAt: A.row.card?.signedAt || null } })
}

// 4. A common channel in both cards' configuration: a claim about setup, never membership.
function configured(A, B, ctx) {
  const source = 'both agents’ sealed lists, shown to you only'
  const other = [A, B].find(k => k.kind !== 'agent')
  if (other) return line(4, 'not-read', `${ctx.nameOf(other.pubkey)} has no sealed list, so its channels are not on the page.`, 'nothing on the page yet')
  const [va, vb] = [ctx.views.get(A.pubkey), ctx.views.get(B.pubkey)]
  const unread = [[A, va], [B, vb]].find(([, v]) => v?.state !== 'readable')
  if (unread) return line(4, 'cant-tell', `Can't read ${ctx.nameOf(unread[0].pubkey)}'s channels: ${whyNot(unread[1])}.`, source)
  const common = va.view.channels.filter(c => vb.view.channels.some(d => d.id === c.id))
  if (common.length) return line(4, 'claimed', `Both cards configure ${common.map(c => c.name || short(c.id)).join(', ')}. That is configuration, not membership.`, source, { channels: common })
  return line(4, 'closed', 'Their cards configure no channel in common.', source)
}

// 7. May A mention B by name? Read from A's own sealed list, as on the grid.
function mentionRight(A, B, ctx) {
  const [an, bn] = [ctx.nameOf(A.pubkey), ctx.nameOf(B.pubkey)]
  if (A.kind === 'person') return notDrawn(7, 'The page sets no mention right for a person.')
  if (A.kind === 'buzz') return line(7, 'not-read', `${an}'s Buzz mention list is not on the page.`, 'nothing on the page yet')
  const v = ctx.views.get(A.pubkey), source = `${an}'s sealed list, shown to you only`
  if (v?.state === 'reply-only') return line(7, 'closed', `${an} only replies; it never starts a conversation.`, `${an}'s card`)
  if (v?.state !== 'readable') return line(7, 'cant-tell', `Can't tell whom ${an} can mention: ${whyNot(v)}.`, source)
  const entry = v.view.mention.find(e => e.pubkey === B.pubkey)
  if (entry) return line(7, 'proven', `${an} may mention ${bn} ${entry.name ? `as @${entry.name}` : 'with no @name'}, ${entry.source === 'manifest' ? 'set on the fleet host' : `by approval ${short(entry.grants[0])}`}.`, source, { entry })
  const st = mentionStatus(v, mentionGrantsOf(ctx.grants, { owner: ctx.owner, giver: B.pubkey, agent: A.pubkey, subjectOf: ctx.subjectOf }))
  if (st.state === 'pending') return line(7, 'closed', PENDING(an), source)
  if (st.state === 'refused') return line(7, 'closed', `${an}'s card refused your approval: ${st.refused[0].reason}.`, source, { fix: 'mention' })
  return line(7, 'closed', `${an} may not mention ${bn}.`, source, { fix: 'mention' })
}

function direction(A, B, ctx) {
  const bn = ctx.nameOf(B.pubkey)
  const first = approval(A, B, ctx)
  const work = [first, taken(A, B, first, ctx), connected(A, ctx)]
  const reach = [
    configured(A, B, ctx),
    line(5, 'not-read', 'The page does not read the Buzz channel roster.', 'nothing on the page yet'),
    line(6, 'not-read', `The page has no read path for the community relay's writer list, so it can't tell whether ${ctx.nameOf(A.pubkey)} may write there.`, 'nothing on the page yet'),
    mentionRight(A, B, ctx),
    line(8, 'not-read', B.kind === 'agent' || B.kind === 'buzz' ? `${bn}'s card does not say whom it listens to.` : `${bn}'s client settings are not on the page.`, 'nothing on the page yet', { see: 'reverse-approval' }),
  ]
  return { from: A.pubkey, to: B.pubkey, work, reach }
}

// The summary: the first Closed line, else the first Can't tell, else a count of each state. It
// never says the pair, or any gate, is open.
export function summaryOf(directions, nameOf) {
  const drawn = directions.flatMap(d => [...d.work, ...d.reach].map(l => ({ ...l, from: d.from, to: d.to }))).filter(l => !l.notDrawn)
  const at = drawn.find(l => l.state === 'closed') || drawn.find(l => l.state === 'cant-tell')
  if (at) return { state: at.state, text: `${STATES[at.state]} at ${at.title} (${nameOf(at.from)} → ${nameOf(at.to)}): ${at.says}` }
  const n = s => drawn.filter(l => l.state === s).length
  return { state: 'counted', text: `No gate the page could read is closed. ${n('proven')} proven, ${n('claimed')} claimed, ${n('not-read')} not read yet.` }
}

// One square of the hive grid (#698): may the giver give the taker work (gate 1), and can the taker
// mention the giver back (gate 7), both read from the taker's side as its listener reads them.
export function gatesFor(taker, giver, ctx) {
  if (taker.pubkey === giver.pubkey) throw new Error('A square is two different keys.')
  const A = { pubkey: taker.pubkey, row: taker, kind: kindOf(taker, ctx.buzz) }
  const B = { pubkey: giver.pubkey, row: giver, kind: kindOf(giver, ctx.buzz) }
  return { kind: A.kind, approval: approval(A, B, ctx), mention: mentionRight(A, B, ctx) }
}

// Both directions for a pair of rows. `ctx`: owner, nameOf, grants (readGrants), subjectOf, views
// (pubkey → owner view), buzz (buzzOf), partial ({ approvals }).
export function pairCheck(rowA, rowB, ctx) {
  if (rowA.pubkey === rowB.pubkey) throw new Error('A pair is two different keys.')
  const A = { pubkey: rowA.pubkey, row: rowA, kind: kindOf(rowA, ctx.buzz) }
  const B = { pubkey: rowB.pubkey, row: rowB, kind: kindOf(rowB, ctx.buzz) }
  const directions = [direction(A, B, ctx), direction(B, A, ctx)]
  return { kinds: { [A.pubkey]: A.kind, [B.pubkey]: B.kind }, directions, summary: summaryOf(directions, ctx.nameOf) }
}
