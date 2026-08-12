// registry_reconcile.mjs — name the disagreements between the registries (#392).
//
// Participation here is spread across registries that nothing compares (#379):
//
//   1. the live 440 grant set      — owner writes, owner revokes
//   2. waggle's own lifecycle rows — waggle writes, from a signed lifecycle command
//   3. the relay_members row       — ONLY THE KEY writes it, and only the key removes it (#366)
//   4. users.display_name          — only the key writes it, nobody removes it (#366)
//
// Two issues are the same defect found twice. #321: the Access page lists agents with grants in
// force while the Agents page says "This hive has admitted no agents" — both truthful, about
// different registries. #366: a key whose grant was revoked keeps its relay row unless it removes
// itself, and the issue closes by naming the fix — read the relay's own membership list and diff it
// against live grants, "no risk of our records having drifted from the relay's".
//
// IT REPORTS, IT DOES NOT RESOLVE, and that is not timidity. Three of the four registries are not
// ours to write: only the key can create or remove #3 and #4. A reconciler that silently fixed what
// it could would produce a screen that agrees with itself and disagrees with the relay — the exact
// failure #366 insists on avoiding by reading the relay's list rather than ours. So each finding
// names the key, the disagreement, WHICH SIDE IS AUTHORITATIVE, and WHO CAN ACT. Nothing else.
//
// Pure: no I/O, no relay, no config. Callers supply the four sets they observed.

const hex = (v) => String(v ?? '').toLowerCase()
const isKey = (v) => /^[0-9a-f]{64}$/.test(hex(v))

/**
 * Every disagreement this module can name. Keyed by id so a caller renders from one table rather
 * than a chain of string comparisons — and so a new finding cannot be added without a label, an
 * authority and an actor.
 *
 * `authority` is the registry whose answer is correct when they conflict. `actor` is who can
 * actually change the other one, which is the field that stops a screen offering a button nobody
 * can press: for anything on the relay, the answer is the key itself.
 */
export const FINDINGS = Object.freeze({
  grant_no_row: {
    label: 'Has a grant, missing from the agent roster',
    detail: 'The agent can act. The roster denies it exists, because a grant does not create a row.',
    authority: 'grant', actor: 'owner',
  },
  row_no_grant: {
    label: 'On the agent roster, no live grant',
    detail: 'A row that outlived its authority. The screen shows an agent that cannot act.',
    authority: 'grant', actor: 'owner',
  },
  relay_no_grant: {
    label: 'Can still authenticate to the relay, no live grant',
    detail: 'The owner can evict it directly by signing a kind:9031 relay-admin removal; ' +
      'an owner may remove members and admins, refusing only other owners. #366 concluded this was ' +
      'cooperative-only, but that search was scoped to HTTP routes under api/ and 9031 is a Nostr ' +
      'admin command dispatched from handlers/relay_admin.rs — a directory it never looked in.',
    authority: 'grant', actor: 'the owner, or the key itself',
  },
  grant_no_relay: {
    label: 'Has a grant, never claimed its relay invite',
    detail: 'Looks admitted and cannot authenticate. Reads as a broken bridge; it is an unclaimed invite.',
    authority: 'relay', actor: 'the key itself',
  },
  name_no_grant: {
    label: 'Name still resolves, no live grant',
    detail: 'Nothing can CLEAR a display name (#366) — no DELETE or UPDATE of users.display_name ' +
      'exists in buzz-db. Only the key that wrote it could overwrite it, and a key that has lost its ' +
      'grant is exactly the one that will not.',
    authority: 'grant', actor: 'nobody who will — only the key that wrote it could overwrite it',
  },
})

export const FINDING_IDS = Object.freeze(Object.keys(FINDINGS))

/**
 * Reconcile what was observed.
 *
 * Every argument is a list of hex pubkeys the caller OBSERVED, never a path to read. `relayMembers`
 * in particular must come from the relay's own membership list, not from our records — that is the
 * whole point of #366's exit path.
 *
 * `relayMembers` and `namedKeys` are `null` when they could not be read. That is the distinction the
 * house rule exists for: "no orphan relay rows" and "we could not see the relay" are different
 * facts, and collapsing them reports a clean bill of health for a check that never ran.
 *
 * @returns {{ findings: Array, unread: string[], counts: object }}
 *   `findings` is one entry per (key, finding) pair — a key in two disagreements appears twice,
 *   because a revoked agent normally IS in two, and first-match-wins would hide the second.
 */
export function reconcileRegistries({ grants = [], agentRows = [], relayMembers = null, namedKeys = null } = {}) {
  const set = (list) => new Set((list || []).map(hex).filter(isKey))
  const grant = set(grants)
  const rows = set(agentRows)
  const relay = relayMembers === null ? null : set(relayMembers)
  const named = namedKeys === null ? null : set(namedKeys)

  const findings = []
  const add = (pubkey, id) => findings.push({ pubkey, finding: id, ...FINDINGS[id] })

  for (const pubkey of grant) if (!rows.has(pubkey)) add(pubkey, 'grant_no_row')
  for (const pubkey of rows) if (!grant.has(pubkey)) add(pubkey, 'row_no_grant')
  if (relay) {
    for (const pubkey of relay) if (!grant.has(pubkey)) add(pubkey, 'relay_no_grant')
    for (const pubkey of grant) if (!relay.has(pubkey)) add(pubkey, 'grant_no_relay')
  }
  if (named) for (const pubkey of named) if (!grant.has(pubkey)) add(pubkey, 'name_no_grant')

  // What could not be read, named rather than assumed clean.
  const unread = []
  if (relay === null) unread.push('relay membership list')
  if (named === null) unread.push('resolvable names')

  // Sorted so a re-render is not a spurious diff, the same reason the agents projection sorts.
  findings.sort((a, b) => a.pubkey.localeCompare(b.pubkey) || a.finding.localeCompare(b.finding))
  const counts = Object.fromEntries(FINDING_IDS.map(id => [id, findings.filter(f => f.finding === id).length]))
  return { findings, unread, counts }
}

/**
 * One line per finding, for an operator.
 *
 * Separate from the computation because a rendering bug and a reconciliation bug are different
 * failures, and a test that reads the string cannot tell them apart otherwise.
 */
export function describeFinding(finding) {
  const spec = FINDINGS[finding?.finding]
  if (!spec || !isKey(finding?.pubkey)) return null
  return `${hex(finding.pubkey).slice(0, 12)}… — ${spec.label}. ${spec.detail} Authority: the ${spec.authority}. Who can fix it: ${spec.actor}.`
}
