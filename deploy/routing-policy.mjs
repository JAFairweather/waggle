#!/usr/bin/env node
// routing-policy.mjs — portable, non-secret routing-policy snapshots (#104).
//
// `config.json` is deliberately host-local: code deploys must never overwrite it. That
// protects live operations, but it used to mean a rebuild could silently lose a carefully
// chosen watchlist or return-lane route. This tool gives an owner a second, deliberate
// representation: a mode-0600 JSON snapshot they may keep in *their own private Git repo*.
// It never reads .env and refuses values that look like credentials.
//
//   node deploy/routing-policy.mjs export --config /opt/waggle-read/config.json --out ~/waggle-policy/read.json
//   node deploy/routing-policy.mjs check  --config /opt/waggle-read/config.json --policy ~/waggle-policy/read.json
//   node deploy/routing-policy.mjs apply  --config /opt/waggle-read/config.json --policy ~/waggle-policy/read.json --confirm
//
// `apply` is intentionally explicit. Console-issued, signed watch changes remain live until
// the owner exports a new snapshot; `check` makes that divergence visible before a rebuild.

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const USAGE = 'usage: node deploy/routing-policy.mjs export|check|apply --config <config.json> --policy|--out <policy.json> [--confirm]'
const argv = process.argv.slice(2)
const command = argv.shift()
const value = (flag) => {
  const i = argv.indexOf(flag)
  return i < 0 ? null : argv[i + 1] || null
}
const die = (message) => { console.error(`routing-policy: ${message}`); process.exit(2) }

if (!['export', 'check', 'apply'].includes(command)) die(USAGE)
const configPath = value('--config')
const policyPath = command === 'export' ? value('--out') : value('--policy')
if (!configPath || !policyPath) die(USAGE)
if (command === 'apply' && !argv.includes('--confirm')) die('apply changes the live policy; re-run with --confirm')

function readJson(path, label) {
  let st
  try { st = lstatSync(path) } catch { die(`${label} not found: ${path}`) }
  if (st.isSymbolicLink() || !st.isFile()) die(`${label} must be a regular file: ${path}`)
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { die(`${label} is not valid JSON: ${path}`) }
}

function assertNoCredentials(value, at = '$') {
  if (Array.isArray(value)) return value.forEach((v, i) => assertNoCredentials(v, `${at}[${i}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/(?:^|[_-])(nsec|secret|password|token|private[_-]?key|bunker|credential)(?:$|[_-])/i.test(key)) {
      die(`refusing credential-like key in policy snapshot: ${at}.${key}`)
    }
    assertNoCredentials(child, `${at}.${key}`)
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]))
  }
  return value
}

// These are exactly the configuration surfaces the two bridge lanes consume. Runtime-only
// command bookkeeping is deliberately excluded, so a signed console command does not make the
// snapshot appear stale merely because the bridge recorded when it processed it.
function projection(config) {
  const pub = { ...(config.public || {}) }
  delete pub._comment
  delete pub.control_state_command_at
  const out = {}
  for (const key of ['relays', 'recipients', 'channels']) if (key in config) out[key] = config[key]
  if (Object.keys(pub).length) out.public = pub
  assertNoCredentials(out)
  return stable(out)
}

const fingerprint = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const source = readJson(configPath, 'live config')
const live = projection(source)

if (command === 'export') {
  const dest = resolve(policyPath)
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
  if (statSync(dirname(dest)).mode & 0o022) die(`policy directory must not be group/world-writable: ${dirname(dest)}`)
  const body = `${JSON.stringify(live, null, 2)}\n`
  const tmp = `${dest}.tmp-${process.pid}`
  writeFileSync(tmp, body, { mode: 0o600, flag: 'w' })
  renameSync(tmp, dest)
  console.log(`exported routing policy (${fingerprint(live).slice(0, 12)}…) to ${dest}`)
  console.log('commit that file only to the owner’s private policy repository; never add .env or a key file.')
  process.exit(0)
}

const expected = projection(readJson(policyPath, 'policy snapshot'))
if (command === 'check') {
  if (fingerprint(live) === fingerprint(expected)) {
    console.log(`routing policy matches snapshot (${fingerprint(live).slice(0, 12)}…)`)
    process.exit(0)
  }
  console.error(`routing policy DRIFT — live ${fingerprint(live).slice(0, 12)}… != snapshot ${fingerprint(expected).slice(0, 12)}…`)
  console.error('A signed console change may be intentional. Export a reviewed new snapshot before rebuilding; do not copy config.json blindly.')
  process.exit(1)
}

// Preserve unknown runtime-only top-level fields, then replace only the two lane policy
// surfaces. This cannot copy a credential because snapshots reject those on input.
const next = { ...source }
for (const key of ['relays', 'recipients', 'channels']) {
  if (key in expected) next[key] = expected[key]
  else delete next[key]
}
if ('public' in expected) next.public = { ...(source.public || {}), ...expected.public }
else delete next.public
const dest = resolve(configPath)
const tmp = `${dest}.tmp-policy-${process.pid}`
writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: statSync(dest).mode & 0o777, flag: 'w' })
renameSync(tmp, dest)
console.log(`applied routing policy (${fingerprint(expected).slice(0, 12)}…) to ${dest}`)
console.log('restart the affected lane, then run deploy/verify-config.sh and routing-policy.mjs check.')
