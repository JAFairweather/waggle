// agent_install_state.mjs — what does this agent still need, and what is merely CLAIMED to be done?
//
// Seating an agent produces fifteen artifacts across two machines, three checkouts and a public
// relay network. Nine of them have no tool that creates them, and every omission fails the same
// way: silently, with the agent appearing to work. A wrong-identity pairing signs and seals
// perfectly. A denied nip44 permission is byte-identical to an empty inbox. A missing kind 0
// costs nothing at runtime — the agent is simply invisible in every client.
//
// So the reporting model here has THREE states, not two. `present` / `missing` is the model that
// lets every one of those defects through, because each of them leaves the artifact present.
//
//   present     — the artifact exists AND something observed it doing its job
//   unverified  — the artifact exists and nothing has checked it. NOT the same as fine.
//   missing     — something looked, and it is not there
//   unknown     — nothing looked. NOT the same as missing.
//
// And one more that is not an observation at all:
//
//   not-applicable — this agent's declared lane never needed it. NOT the same as satisfied.
//
// The lane (#513) exists because there are two ways to participate and this model could describe
// only one of them. Seven of the rows below reach an ssh channel on the broker box; an agent on
// the sealed lane authenticates to the bridge by signature and needs none of them. Until it could
// say so, `--check` told a correctly-onboarded agent it could not run — a wrong answer given
// confidently, which is the failure this file was written to prevent.
//
// The fourth state was added after the first version reported two artifacts as `missing` that it
// had never examined. That is the same false confidence pointing the other way, and it is worse
// than it sounds: "missing" sends an operator to create a thing that may already exist, and for a
// key or a published profile, creating a second one is not a harmless no-op. `found: null` means
// nobody looked and renders as such.
//
// `unverified` is the whole point. This project's rule is that being unable to check is not the
// same as being fine, and tools here exit 3 = INCONCLUSIVE rather than 0 when they could not see
// enough to judge. A report with any `unverified` row is inconclusive, not passing.
//
// This module is pure: it takes observations and returns a report. It reads no files and opens no
// sockets, so tests/agent_install_state.mjs can drive every state including the ones that are
// hard to produce on a real machine. `nip19.decode` is arithmetic over a string and opens nothing,
// so importing it does not cost that.
import { nip19 } from 'nostr-tools'
import { foreignServers, parseClaudeList } from './mcp_runtimes.mjs'

export const PRESENT = 'present'
export const UNVERIFIED = 'unverified'
export const MISSING = 'missing'
export const UNKNOWN = 'unknown'
// A fifth state, and the only one that is not an observation (#513). The four above answer "what
// did we see?"; this one answers "was this ever this agent's step?" — and it must never be spelled
// `present`, because "satisfied" and "did not apply" are different reasons for a row not being a
// problem, and only one of them means the artifact exists. Collapsing them is how a genuinely
// missing credential reads as a green row.
export const NOT_APPLICABLE = 'not-applicable'

// How this agent participates. A DECLARATION, not an observation — and until #513 there was no way
// to make it, so the model could only describe the broker lane. An agent onboarded exactly as the
// design describes was told, with confidence, that it could not run.
export const LANES = Object.freeze({
  sealed: 'seal to the bridge, and the bridge seals back — authenticated by signature, on no other box',
  broker: 'an MCP server reached over ssh, on the broker box',
})

