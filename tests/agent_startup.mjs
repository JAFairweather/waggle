// agent_startup — the file an agent's runtime reads before it does anything (#466).
//
// Two properties carry the whole suite, and both are asserted in BOTH directions because a check
// that only ever fires on the bad case cannot be told from one that fires on everything:
//
//   1. No secret reaches it. This file is written to disk and read into a model context every
//      session, so a pairing URI in it is a credential in a transcript.
//   2. Nothing unproven is stated as fact. An agent whose kind:10050 was never checked must be
//      told it was never checked. An agent that believes it is reachable and is not will report
//      the wall as broken — that exact confusion has cost this project a day more than once.
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MISSING, PRESENT, UNKNOWN, installState } from '../src/agent_install_state.mjs'
import { secretInText, startupDoc } from '../src/agent_startup.mjs'
import { RUNTIMES } from '../src/mcp_runtimes.mjs'
import { FLAGS, acceptableName, knownFlag, normaliseName, usageLine } from '../src/connect_flags.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

console.log('\nagent_startup\n')

console.log("0. the secret sweep, before anything is built")
// FIRST, deliberately. startupDoc THROWS when the sweep fires, so a sweep that flags everything
// takes the whole suite down before a single assertion runs — and a suite that dies reports zero
// failures, which is indistinguishable from a suite that passed. Assert the detector standing on
// its own, ahead of the first document.
check(secretInText("read docs/AGENT_BRIEF.md and post as yourself") === null,
  "NEGATIVE CONTROL — ordinary prose is not flagged: a detector that flags everything gets turned off")
check(secretInText("your key is " + "a".repeat(64)) === null,
  "NEGATIVE CONTROL — a 64-hex PUBLIC key is not a secret")
check(secretInText("bunker://abc?relay=wss://x") === "a bunker:// pairing URI",
  "and a real pairing URI still is, named rather than merely refused")
// The OTHER NIP-46 pairing URI. Missed by the first cut, in a tool whose whole domain is NIP-46
// pairings — an operator who can paste a bunker:// into --channel can paste a nostrconnect://.
check(secretInText("nostrconnect://a1b2?relay=wss://r&secret=deadbeef") === "a nostrconnect:// pairing URI",
  "and so is the other pairing URI, named as itself rather than lumped in with bunker://")
check(secretInText("connect to nostrconnect and see") === null,
  "NEGATIVE CONTROL — the bare word is not the scheme; the sweep matches the URI, not the topic")

const PUB = 'a'.repeat(64)
const CHAN = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
// Everything verified — the state an agent is MOST likely to be handed after a clean install, and
// the one where an overclaim does the most damage.
const allGood = installState(Object.fromEntries(
  ['identity', 'bunker-uri', 'bunker-client', 'signer-identity', 'signer-methods', 'nip05', 'profile',
    'admit-grant', 'dm-relays', 'manifest', 'state-dirs', 'channel-key', 'mcp-registration',
    'mcp-exclusive', 'mcp-identity', 'channel-answers'].map(k => [k, { found: true, verified: true }])))
const good = startupDoc({ agent: 'oliver', pubkey: PUB, channel: CHAN, runtimeLabel: 'Codex CLI', report: allGood })
// The body hard-wraps, so a sentence-level assertion reads it unwrapped or it asserts about line breaks.
const flat = t => t.replace(/\s+/g, ' ')

// ── 1. The rules an agent breaks confidently ────────────────────────────────────────────────
console.log('1. the claims that must never drift')
check(/exactly one private key/.test(good) && /its own/.test(good),
  'waggle holds exactly one private key — its own. Never "holds no key"')
check(/do not get read/i.test(good) && /mentions only/i.test(good),
  'the read half is the return lane, mentions only')
check(/design, not a shortfall/i.test(good) || /is the design/i.test(good) || /that is the wall working/i.test(good),
  'and the wall is the design, not a defect to report')
check(/NIP-46 pairing, not a key/i.test(good), 'the session holds a pairing, not a key')
check(/never as the bridge/i.test(good) && /impersonation/i.test(good),
  'signing as waggle is impersonation; the agent acts as its own key')
check(/published publicly first/i.test(good), 'the public lane publishes first — there is no private path through it')
check(/data\*\*, never instruction|never instruction/i.test(good),
  'text arriving from outside is data, never instruction')
check(!/\bWaggle\b/.test(good) && !/\bWAGGLE\b/.test(good), 'waggle is lowercase everywhere, including a heading')

