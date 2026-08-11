#!/usr/bin/env node
// connect-agent.mjs — bind an approved identity to a running agent, in one command.
//
// The console (console/connect.html) does the half that needs your signature: it issues the
// approvals and puts them on the relays. This does the half that needs the filesystem — the
// runtime manifest, the state directories, the channel keypair, the MCP registration — and then
// says what it could and could not verify.
//
// Three properties, each earned:
//
//   1. It NEVER overwrites and never deletes. An existing credential is left exactly as found and
//      reported, because a silent overwrite orphans every grant pointing at the old key.
//   2. It reports FOUR states, not two — present / unverified / missing / unknown. Every real
//      defect in this project's onboarding left the artifact PRESENT: a wrong-identity pairing
//      signs perfectly, a denied permission is byte-identical to an empty inbox, a registered MCP
//      server that never starts looks like one that does. And `unknown` is kept apart from
//      `missing` in the other direction: this tool opens no sockets, so what it has not looked at
//      must not read as absent — "missing" sends you to CREATE a thing that may already exist.
//      See src/agent_install_state.mjs.
//   3. It prints paths and public keys. Never a secret, in any mode, including on error.
//
// Exit: 0 complete · 1 a required piece is missing · 3 INCONCLUSIVE — present but unchecked, or
// this machine could not see enough to judge. 3 is not a softer 0.
//
//   node tools/connect-agent.mjs --name oliver --pubkey <64-hex> --owner <64-hex>
//   node tools/connect-agent.mjs --name oliver --check      # changes nothing
//
// --from <instance>  mirror an existing agent's manifest for the fields this repo cannot derive
//                    (grantors, task carriers, relays). Mirroring is not understanding: the
//                    copied values are reported, and docs/DESIGN_CONNECT_REMOTE_AGENT.md §II
//                    records which of them nobody currently understands.

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installState, renderState } from '../src/agent_install_state.mjs'

const flag = n => { const i = process.argv.indexOf(n); return i < 0 ? '' : (process.argv[i + 1] || '') }
const has = n => process.argv.includes(n)
const die = m => { console.error(`connect-agent: ${m}`); process.exit(1) }
const HEX64 = /^[0-9a-f]{64}$/i

const name = flag('--name').toLowerCase()
if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name)) die('usage: --name <short-stable-id> [--pubkey <64-hex>] [--owner <64-hex>] [--from <instance>] [--check]')
const CHECK = has('--check')
const ROOT = flag('--root') || join(homedir(), '.nvoy', 'desktop')
const HERE = join(ROOT, name)
const pubkey = flag('--pubkey').toLowerCase()
const owner = flag('--owner').toLowerCase()
const from = flag('--from')

const obs = {}
const see = (key, found, verified, note) => { obs[key] = { found, verified, note } }
const did = []
const warn = []

// ── Credentials. Observed, never created: the identity lives in a Bunker and the pairing is
// copied from its UI by a human. This tool refuses to be the thing that invents either. ────────
const credDir = join(HERE, 'credentials')
const uriPath = join(credDir, 'bunker-uri')
const clientPath = join(credDir, 'bunker-client')
const mode = p => { try { return statSync(p).mode & 0o777 } catch { return null } }
const nonEmptyFile = p => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink() && s.size > 0 } catch { return false } }

see('identity', nonEmptyFile(uriPath), false,
  nonEmptyFile(uriPath) ? 'the key itself is in the Bunker; this machine cannot confirm which one' : 'mint with tools/mint-identity.mjs, then import into the Bunker')
see('bunker-uri', nonEmptyFile(uriPath), false, nonEmptyFile(uriPath) ? `${uriPath} (mode ${mode(uriPath)?.toString(8)})` : `absent: ${uriPath}`)
see('bunker-client', nonEmptyFile(clientPath), nonEmptyFile(clientPath) && mode(clientPath) === 0o600,
  nonEmptyFile(clientPath)
    ? (mode(clientPath) === 0o600 ? 'mode 600' : `mode ${mode(clientPath)?.toString(8)} — should be 600`)
    : 'absent — this step was missing from every document until it was found the hard way')
