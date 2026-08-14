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
//     ssh form, two retired, one bare — with their real spellings, underscores and all. `A` and
//     `B` fixtures are how the last live outage stayed invisible.
import { strict as assert } from 'node:assert'
import {
  KEY_FILE, KNOWN_HOSTS_FILE, SSH_BIN, SSH_TEMPLATE,
  channelCommand, credentialPaths, credentialReport, isRetiredLocalForm, registeredForm,
} from '../src/channel_registration.mjs'

let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }
// Asserts the message, not only that it threw. Returns the message so a caller can narrow further.
const refusal = fn => { try { fn(); return null } catch (e) { return e.message } }

console.log('\nchannel_registration\n')

const ROOT = '/Users/fairwja/.nvoy/desktop/mc-claude'
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
  'nvoy: node /Users/fairwja/Projects/nvoy/mcp/dist/server.js - ✔ Connected',
  `nvoy-mc-claude: /usr/bin/ssh ${LIVE_ARGS.join(' ')} - ✔ Connected`,
  'nvoy-oliver: /Users/fairwja/.nvm/versions/node/v22.16.0/bin/node /Users/fairwja/Projects/connect/nvoy-macos-desktop-binder/mcp/tools/claude-channel.mjs --instance oliver - ✔ Connected',
  'nvoy-lukedog: /Users/fairwja/.nvm/versions/node/v22.16.0/bin/node /Users/fairwja/Projects/connect/nvoy-macos-desktop-binder/mcp/tools/claude-channel.mjs --instance lukedog - ✔ Connected',
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

console.log(`\n${pass} passed, ${fail} failed`)
assert.equal(fail, 0, `${fail} assertion(s) failed`)
