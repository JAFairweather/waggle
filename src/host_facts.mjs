// host_facts.mjs — pure classification of host probe outcomes for the #305 bootstrap runner.
//
// Why this exists: the runner's first probes folded "could not read" into "does not exist" five
// separate ways — `existsSync` returning false on EACCES, a nonzero `id` during an NSS outage, a
// busless `systemctl` with empty stdout, `--abbrev-ref` printing literally `HEAD` on every pinned
// checkout, and the apply path that had never run at all. Each fold lets a failed probe plan an
// action over live state, which is the exact thing the planner exists to refuse. Review of #314
// found three of those; the crew found the other two. So the classification now lives here, pure,
// where every fold is a test case — and the runner only gathers raw observations and hands them in.
//
// A classification is one of:
//   { fact: 'absent' }                — genuinely not there; the planner may plan its creation
//   { fact: 'unreadable' }            — COULD NOT TELL; the planner must block, never act
//   { fact: 'present', value: true }  — satisfied
//   { fact: 'present', value: {…} }   — there but different; the planner reports drift
//
// The dangerous confusion is always absent-vs-unreadable. Absent means the probe positively saw
// nothing there (ENOENT, "no such user", "No such file"). Unreadable means the probe itself failed
// — and a probe that failed has seen nothing, including nothing about absence.

export const ABSENT = Object.freeze({ fact: 'absent' })
export const UNREADABLE = Object.freeze({ fact: 'unreadable' })
const found = value => Object.freeze({ fact: 'present', value })
const shortSha = sha => String(sha).slice(0, 12)

/**
 * Classify an lstat observation: `{ error: { code } }` from a throw, or
 * `{ isDirectory, isSymbolicLink, mode }` from a stat. ENOENT is the ONLY error that means absent.
 * EACCES, ELOOP, EIO and the rest mean the path could not be judged — an unreadable parent makes
 * a live directory look exactly like a missing one, and "fixing" that plans over the live one.
 */
export function directoryFact (obs, wantMode = null) {
  if (!obs || typeof obs !== 'object') return UNREADABLE
  if (obs.error) return obs.error.code === 'ENOENT' ? ABSENT : UNREADABLE
  if (!obs.isDirectory || obs.isSymbolicLink) return found({ note: 'exists but is not a plain directory' })
  const mode = (obs.mode & 0o777).toString(8).padStart(4, '0')
  if (wantMode && mode !== wantMode) return found({ mode })
  return found(true)
}

/**
 * Classify an `id -u <name>` observation. `id` exits nonzero both for "no such user" and for a
 * resolver that could not answer (NSS or LDAP outage, degraded getent). Only the first is absence:
 * planning a useradd during the second creates a duplicate the moment the directory service
 * comes back.
 */
export function userFact (obs) {
  if (!obs || obs.missing || obs.timeout) return UNREADABLE
  if (obs.status === 0) return found(true)
  if (/no such user/i.test(obs.err || '')) return ABSENT
  return UNREADABLE
}

/**
 * Classify a `systemctl is-enabled <unit>` observation. Nonzero with EMPTY stdout is two very
 * different stories — the unit file genuinely does not exist, or systemd itself could not be
 * reached (no bus in a container, degraded manager) — and stderr text is the only discriminator
 * systemctl offers. A reachable manager reporting any state at all (disabled, masked, static) is
 * drift, not absence: something is there and it is not what the plan wants.
 */
export function unitFact (obs) {
  if (!obs || obs.missing || obs.timeout) return UNREADABLE // no systemd here: cannot judge, do not guess
  if (obs.out === 'enabled') return found(true)
  if (obs.out) return found({ enabled: obs.out })
  // Order matters: the busless message is "Failed to connect to bus: No such file or directory" —
  // it CONTAINS the absence phrase, so testing absence first would fold bus-unreachable into
  // absent, which is this module's entire reason to exist.
  if (/connect to bus|dbus/i.test(obs.err || '')) return UNREADABLE
  if (/no such file|not.found|does not exist/i.test(obs.err || '')) return ABSENT
  return UNREADABLE
}

/**
 * Classify a checkout from two `git rev-parse` observations: `HEAD` and `<ref>^{commit}`, both run
 * inside the checkout. Compared as COMMIT IDS, never as branch names — a pinned checkout is
 * detached, and `--abbrev-ref` prints literally `HEAD` there, which made every pinned install
 * report permanent drift. A directory that is not a git repository, or a checkout that does not
 * carry the desired ref, is readable-and-wrong (drift) rather than unreadable: the probe saw it
 * fine, and what it saw disagrees.
 */
export function checkoutFact (head, want) {
  for (const obs of [head, want]) if (!obs || obs.missing || obs.timeout) return UNREADABLE
  if (/not a git repository/i.test(head.err || '')) return found({ note: 'exists but is not a git checkout' })
  if (head.status !== 0) return UNREADABLE
  if (want.status !== 0) return found({ note: 'checkout does not carry the desired ref', head: shortSha(head.out) })
  return head.out === want.out ? found(true) : found({ ref: shortSha(head.out) })
}
