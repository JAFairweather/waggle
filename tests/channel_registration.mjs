// channel_registration — the ssh stanza that reaches the broker, and the local one that does not
// (#472).
//
// The defect this suite exists to hold: `connect-agent.mjs` emitted a local `claude-channel.mjs`
// spawn, which is the form the MCP cutover retired. It does not fail loudly. It spawns, answers
// `initialize`, and lists as ✔ Connected while the identity's real channel is on the broker host.
// Two identities on the maintainer's own machine sat in exactly that state, looking healthy from
// every angle they could see.
//
// So the assertions here are shaped against that failure, not against the happy path:
//
//   * The stanza is compared to a REAL working registration, flag for flag and in order. "The
//     flags are all there somewhere" is a weaker claim than an empty diff, and it is the flags
//     that make this a safe connection — drop `IdentitiesOnly` and it can succeed as the wrong
//     principal, drop `BatchMode` and a password prompt becomes a hang with no error.
//   * Every refusal is paired with a legitimate value that must still get through. A guard tested
//     only on what it rejects cannot be told from one that rejects everything, which is how a slot
//     validator went green all the way to a live outage here.
//   * Every refusal is asserted on its REASON, not just on `throws`. `!ok` cannot distinguish a
//     correct refusal from a correct refusal that sends the operator to the wrong place, and the
//     operator acts on the explanation.
//   * The listing fixtures are the four servers actually registered on a real machine — two in the
//     ssh form, two retired, one bare — with their real spellings, underscores and all, and the
//     ✔ Connected the retired ones really print. Only the home directory is generalised. `A` and
//     `B` fixtures are how the last live outage stayed invisible.
import { strict as assert } from 'node:assert'
import {
  KEY_FILE, KNOWN_HOSTS_FILE, SSH_BIN, SSH_TEMPLATE,
  channelCommand, credentialPaths, credentialReport, isRetiredLocalForm, registeredForm, sameVector,
} from '../src/channel_registration.mjs'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { channelStanza } from '../src/mcp_runtimes.mjs'

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }
// Asserts the message, not only that it threw. Returns the message so a caller can narrow further.
const refusal = fn => { try { fn(); return null } catch (e) { return e.message } }

console.log('\nchannel_registration\n')

// An instance root shaped like a real one — the nvoy desktop layout, a hyphenated agent name — but
// under a generic home rather than one operator's. What section 1 asserts is the template's flag set
// and its order; the paths are per-machine and substituted from this constant, so pinning a
// particular `$HOME` into a public repo proved nothing extra and dated the fixture to one laptop.
const HOME = '/home/agent'
const ROOT = `${HOME}/.nvoy/desktop/mc-claude`
const HOST = 'nave.pub'

// ── 1. The stanza, against a real working registration ──────────────────────────────────────
// Captured from a live `nvoy-mc-claude` entry that answered a handshake. Kept verbatim, in order.
console.log('1. the stanza matches a registration that is known to work')
const LIVE_ARGS = [
  '-F', '/dev/null', '-T',
  '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${ROOT}/credentials/claude-channel-known-hosts`,
  '-o', 'GlobalKnownHostsFile=/dev/null',
  '-o', 'ClearAllForwardings=yes',
  '-i', `${ROOT}/credentials/claude-channel-ssh`,
  'root@nave.pub',
]
const built = channelCommand({ instanceRoot: ROOT, host: HOST })
check(built.command === SSH_BIN, 'the command is ssh by absolute path, not whatever `ssh` resolves to on PATH')
check(JSON.stringify(built.args) === JSON.stringify(LIVE_ARGS),
  'and the argument vector matches the live working entry exactly, in order')
check(built.target === 'root@nave.pub', 'the target defaults to root — the account the forced command is seated under')

