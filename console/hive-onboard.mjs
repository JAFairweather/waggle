// hive-onboard.mjs — the owner's `onboard` grant: a delegate may ask the fleet for new agents
// (docs/DESIGN_ONBOARDING_DELEGATE.md, Part 1, piece 6).
//
// The grant is one kind 440 from the owner: `p` = the delegate, `da-cap onboard`, and a scope that is
// a salted hash of the owner's own key (nvoy onboard_delegate.mjs: `scopeHash(grantor, salt)`, frozen
// by My Dude as "the signed 440 grantor pubkey"). The same signed event carries the two statements
// only the owner can make, and the fleet refuses a delegate request without both:
//
//   ["policy", <terms version>]  the hive's current terms, which the owner was shown and agreed to;
//   ["age", "confirmed"]         the owner's own age attestation.
//
// The page drafts both from what the owner ticked. It never ticks either for him: no agreement, no
// age tick, or terms it could not read, and nothing is drafted. A revocation is one kind 441 from the
// owner; the fleet honours a same-grantor 441 whatever either event's created_at says, and so does
// the fold here, so the page never shows live a grant the fleet treats as revoked.
//
// Signing, publishing and the cold read-back are hive-change.mjs's applyChange, unchanged: a grant
// is done only when a relay serves it back by id on a fresh connection, a revocation only when no
// relay read still serves the grant without its 441.

import { freshSalt } from './hive-change.mjs'
import { joinGate } from './hive-invite.mjs'

export const ONBOARD_CAP = 'onboard'
const HEX64 = /^[0-9a-f]{64}$/
const SALT = /^[0-9a-f]{32}$/
// nvoy onboard_request.mjs POLICY: the shape the fleet accepts as a terms version.
const POLICY = /^[A-Za-z0-9._:-]{1,64}$/
const tag = (ev, name) => (Array.isArray(ev?.tags) ? ev.tags : []).find(t => Array.isArray(t) && t[0] === name)
const one = (ev, name) => { const t = tag(ev, name); return typeof t?.[1] === 'string' ? t[1] : null }
const nowSec = () => Math.floor(Date.now() / 1000)

// Whether the owner may sign an onboard grant now. The same gate as the hive invite (joinGate: the
// terms read, his own agreement), plus the age tick always: the fleet refuses an onboard grant
// without `age confirmed` whatever the terms say, because it stands for every agent the delegate adds.
export function onboardGate(terms, { agreed = false, ageConfirmed = false } = {}) {
  const gate = joinGate(terms, { agreed, ageConfirmed })
  if (!gate.ok) return gate
  if (terms.version !== 'none' && !POLICY.test(String(terms.version))) return { ok: false, reason: `The hive's terms version (${terms.version}) is not one the fleet accepts. Nothing was made.` }
  if (agreed !== true) return { ok: false, reason: 'Tick that you agree to the hive\'s terms for every agent this delegate adds. That is yours to tick; the page never does.' }
  if (ageConfirmed !== true) return { ok: false, reason: 'Tick that you confirm the age requirement. It stands for every agent this delegate adds; tick it only if it is true.' }
  return { ok: true }
}

// The 440, drafted only past the gate. `owner` is the key the page read the hive as; the signer must
// be that key (applyChange checks it), because the scope binds the grant to its signer.
export async function draftOnboardGrant({ delegate, owner, terms, agreed, ageConfirmed, scopeHash, salt = freshSalt(), now = nowSec() }) {
  if (!HEX64.test(delegate || '')) throw new Error('The delegate is not a public key.')
  if (!HEX64.test(owner || '')) throw new Error('Your key is not known yet; read the hive first.')
  if (delegate === owner) throw new Error('You need no grant to add agents to your own hive.')
  const gate = onboardGate(terms, { agreed, ageConfirmed })
  if (!gate.ok) throw new Error(gate.reason)
  if (!SALT.test(salt)) throw new Error('The salt must be 16 random bytes in hex.')
  return { kind: 440, created_at: now, content: '',
    tags: [['p', delegate], ['da-scope', await scopeHash(owner, salt), salt], ['da-cap', ONBOARD_CAP], ['policy', String(terms.version)], ['age', 'confirmed']] }
}

