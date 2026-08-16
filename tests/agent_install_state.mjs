// agent_install_state.mjs — the report must not be able to say "fine" about something nobody checked.
//
// Every real defect in this project's agent onboarding left the artifact PRESENT:
//
//   - a wrong-identity pairing signs, seals and publishes perfectly
//   - a denied nip44 permission is byte-identical to an empty inbox, all the way up the stack
//   - a missing kind 0 costs nothing at runtime; the agent is simply invisible
//   - a registered MCP server that does not start looks exactly like one that does, until you
//     ask it to initialize
//
// A present/missing report is green for all four. So the property under test is that `found`
// without `verified` degrades to UNVERIFIED, that unverified is INCONCLUSIVE rather than passing,
// and that the renderer never prints an unverified row as a tick.
//
//   node tests/agent_install_state.mjs

import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { npubEncode, decode as nip19decode } from 'nostr-tools/nip19'
import { installState, renderState, foreignNvoyServers, boundIdentity, ARTIFACTS, ARTIFACT_KEYS, LANES, NEVER_CHECKED, NEVER_VERIFIED, NOT_APPLICABLE, PRESENT, UNVERIFIED, MISSING, UNKNOWN }
  from '../src/agent_install_state.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const all = (shape) => Object.fromEntries(ARTIFACT_KEYS.map(k => [k, shape]))
const complete = all({ found: true, verified: true })

// ── The default that matters ────────────────────────────────────────────────────────────────
{
  const r = installState({ ...complete, 'signer-identity': { found: true } })
  const row = r.rows.find(x => x.key === 'signer-identity')
  check(row.state === UNVERIFIED,
    'found WITHOUT verified degrades to unverified — "I saw the file" is not "I saw it work"')
  check(r.outcome === 'inconclusive' && r.exitCode === 3,
    'and one unverified row makes the whole report INCONCLUSIVE, exit 3 — not a pass')
  check(/not the same as being fine/.test(r.headline), 'the headline says why')
}

// ── The three outcomes are reachable and distinct ───────────────────────────────────────────
{
  const r = installState(complete)
  check(r.outcome === 'complete' && r.exitCode === 0, 'everything present AND observed → complete, exit 0')
  check(r.counts.unverified === 0 && r.counts.missing === 0, 'with nothing outstanding')
}
{
  const r = installState(all({ found: false }))
  check(r.outcome === 'incomplete' && r.exitCode === 1, 'looked, and nothing is there → incomplete, exit 1')
  check(r.counts.present === 0, 'and nothing is claimed present')
}

// ── "Nobody looked" is not "it is not there" ────────────────────────────────────────────────
// The first version of this module reported two artifacts as MISSING that it had never examined.
// That is worse than it sounds: missing sends an operator to CREATE the thing, and for a key or a
// published profile, making a second one is not a harmless no-op.
{
  const r = installState({})
  check(r.rows.every(x => x.state === UNKNOWN), 'no observations at all → every row UNKNOWN, none MISSING')
  check(r.outcome === 'inconclusive' && r.exitCode === 3,
    'and that is INCONCLUSIVE, exit 3 — an empty report must never read as "everything is absent"')
  check(r.counts.missing === 0, 'nothing is claimed missing on the strength of not having looked')
}
{
  const r = installState({ ...complete, profile: { found: null, note: 'not checked here' } })
  const row = r.rows.find(x => x.key === 'profile')
  check(row.state === UNKNOWN, 'an explicit found:null is UNKNOWN')
  check(r.exitCode === 3 && r.unknown.includes('profile'), 'and denies exit 0')
  check(!/MISSING/.test(renderState(r)), 'and the render never calls it missing')
}
{
  const r = installState({ ...complete, profile: { found: false } })
  check(r.rows.find(x => x.key === 'profile').state === MISSING,
    'while an explicit found:false IS missing — the two are distinguishable, which is the point')
  const text = renderState(r)
  check(/\[ - \]/.test(renderState(installState({ ...complete, profile: { found: null } }))) && !/\[ - \]/.test(text),
    'and they render with different glyphs, so a reader can tell them apart at a glance')
}
{
  // Blocking present and verified; only the cosmetic ones absent. This is the state a working
  // agent with no name is in, and it must NOT read as success.
  const obs = {}
  for (const a of ARTIFACTS) obs[a.key] = a.blocking ? { found: true, verified: true } : { found: false }
  const r = installState(obs)
  check(r.outcome === 'runs-unfinished' && r.exitCode === 3,
    'blocking pieces done, cosmetic ones absent → runs-unfinished, exit 3, never exit 0')
  check(/no name/.test(r.headline), `and the headline names the consequence: ${r.headline}`)
  check(r.missing.includes('profile') && r.missing.includes('nip05'),
    'the two absent pieces are the profile and the directory name — exactly the state observed live')
}

// ── Exit 0 is hard to reach ─────────────────────────────────────────────────────────────────
// The failure this guards: a report that returns 0 whenever nothing is outright missing.
{
  for (const key of ARTIFACT_KEYS) {
    const r = installState({ ...complete, [key]: { found: true } })
    check(r.exitCode !== 0, `one unverified "${key}" is enough to deny exit 0`)
  }
}