// The flags individually, so a failure above names WHICH one moved rather than printing two long
// vectors and leaving the reader to diff them.
console.log('\n2. each flag is present for its own reason')
// Scans EVERY occurrence, not the first. A first cut used `indexOf`, which finds only the leading
// `-o` and so reported four flags absent that the byte-for-byte assertion above had just matched —
// a probe that cannot see the thing it asks about answers "no" indistinguishably from a real miss.
const has = (...pair) => built.args.some((a, i) => a === pair[0] && (pair.length === 1 || built.args[i + 1] === pair[1]))
check(has('-F', '/dev/null'), 'the user ssh_config is ignored — a wildcard Host block would redirect the channel silently')
check(has('-T'), 'no pty — this pipe carries MCP JSON and a pty mangles it')
check(has('-o', 'BatchMode=yes'), 'never prompts — a password prompt in a spawned server is a hang with no error')
check(has('-o', 'IdentitiesOnly=yes'), 'offers only the named key — without it the connection can succeed as the wrong principal')
check(has('-o', 'StrictHostKeyChecking=yes'), 'refuses an unknown host rather than trusting it on sight')
check(has('-o', 'GlobalKnownHostsFile=/dev/null'), 'the system known_hosts is not this principal trust store')
check(has('-o', 'ClearAllForwardings=yes'), 'no tunnels — the channel is a pipe, not a network path')
check(built.args.filter(a => a.startsWith('UserKnownHostsFile=')).length === 1,
  'exactly one UserKnownHostsFile — a second would make which store is consulted depend on ssh argument order')

// NEGATIVE CONTROL for the whole of section 1: the comparison can fail. A byte-for-byte assertion
// that has only ever passed proves the fixture and the code agree, not that either is right.
const wrongUser = channelCommand({ instanceRoot: ROOT, host: HOST, user: 'nobody' })
check(JSON.stringify(wrongUser.args) !== JSON.stringify(LIVE_ARGS),
  'NEGATIVE CONTROL — a stanza built for a different account does NOT match the live vector')
check(wrongUser.args.at(-1) === 'nobody@nave.pub', 'and the account it was built for is the one that appears')

// ── 3. Refusals, each paired with the value that must still pass ────────────────────────────
console.log('\n3. what it refuses, and what it must not refuse')
const noHost = refusal(() => channelCommand({ instanceRoot: ROOT }))
check(noHost !== null, 'no host is a refusal, not a default')
check(/--channel-host/.test(noHost),
  'and the refusal NAMES the flag: a dead end and a dead end with a way out are not the same message')
check(/no default/i.test(noHost),
  'and says WHY there is no default — an operator told only "missing" reasonably assumes one exists')

const url = refusal(() => channelCommand({ instanceRoot: ROOT, host: 'wss://nave.pub' }))
check(url !== null, 'a relay URL pasted in place of a hostname is refused')
check(/URL/.test(url) && /hostname/.test(url), 'and the refusal says it wants a bare hostname, not that the host is unknown')
check(refusal(() => channelCommand({ instanceRoot: ROOT, host: 'nave' })) !== null,
  'a bare label with no dot is refused — ssh would resolve it against a search domain nobody chose')
check(refusal(() => channelCommand({ instanceRoot: ROOT, host: HOST, user: 'root; rm -rf /' })) !== null,
  'a user field carrying shell metacharacters is refused')
check(refusal(() => channelCommand({ instanceRoot: ROOT, host: HOST, user: '-oProxyCommand=x' })) !== null,
  'and a user field shaped like an ssh option is refused before it can become one')

// The other half. Every refusal above is worthless if these also fail.
check(refusal(() => channelCommand({ instanceRoot: ROOT, host: 'nave.pub' })) === null,
  'NEGATIVE CONTROL — an ordinary hostname still gets through')
check(refusal(() => channelCommand({ instanceRoot: ROOT, host: 'a.b.example.com' })) === null,
  'NEGATIVE CONTROL — so does a deeper name')
check(refusal(() => channelCommand({ instanceRoot: ROOT, host: 'nave-2.pub' })) === null,
  'NEGATIVE CONTROL — and one with a hyphen in a label, which the pattern must not treat as a range')
check(refusal(() => channelCommand({ instanceRoot: ROOT, host: HOST, user: 'nvoy-channel' })) === null,
  'NEGATIVE CONTROL — and a real service account with a hyphen is still a valid user')

