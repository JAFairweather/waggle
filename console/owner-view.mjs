// owner-view.mjs — whom an agent can mention, read from its card's sealed owner_view, and the
// one-way flag on the grid (#691, docs/DESIGN_MENTION_RIGHTS.md, step 3).
//
// The card's own signature, by the agent's key, is what makes the view the agent's: the page checks
// it, the author, the kind and the d tag before it asks the signer to open anything. Every failure
// reads as "can't tell", never as "nobody", and an agent whose list can't be read carries no flags.
// Pure: decrypting is the injected `decrypt`, so the suite runs the functions the page runs.

export const CARD_KIND = 30078, CARD_D = 'nvoy-agent-card'
const HEX64 = /^[0-9a-f]{64}$/
// The manifest's name rule (nvoy runtime_manifest.mjs), case-folded when compared.
const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/i
const SOURCES = ['manifest', 'grant']

// Why a list can't be read, in words the row shows after "can't tell who it can mention".
export const WHY = Object.freeze({
  'no-card': 'it has published no agent card',
  'bad-signature': "its card's signature does not check",
  'not-its-card': 'the card was not signed by this agent as its own card',
  'unreadable-card': 'its card could not be read',
  'no-view': 'its card carries no sealed list',
  'not-for-you': 'its card carries no list sealed to you',
  'not-opened': 'the sealed list has not been opened yet',
  'no-signer': 'you are not signed in, so the sealed list was not opened',
  'cannot-decrypt': 'your sign-in method cannot open sealed lists (NIP-44)',
  'other-signer': 'you are signed in as a different key from the hive you read',
  'not-asked': 'your signer refused an earlier list, so it was not asked again',
  'decrypt-failed': 'your signer did not open the sealed list',
  'bad-shape': 'the sealed list is not in the form this page reads',
})
const cantTell = why => ({ state: 'cant-tell', why })
const tagOf = (ev, name) => (Array.isArray(ev?.tags) ? ev.tags : []).find(t => Array.isArray(t) && t[0] === name)
const exactly = (obj, keys) => !!obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === keys.length && keys.every(k => Object.hasOwn(obj, k))

// Everything that can be checked before the signer is asked. `sealed` means one copy addressed to
// the owner is ready to open; `reply-only` needs no opening at all.
export function sealedFor(event, { owner, agent, verify }) {
  if (!event) return cantTell('no-card')
  let ok = false
  try { ok = verify(event) === true } catch { ok = false }
  if (!ok) return cantTell('bad-signature')
  if (event.pubkey !== agent || event.kind !== CARD_KIND || tagOf(event, 'd')?.[1] !== CARD_D) return cantTell('not-its-card')
  let card
  try { card = JSON.parse(event.content) } catch { return cantTell('unreadable-card') }
  if (!card || typeof card !== 'object' || card.pubkey !== agent) return cantTell('not-its-card')
  if (card.may_post === null) return { state: 'reply-only' }
  if (!card.may_post || typeof card.may_post !== 'object') return cantTell('unreadable-card')
  if (card.owner_view == null) return cantTell('no-view')
  if (!Array.isArray(card.owner_view)) return cantTell('bad-shape')
  const mine = card.owner_view.filter(e => e?.to === owner)
  // Two copies for one owner could say different things; neither is believed.
  if (mine.length !== 1) return cantTell(mine.length ? 'bad-shape' : 'not-for-you')
  const { by, sealed } = mine[0]
  if (!HEX64.test(by || '') || typeof sealed !== 'string' || !sealed) return cantTell('bad-shape')
  return { state: 'sealed', by, sealed, eventId: event.id, signedAt: event.created_at }
}

