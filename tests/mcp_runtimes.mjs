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
  RUNTIMES, channelStanza, cliRuntimes, exclusivityVerdict, fileRuntimes, foreignServers, isMine, isNvoyServer,
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

// FAIL CLOSED (#464 review). This parser feeds `mcp-exclusive`, and `[]` there means "asked, and
// nothing foreign is registered" — a green tick. Anything it cannot actually read must therefore
// come back null, or the tick is printed off a list nobody read. Every case below produced a
// usable-looking answer before the fix; the first two produced a WRONG NAME.
check(parseClaudeList('Error: unable to read config') === null,
  'claude: an error line is INCONCLUSIVE, not a server named "Error"')
check(parseClaudeList('zsh: command not found: claude') === null,
  'claude: a shell failure is INCONCLUSIVE, not a server named "zsh"')
check(parseClaudeList('') === null && parseClaudeList('   \n  ') === null,
  'claude: blank output is INCONCLUSIVE — a command that printed nothing has told you nothing')
check(parseClaudeList('Traceback (most recent call last)\n  File "x", line 1') === null,
  'claude: output with no entries in it at all is null, NOT an empty list')
check(parseClaudeList(`${CLAUDE_OUT}\nsomething the parser has never seen`) === null,
  'claude: one unrecognised line invalidates the whole read rather than being skipped')
check(parseClaudeList('No MCP servers configured.\nnvoy-x: /usr/bin/ssh root@h - ✓ Connected') === null,
  'claude: "nothing configured" alongside an entry is a contradiction, not a list')

// BOTH DIRECTIONS — a parser that returned null for everything would pass every check above, and
// would take the whole feature down while looking strictly safer.
check(JSON.stringify(parseClaudeList(`Checking MCP server health...\n\n${CLAUDE_OUT}\n`))
  === JSON.stringify(['nvoy-mc-claude', 'nvoy_codex_jaf', 'github']),
  'NEGATIVE CONTROL — a health-check header, a blank line and a trailing newline do not break a real list')

// The consequence the review named, asserted at the surface rather than at the parser: an
// unreadable list must not reach foreignServers as "nothing foreign here".
check(foreignServers(parseClaudeList('Error: unable to read config'), 'mc-claude') === null,
  'an unreadable list stays UNKNOWN all the way to foreignServers, and cannot print a clean tick')

// ── A SPACE IN A SERVER NAME (#566) ──────────────────────────────────────────────────────────
// The claude.ai-hosted connectors are named `claude.ai Gmail`, `claude.ai Google Drive` and so on.
// The name class had no space in it, so one of those lines returned null for the WHOLE registry —
// and five of them are present on the maintainer's Mac. The fixtures above never caught it because
// every name in them is a single token, which is the same shape of miss as the space-in-a-name bug
// that took the sealed lane down: the suite was green and production was not.
const CLAUDE_HOSTED = [
  'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected',
  'claude.ai Notion: https://mcp.notion.com/mcp - ! Needs authentication',
  'nvoy-lukedog: /path/node /path/claude-channel.mjs --instance lukedog - ✘ Failed to connect',
].join('\n')
check(JSON.stringify(parseClaudeList(CLAUDE_HOSTED))
  === JSON.stringify(['claude.ai Google Drive', 'claude.ai Notion', 'nvoy-lukedog']),
  'claude: a name containing spaces parses, and keeps the space — this returned null for the whole list')

// THE ASSERTION THAT WOULD HAVE FAILED IN PRODUCTION. The point of the row is finding a foreign
// nvoy server; a discarded list finds none, and the operator is told the machine is clean of
// everything the unread runtime held.
check(JSON.stringify(foreignServers(parseClaudeList(CLAUDE_HOSTED), 'mc-claude'))
  === JSON.stringify(['nvoy-lukedog']),
  '  …and the foreign nvoy server beside it is DETECTED, not silently dropped with the list')

// THE STATUS IS ANCHORED BY SHAPE, NOT BY GLYPH. Both spellings of a tick must work: production
// prints U+2714 and this file's own fixtures above were written with U+2713, which is exactly how
// a glyph allowlist would have re-created #566 on the next CLI update.
check(JSON.stringify(parseClaudeList('a: /x - ✓ Connected\nb: /y - ✔ Connected'))
  === JSON.stringify(['a', 'b']),
  'claude: U+2713 and U+2714 are both accepted — the exact tick is deliberately not pinned')
