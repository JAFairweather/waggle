#!/usr/bin/env node
// waggle-host-bootstrap.mjs — the thin runner for the #305 host bootstrap.
//
//   waggle-host-bootstrap.mjs --state <install-state.json> [--check | --apply] [--assume-yes]
//
// `--check` is the default and never mutates. `--check` and `--apply` run the SAME planner and the
// SAME verdict; the only difference is whether actions are executed. That is deliberate — a check
// that computes something different from the apply is a check of nothing.
//
// All policy lives in `src/host_bootstrap.mjs`, which is pure. This file only gathers host facts and
// executes. It has no opinions: an action kind it does not recognise is a refusal, never a no-op,
// because silently skipping an unknown action would report a host as bootstrapped that is not.
//
// Exit: 0 satisfied · 1 work outstanding or drifted · 3 INCONCLUSIVE (a fact could not be read).

import { existsSync, lstatSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { planHostBootstrap, pendingActions, bootstrapVerdict, bootstrapEvidence } from '../src/host_bootstrap.mjs'
import { loadInstallState, saveInstallState, transitionInstallStep } from '../src/install_state.mjs'

const flag = n => { const i = process.argv.indexOf(n); return i < 0 ? '' : process.argv[i + 1] || '' }
const has = n => process.argv.includes(n)
const die = m => { console.error(`waggle-host-bootstrap: ${m}`); process.exit(1) }

const statePath = flag('--state')
if (!statePath) die('usage: --state <install-state.json> [--check | --apply]')
const apply = has('--apply')
if (apply && has('--check')) die('--check and --apply are mutually exclusive')

let state
try { state = loadInstallState(statePath) } catch (e) { die(`cannot load install state: ${e.message}`) }

// ---- fact gathering ---------------------------------------------------------------------------
// Every probe distinguishes three outcomes: satisfied, absent, and COULD NOT TELL. The third is
// reported as unreadable rather than folded into absent — that fold is how a failed probe becomes
// an overwrite of something live.
const present = {}, unreadable = []
const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 })
  if (r.error && r.error.code === 'ENOENT') return { missing: true }
  if (r.status === null) return { unreadable: true }
  return { status: r.status, out: (r.stdout || '').trim() }
}

function probeDirectory (id, path, wantMode) {
  try {
    if (!existsSync(path)) return
    const st = lstatSync(path)
    if (!st.isDirectory() || st.isSymbolicLink()) { present[id] = { note: 'exists but is not a plain directory' }; return }
    const mode = (st.mode & 0o777).toString(8).padStart(4, '0')
    if (wantMode && mode !== wantMode) { present[id] = { mode }; return }
    present[id] = true
  } catch { unreadable.push(id) }
}

function probeUser (id, name) {
  const r = sh('id', ['-u', name])
  if (r.missing || r.unreadable) { unreadable.push(id); return }
  if (r.status === 0) present[id] = true
}

function probeUnit (id, unit) {
  const r = sh('systemctl', ['is-enabled', unit])
  if (r.missing) { unreadable.push(id); return }   // no systemd here: cannot judge, do not guess
  if (r.unreadable) { unreadable.push(id); return }
  if (r.out === 'enabled') present[id] = true
  else if (r.out) present[id] = { enabled: r.out }
}

// A first pass over a bare plan tells us which ids to probe, so the probe set and the action set
// cannot drift apart.
for (const a of planHostBootstrap(state)) {
  if (a.kind === 'system_user') probeUser(a.id, a.want.name)
  else if (a.kind === 'directory') probeDirectory(a.id, a.want.path, a.mode)
  else if (a.kind === 'systemd_unit' || a.kind === 'systemd_timer') probeUnit(a.id, a.want.name)
  else if (a.kind === 'code_checkout') {
    if (!existsSync(a.want.path)) continue
    const head = sh('git', ['-C', a.want.path, 'rev-parse', '--abbrev-ref', 'HEAD'])
    if (head.missing || head.unreadable || head.status !== 0) { unreadable.push(a.id); continue }
    present[a.id] = head.out === a.want.ref ? true : { ref: head.out }
  } else {
    // time_sync, firewall_rule, deploy_runner: host-specific and not probed by this runner yet.
    // Reported as unreadable so they surface as INCONCLUSIVE rather than silently passing.
    unreadable.push(a.id)
  }
}

const plan = planHostBootstrap(state, { present, unreadable })
const verdict = bootstrapVerdict(plan)

// ---- report ------------------------------------------------------------------------------------
const mark = { satisfied: '  ok', missing: ' add', drifted: 'DRIFT', blocked: 'BLOCK' }
console.log(`\nhost bootstrap · installation ${state.installation_id}\n`)
for (const a of plan) console.log(`  ${mark[a.state]}  ${a.id.padEnd(22)} ${a.reason}`)
console.log(`\n${verdict.status.toUpperCase()} — ${verdict.missing} to add · ${verdict.drifted} drifted · ${verdict.blocked} unreadable`)

if (!apply) {
  console.log('\n(check only; nothing was changed. re-run with --apply to act)')
  process.exit(verdict.exit)
}

// ---- apply ---------------------------------------------------------------------------------------
if (verdict.blocked) die('refusing to apply while any host fact is unreadable — resolve those first')
const todo = pendingActions(plan)
if (todo.some(a => a.destructive) && !has('--assume-yes')) {
  die('this plan contains a destructive action; re-run with --assume-yes if that is intended')
}
if (todo.some(a => a.state === 'drifted')) {
  // Drift means something is already there and differs. Correcting it is a replacement, and this
  // bootstrap does not replace: an operator decides whether the live thing or the plan is right.
  die('refusing to apply over drift — reconcile the drifted actions by hand, then re-run')
}
console.log(`\napplying ${todo.length} action(s)…`)
for (const a of todo) {
  console.log(`  … ${a.id}`)
  // The executor is intentionally not implemented in this slice: the planner, the probes, the
  // verdict and the refusals are what needed to exist first, and shipping a half-written executor
  // that runs as root is worse than shipping none. `--apply` therefore refuses rather than pretends.
  die(`no executor is wired for action kind '${a.kind}' yet — this slice ships the planner and the checks; run the printed plan by hand`)
}

const advanced = transitionInstallStep(state, 'host_bootstrap', {
  status: verdict.exit === 0 ? 'passed' : 'failed',
  evidence: [bootstrapEvidence(plan, verdict)],
})
saveInstallState(statePath, advanced)
console.log('install state advanced')
process.exit(verdict.exit)
