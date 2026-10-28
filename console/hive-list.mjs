// hive-list.mjs — the hive manager's one list (#613 M1, docs/HIVE_MANAGER_SPEC.md).
//
// Every identity the hive knows about becomes one row keyed by pubkey, whichever source named it:
// the owner, a grant, an agent card, the bridge's roster. A key named by any source is never
// dropped, because a list that silently loses a key is the registry problem this replaces. Each
// answer on a row is read from the one source that owns it, and an answer that no source reports
// says "not reported" instead of guessing.
//
// "Who can give it work" runs nvoy's own fold (vendor/nvoy-admission.mjs, pinned and hash-checked by
// tests/console_hive_list.mjs), so the page and the broker cannot disagree about it. Pure: no DOM and
// no network, so the suite runs the functions the page runs.

import { foldGrantsWith, grantExpired, TASK_CAPS } from './vendor/nvoy-admission.mjs'
import { GRANT_RELAYS } from './vendor/nvoy-grant-relays.mjs'
import { describeGrant } from './capability-vocabulary.mjs'

export { GRANT_RELAYS }
export const CARD_KIND = 30078
export const CARD_D = 'nvoy-agent-card'
export const CARD_RELAYS = ['wss://relay.nave.pub']
// Sources the spec names that this page does not read yet. They are printed on the page, so an
// absent key is never mistaken for a key that does not exist.
export const NOT_READ = ['the Buzz channel roster', "nvoy's 10440 index", "nact's identities"]
export const TALK_IS_NOT_WORK = 'Being in a channel lets you talk; it does not let you give work.'

const HEX64 = /^[0-9a-f]{64}$/
const tag = (ev, name) => (Array.isArray(ev?.tags) ? ev.tags : []).find(t => t?.[0] === name)

// Every 440 and 441 that verifies, folded across all grantors at once: a revocation counts only
// when its author issued the grant, and a NIP-40 expiry ends a grant as a revocation does.
export function readGrants(events, { verify, now = Date.now() } = {}) {
  const seen = new Map()
  let rejected = 0
  for (const ev of events || []) {
    if (!ev?.id || seen.has(ev.id)) continue
    let ok = false
    try { ok = verify(ev) } catch { ok = false }
    if (!ok) { rejected++; continue }
    seen.set(ev.id, ev)
  }
  const revoked = new Set()
  for (const ev of seen.values()) if (ev.kind === 441 && tag(ev, 'e')?.[1]) revoked.add(`${ev.pubkey}|${tag(ev, 'e')[1]}`)
  const grants = []
  for (const ev of seen.values()) {
    if (ev.kind !== 440) continue
    const grantee = String(tag(ev, 'p')?.[1] || '').toLowerCase(), cap = tag(ev, 'da-cap')?.[1], scope = tag(ev, 'da-scope')
    if (!HEX64.test(grantee) || !cap || !scope?.[1]) continue
    const state = revoked.has(`${ev.pubkey}|${ev.id}`) ? 'revoked' : grantExpired(ev, Math.floor(now / 1000)) ? 'expired' : 'live'
    grants.push({ id: ev.id, grantor: ev.pubkey, grantee, cap, hash: scope[1], salt: scope[2] || '', at: ev.created_at, state, live: state === 'live' })
  }
  grants.sort((a, b) => b.at - a.at)
  return { grants, events: [...seen.values()], rejected }
}

// A scope is a salted hash, so its subject is found by hashing each known key with the grant's
// salt. The table also serves nvoy's fold, which needs scopeHash synchronously.
export async function scopeTable(candidates, grants, scopeHash) {
  const salts = [...new Set(grants.map(g => g.salt))]
  const bySubject = new Map(), byHash = new Map()
  for (const subject of new Set(candidates)) {
    for (const salt of salts) {
      const hash = await scopeHash(subject, salt)
      bySubject.set(`${subject}|${salt}`, hash)
      byHash.set(hash, subject)
    }
  }
  return { hashOf: (subject, salt) => bySubject.get(`${subject}|${salt}`) || '', subjectOf: hash => byHash.get(hash) || null }
}

