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
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// RECURSIVE (#175). The first version read one directory level, so a future src/lanes/foo.mjs
// could import child_process or call finalizeEvent and this ban would pass. Not hypothetical: the
// repo already moved this way once, when #154/#161 split bridge.mjs into leaf modules. A forcing
// function with a scope hole is one refactor away from forcing nothing — and it stays green the
// whole time, which is the failure this repo keeps re-learning.
const files = readdirSync(SRC, { recursive: true }).map(String).filter(f => f.endsWith('.mjs'))

// SCOPE — decided, not inherited from a glob (#175). This ban covers `src/`: the BRIDGE PROCESS,
// whose authorship is what A3 constrains. `tools/` is deliberately NOT covered. Those are
// operator-invoked CLIs, run deliberately by a human, and several legitimately do the banned
// things by design: tripwire.mjs signs alarm DMs with a SEPARATE alarm key, grant.mjs drives a
// remote signer, approve.mjs reposts through the delivery path. Banning them would forbid the
// thing they exist to do.
//
// The boundary is WHO INITIATES, not the directory name: if a tool ever becomes something the
// bridge process invokes rather than something an operator runs, it belongs in src/ and under
// this ban.

let fails = 0
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}`); if (!cond) fails++ }

// SIZE FLOOR — same reasoning as #174's. Every per-file assertion below is vacuously true over an
// empty list: a scan that finds nothing passes every ban. So prove the scan found what it is
// supposed to be policing before trusting a word it says.
ok(`the scan found source modules to police (${files.length})`, files.length >= 5)
ok('the scan includes the two chokepoints it exists to protect',
  files.includes('egress.mjs') && files.includes('nostr_egress.mjs'))

// The scanner, factored out so the negative control can drive it over a planted file.
const importsChildProcess = (text) => /(^|[^\w])(import\s[^\n]*['"]node:child_process['"]|require\(\s*['"](node:)?child_process['"]\s*\))/m.test(text)

console.log('-- Buzz transport: only egress.mjs may import child_process --')

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

// NEGATIVE CONTROL for the SCAN'S REACH, not just its regex (#175). The control above plants a
// violation in the directory the scanner was already reading, so it passed even when the scan was
// one level deep. This one plants it in a SUBDIRECTORY — the shape a future src/lanes/ refactor
// would produce — and requires the file list itself to contain it.
//
// Before the recursive change this check failed, which is the whole point of writing it: it is the
// difference between "the regex works" and "the regex is pointed at everything it must cover".
{
  const subdir = join(SRC, '__ban_control_dir__')
  const planted = join(subdir, 'nested.mjs')
  try {
    mkdirSync(subdir, { recursive: true })
    writeFileSync(planted, "import { execFile } from 'node:child_process'\nexport const x = execFile\n")
    const rescan = readdirSync(SRC, { recursive: true }).map(String).filter(f => f.endsWith('.mjs'))
    const found = rescan.find(f => f.endsWith('nested.mjs'))
    ok('NEGATIVE CONTROL — the scan reaches into subdirectories', !!found)
    ok('NEGATIVE CONTROL — and a violation planted there IS detected',
      !!found && importsChildProcess(readFileSync(join(SRC, found), 'utf8')))
  } finally {
    try { rmSync(subdir, { recursive: true, force: true }) } catch { /* already gone */ }
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

console.log(fails ? `\negress_ban: ${fails} FAILED` : '\negress_ban: all checks passed')
process.exit(fails ? 1 : 0)
