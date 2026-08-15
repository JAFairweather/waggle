// mcp_runtimes.mjs — the MCP channel, described once and rendered per host runtime (#464, #333 §1).
//
// `tools/connect-agent.mjs` used to shell out to `claude mcp list` and, on failure, print
// `claude mcp add`. On a Codex box or a Pi that `catch` fires every time and reports INCONCLUSIVE
// forever: correct, and permanently useless. MCP is the standard; only the registration syntax
// differs. So the server is described once — command, args, env — and each runtime renders it.
//
// Everything here is pure. The subprocess lives in the CLI, so the suite drives the parsers with
// captured output instead of the operator's real config.
//
// What was RUN rather than assumed, on 2026-08-14:
//   claude mcp list                                        → `<server>: <command…> - <status>`
//   codex  mcp list --json                                 → [{name, command, args, env}, …]
//   codex  mcp add <n> --env K=V -- <cmd> <args…>          → lands with command/args/env split
//   gemini mcp                                             → `Unknown argument: mcp`
// That last one is why Gemini is described as file-configured and NOT given an add one-liner. A
// newer build may grow the subcommand; emitting it before someone has run it would be exactly the
// drifted instruction this module exists to remove.

// The prefix every nvoy channel server shares. Anything carrying it can sign.
const NVOY = 'nvoy'

// Both separators, because both are in use. `nvoy-mc-claude` is what connect-agent prints;
// `nvoy_codex_jaf` is what is registered on this machine today. The guard that only knew the
// hyphen reported `nvoy-<name> is the only nvoy server registered` with the other one beside it.
const SEP = /^[-_]$/

/** Is this server name an nvoy channel at all? `nvoy`, `nvoy-…`, `nvoy_…`, any case. */
export function isNvoyServer(name) {
  const s = String(name || '').toLowerCase()
  if (s === NVOY) return true
  return s.startsWith(NVOY) && SEP.test(s.charAt(NVOY.length))
}

/**
 * Is this server THIS agent's own channel?
 *
 * Deliberately strict: the name after the separator must equal the agent's name exactly. It would
 * be tidier to fold `-` and `_` inside the name too, so that `nvoy_mc_claude` counted as agent
 * `mc-claude` — but `a-b` and `a_b` are both legal agent names, and folding them makes a foreign
 * channel read as your own. A guard errs toward flagging. The cost of being wrong here is one
 * line telling the operator about a server they recognise; the cost the other way is #338.
 */
export function isMine(name, agent) {
  const s = String(name || '').toLowerCase()
  const a = String(agent || '').toLowerCase()
  if (!a) return false
  return s === `${NVOY}-${a}` || s === `${NVOY}_${a}`
}

/** Every nvoy server in `names` that is not this agent's own. Order preserved, deduped. */
export function foreignServers(names, agent) {
  if (!Array.isArray(names)) return null
  const out = []
  for (const n of names) {
    const s = String(n || '').toLowerCase()
    if (!isNvoyServer(s) || isMine(s, agent)) continue
    if (!out.includes(s)) out.push(s)
  }
  return out
}

/**
 * The `mcp-exclusive` verdict — the row that stops this session signing as another identity (#338).
 *
 * It lives here rather than inline in `connect-agent.mjs` because the defect it exists to prevent
 * was invisible from the altitude the tests were written at. The tool consulted only the runtimes
 * that ANSWERED, so "Codex is installed but returned nothing readable" left a green tick: a place
 * nobody looked, reported as clean. A subprocess harness is the only way to reach an inline
 * expression, and this suite deliberately opens none — so the decision is a function instead, and
 * all four states can be asserted directly.
 *
 * The asymmetry is deliberate. An unread runtime cannot promote this row to `true`, but it must not
 * demote a foreign server that WAS found back to UNKNOWN: a positive detection stands on its own,
 * and an unasked runtime does not un-find it — it only means there may be more.
 *
 * @param {Array|null} foreign  foreign nvoy servers across the runtimes that answered; null if none did
 * @param {number} unreadable   how many runtimes are installed but could not be read
 * @returns {{found: boolean|null, verified: boolean}}  `found: null` is UNKNOWN, and is never a pass
 */