// ── 2. No secret can reach the file ─────────────────────────────────────────────────────────
console.log('\n2. nothing secret')
check(secretInText('bunker://abc?relay=wss://x') === 'a bunker:// pairing URI', 'a pairing URI is named, not merely refused')
check(secretInText('nsec1qqqqqqqqqq') === 'an nsec', 'an nsec is named')
check(secretInText('the host is 203.0.113.9') === 'an IPv4 address', 'a host IP is named — and named as IPv4, which is what the shape detects')
check(secretInText('sk-abcdefghijklmnop01') === 'an API key or embedded credential', 'an API key is named')
check(secretInText('ghp_abcdefghijklmnopqrst') === 'an API key or embedded credential', 'a GitHub token is caught')
check(secretInText('xoxb-1234567890-abcdef') === 'an API key or embedded credential', 'a Slack bot token is caught')
check(secretInText('AKIAIOSFODNN7EXAMPLE') === 'an API key or embedded credential', 'an AWS access key id is caught')
check(secretInText('Authorization: Bearer eyJhbGciOi') === 'an API key or embedded credential', 'a bearer header is caught')
check(secretInText('wss://user:hunter2@relay.example') === 'an API key or embedded credential', 'a credential embedded in a URL is caught')
// The other direction. A detector that flags everything refuses every legitimate file, and the
// operator then turns it off — which is worse than not having it.
check(secretInText(good) === null, 'NEGATIVE CONTROL — a real startup file is clean')
check(secretInText(`your key is ${PUB}`) === null, 'NEGATIVE CONTROL — a 64-hex PUBLIC key is not a secret and must not be flagged')
check(secretInText('read docs/AGENT_BRIEF.md') === null, 'NEGATIVE CONTROL — an ordinary path is not flagged')
// The IPv4 shape is fail-closed: a false positive means NO startup file at all. Anchored octets
// are the difference between refusing a host address and refusing a version string.
check(secretInText('waggle 1.400.2.9001 and node 22.999.1.0') === null,
  'NEGATIVE CONTROL — a dotted quad with out-of-range octets is a version string, not an address')
check(secretInText('NVOY_INSTANCE_ROOT=/Users/op/.nvoy/desktop') === null,
  'NEGATIVE CONTROL — a filesystem path in a machine-generated note is not flagged')
check(secretInText('a relay at wss://relay.example/req') === null,
  'NEGATIVE CONTROL — an ordinary wss:// URL with no userinfo is not flagged')
check(good.includes(PUB), 'and the public key is actually in the file — an agent that does not know its own key cannot check anything')

let threw = ''
try {
  startupDoc({ agent: 'x', pubkey: PUB, channel: 'bunker://leak?relay=wss://r', report: allGood })
} catch (e) { threw = e.message }
check(/refusing to write/.test(threw) && /bunker/.test(threw),
  `a credential smuggled in through a field is REFUSED, and the reason names it — ${threw.slice(0, 60)}`)

// ── 3. It states what was checked, and no more ──────────────────────────────────────────────
console.log('\n3. proven, unproven, and never looked')
// The real shape after `--check`: this tool opens no sockets, so the relay-side rows are UNKNOWN.
const asChecked = installState({
  'bunker-uri': { found: true, verified: true },
  'signer-identity': { found: true, verified: false, note: 'expected aaaaaaaaaaaa… — prove with EXPECT_PUBKEY on the first send' },
  'dm-relays': { found: null, note: 'not checked here — publish with tools/publish-dm-relay-list.mjs' },
  'mcp-exclusive': { found: false, note: 'also registered: nvoy_codex_jaf (Codex CLI)' },
})
const partial = startupDoc({ agent: 'oliver', pubkey: PUB, runtimeLabel: 'Codex CLI', report: asChecked })
check(/never checked — do not assume either way/.test(partial), 'an UNKNOWN row says nobody looked, not that it is absent')
check(/MISSING — this does not work yet/.test(partial), 'a MISSING row says so plainly')
check(/present but NOT proven/.test(partial), 'an UNVERIFIED row is not allowed to read as confirmed')
check(/nothing can reach you/i.test(partial), 'and an unconfirmed inbound list gets the warning that an agent shipped write-only')
check(!/Every artifact above is confirmed/.test(partial),
  'a partial install is NOT told everything is confirmed')

check(/Every artifact above is confirmed/.test(good),
  'NEGATIVE CONTROL — the fully verified install IS told so, so this is not a doc that always warns')
