// hive-change.mjs — change who can give an agent work, from the hive page (#613 M2, #617).
//
// Every change runs the spec's five steps (docs/HIVE_MANAGER_SPEC.md, "The page", Change): draft the
// 440 or 441, show it in plain words with the exact JSON beneath, sign it, publish it to the full
// grant relay set, and read it back cold before calling it done. The page holds the confirm panel
// and the signer; this module holds the rest. The relay connection and the signer are injected, so
// the suite drives the done/not-done rules against simulated relays instead of trusting them.
//
// What "done" means is the point of the module. A relay's OK is not storage, so a grant is done only
// when a relay serves it back by id on a fresh connection. A withdrawal is done only when a relay
// serves the 441 back and no relay that was read still serves the grant without it (#457): anyone
// reading that relay alone would go on counting the approval.

import { GRANT_RELAYS } from './vendor/nvoy-grant-relays.mjs'
import { describeGrant } from './capability-vocabulary.mjs'

// Who can give it work: work it asks about first, and work it may act on without asking.
export const WORK_CAPS = ['task', 'task+act']
// Every approval the page changes: work, the bridge carrying work to an agent, and your voice.
// Channel passes stay out (#613 M4): they still carry the bridge's returns.
export const CHANGE_CAPS = [...WORK_CAPS, 'task-relay', 'shadow']
const HEX64 = /^[0-9a-f]{64}$/
const SALT = /^[0-9a-f]{32}$/
const tag = (ev, name) => (Array.isArray(ev?.tags) ? ev.tags : []).find(t => t?.[0] === name)
const nowSec = () => Math.floor(Date.now() / 1000)
export const relayHost = url => { try { return new URL(url).host } catch { return String(url) } }

// One fresh salt per grant, never one per batch: a shared salt makes two grants over the same
// subject linkable, which is what the salt exists to prevent.
export const freshSalt = (random = n => crypto.getRandomValues(new Uint8Array(n))) =>
  [...random(16)].map(b => b.toString(16).padStart(2, '0')).join('')

// The same tag layout as grant.mjs and connect.html, so nvoy's fold reads it like any other grant.
// `agent` is the approval's subject: the agent for work and carrying, your own key for your voice.
export async function draftGrant({ grantee, agent, cap, scopeHash, salt = freshSalt(), now = nowSec() }) {
  if (!HEX64.test(grantee || '')) throw new Error('The one to approve is not a public key.')
  if (!HEX64.test(agent || '')) throw new Error('The agent is not a public key.')
  if (grantee === agent) throw new Error('No one needs an approval over itself.')
  if (!CHANGE_CAPS.includes(cap)) throw new Error(`This page gives only ${CHANGE_CAPS.join(', ')}, not ${cap}.`)
  if (!SALT.test(salt)) throw new Error('The salt must be 16 random bytes in hex.')
  return { kind: 440, created_at: now, tags: [['p', grantee], ['da-scope', await scopeHash(agent, salt), salt], ['da-cap', cap]], content: '' }
}

export function draftRevoke({ grantId, now = nowSec() }) {
  if (!HEX64.test(grantId || '')) throw new Error('That is not an approval id.')
  return { kind: 441, created_at: now, tags: [['e', grantId]], content: '' }
}

// Every live approval of these kinds from `grantee` over `subject`, duplicates included: stopping
// withdraws all of them, so an older copy is not left behind.
export function approvalsOf(grants, { subject, grantee, caps, subjectOf }) {
  return grants.filter(g => g.live && g.grantee === grantee && caps.includes(g.cap) && subjectOf(g.hash) === subject)
}
export const workApprovals = (grants, { agent, grantee, subjectOf }) => approvalsOf(grants, { subject: agent, grantee, caps: WORK_CAPS, subjectOf })

// Plain words for the confirm panel. Names only, never hex, and the capability sentence is the
// console's one vocabulary for it.
export function describeChange(change, nameOf) {
  if (change.action === 'give') return `Give: ${describeGrant({ cap: change.cap, grantee: nameOf(change.grantee), subject: nameOf(change.agent) })}.`
  const g = change.grant
  return `Withdraw approval ${g.id.slice(0, 10)}…, which says ${describeGrant({ cap: g.cap, grantee: nameOf(g.grantee), subject: nameOf(change.agent) })}.`
}

// The signer must hand back the event that was shown, not merely an event: what the owner approved
// on the page is the only check of content the signing path has (#617, D1). The timestamp counts
// too: nvoy's fold keeps the newest approval per grantee and cap, so a re-dated event can decide
// which approval wins.
export const sameAsDrafted = (signed, template) => signed?.kind === template.kind && signed.created_at === template.created_at &&
  signed.content === template.content && JSON.stringify(signed.tags) === JSON.stringify(template.tags)