export function exclusivityVerdict(foreign, unreadable = 0) {
  if (foreign === null) return { found: null, verified: false }
  if (foreign.length) return { found: false, verified: false }
  if (unreadable > 0) return { found: null, verified: false }
  return { found: true, verified: true }
}

// ── Parsers. Each returns an array of server names, or null for "could not read this".
// null is not []. `[]` means the runtime answered and has nothing registered; null means nobody
// looked, and those two must never share a cell — the whole four-state report rests on it.

/**
 * `claude mcp list` prints `<server>: <command…> - <status>`. Take only the name.
 *
 * ALLOWLIST, not denylist. The previous version took anything before a colon, which meant a line
 * this parser had never seen still produced an answer: `Error: unable to read config` parsed as a
 * server called `Error`, and output with no colons at all — a stack trace, a permissions failure,
 * a future format — parsed as `[]`. `[]` is the value that says "the runtime answered and has
 * nothing registered", so `mcp-exclusive` printed a verified tick off a list it had never read.
 * That is the one row in this report where failing open is a security answer rather than a
 * cosmetic one (#464 review).
 *
 * Now every non-blank line must be recognised or the whole read is null. A format change surfaces
 * as INCONCLUSIVE, which is the correct direction to be wrong in and the reason the four-state
 * report exists at all.
 */
const CLAUDE_ENTRY = /^([A-Za-z0-9._-]+):\s+\S.*\s-\s+\S/
const CLAUDE_EMPTY = /^No MCP servers configured\b/
// Progress chatter the CLI prints around the list. Matched exactly rather than skipped loosely:
// "any line that is not an entry" is how the old parser got here.
const CLAUDE_NOISE = /^(Checking MCP server health|MCP servers?:)/

export function parseClaudeList(stdout) {
  if (typeof stdout !== 'string') return null
  // A command that prints nothing has told you nothing. Blank stdout is not an empty list.
  if (!stdout.trim()) return null
  const names = []
  let sawEmpty = false
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (CLAUDE_EMPTY.test(line)) { sawEmpty = true; continue }
    if (CLAUDE_NOISE.test(line)) continue
    const m = CLAUDE_ENTRY.exec(line)
    if (!m) return null
    if (!names.includes(m[1])) names.push(m[1])
  }
  // "No MCP servers configured." alongside entries is a contradiction, not a list.
  if (sawEmpty && names.length) return null
  return names
}

/**
 * `codex mcp list --json` prints `[{name, command, args, env}, …]`.
 *
 * The plain table is fixed-width and wraps a full environment block into the name column, so it is
 * not parseable by anything that should be trusted. Ask for JSON and refuse the rest: a parse
 * failure here is INCONCLUSIVE, never "nothing registered".
 */
export function parseCodexJson(stdout) {
  if (typeof stdout !== 'string') return null
  let parsed
  try { parsed = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(parsed)) return null
  const names = []
  for (const e of parsed) {
    const n = e && typeof e.name === 'string' ? e.name : null
    if (n && !names.includes(n)) names.push(n)
  }
  return names
}

// ── The runtimes.

/**
 * Shell-quote one token of a command line the operator is meant to paste (#464 review).
 *
 * `.join(' ')` produced a line that BREAKS RATHER THAN FAILS on a path containing a space, which
 * on macOS is an ordinary home directory (`/Users/x/My Drive/…`). Pasted, it registers a server
 * with the wrong argv and reports success, and the operator's next signal is a channel that will
 * not connect for a reason nothing on screen names.
 *
 * Bare when the token is unambiguous, single-quoted otherwise, with the standard `'\''` escape so
 * a token containing a quote survives too.
 */
