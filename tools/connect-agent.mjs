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
//   node tools/connect-agent.mjs --name oliver --check --stanza   # how to register, per runtime
//
// --whoami <path>    the `nvoy_whoami` result captured from the session under test, compared
//                    against --pubkey. This is the MCP path's EXPECT_PUBKEY (#338): registered is
//                    not sole, and sole is not YOURS. Without it the binding reads UNCHECKED.
//
// --from <instance>  mirror an existing agent's manifest for the fields this repo cannot derive
//                    (grantors, task carriers, relays). Mirroring is not understanding: the
//                    copied values are reported, and docs/DESIGN_CONNECT_REMOTE_AGENT.md §II
//                    records which of them nobody currently understands.

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { boundIdentity, installState, renderState } from '../src/agent_install_state.mjs'
import { channelStanza, cliRuntimes, foreignServers, isMine, registrationHelp, stanzaJson } from '../src/mcp_runtimes.mjs'

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
// The inbound half (#337). Named here rather than left silent because the note IS the remedy: an
// operator who cannot see this question does not know to ask it, which is how an agent shipped
// write-only and only the bridge's own journal knew.
see('dm-relays', null, false,
  pubkey
    ? 'not checked here — publish with tools/publish-dm-relay-list.mjs (prefer NVOY_BUNKER), which cold-reads it back by id'
    : 'no --pubkey given, so nothing to look up')

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
// prints the exact command rather than reaching into it.
//
// Every runtime installed on this host is asked, not just Claude Code (#464, #333 §1). Three
// outcomes, kept apart on purpose:
//   not installed  — not one of this host's runtimes. Not a failure, and NOT inconclusive.
//   unreadable     — installed, asked, could not be understood. INCONCLUSIVE.
//   answered       — a list, possibly empty. Empty means nothing is registered, and says so.
// Collapsing the first two is how a Codex box reported "could not run `claude mcp list`" forever
// while its own registration sat there, readable, unasked. ──────────────────────────────────
const stanza = channelStanza({
  agent: name, command: '<node>', args: ['<path>/claude-channel.mjs'], instanceRoot: instDir,
})
const probes = []
for (const rt of cliRuntimes()) {
  let out = null, installed = true
  try {
    out = execFileSync(rt.bin, rt.listArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 })
  } catch (e) {
    // ENOENT is the binary not being here at all. A non-zero exit ran and failed, which is a
    // different thing and stays INCONCLUSIVE.
    installed = e?.code !== 'ENOENT'
    out = null
  }
  probes.push({ rt, installed, names: installed ? rt.parse(out) : null })
}
const answered = probes.filter(p => p.installed && Array.isArray(p.names))
const unreadable = probes.filter(p => p.installed && p.names === null)
const hosts = answered.filter(p => p.names.some(n => isMine(n, name))).map(p => p.rt.label)

