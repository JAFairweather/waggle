// channel_registration.mjs — the MCP registration an agent is told to write (#472).
//
// `connect-agent.mjs` used to emit a local `claude-channel.mjs` spawn. That is the shape the MCP
// cutover retired, and it is no longer how an identity reaches its channel: the broker runs on a
// host, and the registration is an `ssh` invocation to it. Measured on the maintainer's machine the
// day this was written — the one identity registered in the ssh form answered a live handshake, and
// the two registered in the local form did not reach their identity at all.
//
// Why that mattered more than a stale example: a local entry does not fail loudly. It spawns, it
// answers `initialize`, and `claude mcp list` prints ✔ Connected — while the identity's real channel
// is somewhere else entirely. An agent following the retired stanza lands in a state that looks
// healthy from every angle it can see. **Connected is not attached**, and it is not "pointed at the
// right thing" either.
//
// Nothing here writes to an operator's config. This builds the exact command and the tool prints it.

/**
 * The invocation, in one ordered piece, with the two per-agent paths as placeholders.
 *
 * Order matches a live working registration exactly. ssh does not care where an `-o` sits; a person
 * diffing their own entry against this one does, and "the flags are all there, somewhere" is a
 * harder thing to check than an empty diff.
 *
 * Every flag is a refusal, not a preference — this is a credential-bearing connection to a
 * production host, and a stanza that drops one fails open:
 *
 *   -F /dev/null                 ignore the user's ssh_config. Whatever is in it, it was not written
 *                                for this principal, and a ProxyCommand or a wildcard Host block
 *                                would silently redirect a channel that must go exactly one place.
 *   -T                           no pty. This is a pipe carrying MCP JSON, and a pty mangles it.
 *   BatchMode=yes                never prompt. An MCP server spawned by a runtime has no terminal;
 *                                a password prompt there is a hang with no error, which is the
 *                                worst failure shape this project has.
 *   IdentitiesOnly=yes           offer ONLY the key named by -i. Without it ssh offers every key the
 *                                agent holds, so the connection can succeed as the wrong principal.
 *   StrictHostKeyChecking=yes    refuse an unknown host rather than trusting it on first sight.
 *   UserKnownHostsFile=…         this principal's own trust store, not the user's.
 *   GlobalKnownHostsFile=/dev/null  the system file is not this principal's trust store either.
 *   ClearAllForwardings=yes      no tunnels. The channel is a pipe, not a network path.
 */
export const SSH_TEMPLATE = Object.freeze([
  '-F', '/dev/null', '-T',
  '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'StrictHostKeyChecking=yes',
  '-o', 'UserKnownHostsFile=%KNOWN_HOSTS%',
  '-o', 'GlobalKnownHostsFile=/dev/null',
  '-o', 'ClearAllForwardings=yes',
  '-i', '%KEY%',
  '%TARGET%',
])

export const SSH_BIN = '/usr/bin/ssh'
const CRED_DIR = 'credentials'
export const KEY_FILE = 'claude-channel-ssh'
export const KNOWN_HOSTS_FILE = 'claude-channel-known-hosts'

// A hostname, not a URL and not an IP. Refusing a scheme is worth doing explicitly: `wss://nave.pub`
// is the kind of value that gets pasted in from the relay config next to it, and ssh would take it
// as a hostname and fail with a resolution error that names nothing useful.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/** Where this agent's channel credentials live. Paths only — never the contents of either. */
export function credentialPaths(instanceRoot) {
  if (!instanceRoot) throw new Error('credentialPaths needs the instance root')
  const root = String(instanceRoot).replace(/\/+$/, '')
  return { keyPath: `${root}/${CRED_DIR}/${KEY_FILE}`, knownHostsPath: `${root}/${CRED_DIR}/${KNOWN_HOSTS_FILE}` }
}

/**
 * Build the registration command for one agent's channel.
 *
 * Throws rather than defaulting when the host is missing. A stanza that points nowhere is worse than
 * no stanza: the operator writes it, the runtime reports it registered, and it fails at spawn with
 * no explanation. There is no sensible default here — the host is deployment state and this repo is
 * public.
 */