// The artifacts, in the order they must be satisfied. `blocking` marks the ones without which the
// agent cannot function at all — as opposed to the ones without which it merely has no name.
// Both matter; conflating them is how "it works" and "it is finished" became the same claim.
//
// `lanes` scopes a row to the lanes that need it. A row WITHOUT `lanes` is needed by every lane:
// the default is the demanding one on purpose, so adding a lane later cannot quietly excuse an
// artifact that nobody remembered to scope.
export const ARTIFACTS = [
  // First, because it governs every row beneath it. Non-blocking on purpose: an agent that has not
  // said how it participates is not broken, it is unexamined, and the honest report for unexamined
  // is INCONCLUSIVE rather than "cannot run". What it must not do is assume the lane with fewer
  // requirements and pass.
  { key: 'lane', title: 'Declared participation lane', blocking: false,
    why: 'Which lane this agent speaks over, and therefore which artifacts it needs at all. Undeclared is not sealed: the broker rows stay required, because assuming the lane with fewer requirements is how a missing credential reads as satisfied.' },
  { key: 'identity', title: 'Identity key', blocking: true,
    why: 'The key it signs as. Held in the Bunker; this machine never sees it.' },
  { key: 'bunker-uri', title: 'Bunker pairing', blocking: true,
    why: 'The connection capability. Present is not paired — pairing is proven by asking for the public key.' },
  { key: 'bunker-client', title: 'Client transport key', blocking: true,
    why: 'Distinct from the identity. Minting this was absent from every document until it was found the hard way.' },
  { key: 'signer-identity', title: 'Signer resolves to the right key', blocking: true,
    why: 'A wrong-identity pairing signs, seals and publishes perfectly. This is the only step that catches it.' },
  { key: 'signer-methods', title: 'All four NIP-46 methods', blocking: true,
    why: 'Permissions are per-method and denials are silent. Decrypt must be proven by a round trip, never by an empty inbox.' },
  { key: 'nip05', title: 'Name in the directory', blocking: false,
    why: 'Without it every grant command takes a hand-pasted key, in tooling that exists because hand-pasting keys is the risk.' },
  { key: 'profile', title: 'Public profile (kind 0)', blocking: false,
    why: 'Without it the agent renders as a bare key everywhere. It works perfectly and has no name.' },
  { key: 'admit-grant', title: 'Admitted to the channel', blocking: true,
    why: 'The door. Enforced by the bridge, re-read periodically — so it can stop applying without anything failing.' },
  // #337. Every other artifact here asks whether the agent can ACT. This is the only one that asks
  // whether anything can reach it, and it was missing from a fourteen-item checklist that verified
  // nothing inbound. An agent was admitted, posted successfully, and was structurally incapable of
  // receiving a single message — the bridge had been logging `RETURN not sent — no valid kind:10050
  // recipient DM relay list` since its first attempt, and nothing in the agent's own tooling said so.
  { key: 'dm-relays', title: 'Inbound DM relay list (kind 10050)', blocking: true,
    why: 'The only inbound path an external key has, because the community relay will not serve it. Without one the agent is write-only, and an empty inbox looks identical to an inbox that cannot exist.' },
  { key: 'manifest', title: 'Runtime manifest', blocking: true,
    why: 'Six tools read it and none write it. Every field is validated; one bad field refuses the whole runtime.' },
  { key: 'state-dirs', title: 'Runtime directories', blocking: true,
    why: 'Five of them, two with non-default modes. Nothing creates them and nothing lists them.' },
  // ── Broker-lane only, all seven. Every one of them exists to reach an ssh channel on another
  // box, and a sealed-lane agent reaches the bridge by signature instead. Two of these were the
  // rows telling a correctly-onboarded agent it could not run (#513).
  { key: 'channel-key', title: 'Channel keypair', blocking: true, lanes: ['broker'],
    why: 'The MCP channel transport. Minted at the path the registration names — the two used to disagree, so a fresh agent got a correct stanza pointing at a key nothing had created (#474).' },
  // Its own row, not folded into the keypair. The private half is mintable here; neither of these
  // is, and a green key row beside a missing host key is exactly how a fresh agent reads as ready.
  { key: 'channel-host-key', title: "The broker's host key", blocking: true, lanes: ['broker'],
    why: "StrictHostKeyChecking refuses an unknown host, so without this the channel will not connect. It is the broker's host key and comes from the broker doctor on that box — it cannot be minted here, and this tool will never write one." },
  { key: 'channel-authorized', title: 'The public half is seated on the broker', blocking: true, lanes: ['broker'],
    why: "The other box's authorized_keys, under its forced command. Nothing on this machine can see it, so it is UNKNOWN until an operator confirms it — never assumed from the key existing here." },
  { key: 'mcp-registration', title: 'Registered as an MCP server', blocking: true, lanes: ['broker'],
    why: 'How a new session becomes this agent. Needs the instance root set explicitly; the default path does not exist here.' },
  { key: 'mcp-exclusive', title: 'No other nvoy server registered', blocking: true, lanes: ['broker'],
    why: 'Registered is not sole. A generically-named server alongside carries the tools that sign, bound to somebody else.' },
  // #338. Sole is not YOURS. An agent was handed a session whose attached server answered `whoami`
  // with a different agent's identity — it would have read that identity's sealed inbox and posted
  // under its key, and neither would have errored, because a wrong-identity binding signs and seals
  // perfectly. The Bunker path has refused this since day one via EXPECT_PUBKEY. The MCP path had
  // no equivalent, so the same class of defect moved one layer up from Pair to Bind and found no
  // guard there.
  { key: 'mcp-identity', title: 'The server answers as THIS agent', blocking: true, lanes: ['broker'],
    why: 'Registered is not sole, and sole is not yours. Proven by whoami equalling the minted key — never by the registration existing. That proof is a saved capture, not a live signer: it has no freshness and no binding to the session under test, so it passes forever once taken (#462).' },
  { key: 'channel-answers', title: 'Channel server answers', blocking: true, lanes: ['broker'],
    why: 'Registered is not running. Proven by initialize + tools/list, not by the registration existing.' },
]

