#!/usr/bin/env node
// mint-identity.mjs — create the persistent agent identity, and never show you the private half.
//
//   node tools/mint-identity.mjs --out ~/.nvoy/my-agent.nsec
//
// This replaces a `node -e "…"` one-liner the runbook used to carry, which was wrong twice: it
// only worked from a directory with nostr-tools installed (so it failed from the home directory
// with ERR_MODULE_NOT_FOUND), and it printed the nsec to the terminal — into scrollback, and into
// shell history if anyone reran it with an editor. The house rule is: print a path, never a value.
//
// So: the secret goes straight to a 0600 file that this process creates, and stdout gets the npub
// and the path. Nothing here echoes the private half, and there is no flag to make it.
//
// WHERE TO RUN IT. On the machine that owns the identity — the operator's, not the agent's. The
// agent never generates its own key; an installer that asks an agent for its own key has taught it
// that being asked is normal.

import { writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null
}
const die = (msg, code = 1) => { console.error(`mint-identity: ${msg}`); process.exit(code) }

// `~` is not expanded when a shell passes it quoted, and a file called "~" in the cwd is a silent
// disaster for something holding a key.
const expand = (p) => p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p)

const outArg = arg('out')
if (!outArg) die('usage: node tools/mint-identity.mjs --out <path>   (e.g. ~/.nvoy/my-agent.nsec)')
const out = expand(outArg)

// Refuse to overwrite. Clobbering a key file destroys an identity that grants may already point
// at, and the failure is silent afterwards — the old key simply stops being anywhere.
if (existsSync(out)) die(`${out} already exists. Refusing to overwrite an existing key file — move it aside first if you really mean to replace that identity.`)

const dir = dirname(out)
if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })

const secret = generateSecretKey()
const npub = nip19.npubEncode(getPublicKey(secret))

// mode on writeFileSync applies at creation, which is why the refusal above matters: an existing
// file keeps its own mode and this would not tighten it.
writeFileSync(out, nip19.nsecEncode(secret) + '\n', { mode: 0o600 })

const mode = (statSync(out).mode & 0o777).toString(8)
if (mode !== '600') die(`wrote ${out} but its mode is ${mode}, not 600. Fix the permissions before using this key.`, 3)

console.log('')
console.log('  Public half (this is what you paste when granting):')
console.log(`    ${npub}`)
console.log('')
console.log('  Private half written to (mode 600 — never open this in a chat, an issue, or a log):')
console.log(`    ${out}`)
console.log('')
console.log('  Next: import that file into your Bunker as a new identity, then delete it.')
console.log('  The Bunker is where the key lives from then on; this file is only the delivery.')
console.log('')
