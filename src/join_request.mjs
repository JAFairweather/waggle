// join_request.mjs — what a session asks for, and what an owner is allowed to be shown.
//
// A join request is the one artifact in this ceremony authored by someone the hive has not
// admitted yet. Everything in it is attacker-controlled by definition: the purpose text, the
// requested capabilities, the label. So this module's job is to be paranoid about a stranger's
// JSON before any of it reaches an owner's screen or an issuing path.
//
// Two separate concerns, kept separate on purpose:
//   - `buildJoinRequest` is what the requesting session emits. It cannot lie usefully, because
//     everything it says gets re-validated on the other side.
//   - `readJoinRequest` is what the owner's side trusts, and it trusts nothing it has not checked.
//
// The capability list is the sharp edge. A request that asks for `admit+read` must not be able to
// walk an owner into granting read — the community relay will not serve an external key anyway, so
// the grant would be a lie told to the owner rather than a capability delivered to the agent.

export const JOIN_REQUEST_KIND = 27493          // ephemeral range, alongside the challenge kind
const HEX64 = /^[0-9a-f]{64}$/

// The only capabilities a join request may ask for. Deliberately NOT the full CAP_LABEL set:
//   admit+read — conveys channel key material; not issuable by a console and not issuable here
//   mirror     — authored by the participant about themselves, never granted by an owner
export const REQUESTABLE_CAPS = ['admit', 'task', 'task+act', 'task-relay']

export const MAX_PURPOSE = 300
export const MAX_LABEL = 64
// Same screen the console applies to a label it is about to sign into a public artifact.
export const CREDENTIAL_SHAPED = /nsec1|ncryptsec1|bunker:|^[0-9a-f]{64}$/i

/**
 * The unsigned event a joining session publishes. The caller signs it with the EPHEMERAL request
 * key — never with a persistent identity, which at this point does not exist yet.
 */
export function buildJoinRequest({ hivePubkey, caps, purpose = '', label = '', createdAt }) {
  if (!HEX64.test(String(hivePubkey || '').toLowerCase())) throw new Error('a join request must name the hive it is asking to join')
  const wanted = [...new Set(Array.isArray(caps) ? caps : [])]
  if (!wanted.length) throw new Error('a join request must ask for at least one capability')
  for (const cap of wanted) {
    if (!REQUESTABLE_CAPS.includes(cap)) throw new Error(`"${cap}" cannot be requested here — choose from: ${REQUESTABLE_CAPS.join(', ')}`)
  }
  if (String(purpose).length > MAX_PURPOSE) throw new Error(`purpose is longer than ${MAX_PURPOSE} characters`)
  if (String(label).length > MAX_LABEL) throw new Error(`label is longer than ${MAX_LABEL} characters`)
  for (const [field, value] of [['purpose', purpose], ['label', label]]) {
    if (CREDENTIAL_SHAPED.test(String(value))) throw new Error(`${field} looks like a credential — never put key material in a public request`)
  }
  return {
    kind: JOIN_REQUEST_KIND,
    created_at: Number.isFinite(createdAt) ? createdAt : Math.floor(Date.now() / 1000),
    tags: [['p', String(hivePubkey).toLowerCase()], ...wanted.map(c => ['da-cap', c])],
    content: JSON.stringify({ v: 1, purpose: String(purpose), label: String(label) }),
  }
}

/**
 * Read a join request that arrived from a stranger. Returns `{ ok, request }` or `{ ok, reason }`.
 *
 * Signature verification is the CALLER's, because it needs a verifier this module must not import
 * — but this refuses to look at anything until it has been told the event was verified, so the
 * check cannot be forgotten silently.
 */
export function readJoinRequest(ev, { hivePubkey, verified, now = Math.floor(Date.now() / 1000), maxAgeSecs = 3600, maxSkewSecs = 300 } = {}) {
  if (verified !== true) return { ok: false, reason: 'join request was not signature-verified before being read' }
  if (!ev || ev.kind !== JOIN_REQUEST_KIND) return { ok: false, reason: 'not a join request' }
  const requester = String(ev.pubkey || '').toLowerCase()
  if (!HEX64.test(requester)) return { ok: false, reason: 'join request has no usable author' }

  const addressed = (ev.tags || []).filter(t => t[0] === 'p').map(t => String(t[1] || '').toLowerCase())
  // Exactly one addressee. A request naming several hives is one artifact being shown to several
  // owners as though it were meant for each of them.
  if (addressed.length !== 1) return { ok: false, reason: 'a join request must name exactly one hive' }
  if (addressed[0] !== String(hivePubkey || '').toLowerCase()) return { ok: false, reason: 'join request is addressed to a different hive' }

  if (!Number.isFinite(ev.created_at)) return { ok: false, reason: 'join request has no timestamp' }
  // Future and stale are DIFFERENT refusals. Folding them loses the one signal that distinguishes
  // a clock problem from an attempt to keep a request alive past its window.
  if (ev.created_at > now + maxSkewSecs) return { ok: false, reason: 'join request is dated in the future' }
  if (now - ev.created_at > maxAgeSecs) return { ok: false, reason: 'join request has expired' }

  const caps = [...new Set((ev.tags || []).filter(t => t[0] === 'da-cap').map(t => String(t[1] || '')))]
  if (!caps.length) return { ok: false, reason: 'join request asks for nothing' }
  const refused = caps.filter(c => !REQUESTABLE_CAPS.includes(c))
  // Refuse the whole request rather than quietly dropping the parts that are not allowed. Silently
  // narrowing means the owner approves a request whose text and effect differ.
  if (refused.length) return { ok: false, reason: `join request asks for capabilities that cannot be requested: ${refused.join(', ')}` }

  let body
  try { body = JSON.parse(ev.content || '{}') } catch { return { ok: false, reason: 'join request body is not valid JSON' } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'join request body is not an object' }

  // Attacker-controlled prose. Bounded and screened, never trusted, and returned as data so the
  // surface that renders it owns escaping.
  const purpose = typeof body.purpose === 'string' ? body.purpose.slice(0, MAX_PURPOSE) : ''
  const label = typeof body.label === 'string' ? body.label.slice(0, MAX_LABEL) : ''
  for (const [field, value] of [['purpose', purpose], ['label', label]]) {
    if (CREDENTIAL_SHAPED.test(value)) return { ok: false, reason: `join request ${field} is credential-shaped` }
  }

  return { ok: true, request: { requester, hive: addressed[0], caps: caps.sort(), purpose, label, createdAt: ev.created_at, id: String(ev.id || '').toLowerCase() } }
}
