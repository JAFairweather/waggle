// #129 pull-based deploy runner — regression test for deploy/deploy-runner.sh.
//
// Proves the gates the issue names, with NO box: the runner's box-facing actions are seams
// (CI-state query, npm, systemctl) so the test drives them locally. A real git clone stands
// in for the on-box hub, and verify-deployed.sh runs for real in local-tree mode — the same
// check the runner will run on the droplet, only the transport differs.
//
// Asserts:
//   1. green commit  -> deploys: tree gets the code, DEPLOYED_SHA recorded, restart invoked,
//                       post-deploy verify passes, exit 0
//   2. config.json / .env / data/ pre-existing on the tree are NEVER touched by a deploy
//   3. pending CI    -> skips (exit 0, nothing shipped)
//   4. red CI        -> refuses (exit 0, nothing shipped) — merged is not enough
//   5. already current -> nothing to do on the second tick (no re-ship, no restart)
//   6. drift between ship and verify -> ALARM, exit 1 (never logs-and-passes)
//
// Run: node tests/deploy_runner.mjs   (exit 0 = pass, 1 = fail)

import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = 'deploy/deploy-runner.sh'
// Fixture trees intentionally omit the private live policy. Production uses the runner default;
// individual tests may override this seam to prove that policy failure blocks DEPLOYED_SHA.
process.env.WB_CONFIG_VERIFY_CMD = ':'
let failed = 0
const check = (cond, msg) => { if (!cond) { console.error('  ✗', msg); failed++ } else { console.log('  ✓', msg) } }

// Production uses the default command, not the seam below. verify-config is a bash script
// (`pipefail` + BASH_SOURCE), so forcing it through `sh` fails on Ubuntu's dash after code has
// already shipped and leaves DEPLOYED_SHA permanently stale.
const runnerSource = readFileSync(join(REPO, SCRIPT), 'utf8')
check(/CONFIG_VERIFY_CMD="\$\{WB_CONFIG_VERIFY_CMD:-bash /.test(runnerSource),
  'production policy verifier honors its bash runtime instead of forcing /bin/sh')

// The bridge persists signed operator decisions in config.json. ProtectSystem=strict remains
// load-bearing, so the service may write that one policy file and data/, never its code tree.
const readUnit = readFileSync(join(REPO, 'deploy', 'waggle-read.service'), 'utf8')
check(/ProtectSystem=strict/.test(readUnit), 'read lane keeps ProtectSystem=strict')
check(/ReadWritePaths=\/opt\/waggle-read\/data \/opt\/waggle-read\/config\.json/.test(readUnit),
  'read lane may persist config.json without gaining write access to the code tree')

// The runner ships with rsync, so without it every deploy-path case fails — eleven red checks
// that read as eleven regressions and are really one missing binary. Say which it is: exit 3 =
// INCONCLUSIVE, the same signal tripwire.mjs and verify-firewall.sh use. NOT an all-clear, and
// not a pass — a suite that cannot run must never look like a suite that ran.
try { execFileSync('sh', ['-c', 'command -v rsync'], { stdio: 'ignore' }) }
catch {
  console.error('deploy_runner: INCONCLUSIVE — rsync is not installed, so the deploy path cannot be')
  console.error('  exercised at all. This is NOT an all-clear. Install rsync and re-run.')
  process.exit(3)
}

const work = mkdtempSync(join(tmpdir(), 'wb-runner-'))
// One hub clone shared across cases (the runner only reads + detaches within it).
const hub = join(work, 'hub')
execSync(`git clone --quiet --no-hardlinks "${REPO}" "${hub}"`, { stdio: 'ignore' })
// Resolve the target from the clone's HEAD, not origin/main: CI checks the repo out in
// DETACHED HEAD (no local main branch), so the clone has no origin/main to rev-parse. HEAD
// is the checked-out commit either way. Pass it explicitly as WB_REF on every run below.
const TARGET = execSync(`git -C "${hub}" rev-parse HEAD`, { encoding: 'utf8' }).trim()

