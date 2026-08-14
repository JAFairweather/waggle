// mcp_runtimes — the MCP channel described once, rendered per runtime, and the name test that
// missed an nvoy server spelled with underscores (#464, #333 §1).
//
// Read the negative controls first. This is a guard, and a guard asserted only on what it REFUSES
// cannot be told apart from one that refuses everything — the slot validator that threw on
// `Dennis @everyone` and also on `My Dude` was green all the way to a live outage. So every
// refusal here is paired with a legitimate value that must still get through, and the fixtures are
// the names actually registered on a real machine, underscores and all, not `A` and `B`.
//
// Nothing here opens a subprocess. The parsers are fed captured output, which is the point of them
// being pure: the operator's own MCP config is not a test fixture.
import { strict as assert } from 'node:assert'
import {
  RUNTIMES, channelStanza, cliRuntimes, fileRuntimes, foreignServers, isMine, isNvoyServer,
  parseClaudeList, parseCodexJson, registrationHelp, runtime, stanzaJson,
} from '../src/mcp_runtimes.mjs'

let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

console.log('\nmcp_runtimes\n')

// ── 1. Which names are nvoy channels at all ─────────────────────────────────────────────────
console.log('1. recognising an nvoy channel')
check(isNvoyServer('nvoy'), 'the bare `nvoy` server is one')
check(isNvoyServer('nvoy-mc-claude'), 'the hyphen spelling is one')
check(isNvoyServer('nvoy_codex_jaf'), 'THE BUG — the underscore spelling is one too (this is registered on a real machine)')
check(isNvoyServer('NVOY-Oliver'), 'and case does not hide it')
// The other direction. A test that only asserts what it catches cannot tell "sees nvoy servers"
// from "sees every server", and the second would flag the operator's whole config as hostile.
check(!isNvoyServer('nvoyage'), 'NEGATIVE CONTROL — `nvoyage` is not an nvoy channel: the prefix needs a separator')
check(!isNvoyServer('github'), 'NEGATIVE CONTROL — an ordinary MCP server is not one')
check(!isNvoyServer(''), 'NEGATIVE CONTROL — and neither is nothing')

// ── 2. Which one is mine ────────────────────────────────────────────────────────────────────
console.log('\n2. telling my own channel from somebody else\'s')
check(isMine('nvoy-mc-claude', 'mc-claude'), 'my own hyphen-spelled server is mine')
check(isMine('nvoy_mc-claude', 'mc-claude'), 'and the underscore separator is still mine')
check(isMine('NVOY-MC-CLAUDE', 'mc-claude'), 'and case does not make it a stranger')
check(!isMine('nvoy-oliver', 'mc-claude'), 'NEGATIVE CONTROL — another agent\'s server is not mine')
check(!isMine('nvoy', 'mc-claude'), 'NEGATIVE CONTROL — the bare server is nobody\'s, so it is not mine either')
// Deliberate strictness, documented in the module: `a-b` and `a_b` are both legal agent names, so
// folding separators INSIDE the name would let a foreign channel read as your own.
check(!isMine('nvoy_mc_claude', 'mc-claude'), 'a separator inside the name is NOT folded — it flags rather than assumes')

// ── 3. Foreign servers, the question the guard exists to answer ─────────────────────────────
console.log('\n3. what else is registered')
const REAL = ['nvoy-mc-claude', 'nvoy_codex_jaf', 'nvoy', 'github', 'computer-use']
check(JSON.stringify(foreignServers(REAL, 'mc-claude')) === JSON.stringify(['nvoy_codex_jaf', 'nvoy']),
  'both foreign channels are named, in the order found')
check(foreignServers(['nvoy-mc-claude', 'github'], 'mc-claude').length === 0,
  'NEGATIVE CONTROL — a session carrying only its OWN channel comes back clean, so this is not a guard that always fires')
check(foreignServers(['nvoy-a', 'nvoy-a', 'nvoy_b'], 'me').length === 3 - 1,
  'a repeated name is counted once')
check(foreignServers(null, 'me') === null && foreignServers(undefined, 'me') === null,
  'nothing to read comes back null — UNKNOWN, never an empty list')