// Roles are recipes recognised from grants (spec, "Roles are recipes"). `agent` is the row the
// chip belongs on; anything that matches no recipe is custom and keeps its raw sentence.
export function roleOf(grant, { owner, bridges = [], subject }) {
  const fromOwner = grant.grantor === owner
  if (fromOwner && subject && (grant.cap === 'task' || grant.cap === 'task+act')) {
    if (grant.grantee === owner) return { role: grant.cap === 'task+act' ? 'trusted' : 'teammate', agent: subject }
    return { role: 'colleague', agent: subject, by: grant.grantee }
  }
  if (fromOwner && subject && grant.cap === 'task-relay' && bridges.includes(grant.grantee)) return { role: 'carrier', agent: subject, by: grant.grantee }
  if (fromOwner && grant.cap === 'shadow' && subject === owner) return { role: 'voice', agent: grant.grantee }
  if (grant.cap === 'admit' || grant.cap === 'admit+read') return { role: 'guest', agent: grant.grantee, cleanup: true }
  return { role: 'custom', agent: grant.grantee, sentence: describeGrant({ cap: grant.cap, grantee: grant.grantee, subject: subject || 'an unresolved scope' }) }
}

export const ROLE_NAME = {
  teammate: 'Teammate', trusted: 'Trusted teammate', colleague: 'Colleague', carrier: 'Carrier',
  voice: 'Voice', guest: 'Channel guest', custom: 'Custom',
}

// Two live grants with the same grantor, grantee, capability and subject are one grant too many.
// nvoy counts only the newest per grantee and capability, and an older copy never comes back, so the
// older one is listed: withdrawing it changes nothing, while withdrawing the newer ends the approval.
export function duplicates(grants, subjectOf) {
  const groups = new Map()
  for (const g of grants.filter(g => g.live)) {
    const key = [g.grantor, g.grantee, g.cap, subjectOf(g.hash) || g.hash].join('|')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(g)
  }
  return [...groups.values()].filter(list => list.length > 1)
    .map(list => { const sorted = [...list].sort((a, b) => a.at - b.at); return { keep: sorted.at(-1), extra: sorted.slice(0, -1) } })
}

// A card is believed only as the agent's own signed statement about itself, and it is part of
// this hive only if it names the owner as a grantor. The newest valid card per key wins.
export function readCards(events, { owner, verify }) {
  const cards = new Map()
  for (const ev of events || []) {
    try {
      if (ev?.kind !== CARD_KIND || tag(ev, 'd')?.[1] !== CARD_D || !verify(ev)) continue
      const card = JSON.parse(ev.content)
      if (card?.version !== 1 || card.pubkey !== ev.pubkey || !Array.isArray(card.grantors) || !card.grantors.includes(owner)) continue
      const prior = cards.get(ev.pubkey)
      if (!prior || prior.signedAt < ev.created_at) cards.set(ev.pubkey, { ...card, signedAt: ev.created_at })
    } catch { /* an unparseable card is no card */ }
  }
  return cards
}

const shown = (card, field) => (card?.withheld || []).includes(field) ? 'withheld' : (card?.not_reported || []).includes(field) ? 'not reported' : null