// No placeholder may survive into a path. It would become a literal file named `%KEY%` and ssh
// would report it as an ordinary missing-file error, pointing at something nobody meant to create.
check(!built.args.some(a => /%[A-Z_]+%/.test(a)), 'no template placeholder survives into the built vector')
check(SSH_TEMPLATE.filter(a => /%[A-Z_]+%/.test(a)).length === 3,
  'and the template has exactly the three it is supposed to substitute — known hosts, key, target')

// ── 4. Credentials the stanza names but that may not exist ──────────────────────────────────
console.log('\n4. the stanza can be right and still not run')
const paths = credentialPaths(ROOT)
check(paths.keyPath === `${ROOT}/credentials/${KEY_FILE}`, 'the key path is under the agent own credentials directory')
check(paths.knownHostsPath === `${ROOT}/credentials/${KNOWN_HOSTS_FILE}`, 'and so is its known_hosts')
check(credentialPaths(`${ROOT}///`).keyPath === paths.keyPath, 'a trailing slash on the root does not double the separator')
check(refusal(() => credentialPaths('')) !== null, 'and an empty root is refused rather than rooting the path at /')

const bothThere = credentialReport({ instanceRoot: ROOT, exists: () => true })
check(bothThere.ok && bothThere.missing.length === 0, 'with both files present the report is ok')
const neither = credentialReport({ instanceRoot: ROOT, exists: () => false })
check(!neither.ok, 'with neither present it is not')
check(neither.missing.includes(KEY_FILE) && neither.missing.includes(KNOWN_HOSTS_FILE),
  'and it names BOTH files — "credentials missing" sends an operator to look at two things')
// One missing, not both. This is the state that reads as fine and is not: the key is there, so the
// obvious check passes, and the connection still refuses the host it was never told to trust.
const keyOnly = credentialReport({ instanceRoot: ROOT, exists: p => p.endsWith(KEY_FILE) })
check(!keyOnly.ok, 'a key with no known_hosts is NOT ok')
check(keyOnly.missing.length === 1 && keyOnly.missing[0] === KNOWN_HOSTS_FILE,
  'and it names the one that is absent, not both')
check(/does not exist/.test(keyOnly.note) && !/do not exist/.test(keyOnly.note),
  'and the note agrees with itself in number — one file "does", two "do"')
check(/operator/.test(neither.note), 'the note says whose step minting them is, rather than implying this tool will')
check(refusal(() => credentialReport({ instanceRoot: ROOT })) !== null,
  'and a report asked for with no exists() probe refuses rather than reporting everything absent')
// The last one matters more than it looks: a missing probe defaulting to "not found" would report a
// fully provisioned agent as having no credentials at all, and it would do it silently.

// ── 5. Telling a working registration from one that only looks like one ─────────────────────
// The real listing from a real machine. Two of these four reach their identity and two do not, and
// nothing in the NAMES distinguishes them.
console.log('\n5. registered, and registered in the form that reaches the identity')
const CLAUDE_LIST = [
  `nvoy: node ${HOME}/Projects/nvoy/mcp/dist/server.js - ✔ Connected`,
  `nvoy-mc-claude: /usr/bin/ssh ${LIVE_ARGS.join(' ')} - ✔ Connected`,
  `nvoy-oliver: ${HOME}/.nvm/versions/node/v22.16.0/bin/node ${HOME}/Projects/connect/nvoy-macos-desktop-binder/mcp/tools/claude-channel.mjs --instance oliver - ✔ Connected`,
  `nvoy-lukedog: ${HOME}/.nvm/versions/node/v22.16.0/bin/node ${HOME}/Projects/connect/nvoy-macos-desktop-binder/mcp/tools/claude-channel.mjs --instance lukedog - ✔ Connected`,
].join('\n')

check(registeredForm(CLAUDE_LIST, 'nvoy-mc-claude') === 'ssh', 'the ssh entry reads as ssh')
check(registeredForm(CLAUDE_LIST, 'nvoy-oliver') === 'local', 'the retired local entry reads as local')
check(registeredForm(CLAUDE_LIST, 'nvoy-lukedog') === 'local', 'and so does the second one')
// The whole point. Both retired entries print ✔ Connected in the fixture above, exactly as they do
// on the machine — so a checker that trusted the status would call them healthy.
check(/nvoy-oliver:.*✔ Connected/.test(CLAUDE_LIST),
  'the fixture keeps the ✔ Connected on a retired entry, because that is what the machine prints')
