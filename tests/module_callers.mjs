// module_callers.mjs — fail when a module in src/ is imported by nothing but its own suite (#455).
//
// Four modules have merged with no caller: `pow.mjs` (#346), `registry_reconcile.mjs` (#439), and
// `join_approval.mjs` / `challenge_registry.mjs` / `agent_challenge.mjs` (#454). Each was found by
// hand, months apart, by someone happening to grep. CI was green for every one of them, because a
// module nothing imports has a passing suite and no failing one — the code is correct, tested, and
// in no path.
//
// WHAT COUNTS AS A CALLER, and why the obvious rules do not work. Both of these were written and
// discarded while building this:
//
//   "the filename appears somewhere in the repo" reports ZERO orphans. Design docs name these
//   modules in prose, so `challenge_registry.mjs` reads as reached because DESIGN_JOIN.md mentions
//   it. An alarm that never fires.
//
//   "a line with the filename and the word `import`" reports `buzz_policy_client.mjs` as an orphan.
//   `bridge.mjs` imports it across two lines and the line carrying the path has no keyword on it.
//   A false positive here is worse than a miss: the fix would be to add a live module to the
//   allowlist, and the allowlist would then be a lie.
//
// The rule that works: the filename appears inside a QUOTED string, or after `node ` on a command
// line, on a non-comment line, in a file that is neither the module nor its own suite — with
// `tests/<name>` stripped first, because package.json's test script names every suite on one line
// and would otherwise make all of src/ read as reached.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = true
const ok = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}${cond || !detail ? '' : `  [${detail}]`}`)
  if (!cond) pass = false
}

// Modules with no caller ON PURPOSE. Every entry names the issue that tracks it, so adding one is
// writing down why rather than letting it pass unremarked. This list should only ever shrink.
const ALLOWED = {
  'wordmark.mjs': 'a repo lint rule (#394), exercised only by its own suite — no runtime caller by design',
  'agent_challenge.mjs': '#454 — the join-approval path has no caller yet',
  'challenge_registry.mjs': '#454 — imported only by tests/join_approval.mjs, which is a test',
  'join_approval.mjs': '#454 — the join-approval path has no caller yet',
  'registry_reconcile.mjs': '#439 — computes findings nothing renders',
}

const CODE = /\.(mjs|js|html|json|sh|service)$/
function walk(dir, out = []) {
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const rel = dir === '.' ? e : `${dir}/${e}`
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out)
    else if (CODE.test(e)) out.push(rel)
  }
  return out
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isComment = (l) => /^\s*(\/\/|\*|#|<!--)/.test(l)

/// Does this line name `mod` as something that gets loaded?
export function namesCaller(line, mod) {
  if (isComment(line)) return false
  // `tests/<mod>` is the module's own suite being RUN, not a caller.
  const l = line.replace(new RegExp(`tests/${esc(mod)}`, 'g'), '')
  if (!l.includes(mod)) return false
  return new RegExp(`['"\`][^'"\`]*${esc(mod)}['"\`]`).test(l) ||
    new RegExp(`\\bnode\\s+\\S*${esc(mod)}`).test(l)
}

const FILES = [...new Set([...walk('src'), ...walk('tools'), ...walk('console'), ...walk('deploy'),
  ...walk('tests'), 'package.json'])]

// SIZE FLOOR. A walk that returned nothing would find no orphans and report a clean tree, which is
// the failure mode this whole suite exists to refuse elsewhere.
ok('the scan actually read the repo', FILES.length > 100, `${FILES.length} files`)

const MODULES = readdirSync(join(ROOT, 'src')).filter(f => f.endsWith('.mjs'))
ok('and found the modules to check', MODULES.length > 30, `${MODULES.length} modules`)

const bodies = new Map(FILES.map(f => [f, readFileSync(join(ROOT, f), 'utf8').split('\n')]))
const callersOf = (mod) => FILES
  .filter(f => f !== `src/${mod}` && f !== `tests/${mod}`)
  .filter(f => bodies.get(f).some(l => namesCaller(l, mod)))