// ── The renderer cannot show an unverified row as done ──────────────────────────────────────
{
  const r = installState({ ...complete, profile: { found: true }, nip05: { found: false } })
  const text = renderState(r)
  const profileLine = text.split('\n').find(l => /Public profile/.test(l))
  const nip05Line = text.split('\n').find(l => /directory/.test(l))
  check(/UNVERIFIED/.test(profileLine) && !/\[ok /.test(profileLine),
    `an unverified row is marked UNVERIFIED and is not ticked: ${profileLine.trim()}`)
  check(/MISSING/.test(nip05Line), `a missing row says so: ${nip05Line.trim()}`)
  check(text.includes(r.headline), 'and the headline is included, so a truncated read still gets the verdict')
}

// ── Notes survive, because the reason is what the operator acts on ──────────────────────────
{
  const r = installState({ ...complete, 'admit-grant': { found: true, verified: true, note: 'on ONE relay only' } })
  const row = r.rows.find(x => x.key === 'admit-grant')
  check(row.note === 'on ONE relay only', 'an observation note is carried through')
  check(/ONE relay only/.test(renderState(r)), 'and rendered — a single-relay grant is a live agent with one point of failure')
}

// ── Every artifact declares why it matters ──────────────────────────────────────────────────
for (const a of ARTIFACTS) {
  check(typeof a.why === 'string' && a.why.trim().length > 20,
    `"${a.key}" says what breaks without it`)
  check(typeof a.blocking === 'boolean', `"${a.key}" declares whether it is blocking`)
}
check(ARTIFACTS.some(a => a.blocking) && ARTIFACTS.some(a => !a.blocking),
  'both blocking and non-blocking artifacts exist — otherwise the distinction is decorative')

// ── NEGATIVE CONTROL ────────────────────────────────────────────────────────────────────────
// The checks above assert that unverified is caught. Prove they would also NOTICE if it were not
// — by running the same comparison against a report built with the wrong default.
{
  const wrong = ARTIFACT_KEYS.map(k => ({ key: k, state: PRESENT }))          // the defect: found ⇒ present
  const wouldPass = wrong.every(r => r.state === PRESENT)
  check(wouldPass,
    'NEGATIVE CONTROL — a found-implies-present report WOULD read as fully present, which is the bug')
  const real = installState(all({ found: true }))
  check(real.rows.every(r => r.state === UNVERIFIED) && real.exitCode === 3,
    'and the real one reports every row unverified and exits 3 instead — so the check is not vacuous')
}
{
  // And prove exit 0 is reachable at all, or "never returns 0" would pass by refusing everything.
  check(installState(complete).exitCode === 0,
    'NEGATIVE CONTROL — a fully observed agent DOES reach exit 0, so the bar is not "always fail"')
}

// ── #380 — registered is not SOLE ───────────────────────────────────────────────────────────
// #338's defect left `nvoy-oliver` correctly registered and instance-bound. Asking "is my server
// there?" answered yes. The tools that SIGN were on a bare `nvoy` sitting beside it, hard-wired
// to one identity, so the session held fifteen tools pointed at a teammate.
//
// Fixtures use the real output shape, real instance names, and a path containing a space — the
// 2026-08-01 outage was a name with a space against a suite where every name was `A` or `Dennis`.
{
  const DIRTY = [
    'nvoy: node /Users/op/Projects/nvoy/mcp/dist/server.js - ✔ Connected',
    'nvoy-oliver: /Users/op/My Tools/node /Users/op/connect/claude-channel.mjs --instance oliver - ✘ Failed to connect',
    'nvoy-lukedog: /Users/op/My Tools/node /Users/op/connect/claude-channel.mjs --instance lukedog - ✘ Failed to connect',
    'github: docker run ghcr.io/github/github-mcp-server - ✔ Connected',
  ].join('\n')

  const dirty = foreignNvoyServers(DIRTY, 'oliver')
  check(dirty.includes('nvoy'),
    'the bare `nvoy` beside a correct nvoy-oliver is reported — the #338 configuration exactly')
  check(dirty.includes('nvoy-lukedog'),
    'another agent’s instance server is foreign too — it signs, just not as oliver')
  check(!dirty.includes('nvoy-oliver'), 'the agent’s OWN server is not reported against it')
  check(!dirty.includes('github'), 'a path containing a space does not turn an unrelated server into an nvoy one')

  // BOTH DIRECTIONS. A check that only ever finds a conflict cannot be told from one that calls
  // everything a conflict, and that version would still pass every assertion above.
  const CLEAN = [
    'nvoy-oliver: /Users/op/My Tools/node /Users/op/connect/claude-channel.mjs --instance oliver - ✘ Failed to connect',
    'github: docker run ghcr.io/github/github-mcp-server - ✔ Connected',
  ].join('\n')
  check(Array.isArray(foreignNvoyServers(CLEAN, 'oliver')) && foreignNvoyServers(CLEAN, 'oliver').length === 0,
    'a correctly provisioned session reports NO conflict — the guard is not "refuse everything"')

  // The distinction this whole module exists to keep: could-not-look is not clean.
  check(foreignNvoyServers(null, 'oliver') === null,
    '`claude mcp list` unavailable returns null, NOT an empty array')
  check(foreignNvoyServers(undefined, 'oliver') === null, 'and so does a missing argument')

  // NEGATIVE CONTROL — a version returning [] on null passes "clean → []" identically. This is
  // the assertion that tells them apart, so state it as the thing being relied on.
  const collapsed = (out) => (typeof out === 'string' ? foreignNvoyServers(out, 'oliver') : [])
  check(collapsed(null).length === 0 && foreignNvoyServers(null, 'oliver') === null,
    'NEGATIVE CONTROL — a null-collapses-to-empty version WOULD read as clean; the real one returns null')
}
{
  // And the report wiring: unknown must reach UNKNOWN (exit 3), a conflict must reach MISSING and
  // BLOCK (exit 1). Assert the outcome, not just that something was flagged.
  const conflicted = installState({ ...complete, 'mcp-exclusive': { found: false, note: 'also registered: nvoy' } })
  check(conflicted.outcome === 'incomplete' && conflicted.exitCode === 1,
    'a foreign nvoy server is BLOCKING — exit 1, not a warning the operator can read past')
  check(conflicted.missing.includes('mcp-exclusive'), 'and it is named in the report')

  const unlooked = installState({ ...complete, 'mcp-exclusive': { found: null } })
  check(unlooked.outcome === 'inconclusive' && unlooked.exitCode === 3,
    'and being unable to run `claude mcp list` is INCONCLUSIVE (3), never clean (0)')
  check(installState(complete).exitCode === 0,
    'while an exclusive registration still reaches exit 0 — the new artifact is satisfiable')
}

// ── The checklist asks one inbound question, and the tool has to ask it (#337) ───────────────
//
// Every artifact on the checklist verified whether the agent could ACT. None asked whether anything
// could reach it, and an admitted agent was live for a day posting successfully while structurally
// unable to receive a single message. Two separate things are pinned here, because closing only the
// first leaves the same hole one refactor away.
//
// (No count in that sentence on purpose. This PR's own thesis is that the artifact count drifted
// three times without anyone noticing, and a prose count is exactly the thing that drifts.)
{
  const inbound = ARTIFACTS.find(a => a.key === 'dm-relays')
  check(!!inbound, 'the checklist carries an inbound-reachability artifact at all')
  check(inbound?.blocking === true,
    'and it is blocking — write-only is not a cosmetic shortfall, it is an agent that cannot be talked to')

  // The property, not the mechanism: an install perfect in every other respect must not read clean
  // while the one inbound question is unanswered.
  const everythingElse = Object.fromEntries(
    ARTIFACT_KEYS.filter(k => k !== 'dm-relays').map(k => [k, { found: true, verified: true }]))
  const writeOnly = installState({ ...everythingElse, 'dm-relays': { found: false } })
  check(writeOnly.exitCode === 1 && writeOnly.missing.includes('dm-relays'),
    `an otherwise-complete agent with no kind:10050 does NOT read clean (exit ${writeOnly.exitCode})`)
  const unasked = installState(everythingElse)
  check(unasked.exitCode === 3 && unasked.unknown.includes('dm-relays'),
    'and not looking is INCONCLUSIVE, never clean — the failure mode was nobody asking')

  // BOTH DIRECTIONS. A guard that refuses everything is indistinguishable from one that refuses the
  // dangerous thing, so prove the new artifact is satisfiable and does not wedge the report at 3.
  const reachable = installState({ ...everythingElse, 'dm-relays': { found: true, verified: true } })
  check(reachable.exitCode === 0 && reachable.outcome === 'complete',
    'while a published and read-back list reaches exit 0 — the artifact is satisfiable')
}

// ── …and every artifact is actually REPORTED by the tool that produces the observations ───────
//
// The gap #337 names is not that the checklist judged inbound reachability wrongly. It is that
// nothing asked. An artifact absent from `connect-agent.mjs` sits at UNKNOWN forever with no note,
// and the note is the remedy — it is the line telling an operator which command settles it. So the
// tool must name every key, and this fails when someone adds an artifact and stops there.
{
  const src = readFileSync(join(ROOT, 'tools', 'connect-agent.mjs'), 'utf8')
  if (src.length < 2000) {
    console.error(`agent_install_state: INCONCLUSIVE — connect-agent.mjs read back only ${src.length} bytes`)
    process.exit(3)
  }
  const seen = [...src.matchAll(/see\(\s*'([a-z0-9-]+)'/g)].map(m => m[1])
  check(seen.length > 5, `the scan found ${seen.length} see() calls, so it is reading the tool`)
  const unreported = ARTIFACT_KEYS.filter(k => !seen.includes(k))
  check(unreported.length === 0,
    `every artifact has a see() call in connect-agent.mjs${unreported.length ? ` — unreported: ${unreported.join(', ')}` : ''}`)
  check(!seen.includes('no-such-artifact-key'),
    'NEGATIVE CONTROL — the scan does not report a key the tool never mentions')

  // …and the scan above is weaker than the property it is written for. It matches SOURCE TEXT, so
  // commenting a see() call out, or moving one behind a branch that never runs, leaves it green
  // while the tool reports nothing for that artifact — the exact silence this is here to prevent.
  //
  // So run the tool. `--check` writes nothing (!CHECK guards every mkdirSync/writeFileSync) and
  // renders every row, so the property becomes what an operator would actually see. The text scan
  // stays above because it gives the better failure message: a key name, not a missing line.
  const probeRoot = mkdtempSync(join(tmpdir(), 'wb-connect-probe-'))
  let rendered = null
  try {
    // Exit is non-zero by design here — nothing is installed under a fresh root — so capture rather
    // than throw. It shells out to `claude mcp list`, which connect-agent catches on absence.
    rendered = execFileSync(process.execPath,
      [join(ROOT, 'tools', 'connect-agent.mjs'), '--name', 'probe', '--check', '--root', probeRoot],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    rendered = typeof e?.stdout === 'string' ? e.stdout : null
    // A tool that could not run at all has told us nothing about which artifacts it reports.
    // That is INCONCLUSIVE, not a pass — being unable to check is not the same as being fine.
    if (e?.signal || e?.code === 'ETIMEDOUT') rendered = null
  }
  if (rendered === null || rendered.length < 500) {
    console.error(`agent_install_state: INCONCLUSIVE — connect-agent.mjs --check produced ${rendered === null ? 'no output' : `only ${rendered.length} bytes`}`)
    console.error('  This is NOT an all-clear: the tool was never observed reporting anything.')
    rmSync(probeRoot, { recursive: true, force: true })
    process.exit(3)
  }
  // Assert the NOTE, not the title. renderState prints a row for every entry in ARTIFACTS whether
  // or not the tool observed it, so "the title appears" is true even when the see() call is gone —
  // a check written that way passes the very mutation it exists to catch, which was measured here
  // rather than reasoned about. What the tool actually contributes is the note, and that is also
  // the operator-facing remedy: the line saying which command settles the row. An artifact nobody
  // asked about renders bare —
  //
  //   [ - ] Inbound DM relay list (kind 10050) UNKNOWN
  //
  // against a row that was asked about and legitimately cannot be answered here —
  //
  //   [ - ] Name in the directory              UNKNOWN  — not checked here — resolve <name>@…
  //
  // so "carries a note" separates "the tool asked" from "the tool never mentioned it", which
  // scanning for UNKNOWN cannot do: four artifacts are legitimately UNKNOWN in a --check run.
  const rows = new Map(ARTIFACTS.map(a => [a.key, rendered.split('\n').find(l => l.includes(a.title))]))
  const missingRow = ARTIFACTS.filter(a => !rows.get(a.key)).map(a => a.key)
  check(missingRow.length === 0,
    `and every artifact is RENDERED by a real --check run${missingRow.length ? ` — absent: ${missingRow.join(', ')}` : ''}`)
  const noteless = ARTIFACTS
    .filter(a => rows.get(a.key) && !/—\s*\S/.test(rows.get(a.key).slice(rows.get(a.key).indexOf(a.title) + a.title.length)))
    .map(a => a.key)
  check(noteless.length === 0,
    'and every rendered row carries the tool\'s note, so the tool ASKED about it' +
    `${noteless.length ? ` — silent: ${noteless.join(', ')}` : ''}`)
  check(!rendered.includes('No such artifact, invented for this check'),
    'NEGATIVE CONTROL — the run does not render a title the tool never had')
  // The ceiling clause is EARNED, not printed always. A fresh root is missing blocking pieces, so
  // there is plenty to do here and the tool must not say this is the best it can report (#492).
  check(/\nexit 1 \(incomplete\)/.test(rendered),
    'a fresh root exits 1 with a bare outcome — nothing on the exit line claims a ceiling')
  check(!rendered.includes('best result this build can report'),
    'NEGATIVE CONTROL — the ceiling clause does NOT appear on a run with real work outstanding')
  // `--check` is what makes running it safe in a suite. Prove that rather than trusting the flag.
  check(readdirSync(probeRoot).length === 0,
    'NEGATIVE CONTROL — and --check wrote nothing into the probe root, so running the tool is side-effect free')
  rmSync(probeRoot, { recursive: true, force: true })
}

// ── #338 — sole is not YOURS: the MCP path's EXPECT_PUBKEY ───────────────────────────────────
//
// Every assertion here is paired. The reported failure was a session answering as another agent
// and nothing objecting; the failure this test could introduce is a guard that objects to
// everything, which looks identical from a green suite and takes the working case down with it.
{
  // MC Claude and Oliver, the two identities in the incident, as their real key shapes.
  const MINE = 'ad05b00e'.padEnd(64, '3')
  const THEIRS = 'ebc6eec1'.padEnd(64, '7')
  const whoami = pk => JSON.stringify({ npub: 'npub1…', pubkey: pk, relays: ['wss://relay.example'], metadata: null })

  const right = boundIdentity(whoami(MINE), MINE)
  check(right.match === true, 'a server answering as the minted key passes')
  check(right.resolved === MINE && right.reason.includes(MINE.slice(0, 12)),
    'and the PASS names WHO it matched, because a guard that passes in silence is indistinguishable from one that is not there (#338)')

  const wrong = boundIdentity(whoami(THEIRS), MINE)
  check(wrong.match === false, 'a server answering as a DIFFERENT agent is refused — the reported failure, caught')
  check(wrong.resolved === THEIRS && wrong.reason.includes(THEIRS.slice(0, 12)) && wrong.reason.includes(MINE.slice(0, 12)),
    'and the refusal names both keys, so the operator is not left guessing which session they are in')

  // BOTH DIRECTIONS, at the level that matters: not "it refused" but "it refused THIS and not THAT".
  check(right.match !== wrong.match, 'NEGATIVE CONTROL — the two verdicts differ, so the guard is discriminating and not merely refusing')

  // The three UNKNOWNs. None may reach `true`, and none may reach `false` either: "nobody looked"
  // sends an operator to fix a binding that may be correct, which is the same false confidence
  // pointing the other way.
  check(boundIdentity(null, MINE).match === null, 'nothing captured is UNKNOWN, not a pass')
  check(boundIdentity('', MINE).match === null, 'and so is an empty capture — a file that read blank has told you nothing')
  const unasked = boundIdentity(whoami(THEIRS), '')
  check(unasked.match === null,
    'CRITICAL — with no expected key there is no comparison, so the verdict is UNKNOWN even though the server answered')
  check(unasked.match !== true,
    'NEGATIVE CONTROL — and specifically not a pass: a guard that goes green because nobody supplied the comparison is the whole defect')
  check(boundIdentity('{"npub":"npub1…"}', MINE).match === null,
    'output with no readable identity is UNKNOWN — not silently clean')

  // npub and hex are the same key. Comparing the two alphabets as strings would refuse a correct
  // binding, and a guard that refuses the working case gets switched off.
  //
  // The fixture is encoded by nip19 rather than typed, because the first draft of this test used a
  // hand-invented npub that fails its own checksum. It passed — both sides normalize identically,
  // so a nonsense string matches a nonsense string — and proved nothing about real input.
  const NPUB = npubEncode(MINE)
  const asHex = boundIdentity(JSON.stringify({ npub: NPUB }), NPUB)
  check(asHex.match === true && asHex.resolved === MINE,
    'an npub is decoded to hex, so npub-vs-hex compares as the same key rather than as a mismatch')
  check(boundIdentity(JSON.stringify({ pubkey: MINE }), NPUB).match === true,
    'and the comparison holds with the alphabets swapped between the two sides')
  check(boundIdentity(JSON.stringify({ npub: NPUB }), THEIRS).match === false,
    'NEGATIVE CONTROL — decoding does not make every npub match; a different key still refuses')

  // A round trip across the byte range. Every assertion above compares two values this same path
  // produced, so a normalizer that is wrong in a consistent way agrees with itself perfectly.
  let disagreed = 0
  for (let i = 0; i < 128; i++) {
    const hex = Array.from({ length: 32 }, (_, j) => ((i * 31 + j * 7) % 256).toString(16).padStart(2, '0')).join('')
    if (boundIdentity(JSON.stringify({ npub: npubEncode(hex) }), hex).match !== true) disagreed++
  }
  check(disagreed === 0, `npub↔hex round-trips on 128 keys (${disagreed} disagreed)`)

  // MALFORMED INPUT — the gap the 128 keys above cannot see, because every one of them is
  // well-formed (#451 review).
  //
  // The old decoder read `v.slice(5, -6)` and never looked at the six characters it discarded. Those
  // six ARE the checksum: the only part of a bech32 string that can detect corruption was the only
  // part it threw away. Flip one of them, leave the data untouched, and a string `nip19.decode`
  // refuses outright decoded to the same clean 32 bytes and printed a green tick — on the artifact
  // whose whole job is to refuse what it cannot vouch for.
  //
  // Corrupt the DATA part instead and the refusal was confidently wrong the other way: "answers as
  // …, NOT the minted … — this session would sign as someone else", said about a capture that got
  // mangled between two clipboards. Both are asserted, and both assert the REASON: `match === null`
  // alone cannot tell a correct refusal from a correct refusal that sends the operator hunting for
  // an impostor who does not exist.
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const flip = (s, i) => {
    const at = i < 0 ? s.length + i : i
    return s.slice(0, at) + CHARSET[(CHARSET.indexOf(s[at]) + 1) % CHARSET.length] + s.slice(at + 1)
  }
  const BAD_SUM = flip(NPUB, -3)    // inside the six checksum characters — data part untouched
  const BAD_DATA = flip(NPUB, 10)   // inside the data part

  // FIXTURE GUARD. A probe that loses its own input has told you nothing: if these strings were
  // still valid npubs, every assertion below would pass while exercising nothing.
  const refused = s => { try { nip19decode(s); return false } catch { return true } }
  check(refused(BAD_SUM) && refused(BAD_DATA) && !refused(NPUB) && BAD_SUM !== NPUB && BAD_DATA !== NPUB,
    'FIXTURE — nip19 refuses both corrupted npubs and accepts the clean one, so these cases test what they claim')

  const badSum = boundIdentity(JSON.stringify({ npub: BAD_SUM }), MINE)
  check(badSum.match === null,
    'an npub that fails its CHECKSUM is UNKNOWN — the six characters the old decoder discarded were the only ones that could catch it')
  check(/does not decode/.test(badSum.reason) && !/someone else/.test(badSum.reason),
    '  ...and the reason says garbled capture, not impostor')

  const badData = boundIdentity(JSON.stringify({ npub: BAD_DATA }), MINE)
  check(badData.match === null && /does not decode/.test(badData.reason),
    'an npub whose DATA is corrupt is UNKNOWN too — not a confident "this session would sign as someone else"')

  const badExpected = boundIdentity(JSON.stringify({ pubkey: MINE }), BAD_SUM)
  check(badExpected.match === null && /expected key/.test(badExpected.reason),
    'and a corrupt --pubkey is UNKNOWN rather than a match — the EXPECTED side is decoded too, which is how the checksum flip got its green tick')

  check(boundIdentity(JSON.stringify({ npub: NPUB.slice(0, -4) }), MINE).match === null,
    'a truncated npub is UNKNOWN — nothing about it is readable, so nothing about it is reported')

  // BOTH DIRECTIONS. A normalizer that returned null for every npub would satisfy all four of those
  // and break every real check, which is the shape that gets a guard switched off.
  const impostor = boundIdentity(JSON.stringify({ npub: npubEncode(THEIRS) }), MINE)
  check(impostor.match === false && /sign as someone else/.test(impostor.reason),
    'NEGATIVE CONTROL — a WELL-FORMED npub for a different key still reads as an impostor, so this refuses the garbled input rather than all input')
  check(boundIdentity(JSON.stringify({ npub: npubEncode(MINE) }), MINE).match === true,
    '  ...and the matching one still passes')

  // MCP results reach a human wrapped in an envelope. Failing to read through it would report
  // UNKNOWN for a session that did answer, and UNKNOWN is the state operators learn to skip past.
  const wrapped = JSON.stringify({ content: [{ type: 'text', text: whoami(THEIRS) }] })
  check(boundIdentity(wrapped, MINE).match === false && boundIdentity(wrapped, THEIRS).match === true,
    'a whoami wrapped in an MCP content envelope is still read, in both directions')

  // The artifact, and its exit code. Blocking, because a session bound to someone else must not
  // read as an agent that merely lacks a name.
  const bind = ARTIFACTS.find(a => a.key === 'mcp-identity')
  check(!!bind && bind.blocking === true, 'the checklist carries a blocking mcp-identity artifact')
  const everythingElse = Object.fromEntries(
    ARTIFACT_KEYS.filter(k => k !== 'mcp-identity').map(k => [k, { found: true, verified: true }]))
  check(installState({ ...everythingElse, 'mcp-identity': { found: false } }).exitCode === 1,
    'an otherwise-perfect agent whose server answers as someone else exits 1 — it cannot be used')
  check(installState(everythingElse).exitCode === 3,
    'and one where nobody checked the binding exits 3 — INCONCLUSIVE is not a softer 0')
  check(installState({ ...everythingElse, 'mcp-identity': { found: true, verified: true } }).outcome === 'complete',
    'BOTH DIRECTIONS — a correctly bound agent still reads complete, so the guard has not simply closed the door')
}


// ── The ceiling: exit 0 is unreachable, and that must cost something (#492) ──────────────────
//
// `--check` has four outcomes and one of them cannot happen — not "does not happen on a
// half-finished box", cannot happen, on any machine. Eleven rows are hardcoded at their call sites
// in tools/connect-agent.mjs: five pass a bare `null` for `found`, six pass a bare `false` for
// `verified`. `complete` requires zero unknown and zero unverified, so it is unreachable by
// construction. Each of those was a reasonable local decision; the aggregate lived in a different
// file from every one of them.
//
// Two properties. The report NAMES the ceiling, so a permanent exit 3 does not read as a local
// failure — and a new bare null or false cannot be added without landing in the allowlist, where a
// reader meets it.
{
  // Split a call's arguments on TOP-LEVEL commas only. `see('bunker-client', nonEmptyFile(p),
  // nonEmptyFile(p) && mode(p) === 0o600, …)` has commas inside parens and a naive split reads its
  // second argument as `nonEmptyFile(p)` — which is not a literal, so the row would go unchecked
  // and the scan would report a clean sweep of a file it had misread.
  const splitArgs = (src, from) => {
    const out = []
    let depth = 0, quote = null, start = from, i = from
    for (; i < src.length; i++) {
      const c = src[i], prev = src[i - 1]
      if (quote) { if (c === quote && prev !== '\\') quote = null; continue }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue }
      if ('([{'.includes(c)) { depth++; continue }
      if (')]}'.includes(c)) { if (depth === 0) { out.push(src.slice(start, i).trim()); return out } depth--; continue }
      if (c === ',' && depth === 0) { out.push(src.slice(start, i).trim()); start = i + 1 }
    }
    return out
  }
  const seeCalls = src => {
    const calls = []
    const re = /\bsee\(\s*'([^']+)'\s*,/g
    let m
    while ((m = re.exec(src))) calls.push({ key: m[1], args: splitArgs(src, m.index + m[0].length) })
    return calls
  }

  // POSITIVE CONTROL on the scanner itself, before it is believed about anything. A scanner that
  // silently found nothing would report every allowlist as complete.
  const fixture = "see('a', null, false, 'x')\nsee('b', f(p), f(p) && mode(p) === 0o600, `n`)\nsee('c', x === true ? true : null, false, 'y')"
  const fx = seeCalls(fixture)
  check(fx.length === 3 && fx.map(c => c.key).join(',') === 'a,b,c', 'the see() scanner finds every call in a fixture')
  check(fx[0].args[0] === 'null' && fx[0].args[1] === 'false', '  …and reads a bare null and a bare false as literals')
  check(fx[1].args[1] === 'f(p) && mode(p) === 0o600',
    '  …and does NOT split an argument on a comma inside parens — a naive split misreads this file and reports it clean')
  check(fx[2].args[0] === 'x === true ? true : null' && fx[2].args[1] === 'false',
    '  …and a ternary ending in null is not a bare null: the row can still be observed')

  const toolSrc = readFileSync(join(ROOT, 'tools', 'connect-agent.mjs'), 'utf8')
  const calls = seeCalls(toolSrc)
  check(calls.length >= 15, `the scan reads ${calls.length} see() calls out of connect-agent.mjs — a scan that found none would pass silently`)

  const bareNull = calls.filter(c => c.args[0] === 'null').map(c => c.key)
  const bareFalse = calls.filter(c => c.args[1] === 'false' && c.args[0] !== 'null').map(c => c.key)

  const unlisted = [
    ...bareNull.filter(k => !(k in NEVER_CHECKED)).map(k => `${k} (found: null)`),
    ...bareFalse.filter(k => !(k in NEVER_VERIFIED)).map(k => `${k} (verified: false)`),
  ]
  check(unlisted.length === 0,
    `every hardcoded null/false is declared in the allowlist${unlisted.length ? ` — UNDECLARED: ${unlisted.join(', ')}` : ''}`)
  // Both directions: a stale allowlist entry is its own defect. A key listed here that the tool no
  // longer hardcodes states that exit 0 is unreachable for a reason that has been fixed.
  const stale = [
    ...Object.keys(NEVER_CHECKED).filter(k => !bareNull.includes(k)),
    ...Object.keys(NEVER_VERIFIED).filter(k => !bareFalse.includes(k)),
  ]
  check(stale.length === 0, `and no allowlist entry outlives the call site it describes${stale.length ? ` — STALE: ${stale.join(', ')}` : ''}`)
  check(Object.keys(NEVER_CHECKED).every(k => ARTIFACT_KEYS.includes(k)) && Object.keys(NEVER_VERIFIED).every(k => ARTIFACT_KEYS.includes(k)),
    'and every allowlisted key is a real artifact — a typo would allow a row nothing checks')
  check(Object.values({ ...NEVER_CHECKED, ...NEVER_VERIFIED }).every(r => /settled by/.test(r)),
    'and every reason names what WOULD settle the row, because the remedy is off this machine')

  // NEGATIVE CONTROL — made to fire. A new bare null on a key nobody allowlisted must be caught.
  const mutated = toolSrc + "\nsee('mcp-registration', null, false, 'nobody looked')\n"
  const mutatedBad = seeCalls(mutated).filter(c => c.args[0] === 'null' && !(c.key in NEVER_CHECKED))
  check(mutatedBad.length === 1 && mutatedBad[0].key === 'mcp-registration',
    'NEGATIVE CONTROL — a new bare null on an unlisted key is caught, so this check can fail')

  // The allowlist asserted against the `complete` branch: this is the claim that adding a key here
  // is a decision to keep exit 0 unreachable.
  const asTheToolSets = { ...complete }
  for (const k of Object.keys(NEVER_CHECKED)) asTheToolSets[k] = { found: null, verified: false }
  for (const k of Object.keys(NEVER_VERIFIED)) asTheToolSets[k] = { found: true, verified: false }
  const best = installState(asTheToolSets)
  check(best.outcome === 'inconclusive' && best.exitCode === 3,
    'a PERFECTLY installed agent still exits 3 — exit 0 is unreachable while the allowlist is non-empty')
  check(best.atCeiling === true && /best result available here/.test(best.headline),
    '  …and the report says so, instead of leaving a permanent 3 to read as a local failure')
  check(/remedy for each is off this machine/.test(best.headline),
    '  …and points off the box, which is where every remaining row is settled')
  check(renderState(best).includes('best result available here'),
    '  …and the operator reads it, not just the caller')
  // The exit line, which is the line an operator reads for the verdict. Asserted at the call site
  // because producing a live at-the-ceiling run needs a fully installed agent on this machine.
  check(/exit \$\{report\.exitCode\} \(\$\{report\.outcome\}\$\{report\.atCeiling \?/.test(toolSrc),
    'and the tool puts it on the exit line too, not only in the headline forty lines up')

  // BOTH DIRECTIONS — the sentence must not appear when there IS something to do here. Otherwise
  // it is an alarm that always fires, which fails identically to one that never does.
  const oneRealGap = { ...asTheToolSets, 'manifest': { found: true, verified: false } }
  const real = installState(oneRealGap)
  check(real.atCeiling === false && !/best result available/.test(real.headline),
    'BOTH DIRECTIONS — one row that IS checkable and unverified drops the ceiling sentence entirely')
  check(installState({ ...asTheToolSets, 'manifest': { found: false } }).atCeiling === false,
    'and a missing row is never at the ceiling — something is absent and can be created')
  check(installState(complete).atCeiling === false,
    'and a report with nothing outstanding is not "the best available" — it is complete')
}

// ── The participation lane (#513) ────────────────────────────────────────────────────────────
//
// Two ways to participate, and until this the model could describe only one. Seven rows reach an
// ssh channel on the broker box; a sealed-lane agent authenticates to the bridge by signature and
// needs none of them — so `--check` told an agent onboarded exactly as the design describes that
// it could not run, and exited 1 saying so.
//
// The whole risk of the fix is in the other direction. A scope that excuses a row is one line from
// a scope that excuses every row, and both look like a suite that went green.
{
  const brokerKeys = ARTIFACTS.filter(a => a.lanes?.length === 1 && a.lanes[0] === 'broker').map(a => a.key)
  check(brokerKeys.length === 6, `six rows are scoped to the broker lane (found ${brokerKeys.length})`)
  check(ARTIFACTS.filter(a => !a.lanes).length > 0,
    'and most rows are scoped to no lane at all, which means every lane needs them')
  check(Object.keys(LANES).sort().join(',') === 'broker,sealed', 'two lanes, named')

  // `mcp-exclusive` is NOT one of them, and the distinction is what the row reads, not where it sits
  // in the list. It went out with the broker block for one commit because it was adjacent to it:
  // `foreignNvoyServers` reads THIS machine's MCP runtime configs, so it needs no ssh and no other
  // box. It is worst on the sealed lane — `foreignServers(names, name)` excludes `nvoy-<name>`, and
  // a sealed-lane agent has no such server, so every nvoy server in that session counts as foreign.
  // The lane it was scoped out of is the one where it has nothing of its own to compare against.
  check(!ARTIFACTS.find(a => a.key === 'mcp-exclusive').lanes,
    'mcp-exclusive is scoped to no lane — it reads this machine, not the broker')

  // The tool's own observations: everything found and verified, so nothing here is MISSING for a
  // reason other than the lane. That isolates the property — any refusal below is the scope.
  const sealed = installState(complete, { lane: 'sealed' })

  // 1. Scoped out, and NOT to `present`. This is the whole bullet the issue leads with: "satisfied"
  //    and "never asked for" are different reasons for a row not to be a problem, and a model that
  //    spells them the same way is how a genuinely missing credential reads green.
  check(brokerKeys.every(k => sealed.rows.find(r => r.key === k).state === NOT_APPLICABLE),
    'a sealed-lane agent reports all six broker rows NOT-APPLICABLE')
  check(brokerKeys.every(k => sealed.rows.find(r => r.key === k).state !== PRESENT),
    '  …and not one of them as PRESENT — "did not apply" is never "satisfied"')
  check(sealed.rows.find(r => r.key === 'mcp-exclusive').state === PRESENT,
    '  …and mcp-exclusive is still CHECKED on the sealed lane, not scoped out beside them')
  check(installState({ ...complete, 'mcp-exclusive': { found: false } }, { lane: 'sealed' })
    .missing.includes('mcp-exclusive'),
    '  …BOTH DIRECTIONS — and a foreign nvoy server still fails a sealed-lane agent')
  check(!sealed.notApplicable.some(k => sealed.missing.includes(k) || sealed.unverified.includes(k) || sealed.unknown.includes(k)),
    '  …and a scoped-out row appears in exactly one bucket, so no count double-reports it')
  check(sealed.counts.present === Object.keys(complete).length - brokerKeys.length,
    '  …and the present count drops by exactly six — the rows left the tally, they were not renamed into it')

  // 2. The row still exists and still says so. Dropping the six rows from the render would be the
  //    same defect one layer out: the reader cannot audit a scope they cannot see.
  const shown = renderState(sealed)
  check(brokerKeys.every(k => shown.includes(ARTIFACTS.find(a => a.key === k).title)),
    'the six are still printed, so the scope is auditable rather than invisible')
  check(!/\[ok \] The broker's host key/.test(shown) && /\[n\/a\] The broker's host key/.test(shown),
    '  …with their own glyph, never a tick')
  check(/6 rows did not apply to the sealed lane/.test(sealed.headline) && /not the same as satisfied/.test(sealed.headline),
    '  …and the headline says how many were skipped, and that skipped is not satisfied')

  // 3. The point of the change: this agent is no longer told it cannot run.
  check(sealed.exitCode !== 1 && sealed.outcome !== 'incomplete',
    'a sealed-lane agent with its own artifacts in place is NOT told "this agent cannot run"')

  // 4. BOTH DIRECTIONS. The same fully-installed observations, minus the broker artifacts, must
  //    still refuse on the broker lane. A gate that passes everything and one that passes the right
  //    things fail identically, and this is the assertion that tells them apart.
  const withoutBroker = { ...complete }
  for (const k of brokerKeys) withoutBroker[k] = { found: false }
  const asBroker = installState(withoutBroker, { lane: 'broker' })
  check(asBroker.exitCode === 1 && asBroker.outcome === 'incomplete',
    'BOTH DIRECTIONS — a BROKER-lane agent with no broker artifacts still cannot run')
  check(asBroker.missing.length === brokerKeys.length && brokerKeys.every(k => asBroker.missing.includes(k)),
    '  …and it names all six, rather than refusing for some other reason')
  check(installState(withoutBroker, { lane: 'sealed' }).exitCode !== 1,
    '  …and the SAME observations pass on the sealed lane — the lane is what differs, not the box')

  // 5. Undeclared is not sealed. The second bullet of the issue, and the one that could silently
  //    turn this whole file permissive: a default of "assume the lane with fewer requirements" is
  //    reached by deleting one `||` and looks exactly like this test passing.
  const undeclared = installState(withoutBroker)
  check(undeclared.exitCode === 1 && brokerKeys.every(k => undeclared.missing.includes(k)),
    'an UNDECLARED lane keeps every broker row required — silence is not a declaration')
  check(undeclared.notApplicable.length === 0,
    '  …and scopes nothing out at all')
  // The tool sets this row from the flag, so no flag means no observation. Asserted with the
  // observation removed rather than on `withoutBroker`, which declares every key satisfied.
  const { lane: _dropped, ...noLaneObserved } = withoutBroker
  check(installState(noLaneObserved).rows.find(r => r.key === 'lane').state === UNKNOWN,
    '  …and the lane row itself reads UNKNOWN, so the reader can see the declaration is absent')
  check(installState(complete).atCeiling === false,
    '  …and an undeclared agent is never "at the ceiling" — declaring the lane is a thing to do here')

  // 6. A lane name this build does not know is not a declaration either. Same failure mode as 5,
  //    reached by a typo rather than by omission.
  const typo = installState(withoutBroker, { lane: 'sealled' })
  check(typo.exitCode === 1 && typo.notApplicable.length === 0 && typo.lane === null,
    'an unrecognised lane name excuses nothing — `sealled` is not `sealed`')
  for (const bad of [null, undefined, '', 'toString', '__proto__', 'constructor', true, 0, {}, ['sealed']]) {
    if (installState(withoutBroker, { lane: bad }).notApplicable.length !== 0) {
      check(false, `  …and neither does ${JSON.stringify(bad) ?? String(bad)} — inherited Object keys are not lanes`)
    }
  }
  check(true, '  …and neither do null, empty, a boolean, an array, or an inherited Object property name')

  // 7. The ceiling still means what it meant. A sealed-lane agent whose only outstanding rows are
  //    ones this build never checks has reached the best answer available here — which is exit 3,
  //    not exit 0. Exit 0 stays unreachable (#492) and this change does not alter that.
  const atCeiling = installState(
    Object.fromEntries(ARTIFACT_KEYS.map(k => [k,
      k in NEVER_CHECKED ? { found: null } : k in NEVER_VERIFIED ? { found: true } : { found: true, verified: true }])),
    { lane: 'sealed' })
  check(atCeiling.exitCode === 3 && atCeiling.atCeiling === true,
    'a fully-installed sealed-lane agent reaches exit 3 AT THE CEILING — the best this build can report')
  check(atCeiling.outcome !== 'complete',
    '  …and never exit 0, which is still unreachable by construction (#492)')
}

// ── …and the tool declares it, refuses a bad one, and mints no broker key without it ──────────
{
  const src = readFileSync(join(ROOT, 'tools', 'connect-agent.mjs'), 'utf8')
  if (src.length < 2000) {
    console.error(`agent_install_state: INCONCLUSIVE — connect-agent.mjs read back only ${src.length} bytes`)
    process.exit(3)
  }
  // BOTH scoping axes, because a flag the tool parses and drops changes nothing. `--runtime` joined
  // `--lane` here when the MCP rows started reading it (#526): the tool grew the flag, and a version
  // that read it and never passed it on would leave a Pi blocked by exactly the row the flag exists
  // to scope out — with the command line looking correct.
  check(/installState\(obs,\s*\{\s*lane,\s*mcp:\s*HAS_MCP\s*\}\)/.test(src),
    'the tool passes the declared lane AND the runtime MCP verdict to installState')
  check(/const HAS_MCP = runtimeId \? runtime\(runtimeId\)\.kind !== 'none' : null/.test(src),
    "…and derives that verdict from the runtime registry's own kind, not from a second list of ids")
  // Key material created "just in case" is key material nobody is tracking, and a sealed-lane agent
  // has no broker to present an ssh key to.
  check(/!CHECK && !STARTUP_ONLY && !SEALED/.test(src),
    'and it mints no channel keypair on the sealed lane')

  const probeRoot = mkdtempSync(join(tmpdir(), 'wb-lane-probe-'))
  const run = args => {
    try {
      return { out: execFileSync(process.execPath, [join(ROOT, 'tools', 'connect-agent.mjs'), ...args],
        { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 }
    } catch (e) {
      if (e?.signal || e?.code === 'ETIMEDOUT') return null
      return { out: `${typeof e?.stdout === 'string' ? e.stdout : ''}${typeof e?.stderr === 'string' ? e.stderr : ''}`, code: e?.status ?? null }
    }
  }
  const base = ['--name', 'probe', '--check', '--root', probeRoot]

  // Assert the REASON, not only the refusal. `!ok` cannot tell a correct refusal from a correct
  // refusal that sends the operator somewhere useless, and the remedy here is the list of lanes.
  const bad = run([...base, '--lane', 'sealled'])
  if (bad === null || !bad.out) {
    console.error('agent_install_state: INCONCLUSIVE — connect-agent.mjs never ran for the --lane refusal')
    rmSync(probeRoot, { recursive: true, force: true }); process.exit(3)
  }
  check(bad.code === 1 && /--lane must be one of: sealed, broker/.test(bad.out),
    'the tool refuses an unknown --lane and names the ones it takes')
  check(!/Declared participation lane/.test(bad.out),
    '  …and refuses before rendering a report, so a typo cannot look like a run')

  const live = run([...base, '--lane', 'sealed'])
  if (live === null || !live.out || live.out.length < 500) {
    console.error(`agent_install_state: INCONCLUSIVE — --lane sealed produced ${live?.out?.length ?? 0} bytes`)
    console.error('  This is NOT an all-clear: the tool was never observed reporting anything.')
    rmSync(probeRoot, { recursive: true, force: true }); process.exit(3)
  }
  check(/\[ok \] Declared participation lane/.test(live.out) && /sealed —/.test(live.out),
    'a live --lane sealed run reports the declaration as its own row')
  check((live.out.match(/\[n\/a\]/g) || []).length === 6,
    '  …and renders exactly six n/a rows')
  const undeclaredRun = run(base)
  if (undeclaredRun === null || !undeclaredRun.out || undeclaredRun.out.length < 500) {
    console.error('agent_install_state: INCONCLUSIVE — the undeclared control never produced a report')
    rmSync(probeRoot, { recursive: true, force: true }); process.exit(3)
  }
  check(!/\[n\/a\]/.test(undeclaredRun.out) && /no --lane given/.test(undeclaredRun.out),
    'BOTH DIRECTIONS — the same run with no --lane scopes nothing out, and says why')

  // ── The MCP rows need an MCP, live through the tool (#526) ──────────────────────────────────
  // Driven through the tool rather than asserted on `installState` alone, because the defect was in
  // the seam: the module could scope the row perfectly and the tool never tell it which runtime.
  const EXCL = /No other nvoy server registered/
  const rowState = (out, re) => (out.split('\n').find(l => re.test(l)) || '').match(/\[(.{1,3})\]/)?.[1]?.trim() ?? null
  const piRun = run([...base, '--lane', 'sealed', '--runtime', 'pi'])
  const claudeRun = run([...base, '--lane', 'sealed', '--runtime', 'claude'])
  if (!piRun?.out || !claudeRun?.out || piRun.out.length < 500 || claudeRun.out.length < 500) {
    console.error('agent_install_state: INCONCLUSIVE — a runtime-scoped run produced no report')
    rmSync(probeRoot, { recursive: true, force: true }); process.exit(3)
  }
  check(rowState(piRun.out, EXCL) === 'n/a',
    "a runtime with no MCP client scopes the exclusivity row out — Pi is kind:'none', so the hazard cannot reach it")
  check(!/\[ok \][^\n]*No other nvoy server/.test(piRun.out),
    '  …as NOT-APPLICABLE and never as ok — "did not apply" and "passed" must not collapse into one cell')
  // The direction that matters more. A fix that simply stopped checking would pass the line above.
  check(rowState(claudeRun.out, EXCL) === 'x' || rowState(claudeRun.out, EXCL) === 'ok',
    'BOTH DIRECTIONS — a runtime that HAS an MCP is still judged on the row, not scoped out of it')
  check(rowState(undeclaredRun.out, EXCL) !== 'n/a',
    'and an UNDECLARED runtime still applies it — silence is not a claim that the hazard is absent')
  const badRt = run([...base, '--runtime', 'nope'])
  check(badRt?.code === 1 && /--runtime nope is not one of/.test(badRt.out || ''),
    'an unknown --runtime is refused by name, rather than resolving to "no MCP" and scoping the row out')
  rmSync(probeRoot, { recursive: true, force: true })
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