export function publishTo(signed, { relays = GRANT_RELAYS, connect, timeoutMs = 12000 }) {
  return Promise.all(relays.map(url => new Promise(resolve => {
    let ws, t, done = false
    const end = (outcome, reason = '') => { if (done) return; done = true; clearTimeout(t); try { ws.close() } catch {} resolve({ url, outcome, reason }) }
    try { ws = connect(url) } catch { return end('unreachable') }
    t = setTimeout(() => end('timeout'), timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', signed]))
    ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m[0] === 'OK' && m[1] === signed.id) end(m[2] ? 'accepted' : 'rejected', String(m[3] || '')) } catch {} }
    ws.onerror = () => end('unreachable')
  })))
}

// A fresh connection per relay, so nothing the publish saw can answer for it. A relay has answered
// only when it sends EOSE; one cut off after some events is partial, as on the rest of the page.
export function readBackFrom(filters, { relays = GRANT_RELAYS, connect, verify, timeoutMs = 12000 }) {
  return Promise.all(relays.map(url => new Promise(resolve => {
    let ws, t, done = false
    const events = []
    const end = state => { if (done) return; done = true; clearTimeout(t); try { ws.close() } catch {} resolve({ url, state, events }) }
    const cut = () => end(events.length ? 'partial' : 'none')
    try { ws = connect(url) } catch { return cut() }
    t = setTimeout(cut, timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'read-back', ...filters]))
    ws.onmessage = e => { try {
      const m = JSON.parse(e.data)
      if (m[0] === 'EVENT' && m[1] === 'read-back') { let ok = false; try { ok = verify(m[2]) } catch {} if (ok) events.push(m[2]) }
      if (m[0] === 'EOSE' && m[1] === 'read-back') end('complete')
      if (m[0] === 'CLOSED' && m[1] === 'read-back') cut()
    } catch {} }
    ws.onerror = cut
  })))
}

const unanswered = back => back.filter(r => r.state !== 'complete').map(r => r.url)

export function grantVerdict(signed, back) {
  const holding = back.filter(r => r.events.some(e => e.id === signed.id)).map(r => r.url)
  return { kind: 440, done: holding.length > 0, holding, stale: [], silent: unanswered(back), of: back.length }
}

// The withdrawal counts wherever it is held, the way readGrants and nvoy's fold count it: by its
// author, against the first `e` tag. Any such 441 will do, not only the one just signed.
export function withdrawalVerdict(revoke, grantId, back) {
  const withdraws = e => e.kind === 441 && e.pubkey === revoke.pubkey && tag(e, 'e')?.[1] === grantId
  const holding = back.filter(r => r.events.some(withdraws)).map(r => r.url)
  const stale = back.filter(r => r.events.some(e => e.id === grantId) && !r.events.some(withdraws)).map(r => r.url)
  return { kind: 441, done: holding.length > 0 && stale.length === 0, holding, stale, silent: unanswered(back), of: back.length }
}

export function verdictText(v) {
  const hosts = list => list.map(relayHost).join(', ')
  const silent = v.silent.length ? ` ${v.silent.length} of ${v.of} relays did not answer the read-back in full (${hosts(v.silent)}).` : ''
  if (v.kind === 440) return v.done
    ? `Done. ${v.holding.length} of ${v.of} relays serve it back (${hosts(v.holding)}).${v.holding.length === 1 ? ' Only one relay holds it: if that relay drops it, the approval stops counting.' : ''}${silent}`
    : `Not done. It was signed and sent, but no relay served it back. A relay's OK is not storage.${silent}`
  if (v.done) return `Done. ${v.holding.length} of ${v.of} relays serve the withdrawal back, and none still serves the approval without it.${silent}`
  if (v.stale.length) return `Not done. ${hosts(v.stale)} still serve${v.stale.length === 1 ? 's' : ''} the approval without its withdrawal, so anyone reading there still counts it.${silent}`
  return `Not done. It was signed and sent, but no relay served the withdrawal back.${silent}`
}

// Sign, check it is the event shown, publish, read back cold, and judge. Nothing is published
// unless the signed event is the drafted one, signed by the key the page read the hive as.
export async function applyChange(template, { sign, owner, verify, connect, relays = GRANT_RELAYS, timeoutMs, onStep = () => {} }) {
  onStep('waiting for your signer')
  const signed = await sign(template)
  let valid = false
  try { valid = verify(signed) } catch {}
  if (!valid || !sameAsDrafted(signed, template)) throw new Error('The signer returned an event that is not the one shown. Nothing was published.')
  if (signed.pubkey !== owner) throw new Error('Your signer signed with a different key from the one this page read the hive as. Nothing was published.')
  onStep('publishing')
  const published = await publishTo(signed, { relays, connect, timeoutMs })
  onStep('reading it back')
  let verdict
  if (signed.kind === 440) {
    verdict = grantVerdict(signed, await readBackFrom([{ ids: [signed.id] }], { relays, connect, verify, timeoutMs }))
  } else {
    const grantId = tag(signed, 'e')[1]
    const back = await readBackFrom([{ ids: [grantId] }, { kinds: [441], authors: [signed.pubkey], '#e': [grantId] }], { relays, connect, verify, timeoutMs })
    verdict = withdrawalVerdict(signed, grantId, back)
  }
  return { signed, published, verdict, text: verdictText(verdict) }
}