// Run the runner against a fresh tree. state = CI stub (success|failure|pending); extraEnv
// lets a case override npm/restart. Returns { code, out, tree, restartMarker }.
let caseN = 0
function runCase(state, extraEnv = {}) {
  const tree = join(work, `tree-${caseN++}`)
  mkdirSync(tree, { recursive: true })
  const restartMarker = join(tree, '.restarted')
  const env = {
    ...process.env,
    WB_HUB: hub,
    WB_TREE: tree,
    WB_REF: TARGET,                                    // explicit sha (no origin/main in a CI clone)
    WB_NO_FETCH: '1',                                  // offline: drive the hub as-is
    STUB_CI_STATE: state,
    WB_CI_STATE_CMD: 'echo "$STUB_CI_STATE" #',        // ignore the sha arg (commented out)
    WB_NPM_CMD: ':',                                   // no registry in the test
    WB_RESTART_CMD: `touch "${restartMarker}" #`,      // record the restart, ignore unit arg
    ...extraEnv,
  }
  let code = 0, out = ''
  try {
    // merge stderr (where alarms go) into the captured output, on success AND failure
    out = execFileSync('sh', ['-c', `sh "${SCRIPT}" read 2>&1`], { cwd: REPO, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) { code = e.status ?? 1; out = (e.stdout || '') + (e.stderr || '') }
  return { code, out, tree, restartMarker }
}

try {
  // (1) green -> full deploy
  const g = runCase('success')
  check(g.code === 0, 'green commit -> exit 0')
  check(existsSync(join(g.tree, 'src', 'bridge.mjs')), 'green -> code shipped into tree (src/bridge.mjs)')
  check(existsSync(g.restartMarker), 'green -> unit restart invoked')
  check(existsSync(join(g.tree, 'DEPLOYED_SHA')), 'green -> DEPLOYED_SHA recorded')
  check(existsSync(join(g.tree, 'DEPLOYED_SHA')) &&
        readFileSync(join(g.tree, 'DEPLOYED_SHA'), 'utf8').trim() === TARGET, 'green -> recorded SHA == target')
  check(/deploy OK/.test(g.out) && /verified/.test(g.out), 'green -> post-deploy verify passed')
  // config.json / .env / data/ must never appear from a deploy (they are not in the ship list)
  check(!existsSync(join(g.tree, 'config.json')), 'deploy never creates config.json')

  // (2) live-only files pre-existing on the tree survive a deploy untouched
  const keep = runCase('success', {})
  const cfg = join(keep.tree, 'config.json'), env = join(keep.tree, '.env'), data = join(keep.tree, 'data')
  mkdirSync(data, { recursive: true })
  writeFileSync(cfg, '{"live":"policy"}'); writeFileSync(env, 'SECRET=1'); writeFileSync(join(data, 'seen.log'), 'a\nb\n')
  // deploy on top of the seeded tree
  const keep2 = (() => {
    const restartMarker = join(keep.tree, '.restarted2')
    const e = { ...process.env, WB_HUB: hub, WB_TREE: keep.tree, WB_REF: TARGET, WB_NO_FETCH: '1',
      STUB_CI_STATE: 'success', WB_CI_STATE_CMD: 'echo "$STUB_CI_STATE" #', WB_NPM_CMD: ':',
      WB_RESTART_CMD: `touch "${restartMarker}" #` }
    // force a re-deploy by clearing the recorded sha
    rmSync(join(keep.tree, 'DEPLOYED_SHA'), { force: true })
    let code = 0, out = ''
    try { out = execFileSync('sh', ['-c', `sh "${SCRIPT}" read 2>&1`], { cwd: REPO, env: e, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }) }
    catch (x) { code = x.status ?? 1; out = (x.stdout||'')+(x.stderr||'') }
    return { code, out }
  })()
  check(keep2.code === 0, 'deploy over a live tree -> exit 0')
  check(readFileSync(cfg, 'utf8') === '{"live":"policy"}', 'config.json content untouched by deploy')
  check(readFileSync(env, 'utf8') === 'SECRET=1', '.env content untouched by deploy')
  check(readFileSync(join(data, 'seen.log'), 'utf8') === 'a\nb\n', 'data/ content untouched by deploy')

  // (3) pending CI -> skip, ship nothing
  const p = runCase('pending')
  check(p.code === 0, 'pending CI -> exit 0 (retry next tick)')
  check(!existsSync(join(p.tree, 'src')), 'pending -> nothing shipped')
  check(!existsSync(p.restartMarker), 'pending -> no restart')
  check(/still running/.test(p.out), 'pending -> reports waiting, not failure')

  // (4) red CI -> refuse, ship nothing
  const r = runCase('failure')
  check(r.code === 0, 'red CI -> exit 0 (refuse, do not fail the timer)')
  check(!existsSync(join(r.tree, 'src')), 'red -> nothing shipped')
  check(!existsSync(r.restartMarker), 'red -> no restart')
  check(/RED/.test(r.out), 'red -> alarms that main is red')

  // (5) already current -> no work on the second tick
  const first = runCase('success')
  check(first.code === 0 && existsSync(first.restartMarker), 'first deploy succeeded')
  rmSync(first.restartMarker, { force: true })
  let out2 = '', code2 = 0
  try {
    out2 = execFileSync('sh', ['-c', `sh "${SCRIPT}" read 2>&1`], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WB_HUB: hub, WB_TREE: first.tree, WB_REF: TARGET, WB_NO_FETCH: '1',
             STUB_CI_STATE: 'success', WB_CI_STATE_CMD: 'echo "$STUB_CI_STATE" #',
             WB_NPM_CMD: ':', WB_RESTART_CMD: `touch "${first.restartMarker}" #` },
    })
  } catch (e) { code2 = e.status ?? 1; out2 = (e.stdout || '') + (e.stderr || '') }
  check(code2 === 0, 'second tick on same SHA -> exit 0')
  check(/already current/.test(out2), 'second tick -> "already current"')
  check(!existsSync(first.restartMarker), 'second tick -> no re-restart')

  // (6) drift between ship and verify -> ALARM, exit 1. Model it by mutating a shipped file
  // in the NPM step (which runs after rsync, before verify), so the tree no longer matches git.
  const d = runCase('success', { WB_NPM_CMD: 'printf "\\n// injected drift\\n" >> src/bridge.mjs' })
  check(d.code === 1, 'post-deploy drift -> exit 1')
  check(/ALARM/.test(d.out) && /drift/i.test(d.out), 'drift -> ALARM emitted, not a silent pass')

  // (6b) #136 — a FAILED verify must NOT record the SHA, and the fault must alarm on EVERY tick.
  //
  // This is the property the whole issue rests on. The SHA used to be written before verify, so
  // a tree that failed verification still claimed success: the next tick read "already current",
  // skipped, and a standing drift alarmed exactly ONCE. An alarm that fires once for an ongoing
  // fault is indistinguishable from one that was handled.
  check(!existsSync(join(d.tree, 'DEPLOYED_SHA')),
    'drift -> DEPLOYED_SHA NOT recorded (an unverified deploy is not a deploy)')

  // Second tick against the SAME broken tree: it must re-deploy and re-alarm, never go quiet.
  const d2 = (() => {
    const env = {
      ...process.env, WB_HUB: hub, WB_TREE: d.tree, WB_REF: TARGET, WB_NO_FETCH: '1',
      STUB_CI_STATE: 'success', WB_CI_STATE_CMD: 'echo "$STUB_CI_STATE" #',
      WB_NPM_CMD: 'printf "\\n// injected drift\\n" >> src/bridge.mjs',
      WB_RESTART_CMD: 'true #',
    }
    try {
      return { code: 0, out: execFileSync('sh', ['-c', `sh "${SCRIPT}" read 2>&1`], { cwd: REPO, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
    } catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') } }
  })()
  check(d2.code === 1, 'drift, second tick -> STILL exit 1 (a standing fault keeps failing)')
  check(/ALARM/.test(d2.out), 'drift, second tick -> alarms AGAIN, not once')
  // Assert the POSITIVE — that it re-shipped — rather than the absence of the skip wording. A
  // first draft checked !/already current/ and failed against the runner's own alarm text, which
  // quotes that phrase: a negative string assertion is only as good as every other string in the
  // output, and this repo has an alarm whose job is to mention the thing it prevented.
  check(/shipping code into/.test(d2.out),
    'drift, second tick -> re-deploys instead of skipping the tree as up to date')

  // (7) WB_TREE unset (every production run) must not trip `set -e` on the override guard.
  // DRY_RUN so it resolves + gates green, then reports, without writing to the real /opt tree.
  let dc = 0, dOut = ''
  try {
    dOut = execFileSync('sh', ['-c', `sh "${SCRIPT}" read 2>&1`], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WB_HUB: hub, WB_REF: TARGET, WB_NO_FETCH: '1', DRY_RUN: '1',
             STUB_CI_STATE: 'success', WB_CI_STATE_CMD: 'echo "$STUB_CI_STATE" #' },
    })
  } catch (e) { dc = e.status ?? 1; dOut = (e.stdout || '') + (e.stderr || '') }
  check(dc === 0, 'WB_TREE unset + DRY_RUN -> exit 0 (no set -e trip on the override guard)')
  check(/DRY_RUN/.test(dOut) && /waggle-read/.test(dOut), 'unset WB_TREE -> tree defaults to /opt/waggle-read')

  // (8) the no-op gate (#162): a commit that changes NO shipped file must not restart the lane.
  //
  // The runner deploys `main` HEAD, and most merges here are docs. Without this gate each one
  // rsyncs byte-identical content, runs npm ci and bounces the bridge — dropping every relay
  // subscription to change nothing. The cases below run on the SAME tree in sequence, because
  // the gate is about the transition from one deployed SHA to the next.
  const tick = (tree, ref, marker, extraEnv = {}) => {
    let c = 0, o = ''
    try {
      o = execFileSync('sh', ['-c', `sh "${SCRIPT}" read 2>&1`], {
        cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, WB_HUB: hub, WB_TREE: tree, WB_REF: ref, WB_NO_FETCH: '1',
               STUB_CI_STATE: 'success', WB_CI_STATE_CMD: 'echo "$STUB_CI_STATE" #',
               WB_NPM_CMD: ':', WB_RESTART_CMD: `touch "${marker}" #`, ...extraEnv },
      })
    } catch (e) { c = e.status ?? 1; o = (e.stdout || '') + (e.stderr || '') }
    return { code: c, out: o }
  }

  // Two commits on top of TARGET in the hub: one touching only an unshipped path, one touching
  // a shipped one. Made on a detached HEAD so the hub's own checkout state is irrelevant.
  const inHub = (cmd) => execSync(`git -C "${hub}" ${cmd}`, { encoding: 'utf8' }).trim()
  inHub(`-c advice.detachedHead=false checkout --quiet --detach ${TARGET}`)
  writeFileSync(join(hub, 'README.md'), readFileSync(join(hub, 'README.md'), 'utf8') + '\n<!-- docs-only -->\n')
  inHub('add README.md')
  inHub('-c user.email=t@t -c user.name=t commit --quiet -m "docs only"')
  const DOCS_SHA = inHub('rev-parse HEAD')
  writeFileSync(join(hub, 'src', 'log.mjs'), readFileSync(join(hub, 'src', 'log.mjs'), 'utf8') + '\n// shipped change\n')
  inHub('add src/log.mjs')
  inHub('-c user.email=t@t -c user.name=t commit --quiet -m "code change"')
  const CODE_SHA = inHub('rev-parse HEAD')

  const nt = join(work, 'tree-noop')
  mkdirSync(nt, { recursive: true })
  const nm = join(nt, '.restarted')

  const base = tick(nt, TARGET, nm)
  check(base.code === 0 && existsSync(nm), 'no-op gate: baseline deploy restarts, as before')

  rmSync(nm, { force: true })
  const docsTick = tick(nt, DOCS_SHA, nm)
  check(docsTick.code === 0, 'docs-only commit -> exit 0')
  check(!existsSync(nm), 'docs-only commit -> lane NOT restarted')
  check(/no shipped files changed/.test(docsTick.out), 'docs-only -> says why it skipped, never silently')
  check(readFileSync(join(nt, 'DEPLOYED_SHA'), 'utf8').trim() === DOCS_SHA,
    'docs-only -> SHA still recorded, so the next tick is not re-evaluated')
  check(/verified/.test(docsTick.out), 'docs-only -> tree still VERIFIED, not merely assumed')

  // #104: the no-op path is still a deploy decision. It must refuse an incomplete private
  // routing policy and leave the old watermark so the next timer tick re-alarms.
  const policyTree = join(work, 'tree-noop-policy')
  mkdirSync(policyTree, { recursive: true })
  const policyMarker = join(policyTree, '.restarted')
  const policyBase = tick(policyTree, TARGET, policyMarker)
  check(policyBase.code === 0, 'no-op policy gate: baseline deploy succeeds')
  const policyDocs = tick(policyTree, DOCS_SHA, policyMarker, { WB_CONFIG_VERIFY_CMD: 'false' })
  check(policyDocs.code === 1, 'docs-only with incomplete policy -> exit 1')
  check(/policy is incomplete/.test(policyDocs.out), 'docs-only incomplete policy -> loud alarm')
  check(readFileSync(join(policyTree, 'DEPLOYED_SHA'), 'utf8').trim() === TARGET,
    'docs-only incomplete policy -> old DEPLOYED_SHA retained for retry')

  // NEGATIVE CONTROL. The checks above pass just as happily if the gate skipped everything
  // unconditionally — a runner that never restarts and one that restarts only when needed are
  // indistinguishable until a real code change is put through it.
  rmSync(nm, { force: true })
  const codeTick = tick(nt, CODE_SHA, nm)
  check(codeTick.code === 0, 'NEGATIVE CONTROL — shipped-file change -> exit 0')
  check(existsSync(nm), 'NEGATIVE CONTROL — shipped-file change DOES restart the lane')
  check(!/no shipped files changed/.test(codeTick.out), 'NEGATIVE CONTROL — did not take the no-op path')
  check(/\/\/ shipped change/.test(readFileSync(join(nt, 'src', 'log.mjs'), 'utf8')),
    'NEGATIVE CONTROL — the new code actually reached the tree')

  // Being unable to answer the question is not a reason to skip work: a recorded SHA the hub
  // does not have (force-push, rebase, a restored tree) must fall through to a full deploy.
  rmSync(nm, { force: true })
  writeFileSync(join(nt, 'DEPLOYED_SHA'), 'f'.repeat(40) + '\n')
  const orphan = tick(nt, CODE_SHA, nm)
  check(orphan.code === 0 && existsSync(nm), 'unknown recorded SHA -> falls through to a full deploy')
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failed) { console.error(`deploy_runner: ${failed} check(s) failed`); process.exit(1) }
console.log('deploy_runner: all checks passed')