check(Array.isArray(foreignServers([], 'me')) && foreignServers([], 'me').length === 0,
  'and an EMPTY list is not null: "asked, nothing there" must not read as "nobody asked"')

// ── 4. Parsers, fed real captured output ────────────────────────────────────────────────────
console.log('\n4. parsing what each runtime prints')
const CLAUDE_OUT = [
  'nvoy-mc-claude: /usr/bin/ssh -i /path/id_ed25519 root@host - ✗ Failed to connect',
  'nvoy_codex_jaf: /usr/bin/ssh -i /path/id_ed25519 root@host - ✓ Connected',
  'github: npx -y @modelcontextprotocol/server-github - ✓ Connected',
].join('\n')
const claudeNames = parseClaudeList(CLAUDE_OUT)
check(JSON.stringify(claudeNames) === JSON.stringify(['nvoy-mc-claude', 'nvoy_codex_jaf', 'github']),
  'claude mcp list: three servers, names only — the command and status are not part of the name')
check(parseClaudeList(null) === null, 'claude: no output at all is null, not []')
check(JSON.stringify(parseClaudeList('No MCP servers configured.')) === JSON.stringify([]),
  'claude: a real answer with nothing in it is [], not null')

// Captured from `codex mcp list --json` on 2026-08-14. The plain table is fixed-width and folds a
// whole environment block into the name column, which is why this asks for JSON.
const CODEX_OUT = JSON.stringify([
  { name: 'computer-use', command: '/Applications/x', args: ['mcp'], env: null },
  { name: 'nvoy_codex_jaf', command: '/usr/bin/ssh', args: ['-T', 'root@host'], env: null },
])
check(JSON.stringify(parseCodexJson(CODEX_OUT)) === JSON.stringify(['computer-use', 'nvoy_codex_jaf']),
  'codex mcp list --json: names in order')
check(parseCodexJson('Name            Command\ncomputer-use   /App') === null,
  'codex: the fixed-width TABLE is refused — INCONCLUSIVE, never parsed as a name')
check(parseCodexJson('{"servers":[]}') === null, 'codex: JSON that is not the expected array is null')
check(JSON.stringify(parseCodexJson('[]')) === JSON.stringify([]), 'codex: an empty array is [], not null')
check(JSON.stringify(parseCodexJson('[{"command":"x"}]')) === JSON.stringify([]),
  'codex: an entry with no name contributes no name, and does not crash')

// The two parsers must agree about the SAME machine, or the guard's answer depends on which
// runtime asked — which is the whole defect being fixed.
check(JSON.stringify(foreignServers(parseClaudeList(CLAUDE_OUT), 'mc-claude'))
  === JSON.stringify(['nvoy_codex_jaf', 'nvoy'].slice(0, 1)),
  'the same foreign channel is found through the claude parser as through the codex one')
check(JSON.stringify(foreignServers(parseCodexJson(CODEX_OUT), 'mc-claude')) === JSON.stringify(['nvoy_codex_jaf']),
  'and through the codex parser')

// ── 5. The stanza — described once ──────────────────────────────────────────────────────────
console.log('\n5. the neutral stanza')
const S = channelStanza({ agent: 'MC-Claude', command: '/usr/bin/node', args: ['/opt/nvoy/claude-channel.mjs'], instanceRoot: '/root/instances' })
check(S.server === 'nvoy-mc-claude', 'the server name is lowercased from the agent name')
check(S.args.join(' ') === '/opt/nvoy/claude-channel.mjs --instance mc-claude', '--instance is appended, lowercased')
check(S.env.NVOY_INSTANCE_ROOT === '/root/instances', 'the instance root travels in env')
check(Object.keys(S.env).length === 1, 'and nothing else does — this object is rendered into a paste block')
check(!JSON.stringify(S).toLowerCase().includes('bunker') && !JSON.stringify(S).toLowerCase().includes('nsec'),
  'NEGATIVE CONTROL — no credential of any kind reaches the stanza')
let threw = false
try { channelStanza({ agent: 'x' }) } catch { threw = true }
check(threw, 'a stanza with no command refuses rather than emitting a half-command to paste')

