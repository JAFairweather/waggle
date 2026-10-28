// A link that opens the console at a grant to sign or a grant to revoke, so the beeswarm page
// (nvoy, waggle.nave.pub/status/beeswarm.html) can say "change this" and land the owner on the one
// form that changes it.
//
// THE LINK CARRIES PREFIXES, NOT KEYS. The swarm is published sanitised: names and 8-hex prefixes
// only. So the link names keys by prefix, and the console resolves each one against keys it already
// holds — the grantees and grant ids it just read and verified for the signed-in grantor, and that
// key itself. A link can therefore point only at something the owner has already granted or been
// shown; it can never introduce a key. That is the property that makes a prefilled grant form safe
// to open from a URL: a crafted link cannot aim a grant at a stranger.
//
// A LINK NEVER SIGNS. The hive page (#613 M4) puts the change it names in the confirm panel and
// stops. Signing stays the owner's click and the signer's approval, exactly as without the link.
//
// An ambiguous or unknown prefix resolves to nothing and says so. A guess here would be a grant to
// the wrong key, which is a legitimate operation nothing downstream can catch.
//
//   #revoke=<grant id prefix>
//   #grant=<grantee prefix>&on=<agent prefix>&cap=<cap>
//   #agent=<agent prefix>          opens that agent's row on the hive page and changes nothing

const PREFIX = /^[0-9a-f]{8,64}$/
const CAP = /^[a-z][a-z+-]{0,19}$/

export function parseIntent(hash) {
  const raw = String(hash || '').replace(/^#/, '')
  if (!raw) return null
  // Parsed by hand: the console's lint admits three browser globals, and a hash of a few hex fields
  // does not justify a fourth.
  const pairs = raw.split('&').map(kv => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)] })
  const field = k => { const p = pairs.find(([n]) => n === k); try { return p ? decodeURIComponent(p[1]) : null } catch { return '' } }
  const q = { has: k => pairs.some(([n]) => n === k), get: field }
  const hex = k => { const v = (q.get(k) || '').toLowerCase(); return PREFIX.test(v) ? v : null }
  if (q.has('revoke')) {
    const grant = hex('revoke')
    return grant ? { action: 'revoke', grant } : { action: 'invalid', why: 'the grant in this link is not a hex id or prefix' }
  }
  if (q.has('grant')) {
    const to = hex('grant'), on = hex('on'), cap = q.get('cap')
    if (!to || !on) return { action: 'invalid', why: 'this link must name the grantee and the agent by hex prefix' }
    if (cap !== null && !CAP.test(cap)) return { action: 'invalid', why: 'the capability in this link is not one the console knows' }
    return { action: 'grant', to, on, cap }
  }
  if (q.has('agent')) {
    const agent = hex('agent')
    return agent ? { action: 'agent', agent } : { action: 'invalid', why: 'the agent in this link is not a hex key or prefix' }
  }
  return null
}

// One full key or id that starts with the prefix, from the ones given — or why there is none.
export function resolvePrefix(prefix, candidates) {
  const hits = [...new Set(candidates.filter(c => typeof c === 'string').map(c => c.toLowerCase()))].filter(c => c.startsWith(prefix))
  if (hits.length === 1) return { value: hits[0] }
  return { value: null, why: hits.length ? `${prefix} matches ${hits.length} keys here — open it by hand` : `${prefix} is not a key this console has read for you` }
}

// The live grant a revoke link names, among the signed-in grantor's own verified grants.
export function resolveRevoke(intent, grants) {
  const live = grants.filter(g => g.live)
  const r = resolvePrefix(intent.grant, live.map(g => g.id))
  if (r.value) return { grant: live.find(g => g.id === r.value) }
  const gone = grants.some(g => !g.live && g.id.startsWith(intent.grant))
  return { grant: null, why: gone ? `grant ${intent.grant} is already revoked` : `grant ${intent.grant} is not a live grant signed by this key` }
}

// What each capability's subject must be for nvoy to count the approval. An approval over any other
// subject still signs and reads back, so without this a link could end in "Done" for a grant that
// does nothing (vendor/nvoy-admission.mjs counts a shadow only when its scope is the grantor's key).
export function subjectRule({ cap, to, on, owner, bridge }) {
  if (cap === 'shadow') {
    if (on !== owner) return 'your voice is given over your own key, so the link must name you as the agent; over any other key nvoy never counts it'
    if (to === owner) return 'your voice is given to an agent, not to yourself'
    return null
  }
  if (on === owner) return `${cap} is given over an agent, not over your own key`
  if (cap === 'task-relay' && bridge && to !== bridge) return 'carrying is given only to the waggle bridge'
  return null
}

// The issue form's three fields for a grant link. The grantee and the agent come only from keys
// this console has verified; the capability is checked against what may be issued over an agent,
// and the subject against what that capability needs, before any confirm panel is shown.
export function resolveGrant(intent, { known, issuable, owner, bridge }) {
  const to = resolvePrefix(intent.to, known), on = resolvePrefix(intent.on, known)
  if (!to.value) return { why: `the grantee: ${to.why}` }
  if (!on.value) return { why: `the agent: ${on.why}` }
  const allowed = issuable.filter(o => o.ok).map(o => o.cap)
  if (intent.cap !== null && !allowed.includes(intent.cap)) return { why: `${intent.cap} cannot be granted over an agent here` }
  const why = subjectRule({ cap: intent.cap || 'task', to: to.value, on: on.value, owner, bridge })
  if (why) return { why }
  return { to: to.value, on: on.value, cap: intent.cap }
}