check(registeredForm(CLAUDE_LIST, 'nvoy-notregistered') === 'unknown',
  'a server that is not in the listing is unknown, not local and not ssh')
check(registeredForm(null, 'nvoy-mc-claude') === 'unknown', 'unreadable output is unknown — UNVERIFIED, never fine')
check(registeredForm('', 'nvoy-mc-claude') === 'unknown', 'and so is empty output, which a size floor would otherwise pass as clean')
check(registeredForm(CLAUDE_LIST, '') === 'unknown', 'and asking about no server at all is unknown')

// Codex answers JSON for the same question. Same three verdicts, different shape.
const CODEX_JSON = JSON.stringify([
  { name: 'nvoy_codex_jaf', command: '/usr/bin/ssh', args: LIVE_ARGS },
  { name: 'nvoy-oliver', command: '/opt/node/bin/node', args: ['/opt/nvoy/mcp/tools/claude-channel.mjs', '--instance', 'oliver'] },
])
check(registeredForm(CODEX_JSON, 'nvoy_codex_jaf') === 'ssh', 'the JSON listing resolves the ssh form too')
check(registeredForm(CODEX_JSON, 'nvoy-oliver') === 'local', 'and the retired form inside JSON')
check(registeredForm('[', 'nvoy-oliver') === 'unknown', 'JSON that does not parse is unknown, not empty')

// A shape neither branch recognises must never come back `ssh`. `ssh` is the verdict that lets an
// entry pass as healthy, so it is the one that must be earned.
check(registeredForm('nvoy-oliver: /opt/weird/thing --flag - ✔ Connected', 'nvoy-oliver') === 'unknown',
  'a command that is neither ssh nor the retired script is unknown, never ssh')

// ── 6. The local-form test itself ───────────────────────────────────────────────────────────
console.log('\n6. what counts as the retired local form')
check(isRetiredLocalForm({ command: '/opt/node/bin/node', args: ['/x/claude-channel.mjs', '--instance', 'oliver'] }),
  'a node spawn of claude-channel.mjs is the retired form')
check(!isRetiredLocalForm({ command: SSH_BIN, args: LIVE_ARGS }), 'the ssh invocation is not')
// The trap: the ssh stanza names `claude-channel-ssh` in its own arguments. A substring test for
// "ssh" anywhere on the line, or for "claude-channel" anywhere, gets one of these two backwards.
check(!isRetiredLocalForm(`${SSH_BIN} ${LIVE_ARGS.join(' ')}`),
  'NEGATIVE CONTROL — and the ssh line is still not local even though it contains the string claude-channel-ssh')
check(isRetiredLocalForm('/usr/bin/node /x/claude-channel.mjs --ssh-nothing'),
  'NEGATIVE CONTROL — while a local spawn is still local even though the word ssh appears in its arguments')
check(!isRetiredLocalForm(''), 'an empty entry is not a retired registration — it is no registration')
check(!isRetiredLocalForm(null), 'and neither is a missing one')
check(!isRetiredLocalForm({ command: 'node', args: ['/x/server.js'] }), 'nor is an unrelated local server')

// ── 7. Form is not correctness ───────────────────────────────────────────────────────────────
// The finding that reopened this PR: an entry can be in the ssh form and still point at a previous
// broker, or at the other identity's key file. It connects, it prints ✔ Connected, and it is wrong —
// #472's own failure class one layer over. Every fixture below reads as `ssh` to `registeredForm`.
console.log('\n7. an ssh entry pointing at the wrong place')
check(sameVector(CLAUDE_LIST, 'nvoy-mc-claude', LIVE_ARGS) === true,
  'the live entry matches the vector this tool builds')
check(sameVector(CLAUDE_LIST, 'nvoy-mc-claude', built.args) === true,
  'and it matches the one channelCommand actually returns, not just the fixture copy of it')

