// durableSet — the shared dedup primitive behind `seen`, `relaySeen` and `rlSeen` (#151).
//
// The property this suite exists to hold is the one that cost a production incident (#121): a
// CLAIM must not survive a restart, and a COMMIT must. Those two were the same call once, and a
// mention that reached no relay was durably suppressed anyway — the loss was permanent because the
// durability worked. Merging three copies of the store into one primitive is only safe if that
// distinction is asserted somewhere, so it is asserted here rather than left to be re-derived.
//
// "Survives a restart" is tested the way a restart actually works: build a SECOND store over the
// same file and load it. Nothing is stubbed — this drives the real exported durableSet.
//
// Run: node tests/durable_store.mjs   (exit 0 = pass, 1 = fail)

import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wb-store-'))
process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'dryrun'
process.env.SEEN_PATH = join(dir, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(dir, 'watermark')

const { durableSet } = await import('../src/bridge.mjs')

let fails = 0
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}`); if (!cond) fails++ }

// Quiet the module's own logging so the suite output is only assertions.
console.log = ((real) => (...a) => { if (String(a[0] ?? '').startsWith('ok  ') || String(a[0] ?? '').startsWith('FAIL')) real(...a) })(console.log)

const mk = (file, cap = 1000) =>
  durableSet({ path: join(dir, file), cap, label: 'test', noun: 'keys' })

// --- claim is in-memory ONLY ---------------------------------------------------------------
const s1 = mk('claim.log')
s1.claim('a')
ok('claim is visible in memory immediately', s1.has('a'))
ok('claim writes NOTHING to disk', !existsSync(join(dir, 'claim.log')))

// The load-bearing negative: a restart must NOT see a claim. This is #121's bug in one line —
// if a claim persisted, a carry that reached no relay would be suppressed forever.
const s1b = mk('claim.log')
s1b.load()
ok('a claim does NOT survive a restart', !s1b.has('a'))

// --- commit is durable ---------------------------------------------------------------------
const s2 = mk('commit.log')
s2.commit('b')
ok('commit is visible in memory', s2.has('b'))
ok('commit reaches disk', existsSync(join(dir, 'commit.log')) &&
  readFileSync(join(dir, 'commit.log'), 'utf8').includes('b'))
const s2b = mk('commit.log')
s2b.load()
ok('a commit DOES survive a restart', s2b.has('b'))

// --- rollback undoes a claim ---------------------------------------------------------------
const s3 = mk('rollback.log')
s3.claim('c')
s3.rollback('c')
ok('rollback clears the in-memory claim, so a failed send retries', !s3.has('c'))
ok('rollback leaves no durable trace', !existsSync(join(dir, 'rollback.log')))

// Rollback after a COMMIT is deliberately not a supported undo — it clears memory but the line is
// already on disk, so the next restart brings it back. Asserted so the asymmetry is documented
// behaviour rather than a surprise: roll back a claim, never a commit.
const s4 = mk('committed-rollback.log')
s4.commit('d')
s4.rollback('d')
ok('rollback after commit clears memory only', !s4.has('d'))
const s4b = mk('committed-rollback.log')
s4b.load()
ok('...and the committed key still returns after a restart (commit is not undoable)', s4b.has('d'))

// --- the cap bounds the file on load -------------------------------------------------------
writeFileSync(join(dir, 'cap.log'), ['k1', 'k2', 'k3', 'k4', 'k5'].join('\n') + '\n')
const s5 = mk('cap.log', 2)
s5.load()
ok('load keeps only the cap-most-recent keys', s5.mem.size === 2 && s5.has('k4') && s5.has('k5'))
ok('load drops the oldest beyond the cap', !s5.has('k1'))

// --- a missing file is not an error --------------------------------------------------------
const s6 = mk('never-written.log')
s6.load()
ok('loading a store that has never been written is a no-op, not a throw', s6.mem.size === 0)

// --- stores are independent ----------------------------------------------------------------
// The three lanes must never collide: a wrap id in the relay store is not a "seen" event id.
const a = mk('iso-a.log'), b = mk('iso-b.log')
a.commit('shared-key')
ok('a key committed to one store is invisible to another', !b.has('shared-key'))

console.log(fails ? `\ndurable_store: ${fails} check(s) failed` : '\ndurable_store: all checks passed')
process.exit(fails ? 1 : 0)