check(/statement about what was checked, not a promise about the network/i.test(flat(good)),
  'and even then it does not promise the network — a publish is proven by reading it back')
check(!/never checked — do not assume/.test(good), 'a clean install carries no spurious "never checked"')

// The file must never be silent about a gap. Silence is what every failure in this project looks
// like, so an omitted row is the defect, not a tidier document.
for (const key of ['signer-identity', 'dm-relays', 'mcp-exclusive']) {
  const title = asChecked.rows.find(r => r.key === key).title
  check(partial.includes(title), `the ${key} row appears by name (${title.slice(0, 42)})`)
}

// ── 4. Per runtime ──────────────────────────────────────────────────────────────────────────
console.log('\n4. one document, four filenames')
check(RUNTIMES.every(r => typeof r.startupFile === 'string' && r.startupFile.endsWith('.md')),
  'every runtime declares the file it reads at session start')
check(RUNTIMES.find(r => r.id === 'claude').startupFile === 'CLAUDE.md', 'Claude Code reads CLAUDE.md')
check(RUNTIMES.find(r => r.id === 'codex').startupFile === 'AGENTS.md', 'Codex reads AGENTS.md')
check(RUNTIMES.find(r => r.id === 'gemini').startupFile === 'GEMINI.md', 'Gemini reads GEMINI.md')
check(RUNTIMES.find(r => r.id === 'generic').startupFile === 'AGENTS.md', 'a headless host gets AGENTS.md, the cross-tool convention')
// Pi (pi.dev) reads the same filename as Codex from a DIFFERENT set of directories — `~/.pi/agent/`,
// parent directories, and the cwd. The filename agreeing is not the file being found, which is why
// `--startup` prints the path it wrote instead of reporting that a runtime read it (#519).
check(RUNTIMES.find(r => r.id === 'pi').startupFile === 'AGENTS.md', 'Pi reads AGENTS.md too')
check(new Set(RUNTIMES.map(r => r.startupFile)).size >= 3,
  'and they are not all the same name — writing CLAUDE.md on a Codex box is a file nothing reads')

const asClaude = startupDoc({ agent: 'oliver', pubkey: PUB, channel: CHAN, runtimeLabel: 'Claude Code', report: allGood })
check(asClaude.includes('Claude Code') && good.includes('Codex CLI'), 'the body names the runtime it was written for')
check(asClaude.replace(/Claude Code/g, 'X') === good.replace(/Codex CLI/g, 'X'),
  'and is otherwise identical — one description, rendered per runtime, so they cannot drift apart')

// ── 5. Refusals ─────────────────────────────────────────────────────────────────────────────
console.log('\n5. what it refuses to write')
let noName = false
try { startupDoc({ pubkey: PUB, report: allGood }) } catch { noName = true }
check(noName, 'no agent name is a refusal, not a file addressed to nobody')
const noReport = startupDoc({ agent: 'oliver', pubkey: PUB })
check(/no install state was supplied — nothing here is confirmed/.test(noReport),
  'no install state says so, rather than rendering an empty list that reads as "all clear"')
check(noReport.includes('do not get read'), 'and the non-negotiable rules survive even with no state to report')
// The negative half. `state` and `open` are two filters over the same rows, and EMPTY rows satisfies
// both — so the document said "nothing here is confirmed" and "every artifact above is confirmed"
// twenty lines apart. Asserting only that the first line is PRESENT could never see it.
check(!/Every artifact above is confirmed/.test(noReport),
  'and is NOT also told everything is confirmed — the two branches are exclusive, not merely ordered')

// A claim about THIS AGENT must be rendered from its own row. Both of these read as flat fact
// before, in the section that reads as authoritative, for an agent holding neither.
const unpaired = startupDoc({ agent: 'oliver', pubkey: PUB, report: { rows: [
  { key: 'bunker-uri', title: 'Bunker pairing', state: MISSING },
  { key: 'admit-grant', title: 'Admitted to the channel', state: UNKNOWN },
] } })
check(/\*\*Yours:\*\* MISSING/.test(unpaired),
  'an agent with no pairing is told so where the pairing is described, not twenty lines below it')
check(/\*\*Your admission:\*\* never checked/.test(unpaired),
  'and an unverified admission is named as unverified, not asserted as "you post in"')
check(!/\*\*You hold a NIP-46 pairing, not a key\.\*\*/.test(unpaired),
  'NEGATIVE CONTROL — the flat second-person claim is GONE, not merely supplemented by a state line')