console.log('\n1. the discriminator tells reached from unreached')
{
  // POSITIVE CONTROL. If the rule drifted to "nothing is ever a caller", every module would look
  // like an orphan and the suite would fail loudly — but a rule that is merely too STRICT fails
  // quietly, by putting a live module on the allowlist. These are the shapes that must be seen.
  ok('a plain single-line import is a caller',
    namesCaller("import { relaySet } from '../src/relays.mjs'", 'relays.mjs'))
  ok('THE CASE THAT BROKE THE FIRST ATTEMPT — a multi-line import, whose path line has no keyword',
    namesCaller("  verifyPolicyResponse, validatePolicyWriterConfig } from './buzz_policy_client.mjs'", 'buzz_policy_client.mjs'))
  ok('and bridge.mjs really does import it that way, so that control is not hypothetical',
    callersOf('buzz_policy_client.mjs').includes('src/bridge.mjs'), callersOf('buzz_policy_client.mjs').join(' '))
  ok('a worker path handed to new URL is a caller',
    namesCaller("  const url = workerUrl || new URL('./pow_worker.mjs', import.meta.url)", 'pow_worker.mjs'))
  ok('a package.json script is a caller', namesCaller('"start": "node src/bridge.mjs"', 'bridge.mjs'))

  // NEGATIVE CONTROLS. Without these the rule could be "everything is a caller", which reports a
  // clean tree forever — the exact shape of the alarm that never fires.
  ok('NEGATIVE — prose in a comment is not a caller, which is why the whole-repo grep reported nothing',
    !namesCaller('// WHY THIS EXISTS. `src/agent_challenge.mjs` (#311) verifies that a response is', 'agent_challenge.mjs'))
  ok('NEGATIVE — a block-comment continuation is not a caller either',
    !namesCaller("   * see './registry_reconcile.mjs' for the finding table", 'registry_reconcile.mjs'))
  ok('NEGATIVE — running a suite is not a caller, or package.json would reach all of src/',
    !namesCaller('"test": "node tests/join_approval.mjs && node tests/pow.mjs"', 'join_approval.mjs'))
  ok('NEGATIVE — but a module that shares a stem with a suite is still reached on its own merits',
    namesCaller("import { mineSync } from '../src/pow.mjs'", 'pow.mjs'))
  // Assembled rather than written out. A literal here would appear in THIS file, which the scan
  // reads, inside a quoted string on a non-comment line — so the fabricated module would find
  // itself and the control would report the opposite of what it was checking.
  const absent = ['no', 'such', 'module', 'anywhere'].join('_') + '.mjs'
  ok('NEGATIVE — a name that appears nowhere is unreached, so the scan can return an empty answer',
    callersOf(absent).length === 0, callersOf(absent).join(' '))
}

console.log('\n2. every module in src/ is reached, or is on the allowlist with a reason')
{
  const orphans = MODULES.filter(m => callersOf(m).filter(f => !f.startsWith('tests/')).length === 0)
  const unexpected = orphans.filter(m => !(m in ALLOWED))
  const fixed = Object.keys(ALLOWED).filter(m => !orphans.includes(m))

  ok('no module in src/ has merged without a caller',
    unexpected.length === 0,
    unexpected.length ? `${unexpected.join(', ')} — nothing loads these. Wire a caller, or add it to ALLOWED with the issue that tracks the gap.` : '')

  // The allowlist should only ever shrink. An entry for a module that now HAS a caller is stale,
  // and a stale allowlist is how the guard quietly stops guarding.
  ok('the allowlist has no stale entries — a module that gained a caller is off it',
    fixed.length === 0, fixed.length ? `${fixed.join(', ')} now have callers; drop them from ALLOWED` : '')

  ok('every allowlist entry names the issue that tracks it, so none of them is just a shrug',
    Object.values(ALLOWED).every(r => /#\d+|by design/.test(r)))

  const reached = MODULES.length - orphans.length
  ok('and most of src/ is genuinely reached, so this is not passing by an empty module list',
    reached > 30, `${reached}/${MODULES.length} reached, ${orphans.length} allowlisted`)
  console.log(`     allowlisted: ${orphans.join(', ')}`)
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