// The three ways an ssh entry goes wrong. Each differs from the live vector in exactly one field,
// because a fixture that differs in five would pass a comparison that only ever looked at the first.
const swap = (find, put) => CLAUDE_LIST.replace(find, put)
const otherHost = swap('root@nave.pub', 'root@nave-old.pub')
const otherKey = swap(`-i ${ROOT}/credentials/claude-channel-ssh`, `-i ${HOME}/.nvoy/desktop/oliver/credentials/claude-channel-ssh`)
const otherUser = swap('root@nave.pub', 'nvoy@nave.pub')
check(registeredForm(otherHost, 'nvoy-mc-claude') === 'ssh' && sameVector(otherHost, 'nvoy-mc-claude', LIVE_ARGS) === false,
  'an entry pointing at a previous broker host reads as ssh and does NOT match')
check(registeredForm(otherKey, 'nvoy-mc-claude') === 'ssh' && sameVector(otherKey, 'nvoy-mc-claude', LIVE_ARGS) === false,
  'and one carrying another identity key file — the way one agent ends up authenticating as another')
check(registeredForm(otherUser, 'nvoy-mc-claude') === 'ssh' && sameVector(otherUser, 'nvoy-mc-claude', LIVE_ARGS) === false,
  'and one under a different account, which the forced command is not seated under')
// A dropped flag is the quiet one: it still connects. Without IdentitiesOnly, ssh offers every key
// the agent holds, so the connection can succeed as the wrong principal and look entirely healthy.
const noIdentitiesOnly = swap('-o IdentitiesOnly=yes ', '')
check(sameVector(noIdentitiesOnly, 'nvoy-mc-claude', LIVE_ARGS) === false,
  'and one with IdentitiesOnly dropped — it still connects, which is why nothing else would catch it')

// NEGATIVE CONTROL. Everything above is worthless if the comparison also refuses a correct entry —
// that is the slot-validator outage in this repo's own history, where a guard rejected the real
// recipient as readily as the hostile one and every assertion still passed.
check(sameVector(CODEX_JSON, 'nvoy_codex_jaf', LIVE_ARGS) === true,
  'NEGATIVE CONTROL — a correct entry in the JSON listing still matches')
check(sameVector(`nvoy-mc-claude: ${SSH_BIN} ${LIVE_ARGS.join(' ')}`, 'nvoy-mc-claude', LIVE_ARGS) === true,
  'NEGATIVE CONTROL — and a correct entry with no ✔ status suffix on the line still matches')
check(sameVector(`nvoy-mc-claude: ${SSH_BIN} ${LIVE_ARGS.join(' ')} - ✗ Failed to connect`, 'nvoy-mc-claude', LIVE_ARGS) === true,
  'NEGATIVE CONTROL — and one whose status says Failed to connect, which is EXPECTED while the real channel holds the lock')

// null is not false, and this is the distinction the caller acts on: `!null` would report a
// comparison that never ran as a mismatch, and the operator would go diffing a correct entry.
console.log('\n7b. and when nothing could be compared at all')
check(sameVector(CLAUDE_LIST, 'nvoy-mc-claude', null) === null, 'no vector to compare against is null, not false')
check(sameVector(CLAUDE_LIST, 'nvoy-mc-claude', []) === null, 'and neither is an empty one — that would match nothing and read as a mismatch')
check(sameVector(CLAUDE_LIST, 'nvoy-notregistered', LIVE_ARGS) === null, 'a server absent from the listing is null')
check(sameVector(null, 'nvoy-mc-claude', LIVE_ARGS) === null, 'unreadable output is null')
check(sameVector(`nvoy-mc-claude: ${SSH_BIN} - ✔ Connected`, 'nvoy-mc-claude', LIVE_ARGS) === null,
  'a line with a command and no arguments is null — nothing was read, so nothing is claimed')
check(sameVector('nvoy-mc-claude: - ✔ Connected', 'nvoy-mc-claude', LIVE_ARGS) === null,
  'and a line with no command at all is null, not a comparison against its status text')