check(/Agents here hold a NIP-46 pairing, not a key/.test(unpaired) && /re-pairs to the same identity/.test(unpaired),
  'while the design statement still stands — it is true of the system whatever this install looks like')
const paired = startupDoc({ agent: 'oliver', pubkey: PUB, report: { rows: [
  { key: 'bunker-uri', title: 'Bunker pairing', state: PRESENT },
  { key: 'admit-grant', title: 'Admitted to the channel', state: PRESENT },
] } })
check(/\*\*Yours:\*\* confirmed/.test(paired) && /\*\*Your admission:\*\* confirmed/.test(paired),
  'NEGATIVE CONTROL — a genuinely paired, genuinely admitted agent is told plainly that it is')

// ── 5b. The mechanism, not only the shape ───────────────────────────────────────────────────
console.log('\n5b. the two lane commands')
// The document described participation exhaustively and never said HOW — the two tools that ARE
// the mechanism appeared nowhere outside their own file headers (#512). An agent that reads its
// brief and then has to ask how to listen has not been onboarded.
check(/agent-inbox\.mjs/.test(good) && /agent-send\.mjs/.test(good),
  'a working agent is given both commands by name')
check(/--pubkey/.test(good) && /--channel/.test(good),
  '…with the arguments each one refuses to guess')
// Both clauses, not an alternation. An alternation passes with either half deleted, so it cannot
// tell "states the trust rule" from "states half of it" — caught by mutation.
check(/anyone may seal mail to your key/.test(good) && /being\s+addressed is not authority/.test(good),
  'the listen half says that being addressed is not authority — the trust rule, not just the command')
check(/refuses a body with no `@name`/.test(good),
  'the speak half names the guard, so rule 5 has a mechanism attached to it')
check(/Do not report a send as delivered/.test(good),
  'and neither is offered as proof of delivery, which is the claim this project cannot make')

// BOTH DIRECTIONS. A section printed unconditionally proves nothing about whether it read the
// state, and handing an agent commands that cannot work is the flat-unproven-claim defect §5 exists
// to catch. `unpaired` holds a MISSING bunker row.
check(/Neither command works yet/.test(unpaired),
  'an agent with no pairing is warned the commands will not work')
// Bounded to the warning LINE. Splitting on the marker and testing the tail matched "Bunker pairing"
// from the install-state section forty lines below, so the assertion could not fail — caught by
// mutation, which emptied the title list and stayed green.
const warnLine = (unpaired.split('\n').find(l => l.includes('Neither command works yet')) || '')
check(/Bunker pairing/.test(warnLine),
  '…and told which piece is missing, on that line, rather than being sent to re-check everything')
check(!/Neither command works yet/.test(good),
  'NEGATIVE CONTROL — a working agent is NOT warned; the warning tracks the state, it is not decoration')
// The bug this commit fixed: a piece with NO row read as satisfied, so a document built from no
// install state at all handed over both commands with no warning at all.
check(/Neither command works yet/.test(noReport),
  'a document built from NO install state warns too — an unsupplied row is unknown, not satisfied')
// The third state matters separately: never-checked is not absent, and telling an agent its lane is
// broken when nobody looked sends it to fix a thing that may be fine.
const laneUnchecked = startupDoc({ agent: 'oliver', pubkey: PUB, report: { rows: [
  { key: 'bunker-uri', title: 'Bunker pairing', state: UNKNOWN },
] } })
check(/was never checked, which is not the same as absent/.test(laneUnchecked),
  'an unchecked pairing is reported as unchecked, not as missing')

// The must-fix from the #514 review: the documented speak command could not run. `--bridge` is the
// FIRST check in tools/agent-send.mjs — ahead of the signer, ahead of the body — and nothing in the
// install path supplies it, so a fully-installed agent got the command and no caveat, and exit 3.
console.log('\n5c. the speak command can actually be run')
const BRIDGE = 'c'.repeat(64)
const withBridge = startupDoc({ agent: 'oliver', pubkey: PUB, channel: CHAN, bridge: BRIDGE,
  runtimeLabel: 'Codex CLI', report: allGood })
const speakLine = l => (l.split('\n').find(x => x.includes('agent-send.mjs')) || '')
check(/--bridge/.test(speakLine(withBridge)), 'the speak command names --bridge, which the tool refuses to run without')
check(speakLine(withBridge).includes(BRIDGE),
  '  …filled in with the actual key when the caller knew it, not left as a placeholder to resolve elsewhere')