export function channelCommand({ instanceRoot, host, user = 'root' }) {
  if (!host) {
    throw new Error('no channel host — pass --channel-host <host>. There is no default: the host is deployment state, and a stanza pointing nowhere registers cleanly and fails at spawn')
  }
  if (/:\/\//.test(String(host))) {
    throw new Error(`channel host "${host}" is a URL — ssh needs a bare hostname, not a scheme`)
  }
  if (!HOSTNAME.test(String(host))) {
    throw new Error(`channel host "${host}" is not a hostname`)
  }
  if (!/^[a-z_][a-z0-9_-]*$/i.test(String(user))) throw new Error(`channel user "${user}" is not a username`)
  const { keyPath, knownHostsPath } = credentialPaths(instanceRoot)
  const fill = { '%KNOWN_HOSTS%': knownHostsPath, '%KEY%': keyPath, '%TARGET%': `${user}@${host}` }
  const args = SSH_TEMPLATE.map(a => (a in fill ? fill[a] : a.replace(/%[A-Z_]+%/g, m => fill[m] ?? m)))
  // A placeholder that survives substitution becomes a literal path named `%KEY%`, and ssh would
  // report that as an ordinary missing-file error pointing at a file nobody ever meant to create.
  // Cheap to check, and the alternative is a stanza that is wrong in a way that reads as an
  // environment problem.
  const stray = args.find(a => /%[A-Z_]+%/.test(a))
  if (stray) throw new Error(`unsubstituted placeholder in ssh stanza: ${stray}`)
  return { command: SSH_BIN, args, keyPath, knownHostsPath, target: fill['%TARGET%'] }
}

/**
 * Are the credentials this stanza names actually here?
 *
 * `exists` is injected so this is testable without a filesystem, and so the caller keeps the one
 * decision this module must not make: what to do about it. Returns the missing files BY NAME —
 * "credentials missing" sends an operator to look at both, and on the machine that prompted this
 * issue two identities were registered in the retired local form for exactly this reason: they had
 * no keypair, so nobody could have written the ssh form for them even knowing it was correct.
 */
export function credentialReport({ instanceRoot, exists }) {
  if (typeof exists !== 'function') throw new Error('credentialReport needs an exists() probe')
  const { keyPath, knownHostsPath } = credentialPaths(instanceRoot)
  const missing = []
  if (!exists(keyPath)) missing.push(KEY_FILE)
  if (!exists(knownHostsPath)) missing.push(KNOWN_HOSTS_FILE)
  return {
    ok: missing.length === 0,
    missing,
    keyPath,
    knownHostsPath,
    note: missing.length
      ? `${missing.join(' and ')} absent under ${instanceRoot}/${CRED_DIR} — this stanza names ${missing.length === 1 ? 'a file' : 'files'} that ${missing.length === 1 ? 'does' : 'do'} not exist, so the server would fail at spawn. Minting them is the operator's step, not this tool's.`
      : 'channel credentials present',
  }
}

/**
 * Is a registration the retired local form?
 *
 * Reported separately from "not registered" on purpose. An operator whose entry spawns
 * `claude-channel.mjs` locally sees ✔ Connected and has no reason to look further — the install
 * report is the only surface that can tell them the entry is pointed at a runtime that no longer
 * holds their identity. Collapsing this into "registered" is how that goes unnoticed.
 */
export function isRetiredLocalForm(entry) {
  if (!entry) return false
  const text = typeof entry === 'string' ? entry : `${entry.command || ''} ${(entry.args || []).join(' ')}`
  if (!text.trim()) return false
  // The COMMAND, not the whole line. The ssh form names `claude-channel-ssh` in its own arguments,
  // so a substring test for "ssh" anywhere would clear a local entry that happened to mention the
  // key file, and — worse — a bare `\bssh\b` over the line is exactly the check that would have
  // called the working stanza local had the key been named differently.
  const command = typeof entry === 'string' ? String(entry).trim().split(/\s+/)[0] : String(entry.command || '')
  if (/(^|\/)ssh$/.test(command)) return false
  return /claude-channel\.mjs/.test(text)
}

