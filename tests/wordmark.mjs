// wordmark.mjs — `waggle` is always lowercase, in every Markdown file (#394).
//
// The rule is in CLAUDE.md under "claims that must never drift" and is stated to every agent we
// onboard. It had no mechanism, so it drifted to 25 violations across 7 files — the README's first
// sentence, the title of the external review packet, an architecture diagram, and the alt text a
// screen reader reads aloud.
//
// A lint like this fails in two directions and a green suite hides both. One that never fires and
// one that cannot fire look identical, so the negative control below plants a violation and
// requires it to be caught. And a lint with false positives gets suppressed within a week — after
// which it guards nothing — so every legitimate shape in this repo is asserted NOT to fire.

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findWordmarkViolations, describeWordmarkViolation } from '../src/wordmark.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let n = 0, pass = 0
const t = (name, ok, detail = '') => { n++; if (ok) { pass++; console.log(`ok - ${name}`) } else console.log(`FAIL - ${name}${detail ? `\n     ${detail}` : ''}`) }

// ---- the negative control runs FIRST, so nothing below can be vacuous -------------------------
{
  const planted = 'waggle is fine.\nBut Waggle here is not.\nAnd waggle again.'
  const found = findWordmarkViolations(planted)
  t('NEGATIVE CONTROL — a planted violation IS caught', found.length === 1)
  t('…on the right line, so the failure is actionable', found[0]?.line === 2, JSON.stringify(found))
  t('…and the surrounding correct usages are not swept up with it',
    !found.some(v => v.line === 1 || v.line === 3))
}

// ---- the shapes where a capital is CORRECT, each of which appears in this repo -----------------
// A lint that flags these is a lint someone turns off, and then the rule has no mechanism again.
{
  const legitimate = [
    ['an asset path', '<img src="docs/assets/waggle-setup-meadow-hero.png" width="100%">'],
    ['a URL', 'See https://example.com/Waggle/readme for the mirror.'],
    ['an inline-code identifier', 'The class is `Waggle` in that binding.'],
    ['SCREAMING_CASE, its own convention', 'Read WAGGLE_BRIEF.md on the maintainer machine.'],
    ['the rule being stated', '- **`waggle` is always lowercase.** Never Waggle, never WAGGLE.'],
    ['a possessive inside code', 'Use `WaggleBridge.start()` to boot.'],
  ]
  for (const [what, line] of legitimate) {
    t(`not flagged: ${what}`, findWordmarkViolations(line).length === 0, line)
  }
  // BOTH DIRECTIONS. Each exclusion above must be narrow — if the path rule also swallowed prose,
  // every assertion above would still pass while the lint caught nothing.
  t('…but prose ON A LINE WITH a path is still caught — the exclusion is the token, not the line',
    findWordmarkViolations('<img src="docs/assets/waggle-x.png" alt="Waggle’s hive">').length === 1)
  t('…and prose beside inline code is still caught',
    findWordmarkViolations('Waggle issues a `task-relay` grant.').length === 1)
  t('…and a fenced DIAGRAM is in scope, because a reader sees it as written',
    findWordmarkViolations('```\n        | Waggle verifies source\n```').length === 1)
}

// ---- the repo itself ---------------------------------------------------------------------------
// The whole point. Not a sample, not a list someone maintains: every Markdown file git tracks.
{
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '*.md'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
  // A scan of nothing reports everything clean, so put a floor under the input before believing it.
  t('the scan actually read the repo — a scan of no files proves nothing', files.length >= 20,
    `found ${files.length} markdown file(s)`)

  const offences = []
  for (const rel of files) {
    for (const v of findWordmarkViolations(readFileSync(join(ROOT, rel), 'utf8'))) {
      offences.push(describeWordmarkViolation(rel, v))
    }
  }
  t('every Markdown file in the repo writes the wordmark lowercase',
    offences.length === 0, offences.slice(0, 12).join('\n     '))

  // The two files that state the rule must keep stating it — a fix that silenced the guard by
  // deleting the rule would otherwise pass everything above.
  const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8')
  const brief = readFileSync(join(ROOT, 'docs/AGENT_BRIEF.md'), 'utf8')
  t('CLAUDE.md still carries the rule it is drifting from',
    /always lowercase/i.test(claude))
  t('AGENT_BRIEF.md still states it to the agents we onboard',
    /always lowercase/i.test(brief))
}

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