// The one list. Sources only add keys; nothing here removes one.
export function buildList({ owner, grantEvents = [], grants = [], table, cards = new Map(), roster = [], bridge = null, profiles = new Map() }) {
  const rows = new Map()
  const add = (pubkey, source) => {
    const pk = String(pubkey || '').toLowerCase()
    if (!HEX64.test(pk)) return
    if (!rows.has(pk)) rows.set(pk, { pubkey: pk, sources: new Set(), roles: [], needs: [] })
    rows.get(pk).sources.add(source)
  }
  add(owner, 'owner')
  if (bridge) add(bridge, 'roster')
  for (const agent of roster) add(agent.pubkey, 'roster')
  for (const pk of cards.keys()) add(pk, 'card')
  for (const g of grants) {
    add(g.grantor, 'grants'); add(g.grantee, 'grants')
    const subject = table.subjectOf(g.hash)
    if (subject && HEX64.test(subject)) add(subject, 'grants')
  }

  const needs = []
  const bridges = bridge ? [bridge] : []
  for (const g of grants) {
    const subject = table.subjectOf(g.hash)
    if (g.state === 'expired') needs.push({ kind: 'expired', grant: g, subject, text: 'An expired approval is still published. It does nothing; withdrawing it tidies the record.' })
    if (!g.live) continue
    const role = roleOf(g, { owner, bridges, subject })
    const row = rows.get(role.agent)
    row.roles.push({ ...role, grant: g })
    if (role.role === 'custom') needs.push({ kind: 'custom', grant: g, subject, text: `Matches no role: ${role.sentence}` })
    if (role.role === 'guest') needs.push({ kind: 'guest', grant: g, subject, text: 'A channel pass left over from waggle carry. A candidate for cleanup.' })
  }
  const listed = new Set()
  for (const { keep, extra } of duplicates(grants, table.subjectOf)) {
    for (const g of extra) {
      listed.add(g.id)
      needs.push({ kind: 'duplicate', grant: g, keep, subject: table.subjectOf(g.hash), text: 'An older copy of an approval given again later. Withdrawing this one changes nothing; withdrawing the newer one would end the approval.' })
    }
  }

  for (const row of rows.values()) {
    const card = cards.get(row.pubkey) || null
    const profile = profiles.get(row.pubkey) || {}
    const label = roster.find(a => a.pubkey === row.pubkey)?.label
    row.name = profile.display_name || profile.name || label || card?.instance || null
    row.picture = profile.picture || null
    row.card = card
    row.isOwner = row.pubkey === owner
    row.isBridge = row.pubkey === bridge
    row.stage = card ? 'tools' : row.roles.length ? 'grants' : 'key'
    row.answers = answersFor(row, { owner, grantEvents, table })
    // nvoy's fold decides which work approvals count: the newest per grantee and capability. One that
    // is live but replaced has no effect; if its replacement has since been withdrawn or run out,
    // nothing holds that capability, though a live approval says it should.
    const grantors = card ? card.grantors : [owner]
    for (const role of row.roles) {
      const g = role.grant
      if (!TASK_CAPS.includes(g.cap) || !grantors.includes(g.grantor) || table.subjectOf(g.hash) !== row.pubkey) continue
      role.inEffect = row.answers.fold.get(g.grantee)?.get(g.cap)?.grantId === g.id
      if (role.inEffect || listed.has(g.id)) continue
      needs.push(row.answers.fold.get(g.grantee)?.has(g.cap)
        ? { kind: 'duplicate', grant: g, subject: row.pubkey, text: 'Replaced by a newer approval for the same thing. Withdrawing this one changes nothing.' }
        : { kind: 'replaced', grant: g, subject: row.pubkey, text: 'Never withdrawn, but a newer approval for the same thing replaced it and was later withdrawn or ran out, so neither counts. Give it again if it should still hold.' })
    }
    if (!card && row.roles.some(r => ['teammate', 'trusted', 'colleague', 'carrier'].includes(r.role)))
      needs.push({ kind: 'no-card', pubkey: row.pubkey, text: 'Others can give it work, but it has published no agent card: unreachable, not upgraded, or its card is off.' })
  }

  const order = { tools: 0, grants: 1, key: 2 }
  const list = [...rows.values()].sort((a, b) => (Number(b.isOwner) - Number(a.isOwner)) || (order[a.stage] - order[b.stage]) ||
    (a.name || '~').localeCompare(b.name || '~') || a.pubkey.localeCompare(b.pubkey))
  return { rows: list, needs }
}

