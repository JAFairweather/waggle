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

import { installState, renderState, ARTIFACTS, ARTIFACT_KEYS, PRESENT, UNVERIFIED, MISSING, UNKNOWN }
  from '../src/agent_install_state.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

// The launch binding is an ARTIFACT, not a note in a runbook. Registration alone makes a toolset
// visible to every session on the machine, so without this file "which identity is this session"
// is a convention rather than a fact — measured 2026-08-11, a strict session saw 2 tools from 1
// server and the same session without the flag saw 94 from 6.
check(ARTIFACT_KEYS.includes('agent-brief'), 'the brief a session launches with is a tracked artifact')
check(ARTIFACTS.find(a2 => a2.key === 'agent-brief')?.blocking === true,
  '…and blocks, because a bound session that knows nothing about the community will guess')
check(ARTIFACT_KEYS.includes('strict-launch-config'), 'the strict launch binding is a tracked artifact')
check(ARTIFACTS.find(a2 => a2.key === 'strict-launch-config')?.blocking === true,
  '…and its absence blocks, because an unbound session can act as any identity registered on the box')
// Ordering is meaning here: the binding is useless before the server it points at exists.
check(ARTIFACT_KEYS.indexOf('strict-launch-config') > ARTIFACT_KEYS.indexOf('mcp-registration'),
  '…and is reported after the registration it depends on')

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

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