check(speakLine(withBridge).includes(CHAN),
  '  …and the channel too — a pasted prompt has no somewhere-else to look these up')
const listenLine = l => (l.split('\n').find(x => x.includes('agent-inbox.mjs')) || '')
check(listenLine(withBridge).includes(PUB), 'the listen command carries the agent\'s own key for the same reason')
check(!/⚠ \*\*`--bridge` is not filled in/.test(withBridge),
  'NEGATIVE CONTROL — no caveat when the value IS known; the warning tracks the value, it is not decoration')

// BOTH DIRECTIONS. `good` is the same fully-installed agent with no bridge supplied — the exact case
// the review ran, where every lane row is PRESENT so the existing warning block stays silent.
check(/--bridge/.test(speakLine(good)),
  'with no bridge supplied the flag is STILL printed — an omitted flag is what made the command look complete')
check(/⚠ \*\*`--bridge` is not filled in/.test(good),
  '  …and a fully-installed agent is told it is unresolved, rather than handed a command that exits 3')
check(/will not guess|refuses to guess/.test(good), '  …and told the tool refuses to guess it, which is what it does')
check(/not a secret/.test(good), '  …and that it is a public key, so nobody withholds it as a credential')

// The should-fix: the never-checked caveat was all-or-nothing, so one MISSING piece stated two
// unexamined ones flatly as absent — what the fourth state exists to prevent.
const laneMixed = startupDoc({ agent: 'oliver', pubkey: PUB, report: { rows: [
  { key: 'bunker-uri', title: 'Bunker pairing', state: MISSING },
  { key: 'bunker-client', title: 'Client transport key', state: UNKNOWN },
] } })
const mixedLine = (laneMixed.split('\n').find(l => l.includes('Neither command works yet')) || '')
check(/Bunker pairing is not in place/.test(mixedLine), 'a MISSING piece beside an unchecked one is still reported missing')
check(/Client transport key was never checked/.test(mixedLine),
  '  …and the unchecked one KEEPS its own state — all-or-nothing silenced this the moment the states mixed')

// ── 5d. the check command names the lane it was checked under ───────────────────────────────
console.log('\n5d. the remedy command carries the right lane')
// The document tells the reader to settle its state with `connect-agent --check`. That command was
// written with `--lane sealed` baked into the string, so a BROKER-lane agent following its own
// onboarding document scoped out the rows it depends on — `applies` refusing to assume the cheaper
// lane, arriving through the document instead of the flag.
// `--check`, not just the tool name: the document also names `tools/connect-agent.mjs --startup` as
// its own provenance, and that line is not a remedy. A filter that swept it in would assert the
// lane flag against a line that has no business carrying one.
const remedies = doc => doc.split('\n').filter(l => l.includes('tools/connect-agent.mjs') && l.includes('--check'))
const laneDoc = lane => startupDoc({ agent: 'oliver', pubkey: PUB,
  report: { lane, rows: [{ key: 'bunker-uri', title: 'Bunker pairing', state: MISSING },
    { key: 'profile', title: 'Published profile', state: UNKNOWN }] } })

const broker = remedies(laneDoc('broker'))
check(broker.length >= 2, 'the document prints the remedy command more than once, so one right and one wrong is possible')
check(broker.every(l => /--check --lane broker/.test(l)),
  'a BROKER-lane report renders --lane broker in EVERY remedy line')
check(!broker.some(l => /--lane sealed/.test(l)),
  '  …and never the other lane — this rendered `--lane sealed` for a broker agent')
const sealedDoc = remedies(laneDoc('sealed'))
check(sealedDoc.every(l => /--check --lane sealed/.test(l)),
  'BOTH DIRECTIONS — a SEALED-lane report still renders --lane sealed, so the fix is not "drop the flag"')
// Undeclared is not sealed — `installState` treats silence as "every row applies", and a document
// that supplied the flag anyway would talk an undeclared agent into the permissive reading.
const noLane = remedies(laneDoc(null))
check(noLane.length >= 2 && noLane.every(l => !/--lane/.test(l)),
  'an UNDECLARED lane prints no --lane at all — silence is not a declaration here either')
check(remedies(laneDoc('brokr')).every(l => !/--lane/.test(l)),
  'an unrecognised lane is DROPPED, not echoed — `installState` would refuse it, so printing it hands over a command that fails')