// The four answers, plus how it works and the proof that it does, each from its one source.
export function answersFor(row, { owner, grantEvents, table }) {
  const card = row.card
  // nvoy's fold, with the grantors the agent itself attests to. Without a card the page can only
  // assume the owner, and the answer says so.
  const grantors = card ? card.grantors : [owner]
  const { live } = foldGrantsWith(grantEvents, { me: row.pubkey, grantors, scopeHash: table.hashOf })
  const givers = [...live].map(([pubkey, caps]) => ({ pubkey, caps: [...caps.keys()], voice: [...caps.values()].some(g => g.shadow) }))
    .filter(g => g.caps.some(c => c === 'task' || c === 'task+act'))
  const carriers = [...live].filter(([, caps]) => caps.has('task-relay')).map(([pubkey]) => pubkey)
  return {
    fold: live,
    work: { givers, carriers, grantorsFrom: card ? 'card' : 'assumed' },
    act: {
      withoutAsking: givers.filter(g => g.caps.includes('task+act')).map(g => g.pubkey),
      limits: card?.agent_limits || null,
      profile: card ? card.may_set_profile : null,
      harness: 'set on its box, not visible here',
    },
    post: card ? card.may_post : null,
    holds: card ? shown(card, 'holdings') || 'not reported' : null,
    how: card ? { runner: card.harness?.runner || null, release: card.release, delivery: card.delivery_mode, profile: shown(card, 'harness profile') || 'not reported' } : null,
    proof: card ? { cardSignedAt: card.signedAt, lastTask: shown(card, 'last admitted task') || 'not reported', lastReply: shown(card, 'last reply') || 'not reported' } : null,
  }
}

// "You and DJ Codex can give it work." Names, never hex, and "you" for the owner.
export function workSentence(answer, { owner, nameOf, incomplete = false }) {
  const givers = [...answer.givers].sort((a, b) => Number(b.pubkey === owner) - Number(a.pubkey === owner))
  const who = givers.map(g => g.pubkey === owner ? 'You' : `${nameOf(g.pubkey)}${g.voice ? ' (as your voice)' : ''}`)
  if (!who.length) return incomplete ? `Nobody, ${PARTIAL}.` : 'Nobody can give it work.'
  const list = who.length === 1 ? who[0] : `${who.slice(0, -1).join(', ')} and ${who.at(-1)}`
  return `${list} can give it work.`
}

// The table's short answers: "You, DJ Codex" and "Not on your work". An absence the read cannot
// vouch for is starred; the page's footnote says why.
const star = incomplete => incomplete ? '*' : ''
// Both name columns read in one order: you, the others by name, your voice last.
const rank = n => n === 'You' ? 0 : n === 'Your voice' ? 2 : 1
const inOrder = names => names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { sensitivity: 'base' }))
export function workCell(answer, { owner, nameOf, incomplete = false }) {
  const givers = answer.givers.map(g => g.pubkey === owner ? 'You' : g.voice ? 'Your voice' : nameOf(g.pubkey))
  return givers.length ? inOrder(givers) : [`Nobody${star(incomplete)}`]
}
// The other direction of the same approvals: whose rows name this key as a giver.
export function givesCell(pubkey, rows, { owner, nameOf, incomplete = false }) {
  const to = rows.filter(r => r.pubkey !== pubkey && r.answers?.work.givers.some(g => g.pubkey === pubkey))
  return to.length ? inOrder(to.map(r => r.pubkey === owner ? 'You' : nameOf(r.pubkey))) : [`Nobody${star(incomplete)}`]
}
// Every name a column holds, in one order, so each name sits on the same line in every row and a
// gap shows who is missing. A cell with nobody in it stays one line.
const EMPTY = /^(Nobody\*?|—)$/
export function nameSlots(cells, groupOf = () => 0) {
  return inOrder([...new Set(cells.flat().filter(n => !EMPTY.test(n)))]).sort((a, b) => groupOf(a) - groupOf(b))
}