export const ARTIFACT_KEYS = ARTIFACTS.map(a => a.key)

// ── The ceiling. ─────────────────────────────────────────────────────────────────────────────
//
// `connect-agent --check` cannot report `complete` on any machine, however perfectly the agent is
// installed. It opens no sockets and cannot see the other box, so eleven of the nineteen rows above
// are hardcoded at their call sites: five report `found: null` and six report `verified: false`, and
// no branch can move them. `complete` requires zero unknown and zero unverified, so exit 0 is
// unreachable by construction (#492).
//
// The lane does not change that. Declaring `sealed` scopes three of the eleven out — they are the
// broker's rows — and the remaining eight are still enough to keep exit 0 unreachable. What the
// lane changes is exit **1**: a sealed-lane agent reaches the ceiling at exit 3 instead of being
// told it cannot run. That is the whole of #513, and it is worth being exact about, because "the
// check now passes" is the summary a reader will reach for and it is not what happens.
//
// Each of those was a reasonable local decision — "not checked here" is honest — and the aggregate
// consequence lived in a different file from every one of them. An operator running `--check` to
// completion was chasing an exit code the tool cannot emit, and the natural reading of a permanent
// exit 3 is "something on my box is still wrong". These two lists are where the aggregate lives, so
// a reader meets it: adding a key here is visibly a decision to keep exit 0 unreachable.
//
// Every reason names what WOULD settle the row and where, because in each case the remedy is off
// this machine rather than on it.

/// Rows nothing on this machine looks at. Permanently UNKNOWN — never MISSING, because "cannot
/// check" must not read as "not there" any more than it may read as "fine".
export const NEVER_CHECKED = Object.freeze({
  'nip05': 'no sockets here — settled by resolving <name>@<host>/.well-known/nostr.json',
  'profile': 'no sockets here — settled by fetching the kind 0 back BY ID from a fresh connection',
  'admit-grant': 'no sockets here — settled by cold-reading the 440 per relay, EOSE/ERROR/TIMEOUT reported separately',
  'dm-relays': 'no sockets here — settled by tools/publish-dm-relay-list.mjs, which cold-reads it back by id',
  'channel-authorized': "on the broker's disk — settled by an operator confirming the public half is seated under the forced command",
})

/// Rows this build can see but never observe DOING their job. Permanently UNVERIFIED once present —
/// which is the honest answer, and is also why it is not exit 0.
export const NEVER_VERIFIED = Object.freeze({
  'identity': 'the key is in the Bunker — settled by EXPECT_PUBKEY on a real send, not by a file being here',
  'bunker-uri': 'present is not paired — settled by asking the Bunker for the public key',
  'signer-identity': 'this tool opens no Bunker session — settled by the first send under EXPECT_PUBKEY',
  'signer-methods': 'permissions are per-method and denials are silent — settled by a decrypt round trip',
  'channel-host-key': 'present is not RIGHT — settled by StrictHostKeyChecking on first connect',
  'channel-answers': 'registered is not running — settled by an initialize + tools/list handshake',
})

/// Is this report already the best one this build can produce? True only when every row still
/// standing between it and `complete` is one of the two lists above.
///
/// Deliberately NOT a property of the outcome. `inconclusive` stays inconclusive; this says whether
/// the operator can do anything about it from here, which is the question a permanent exit 3 leaves
/// them guessing at.
export function ceilingReached({ unverified = [], unknown = [], missing = [] } = {}) {
  if (missing.length) return false
  if (!unverified.length && !unknown.length) return false
  return unknown.every(k => k in NEVER_CHECKED) && unverified.every(k => k in NEVER_VERIFIED)
}

/**
 * Build the report.
 *
 * observations: { [key]: { found: boolean, verified?: boolean, note?: string } }
 *
 * An observation with `found: true` and no `verified` is UNVERIFIED — deliberately, and this is
 * the default rather than an error, because "I saw the file" is the easy observation and "I saw
 * it work" is the one people skip. Defaulting the skipped case to `present` is how a report
 * becomes a green light for an agent nobody checked.
 */