// A view for every agent on the chart. A taker with no card reads "can't tell", and carries no flag,
// as every list that can't be read does. `opened` keeps a list opened once for that exact card event.
export function viewsFor({ cards, takers = [], owner, verify, opened = new Map() }) {
  const views = new Map()
  for (const [pk, card] of cards) {
    const s = sealedFor(card.event, { owner, agent: pk, verify })
    views.set(pk, s.state !== 'sealed' ? s : opened.get(`${owner}|${s.eventId}`) || { state: 'cant-tell', why: 'not-opened', event: card.event })
  }
  for (const pk of takers) if (!views.has(pk)) views.set(pk, cantTell('no-card'))
  return views
}

// The plaintext, held to the form nvoy seals (agent_card.mjs ownerView): every field present, no
// other field, and the merged list's own rules (one entry per key, one key per name, a refused
// grant on no entry). Anything else is not a list this page can vouch for.
export function viewShape(json) {
  let v
  try { v = JSON.parse(json) } catch { return null }
  if (!exactly(v, ['mention', 'refused', 'channels']) || ![v.mention, v.refused, v.channels].every(Array.isArray)) return null
  const keys = new Set(), names = new Set(), attached = new Set()
  for (const e of v.mention) {
    if (!exactly(e, ['name', 'pubkey', 'source', 'grants']) || !HEX64.test(e.pubkey) || keys.has(e.pubkey)) return null
    if (!(e.name === null || (typeof e.name === 'string' && NAME.test(e.name))) || !SOURCES.includes(e.source)) return null
    if (!Array.isArray(e.grants) || !e.grants.every(g => typeof g === 'string' && HEX64.test(g) && !attached.has(g))) return null
    if (e.source === 'grant' && (!e.name || !e.grants.length)) return null
    if (e.name !== null) { if (names.has(e.name.toLowerCase())) return null; names.add(e.name.toLowerCase()) }
    keys.add(e.pubkey); for (const g of e.grants) attached.add(g)
  }
  for (const r of v.refused) {
    if (!exactly(r, ['grant', 'reason']) || typeof r.grant !== 'string' || !HEX64.test(r.grant) || attached.has(r.grant)) return null
    if (typeof r.reason !== 'string' || !r.reason || r.reason.length > 300) return null
  }
  for (const c of v.channels) {
    if (!exactly(c, ['id', 'name']) || typeof c.id !== 'string' || !c.id || c.id.length > 128) return null
    if (!(c.name === null || (typeof c.name === 'string' && c.name.length <= 128))) return null
  }
  return v
}

// Open one card's view for its owner. `decrypt(by, sealed)` is the owner's signer's NIP-44 decrypt.
export async function openOwnerView(event, { owner, agent, verify, decrypt }) {
  const s = sealedFor(event, { owner, agent, verify })
  if (s.state !== 'sealed') return s
  let json
  try { json = await decrypt(s.by, s.sealed) } catch { return cantTell('decrypt-failed') }
  if (typeof json !== 'string') return cantTell('decrypt-failed')
  const view = viewShape(json)
  return view ? { state: 'readable', view, eventId: s.eventId, signedAt: s.signedAt } : cantTell('bad-shape')
}

// The one-way flag (design, "The one-way flag"). The square is on: the giver can give the agent work,
// by nvoy or by Buzz; the agent's list is readable; and the giver is neither on it nor the agent. A
// voice is its own key, so a list naming only the voice's owner still flags the voice's square.
export const oneWay = ({ on, giver, agent, view }) =>
  on === true && view?.state === 'readable' && giver !== agent && !view.view.mention.some(e => e.pubkey === giver)

// The line under the grid: "1 one-way pair: Dennis → Pi Dog." Lists that can't be read are said,
// so no pairs among the readable ones is never "no pairs".
export function oneWayLine(pairs, { nameOf, unread = 0, readable = 0 }) {
  const unknown = unread ? ` ${unread === 1 ? "1 agent's list" : `${unread} agents' lists`} can't be read, so ${unread === 1 ? 'it is' : 'they are'} not checked.` : ''
  if (!pairs.length) return readable ? `No one-way pairs among the agents whose lists you can read.${unknown}` : unknown.trim()
  const named = pairs.map(p => `${nameOf(p.giver)} → ${nameOf(p.agent)}`).join(', ')
  return `${pairs.length} one-way pair${pairs.length === 1 ? '' : 's'}: ${named}. ${pairs.length === 1 ? 'That agent' : 'Each agent'} can't mention its giver back.${unknown}`
}

