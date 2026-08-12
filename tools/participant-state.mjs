#!/usr/bin/env node
// participant-state.mjs — report the participant state ledger (#308) from evidence, not assertion.
//
//   participant-state.mjs --pubkey <npub|hex> [--instance-root <dir>] [--instance <id>]
//                         [--grantor <npub|hex>] [--channel-grantor <npub|hex>]
//
// `docs/AGENT_PARTICIPANT_ARCHITECTURE.md` is explicit that "implemented", "deployed", "attached"
// and "live-proven" are not synonyms; #308 exists because those states were collapsed into one
// saved "pending" more than once. So this prints one line per state with the evidence behind it,
// and never a single roll-up verdict.
//
// EXIT CODES follow this repo's convention (`tripwire.mjs`, `verify-firewall.sh`):
//   0  every state it could judge is PROVEN
//   1  a state is definitively NOT PROVEN
//   3  INCONCLUSIVE — it could not see enough to judge. Being unable to check is not being fine.
//
// It never reads, derives, prints or transmits private key material. Credential files are reported
// by PATH and MODE only. It makes no signing call and opens no Bunker session: deriving a pubkey
// from a signer is an operator action with its own evidence step, and a tool that silently did it
// would turn a check into a side effect.

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { nip19 } from 'nostr-tools'

const HEX64 = /^[0-9a-f]{64}$/
const ZERO = '0'.repeat(64)
const flag = n => { const i = process.argv.indexOf(n); return i < 0 ? '' : process.argv[i + 1] || '' }
const die = m => { console.error(`participant-state: ${m}`); process.exit(1) }

const asHex = (value, label) => {
  if (!value) return ''
  if (value.startsWith('npub1')) {
    try { return nip19.decode(value).data } catch { die(`${label} is not a decodable npub`) }
  }
  if (HEX64.test(value.toLowerCase())) return value.toLowerCase()
  return die(`${label} must be an npub or 64-hex pubkey`)
}

const subject = asHex(flag('--pubkey'), '--pubkey')
if (!subject) die('usage: --pubkey <npub|hex> [--instance-root <dir>] [--instance <id>] [--grantor <npub|hex>]')
const instanceRoot = flag('--instance-root') || process.env.NVOY_INSTANCE_ROOT || '/etc/nvoy/instances'
const wantInstance = flag('--instance')
const grantor = asHex(flag('--grantor'), '--grantor')

// PROVEN / NOT-PROVEN / INCOMPLETE are verdicts about the world. INCONCLUSIVE is a verdict about
// this tool's own sight, and is deliberately not collapsed into any of the others.
const PROVEN = 'PROVEN', NOT = 'NOT PROVEN', PARTIAL = 'INCOMPLETE', UNKNOWN = 'INCONCLUSIVE'
const rows = []
const state = (n, name, verdict, basis) => rows.push({ n, name, verdict, basis })

// ---- state 1 — identity assigned -------------------------------------------------------------
let manifest = null, manifestPath = ''
if (!existsSync(instanceRoot)) {
  state(1, 'identity assigned', UNKNOWN, `instance root ${instanceRoot} does not exist — pass --instance-root`)
} else {
  let names = []
  try { names = readdirSync(instanceRoot).filter(f => f.endsWith('.json')) } catch (e) { die(`cannot read instance root: ${e.message}`) }
  for (const name of names) {
    if (wantInstance && name !== `${wantInstance}.json`) continue
    let parsed
    try { parsed = JSON.parse(readFileSync(join(instanceRoot, name), 'utf8')) } catch { continue }
    if (String(parsed?.pubkey || '').toLowerCase() === subject) { manifest = parsed; manifestPath = join(instanceRoot, name); break }
  }
  if (manifest) state(1, 'identity assigned', PROVEN, `manifest ${manifestPath} pins this pubkey`)
  else state(1, 'identity assigned', NOT, `no manifest under ${instanceRoot} pins ${subject.slice(0, 8)}…`)
}