export function installState(observations = {}, { lane = null } = {}) {
  // A lane counts as declared only if it is a string naming one we know. An unrecognised name is a
  // typo or a future lane, and neither may excuse a row: `applies` falls back to "every row
  // applies", which is the demanding answer. `--lane brokr` must not quietly become `--lane sealed`.
  //
  // `typeof === 'string'` is not belt-and-braces. `String(['sealed'])` is `'sealed'`, so without it
  // a single-element array declares a lane and scopes seven rows out — measured, not reasoned
  // about. `hasOwnProperty` rather than `in` for the same reason one layer down: `'toString'` is a
  // property of every object and would otherwise name a lane.
  const declared = typeof lane === 'string' && Object.prototype.hasOwnProperty.call(LANES, lane) ? lane : null
  // No `lanes` on a row → every lane needs it. No declared lane → every row applies, because the
  // permissive reading of silence is the one this whole module exists to refuse.
  const applies = artifact => !declared || !artifact.lanes || artifact.lanes.includes(declared)

  const rows = ARTIFACTS.map(artifact => {
    const seen = observations[artifact.key]
    // Scoped out before the observation is consulted, and deliberately so: a broker key that
    // happens to exist on a sealed-lane box has still not been asked for, and reporting it
    // `present` would put "we have it" and "we never needed it" back in the same cell.
    if (!applies(artifact)) {
      return { ...artifact, state: NOT_APPLICABLE, note: `not part of the ${declared} lane` }
    }
    // An absent observation and an explicit `found: null` both mean nobody looked. Only an
    // explicit `found: false` — someone looked and it was not there — is MISSING.
    let state
    if (!seen || seen.found === null || seen.found === undefined) state = UNKNOWN
    else if (seen.found === false) state = MISSING
    else state = seen.verified === true ? PRESENT : UNVERIFIED
    return {
      ...artifact,
      state,
      note: typeof seen?.note === 'string' ? seen.note : '',
    }
  })

  const by = state => rows.filter(r => r.state === state)
  const missing = by(MISSING)
  const unverified = by(UNVERIFIED)
  const unknown = by(UNKNOWN)
  const notApplicable = by(NOT_APPLICABLE)
  const blockingMissing = missing.filter(r => r.blocking)
  const atCeiling = ceilingReached({
    unverified: unverified.map(r => r.key), unknown: unknown.map(r => r.key), missing: missing.map(r => r.key),
  })

  // Three outcomes, mapped onto this project's exit convention. INCONCLUSIVE is not a softer
  // failure — it is the honest answer when the tool could not see enough, and it must not be
  // reachable by the same path as success.
  let outcome, exitCode, headline
  if (blockingMissing.length) {
    outcome = 'incomplete'; exitCode = 1
    headline = `${blockingMissing.length} required piece${blockingMissing.length === 1 ? '' : 's'} missing — this agent cannot run.`
  } else if (unverified.length || unknown.length) {
    outcome = 'inconclusive'; exitCode = 3
    const parts = []
    if (unverified.length) parts.push(`${unverified.length} present but unchecked`)
    if (unknown.length) parts.push(`${unknown.length} not looked at`)
    headline = `${parts.join(', ')} — being unable to check is not the same as being fine.`
    // Name the ceiling, or the sentence above reads as a local failure. It is the true sentence and
    // it is exactly the one that sends an operator hunting on a box where there is nothing to find.
    if (atCeiling) headline += ' Every remaining row is one this build never checks — exit 3 is the best result available here, and the remedy for each is off this machine.'
  } else if (missing.length) {
    outcome = 'runs-unfinished'; exitCode = 3
    headline = `Runs, but ${missing.length} non-blocking piece${missing.length === 1 ? ' is' : 's are'} absent — it works and has no name.`
  } else {
    outcome = 'complete'; exitCode = 0
    headline = 'Every piece present and observed doing its job.'
  }
  // Say out loud how many rows were scoped out, and by which lane. A report that quietly stops
  // asking about seven artifacts is the same shape as a report that quietly passes them — the
  // reader cannot tell the two apart unless the count is on the page.
  if (notApplicable.length) {
    headline += ` ${notApplicable.length} row${notApplicable.length === 1 ? '' : 's'} did not apply to the ${declared} lane and ${notApplicable.length === 1 ? 'was' : 'were'} not checked — that is not the same as satisfied.`
  }

  return {
    outcome, exitCode, headline, rows, atCeiling, lane: declared,
    counts: {
      present: by(PRESENT).length, unverified: unverified.length,
      missing: missing.length, unknown: unknown.length, notApplicable: notApplicable.length,
    },
    missing: missing.map(r => r.key),
    unverified: unverified.map(r => r.key),
    unknown: unknown.map(r => r.key),
    notApplicable: notApplicable.map(r => r.key),
  }
}

