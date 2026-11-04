// hive-square.mjs — one square of the hive grid, and what its side panel says (#698).
//
// docs/DESIGN_HIVE_CONSOLE.md, "The square". Read across a row: each square says what the column
// does when the row gives it work, and only as far as the page has read. The state is pair-check's
// own gates read from the taker's side (gate 1, may the giver give it work; gate 7, can it mention the
// giver back), so the square and the checks the suite pins cannot disagree. cellOf says what the
// owner can change. Whether the post arrives, and whether the agent is connected now, are not read,
// so no square draws them and every panel says so.
//
// Pure: the page and the suite run the same words.

import { gatesFor } from './pair-check.mjs'
import { oneWay, WHY, mentionStatus, mentionGrantsOf } from './owner-view.mjs'
import { whatIf } from './hive-what-if.mjs'
import { sharedRooms } from './room-lists.mjs'

export const GLYPH = Object.freeze({ work: '✓', copy: '✓', blocked: '!', none: '', unknown: '?', add: '+', remove: '–', self: '·', person: '' })
export const ANSWER = Object.freeze({
  work: 'Takes work from it',
  copy: 'Your copy says it takes work from it',
  blocked: "Takes the work, but can't answer back by name",
  none: "Won't act on it",
  hears: "Hears it, won't act on it",
  unseen: 'Not in any room you can see with it',
  unknown: 'Not known yet',
  add: 'Will take work from it once you sign',
  remove: 'Will stop taking work from it once you sign',
  person: 'A person takes no work through the page',
  self: 'Itself',
})
// The legend, in the order the spec draws it.
export const LEGEND = Object.freeze([
  ['work', 'takes work from it'],
  ['copy', 'your copy of Buzz says so'],
  ['blocked', "takes the work but can't answer back by name"],
  ['none', "won't act on it"],
  ['unknown', 'not known yet'],
  ['add', 'your change, not signed'],
])

const Up = s => s.startsWith('you') ? `Y${s.slice(1)}` : s
const isnt = a => a === 'you' ? "aren't" : "isn't"
const poss = a => a === 'you' ? 'your' : `${a}'s`
const list = names => names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
// Plain words for the reasons whose shared wording names the list's format.
const UNREAD = { 'no-view': "its card doesn't carry the list", 'not-for-you': "its card doesn't carry a list for you", 'bad-shape': "the list isn't in the form this page reads" }
const PRIVATE = ['not-opened', 'no-signer', 'not-asked', 'decrypt-failed', 'cannot-decrypt', 'other-signer']

// Whether the taker hears the giver, from the room lists the owner read (docs/DESIGN_HIVE_CONSOLE.md,
// "Who is in each room"). Only when both are in some room the page read: `{ rooms }` they share, or
// `{ rooms: [] }` for "not in any room you can see". Null when that isn't known, which keeps today's
// line: an nvoy agent on public relays, no room read yet, or a room whose list wasn't trusted.
export function hearingOf(taker, giver, ctx) {
  const read = ctx.rooms?.rooms
  if (!read) return null
  const inAny = pk => [...read.values()].some(m => m.has(pk))
  if (!inAny(taker.pubkey) || !inAny(giver.pubkey)) return null
  const rooms = sharedRooms(giver.pubkey, taker.pubkey, read)
  // A room whose list wasn't read or wasn't trusted may hold them both, so "not in any" waits.
  if (!rooms.length && ctx.rooms.unread?.size) return null
  return { rooms }
}

// The square's state. `change` is the owner's pending 'add' or 'remove' for it, if any. A blank
// square ('none') splits by `hear`: 'hears' or 'unseen' once the rooms are read, else null.
// ctx: owner, nameOf, grants, subjectOf, views, buzz, partial (pair-check's ctx), rooms.
export function squareOf({ taker, giver, change = null, ctx }) {
  if (taker.pubkey === giver.pubkey) return { kind: 'self', base: 'self', gates: null }
  const gates = gatesFor(taker, giver, ctx)
  const base = gates.approval.notDrawn ? 'person'
    : gates.approval.state === 'proven' ? oneWay({ on: true, giver: giver.pubkey, agent: taker.pubkey, view: ctx.views.get(taker.pubkey) }) ? 'blocked' : 'work'
      : gates.approval.state === 'claimed' ? 'copy'
        : gates.approval.state === 'closed' ? 'none' : 'unknown'
  const h = base === 'none' ? hearingOf(taker, giver, ctx) : null
  return { kind: change || base, base, gates, hear: h ? h.rooms.length ? 'hears' : 'unseen' : null }
}

