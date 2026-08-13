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

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installState, renderState, foreignNvoyServers, ARTIFACTS, ARTIFACT_KEYS, PRESENT, UNVERIFIED, MISSING, UNKNOWN }
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
// Thirteen artifacts verified whether the agent could ACT. None asked whether anything could reach
// it, and an admitted agent was live for a day posting successfully while structurally unable to
// receive a single message. Two separate things are pinned here, because closing only the first
// leaves the same hole one refactor away.
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
    `every artifact is reported by connect-agent.mjs${unreported.length ? ` — unreported: ${unreported.join(', ')}` : ''}`)
  check(!seen.includes('no-such-artifact-key'),
    'NEGATIVE CONTROL — the scan does not report a key the tool never mentions')
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