// Which OTHER nvoy MCP servers is this session carrying? (#380)
//
// The failure in #338 was not a missing server. It was a present one: alongside the correctly
// instance-bound `nvoy-<name>` sat a generically-named `nvoy`, hard-wired to one identity's
// credential files — and that is the server holding every tool that SIGNS. The instance-bound
// path cannot act; the acting path is not instance-bound. No server is both, so the
// default-looking choice is the unsafe one and an agent passes Bind while holding fifteen tools
// pointed at a teammate.
//
// Checking that `nvoy-<name>` exists cannot catch that, because it was there. The question is
// whether anything ELSE named nvoy is also there.
//
// Pure by design, like the rest of this module: it takes the text `claude mcp list` printed and
// returns names. Passing `null` — the tool could not be run — must reach the UNKNOWN path, never
// an empty array, because "nothing conflicting" and "I could not look" are the two things this
// whole module exists to keep apart.
//
// The name test and the parse both live in src/mcp_runtimes.mjs now, so Claude Code and Codex
// cannot answer this question differently, and neither of them can miss `nvoy_other` the way the
// hyphen-only test here did (#464). This is the `claude mcp list` adapter over them, kept because
// it is the shape the suite and the tool already speak.
export function foreignNvoyServers(listOutput, name) {
  if (typeof listOutput !== 'string') return null
  return foreignServers(parseClaudeList(listOutput), name)
}

// Does the registered MCP server answer as the agent we just minted? (#338)
//
// This is the MCP path's `EXPECT_PUBKEY`. `nvoy_whoami` returns `{ npub, pubkey, relays, metadata }`
// (nvoy `mcp/src/app.ts`); the operator captures that and hands it here, because this repo's checker
// opens no sockets and the channel server holds its own lock.
//
// Three answers, and the third is the one that matters. `null` — nobody looked, or nobody said what
// to expect — must NEVER be reachable by the same path as `true`. The failure this exists to catch
// is a guard that passes because the comparison was never supplied: that is precisely how a session
// ran for a day answering as somebody else.
//
// Pure, and both arguments are untrusted text. Returns the resolved key alongside the verdict so a
// PASS can print WHO it matched — a guard that passes in silence is indistinguishable from a guard
// that is not there.
export function boundIdentity(whoamiOutput, expected) {
  const unknown = reason => ({ match: null, resolved: null, reason })
  if (typeof whoamiOutput !== 'string' || whoamiOutput.trim() === '') return unknown('nothing captured from the server — INCONCLUSIVE, not absent')

  const want = normalizeKey(expected)
  // Deliberately checked BEFORE parsing. With no expectation there is no comparison to make, and
  // reporting "the server answered" as a pass is the whole defect.
  if (!want) {
    return unknown(malformedNpub(expected)
      ? 'the expected key is an npub that does not decode — INCONCLUSIVE, a garbled value rather than a different identity'
      : 'no expected key given, so there is nothing to compare against')
  }

  const resolved = whoamiPubkey(whoamiOutput)
  if (!resolved) {
    return unknown(malformedNpub(whoamiRawKey(whoamiOutput))
      ? 'the captured output holds an npub that does not decode — INCONCLUSIVE, a garbled capture rather than a different identity'
      : 'no identity found in the captured output — check it is the whole `nvoy_whoami` result')
  }

  return resolved === want
    ? { match: true, resolved, reason: `answers as ${resolved.slice(0, 12)}…, which is the minted key` }
    : { match: false, resolved, reason: `answers as ${resolved.slice(0, 12)}…, NOT the minted ${want.slice(0, 12)}… — this session would sign as someone else` }
}