const shq = value => {
  const token = String(value ?? '')
  if (token === '') return "''"
  return /^[A-Za-z0-9._:=@/-]+$/.test(token) ? token : `'${token.replace(/'/g, "'\\''")}'`
}

export const RUNTIMES = [
  {
    id: 'claude',
    label: 'Claude Code',
    kind: 'cli',
    startupFile: 'CLAUDE.md',
    bin: 'claude',
    listArgs: ['mcp', 'list'],
    parse: parseClaudeList,
    add: ({ server, command, args, env }) =>
      ['claude', 'mcp', 'add', shq(server), '-s', 'user',
        ...Object.entries(env).flatMap(([k, v]) => ['-e', shq(`${k}=${v}`)]),
        '--', shq(command), ...args.map(shq)].join(' '),
    remove: server => `claude mcp remove ${shq(server)}`,
    // A registered server that the real channel already holds the lock on reports "Failed to
    // connect" here. That is expected and is not a registration fault.
    listCaveat: '"Failed to connect" in this list is EXPECTED while the real channel holds the lock',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    kind: 'cli',
    startupFile: 'AGENTS.md',
    bin: 'codex',
    listArgs: ['mcp', 'list', '--json'],
    parse: parseCodexJson,
    add: ({ server, command, args, env }) =>
      ['codex', 'mcp', 'add', shq(server),
        ...Object.entries(env).flatMap(([k, v]) => ['--env', shq(`${k}=${v}`)]),
        '--', shq(command), ...args.map(shq)].join(' '),
    remove: server => `codex mcp remove ${shq(server)}`,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    kind: 'file',
    startupFile: 'GEMINI.md',
    // Documentation-derived, not executed: this repo has confirmed the CLI has no `mcp`
    // subcommand, and nothing more. The stanza is what to write; whether the runtime read it is
    // proven by a handshake in the session, not by this file existing.
    config: '~/.gemini/settings.json',
    configKey: 'mcpServers',
  },
  // THE RUNTIME WITH NO MCP (#519). Pi is the agent harness at pi.dev, not a board — and this repo
  // read its own `generic` label as hardware while planning the #486 walk, which is why that label
  // no longer says it.
  //
  // `kind: 'none'` exists because the other two kinds both end in "here is how you register the MCP
  // server", and for Pi that answer is false. Its docs say there is no built-in MCP and say what to
  // do instead: build CLI tools with READMEs, or write an extension. Rendering it as `file` would
  // print an `mcpServers` stanza under a label, and a stanza under a label is an instruction —
  // pointing an operator at a config file that does not exist, for a subsystem the runtime does not
  // have. A registry that cannot say "no MCP here" says the wrong thing confidently instead.
  //
  // The participation surface is the two tools this repo already ships, which is not a downgrade:
  // both authenticate by SIGNATURE through `loadNostrSigner`, so neither needs a broker, an ssh
  // account or a seated key, and neither ever holds one.
  {
    id: 'pi',
    label: 'Pi (pi.dev)',
    kind: 'none',
    // Same filename as Codex, DIFFERENT search path: Pi loads it from `~/.pi/agent/`, from parent
    // directories, and from the current directory. `--startup` prints the path it wrote for exactly
    // this reason — a file at the wrong one of those is a file nothing reads, and it looks identical
    // to a file that was read.
    startupFile: 'AGENTS.md',
    instead: 'no MCP — Pi has none built in. Participation is the two CLI tools: ' +
      '`tools/agent-inbox.mjs --watch` to listen, `tools/agent-send.mjs` to speak. ' +
      'Both sign through `loadNostrSigner`, so a bunker-held identity works with no nsec anywhere.',
    // "Point your runtime at this directory" is not actionable for a runtime with three search
    // locations, and the failure it hides is silent: a file at the wrong one of them is a file
    // nothing reads, and the session looks exactly like one that read it and ignored it. So say the
    // three, and say which act puts the file in reach of each.
    startupNote: 'Pi loads AGENTS.md from ~/.pi/agent/, from parent directories, and from the ' +
      'current directory — so either start the session with this directory as its cwd, or place ' +
      'the file in ~/.pi/agent/. A file in none of those is read by nothing, and looks identical ' +
      'to one that was read.',
  },
  {
    id: 'generic',
    // Was "Raspberry Pi, headless, self-hosted". The board was an example of a headless MCP host and
    // is still a fine one; the word is gone because in this repo Pi now names the harness above, and
    // an operator picking a runtime by its label is the person that ambiguity costs.
    label: 'Any other MCP host (headless, self-hosted)',
    kind: 'file',
    // AGENTS.md is the cross-tool convention; a host that reads something else is pointed at it
    // by hand, which is why --startup prints the path it wrote rather than assuming it was read.
    startupFile: 'AGENTS.md',
    config: 'the host\'s own MCP config',
    configKey: 'mcpServers',
  },
]

