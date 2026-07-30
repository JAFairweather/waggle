// #33 deployed-build drift check — regression test for deploy/verify-deployed.sh.
//
// Proves the Verify criterion from the issue: run the check against a deliberately stale
// tree and it must REPORT the drift rather than passing. Uses the script's local-tree
// mode (DEST = a directory) so it needs no ssh/box — the comparison core is identical to
// the remote path, only the transport differs.
//
// Builds a faithful "deployed tree" from HEAD via `git archive` (same committed state the
// script resolves blobs from), then asserts: (1) a clean copy passes; (2) a byte-changed
// shipped file fails loudly; (3) a missing shipped file fails loudly.
//
// Run: node tests/deploy_verify.mjs   (exit 0 = pass, 1 = fail)

import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = 'deploy/verify-deployed.sh'
let failed = 0
const check = (cond, msg) => { if (!cond) { console.error('  ✗', msg); failed++ } else { console.log('  ✓', msg) } }

// Run the script; capture exit code + combined output. Never throws.
function run(dest, ref = 'HEAD') {
  try {
    const out = execFileSync('sh', [SCRIPT, 'read', dest, ref], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }
  }
}

// Materialize HEAD's tracked tree into a temp dir (the "deployed tree").
const tree = mkdtempSync(join(tmpdir(), 'wb-deploy-'))
execSync(`git -C "${REPO}" archive HEAD | tar -x -C "${tree}"`, { stdio: 'ignore' })

// Pick a real shipped file to perturb (first .mjs under src/).
function firstFile(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { const r = firstFile(p); if (r) return r }
    else if (e.endsWith('.mjs')) return p
  }
  return null
}
const victim = firstFile(join(tree, 'src'))

try {
  // (1) clean copy of HEAD matches HEAD
  const clean = run(tree)
  check(clean.code === 0, 'clean tree passes (exit 0)')
  check(/OK: all/.test(clean.out), 'clean tree reports OK summary')

  // (2) byte-changed shipped file is reported as drift
  check(victim != null, 'found a shipped src file to perturb')
  appendFileSync(victim, '\n// deliberate drift\n')
  const changed = run(tree)
  check(changed.code === 1, 'changed file -> exit 1')
  check(/DRIFT +content differs/.test(changed.out), 'changed file -> "content differs" reported')
  check(new RegExp('src/').test(changed.out), 'drift line names the drifted path')

  // (3) missing shipped file is reported as drift
  rmSync(victim)
  const missing = run(tree)
  check(missing.code === 1, 'missing file -> exit 1')
  check(/DRIFT +missing on box/.test(missing.out), 'missing file -> "missing on box" reported')

  // (4) a bad ref is a usage error (exit 2), not a false pass
  const badref = run(tree, 'no-such-ref-xyz')
  check(badref.code === 2, 'bad git ref -> exit 2')
} finally {
  rmSync(tree, { recursive: true, force: true })
}

if (failed) { console.error(`deploy_verify: ${failed} check(s) failed`); process.exit(1) }
console.log('deploy_verify: all checks passed')