// ── 8. The stanza that is PRINTED, not the vector one layer under it ─────────────────────────
console.log('\n8. what --stanza emits is the registration, not a superset of it')
// The round-2 blocker: section 1 asserts on `channelCommand(...).args`, and the tool hands that to
// `channelStanza`, which appended `--instance <agent>` and an env entry. Everything past an ssh
// target is the remote command, and ssh forwards no env — so the printed stanza was 20 args and an
// env block while the live entry is 18 and none, and no assertion anywhere could see it. Asserting
// one layer below the value that ships is the same defect this PR exists to fix.
const shipped = channelStanza({ agent: 'mc-claude', command: built.command, args: built.args, instanceRoot: `${ROOT}/instances`, verbatim: true })
check(JSON.stringify(shipped.args) === JSON.stringify(LIVE_ARGS),
  'the stanza the tool prints carries exactly the live vector — no --instance appended after the ssh target')
check(shipped.command === SSH_BIN, 'and the command it names is ssh by absolute path')
check(JSON.stringify(shipped.env) === '{}',
  'and its env is empty: an env entry on an ssh stanza is set in the LOCAL process and reaches nothing on the far side')
check(shipped.args.at(-1) === 'root@nave.pub',
  'so the target is the last argument — anything after it would be sent as the remote command')
check(sameVector(`nvoy-mc-claude: ${SSH_BIN} ${shipped.args.join(' ')} - ✔ Connected`, 'nvoy-mc-claude', shipped.args) === true,
  'and an entry registered FROM this stanza compares equal to it — the round trip the operator is told to run')
// Both directions. `verbatim` has to be what does this, not an accident of the vector: the default
// form still appends, which is what a local spawn needs.
const localStanza = channelStanza({ agent: 'mc-claude', command: 'node', args: ['server.mjs'], instanceRoot: `${ROOT}/instances` })
check(localStanza.args.includes('--instance') && localStanza.env.NVOY_INSTANCE_ROOT === `${ROOT}/instances`,
  'NEGATIVE CONTROL — the default form still appends --instance and the env root, which a local spawn needs')
check(shipped.server === localStanza.server && shipped.server === 'nvoy-mc-claude',
  'and both forms register under the same server name')

// ── 9. The verdict the operator reads ────────────────────────────────────────────────────────
console.log('\n9. what the mcp-registration row says, driven through the tool')
// Everything above tests the exported functions. The row is assembled in `connect-agent.mjs` from
// their answers, and that is the layer where the last two defects lived: `unknown` spent the credit
// `registeredForm` was careful not to give away, and an ssh entry pointing at the wrong host read
// healthy. Neither is visible from a function test, so drive the tool with a fake `claude` on PATH
// and read the row it prints.
const probeRoot = mkdtempSync(join(tmpdir(), 'wb-mcpreg-'))
const binDir = join(probeRoot, 'bin')
mkdirSync(binDir, { recursive: true })
const AGENT = 'mc-claude'
const AGENT_ROOT = join(probeRoot, AGENT)
// The vector the tool will build for THIS root, so the fixtures are the tool's own stanza rather
// than a hand-typed copy that can drift from it.
const toolArgs = channelCommand({ instanceRoot: AGENT_ROOT, host: HOST }).args

// The fake runtime replaces PATH rather than extending it, so a real `codex` on the machine cannot
// answer with the operator's own registrations and make this suite depend on the laptop it runs on.
//
// The shebang is `#!/bin/sh` and node is a SHELL-QUOTED ARGUMENT, not part of the interpreter line.
// This was `#!${process.execPath}`, and the kernel splits a shebang at the first space: on this
// nest node lives under `~/Library/Application Support/Buzz/runtimes/…`, so the interpreter
// resolved to `/Users/…/Library/Application` and the stub could not exec. With PATH stripped
// nothing else answered either, the tool honestly reported "no MCP host CLI on this machine", and
// all five assertions below failed — blaming `connect-agent` for a broken fixture. CI's node has no
// space in its path, so the suite was green there and red on every machine the crew works on (#472
// review). `/bin/sh` is resolved by the kernel from an absolute path that has no space, and the
// stripped PATH — which is the whole point of the harness — costs nothing.
//
// Do not reintroduce a `cat` pipe here: with PATH stripped `cat` is not on it, the stub exits 127,
// and the failure looks identical to the one above.
const shq = s => `'${String(s).replace(/'/g, "'\\''")}'`
const runTool = listing => {
  writeFileSync(join(binDir, 'claude'),
    `#!/bin/sh\nexec ${shq(process.execPath)} -e ${shq(`process.stdout.write(${JSON.stringify(listing + '\n')})`)}\n`,
    { mode: 0o755 })
  const args = [join(ROOT_DIR, 'tools', 'connect-agent.mjs'), '--name', AGENT, '--root', probeRoot,
    '--check', '--channel-host', HOST]
  try {
    return execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PATH: binDir } })
  } catch (e) { return typeof e?.stdout === 'string' ? e.stdout : '' }
}
const regRow = out => (out.split('\n').find(l => /Registered as an MCP server/.test(l)) || '')