// npub or 64-hex in, lowercase hex out, or null.
//
// `nip19.decode`, not a hand-rolled base32 walk. The hand-rolled one read `v.slice(5, -6)` and
// never looked at the six characters it discarded — so the only part of a bech32 string that can
// detect corruption was the only part it threw away. Flip one checksum character and a string the
// standard decoder refuses outright decoded to a clean 32 bytes and was reported as a MATCH, by the
// guard whose entire job is to refuse what it cannot vouch for (#451 review).
//
// The defence for hand-rolling was that this module takes no runtime dependency. It does not hold:
// `src/nostr_signer.mjs` and `src/buzz_policy_core.mjs` already import nip19, `nostr-tools` is a
// direct dependency, and `nip19.decode` opens nothing — the module stays pure. The house precedent
// is `tools/publish-dm-relay-list.mjs`, which normalizes the same value the same way for the same
// job; the hand-rolled version was strictly weaker than the guard it was modelled on.
function normalizeKey(value) {
  const v = String(value ?? '').trim().toLowerCase()
  if (/^[0-9a-f]{64}$/.test(v)) return v
  if (!v.startsWith('npub1')) return null
  try {
    const { type, data } = nip19.decode(v)
    return type === 'npub' && /^[0-9a-f]{64}$/.test(data) ? data : null
  } catch { return null }   // bad checksum, wrong length, not bech32 at all — all refused
}

// An npub-shaped string that does not decode is a GARBLED CAPTURE, not somebody else's key, and the
// two need different words. Corrupting the data part used to produce "answers as …, NOT the minted
// … — this session would sign as someone else", which sends the operator hunting for an impostor
// when one character got mangled between two clipboards. Assert the reason, not only the refusal.
function malformedNpub(value) {
  const v = String(value ?? '').trim().toLowerCase()
  return v.startsWith('npub1') && normalizeKey(v) === null
}

// The JSON field first, because it is the contract. The loose scan is a fallback for output that
// has been reformatted by a client on its way to the operator's clipboard — a real path, since a
// human is carrying this between two tools.
function whoamiPubkey(text) {
  try {
    const found = pickKey(JSON.parse(text))
    if (found) return found
  } catch { /* not JSON, or wrapped in a client's own envelope — fall through */ }
  const m = /"(?:pubkey|npub)"\s*:\s*"([^"]+)"/.exec(text) || /\b(npub1[023456789acdefghjklmnpqrstuvwxyz]{58})\b/.exec(text)
  return m ? normalizeKey(m[1]) : null
}

// The raw token `whoamiPubkey` WOULD have used, before normalization — diagnosis only, never a
// return value. It is what lets a null answer say WHICH null: nothing key-shaped in the capture at
// all, or an npub-shaped string that does not decode. The npub pattern here is deliberately looser
// than the one above, because a truncated or over-long npub is exactly the garbling being reported.
function whoamiRawKey(text) {
  if (typeof text !== 'string') return null
  const m = /"(?:pubkey|npub)"\s*:\s*"([^"]+)"/.exec(text) || /\bnpub1[023456789acdefghjklmnpqrstuvwxyz]{6,}\b/.exec(text)
  return m ? (m[1] ?? m[0]) : null
}

// MCP results arrive wrapped — `{content:[{type:'text',text:'{…}'}]}` — so walk into strings too.
function pickKey(value, depth = 0) {
  if (depth > 6) return null
  if (typeof value === 'string') { try { return pickKey(JSON.parse(value), depth + 1) } catch { return null } }
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) { for (const v of value) { const f = pickKey(v, depth + 1); if (f) return f } return null }
  const direct = normalizeKey(value.pubkey) || normalizeKey(value.npub)
  if (direct) return direct
  for (const v of Object.values(value)) { const f = pickKey(v, depth + 1); if (f) return f }
  return null
}

// Render for a terminal. Kept here rather than in the CLI so the suite can assert that an
// unverified row never prints as a tick — the single most likely way this report lies.
export function renderState(report, { width = 34 } = {}) {
  // UNKNOWN gets its own glyph. Sharing one with MISSING would put "nobody looked" and "it is not
  // there" back into the same cell, which is the distinction this report exists to keep. Same
  // reasoning for NOT_APPLICABLE: it is emphatically not `ok`, and a reader scanning the left
  // column for ticks must not find one on a row nobody asked about.
  const mark = { [PRESENT]: 'ok ', [UNVERIFIED]: ' ? ', [MISSING]: ' x ', [UNKNOWN]: ' - ', [NOT_APPLICABLE]: 'n/a' }
  const lines = report.rows.map(r =>
    `[${mark[r.state]}] ${r.title.padEnd(width)} ${r.state === PRESENT ? '' : r.state.toUpperCase()}${r.note ? `  — ${r.note}` : ''}`.trimEnd())
  return [...lines, '', report.headline].join('\n')
}
