// config.example.json is the reference an operator configures from. A key the bridge READS but the
// example never mentions is a switch nobody can find — and this repo has one whose absence the boot
// code itself complains about: `mirror_expected_tos_hash`, without which in-door consent's
// version-binding is UNENFORCED and a consent signed against superseded terms still counts. The
// warning fired on every boot; the key it names was not in the example to set.
//
// So the property is one-directional and mechanical: **every `cfg.public.<key>` read anywhere in
// src/ must appear in config.example.json's `public` block.** The reverse is deliberately not
// enforced — `owner_pubkey` is real and is consumed by tools/waggle-init.mjs and the install-state
// manifest rather than by the bridge, and a check that flagged it would train someone to delete it.
//
//   node tests/config_example.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const ok = (n, c, detail = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}${c || !detail ? '' : ` — ${detail}`}`); if (!c) fails++ }

// Both spellings. `cfg.public.x` and `cfg.public?.x` are the same read, and an earlier hand-run of
// this sweep used only the first — which silently excused three keys and reported a clean result.
const READ = /cfg\.public\??\.([a-z_][a-z0-9_]*)/g
const keysRead = (text) => {
  const out = new Set()
  for (const m of text.matchAll(READ)) out.add(m[1])
  return out
}

const srcFiles = readdirSync(join(ROOT, 'src')).filter(f => f.endsWith('.mjs'))
const read = new Set()
for (const f of srcFiles) for (const k of keysRead(readFileSync(join(ROOT, 'src', f), 'utf8'))) read.add(k)

const example = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8'))
const documented = new Set(Object.keys(example.public || {}))

// A size floor. An empty or truncated scan reports everything clean, which is the shape of a
// passing check that ran on nothing.
ok(`the sweep found config reads at all (${read.size})`, read.size >= 20, `only ${read.size} — the scan probably matched nothing`)
ok(`the example documents a public block (${documented.size} keys)`, documented.size >= 20)

const missing = [...read].filter(k => !documented.has(k)).sort()
ok('every public key the bridge reads is in config.example.json', missing.length === 0,
  `undiscoverable: ${missing.join(', ')}`)

// NEGATIVE CONTROL. A comparison that has only ever passed proves nothing — make it fail on
// purpose and watch it say so.
const plantedRead = new Set([...read, 'a_key_no_example_mentions'])
const plantedMissing = [...plantedRead].filter(k => !documented.has(k))
ok('NEGATIVE CONTROL — a planted unread key IS reported',
  plantedMissing.length === 1 && plantedMissing[0] === 'a_key_no_example_mentions')

// And the regex itself, in both spellings, since that is what silently excused keys before.
const probe = 'const a = cfg.public.plain_one\nconst b = cfg.public?.optional_one\n'
const probed = keysRead(probe)
ok('the scan matches cfg.public.x', probed.has('plain_one'))
ok('…and cfg.public?.x, the spelling that was missed', probed.has('optional_one'))
ok('…and nothing else', probed.size === 2)

console.log(fails ? `\nCONFIG EXAMPLE FAIL — ${fails}` : '\nCONFIG EXAMPLE PASS — nothing the bridge reads is undiscoverable')
process.exit(fails ? 1 : 0)