// Where each agent runs, in the order the table groups them. Agent cards carry no platform yet
// (#637), so the keys are listed here; anyone not listed is in the last group.
export const PLATFORMS = Object.freeze([
  { id: 'you', label: 'You' },
  { id: 'lab', label: 'Frontier lab harnesses', runs: 'Codex, Claude Code', keys: [
    '231952cb5eb0652c04075f6a1b93e727819ed2ac0bf5238a96c6d2ca51617edd', // DJ Codex
    'ad05b00ee49200d5bd2788fba480621ba6009224f01e48b3e9bce10100421d5c', // MC Claude
    '38889d4ce187469d41dc0ef3f610a79d42120603fbc8a68b92d8bd67ae63a536', // waggle-dev
  ] },
  { id: 'third-party', label: 'Third-party harnesses', runs: 'Pi, OpenClaw', keys: [
    'e4c0faf44d9aeabcb5459c6c3b76f2c704d7b55c7e0ddb3685fab4e4226935d8', // Pi Dog
    '1b53f548acebe8dd47252717104350006f49b5c981a86ad4cfaf58d3fd7a0f1e', // lukedog
  ] },
  { id: 'grok', label: 'Grok Bot', keys: [
    '61cb9345ce61bb06d42bef251de746051e608a539c1430142a8afa6593db924c', // GrokDoggyDog
  ] },
  { id: 'buzz', label: 'Buzz', keys: [
    '0a8e0720c3ec52c6bfd9e2545d620cf58e2e8d371244255efce3ddd57ba0a32c', // My Dude
    '9a07300d3295f392d295cd8f73c8f1d3c725809b2e50fc52815db8682ef940a5', // Dennis
    'eb586b1e9c214c10762acc0dd4d428ac9156c284162f2d9dcc98562e644d71a5', // Kerouac
    '5d3848a699e82f81e218aaad2f481bb63c00ff69b813cfca1cafc58ca633eb08', // Neil
  ] },
  { id: 'other', label: 'Everyone else' },
])
// Your voice speaks for you, so it sits in your group.
export function platformOf(row) {
  if (row.isOwner || row.roles?.some(x => x.role === 'voice')) return 'you'
  return PLATFORMS.find(p => p.keys?.includes(row.pubkey))?.id || 'other'
}
export function byPlatform(rows) {
  return PLATFORMS.map(platform => ({ platform, rows: rows.filter(r => platformOf(r) === platform.id) })).filter(g => g.rows.length)
}
// Both columns share one set of lines, so line N is the same agent across the row. A name the
// column never holds (nobody gives you work) is blank rather than struck, so a strike is a real gap.
export function slotted(cell, slots, self, column = slots) {
  if (cell.length === 1 && EMPTY.test(cell[0])) return null
  return slots.map(name => ({ name, state: cell.includes(name) ? 'present' : name === self || !column.includes(name) ? 'self' : 'absent' }))
}
export function askCell(act, { owner, nameOf, incomplete = false, givers = 1 }) {
  if (!givers) return '—'
  if (!act.withoutAsking.length) return `Yes, always${star(incomplete)}`
  const whose = [...act.withoutAsking].sort((a, b) => Number(b === owner) - Number(a === owner)).map(pk => pk === owner ? 'your' : `${nameOf(pk)}'s`)
  return `Not on ${whose.length === 1 ? whose[0] : `${whose.slice(0, -1).join(', ')} or ${whose.at(-1)}`} work`
}

// A relay has answered only when it sends EOSE. One that times out after sending some events is
// partial, and a read is full only when every relay asked answered. Anything the page says is absent
// ("nobody", "no card", a missing key) is qualified unless every read it rests on was full.
export const PARTIAL = 'as far as the relays that answered in full show; not every relay did'
export function relayCoverage(states) {
  const complete = states.filter(s => s === 'complete').length, partial = states.filter(s => s === 'partial').length
  return { complete, partial, of: states.length, full: states.length > 0 && complete === states.length }
}
export function coverageText({ complete, partial, of }) {
  if (!complete && !partial) return { lead: 'Unverifiable', rest: 'no relay answered for', none: true }
  const extra = partial ? `, ${partial} sent only part before timing out,` : ''
  return { lead: `${complete} of ${of}`, rest: `relays answered in full${extra} for`, none: !complete }
}