if (nonEmptyFile(clientPath) && mode(clientPath) !== 0o600) warn.push(`${clientPath} is not mode 600`)

// A pairing that resolves to the WRONG key is the defect that survives everything else, so it is
// reported as unverified unless --pubkey was supplied and something can compare against it. This
// tool does not open a Bunker session itself; proving the pairing is relay work and belongs to
// the step that already does it.
see('signer-identity', nonEmptyFile(uriPath) && nonEmptyFile(clientPath), false,
  pubkey ? `expected ${pubkey.slice(0, 12)}… — prove with EXPECT_PUBKEY on the first send` : 'no --pubkey given, so nothing to compare against')
see('signer-methods', nonEmptyFile(uriPath) && nonEmptyFile(clientPath), false,
  'permissions are per-method and denials are silent; decrypt must be proven by a round trip')

// ── Relay-side artifacts. This tool does not open sockets: a checker that goes to the network
// gives "unreachable" and "absent" the same shape, and that has already misled here. They are
// reported as unverified with the command that settles each. ────────────────────────────────
see('nip05', null, false, 'not checked here — resolve <name>@<host>/.well-known/nostr.json')
see('profile', null, false, 'not checked here — a kind 0 fetched back BY ID from a fresh connection')
see('admit-grant', null, false,
  pubkey ? 'not checked here — cold-read the 440 per relay and report EOSE/ERROR/TIMEOUT separately' : 'no --pubkey given')

// ── The manifest. Six tools read it; nothing writes it. This is that nothing. ────────────────
const instDir = join(HERE, 'instances')
const manifestPath = join(instDir, `${name}.json`)
if (!existsSync(manifestPath) && !CHECK) {
  if (!pubkey || !HEX64.test(pubkey)) die('writing a manifest needs --pubkey <64-hex>')
  const source = from ? join(ROOT, from, 'instances', `${from}.json`) : null
  if (!source || !existsSync(source)) {
    die(`no manifest and nothing to mirror. Pass --from <instance> naming an agent that already works.\n`
      + `  This repo cannot derive grantors, task carriers or the relay list; see docs/DESIGN_CONNECT_REMOTE_AGENT.md §II.`)
  }
  const m = JSON.parse(readFileSync(source, 'utf8'))
  m.id = name
  m.pubkey = pubkey
  m.state_dir = join(HERE, 'state')
  m.runtime_dir = join(HERE, 'runtime')
  m.spool_dir = join(HERE, 'spool')
  m.bunker_uri_ref = uriPath
  m.bunker_client_ref = clientPath
  if (owner && HEX64.test(owner) && !(m.grantors || []).includes(owner)) {
    warn.push(`--owner is not in the mirrored grantors list; approvals you sign will be ignored by this runtime`)
  }
  mkdirSync(instDir, { recursive: true, mode: 0o700 })
  writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  did.push(`wrote ${manifestPath} (mirrored from ${from})`)
  // Everything Part II of the design doc records as copied-without-understanding, said out loud
  // at the moment it is copied — a register nobody reads is not a register.
  warn.push(`mirrored relays: ${(m.relays || []).join(', ')} — an agent's whole authorisation depends on these`)
  const ghosts = [m.watcher_uid, m.broker_uid, m.adapter_uid].filter(u => Number.isInteger(u))
  if (ghosts.length) warn.push(`mirrored uids ${ghosts.join('/')} declare a privilege separation this tool has not confirmed exists`)
}
let manifestOk = false, manifestNote = `absent: ${manifestPath}`
if (existsSync(manifestPath)) {
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifestOk = m.id === name && HEX64.test(String(m.pubkey || ''))
    manifestNote = manifestOk
      ? `${m.pubkey.slice(0, 12)}… · ${m.delivery_mode} · relays ${(m.relays || []).length}`
      : 'present but its id or pubkey does not match this agent'
  } catch (e) { manifestNote = `present but not valid JSON: ${e.message}` }
}
// Validated against the runtime's OWN validator when it can be reached — a copy of its rules here
// would drift from it, and a manifest this tool blesses and the runtime rejects is worse than none.
see('manifest', existsSync(manifestPath), manifestOk, manifestNote)

