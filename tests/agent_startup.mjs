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
import { MISSING, PRESENT, UNKNOWN, UNVERIFIED, installState } from '../src/agent_install_state.mjs'
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
// The agent's instance directory — where its credentials and spool live. A DIFFERENT directory from
// the checkout, and the reader's actual working directory (#583).
const INST = '/opt/agents/oliver'
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
check(/Nothing has checked whether these commands can run/.test(noReport),
  'a document built from NO install state warns too — an unsupplied row is unknown, not satisfied')
// …and warns in the never-checked words rather than the absent ones (#583). This used to reach
// `Neither command works yet`, which is a flat claim about a lane nothing looked at — the same
// overclaim the UNVERIFIED split removed one state along, in the one state left. It matters because
// the console renders this document for a machine it has never seen, so ALL of its lane rows are
// unknown and every prompt it emitted opened by telling the agent its lane was down.
check(!/Neither command works yet/.test(noReport),
  '  …and NOT in the words for a credential that is genuinely absent — nobody looked, which is a different fact')
check(/on the agent's own machine/.test(noReport),
  '  …and points the check at the machine that can see the files, rather than telling the reader to wait')
// The third state matters separately: never-checked is not absent, and telling an agent its lane is
// broken when nobody looked sends it to fix a thing that may be fine.
const laneUnchecked = startupDoc({ agent: 'oliver', pubkey: PUB, report: { rows: [
  { key: 'bunker-uri', title: 'Bunker pairing', state: UNKNOWN },
] } })
check(/was never checked, which is not the same as absent/.test(laneUnchecked),
  'an unchecked pairing is reported as unchecked, not as missing')
check(/Both commands may well work/.test(laneUnchecked),
  '  …and the agent is told to try them, because one that reads "this does not work" does not')
// NEGATIVE CONTROL for the split, and it is the one that matters: a single genuinely MISSING piece
// beside unchecked ones must still produce the hard heading, or this has just deleted the warning.
check(/Neither command works yet/.test(startupDoc({ agent: 'oliver', pubkey: PUB, report: { rows: [
  { key: 'bunker-uri', title: 'Bunker pairing', state: UNKNOWN },
  { key: 'bunker-client', title: 'Client transport key', state: MISSING },
] } })),
  'NEGATIVE CONTROL — one MISSING piece among unchecked ones still says neither command works')

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

// The same collapse, one state along (#541). UNVERIFIED reached the `is not in place` verb because
// it was merely "not PRESENT", so a pairing sitting at mode 600 and only unproven read as absent,
// under a heading saying neither command works. pi-dog was in that state on a day both commands ran,
// one of them into the Buzz channel — so the document told a working agent its lane was down and
// sent it to create a key it already held.
const laneUnproven = startupDoc({ agent: 'oliver', pubkey: PUB, report: { rows: [
  { key: 'bunker-uri', title: 'Bunker pairing', state: UNVERIFIED },
  { key: 'bunker-client', title: 'Client transport key', state: PRESENT },
  { key: 'signer-identity', title: 'Signer resolves to the right key', state: UNVERIFIED },
] } })
const unprovenLine = (laneUnproven.split('\n').find(l => l.includes('was not proven from this machine')) || '')
check(/Bunker pairing is in place but was not proven/.test(unprovenLine),
  'an UNVERIFIED pairing is reported as unproven, NOT as absent')
check(!/is not in place/.test(unprovenLine),
  '  …and the missing-verb never appears on that line — that verb sends an agent to re-create a key it holds')
check(!/Neither command works yet/.test(laneUnproven),
  'and the heading does not claim the commands are broken when nothing is actually absent')
check(/Not everything here was proven from this machine/.test(laneUnproven),
  '  …it says what is true instead: unproven, which is a different fact from broken')
check(/running them is/.test(laneUnproven) && /--expect/.test(laneUnproven),
  '  …and points at the instruments that settle it, because an agent told "this does not work" does not try')

// NEGATIVE CONTROL, and it is the one that matters: a document that always warns and one that never
// warns fail identically. One genuinely MISSING piece beside the unproven ones must still produce
// the hard heading — otherwise the change above has just deleted the warning.
const laneUnprovenPlusMissing = startupDoc({ agent: 'oliver', pubkey: PUB, report: { rows: [
  { key: 'bunker-uri', title: 'Bunker pairing', state: UNVERIFIED },
  { key: 'bunker-client', title: 'Client transport key', state: MISSING },
  { key: 'signer-identity', title: 'Signer resolves to the right key', state: UNVERIFIED },
] } })
check(/Neither command works yet/.test(laneUnprovenPlusMissing),
  'NEGATIVE CONTROL — one MISSING piece still produces the hard warning, unproven neighbours notwithstanding')
