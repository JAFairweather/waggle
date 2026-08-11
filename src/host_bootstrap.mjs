// host_bootstrap.mjs — the idempotent host consumer of the #305 install state.
//
// It introduces NO second setup vocabulary: it consumes `install_state.mjs`'s closed step
// catalogue and advances `host_bootstrap`. This file is pure — it plans, it never executes, never
// shells out and never touches the filesystem — so the plan can be asserted in full without a host.
// `tools/waggle-host-bootstrap.mjs` is the thin runner that applies a plan.
//
// Two rules shape everything here:
//
//   1. A plan is a set of DESIRED STATES, not commands. Re-running must converge, so every action
//      declares what it wants to be true and is skipped when the host already reports that. This is
//      what makes `--check` and `--apply` the same computation, differing only in whether the
//      runner acts.
//   2. Nothing here ever plans to overwrite a credential or an identity. #305 requires every step
//      to refuse that, and the refusal must be visible in the plan rather than left to the runner's
//      good manners — a runner that decides is a second policy.

export const HOST_BOOTSTRAP_VERSION = 1
// Closed and ordered. A caller cannot introduce an action kind, and the runner switches on exactly
// this set — an unknown kind is a refusal, not a default branch.
export const ACTION_KINDS = Object.freeze([
  'directory', 'system_user', 'code_checkout', 'systemd_unit', 'systemd_timer',
  'firewall_rule', 'time_sync', 'deploy_runner',
])
export const ACTION_STATES = Object.freeze(['satisfied', 'missing', 'drifted', 'blocked'])

const fail = message => { throw new Error(`host-bootstrap: ${message}`) }
const ID = /^[a-z][a-z0-9_-]{1,63}$/

// Ownership is stated per action rather than assumed, because the whole point of the split users is
// that the broker cannot read what the adapter writes.
const action = (kind, id, want, opts = {}) => Object.freeze({
  kind, id, want,
  owner: opts.owner || 'root',
  mode: opts.mode || null,
  reason: opts.reason || '',
  // A destructive action is one that could remove or replace something already on the host. The
  // planner marks them; the runner must refuse to apply one without an explicit confirmation.
  destructive: Boolean(opts.destructive),
  state: opts.state || 'missing',
})

/**
 * Build the desired-state plan for one installation.
 *
 * `facts` is what the host currently reports — supplied by the runner, never gathered here, so the
 * planner stays pure and the same facts can be replayed in a test. Anything absent from `facts` is
 * treated as unknown rather than absent: planning an action on a fact we could not read would let
 * a failed probe look like a missing directory and get "fixed" by overwriting a live one.
 */