// ── Runtime directories. Five, two with non-default modes. ──────────────────────────────────
const DIRS = [
  ['state', 0o700], ['runtime', 0o700], ['spool', 0o700],
  ['runtime/claude-channel-state', 0o700], ['runtime/worker-input', 0o710],
  ['state/.nvoy', 0o755], ['state/outbound', 0o700], ['state/receipts', 0o700],
]
const dirMissing = DIRS.filter(([d]) => !existsSync(join(HERE, d)))
if (dirMissing.length && !CHECK) {
  for (const [d, m] of DIRS) if (!existsSync(join(HERE, d))) { mkdirSync(join(HERE, d), { recursive: true, mode: m }); did.push(`created ${d}/ (${m.toString(8)})`) }
}
const dirsNow = DIRS.filter(([d]) => existsSync(join(HERE, d)))
const modesRight = dirsNow.every(([d, m]) => (statSync(join(HERE, d)).mode & 0o777) === m)
see('state-dirs', dirsNow.length === DIRS.length, dirsNow.length === DIRS.length && modesRight,
  dirsNow.length === DIRS.length ? (modesRight ? `${DIRS.length} directories, modes as expected` : 'all present, but a mode differs') : `${DIRS.length - dirsNow.length} missing`)

// ── Channel keypair ─────────────────────────────────────────────────────────────────────────
const keyPath = join(HERE, 'mcp-channel', 'id_ed25519')
if (!existsSync(keyPath) && !CHECK) {
  mkdirSync(join(HERE, 'mcp-channel'), { recursive: true, mode: 0o700 })
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `nvoy-mcp-channel ${name}`, '-f', keyPath], { stdio: 'ignore' })
  did.push(`generated ${keyPath}`)
}
const keyOk = existsSync(keyPath) && mode(keyPath) === 0o600 && existsSync(`${keyPath}.pub`)
see('channel-key', existsSync(keyPath), keyOk, existsSync(keyPath) ? (keyOk ? 'mode 600, with its public half' : `mode ${mode(keyPath)?.toString(8)}`) : 'absent')

// ── MCP registration. Reported, never written: it edits the operator's own config, and this tool
// prints the exact command rather than reaching into it. ────────────────────────────────────
let registered = null, regNote = ''
try {
  const list = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 })
  registered = new RegExp(`^nvoy-${name}:`, 'm').test(list)
  regNote = registered
    ? 'registered — note that "Failed to connect" here is EXPECTED while the real channel holds the lock'
    : `not registered. Run:\n      claude mcp add nvoy-${name} -s user -e NVOY_INSTANCE_ROOT=${instDir} -- <node> <path>/claude-channel.mjs --instance ${name}`
} catch { registered = null; regNote = 'could not run `claude mcp list` — INCONCLUSIVE, not absent' }
see('mcp-registration', registered, false, regNote)
see('channel-answers', registered === true ? true : null, false, 'registered is not running — prove with an initialize + tools/list handshake')

// ── Report ──────────────────────────────────────────────────────────────────────────────────
const report = installState(obs)
if (did.length) { console.log(`\nchanged:`); for (const d of did) console.log(`  + ${d}`) }
if (CHECK) console.log(`\n(--check: nothing was changed)`)
console.log(`\n${name} — ${HERE}\n`)
console.log(renderState(report))
if (warn.length) { console.log(`\ncarried forward without understanding:`); for (const w of warn) console.log(`  ! ${w}`) }
console.log(`\nexit ${report.exitCode} (${report.outcome})`)
process.exit(report.exitCode)
