// mint_identity.mjs — the three properties that must not silently break.
//
// This tool writes a private key to disk. Its whole value is that the secret goes to a 0600 file
// and NOT to stdout, and that it never clobbers an existing identity. All three fail silently:
// a wrong mode looks fine, an echoed secret looks fine, and an overwrite looks like success while
// destroying an identity that live grants point at.
//
// Runs the real tool as a child process, because "what reaches stdout" is the property under test
// and importing it would not have a stdout.
//
//   node tests/mint_identity.mjs

import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const TOOL = fileURLToPath(new URL('../tools/mint-identity.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'waggle-mint-'))
const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' })

try {
  // ── The happy path, and what it does NOT print ────────────────────────────────────────────
  {
    const out = join(dir, 'agent.nsec')
    const r = run('--out', out)
    check(r.status === 0, 'minting an identity exits 0')
    check(existsSync(out), 'and the key file exists')

    const secret = readFileSync(out, 'utf8').trim()
    check(/^nsec1[0-9a-z]+$/.test(secret), 'the file holds an nsec')

    const printed = `${r.stdout}${r.stderr}`
    check(!printed.includes(secret), 'THE SECRET IS NOT PRINTED — not on stdout, not on stderr')
    check(!/nsec1/.test(printed), 'and no nsec-shaped string appears in the output at all')
    check(printed.includes(out), 'while the PATH is printed, which is the thing the operator needs')
    check(/npub1[0-9a-z]+/.test(printed), 'and so is the public half, which is what they paste when granting')

    // The pair must actually correspond — a tool that printed an unrelated npub would pass every
    // check above and grant capability to a key nobody holds.
    const m = await import('nostr-tools')
    const derived = m.nip19.npubEncode(m.getPublicKey(m.nip19.decode(secret).data))
    check(printed.includes(derived),
      'NEGATIVE CONTROL — the printed npub is the one derived from the written nsec, so the pair is real')

    check((statSync(out).mode & 0o777) === 0o600, 'the key file is mode 600')
  }

  // ── It refuses to overwrite ───────────────────────────────────────────────────────────────
  {
    const out = join(dir, 'existing.nsec')
    writeFileSync(out, 'do-not-destroy-me\n', { mode: 0o600 })
    const r = run('--out', out)
    check(r.status !== 0, 'minting over an existing file FAILS rather than succeeding quietly')
    check(readFileSync(out, 'utf8') === 'do-not-destroy-me\n',
      'and the existing key is untouched — an overwrite would silently orphan every grant pointing at it')
    check(/already exists/.test(r.stderr), 'with a reason that says why')
  }

  // ── Usage ─────────────────────────────────────────────────────────────────────────────────
  {
    const r = run()
    check(r.status !== 0 && /usage/.test(r.stderr), 'no --out is a usage error, not a key written somewhere surprising')
  }

  // ── A path that needs its directory created ───────────────────────────────────────────────
  {
    const out = join(dir, 'nested', 'deep', 'agent.nsec')
    const r = run('--out', out)
    check(r.status === 0 && existsSync(out), 'a missing parent directory is created rather than failing')
    check((statSync(join(dir, 'nested')).mode & 0o777) === 0o700, 'and the created directory is 700, not world-readable')
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