export const cliRuntimes = () => RUNTIMES.filter(r => r.kind === 'cli')
export const fileRuntimes = () => RUNTIMES.filter(r => r.kind === 'file')
export const runtime = id => RUNTIMES.find(r => r.id === id) || null

/**
 * The server, described once. `server` is the registered name; `command`/`args` launch the
 * channel; `env` carries `NVOY_INSTANCE_ROOT`.
 *
 * Nothing secret goes in here and nothing secret may be added: this object is rendered into a
 * paste block and into an operator's config file. Paths and public values only.
 */
export function channelStanza({ agent, command, args = [], instanceRoot, verbatim = false }) {
  const a = String(agent || '').toLowerCase()
  if (!a) throw new Error('channelStanza needs an agent name')
  if (!command) throw new Error('channelStanza needs the command that launches the channel')
  // `verbatim` is for the ssh form (#472), and both halves of it are load-bearing.
  //
  // `--instance` after an ssh target is not an argument to anything local — everything past the
  // target is the REMOTE command. On a forced-command entry it lands in `SSH_ORIGINAL_COMMAND`;
  // without one, ssh tries to exec `--instance <agent>` on the broker. The instance is selected by
  // which key authenticates, not by a flag.
  //
  // `env` is set in the LOCAL process. ssh does not forward it — no `SendEnv` here — so
  // `NVOY_INSTANCE_ROOT` reaches nothing on the far side and only makes the stanza differ from the
  // registration that actually works.
  //
  // The live `nvoy-mc-claude` entry carries neither: 18 args ending at the target, and `env: {}`.
  if (verbatim) return { server: `${NVOY}-${a}`, command: String(command), args: args.map(String), env: {} }
  return {
    server: `${NVOY}-${a}`,
    command: String(command),
    args: [...args.map(String), '--instance', a],
    env: { NVOY_INSTANCE_ROOT: String(instanceRoot || '') },
  }
}

/** The neutral form every MCP host understands, as it goes into a config file. */
export function stanzaJson(stanza) {
  return JSON.stringify({
    mcpServers: {
      [stanza.server]: { command: stanza.command, args: stanza.args, env: stanza.env },
    },
  }, null, 2)
}

/**
 * What to tell the operator, per runtime. A CLI runtime gets its one-liner; a file runtime gets
 * the path and the JSON. Both name the runtime, because "run this" with no label is how a Codex
 * operator ends up typing a Claude Code command.
 */
export function registrationHelp(stanza) {
  return RUNTIMES.map(r => {
    if (r.kind === 'cli') return { id: r.id, label: r.label, kind: 'cli', line: r.add(stanza) }
    // A runtime with no MCP gets neither a command nor a stanza — it gets told so, by name. It is
    // still in the list rather than filtered out of it, because an operator scanning for their
    // runtime and not finding it concludes the tool does not know about it and picks the nearest
    // block, which is the `mcpServers` one this branch exists to keep them away from.
    if (r.kind === 'none') return { id: r.id, label: r.label, kind: 'none', instead: r.instead }
    return { id: r.id, label: r.label, kind: 'file', config: r.config, json: stanzaJson(stanza) }
  })
}