const bothLine = (laneUnprovenPlusMissing.split('\n').find(l => l.includes('Neither command works yet')) || '')
check(/Client transport key is not in place/.test(bothLine) && /Bunker pairing is in place but was not proven/.test(bothLine),
  '  …and each piece still carries its OWN verb on that line, rather than the worst one spreading')

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
const laneDoc = (lane, extra = {}) => startupDoc({ agent: 'oliver', pubkey: PUB, ...extra,
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
  const m = doc.match(/`(node \S*tools\/connect-agent\.mjs[^`]*)`/)
  return m ? m[1] : null
}
const sealedCmd = cmdOf(laneDoc('sealed', { repo: ROOT }))
check(sealedCmd !== null, 'the remedy renders as `node …/tools/…`, the same form as the two tools named beside it')
check(/--name \S+/.test(sealedCmd || ''), '…and carries --name, which the tool cannot run without')

// AND IT IS RUN FROM WHERE THE AGENT STANDS, which is not the checkout. `--startup` writes into the
// instance directory and the runtime reads it there, so that directory — holding this file and
// nothing else — is the cwd every command in the document is executed from. Running the probe in
// ROOT was the whole reason a repo-relative command passed this suite and failed on a real Pi
// (#524). The temp root doubles as that cwd: same shape, no `tools/`.
const remedyRoot = mkdtempSync(join(tmpdir(), 'wb-remedy-'))
let remedyRc = -1, remedyOut = ''
try {
  execFileSync('/bin/sh', ['-c', `${sealedCmd} --root ${remedyRoot}`], { cwd: remedyRoot, encoding: 'utf8', stdio: 'pipe' })
  remedyRc = 0
} catch (e) { remedyRc = e.status; remedyOut = `${e.stdout || ''}${e.stderr || ''}` }
check(remedyRc !== 127, `the documented command EXISTS — it exited 127, command-not-found, until #522 (rc=${remedyRc})`)
check(!/Cannot find module/.test(remedyOut), 'and it RESOLVES from the agent\'s own directory — a repo-relative path dies here with a module error (#524)')
check(!/usage:/.test(remedyOut), 'and it is not a usage error — the tool understood every flag the document told the agent to pass')
check(/Declared participation lane/.test(remedyOut) && /sealed/.test(remedyOut),
  '…and it did the thing it was documented to do: reported install state, scoped to the declared lane')

// NEGATIVE CONTROL, and the sharp one. The pre-#524 rendering — the same command, repo-relative —
// run from the same cwd. It must fail, and it must fail with exit 1: identical to the exit an
// unseated credential gives, which is why the agent read "I am in the wrong place" as "I am not
// onboarded" and reported itself unable to participate.
const relCmd = sealedCmd.replace(`${ROOT}/`, '')
check(!relCmd.includes(ROOT), 'ANCHOR — the control really is the repo-relative form, not a copy of the absolute one')
let relRc = 0, relOut = ''
try { execFileSync('/bin/sh', ['-c', `${relCmd} --root ${remedyRoot}`], { cwd: remedyRoot, encoding: 'utf8', stdio: 'pipe' }) } catch (e) { relRc = e.status; relOut = `${e.stdout || ''}${e.stderr || ''}` }
check(relRc === 1 && /Cannot find module/.test(relOut),
  'NEGATIVE CONTROL — the OLD repo-relative rendering dies here, and exits 1: the same code as a missing credential')
// POSITIVE CONTROL on the probe itself. If `execFileSync` silently succeeded on anything, the checks
// above would pass for a command that does nothing.
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

console.log('\n5g. every path the document names resolves from the agent, or says it does not')
// Both directions. With a repo, nothing repo-relative may survive anywhere in the document — the
// listen and speak commands and the three doc references are as unrunnable from the instance
// directory as the remedy was, and fixing only the one that had an issue number is how the next
// one gets found by a Pi instead of by this suite.
// The provenance line is excluded, and by an anchored sentinel rather than by matching its words:
// it names the command that WROTE this file, on the machine that wrote it, which is not a path the
// reader resolves. A filter that swept it in would demand an absolute path for a line nobody runs —
// the same shape of mistake as the remedy filter in 5d, which caught it for the opposite reason.
// `instanceRoot` as well as `repo`: this block asserts that NO placeholder survives when the caller
// knew the paths, and there are two of them. Supplying one and not the other would leave the other's
// caveat standing and turn the assertion below into a test of which placeholder was checked.
const withRepo = laneDoc('sealed', { repo: ROOT, instanceRoot: INST, writtenBy: 'PROVENANCE-SENTINEL tools/connect-agent.mjs' })
check(withRepo.includes('PROVENANCE-SENTINEL'), 'ANCHOR — the provenance line is present, so excluding it excludes something')
const bareRefs = withRepo.split('\n')
  .filter(l => !l.includes('PROVENANCE-SENTINEL'))
  .filter(l => /`[^`]*(?<![\w/])(?:node )?(?:tools|docs)\//.test(l) && !l.includes(ROOT))
check(bareRefs.length === 0, `no repo-relative path survives when the checkout is known${bareRefs.length ? ` — left: ${bareRefs[0]}` : ''}`)
for (const p of ['tools/agent-inbox.mjs', 'tools/agent-send.mjs', 'docs/AGENT_BRIEF.md', 'docs/KEY_CUSTODY.md'])
  check(withRepo.includes(`${ROOT}/${p}`), `  …${p} is named absolutely`)
check(!withRepo.includes('<your waggle checkout>'), 'and no placeholder is left over when a real path was supplied')
check(!/placeholder/.test(withRepo), '  …nor the caveat that explains one — an absolute command needs no explanation')
// A trailing slash on the caller's path must not produce a doubled separator.
check(laneDoc('sealed', { repo: `${ROOT}/` }).includes(`${ROOT}/tools/agent-send.mjs`),
  'a trailing slash on the supplied checkout does not render `//` into the command')
// A caller that already resolved its own brief is not prefixed twice.
check(startupDoc({ agent: 'oliver', repo: ROOT, briefPath: '/srv/brief/AGENT_BRIEF.md', report: { rows: [] } })
  .includes('`/srv/brief/AGENT_BRIEF.md`'), 'an ALREADY-ABSOLUTE briefPath is passed through, not prefixed twice')

// The other direction: the console renders this for a machine it has never seen, so it has no path
// to give. The placeholder is correct there; a guessed path would be worse than an honest gap.
const noRepo = laneDoc('sealed')
check(noRepo.includes('<your waggle checkout>/tools/agent-inbox.mjs'),
  'with NO checkout known, the commands render the placeholder rather than a path nobody verified')
check(/placeholder/.test(noRepo) && /exits \*\*1\*\*/.test(noRepo),
  '  …and the document says so, and names the exit code that would otherwise read as a missing credential')
check(/no clone on this[\s\S]{0,40}machine at all, you cannot run these/.test(noRepo),
  '  …and tells an agent with NO checkout to report that, rather than substituting nothing and reading exit 1 as a bad credential')

// ── 5h. the command survives a checkout path a human named ──────────────────────────────────
console.log('\n5h. a checkout path with a space is a command, not a module error')
// #525 review. `at()` interpolated bare, so `/Users/me/My Repos/waggle` rendered
// `node /Users/me/My Repos/waggle/tools/agent-inbox.mjs`, which dies `Cannot find module
// '/Users/me/My'` at exit 1 — the same message and the same code as the failure this whole change
// removes, and this time with no caveat above it, because a path WAS supplied. On macOS that class
// of directory name is ordinary. So the command is RUN here rather than pattern-matched: what is
// under test is whether a shell can execute it.
const spaceRoot = mkdtempSync(join(tmpdir(), 'wb-space-'))
const spacedRepo = join(spaceRoot, 'My Repos', "it's waggle")
mkdirSync(join(spacedRepo, 'tools'), { recursive: true })
writeFileSync(join(spacedRepo, 'tools', 'agent-inbox.mjs'), 'process.exit(0)\n')
// The instance directory gets a space and an apostrophe too, and for the same reason: it is now
// interpolated into the same command, as three paths (#583). `~/Library/Application Support/…` is
// where a Mac agent's directory ordinarily lands, so this is not a contrived name.
const spacedInst = join(spaceRoot, 'Application Support', "oliver's agent")
// The bridge key is supplied so the command under test carries only PATH quoting. Without it
// `--trust` renders a quoted placeholder, and this block's negative controls work by stripping every
// quote in the line — which would then be measuring the placeholder rather than the paths. The
// placeholder has its own run-it-in-a-shell check, with its own control, in 5k.
const spacedDoc = laneDoc('sealed', { repo: spacedRepo, instanceRoot: spacedInst, bridge: BRIDGE })
const spacedListenLine = spacedDoc.split('\n').find(l => l.startsWith('**To listen:**'))
const spacedListenCmd = (spacedListenLine || '').match(/`([^`]+)`/)?.[1] || ''
check(/agent-inbox\.mjs/.test(spacedListenCmd), `ANCHOR — a listen command was extracted from the document (${spacedListenCmd.slice(0, 60)}…)`)
check(/WAGGLE_BUNKER_URI_FILE=/.test(spacedListenCmd) && /--spool /.test(spacedListenCmd),
  '  ANCHOR — and it carries the signer pair and the spool, so the quoting under test covers all three')
const runsInShell = c => { try { execFileSync('/bin/sh', ['-c', c], { stdio: 'pipe' }); return 0 } catch (e) { return e.status ?? -1 } }
check(runsInShell(spacedListenCmd) === 0,
  'the rendered command RUNS in a real shell when the checkout path holds a space and an apostrophe')
// NEGATIVE CONTROL, in two halves, because the command now has two kinds of quoted path in it and
// they fail differently when the quotes come off.
//
// The `node …` half first, unchanged: strip the quoting and it must be `Cannot find module` at
// exit 1 — the exact failure #525 removed. It is isolated from the leading assignments because an
// unquoted assignment fails EARLIER and with a different shape, which would mask this one.
const nodePart = spacedListenCmd.slice(spacedListenCmd.indexOf('node '))
check(nodePart.startsWith('node ') && nodePart.includes('agent-inbox.mjs') && !/WAGGLE_/.test(nodePart),
  'ANCHOR — the node half was isolated from the env prefix')
const unquoted = nodePart.replace(/'/g, '')
let bareErr = ''
try { execFileSync('/bin/sh', ['-c', unquoted], { stdio: 'pipe' }) } catch (e) { bareErr = `${e.stderr || ''}` }
check(runsInShell(unquoted) === 1 && /Cannot find module/.test(bareErr),
  '  NEGATIVE CONTROL — with the quotes removed it is `Cannot find module` at exit 1, the failure this PR exists to remove')
// The env half. Unquoted, `WAGGLE_BUNKER_URI_FILE=/…/Application Support/…` splits at the space and
// the shell runs the remainder as a command, so the whole line fails before node is reached. Its
// exit code is not the point and is not asserted — what is asserted is that the quoting is
// load-bearing here too, rather than decoration around a path that would have worked anyway.
check(runsInShell(spacedListenCmd.replace(/'/g, '')) !== 0,
  '  NEGATIVE CONTROL — and unquoted, the signer paths break the line before node runs at all')
// And the quoting is not applied to everything: an ordinary path stays bare, or the document would
// print quotes nobody needs and the reader would learn to ignore them.
check(!/'/.test(laneDoc('sealed', { repo: ROOT, instanceRoot: INST, bridge: BRIDGE }).split('\n').find(l => l.startsWith('**To listen:**')) || "'"),
  '  BOTH DIRECTIONS — paths that need no quoting do not get any')

// ── 5i. the seating command is a command too ────────────────────────────────────────────────
console.log('\n5i. the pairing remedy runs in a shell, and is withheld once the pairing is seated')
// `pair-agent` is the one artifact in this document an agent can settle by itself (#528), and until
// this block existed the pairing row said `MISSING — this does not work yet` with no remedy beside
// it. It is run rather than matched for the same reason as 5h: this is a path the reader pastes.
// The stub is `process.exit(0)` — nothing here pairs with anything.
writeFileSync(join(spacedRepo, 'tools', 'pair-agent.mjs'), 'process.exit(0)\n')
const seatOf = doc => ((doc.split('\n').find(l => l.includes('pair-agent.mjs')) || '').match(/`([^`]+)`/)?.[1] || '')
const spacedSeatCmd = seatOf(laneDoc('sealed', { repo: spacedRepo }))
check(/pair-agent\.mjs/.test(spacedSeatCmd), `ANCHOR — a seating command was extracted (${spacedSeatCmd.slice(0, 60)}…)`)
check(runsInShell(spacedSeatCmd) === 0,
  'the rendered SEATING command RUNS in a real shell under a spaced, apostrophed checkout path')