export function planHostBootstrap(state, facts = {}) {
  if (!state || typeof state !== 'object') fail('install state is required')
  if (!ID.test(String(state.installation_id || ''))) fail('install state carries no usable installation id')
  // Paths are keyed on the installation id, never on `hive.id` — that field is a 64-hex PUBLIC KEY
  // (`install_state.mjs` validates it as one), and putting an identity into a directory name spreads
  // it across the filesystem, backups and any log that ever prints a path.
  const inst = String(state.installation_id)
  const existing = facts.present && typeof facts.present === 'object' ? facts.present : {}
  const unreadable = new Set(Array.isArray(facts.unreadable) ? facts.unreadable : [])

  const at = (id, a) => {
    if (unreadable.has(id)) {
      // Cannot see it — say so. Being unable to check is not the same as being fine.
      return { ...a, state: 'blocked', reason: `${a.reason} (host fact unreadable; refusing to act blind)`.trim() }
    }
    if (!(id in existing)) return a
    const found = existing[id]
    if (found === true) return { ...a, state: 'satisfied' }
    // A fact that disagrees with the desired state is drift, and drift on a credential-bearing or
    // code path is never silently corrected.
    return { ...a, state: 'drifted', reason: `${a.reason} (host reports ${JSON.stringify(found)})`.trim() }
  }

  const plan = []
  const push = (kind, id, want, opts) => plan.push(at(id, action(kind, id, want, opts)))

  // --- users before anything they must own -----------------------------------------------------
  // Split uids are the isolation boundary; creating a directory before its owner exists would make
  // it root-owned and quietly defeat that.
  for (const role of ['watcher', 'broker', 'adapter', 'worker']) {
    push('system_user', `user:${role}`, { name: `waggle-${role}`, shell: '/usr/sbin/nologin', system: true },
      { reason: `${role} runs under its own uid so it cannot read the others' state` })
  }

  // --- data roots --------------------------------------------------------------------------
  push('directory', 'dir:state', { path: `/var/lib/waggle/${inst}/state` }, { owner: 'waggle-broker', mode: '0700',
    reason: 'durable bridge state' })
  push('directory', 'dir:spool', { path: `/var/lib/waggle/${inst}/spool` }, { owner: 'waggle-broker', mode: '0700',
    reason: 'opaque pending markers' })
  push('directory', 'dir:runtime', { path: `/run/waggle/${inst}` }, { owner: 'waggle-adapter', mode: '0750',
    reason: 'adapter handoff, cleared on reboot' })
  push('directory', 'dir:credentials', { path: `/etc/waggle/${inst}/credentials` }, { owner: 'root', mode: '0700',
    reason: 'credential files are seated here by hand, never by this bootstrap' })

  // --- code ------------------------------------------------------------------------------------
  // Pinned, not tracked: an installer that follows a branch turns every upstream push into an
  // unreviewed deploy on this host.
  push('code_checkout', 'code:waggle', { path: '/opt/waggle', ref: state.pinned_ref || 'main', immutable: true },
    { reason: 'immutable checkout; the deploy runner moves it, nothing else' })

  // --- clock, before anything that signs -------------------------------------------------------
  // Every gate that clamps timestamps and every freshness bound is meaningless on a drifting clock,
  // so this precedes the units rather than sitting in a "hardening" afterthought.
  push('time_sync', 'time:ntp', { enabled: true, source: 'system' },
    { reason: 'signature freshness and timestamp clamps are only as good as the clock' })

  // --- units -----------------------------------------------------------------------------------
  for (const [unit, why] of [
    ['waggle-read', 'the in-door read lane'],
    ['waggle-egress', 'the out-door egress lane'],
    ['waggle-console', 'the loopback console'],
  ]) push('systemd_unit', `unit:${unit}`, { name: `${unit}.service`, enabled: true, wantedBy: 'multi-user.target' },
    { reason: why })
  push('systemd_timer', 'timer:deploy', { name: 'waggle-deploy.timer', enabled: true, onUnitActiveSec: '60s' },
    { reason: 'polls main for the first CI-green commit' })

  // --- firewall --------------------------------------------------------------------------------
  // Default-deny inbound. The console is loopback-only: exposing it is what #145's Host check exists
  // to survive, and the firewall should mean that never gets tested in anger.
  push('firewall_rule', 'fw:default-deny', { direction: 'inbound', policy: 'deny' },
    { reason: 'nothing inbound is required; the bridge dials out' })
  push('firewall_rule', 'fw:console-loopback', { port: 8787, bind: '127.0.0.1', policy: 'allow' },
    { reason: 'console is loopback-only and additionally checks Host' })

  // --- the deploy runner, last ------------------------------------------------------------------
  // It ships whatever is on main, so it must not be able to run before the host it deploys onto is
  // fully formed.
  push('deploy_runner', 'deploy:runner', { path: '/opt/waggle/deploy', pinned: Boolean(state.pinned_ref) },
    { reason: 'merged + CI green is the authorisation; pin WB_REF to land without shipping' })

  return Object.freeze(plan.map(Object.freeze))
}

/** Actions that still need doing. `blocked` is deliberately NOT actionable. */
export function pendingActions(plan) {
  return plan.filter(a => a.state === 'missing' || a.state === 'drifted')
}

/**
 * Judge a plan. Separated from the plan itself so `--check` and `--apply` agree by construction:
 * they run the same planner and the same verdict, and differ only in whether the runner acts.
 */
export function bootstrapVerdict(plan) {
  const blocked = plan.filter(a => a.state === 'blocked')
  const drifted = plan.filter(a => a.state === 'drifted')
  const missing = plan.filter(a => a.state === 'missing')
  // Blocked outranks everything: a plan containing something we could not read cannot be called
  // complete, and must not exit 0 just because everything visible happened to be satisfied.
  if (blocked.length) return Object.freeze({ status: 'inconclusive', exit: 3, blocked: blocked.length, drifted: drifted.length, missing: missing.length })
  if (drifted.length) return Object.freeze({ status: 'drifted', exit: 1, blocked: 0, drifted: drifted.length, missing: missing.length })
  if (missing.length) return Object.freeze({ status: 'incomplete', exit: 1, blocked: 0, drifted: 0, missing: missing.length })
  return Object.freeze({ status: 'satisfied', exit: 0, blocked: 0, drifted: 0, missing: 0 })
}

/** The evidence line recorded against the `host_bootstrap` step. States when, and on what basis. */
export function bootstrapEvidence(plan, verdict, { at = new Date().toISOString() } = {}) {
  return Object.freeze({
    version: HOST_BOOTSTRAP_VERSION,
    checked_at: at,
    status: verdict.status,
    actions_total: plan.length,
    actions_satisfied: plan.filter(a => a.state === 'satisfied').length,
    actions_blocked: verdict.blocked,
  })
}
