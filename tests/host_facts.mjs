// host_facts.mjs — the absent-vs-unreadable boundary of the bootstrap runner's probes.
//
// Drives the REAL classifiers with synthetic observations of every failure the runner met in
// review of #314: existsSync's EACCES fold, a nonzero `id` during an NSS outage, a busless
// systemctl with empty stdout, and a detached-HEAD pin. The property under test is single:
// "could not read" is NEVER reported as "does not exist". Per the house rule, every refusal is
// paired with the legitimate case that must still get through — a classifier that answers
// UNREADABLE to everything also never plans anything, and that failure mode is silent.
//
//   node tests/host_facts.mjs

import { directoryFact, userFact, unitFact, checkoutFact, ABSENT, UNREADABLE } from '../src/host_facts.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const isAbsent = f => f.fact === 'absent'
const isUnreadable = f => f.fact === 'unreadable'
const isSatisfied = f => f.fact === 'present' && f.value === true
const isDrift = f => f.fact === 'present' && f.value !== true

// ---- directories: the errno is the whole signal ------------------------------------------------
check(isAbsent(directoryFact({ error: { code: 'ENOENT' } })), 'ENOENT is the one error that means absent')
check(isUnreadable(directoryFact({ error: { code: 'EACCES' } })),
  'EACCES is UNREADABLE — a live directory behind an unreadable parent must never probe as missing')
for (const code of ['ELOOP', 'EIO', 'ENAMETOOLONG', 'UNKNOWN']) {
  check(isUnreadable(directoryFact({ error: { code } })), `${code} is UNREADABLE, not absent`)
}
check(isSatisfied(directoryFact({ isDirectory: true, isSymbolicLink: false, mode: 0o40700 }, '0700')),
  'PAIR: a readable directory with the wanted mode is satisfied')
check(isDrift(directoryFact({ isDirectory: true, isSymbolicLink: false, mode: 0o40755 }, '0700')),
  'a wrong mode is drift, and carries what the host reported')
check(directoryFact({ isDirectory: true, isSymbolicLink: false, mode: 0o40755 }, '0700').value.mode === '0755',
  'the drift value states the actual mode in octal')
check(isDrift(directoryFact({ isDirectory: false, isSymbolicLink: false, mode: 0o100644 })),
  'a plain file where a directory belongs is drift — readable and wrong, not invisible')
check(isDrift(directoryFact({ isDirectory: true, isSymbolicLink: true, mode: 0o40700 })),
  'a symlink is never a satisfied directory')
check(isUnreadable(directoryFact(null)), 'a missing observation is unreadable, never assumed absent')

// ---- users: an NSS outage is not an empty passwd -----------------------------------------------
check(isSatisfied(userFact({ status: 0, out: '988', err: '' })), 'an existing user is satisfied')
check(isAbsent(userFact({ status: 1, out: '', err: "id: 'waggle-broker': no such user" })),
  'a positive "no such user" is absent — the useradd may be planned')
check(isUnreadable(userFact({ status: 1, out: '', err: 'id: cannot find name service' })),
  'any other nonzero `id` is UNREADABLE — planning a useradd during an NSS outage duplicates the user later')
check(isUnreadable(userFact({ missing: true })), 'no `id` binary: cannot judge, do not guess')
check(isUnreadable(userFact({ timeout: true })), 'a hung resolver is not an absent user')

// ---- units: a busless systemctl reports nothing about the unit ---------------------------------
check(isSatisfied(unitFact({ status: 0, out: 'enabled', err: '' })), 'an enabled unit is satisfied')
check(isDrift(unitFact({ status: 1, out: 'disabled', err: '' })), 'a disabled unit is drift, not absence')
check(unitFact({ status: 1, out: 'masked', err: '' }).value.enabled === 'masked', 'the drift value names the state')
check(isAbsent(unitFact({ status: 1, out: '', err: 'Failed to get unit file state for waggle-read.service: No such file or directory' })),
  'a positive "No such file" is absent — the unit may be planned')
check(isUnreadable(unitFact({ status: 1, out: '', err: 'Failed to connect to bus: No such file or directory' })),
  'the busless message ALSO contains "No such file" — bus-unreachable must still be UNREADABLE, not absent')
check(isUnreadable(unitFact({ missing: true })), 'no systemctl at all: cannot judge, do not guess')
check(isUnreadable(unitFact({ status: 1, out: '', err: '' })),
  'nonzero with empty stdout and no explanation is UNREADABLE — silence is not absence')

// ---- checkouts: commit ids, never branch names --------------------------------------------------
const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40)
check(isSatisfied(checkoutFact({ status: 0, out: SHA, err: '' }, { status: 0, out: SHA, err: '' })),
  'a pinned checkout whose HEAD commit equals the pinned commit is satisfied — detached HEAD included')
check(isDrift(checkoutFact({ status: 0, out: OTHER, err: '' }, { status: 0, out: SHA, err: '' })),
  'a checkout on a different commit is drift')
check(checkoutFact({ status: 0, out: OTHER, err: '' }, { status: 0, out: SHA, err: '' }).value.ref === 'b'.repeat(12),
  'drift reports the actual head, shortened — a sha is not a secret but 40 chars is noise')
check(isDrift(checkoutFact({ status: 128, out: '', err: 'fatal: not a git repository' }, { status: 128, out: '', err: '' })),
  'a directory that is not a git checkout is drift — readable and wrong, not invisible')
check(isDrift(checkoutFact({ status: 0, out: SHA, err: '' }, { status: 128, out: '', err: 'unknown revision' })),
  'a checkout that does not carry the pinned ref is drift, not blindness')
check(isUnreadable(checkoutFact({ missing: true }, { missing: true })), 'no git binary: cannot judge')
check(isUnreadable(checkoutFact({ status: 129, out: '', err: 'some other failure' }, { status: 0, out: SHA, err: '' })),
  'an unexplained rev-parse failure is UNREADABLE')

// ---- the classifications are inert values -------------------------------------------------------
check(Object.isFrozen(ABSENT) && Object.isFrozen(UNREADABLE) && Object.isFrozen(userFact({ status: 0 })),
  'classifications are frozen — a probe result is evidence, not a scratchpad')

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