console.log('\n5e. the remedy command is one that RUNS')
// Every assertion above is about the text of the command, and the text was right while the command
// was not: `connect-agent --check --lane sealed` is not on PATH (exit 127) and omits the --name the
// tool requires. Asserting the property means running it, not grepping it (#522).
const cmdOf = doc => {
  const m = doc.match(/`(node tools\/connect-agent\.mjs[^`]*)`/)
  return m ? m[1] : null
}
const sealedCmd = cmdOf(laneDoc('sealed'))
check(sealedCmd !== null, 'the remedy renders as `node tools/…`, the same form as the two tools named beside it')
check(/--name \S+/.test(sealedCmd || ''), '…and carries --name, which the tool cannot run without')

// Drive it. Exit 127 is "no such command", exit 1 with a usage line is "you called it wrong"; both
// were what the old string produced, and neither is what a remedy may do.
const remedyRoot = mkdtempSync(join(tmpdir(), 'wb-remedy-'))
let remedyRc = -1, remedyOut = ''
try {
  execFileSync('/bin/sh', ['-c', `${sealedCmd} --root ${remedyRoot}`], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
  remedyRc = 0
} catch (e) { remedyRc = e.status; remedyOut = `${e.stdout || ''}${e.stderr || ''}` }
check(remedyRc !== 127, `the documented command EXISTS — it exited 127, command-not-found, until #522 (rc=${remedyRc})`)
check(!/usage:/.test(remedyOut), 'and it is not a usage error — the tool understood every flag the document told the agent to pass')
check(/Declared participation lane/.test(remedyOut) && /sealed/.test(remedyOut),
  '…and it did the thing it was documented to do: reported install state, scoped to the declared lane')
// POSITIVE CONTROL on the probe itself. If `execFileSync` silently succeeded on anything, the three
// checks above would pass for a command that does nothing.
let bogusRc = 0
try { execFileSync('/bin/sh', ['-c', 'connect-agent --check'], { cwd: ROOT, stdio: 'pipe' }) } catch (e) { bogusRc = e.status }
check(bogusRc === 127, 'POSITIVE CONTROL — the OLD rendering still exits 127 here, so the probe can tell the difference')
rmSync(remedyRoot, { recursive: true, force: true })

console.log('\n5f. the name in the rendered command is one --name accepts')
// This line used to QUOTE a name it could not use, which buys a clean argv split and nothing else:
// `--name` is lowercased and matched against a pattern, so a name that needed quoting to survive
// splitting is a name the tool then refuses. The operator who named an agent `Pi Dog` pasted the
// rendered command and got exit 1 and a usage line (#523 review).
const nameDoc = agent => startupDoc({ agent, pubkey: PUB,
  report: { lane: 'sealed', rows: [{ key: 'bunker-uri', title: 'Bunker pairing', state: MISSING },
    { key: 'profile', title: 'Published profile', state: UNKNOWN }] } })

const okName = remedies(nameDoc('oliver'))
check(okName.length >= 2 && okName.every(l => /--name oliver\b/.test(l)),
  'BOTH DIRECTIONS — a name the tool ACCEPTS still renders a command, in every remedy line')
