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

// ── Parsers. Each returns an array of server names, or null for "could not read this".
// null is not []. `[]` means the runtime answered and has nothing registered; null means nobody
// looked, and those two must never share a cell — the whole four-state report rests on it.

/** `claude mcp list` prints `<server>: <command…> - <status>`. Take only the name. */
export function parseClaudeList(stdout) {
  if (typeof stdout !== 'string') return null
  const names = []
  for (const line of stdout.split('\n')) {
    const m = /^([A-Za-z0-9._-]+):/.exec(line.trim())
    if (m && !names.includes(m[1])) names.push(m[1])
  }
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

export const RUNTIMES = [
  {
    id: 'claude',
    label: 'Claude Code',
    kind: 'cli',
    bin: 'claude',
    listArgs: ['mcp', 'list'],
    parse: parseClaudeList,
    add: ({ server, command, args, env }) =>
      ['claude', 'mcp', 'add', server, '-s', 'user',
        ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        '--', command, ...args].join(' '),
    remove: server => `claude mcp remove ${server}`,
    // A registered server that the real channel already holds the lock on reports "Failed to
    // connect" here. That is expected and is not a registration fault.
    listCaveat: '"Failed to connect" in this list is EXPECTED while the real channel holds the lock',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    kind: 'cli',
    bin: 'codex',
    listArgs: ['mcp', 'list', '--json'],
    parse: parseCodexJson,
    add: ({ server, command, args, env }) =>
      ['codex', 'mcp', 'add', server,
        ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
        '--', command, ...args].join(' '),
    remove: server => `codex mcp remove ${server}`,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    kind: 'file',
    // Documentation-derived, not executed: this repo has confirmed the CLI has no `mcp`
    // subcommand, and nothing more. The stanza is what to write; whether the runtime read it is
    // proven by a handshake in the session, not by this file existing.
    config: '~/.gemini/settings.json',
    configKey: 'mcpServers',
  },
  {
    id: 'generic',
    label: 'Any other MCP host (Raspberry Pi, headless, self-hosted)',
    kind: 'file',
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
export function channelStanza({ agent, command, args = [], instanceRoot }) {
  const a = String(agent || '').toLowerCase()
  if (!a) throw new Error('channelStanza needs an agent name')
  if (!command) throw new Error('channelStanza needs the command that launches the channel')
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
  return RUNTIMES.map(r => r.kind === 'cli'
    ? { id: r.id, label: r.label, kind: 'cli', line: r.add(stanza) }
    : { id: r.id, label: r.label, kind: 'file', config: r.config, json: stanzaJson(stanza) })
}
