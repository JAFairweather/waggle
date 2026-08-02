// suite_count.mjs — the suite count in prose must match package.json (#172).
//
// Why this exists: the number is load-bearing. CLAUDE.md says "if a run reports fewer than N, the
// branch is on a stale base" — a stale-base detector whose calibration was maintained by hand, and
// therefore wrong most of the time. It drifted 13 → 16 → 17 → 19 → 20 in two days, hand-synced
// across three files each round, and on one of those rounds README's roster listed 17 items beside
// a claim of 19. A detector calibrated by hand is a detector that sits quiet through exactly the
// situation it exists to catch.
//
// package.json's `test` script is the count of record. Everything else is a claim about it, and
// claims are what this suite checks.
//
// Two properties beyond the obvious, both learned the hard way:
//   - the scan is MULTILINE. A line-based grep missed a stale count in ci.yml because "The four"
//     and "suites" sat on different lines; it was found by reading, not by the check.
//   - the ROSTER length is asserted too, not just the number. README once carried a correct count
//     beside a list of the wrong length, which a count-only check passes.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const ok = (name, cond, detail = '') => {
  if (cond) return console.log(`  ok   ${name}`)
  fails++
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('suite count (#172)')

// --- the count of record ---------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const invoked = (pkg.scripts.test.match(/tests\/[\w-]+\.mjs/g) || [])
const onDisk = readdirSync(join(ROOT, 'tests')).filter(f => f.endsWith('.mjs'))
const N = invoked.length

// Ground truth has to agree with itself first, or the number it certifies means nothing.
ok(`package.json invokes ${N} suite(s)`, N > 0)
ok('every invoked suite exists on disk', invoked.every(p => onDisk.includes(p.replace('tests/', ''))),
  invoked.filter(p => !onDisk.includes(p.replace('tests/', ''))).join(', ') || '')
ok('every suite on disk is invoked — an orphan file is a test nobody runs',
  onDisk.every(f => invoked.includes(`tests/${f}`)),
  onDisk.filter(f => !invoked.includes(`tests/${f}`)).join(', ') || '')
ok('no suite is invoked twice', new Set(invoked).size === invoked.length)

// --- the claims ---------------------------------------------------------------------------
// MULTILINE on purpose (see header). `\s` spans newlines, so a count split across a wrap is still
// caught — which a line-based grep is structurally unable to do.
const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty'
const claimRe = new RegExp(`(\\d+|${NUMBER_WORDS})[\\s#*_-]+suites?\\b`, 'gi')
const WORD_TO_N = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 }
const asNumber = (s) => /^\d+$/.test(s) ? Number(s) : WORD_TO_N[s.toLowerCase()]

// Every file that could carry a claim, not only the ones that carry one today — a stale count in a
// file nobody thought to list is the exact failure this suite exists to prevent.
const CANDIDATES = ['CLAUDE.md', 'README.md', 'docs/GETTING_STARTED.md', '.github/workflows/ci.yml', 'SECURITY.md']

for (const rel of CANDIDATES) {
  let text
  try { text = readFileSync(join(ROOT, rel), 'utf8') } catch { continue }
  const claims = [...text.matchAll(claimRe)].map(m => asNumber(m[1])).filter(Number.isFinite)
  if (!claims.length) continue // a file that states no count cannot state a wrong one
  const wrong = claims.filter(c => c !== N)
  ok(`${rel}: every stated suite count is ${N}`, wrong.length === 0,
    wrong.length ? `found ${wrong.join(', ')} — package.json says ${N}` : '')
}

// The stale-base threshold in CLAUDE.md is the reason the number matters at all.
{
  const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8')
  const m = claude.match(/fewer than\s+(\d+|[a-z]+)/i)
  ok('CLAUDE.md stale-base threshold matches the real count', m && asNumber(m[1]) === N,
    m ? `threshold says ${m[1]}, package.json says ${N}` : 'no threshold line found')
}

// --- the roster, not just the number ----------------------------------------------------------
// README once claimed 19 beside a list of 17. A count-only check passes that.
for (const rel of ['CLAUDE.md', 'README.md']) {
  const text = readFileSync(join(ROOT, rel), 'utf8')
  const roster = text.match(/boot ·[\s\S]*?(?=\n\n)/)
  if (!roster) { ok(`${rel}: roster found`, false, 'no "boot · …" roster block'); continue }
  const items = roster[0].split('·').map(s => s.trim()).filter(Boolean)
  ok(`${rel}: roster lists ${N} suites`, items.length === N, `roster has ${items.length}`)
}

console.log(fails ? `\nsuite_count: ${fails} check(s) failed` : '\nall checks passed')
process.exit(fails ? 1 : 0)