// ---- state 3 — credentials installed ---------------------------------------------------------
// Checked before state 2 because state 2 depends on it: you cannot verify what a signer derives
// until the credential that reaches that signer exists.
const credentialFacts = []
let credentialsReady = false
if (!manifest) {
  state(3, 'credentials installed', UNKNOWN, 'no manifest — nothing names the credential paths')
} else {
  const refs = [['bunker URI', manifest.bunker_uri_ref], ['NIP-46 client', manifest.bunker_client_ref]]
  let missing = 0, insecure = 0
  for (const [label, path] of refs) {
    if (!path) { credentialFacts.push(`${label}: not referenced by the manifest`); missing++; continue }
    if (!existsSync(path)) { credentialFacts.push(`${label}: referenced but ABSENT at ${path}`); missing++; continue }
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isFile()) { credentialFacts.push(`${label}: ${path} is not a regular file`); insecure++; continue }
    if ((st.mode & 0o077) !== 0) { credentialFacts.push(`${label}: ${path} is group/other readable (want 0600)`); insecure++; continue }
    // Path and mode only. The contents are the credential and are never read.
    credentialFacts.push(`${label}: present at ${path}, mode ${(st.mode & 0o777).toString(8)}`)
  }
  credentialsReady = missing === 0 && insecure === 0
  state(3, 'credentials installed', credentialsReady ? PROVEN : (missing ? PARTIAL : NOT), credentialFacts.join(' · '))
}

// ---- state 2 — Bunker verified ---------------------------------------------------------------
// Deliberately never auto-derived. #308: possessing a NIP-46 URI is not proof it controls the
// identity, and the evidence must be a pubkey COMPARISON — not a manifest value, not a UI label,
// not an npub copied off a screen. That comparison is an operator action; this tool states whether
// it is even possible yet, and refuses to imply it happened.
const evidencePath = manifest ? join(manifest.state_dir || '', 'bunker-verification.json') : ''
if (!credentialsReady) {
  state(2, 'Bunker verified', UNKNOWN, 'blocked on state 3 — no credential exists to derive a pubkey through')
} else if (evidencePath && existsSync(evidencePath)) {
  let rec = null
  try { rec = JSON.parse(readFileSync(evidencePath, 'utf8')) } catch { /* handled below */ }
  const derived = String(rec?.derived_pubkey || '').toLowerCase()
  if (!HEX64.test(derived)) state(2, 'Bunker verified', UNKNOWN, `${evidencePath} exists but records no usable derived pubkey`)
  else if (derived === subject) state(2, 'Bunker verified', PROVEN, `recorded derivation matches: ${evidencePath} (at ${rec.verified_at || 'unrecorded time'})`)
  else state(2, 'Bunker verified', NOT, `recorded derivation MISMATCHES this identity — signer controls ${derived.slice(0, 8)}…, not ${subject.slice(0, 8)}…`)
} else {
  state(2, 'Bunker verified', NOT, `credentials exist but no comparison evidence recorded at ${evidencePath || '<state_dir>/bunker-verification.json'}`)
}

// ---- state 4 — broker attached ---------------------------------------------------------------
if (!manifest) {
  state(4, 'broker attached', UNKNOWN, 'no manifest — nothing names the runtime roots')
} else {
  const dirs = [['state', manifest.state_dir], ['runtime', manifest.runtime_dir], ['spool', manifest.spool_dir]]
  const absent = dirs.filter(([, d]) => !d || !existsSync(d)).map(([l]) => l)
  if (absent.length) {
    state(4, 'broker attached', NOT, `runtime roots absent: ${absent.join(', ')} — the broker has never run`)
  } else {
    // "The directories exist" is not "it ran". Look for something only a run leaves behind.
    const marks = []
    const lock = join(manifest.state_dir, 'broker-daemon.lock')
    if (existsSync(lock)) marks.push('daemon lock present (a daemon holds or held this instance)')
    const terminal = join(manifest.state_dir, 'terminal-replies.jsonl')
    if (existsSync(terminal) && statSync(terminal).size > 0) marks.push('terminal-reply log has entries')
    let spooled = 0
    try { spooled = readdirSync(manifest.spool_dir).length } catch { /* counted as zero */ }
    if (spooled) marks.push(`${spooled} spool marker(s)`)
    if (marks.length) state(4, 'broker attached', PROVEN, marks.join(' · '))
    else state(4, 'broker attached', NOT, 'runtime roots exist but carry no trace of a run — created, not attached')
  }
}