// The approval reason: who let it happen, or why it is not known.
function approvalLine(sq, { taker, giver, cell, change, ctx }) {
  const a = ctx.nameOf(giver.pubkey), b = ctx.nameOf(taker.pubkey)
  if (change === 'add') return `Your change, not signed yet: ${a} may give ${b} work.`
  if (change === 'remove') return `Your change, not signed yet: ${a} stops giving ${b} work.`
  if (sq.base === 'person') return `${Up(b)} is a person, and takes no work through the page.`
  if (sq.gates.kind === 'buzz') {
    const copy = ctx.buzz?.known ? ctx.buzz.lists?.get(taker.pubkey) : null
    if (!ctx.buzz?.known) return 'Not every relay returned your copy of the Buzz allow-lists. Read again.'
    if (!copy) return `Buzz decides for ${b}, and its allow-list hasn't been copied here yet.`
    return sq.base === 'copy'
      ? `Your copy of ${b}'s Buzz allow-list says it takes work from ${copy.has('*') ? 'anyone' : a}. Buzz's own list isn't read.`
      : `Your copy of ${b}'s Buzz allow-list leaves ${a} out, but it is a copy. Buzz's own list isn't read.`
  }
  if (sq.base === 'unknown') return ctx.partial?.approvals
    ? 'Not every relay answered in full, so an approval or a withdrawal may be missing. Read again.'
    : `${Up(b)} doesn't publish its settings, so who it takes work from is assumed, not read.`
  if (sq.base === 'none') return cell?.why && !cell.can ? `${Up(b)}'s settings don't count your approvals, so one from you would do nothing.` : `Nobody has let ${a} give ${b} work.`
  const others = (cell?.others || []).map(ctx.nameOf)
  if (cell?.mine?.length && others.length) return `You and ${list(others)} approved this, so withdrawing yours wouldn't stop it.`
  if (cell?.mine?.length) return a === 'you' ? `You let ${b} take work from you.` : `You let ${a} give ${b} work.`
  if (others.length) return `${Up(list(others))} approved this, not you.`
  const g = sq.gates.approval.grant
  if (g?.shadow) return `${Up(a)} gives ${b} work as your voice.`
  return `${Up(b)} takes work from ${a} by its own settings.`
}

// Answering back: can the taker bring the giver back in by name? Read from its own sealed list.
function backLine(sq, { taker, giver, ctx }) {
  if (sq.base === 'person') return null
  const a = ctx.nameOf(giver.pubkey), b = ctx.nameOf(taker.pubkey)
  if (sq.gates.kind === 'buzz') return `${Up(b)}'s Buzz @mention list isn't on the page.`
  const v = ctx.views.get(taker.pubkey)
  if (v?.state === 'reply-only') return `${Up(b)} only replies: it answers whoever gave it the work, and brings no one else in.`
  if (v?.state === 'readable') {
    const entry = v.view.mention.find(e => e.pubkey === giver.pubkey)
    if (entry) return `${Up(b)} can @mention ${a} back${entry.name ? ` as @${entry.name}` : ''}.`
    const st = mentionStatus(v, mentionGrantsOf(ctx.grants, { owner: ctx.owner, giver: giver.pubkey, agent: taker.pubkey, subjectOf: ctx.subjectOf }))
    if (st.state === 'pending') return `You let ${b} @mention ${a}. It's signed, and waiting for ${b} to take it.`
    if (st.state === 'refused') return `${Up(b)} refused your approval to @mention ${a}: ${st.refused[0].reason}.`
    return `${Up(a)} ${isnt(a)} on ${b}'s @mention list, so ${b} can't bring ${a} back in by name.`
  }
  if (v?.why === 'no-card' || !v) return null
  if (PRIVATE.includes(v.why)) return `${Up(b)} keeps who it can @mention private to you.`
  return `Who ${b} can @mention can't be read: ${UNREAD[v.why] || WHY[v.why] || UNREAD['bad-shape']}.`
}

