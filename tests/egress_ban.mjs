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
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const files = readdirSync(SRC).filter(f => f.endsWith('.mjs'))

let fails = 0
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}`); if (!cond) fails++ }

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
