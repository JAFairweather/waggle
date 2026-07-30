// tripwire_union.mjs — the tripwire must diff against the UNION of every lane's send journal,
// and must refuse to issue an all-clear when part of that union is missing (#87).
//
// Why this test exists: one poster identity signs from TWO deployments with separate data dirs
// (the public read lane, and the sealed + return lanes). Diffing against a single tree reads the
// other lane's legitimate sends as theft — a false alarm on day one. And a detector that cries
// wolf gets muted, which is the same end state as having no detector at all.
//
// Runs the real tool against fixture journals. No relays, no production state.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOL = resolve(HERE, '..', 'tools', 'tripwire.mjs')
// A valid poster npub is required to get past argument validation; it signs nothing here.
const POSTER = 'npub1s36nypljc6h88tey0kshf688eyd8myu636ctfs4e3d2w54nhsmnqfhaent'

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) return console.log(`  ok   ${name}`)
  failures++
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

// Run the tool; return {code, out}. A window of 1 minute keeps the relay fetch trivial.
//
// spawnSync, not execFileSync: the per-journal accounting is written to STDERR, and execFileSync
// hands back only stdout on success — so a passing run looked like it had produced no summary at
// all. Both streams are evidence here.
function run(journals) {
  const args = ['--since-min', '1']
  for (const j of journals) args.push('--journal', j)
  const r = spawnSync('node', [TOOL, ...args],
    { env: { ...process.env, POSTER, ALARM_NSEC: '', ALARM_TO: '' }, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const dir = mkdtempSync(resolve(tmpdir(), 'waggle-tripwire-'))
try {
  mkdirSync(resolve(dir, 'read'), { recursive: true })
  mkdirSync(resolve(dir, 'sealed'), { recursive: true })
  const readJ = resolve(dir, 'read', 'send-journal.log')
  const sealedJ = resolve(dir, 'sealed', 'send-journal.log')
  const id = (c) => c.repeat(64)
  writeFileSync(readJ, JSON.stringify({ id: id('a'), kind: 9, lane: 'public' }) + '\n')
  writeFileSync(sealedJ, JSON.stringify({ id: id('b'), kind: 9, lane: 'sealed' }) + '\n')

  console.log('tripwire union (#87)')

  const both = run([readJ, sealedJ])
  check('unions every lane it is given', /2 journaled across 2\/2 lane\(s\)/.test(both.out),
    both.out.split('\n').find(l => l.includes('journaled')) || 'no summary line')
  check('a complete union can report OK', both.code === 0, `exit ${both.code}`)

  // The property that matters: a missing lane journal must NOT become an all-clear.
  const half = run([readJ, resolve(dir, 'absent', 'send-journal.log')])
  check('a half-synced union does not exit clean', half.code === 3, `exit ${half.code}`)
  check('it says INCONCLUSIVE, not OK', /INCONCLUSIVE/.test(half.out) && !/^OK/m.test(half.out))
  check('it names the missing journal', /absent/.test(half.out))

  // Comma-separated form is accepted, since that is how a systemd unit will pass it.
  const csv = run([`${readJ},${sealedJ}`])
  check('accepts comma-separated journals', /2\/2 lane\(s\)/.test(csv.out))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')
