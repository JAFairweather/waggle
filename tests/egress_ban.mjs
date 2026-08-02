// tests/egress_ban.mjs — the enforcement gate (#134 A3 §2.3).
//
// A chokepoint nobody is forced to use is a style guide. This suite is what forces it.
//
// BAN THE CAPABILITY, NOT THE SPELLING. An earlier proposal was to grep for `execFile('buzz'`.
// That is the wrong axis: it is evaded by aliasing the function, by a variable verb, by
// spawn('sh', ['-c', …]) — and it is structurally blind to the Nostr transport, which never
// spells `buzz` at all. So the ban is on the IMPORTS and SIGNER SYMBOLS.
//
// Honest residual, stated rather than papered over: `require('child_' + 'process')` still slips a
// static check, and anyone with commit access can route around a lint rule. What an import ban
// reliably stops is the ACCIDENT — the next contributor reaching for the convenient thing — which
// is the actual threat model here. It is not airtight and nothing below claims it is.
import { readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const TOOLS = join(ROOT, 'tools')

// RECURSIVE, deliberately (#175). `readdirSync` without it does not descend, so a future
// src/lanes/foo.mjs could import child_process or call finalizeEvent and this gate would pass —
// green the whole time, which is the specific failure this repo keeps naming. The tree has
// already moved this way once (#154 split bridge.mjs into leaf modules), so nesting is a matter
// of when, not whether.
const mjsUnder = (root) => {
  const out = []
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(full) }
      else if (ent.name.endsWith('.mjs')) out.push(full)
    }
  }
  walk(root)
  return out
}

const srcFiles = mjsUnder(SRC)
const files = srcFiles.map(f => relative(SRC, f))