let registered = null, regNote = ''
if (answered.length === 0) {
  registered = null
  regNote = unreadable.length
    ? `${unreadable.map(p => `\`${p.rt.bin} ${p.rt.listArgs.join(' ')}\``).join(', ')} could not be read — INCONCLUSIVE, not absent`
    : 'no MCP host CLI on this machine — register from the stanza (--stanza) and prove it with an initialize + tools/list handshake'
} else if (hosts.length) {
  registered = true
  const caveat = answered.find(p => p.rt.listCaveat && hosts.includes(p.rt.label))?.rt.listCaveat
  regNote = `registered in ${hosts.join(', ')}${caveat ? ` — ${caveat}` : ''}`
} else {
  registered = false
  regNote = `not registered in ${answered.map(p => p.rt.label).join(', ')}. Run:\n`
    + answered.map(p => `      ${p.rt.add(stanza)}`).join('\n')
}
if (unreadable.length && answered.length) {
  regNote += `\n      (${unreadable.map(p => p.rt.label).join(', ')} is installed but could not be read — UNCHECKED)`
}
see('mcp-registration', registered, false, regNote)

// Registered is not SOLE. #338: the acting tools live on a generically-named server that is not
// instance-bound, so a correct `nvoy-<name>` alongside a bare `nvoy` still signs as somebody else.
// This is the MCP path's EXPECT_PUBKEY — the Bunker path hard-stops on a key mismatch, and until
// now this one had no guard at all.
//
// Asserted across every runtime that answered, and labelled with which one, because "remove it"
// is a different command in each. It also now sees `nvoy_other` and not only `nvoy-other`: the
// hyphen-only test reported sole occupancy with an underscore-spelled channel beside it (#464).
const foreign = answered.length === 0
  ? null
  : answered.flatMap(p => foreignServers(p.names, name).map(s => ({ rt: p.rt, server: s })))
see('mcp-exclusive', foreign === null ? null : foreign.length === 0, foreign !== null && foreign.length === 0,
  foreign === null
    ? (unreadable.length ? 'no runtime could be read — INCONCLUSIVE, not absent' : 'no MCP host CLI on this machine to ask — UNKNOWN, not clean')
    : foreign.length === 0
      ? `nvoy-${name} is the only nvoy server registered in ${answered.map(p => p.rt.label).join(', ')}`
      : `also registered: ${foreign.map(f => `${f.server} (${f.rt.label})`).join(', ')} — these carry the tools that SIGN, and not as ${name}. Remove with \`${foreign.map(f => f.rt.remove(f.server))[0]}\` before acting.`)
if (foreign?.length) warn.push(`${foreign.map(f => f.server).join(', ')} would sign as another identity from this session`)

// Sole is not YOURS (#338). Nothing here can call the server — the channel holds its own lock — so
// the operator captures `nvoy_whoami` from the session under test and passes the file. Reported
// UNKNOWN without it, never as a pass: an unsupplied comparison reading green is the defect.
const whoamiPath = flag('--whoami')
let captured = null
if (whoamiPath) {
  try { captured = readFileSync(whoamiPath, 'utf8') } catch { captured = null }
  if (captured === null) warn.push(`could not read ${whoamiPath} — the binding is UNCHECKED, not clean`)
}
const bind = boundIdentity(captured, pubkey)
const bindRemedy = !pubkey
  ? ' — pass --pubkey <64-hex>'
  : captured === null ? ' — call nvoy_whoami in the session under test, save the result, and pass --whoami <path>' : ''
see('mcp-identity', bind.match, bind.match === true, bind.match === null ? bind.reason + bindRemedy : bind.reason)
if (bind.match === false) warn.push(`this session answers as ${bind.resolved.slice(0, 12)}… — do not send, do not read; it is not ${name}`)

see('channel-answers', registered === true ? true : null, false, 'registered is not running — prove with an initialize + tools/list handshake')

// ── Report ──────────────────────────────────────────────────────────────────────────────────
const report = installState(obs)
if (did.length) { console.log(`\nchanged:`); for (const d of did) console.log(`  + ${d}`) }
if (CHECK) console.log(`\n(--check: nothing was changed)`)
console.log(`\n${name} — ${HERE}\n`)
console.log(renderState(report))
if (warn.length) { console.log(`\ncarried forward without understanding:`); for (const w of warn) console.log(`  ! ${w}`) }

// --stanza prints the registration for EVERY runtime, labelled, including the neutral JSON for a
// host with no CLI to run — a Pi, a headless box, anything self-hosted. Printed on request rather
// than always, because an unrequested wall of config is how the one line that mattered gets missed.
if (has('--stanza')) {
  console.log(`\nregister the channel — pick your runtime, not the first block you see:`)
  for (const h of registrationHelp(stanza)) {
    console.log(`\n  ${h.label}`)
    if (h.kind === 'cli') console.log(`    ${h.line}`)
    else console.log(`    ${h.config}\n` + h.json.split('\n').map(l => `    ${l}`).join('\n'))
  }
  console.log(`\n  <node> and <path> are this host's node and its nvoy checkout. Nothing above is secret;`)
  console.log(`  the pairing is delivered to the installer on stdin and never appears in a paste block (#333).`)
}
console.log(`\nexit ${report.exitCode} (${report.outcome})`)
process.exit(report.exitCode)