// The exact disagreement the hand-copied predicate had on day one: it omitted `.toLowerCase()`, so
// `Oliver` was quoted by the renderer and accepted by the tool. One predicate now, so both lower.
const upper = remedies(nameDoc('Oliver'))
check(upper.length >= 2 && upper.every(l => /--name oliver\b/.test(l) && !/--name ['"]/.test(l)),
  'a name that only needed LOWERCASING is lowercased and rendered bare, not quoted')

const badDoc = nameDoc('Pi Dog')
check(remedies(badDoc).length === 0,
  'a name the tool REFUSES renders no command at all — the document does not state a fact it does not have')
// `--name` still appears, inside the rule the document states; what must not appear is an ARGUMENT
// after it — a quoted one is the old behaviour and a bare one would split into two argv words.
check(!/--name\s/.test(badDoc), '…and --name is never given an argument, quoted or bare')
check(badDoc.includes('Pi Dog') && /Settle the agent's id first/.test(badDoc),
  'it names the offending name and what to settle — "settle your name" with neither is not actionable')
check(/lowercase, 2–64 characters/.test(badDoc) && /a-z0-9\._-/.test(badDoc),
  '…and states the rule, so the reader can pick a name that will work rather than guess again')
// NEGATIVE CONTROL on the block above: a document that simply went silent would pass every
// "no command" assertion. The two sections that carry the remedy must still be present and say why.
check(/Neither command works yet/.test(badDoc) && /never checked/.test(badDoc),
  'NEGATIVE CONTROL — the refusing document still renders both sections; it withholds the command, not the warning')

// The renderer and the tool must AGREE, and the only way to know is to drive the tool. Ten fixtures,
// both verdicts represented, run through the real argv path — spaces and all, hence execFileSync
// with an array rather than a shell string.
const nameRoot = mkdtempSync(join(tmpdir(), 'wb-name-'))
const toolTakes = n => {
  try {
    execFileSync(process.execPath, [join(ROOT, 'tools', 'connect-agent.mjs'), '--name', n,
      '--check', '--root', nameRoot], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    return true
  } catch (e) { return !/usage:/.test(`${e.stdout || ''}${e.stderr || ''}`) }
}
const NAME_FIXTURES = ['oliver', 'Oliver', 'pi-dog', 'Pi Dog', 'mc-claude', 'my.dude_1',
  'a', '@dennis', 'Dennis', 'has/slash']
let agreed = 0
for (const n of NAME_FIXTURES) {
  const r = acceptableName(n), t = toolTakes(n)
  check(r === t, `renderer and tool agree on ${JSON.stringify(n)} — both ${r ? 'accept' : 'refuse'}`)
  if (r === t) agreed++
}
check(NAME_FIXTURES.some(acceptableName) && !NAME_FIXTURES.every(acceptableName),
  `POSITIVE CONTROL — the fixture set exercises BOTH verdicts (${agreed}/${NAME_FIXTURES.length} agreed), so agreement is not "it refuses everything"`)
check(normaliseName('Pi Dog') === 'pi dog' && !acceptableName('pi dog'),
  'normalising is not accepting — lowercasing a name with a space does not make it a name')
rmSync(nameRoot, { recursive: true, force: true })

// The usage line is the message an agent acts on when it gets the call wrong, and it had drifted to
// five of nineteen flags — omitting every flag #513, #514 and #519 added. Rendered from the
// catalogue now, so this asserts the catalogue and the tool agree rather than re-checking a literal.
const usage = usageLine()
for (const f of FLAGS) check(usage.includes(f.flag), `usage names ${f.flag}`)
const readsFlags = [...readFileSync(join(ROOT, 'tools', 'connect-agent.mjs'), 'utf8')
  .matchAll(/(?:flag|has)\('(--[a-z-]+)'\)/g)].map(m => m[1])
check(readsFlags.length > 0, 'the source scan found flags at all — a scan that matches nothing reports everything clean')
const undeclared = [...new Set(readsFlags)].filter(f => !knownFlag(f))
check(undeclared.length === 0, `every flag the tool reads is declared${undeclared.length ? ` — undeclared: ${undeclared.join(' ')}` : ''}`)
check(!knownFlag('--not-a-flag'), 'NEGATIVE CONTROL — knownFlag says no to a name that is not in the catalogue')

// ── 6. The tool, not the function ───────────────────────────────────────────────────────────
console.log('\n6. what connect-agent actually writes')
// Everything above tests `startupDoc`, which is handed a pubkey. The tool is not, and that gap
// shipped a real defect: `--startup` on a Pi is run WITHOUT `--pubkey` — the manifest is the whole
// reason it does not need one — so the tool passed `undefined` and wrote a file that never named
// the agent's own key. §2 asserts that key must be in the file. It was, in the fixture, and was not
// in the artifact. So drive the tool and read what lands.
const probeRoot = mkdtempSync(join(tmpdir(), 'wb-startup-probe-'))
const runStartup = (agent, extra = []) => {
  const args = [join(ROOT, 'tools', 'connect-agent.mjs'), '--name', agent, '--root', probeRoot,
    '--startup', '--runtime', 'generic', '--print', ...extra]
  try {
    return execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) { return typeof e?.stdout === 'string' ? e.stdout : null }
}
const TOOL_PUB = 'e'.repeat(64)
mkdirSync(join(probeRoot, 'seated', 'instances'), { recursive: true })
writeFileSync(join(probeRoot, 'seated', 'instances', 'seated.json'), JSON.stringify({
  version: 1, id: 'seated', pubkey: TOOL_PUB, grantors: [], task_carriers: [],
  relays: ['wss://nos.lol'], broker_mode: 'local', delivery_mode: 'notify_only',
}) + '\n')

const seated = runStartup('seated')
// A tool that could not run has told us nothing — that is INCONCLUSIVE, not a pass.
if (seated === null || seated.length < 500) {
  console.error(`agent_startup: INCONCLUSIVE — connect-agent --startup produced ${seated === null ? 'no output' : `only ${seated.length} bytes`}`)
  console.error('  This is NOT an all-clear: the tool was never observed writing anything.')
  rmSync(probeRoot, { recursive: true, force: true })
  process.exit(3)
}
check(seated.includes(TOOL_PUB),
  'the written file names the key the MANIFEST holds, with no --pubkey on the command line')
check(/act as this key/.test(seated), 'and says plainly that this is the key the agent acts as')

// The other direction, and the reason this is not just "always print something": with no manifest
// there is no key, and the file must stay silent rather than invent one. A startup file asserting a
// key the agent does not hold is worse than one that omits it — the agent would check against it.
const unseated = runStartup('nomanifest')
check(unseated !== null && !/act as this key/.test(unseated),
  'NEGATIVE CONTROL — no manifest, no key line: the tool does not invent one to fill the slot')
check(unseated !== null && /nomanifest/.test(unseated),
  'and the file is still written and still addressed to the agent')

// ── 7. The boundary allowlist ───────────────────────────────────────────────────────────────
console.log('\n7. the two pasted fields are held to a shape before anything renders them')
// `secretInText` is a denylist over rendered text, and no denylist can be proven complete. The two
// fields an operator pastes into DO have a shape, so they are checked at the boundary and the
// smuggling case becomes unreachable rather than caught. Asserted through the tool, because the
// boundary is in the tool: the exported function still has to accept whatever it is handed.
const runRaw = (extra = [], name = 'boundary') => {
  const args = [join(ROOT, 'tools', 'connect-agent.mjs'), '--name', name, '--root', probeRoot,
    '--startup', '--runtime', 'generic', ...extra]
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    return { code: typeof e?.status === 'number' ? e.status : -1, stdout: String(e?.stdout ?? ''), stderr: String(e?.stderr ?? '') }
  }
}
const smuggled = runRaw(['--print', '--channel', 'bunker://leak?relay=wss://r&secret=deadbeef'])
check(smuggled.code === 1, 'a bunker:// URI in --channel exits 1 rather than rendering')
// The REASON matters, not only the refusal. If this reported the sweep's message the boundary did
// not fire and the guarantee is still the denylist's — same exit code, different property.
check(/--channel must be a channel uuid/.test(smuggled.stderr),
  `and is refused at the boundary as a malformed --channel, not caught downstream — ${smuggled.stderr.trim().slice(0, 70)}`)
check(!/bunker/.test(smuggled.stdout + smuggled.stderr),
  'and the URI itself is not echoed back at the operator — a refusal that reprints the secret has moved it, not stopped it')

const badKey = runRaw(['--print', '--pubkey', 'nope'])
check(badKey.code === 1 && /--pubkey must be 64-character hex/.test(badKey.stderr),
  'a malformed --pubkey is refused on --startup too — its only other check sits in the manifest branch --startup skips')

// Both directions. A boundary that refuses everything refuses every real run.
// Run against `seated`, which §6 gave a manifest: supplying --pubkey takes the manifest path, and
// a boundary that refuses a legitimate value would fail here for a reason that is not the manifest.
const okRun = runRaw(['--print', '--channel', CHAN, '--pubkey', TOOL_PUB], 'seated')
check(!/must be/.test(okRun.stderr),
  'NEGATIVE CONTROL — a real uuid and a real 64-hex pubkey are not refused')
check(okRun.stdout.includes(CHAN),
  'and the channel reaches the document, so the allowlist is passing the value through rather than dropping it')
check(okRun.stdout.includes(TOOL_PUB), 'and so does the pubkey')

// §4: the remedy line is a command the operator pastes. Without --root it reads a different agent
// root, and without --channel it renders a different document — so the comparison it exists for is
// against the wrong file.
const writeOnce = runRaw(['--channel', CHAN], 'remedy')
const again = runRaw(['--channel', CHAN], 'remedy')
check(/wrote /.test(writeOnce.stdout) && /unchanged:/.test(again.stdout),
  'the first run writes the file and the second reports it unchanged')
const remedy = (again.stdout.split('\n').find(l => l.includes('compare it against a fresh one')) || '')
check(remedy.includes(`--root ${probeRoot}`),
  `the remedy command carries --root — ${remedy.trim().slice(0, 90)}`)
check(remedy.includes(`--channel ${CHAN}`), 'and carries --channel, so the fresh file is comparable to the one on disk')

rmSync(probeRoot, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
assert.equal(fail, 0, `${fail} assertion(s) failed`)