// The owner's onboard grants, as the fleet folds them (nvoy foldOnboardGrants): only his own 440s
// with `da-cap onboard`, a delegate that is a key and not his, and a scope that hashes his own key; a
// 441 from him revokes its grant whatever the timestamps. Expired grants (NIP-40) are ended too.
// Each grant says whether the fleet would accept it against `terms` now, and why not.
export async function onboardGrantsOf(events, { owner, verify, scopeHash, terms = null, now = nowSec() }) {
  const grants = new Map(), revoked = new Set()
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.pubkey !== owner || (ev.kind !== 440 && ev.kind !== 441)) continue
    let ok = false
    // A copy, as nvoy's fold verifies: nostr-tools caches a verification on the object itself.
    try { ok = verify(JSON.parse(JSON.stringify(ev))) === true } catch { ok = false }
    if (!ok) continue
    if (ev.kind === 441) { const id = one(ev, 'e'); if (id) revoked.add(id); continue }
    if (one(ev, 'da-cap') !== ONBOARD_CAP) continue
    const delegate = String(one(ev, 'p') || '').toLowerCase(), scope = tag(ev, 'da-scope')
    if (!HEX64.test(delegate) || delegate === owner || !scope || scope[1] !== await scopeHash(owner, scope[2] || '')) continue
    const exp = tag(ev, 'expiration')
    const expired = !!exp && (!/^[0-9]{1,12}$/.test(String(exp[1])) || Number(exp[1]) <= now)
    grants.set(ev.id, { id: ev.id, delegate, at: Number.isInteger(ev.created_at) ? ev.created_at : 0, policy: one(ev, 'policy'), age: one(ev, 'age'), expired })
  }
  return [...grants.values()].map(g => {
    const state = revoked.has(g.id) ? 'revoked' : g.expired ? 'expired' : 'live'
    return { ...g, state, live: state === 'live', ...(state === 'live' ? { usable: usable(g, terms) } : {}) }
  }).sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
}

// What the fleet's request parser would say about a live grant now (nvoy onboard_request.mjs).
function usable(g, terms) {
  if (!POLICY.test(String(g.policy || ''))) return { ok: false, reason: 'it carries no terms version, so the fleet refuses every request under it' }
  if (g.age !== 'confirmed') return { ok: false, reason: 'it carries no age confirmation, so the fleet refuses every request under it' }
  if (!terms?.ok) return { ok: null, reason: "the hive's terms could not be read, so whether it still matches is unknown" }
  if (terms.version !== g.policy) return { ok: false, reason: `it agreed terms ${g.policy}, but the hive now serves ${terms.version}; sign a new one` }
  return { ok: true, reason: 'the fleet accepts requests under it' }
}

// Just before signing: the hive's terms are read again, and an onboard grant is signed only if the hive
// still serves the version it carries. The owner agreed to the terms he was shown; if they changed, or
// cannot be read, nothing is signed and he reads and ticks again. Any other event passes untouched.
export async function recheckOnboard(template, { readTerms }) {
  if (template?.kind !== 440 || one(template, 'da-cap') !== ONBOARD_CAP) return { ok: true }
  let now
  try { now = await readTerms() } catch (e) { now = { ok: false, reason: e?.message || String(e) } }
  if (!now?.ok) return { ok: false, reason: `Can't read the hive's terms again before signing (${now?.reason || 'not read'}). Nothing was signed; read the terms and tick again.` }
  const drafted = one(template, 'policy')
  if (now.version !== drafted) return { ok: false, reason: `The hive's terms changed from ${drafted} to ${now.version} since you read them. Nothing was signed; read the new terms and tick again.` }
  return { ok: true }
}

// Plain words for the confirm panel, names only.
export function describeOnboard(change, nameOf) {
  if (change.action === 'give') return `Give: ${nameOf(change.delegate)} may ask the fleet to add new agents to your hive, at most one a day, `
    + `from the templates you list. You agree to the hive's terms (${change.policy}) and confirm the age requirement for each agent it adds. `
    + 'Who may give those agents work stays yours.'
  return `Withdraw onboard grant ${change.grant.id.slice(0, 10)}…: ${nameOf(change.grant.delegate)} may no longer ask for new agents. `
    + 'Requests not yet acted on are void; agents already added stay.'
}
