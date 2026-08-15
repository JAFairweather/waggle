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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MISSING, PRESENT, UNKNOWN, installState } from '../src/agent_install_state.mjs'
import { secretInText, startupDoc } from '../src/agent_startup.mjs'
import { RUNTIMES } from '../src/mcp_runtimes.mjs'

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
check(RUNTIMES.find(r => r.id === 'generic').startupFile === 'AGENTS.md', 'a Pi or headless host gets AGENTS.md, the cross-tool convention')
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