let fails = 0
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}`); if (!cond) fails++ }

// The scanner, factored out so the negative control can drive it over a planted file.
const importsChildProcess = (text) => /(^|[^\w])(import\s[^\n]*['"]node:child_process['"]|require\(\s*['"](node:)?child_process['"]\s*\))/m.test(text)

console.log(`-- Buzz transport: only egress.mjs may import child_process (${files.length} file(s) under src/, recursive) --`)

for (const f of files) {
  const text = readFileSync(join(SRC, f), 'utf8')
  const has = importsChildProcess(text)
  if (f === 'egress.mjs') ok(`${f}: holds the transport (expected)`, has)
  else ok(`${f}: does not import child_process`, !has)
}

// NEGATIVE CONTROL. The loop above passes trivially if the scanner is broken — a regex that never
// matches and a codebase that never violates are indistinguishable. Plant a violation and require
// the scanner to catch it.
{
  const planted = join(SRC, '__ban_control__.mjs')
  try {
    writeFileSync(planted, "import { execFile } from 'node:child_process'\nexport const x = execFile\n")
    const caught = importsChildProcess(readFileSync(planted, 'utf8'))
    ok('NEGATIVE CONTROL — a planted child_process import IS detected', caught)
    // And the shape the design calls out as the reason not to grep for `execFile('buzz'`:
    ok('NEGATIVE CONTROL — the ban is on the import, so an aliased spawn would still be caught',
      importsChildProcess("const { spawn: go } = require('child_process')"))
  } finally {
    try { unlinkSync(planted) } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------------------------
console.log('\n-- Nostr transport: only nostr_egress.mjs may sign or hold the key (INV-A3-2) --')
//
// INV-A3-2 wants exactly one function per transport to invoke a signer. Both halves now hold:
// egress.mjs owns the Buzz CLI, nostr_egress.mjs owns the in-process NIP-59 signing AND the
// bridge key itself. The key matters as much as the signer here — signing is not the only thing
// a private key does (the relay lane unseals with it), and a ban on `finalizeEvent` alone would
// leave BRIDGE_SK spread across the file with nothing stopping the next signer appearing beside
// a decrypt.
for (const f of files) {
  const text = readFileSync(join(SRC, f), 'utf8')
  // Count CALLS, not the import line: `finalizeEvent(` with a paren.
  const calls = (text.match(/finalizeEvent\s*\(/g) || []).length
  const holdsKey = /BRIDGE_SK/.test(text)
  if (f === 'nostr_egress.mjs') {
    ok(`${f}: holds the signer (expected)`, calls > 0)
    ok(`${f}: holds the bridge key (expected)`, holdsKey)
  } else {
    ok(`${f}: no finalizeEvent call site`, calls === 0)
    ok(`${f}: never references BRIDGE_SK`, !holdsKey)
  }
}
{
  const planted = 'const e = finalizeEvent({ kind: 1 }, sk)'
  const seen = (planted.match(/finalizeEvent\s*\(/g) || []).length
  ok('NEGATIVE CONTROL — the counter sees a planted signer call', seen === 1)
}

// ---------------------------------------------------------------------------------------------
console.log('\n-- tools/: scope is a DECISION, not an artifact of the glob (#175) --')
//
// A3's scope is what the BRIDGE PROCESS may author. `tools/` is operator-invoked CLIs — a human
// runs them deliberately, and several legitimately sign: tripwire alarms under a separate
// zero-authority key, grant.mjs through a bunker, publish_relay_list under a member's own key.
// Excluding them is right. But until now it was right *by accident*: the scan globbed `src/` and
// nobody had written down that `tools/` was out. An undocumented scope boundary on an enforcement
// gate is one refactor from silently covering nothing.
//
// So tools/ IS scanned, against an explicit roster. Each entry is a decision with a reason. A NEW
// tool that signs, or an existing one that starts to, fails this suite until someone adds it here
// — which is the point: the exclusion becomes a deliberate act, not a side effect.
//
// The one hard rule tools/ does NOT get to opt out of: none of them may touch BRIDGE_SK. The
// bridge's own key belongs to src/nostr_egress.mjs alone, whatever the caller's privileges.
const TOOL_SIGNERS = {
  'grant.mjs':              'issues NIP-DA 440/441 under the GRANTOR key (bunker or local), never the bridge key',
  'participant-init.mjs':   'mints and publishes a participant identity under that participant\'s own key',
  'publish_relay_list.mjs': 'publishes a NIP-65 kind:10002 under the member\'s own key',
  'retract.mjs':            'publishes a NIP-09 deletion for a note the invoking key authored',
  'tripwire.mjs':           'signs the alarm DM under a SEPARATE zero-authority key — rule 1 of the tripwire',
  'waggle-init.mjs':        'operator setup CLI; shells out to the buzz binary to check readiness',
}

for (const full of mjsUnder(TOOLS)) {
  const name = relative(TOOLS, full)
  const text = readFileSync(full, 'utf8')
  const signs = (text.match(/finalizeEvent\s*\(/g) || []).length > 0 || importsChildProcess(text)
  const declared = Object.prototype.hasOwnProperty.call(TOOL_SIGNERS, name)
  if (signs) {
    ok(`tools/${name}: signs or shells out, and is on the roster with a reason`, declared)
  } else if (declared) {
    ok(`tools/${name}: on the roster but no longer signs — roster is stale, remove it`, false)
  }
  // The rule no tool may opt out of.
  ok(`tools/${name}: never touches BRIDGE_SK`, !/BRIDGE_SK/.test(text))
}

// NEGATIVE CONTROL — a new signing tool that nobody added to the roster must fail.
{
  const planted = join(TOOLS, '__ban_control_tool__.mjs')
  try {
    writeFileSync(planted, "import { finalizeEvent } from 'nostr-tools/pure'\nexport const x = () => finalizeEvent({ kind: 1 }, sk)\n")
    const text = readFileSync(planted, 'utf8')
    const signs = (text.match(/finalizeEvent\s*\(/g) || []).length > 0
    const declared = Object.prototype.hasOwnProperty.call(TOOL_SIGNERS, '__ban_control_tool__.mjs')
    ok('NEGATIVE CONTROL — an unrostered signing tool is caught', signs && !declared)
  } finally { try { unlinkSync(planted) } catch { /* */ } }
}

// NEGATIVE CONTROL — the recursive walk actually descends.
{
  const nested = join(SRC, '__ban_control_dir__')
  try {
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'sneaky.mjs'), "import { execFile } from 'node:child_process'\nexport const x = execFile\n")
    const found = mjsUnder(SRC).some(f => f.endsWith('sneaky.mjs'))
    const caught = found && importsChildProcess(readFileSync(join(nested, 'sneaky.mjs'), 'utf8'))
    ok('NEGATIVE CONTROL — a violation in a NESTED src/ directory is reached and caught', caught)
  } finally { try { rmSync(nested, { recursive: true, force: true }) } catch { /* */ } }
}

console.log(fails ? `\negress_ban: ${fails} FAILED` : '\negress_ban: all checks passed')
process.exit(fails ? 1 : 0)