check(runsInShell(spacedSeatCmd.replace(/'/g, '')) === 1,
  '  NEGATIVE CONTROL — strip its quoting and it fails at exit 1, so the quoting is what carries it')
// The pin, both directions. `--expect` is what makes a signer answering as someone else a refusal,
// and rendering it as a placeholder would print a command that dies on its own argument.
check(new RegExp(`--expect ${PUB}$`).test(spacedSeatCmd),
  '  it pins the identity to the key this same document names above')
const unpinnedSeat = seatOf(startupDoc({ agent: 'oliver', repo: spacedRepo,
  report: { rows: [{ key: 'bunker-uri', title: 'Bunker pairing', state: MISSING }] } }))
check(unpinnedSeat && !/--expect/.test(unpinnedSeat) && runsInShell(unpinnedSeat) === 0,
  '  BOTH DIRECTIONS — with no key known it omits --expect and still runs, rather than printing a placeholder')
// And it is absent once the pairing is there: `pair-agent` exits rather than overwrite a seated
// credential, so a paired agent handed this command is handed one whose first act is to refuse.
check(!seatOf(startupDoc({ agent: 'oliver', pubkey: PUB, repo: spacedRepo,
  report: { rows: [{ key: 'bunker-uri', title: 'Bunker pairing', state: PRESENT }] } })),
  '  BOTH DIRECTIONS — a SEATED pairing renders no seating command at all')

// ── 5j. the commands carry the signer and the spool ─────────────────────────────────────────
console.log('\n5j. the printed commands carry a signer and a durable index, or say they could not')
// #583. Both commands were printed without the two environment variables that ARE the signer, and
// the listen command without `--spool`. Neither omission looks like an omission from the reader's
// side: `loadNostrSigner` reads only the environment, so an agent whose pairing this same document
// reports as PRESENT runs the command, gets exit 3, and reports its lane as down. That is how one
// onboarding run ended INCONCLUSIVE with every credential correctly seated.
const withPaths = laneDoc('sealed', { repo: ROOT, instanceRoot: INST, bridge: BRIDGE, channel: CHAN })
const listenOf = d => (d.split('\n').find(l => l.startsWith('**To listen:**')) || '').match(/`([^`]+)`/)?.[1] || ''
const speakOf = d => (d.split('\n').find(l => l.startsWith('**To speak:**')) || '').match(/`([^`]+)`/)?.[1] || ''
check(/agent-inbox\.mjs/.test(listenOf(withPaths)) && /agent-send\.mjs/.test(speakOf(withPaths)),
  'ANCHOR — both commands were extracted, so asserting about them asserts about something')
// The NAMES come from the reader, not from here. `loadNostrSigner` is the only thing that reads
// them, and a document naming a variable it does not read is a document that cannot work — so this
// asserts the two files agree rather than re-checking a literal, the same rule `connect_flags.mjs`
// exists for. A rename in the signer that missed this renderer would fail here rather than in a
// pasted command on somebody else's machine.
const signerSrc = readFileSync(join(ROOT, 'src', 'nostr_signer.mjs'), 'utf8')
const envNames = [...signerSrc.matchAll(/env\.(WAGGLE_[A-Z0-9_]+)/g)].map(m => m[1])
check(envNames.length === 2, `ANCHOR — the signer reads two WAGGLE_ variables from the environment (${envNames.join(', ')})`)
for (const v of envNames) {
  check(listenOf(withPaths).includes(`${v}=`), `the listen command sets ${v}, which is what the signer actually reads`)
  check(speakOf(withPaths).includes(`${v}=`), `  …and so does the speak command — it signs too`)
}
// And the PATHS come from the tool that writes them. `pair-agent` puts both files under
// `credentials/`, and `connect-agent` creates `spool/` at 0o700; a renderer that invented its own
// layout would point at files nothing creates, which is exactly the defect #474 was.
const pairSrc = readFileSync(join(ROOT, 'tools', 'pair-agent.mjs'), 'utf8')
check(/join\(here, 'credentials'\)/.test(pairSrc) && /'bunker-uri'/.test(pairSrc) && /'bunker-client'/.test(pairSrc),
  'ANCHOR — pair-agent still writes credentials/bunker-uri and credentials/bunker-client')
check(listenOf(withPaths).includes(`${INST}/credentials/bunker-uri`)
  && listenOf(withPaths).includes(`${INST}/credentials/bunker-client`),
  '  …and the command names those two paths under the agent\'s own instance directory')
const connectSrc = readFileSync(join(ROOT, 'tools', 'connect-agent.mjs'), 'utf8')
check(/\['spool', 0o700\]/.test(connectSrc), "ANCHOR — connect-agent still creates spool/ at 0700 under the instance directory")
check(listenOf(withPaths).includes(`--spool ${INST}/spool`),
  'the listen command points --spool at that directory, so the first-seen index survives a restart')
check(/#557/.test(withPaths) && /every restart is a first-ever start/.test(flat(withPaths)),
  '  …and says what it buys, because a flag with no reason attached is the first thing trimmed')
// NEGATIVE CONTROL for the whole block: none of this is decoration that renders unconditionally.
check(!/<your agent dir>/.test(withPaths),
  'NEGATIVE CONTROL — with the directory known, no placeholder survives anywhere in the document')
check(!/in the commands below is a placeholder/.test(withPaths.split('agent dir')[0] || ''),
  '  …nor the caveat that explains one')

// The other direction — the console renders this for a machine it has never seen. The commands must
// STILL carry the pair, filled in with a placeholder and flagged, never silently dropped: an omitted
// argument is what made an incomplete command look complete, which is the rule `--bridge` follows.
const noInst = laneDoc('sealed', { repo: ROOT, bridge: BRIDGE, channel: CHAN })
for (const v of envNames) check(listenOf(noInst).includes(`${v}=`),
  `BOTH DIRECTIONS — ${v} is printed even when the directory is unknown, rather than dropped`)
check(listenOf(noInst).includes('--spool'), '  …and so is --spool')
check(/<your agent dir>/.test(listenOf(noInst)), '  …with a placeholder standing in for the path')
check(/`<your agent dir>` in the commands below is a placeholder/.test(noInst),
  '  …and the document says it is one, rather than leaving the reader to guess it is a substitution')
check(/not\*\* the waggle checkout/.test(flat(noInst)),
  '  …and says it is NOT the checkout — two placeholders in one document that resolve to different directories')
// A trailing slash must not render `//` into a path, the same way it must not for the checkout.
check(laneDoc('sealed', { instanceRoot: `${INST}/` }).includes(`${INST}/spool`)
  && !laneDoc('sealed', { instanceRoot: `${INST}/` }).includes(`${INST}//`),
  'a trailing slash on the instance directory does not render `//` into the command')

// ── 5k. the lane is ARMED, not merely open ──────────────────────────────────────────────────
console.log('\n5k. the listen half arms the lane, stops the old watcher, and wires a hook')
// The command this document printed until 2026-08-17 opened the lane and could wake nobody.
// `tools/agent-inbox.mjs` gates the wake hook on the trust list and NOTHING else, and refuses
// `--on-message` outright with an empty one. DJ Codex ran the printed command: five messages, every
// one `forMe: true` and `wake: false`, each naming the bridge key as not trusted. Nothing was
// broken — the document handed over a listener with the notification half left out, and a spool
// that fills while nobody is woken is indistinguishable from a quiet channel.
const inboxSrc = readFileSync(join(ROOT, 'tools', 'agent-inbox.mjs'), 'utf8')
check(/--on-message with an empty trust list can never fire/.test(inboxSrc),
  'ANCHOR — agent-inbox still refuses --on-message with an empty trust list, which is why --trust is not optional')
check(listenOf(withPaths).includes(`--trust ${BRIDGE}`),
  'the listen command passes --trust <bridge>, without which every message is recorded as data and nothing wakes')
check(/mayAct/.test(flat(withPaths)) && /indistinguishable from a quiet channel/.test(flat(withPaths)),
  '  …and says what its absence looks like, since the failure mode is silence rather than an error')
// BOTH DIRECTIONS on the warning specifically. A caveat that renders unconditionally is one the
// reader learns to skip, and it would then be skipped in the one document where it is the whole
// point — the one where the key really is missing.
const noBridge = laneDoc('sealed', { repo: ROOT, instanceRoot: INST, channel: CHAN })
check(/--trust '<waggle 64-hex>'/.test(listenOf(noBridge)),
  'BOTH DIRECTIONS — with no bridge key the flag is printed with a placeholder, never silently dropped')
// AND THE PLACEHOLDER SURVIVES A SHELL. `<waggle's 64-hex>` unquoted is a redirection followed by an
// unbalanced quote: the pasted line dies with `sh: parse error`, which names nothing the reader can
// act on, and is a worse outcome than the missing value it stands for. Caught here by running the
// command rather than matching it — every string assertion in this file passed on the broken form.
const stubListen = listenOf(laneDoc('sealed', { repo: spacedRepo, instanceRoot: spacedInst }))
check(/agent-inbox\.mjs/.test(stubListen) && /'<waggle 64-hex>'/.test(stubListen),
  'ANCHOR — a placeholder-bearing listen command was extracted against the stub checkout')
check(runsInShell(stubListen) === 0,
  '  …and it PARSES and runs in a real shell, so an unfilled --trust reaches the tool to be refused by name')
check(runsInShell(stubListen.replace(/'<waggle 64-hex>'/, '<waggle 64-hex>')) !== 0,
  '  NEGATIVE CONTROL — unquoted, the same placeholder breaks the line, which is what the quoting is for')
check(/`--trust` is not filled in above/.test(noBridge),
  '  …and the document flags it, because a watcher without it reports itself healthy')
check(!/`--trust` is not filled in above/.test(withPaths),
  '  …and that warning does NOT render once the key is known — a caveat on every document is a caveat nobody reads')

// STOP THE OLD ONE FIRST. Two watchers on one key both open the lane; which one a message reaches
// is a coin toss, and neither one's output names the other. On 2026-08-17 DJ Codex reported his
// return lane INCONCLUSIVE because "the watcher died before any reply arrived", while a second
// watcher on the same key was alive and had recorded the wake. Both statements were true of a
// different process, and nothing available to him from inside could tell them apart.
const stopLine = withPaths.split('\n').find(l => l.startsWith('`pkill')) || ''
check(/agent-inbox\.mjs --pubkey/.test(stopLine) && stopLine.includes(PUB),
  'the document prints a stop command that names THIS key, not every watcher on the machine')
// `indexOf(…) < indexOf(…)` ALONE CANNOT SAY THIS, and the first version of this line was written
// that way. A missing heading returns -1, which is less than everything, so deleting the block
// outright read as correct ordering — caught by mutating the heading and watching nothing fail. The
// presence of both is asserted first, then their order.
const stopAt = withPaths.indexOf('**First, stop any watcher'), listenAt = withPaths.indexOf('**To listen:**')
check(stopAt >= 0 && listenAt >= 0, 'ANCHOR — both headings are present, so comparing their positions compares something')
check(stopAt < listenAt,
  '  …and the stop command prints BEFORE the start command, which is the only order in which it helps')
check(/coin toss/.test(flat(withPaths)) && /neither one's output mentions the other/.test(flat(withPaths)),
  '  …and says why, because "tidy up first" reads as optional and this is not')
const noPub = laneDoc('sealed', { repo: ROOT, instanceRoot: INST, bridge: BRIDGE, channel: CHAN, pubkey: undefined })
check((noPub.split('\n').find(l => l.startsWith('`pkill')) || '').includes('<your 64-hex>'),
  'BOTH DIRECTIONS — with no pubkey the stop command carries a placeholder rather than matching every watcher')

// THE HOOK. A watcher records; it does not interrupt. The omission cost an evening on 2026-08-17: a
// hook was written that appended each record to a JSONL file nothing read. The lane delivered, the
// trust gate passed, the hook ran, and the message landed where no one opens.
check(/--on-message/.test(flat(withPaths)) && /on \*\*stdin\*\*/.test(flat(withPaths)),
  'the document wires the hook and says the envelope arrives on stdin')
check(/a path to an executable, not a command line/.test(flat(withPaths)),
  '  …and that it is an executable, not a command line — there is no argument splitting to rescue a quoted string')
check(/no argument splitting/.test(flat(inboxSrc)) && /shell: false/.test(inboxSrc),
  'ANCHOR — the tool really does refuse a shell string, so the document is describing the tool and not a wish')
check(/wakes nobody unless something reads that file/.test(flat(withPaths)),
  '  …and names the trap: a hook that only appends to a file looks like it works from every angle the agent can see')
check(/report the hook as unwired rather than picking a file and hoping/.test(flat(withPaths)),
  '  …and says what to do when the runtime\'s wake path is unknown, which is to say so rather than guess')

// It RUNS — the whole pipeline, not just the node half. `echo … | VAR=… node …` is a shape a string
// assertion cannot judge, and the memory of what a lost backslash costs is that it passes every
// string assertion and dies in a real shell.
writeFileSync(join(spacedRepo, 'tools', 'agent-send.mjs'), 'process.exit(0)\n')
const spacedSpeak = speakOf(laneDoc('sealed', { repo: spacedRepo, instanceRoot: spacedInst, bridge: BRIDGE, channel: CHAN }))
check(/agent-send\.mjs/.test(spacedSpeak) && /WAGGLE_/.test(spacedSpeak), 'ANCHOR — a speak pipeline with an env prefix was extracted')
check(runsInShell(spacedSpeak) === 0,
  'the speak command runs as a PIPELINE with the env pair in front of node, under spaced paths')
rmSync(spaceRoot, { recursive: true, force: true })

// The usage line is the message an agent acts on when it gets the call wrong, and it had drifted to
// five of nineteen flags — omitting every flag #513, #514 and #519 added. Rendered from the
// catalogue now, so this asserts the catalogue and the tool agree rather than re-checking a literal.
const usage = usageLine()
// The flag loop below asserts every flag NAME and never the program name, so the line could have
// read `usage: connect-agent` — the exact 127 this change removes — and stayed green (#523 review).
check(usage.startsWith('usage: node tools/connect-agent.mjs'),
  'the usage line names a command that RUNS — `connect-agent` alone is the 127 this change removed')
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

// ── 6b. A document already on disk can still be compared against a fresh one (#539) ─────────
console.log('\n6b. --print renders a FRESH document even when one already exists')
// The file is never overwritten, deliberately. So the only defence against a stale one is reading
// a fresh copy beside it — and `--print` was consulted only when the file was ABSENT, which turned
// it off in the one case it is for. The message told the operator to compare, and the command it
// suggested landed back in the same branch and printed the suggestion again.
//
// This is not hypothetical: pi-dog's document, written before its bunker was seated, still said
// `this does not work yet` on a day when both of its commands were exercised live. Nothing in the
// tool would show the operator otherwise.
const runStartupRaw = (agent, extra = []) => {
  const args = [join(ROOT, 'tools', 'connect-agent.mjs'), '--name', agent, '--root', probeRoot,
    '--startup', '--runtime', 'generic', ...extra]
  try { return execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (e) { return typeof e?.stdout === 'string' ? e.stdout : null }
}
const STALE = 'stalecheck'
const stalePath = join(probeRoot, STALE, 'AGENTS.md')

// 1. Written while the agent has NO manifest — so the document cannot name a key.
const wrote = runStartupRaw(STALE)
check(wrote !== null && /wrote /.test(wrote), 'a first run with no --print writes the file')
const onDisk = readFileSync(stalePath, 'utf8')
check(!onDisk.includes(TOOL_PUB), 'and that file does NOT name a key, because there was no manifest to hold one')

// 2. The state then changes underneath it — exactly what a seating does.
mkdirSync(join(probeRoot, STALE, 'instances'), { recursive: true })
writeFileSync(join(probeRoot, STALE, 'instances', `${STALE}.json`), JSON.stringify({
  version: 1, id: STALE, pubkey: TOOL_PUB, grantors: [], task_carriers: [],
  relays: ['wss://nos.lol'], broker_mode: 'local', delivery_mode: 'notify_only',
}) + '\n')

const printed = runStartupRaw(STALE, ['--print'])
check(printed !== null && /act as this key/.test(printed),
  'a later run WITH --print prints a document, instead of only reporting that one exists')
// The property that matters. Echoing the file back would satisfy "prints a document" and would be
// useless — what is needed is the document the tool would write TODAY.
check(printed !== null && printed.includes(TOOL_PUB),
  'and it is rendered fresh — it names the key seated AFTER the file was written, which the file cannot')
check(printed !== null && /NOT overwritten/.test(printed),
  'and it still says the existing file was not overwritten, so nobody reads the fresh copy as the saved one')
check(readFileSync(stalePath, 'utf8') === onDisk,
  'and the file on disk is byte-identical afterwards — --print writes nothing')

// NEGATIVE CONTROL, both halves. Without --print the existing branch must still refuse to render,
// or "it prints a document" is a statement about the tool always printing rather than about --print.
const quiet = runStartupRaw(STALE)
check(quiet !== null && /NOT overwritten/.test(quiet) && !/act as this key/.test(quiet),
  'NEGATIVE CONTROL — without --print it reports the file and renders nothing')
check(quiet !== null && /--print/.test(quiet),
  'and the command it suggests ends in --print, which is now a command that prints')
// The suggestion has to carry the lane, or the fresh copy is rendered for a DIFFERENT lane and the
// comparison reports differences that are the missing flag rather than the file being stale.
const laned = runStartupRaw(STALE, ['--lane', 'sealed'])
check(laned !== null && /--lane sealed/.test(laned),
  'and it carries --lane through, so the comparison is against the same lane')

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

// ── 8. Whose machine the document is about ──────────────────────────────────────────────────
console.log('\n8. the tool names the agent\'s own directory, or says it is not this machine')
// The instance directory is `--root/--name`, and the tool has always known it — it creates `spool/`
// there and `pair-agent` writes both credential files there. It just never printed any of it, so
// the commands the tool wrote named neither (#583).
const localDoc = runStartup('seated')
check(localDoc !== null && localDoc.includes(`${join(probeRoot, 'seated')}/credentials/bunker-uri`),
  'the written document names the credential files under THIS agent\'s instance directory')
check(localDoc !== null && localDoc.includes(`--spool ${join(probeRoot, 'seated')}/spool`),
  '  …and points --spool at the directory the tool itself creates at 0700')
check(localDoc !== null && !/<your agent dir>/.test(localDoc),
  '  NEGATIVE CONTROL — and prints no placeholder, because the tool knows the path')

// `--remote`. The tool's paths and its install rows are both about THIS machine, and neither is a
// fact about an agent somewhere else. Without this the operator writing a handoff for a third
// machine got a document naming a checkout that does not exist there, over install rows read off
// the wrong disk — which is how three onboarding runs got hand-written essays instead.
const remoteDoc = runStartup('seated', ['--remote'])
check(remoteDoc !== null && /<your agent dir>/.test(remoteDoc) && /<your waggle checkout>/.test(remoteDoc),
  '--remote renders BOTH paths as placeholders, because neither of this machine\'s is the reader\'s')
// Scoped to the DOCUMENT, which `--print` emits behind a `| ` gutter, not to the whole run. The
// tool also prints its own local install report above it, and that report is entitled to name this
// machine's paths — the operator is standing on it. What must not carry them is the file that gets
// handed to somebody else.
const gutter = out => (out || '').split('\n').filter(l => l.startsWith('  | ')).join('\n')
check(gutter(remoteDoc).length > 500, 'ANCHOR — a document was extracted from behind the print gutter')
check(!gutter(remoteDoc).includes(join(probeRoot, 'seated', 'credentials')),
  '  …and no path off this machine leaks into the commands')
// The load-bearing half. A row read off this disk is not an observation of that agent, and reporting
// one as MISSING sends a reader to re-create a credential they already hold.
check(remoteDoc !== null && /Nothing has checked whether these commands can run/.test(remoteDoc),
  '  …and the lane reads never-checked rather than broken — nobody looked at that machine')
check(remoteDoc !== null && !/Neither command works yet/.test(remoteDoc),
  '  …never the words for a credential that is genuinely absent, which is what this disk would have said')
check(remoteDoc !== null && /on the agent's own machine/.test(remoteDoc),
  '  …and the check it names is to be run there, not here')
// NEGATIVE CONTROL for the whole flag: the local document still reports the local state. A tool that
// blanked every row unconditionally would pass every assertion above.
check(localDoc !== null && localDoc.includes(TOOL_PUB) && !/<your waggle checkout>/.test(localDoc),
  'NEGATIVE CONTROL — without --remote the document still names this machine\'s checkout and this manifest\'s key')

// `--repo-root` on its own: the operator knows the checkout on the agent's machine and says so.
const rooted = runStartup('seated', ['--remote', '--repo-root', '/srv/waggle'])
check(rooted !== null && rooted.includes('/srv/waggle/tools/agent-inbox.mjs'),
  '--repo-root names the checkout on the agent\'s machine, in the commands')
check(rooted !== null && !/<your waggle checkout>/.test(rooted) && /<your agent dir>/.test(rooted),
  '  …and resolves only that placeholder — the instance directory is still unknown and still says so')

// Both flags refuse outside --startup, because that is the only thing either changes and a flag that
// silently does nothing is one the operator believes worked.
const strayRun = (extra) => {
  const args = [join(ROOT, 'tools', 'connect-agent.mjs'), '--name', 'seated', '--root', probeRoot, '--check', ...extra]
  try { execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); return { code: 0, stderr: '' } }
  catch (e) { return { code: typeof e?.status === 'number' ? e.status : -1, stderr: String(e?.stderr ?? '') } }
}
for (const [f, extra] of [['--remote', ['--remote']], ['--repo-root', ['--repo-root', '/srv/waggle']]]) {
  const r = strayRun(extra)
  // The REASON, not only the refusal: `!ok` cannot tell a correct refusal from one whose message
  // sends the operator somewhere else, and `--check` exits non-zero on its own by design.
  check(r.code === 1 && new RegExp(`${f} only changes the startup document`).test(r.stderr),
    `${f} outside --startup is refused, and says why — ${r.stderr.trim().slice(0, 60)}`)
}
check(strayRun([]).stderr === '' || !/only changes the startup document/.test(strayRun([]).stderr),
  'NEGATIVE CONTROL — an ordinary --check with neither flag is not refused for either of them')

// ── 8b. A manifest key that is not the key on the command line ──────────────────────────────
console.log('\n8b. two accounts of the agent\'s identity, disagreeing')
// The row asked only whether the field was 64 hex, so a stub — `1111…` shipped — rendered `ok` while
// `--pubkey` on the same line said otherwise. Both halves are believable alone; this line is the
// only place they meet.
const STUB = '1'.repeat(64)
mkdirSync(join(probeRoot, 'stubkey', 'instances'), { recursive: true })
writeFileSync(join(probeRoot, 'stubkey', 'instances', 'stubkey.json'), JSON.stringify({
  version: 1, id: 'stubkey', pubkey: STUB, grantors: [], task_carriers: [],
  relays: ['wss://nos.lol'], broker_mode: 'local', delivery_mode: 'notify_only',
}) + '\n')
const mismatch = runRaw(['--print', '--pubkey', TOOL_PUB], 'stubkey')
check(/Runtime manifest/.test(mismatch.stdout), 'ANCHOR — the manifest row rendered at all')
const manifestRow = mismatch.stdout.split('\n').find(l => /Runtime manifest/.test(l)) || ''
check(/missing/i.test(manifestRow) || /✗|x /.test(manifestRow),
  `a manifest naming a different key than --pubkey is MISSING, not ok — ${manifestRow.trim().slice(0, 90)}`)
check(manifestRow.includes(STUB.slice(0, 12)) && manifestRow.includes(TOOL_PUB.slice(0, 12)),
  '  …and the row names BOTH keys, because "does not match" without them is a refusal nobody can act on')
check(!mismatch.stdout.includes(STUB),
  '  …and the document does not fall back to the key the row just refused')
// BOTH DIRECTIONS, and this is the one that matters: a check that fires on every manifest cannot
// tell a stub from a real one, and would refuse every correctly-seated agent.
const agreeing = runRaw(['--print', '--pubkey', TOOL_PUB], 'seated')
const agreeRow = agreeing.stdout.split('\n').find(l => /Runtime manifest/.test(l)) || ''
check(!/missing/i.test(agreeRow) && agreeing.stdout.includes(TOOL_PUB),
  `NEGATIVE CONTROL — a manifest that AGREES with --pubkey is not refused — ${agreeRow.trim().slice(0, 80)}`)
// And with no --pubkey there is nothing to compare against, so the manifest still supplies the key.
const noCompare = runRaw(['--print'], 'stubkey')
check(noCompare.stdout.includes(STUB),
  '  …and with no --pubkey the manifest key is still used: the check is a comparison, not a stub detector')

rmSync(probeRoot, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
assert.equal(fail, 0, `${fail} assertion(s) failed`)