export const REPLY_ONLY = 'It may only reply: it answers whoever gave the work, and can bring no one else in. Changing that is a fleet change.'

// The row's "Who it can mention · shown to you only", one line per entry and per refused grant.
export function mentionLines(v, { nameOf, shortKey }) {
  if (v?.state === 'reply-only') return { lines: [REPLY_ONLY] }
  if (v?.state !== 'readable') return { unknown: true, lines: [`Can't tell who it can mention: ${WHY[v?.why] || WHY['bad-shape']}.`] }
  const lines = v.view.mention.map(e => {
    const who = nameOf(e.pubkey), key = shortKey(e.pubkey)
    const source = e.source === 'manifest' ? 'set on the fleet host' : `by ${e.grants.length === 1 ? 'a mention grant' : `${e.grants.length} mention grants`}`
    return `${e.name ? `@${e.name}` : 'no @name'} · ${who === key ? key : `${who}, ${key}`} · ${source}`
  })
  if (!lines.length) lines.push('Nobody by name.')
  for (const r of v.view.refused) lines.push(`Refused: grant ${r.grant.slice(0, 10)}…, ${r.reason}`)
  return { lines }
}

// ── The fix (step 4) ────────────────────────────────────────────────────────────────────────
// The owner's own live mention grants for `giver` over `agent`, and where they stand on the agent's
// card. Only the card naming a grant's own id on the giver's entry proves the agent took it; the
// giver merely being listed is not proof, and a card that can't be read leaves the grant pending.
export const mentionGrantsOf = (grants, { owner, giver, agent, subjectOf }) =>
  grants.filter(g => g.live && g.cap === 'mention' && g.grantor === owner && g.grantee === giver && subjectOf(g.hash) === agent)

export function mentionStatus(view, mine) {
  if (!mine.length) return { state: 'none' }
  const ids = new Set(mine.map(g => g.id))
  if (view?.state !== 'readable') return { state: 'pending', grants: mine }
  // Proof is this grant's id on its own giver's entry, in a card no older than the grant. The same
  // second counts; an older card cannot have read it, and an id under another key proves nothing.
  const takes = (e, g) => e.pubkey === g.grantee && e.grants.includes(g.id) && view.signedAt >= g.at
  const taken = view.view.mention.find(e => mine.some(g => takes(e, g)))
  if (taken) return { state: 'taken', entry: taken }
  const refused = view.view.refused.filter(r => ids.has(r.grant))
  const waiting = mine.filter(g => !refused.some(r => r.grant === g.id))
  return waiting.length ? { state: 'pending', grants: waiting } : { state: 'refused', refused }
}

// The name another key already holds on this list, which would make the grant a refused one.
export function nameClash(view, name, giver) {
  if (view?.state !== 'readable' || !name) return null
  return view.view.mention.find(e => e.pubkey !== giver && e.name && e.name.toLowerCase() === name.toLowerCase()) || null
}

export const mentionWhatIf = ({ agentName, giverName, name }) => `${agentName} will be able to mention ${giverName} as @${name}.`
export const PUBLIC_NAME = 'The name is public. Anyone reading the approval relays sees that some agent may mention this key under it; the agent itself stays hashed.'
export const PENDING = agentName => `Signed, waiting for ${agentName} to take it. The flag clears when ${agentName}'s card lists this approval.`

// The owner's own live grants on one entry of the list: the ones a 441 from this owner can end.
export const ownGrantsOn = (entry, grants, owner) => {
  const ids = new Set(entry?.grants || [])
  return grants.filter(g => g.live && g.cap === 'mention' && g.grantor === owner && ids.has(g.id))
}