const json = JSON.parse(stanzaJson(S))
check(!!json.mcpServers['nvoy-mc-claude'], 'the JSON form is the standard `mcpServers` shape a file-configured host reads')
check(json.mcpServers['nvoy-mc-claude'].command === '/usr/bin/node', 'with the command intact')

// ── 6. Per-runtime rendering ────────────────────────────────────────────────────────────────
console.log('\n6. what each runtime is told')
const help = registrationHelp(S)
check(help.length === RUNTIMES.length, 'every runtime gets an entry — a missing one is a runtime nobody is told how to use')
check(help.every(h => h.label && h.label.length > 2), 'and every entry is LABELLED: an unlabelled command is how a Codex operator types a Claude Code one')

const claudeLine = help.find(h => h.id === 'claude').line
check(claudeLine.startsWith('claude mcp add nvoy-mc-claude -s user'), `claude: ${claudeLine.slice(0, 46)}…`)
check(claudeLine.includes('-e NVOY_INSTANCE_ROOT=/root/instances'), 'claude: env as -e')
check(claudeLine.includes('-- /usr/bin/node /opt/nvoy/claude-channel.mjs --instance mc-claude'), 'claude: the command after --')

// RUN, not assumed: `codex mcp add <n> --env K=V -- <cmd> <args…>` was executed against the real
// CLI on 2026-08-14 and the entry landed with command, args and env split exactly this way.
const codexLine = help.find(h => h.id === 'codex').line
check(codexLine.startsWith('codex mcp add nvoy-mc-claude --env NVOY_INSTANCE_ROOT=/root/instances --'), `codex: ${codexLine.slice(0, 46)}…`)
check(!codexLine.includes('-s user'), 'NEGATIVE CONTROL — codex does not get Claude Code\'s -s flag')

// `gemini mcp` printed `Unknown argument: mcp` on the installed build. Emitting an add one-liner
// for it would be an instruction that has never run — the exact drift this module removes.
const gemini = help.find(h => h.id === 'gemini')
check(gemini.kind === 'file' && !gemini.line, 'gemini is file-configured and is given NO command line')
check(gemini.config.includes('settings.json') && gemini.json.includes('mcpServers'), 'gemini gets a path and the stanza')
const generic = help.find(h => h.id === 'generic')
check(!!generic && /pi|headless/i.test(generic.label), `a host with no CLI at all is covered — ${generic.label.slice(0, 40)}…`)

check(cliRuntimes().every(r => typeof r.add === 'function' && typeof r.remove === 'function' && typeof r.parse === 'function'),
  'every CLI runtime can list, add AND remove — a guard that says "remove it" without the command is half a guard')
check(fileRuntimes().every(r => r.config && !r.add), 'and no file-configured runtime carries an add line')
check(runtime('codex')?.id === 'codex' && runtime('nope') === null, 'runtimes are addressable by id, and an unknown one is null not a throw')

// ── 7. The property the whole module is for ─────────────────────────────────────────────────
console.log('\n7. end to end: the machine that reported sole occupancy')
// Claude Code answers and looks clean; Codex answers and does not. Before #464 only the first was
// asked, and the report read `nvoy-mc-claude is the only nvoy server registered`.
const perRuntime = [
  { id: 'claude', names: parseClaudeList('nvoy-mc-claude: /usr/bin/ssh - ✓ Connected\ngithub: npx - ✓ Connected') },
  { id: 'codex', names: parseCodexJson(CODEX_OUT) },
]
const allForeign = perRuntime.flatMap(p => foreignServers(p.names, 'mc-claude').map(s => `${p.id}:${s}`))
check(JSON.stringify(allForeign) === JSON.stringify(['codex:nvoy_codex_jaf']),
  'asking every runtime finds the channel that asking one did not')
check(foreignServers(perRuntime[0].names, 'mc-claude').length === 0,
  'NEGATIVE CONTROL — and the runtime that IS clean still reports clean, so this is not "flag everything"')

console.log(`\n${pass} passed, ${fail} failed`)
assert.equal(fail, 0, `${fail} assertion(s) failed`)