check(parseClaudeList('Error: config not found - check permissions') === null,
  'claude: prose after the dash is still INCONCLUSIVE — widening the NAME did not widen the line')
check(parseClaudeList('nvoy: node /x.js - OK') === null,
  'claude: an unrecognised status reads as INCONCLUSIVE rather than as a short list')

// THE GUARD IS THE STATUS, NOT THE NAME. Every #464 refusal above must still hold with the name
// class gone, or widening it traded one silent failure for another. These are the same inputs, kept
// here deliberately next to the widening that could have broken them.
check(parseClaudeList('svc/worker: node /x.js - ✓ Connected') !== null,
  'claude: a name this parser never anticipated still parses — a narrow class is just #566 waiting')
check(parseClaudeList('zsh: command not found: claude') === null,
  '  …and a shell failure is STILL refused, by the missing status rather than by the name')

// ── The row itself. The line above is true of `foreignServers`, and was written as though it were
// true of the REPORT — one frame below where the sentence is about. It is not: the tool asked only
// the runtimes that ANSWERED, so `claude` answering clean while `codex` sat installed-and-unreadable
// printed a green tick on the row that stops this session signing as another identity (#464 review).
//
// Four states, and the controls that make them mean something. A verdict function returning
// `{found: null}` for everything would satisfy every UNKNOWN assertion here and take the guard down
// while looking strictly safer — so the clean case and the detection case are asserted as hard as
// the refusals.
const verdict = (f, u) => JSON.stringify(exclusivityVerdict(f, u))
check(verdict([], 0) === JSON.stringify({ found: true, verified: true }),
  'NEGATIVE CONTROL — every runtime answered and none holds a foreign server: that IS a clean tick')
check(verdict(['nvoy-other'], 0) === JSON.stringify({ found: false, verified: false }),
  'NEGATIVE CONTROL — a foreign server that was found is MISSING, not UNKNOWN')
check(verdict([], 1) === JSON.stringify({ found: null, verified: false }),
  'THE BUG — one runtime installed but unreadable makes the row UNKNOWN, however clean the others read')
check(verdict(null, 1) === JSON.stringify({ found: null, verified: false }),
  'and no runtime readable at all is UNKNOWN, never absent')
check(verdict(null, 0) === JSON.stringify({ found: null, verified: false }),
  'and no MCP host CLI on the machine is UNKNOWN too — nobody looked')
// The asymmetry, asserted rather than assumed: an unread runtime must not un-find what was found.
check(verdict(['nvoy-other'], 1) === JSON.stringify({ found: false, verified: false }),
  'a detection SURVIVES an unread runtime — an unasked runtime does not un-find a foreign server')
check(exclusivityVerdict([], 0).verified === true && exclusivityVerdict([], 1).verified === false,
  'and `verified` follows: only the state where every runtime was actually read is verified')

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
check(!!generic && /headless/i.test(generic.label), `a host with no CLI at all is covered — ${generic.label.slice(0, 40)}…`)

// ── The runtime with no MCP (#519) ──────────────────────────────────────────────────────────
// Pi is the agent harness at pi.dev, not a board. It has no built-in MCP, so the one thing this
// block must never do for it is print an `mcpServers` stanza under its label — that is an
// instruction pointing at a config file which does not exist, for a subsystem the runtime does not
// have. The old `generic` label said "Raspberry Pi" and this repo read it as hardware while
// planning the walk, which is how the wrong block gets picked in the first place.
const pi = help.find(h => h.id === 'pi')
check(!!pi && pi.kind === 'none', 'Pi is present and is neither a CLI nor a file-configured runtime')
check(!pi.json && !pi.line && !pi.config,
  '  …so it is given NO stanza, NO command line and NO config path — there is nothing to paste')
check(/no MCP/i.test(pi.instead), '  …and it SAYS there is no MCP, rather than rendering an empty block')
check(/agent-inbox\.mjs/.test(pi.instead) && /agent-send\.mjs/.test(pi.instead),
  '  …and names both tools that ARE the participation surface — listen and speak, not one of them')