// A tool that produced nothing has told us nothing. Exit 3, not a pass.
//
// The UNKNOWN case is checked too, and it is the one that actually bit. A broken fixture does not
// silence the row — the tool prints an honest `[ - ] … UNKNOWN — no MCP host CLI on this machine`,
// which is a row, so a guard that only asks whether the row EXISTS waves it through and lets the
// five assertions below fail one by one as though `connect-agent` had regressed. The harness cannot
// distinguish "the runtime said nothing useful" from "the tool got it wrong", so it must refuse to
// judge rather than report the difference as a defect. Every assertion here needs a runtime that
// answered; if none did, that is INCONCLUSIVE and it is the fixture that is broken.
const sshOut = runTool(`nvoy-${AGENT}: ${SSH_BIN} ${toolArgs.join(' ')} - ✔ Connected`)
if (!regRow(sshOut) || /^\[ - \]/.test(regRow(sshOut).trim()) || /UNKNOWN/.test(regRow(sshOut))) {
  console.error('channel_registration: INCONCLUSIVE — no runtime answered, so the verdict was never observed.')
  console.error(`  row: ${regRow(sshOut).trim() || '(the tool printed no mcp-registration row at all)'}`)
  console.error('  This is NOT an all-clear, and it is NOT a defect in connect-agent — it is this')
  console.error('  harness failing to stand up a fake runtime. Check the `claude` stub in binDir.')
  rmSync(probeRoot, { recursive: true, force: true })
  process.exit(3)
}
// NEGATIVE CONTROL FIRST, so the three refusals below cannot be a row that never says ok.
check(/^\[ok \]/.test(regRow(sshOut).trim()) && /matching --stanza/.test(regRow(sshOut)),
  `NEGATIVE CONTROL — an ssh entry matching the stanza IS a tick — ${regRow(sshOut).trim().slice(0, 78)}`)

// MISSING, not merely "not a tick". This row is `blocking: true`, so MISSING stops the run and
// UNVERIFIED does not — and `registered = true` with nothing verified renders `?`, which is not a
// tick and is also not a refusal. Asserting only "no ok" cannot tell those two apart, and the
// difference is whether the operator is stopped or waved through.
const opaque = regRow(runTool(`nvoy-${AGENT}: node /opt/nvoy/mcp/dist/server.js - ✔ Connected`))
check(/^\[ x \]/.test(opaque.trim()) && /MISSING/.test(opaque),
  'a command that is neither the ssh form nor the retired one is MISSING, not present-and-unchecked — ✔ Connected is what the retired form printed too')
check(/neither the ssh form nor the retired one/.test(opaque),
  `and the reason names what it is, not just that it failed — ${opaque.trim().slice(0, 78)}`)

const retired = regRow(runTool(`nvoy-${AGENT}: node /home/agent/.nvoy/claude-channel.mjs --instance ${AGENT} - ✔ Connected`))
check(/^\[ x \]/.test(retired.trim()) && /RETIRED LOCAL FORM/.test(retired),
  'the retired local spawn is MISSING too, and is named as retired — this is the entry that lists as connected and reaches nothing')

// Form is not correctness: right shape, wrong host.
const wrongHost = regRow(runTool(`nvoy-${AGENT}: ${SSH_BIN} ${toolArgs.slice(0, -1).join(' ')} root@nave-old.pub - ✔ Connected`))
check(/^\[ x \]/.test(wrongHost.trim()) && /NOT the/.test(wrongHost),
  'and an ssh entry pointing at a different host is MISSING — connected is not connected to the right thing')

rmSync(probeRoot, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
assert.equal(fail, 0, `${fail} assertion(s) failed`)
