// agent_install_state.mjs — what does this agent still need, and what is merely CLAIMED to be done?
//
// Seating an agent produces thirteen artifacts across two machines, three checkouts and a public
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
// hard to produce on a real machine.

export const PRESENT = 'present'
export const UNVERIFIED = 'unverified'
export const MISSING = 'missing'
export const UNKNOWN = 'unknown'

// The artifacts, in the order they must be satisfied. `blocking` marks the ones without which the
// agent cannot function at all — as opposed to the ones without which it merely has no name.
// Both matter; conflating them is how "it works" and "it is finished" became the same claim.
export const ARTIFACTS = [
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
  { key: 'manifest', title: 'Runtime manifest', blocking: true,
    why: 'Six tools read it and none write it. Every field is validated; one bad field refuses the whole runtime.' },
  { key: 'state-dirs', title: 'Runtime directories', blocking: true,
    why: 'Five of them, two with non-default modes. Nothing creates them and nothing lists them.' },
  { key: 'channel-key', title: 'Channel keypair', blocking: true,
    why: 'The MCP channel transport.' },
  { key: 'mcp-registration', title: 'Registered as an MCP server', blocking: true,
    why: 'How a new session becomes this agent. Needs the instance root set explicitly; the default path does not exist here.' },
  { key: 'channel-answers', title: 'Channel server answers', blocking: true,
    why: 'Registered is not running. Proven by initialize + tools/list, not by the registration existing.' },
]

export const ARTIFACT_KEYS = ARTIFACTS.map(a => a.key)

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
export function installState(observations = {}) {
  const rows = ARTIFACTS.map(artifact => {
    const seen = observations[artifact.key]
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
  const blockingMissing = missing.filter(r => r.blocking)

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
  } else if (missing.length) {
    outcome = 'runs-unfinished'; exitCode = 3
    headline = `Runs, but ${missing.length} non-blocking piece${missing.length === 1 ? ' is' : 's are'} absent — it works and has no name.`
  } else {
    outcome = 'complete'; exitCode = 0
    headline = 'Every piece present and observed doing its job.'
  }

  return {
    outcome, exitCode, headline, rows,
    counts: { present: by(PRESENT).length, unverified: unverified.length, missing: missing.length, unknown: unknown.length },
    missing: missing.map(r => r.key),
    unverified: unverified.map(r => r.key),
    unknown: unknown.map(r => r.key),
  }
}

// Render for a terminal. Kept here rather than in the CLI so the suite can assert that an
// unverified row never prints as a tick — the single most likely way this report lies.
export function renderState(report, { width = 34 } = {}) {
  // UNKNOWN gets its own glyph. Sharing one with MISSING would put "nobody looked" and "it is not
  // there" back into the same cell, which is the distinction this report exists to keep.
  const mark = { [PRESENT]: 'ok ', [UNVERIFIED]: ' ? ', [MISSING]: ' x ', [UNKNOWN]: ' - ' }
  const lines = report.rows.map(r =>
    `[${mark[r.state]}] ${r.title.padEnd(width)} ${r.state === PRESENT ? '' : r.state.toUpperCase()}${r.note ? `  — ${r.note}` : ''}`.trimEnd())
  return [...lines, '', report.headline].join('\n')
}