check(runtime('pi')?.startupFile === 'AGENTS.md', 'Pi reads AGENTS.md — same filename as Codex, different search path')
check(!fileRuntimes().some(r => r.id === 'pi') && !cliRuntimes().some(r => r.id === 'pi'),
  '  …and neither runtime filter picks it up, so no caller renders it as one of those')

// BOTH DIRECTIONS. "No runtime prints a stanza" would pass every assertion above and is the change
// that silently breaks the other four. Every runtime that is not `none` must still get something
// pasteable, and no label may name the board again.
check(help.filter(h => h.kind !== 'none').every(h => h.line || h.json),
  'BOTH DIRECTIONS — every other runtime still gets a command or a stanza')
check(help.filter(h => h.kind === 'none').length === 1, '  …and exactly one runtime claims to have no MCP')
check(RUNTIMES.every(r => !/raspberry/i.test(r.label)),
  'no runtime label says Raspberry — in this repo "Pi" now names the harness, and an operator picks by label')
// Where the file has to land. `--startup` writes into the agent root and tells the operator to
// point the runtime at it, which is not one place for Pi: `~/.pi/agent/`, parent directories, and
// the cwd. A file in none of the three is read by nothing and looks identical to one that was read.
const note = runtime('pi').startupNote
check(/~\/\.pi\/agent\//.test(note) && /parent director/i.test(note) && /current directory/.test(note),
  'the Pi row names all three places Pi loads AGENTS.md from')
check(/cwd|current directory/.test(note) && /~\/\.pi\/agent\//.test(note) && /place|start/.test(note),
  '  …and names an act that puts the file in reach, not only the locations')
check(RUNTIMES.filter(r => r.startupNote).length === 1,
  '  …and it is carried on the row, so a second such runtime says it too rather than being special-cased')

// SHELL QUOTING (#464 review). These lines are printed for the operator to paste, and the old
// `.join(' ')` did not fail on a path with a space in it — it produced a DIFFERENT, valid command
// that registered the wrong argv and reported success. `/Users/x/My Drive/...` is an ordinary
// macOS home path, and the next signal is a channel that will not connect for a reason nothing on
// screen names.
{
  const spaced = channelStanza({
    agent: 'MC-Claude',
    command: '/Users/op/My Drive/bin/node',
    args: ['/Users/op/My Drive/nvoy/claude-channel.mjs', '--instance', 'mc-claude'],
    instanceRoot: '/Users/op/My Drive/instances',
  })
  for (const r of cliRuntimes()) {
    const line = r.add(spaced)
    check(line.includes("'/Users/op/My Drive/bin/node'"), `${r.id}: a command path with a space is quoted`)
    check(line.includes("'/Users/op/My Drive/nvoy/claude-channel.mjs'"), `${r.id}: an argument with a space is quoted`)
    check(/(-e|--env) 'NVOY_INSTANCE_ROOT=\/Users\/op\/My Drive\/instances'/.test(line),
      `${r.id}: an env VALUE with a space is quoted as one token`)
    // The property, not the mechanism: splitting the rendered line the way a shell would must give
    // back exactly the argv that went in.
    check(!/ \/Users\/op\/My Drive/.test(line.replace(/'[^']*'/g, '')),
      `${r.id}: no unquoted space survives anywhere in the line`)
  }
  const quoted = channelStanza({ agent: "od'd", command: '/bin/node', args: ['/a b'], instanceRoot: '/r' })
  check(cliRuntimes().every(r => r.add(quoted).includes("'\\''")),
    "a single quote inside a token uses the '\\'' escape rather than ending the quoting early")
}
// BOTH DIRECTIONS — quoting everything unconditionally would pass all of the above and make every
// ordinary line unreadable. The plain case must stay plain.
check(!claudeLine.includes("'"), 'NEGATIVE CONTROL — an ordinary path is NOT quoted; the line stays copy-readable')
check(!help.find(h => h.id === 'codex').line.includes("'"), 'NEGATIVE CONTROL — same for codex')

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