// ---- state 6 — grants ------------------------------------------------------------------------
// Public kind:440s, readable off the relays with no signer. Run the NEGATIVE CONTROL first: an
// all-zeros subject must come back empty. Without it, an empty result for the real subject cannot
// be told apart from a filter that always returns nothing.
const grantTool = resolve(new URL('.', import.meta.url).pathname, 'grant.mjs')
const listFor = who => spawnSync(process.execPath, [grantTool, 'list', '--grantor', grantor, '--agent', who],
  { encoding: 'utf8', timeout: 45000 })

if (!grantor) {
  state(6, 'grants (admit / task / task-relay)', UNKNOWN, 'pass --grantor <npub|hex> to read the public 440s (no signer needed)')
} else {
  const control = listFor(ZERO)
  if (control.status !== 0 && !control.stdout) {
    state(6, 'grants (admit / task / task-relay)', UNKNOWN, `grant listing failed to run: ${(control.stderr || '').trim().slice(0, 160)}`)
  } else if (/[0-9a-f]{16}/i.test(control.stdout || '')) {
    // The control returned grants for an identity that cannot hold any. Nothing downstream of a
    // filter this broken is worth reporting.
    state(6, 'grants (admit / task / task-relay)', UNKNOWN, 'NEGATIVE CONTROL FAILED — an all-zeros subject returned grants, so this listing cannot be trusted')
  } else {
    const real = listFor(subject)
    const out = real.stdout || ''
    const has = cap => new RegExp(`da-cap[^\\n]*${cap}|\\b${cap}\\b`, 'i').test(out)
    const found = ['admit', 'task-relay', 'task'].filter(has)
    const missing = ['admit', 'task', 'task-relay'].filter(c => !found.includes(c))
    if (!found.length) state(6, 'grants (admit / task / task-relay)', NOT, 'no grants bound to this subject (negative control passed, so this absence is real)')
    else if (missing.length) state(6, 'grants (admit / task / task-relay)', PARTIAL, `present: ${found.join(', ')} · MISSING: ${missing.join(', ')} — an admit grant alone cannot wake an agent`)
    else state(6, 'grants (admit / task / task-relay)', PROVEN, 'admit, task and task-relay all bound to this subject')
  }
}

// ---- states 5, 7, 8 --------------------------------------------------------------------------
state(5, 'Channel MCP attached', UNKNOWN, 'reachability is not attachment — prove from a session, not from this host')
state(7, 'live wake proven', UNKNOWN, 'only a live round trip proves this; blocked while 2–4 are unproven')
state(8, 'live reply proven', UNKNOWN, 'only a live round trip proves this; blocked while 2–4 are unproven')

// ---- report ----------------------------------------------------------------------------------
const pad = s => String(s).padEnd(12)
console.log(`\nparticipant ${subject.slice(0, 8)}…  ·  instance root ${instanceRoot}\n`)
for (const r of rows.sort((a, b) => a.n - b.n)) console.log(`  ${r.n}  ${pad(r.verdict)}  ${r.name}\n         ${r.basis}`)

const notProven = rows.filter(r => r.verdict === NOT || r.verdict === PARTIAL)
const unknown = rows.filter(r => r.verdict === UNKNOWN)
console.log(`\n${rows.filter(r => r.verdict === PROVEN).length} proven · ${notProven.length} not proven · ${unknown.length} inconclusive`)
if (notProven.length) { console.log('\nNOT PROVEN — these are real absences, not gaps in sight.'); process.exit(1) }
if (unknown.length) { console.log('\nINCONCLUSIVE — could not see enough to judge. Being unable to check is not being fine.'); process.exit(3) }
process.exit(0)