const roomWords = (rooms, names) => {
  const named = rooms.map(r => names?.get(r)).filter(Boolean).map(n => `“${n}”`)
  const rest = rooms.length - named.length
  return named.length ? list(rest ? [...named, `${rest} more`] : named) : `${rooms.length} room${rooms.length === 1 ? '' : 's'} you read`
}
// What the room lists say about whether the post arrives. Null keeps NOT_READ_LINE.
export function hearingLine({ taker, giver, ctx }) {
  const h = hearingOf(taker, giver, ctx)
  if (!h) return null
  const a = ctx.nameOf(giver.pubkey), b = ctx.nameOf(taker.pubkey)
  if (h.rooms.length) return `${Up(b)} hears ${a} in ${roomWords(h.rooms, ctx.rooms.names)}. Whether ${b} is connected right now isn't read.`
  return `${Up(b)} isn't in any room you can see with ${a}. Rooms you aren't in aren't read, so whether ${poss(a)} post reaches ${b} isn't known. Whether ${b} is connected right now isn't read either.`
}

export const NOT_READ_LINE = (a, b) => `Whether ${poss(a)} post reaches ${b} isn't read yet: that needs each room's member list. Whether ${b} is connected right now isn't read either.`

// Everything the side panel says about one square, except the reverse square, which the page
// works out with this same function.
export function panelOf({ taker, giver, cell, change = null, ctx }) {
  const sq = squareOf({ taker, giver, change, ctx })
  const a = ctx.nameOf(giver.pubkey), b = ctx.nameOf(taker.pubkey)
  if (sq.kind === 'self') return { sq, title: `${Up(a)} → itself`, answer: ANSWER.self, reasons: [], button: null }
  const reasons = [approvalLine(sq, { taker, giver, cell, change, ctx }), backLine(sq, { taker, giver, ctx })].filter(Boolean)
  if (sq.base !== 'person') reasons.push(hearingLine({ taker, giver, ctx }) || NOT_READ_LINE(a, b))
  let acts = null
  if (['work', 'blocked'].includes(sq.base) && sq.gates.kind !== 'buzz' && taker.answers?.fold) {
    const w = whatIf({ author: giver.pubkey, row: taker, dm: false, owner: ctx.owner, nameOf: ctx.nameOf })
    if (w.work) acts = w.grant.cap === 'task+act' ? `${Up(b)} may act on it without asking.` : `${Up(b)} asks before acting on it.`
  }
  const v = ctx.views.get(taker.pubkey)
  return {
    sq, title: `${Up(a)} → ${b}`, answer: ANSWER[sq.kind === 'none' && sq.hear ? sq.hear : sq.kind], acts, reasons,
    button: buttonOf(sq, { cell, change, a, b, ctx }),
    showPrivate: sq.base !== 'person' && v?.state === 'cant-tell' && v.why === 'not-opened',
    source: sq.base === 'person' ? null : sq.gates.kind === 'buzz' ? `Answered from your copy of ${b}'s Buzz allow-list.` : `Answered by nvoy's own rules, the same ones ${b}'s listener runs.`,
  }
}

// The one button. Disabled ones say who can change it instead.
export function buttonOf(sq, { cell, change, a, b, ctx }) {
  if (change) return { label: 'Undo', act: 'toggle' }
  if (!cell || ['self', 'person'].includes(sq.base)) return null
  const give = a === 'you' ? `Let ${b} take work from you` : `Let ${a} give ${b} work`
  if (cell.can) return cell.on ? { label: 'Stop it', act: 'toggle' } : { label: give, act: 'toggle' }
  if (cell.buzz) return { label: 'Change it in Buzz Desktop', disabled: true }
  if (cell.on && cell.others?.length) return { label: `Approved by ${list(cell.others.map(ctx.nameOf))}`, disabled: true }
  if (cell.on) return { label: 'Gives work as your voice', disabled: true }
  return { label: give, disabled: true }
}

// The private lists to ask the signer to open: every one for Needs you's "Show it", and only the
// taker's for a square's "Show who B can @mention".
export function listsToOpen(views, only = null) {
  return [...views].filter(([pk, v]) => v.state === 'cant-tell' && v.event && (!only || pk === only))
}

// "And back": the reverse square's answer in one line.
export function backOf(rev, { taker, giver, ctx }) {
  const a = ctx.nameOf(taker.pubkey), b = ctx.nameOf(giver.pubkey)
  return `${Up(a)} → ${b}: ${rev ? ANSWER[rev.kind].replace(/^./, c => c.toLowerCase()) : `${b === 'you' ? 'you take' : `${b} takes`} no work through this page`}.`
}