/**
 * Does the registration a runtime is reporting match the vector we would build?
 *
 * Form is not correctness. `registeredForm` answers "is this an ssh call"; it cannot answer "is it
 * an ssh call to the right place". An entry pointing at a previous broker host, or at another
 * identity's key file, is in the ssh form, connects, and looks healthy — which is #472's whole
 * failure class one layer over.
 *
 * Returns `null` when the comparison could not be made at all, so a caller can keep "they differ"
 * apart from "nothing was compared". Collapsing those is how a check that never ran reads as a pass.
 */
export function sameVector(stdout, server, expectedArgs) {
  if (!Array.isArray(expectedArgs) || expectedArgs.length === 0) return null
  if (typeof stdout !== 'string' || !server) return null
  let actual = null
  try {
    const parsed = JSON.parse(stdout)
    if (Array.isArray(parsed)) {
      const e = parsed.find(x => x && x.name === server)
      if (e && Array.isArray(e.args)) actual = e.args.map(String)
    }
  } catch { /* not JSON — the text listing below */ }
  if (!actual) {
    const line = stdout.split('\n').map(l => l.trim()).find(l => l.startsWith(`${server}:`))
    if (!line) return null
    // `<server>: <command> <args…> - <status>`. Drop the command, and drop the status suffix — here
    // it DOES have to go, because a trailing `- ✔ Connected` would be compared as two more args.
    // ` - ` with spaces both sides never occurs inside these flags; `-F`, `-T` and `-o` have none.
    const rest = line.slice(server.length + 1).trim().replace(/\s+-\s+\S.*$/, '')
    const parts = rest.split(/\s+/).filter(Boolean)
    // A first token that starts with `-` is not a command, so this line is not the shape assumed
    // and dropping parts[0] would silently compare a vector against itself minus its first flag.
    // That is a wrong answer dressed as a real one; null is the honest reading.
    if (parts.length < 2 || parts[0].startsWith('-')) return null
    actual = parts.slice(1)
  }
  return JSON.stringify(actual) === JSON.stringify(expectedArgs.map(String))
}

/**
 * Which form is this agent registered in — `'ssh'`, `'local'`, or `'unknown'`?
 *
 * Reads the runtime's own listing rather than a config file, because the listing is what the
 * operator sees and what `--check` already has in hand. Claude Code prints
 * `<server>: <command…> - <status>`; Codex prints JSON. Both branches are explicit and a shape
 * neither one recognises is `'unknown'` — never `'ssh'`, which is the answer that would let a
 * retired entry pass as healthy.
 *
 * `'unknown'` is also the honest answer for a server that is registered but whose command could not
 * be read. UNVERIFIED, not fine.
 */
export function registeredForm(stdout, server) {
  if (typeof stdout !== 'string' || !server) return 'unknown'
  let entry = null
  try {
    const parsed = JSON.parse(stdout)
    if (Array.isArray(parsed)) entry = parsed.find(e => e && e.name === server) || null
  } catch { /* not JSON — fall through to the text listing below */ }
  if (!entry) {
    // The status suffix is left on deliberately. Nothing below reads past the first token except
    // the `claude-channel.mjs` test, and stripping ` - ✔ Connected` is one more thing to get wrong
    // on a path that happens to contain a spaced hyphen.
    const line = stdout.split('\n').map(l => l.trim()).find(l => l.startsWith(`${server}:`))
    if (!line) return 'unknown'
    entry = line.slice(server.length + 1).trim()
    if (!entry) return 'unknown'
  }
  if (isRetiredLocalForm(entry)) return 'local'
  const command = typeof entry === 'string' ? entry.trim().split(/\s+/)[0] : String(entry.command || '')
  return /(^|\/)ssh$/.test(command) ? 'ssh' : 'unknown'
}
