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
console.log('\n-- Nostr transport: no NEW signer site may appear (INV-A3-2, ratcheted) --')
//
// INV-A3-2 wants exactly one function per transport to invoke a signer. That is TRUE for Buzz as
// of #134 and NOT YET TRUE for Nostr: the sibling chokepoint (§2.5) has not been built, so
// `finalizeEvent` still lives in bridge.mjs. Asserting "only nostr.mjs may sign" today would be a
// test that passes for the wrong reason.
//
// So this is a RATCHET rather than the final gate: the exact current signer sites are pinned, and
// any new one fails. That keeps the Nostr path from drifting toward prose while the Buzz path is
// being fixed — which §2.3 names as the whole point of covering both transports from day one —
// and it converts to the strict single-module ban when §2.5 lands.
const SIGNER_SITES_EXPECTED = {
  'bridge.mjs': 2,   // returnLaneSend(): the kind:13 seal and the kind:1059 wrap
}
for (const f of files) {
  const text = readFileSync(join(SRC, f), 'utf8')
  // Count CALLS, not the import line: `finalizeEvent(` with a paren.
  const calls = (text.match(/finalizeEvent\s*\(/g) || []).length
  const expected = SIGNER_SITES_EXPECTED[f] || 0
  ok(`${f}: ${calls} finalizeEvent call site(s), pinned at ${expected}`, calls === expected)
}
{
  const planted = 'const e = finalizeEvent({ kind: 1 }, sk)'
  const seen = (planted.match(/finalizeEvent\s*\(/g) || []).length
  ok('NEGATIVE CONTROL — the counter sees a planted signer call', seen === 1)
}

console.log(fails ? `\negress_ban: ${fails} FAILED` : '\negress_ban: all checks passed')
process.exit(fails ? 1 : 0)
