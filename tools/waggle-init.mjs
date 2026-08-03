#!/usr/bin/env node
// waggle-init.mjs — the guided setup. The executable form of the getting-started guide.
//
//   node tools/waggle-init.mjs                walk the setup, prompting only for what is missing
//   node tools/waggle-init.mjs --check        report readiness and change nothing
//   node tools/waggle-init.mjs --enable-mirror-consent  add this hive's consent identity
//   node tools/waggle-init.mjs --agent-launch print the safe hand-off for a coding agent
//
// Standing up a bridge is roughly two dozen steps across identities, a host, configuration,
// discoverability and admission — with private keys moving between several of them. The steps
// are not hard individually; the failure mode is that they are quiet. A wrong channel id, a
// stale build, an unsynchronised clock: each looks like success and shows up later as "the
// bridge doesn't work" with no obvious cause. So this asks, records, and then VERIFIES.
//
// What it will not do, on purpose:
//   · It never asks any agent to hand over its own key. The administrator seats credentials
//     directly. An assistant that asks an agent to export its nsec has taught the agent that
//     exporting its nsec is a normal request, which is the whole attack.
//   · It never takes a secret as a command argument (argv is world-readable in `ps`), never
//     writes one to this repo, and never prints one back.
//   · It does not touch a live host. Provisioning and seating are deliberate administrator
//     acts with their own scripts; this prepares and verifies, and tells you what to run.
//
// Resumable and idempotent: every step first checks whether it is already done.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import * as nip19 from 'nostr-tools/nip19'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = process.env.CONFIG_PATH || resolve(ROOT, 'config.json')
const EXAMPLE = resolve(ROOT, 'config.example.json')
const CHECK_ONLY = process.argv.includes('--check')
const ENABLE_MIRROR_CONSENT = process.argv.includes('--enable-mirror-consent')
const AGENT_LAUNCH = process.argv.includes('--agent-launch')

const c = { dim: '\x1b[2m', b: '\x1b[1m', ok: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m', off: '\x1b[0m' }
const say = (s = '') => console.log(s)
const head = (s) => { say(''); say(`  ${c.b}${s}${c.off}`); say(`  ${'─'.repeat(s.length)}`) }
const good = (s) => say(`    ${c.ok}✓${c.off} ${s}`)
const todo = (s) => say(`    ${c.warn}•${c.off} ${s}`)
const bad = (s) => say(`    ${c.bad}✗${c.off} ${s}`)
const note = (s) => say(`      ${c.dim}${s}${c.off}`)

const HEX64 = /^[0-9a-f]{64}$/i
const toHex = (v) => {
  const s = String(v || '').trim()
  if (s.startsWith('npub1')) return nip19.decode(s).data
  if (HEX64.test(s)) return s.toLowerCase()
  throw new Error(`not an npub or 64-hex pubkey: ${s || '(empty)'}`)
}
const isPlaceholder = (v) => typeof v === 'string' && (v.startsWith('<') || /^[A-Z_]+$/.test(v) || v.includes('UUID_'))

// A coding agent's identity belongs to that agent's runtime, not to this installer and not
// to its owner. This is deliberately a hand-off, rather than a "create agent key" action:
// the recipient mints locally, asks for a bounded admission, and burns the key on exit.
function printAgentLaunch() {
  head('Coding-agent hand-off')
  say('    Give the following job to the coding agent that will join this hive:')
  say('')
  say('      1. Mint its own ephemeral Nostr identity locally (0600; never print or export the nsec).')
  say('      2. Publish kind:0, kind:10002, and kind:10050; name it `Codex - <8 public-key hex>`')
  say('         (or the runtime family equivalent) and mark `bot:true`.')
  say('      3. Send a scoped admission request naming the Buzz channel and one-line purpose.')
  say('      4. Wait for the owner to approve the NIP-DA `admit` grant in Nvoy or waggle console.')
  say('      5. Cold-read the grant and relay lists, then send one test message and read its sealed receipt.')
  say('      6. Burn the session key on exit.')
  say('')
  note('Use Nvoy MCP only when this agent also needs delegated private data or NIP-17 conversation tools.')
  note('A standing MCP agent keeps its OWN encrypted NIP-49 key file; setup never accepts its nsec.')
  say('')
  process.exit(0)
}

if (AGENT_LAUNCH) printAgentLaunch()

// --- read what exists ------------------------------------------------------------------------
let cfg = null, cfgExists = existsSync(CONFIG)
if (cfgExists) {
  try { cfg = JSON.parse(readFileSync(CONFIG, 'utf8')) }
  catch (e) { bad(`config.json exists but is not valid JSON: ${e.message}`); process.exit(1) }
}

// --- preflight: the environment, before any questions ------------------------------------------
head('Preflight')
let blocking = 0
const nodeMajor = Number(process.versions.node.split('.')[0])
nodeMajor >= 20 ? good(`node ${process.versions.node}`) : (bad(`node ${process.versions.node} — 20 or newer required`), blocking++)

let hasBuzz = false
try { execFileSync('buzz', ['--help'], { stdio: 'ignore' }); hasBuzz = true; good('buzz CLI on PATH') }
catch { todo('buzz CLI not on PATH — needed to create the agent and read channel ids'); note('the bridge shells out to `buzz`; install it before running the lanes') }

existsSync(resolve(ROOT, 'node_modules')) ? good('dependencies installed') : (todo('dependencies not installed — run: npm ci'), blocking++)

// --- the parts a person must do, which no script may do for them --------------------------------
head('Identities — yours to create, and deliberately so')
say('    A bridge needs one dedicated agent inside your Buzz community. You create it,')
say('    you approve it, and you seat its credentials on the host yourself.')
say('')
todo('Create the bridge agent in Buzz and approve it (owner action)')
note('buzz agents draft-create --channel <default> --display-name waggle …')
todo('Export its nsec — you hold it; it is never requested from the agent')
note('an installer that asks an agent for its own key has taught it that this is normal')
todo('Mint the owner auth tag locally, with your own key:')
note('OWNER_NSEC=… AGENT_PUBKEY=<agent npub> node tools/mint-auth-tag.mjs')
note('the owner key never leaves your machine; only the public tag is emitted')
todo('Publish the agent profile — PNG avatar, not SVG')
note('Buzz renders SVG as a blank circle, which reads as an impostor account')

// --- configuration ------------------------------------------------------------------------------
head('Configuration')
if (!cfgExists) {
  todo('config.json does not exist yet')
  note(`it will be created from ${EXAMPLE.replace(ROOT + '/', '')}`)
} else {
  good('config.json present')
}

const P = cfg?.public || {}
const checks = [
  ['public.relays', Array.isArray(P.relays) && P.relays.length, 'which public relays to read and write'],
  ['public.inbox', P.inbox && !isPlaceholder(P.inbox), 'the channel bridged messages land in — the knob operators ask about first'],
  ['public.staging_inbox', P.staging_inbox && !isPlaceholder(P.staging_inbox), 'where quarantined arrivals wait; may equal inbox for a single-channel lifecycle'],
  ['public.approvers', Array.isArray(P.approvers) && P.approvers.length && !isPlaceholder(P.approvers[0]), 'who may approve, follow, mute or reject in-channel'],
  ['public.grantors', Array.isArray(P.grantors) && P.grantors.length && !isPlaceholder(P.grantors[0]), 'whose signed grants admit an outside participant'],
  ['public.watch_events', Array.isArray(P.watch_events) && P.watch_events.length && !isPlaceholder(P.watch_events[0]), 'notes whose replies you want to receive'],
]

const consentFields = ['mirror_consent_hive_id', 'mirror_consent_hive_name', 'mirror_consent_hive_handle', 'mirror_consent_terms_url', 'mirror_consent_url']
const consentMissing = () => consentFields.filter(k => !cfg?.public?.[k] || isPlaceholder(cfg?.public?.[k]))
// A configured channel is a UUID, and a UUID confirms nothing to a human. "public.inbox ✓" next
// to an unreadable id is exactly the kind of green tick that gets trusted without being checked —
// and pointing the bridge at the wrong channel is silent until members see traffic they did not
// expect. So resolve the name and show it. Best-effort: needs the CLI and credentials, and when
// it cannot resolve we say so rather than implying the id was validated.
function channelLabel(uuid) {
  if (!hasBuzz) return `${uuid} ${c.dim}(name unresolved — buzz CLI not on PATH)${c.off}`
  try {
    const out = execFileSync('buzz', ['channels', 'get', '--channel', uuid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const name = JSON.parse(out)?.name
    return name ? `${c.ok}#${name}${c.off} ${c.dim}(${uuid.slice(0, 8)}…)${c.off}` : uuid
  } catch {
    return `${uuid} ${c.dim}(name unresolved — no credentials here, or the channel is not visible to you)${c.off}`
  }
}

let gaps = 0
for (const [k, ok, why] of checks) {
  if (!ok) { todo(`${k} — ${why}`); gaps++; continue }
  if (k === 'public.inbox') good(`${k} → messages land in ${channelLabel(P.inbox)}`)
  else if (k === 'public.staging_inbox') good(`${k} → quarantine waits in ${channelLabel(P.staging_inbox)}`)
  else good(k)
}

if (P.mirror_require_consent) {
  const missing = consentMissing()
  if (missing.length) {
    todo(`mirror consent identity — enforcement is ON but needs: ${missing.join(', ')}`)
    gaps++
  } else {
    good(`mirror consent → ${P.mirror_consent_hive_name} (${P.mirror_consent_hive_handle}), bound to its stable hive id`)
  }
} else {
  todo('mirror consent is not enabled yet — public feeds remain ungated until you choose a hive identity')
  note('enable it only after the first feed invitation can be delivered; silence remains a no')
}

// --- interactive fill ---------------------------------------------------------------------------
if (!CHECK_ONLY && (gaps || !cfgExists || ENABLE_MIRROR_CONSENT)) {
  say('')
  const rl = createInterface({ input, output })
  const ask = async (q, dflt) => {
    const a = (await rl.question(`    ${q}${dflt ? ` [${dflt}]` : ''}: `)).trim()
    return a || dflt || ''
  }
  if (!cfgExists) { copyFileSync(EXAMPLE, CONFIG); cfg = JSON.parse(readFileSync(CONFIG, 'utf8')); say(`    created ${CONFIG.replace(ROOT + '/', '')} from the example`) }
  cfg.public = cfg.public || {}
  if (ENABLE_MIRROR_CONSENT) {
    cfg.public.mirror_require_consent = true
    say('')
    say('    Mirror consent will be enforced for this hive after you finish its identity below.')
    note('existing watched authors need explicit grandfathering or their feeds will hold until they consent')
  }

  if (!P.inbox || isPlaceholder(P.inbox)) {
    say('')
    say('    Which Buzz channel should bridged messages land in?')
    if (hasBuzz) say(`    ${c.dim}(run 'buzz channels list' in another window to see ids and names)${c.dim}${c.off}`)
    const v = await ask('channel name or UUID')
    if (v) cfg.public.inbox = v
  }
  if (!P.staging_inbox || isPlaceholder(P.staging_inbox)) {
    say('')
    say('    Where should quarantined arrivals wait for review?')
    say(`    ${c.dim}Same value as the inbox is fine — pending and released then live together,${c.off}`)
    say(`    ${c.dim}distinguished by how they render. Leave empty to hold-and-log instead.${c.off}`)
    const v = await ask('staging channel', cfg.public.inbox || '')
    if (v) cfg.public.staging_inbox = v
  }
  if (!P.approvers?.length || isPlaceholder(P.approvers?.[0])) {
    say('')
    say('    Who may approve a quarantined message? Usually you.')
    const v = await ask('approver npub or hex')
    if (v) { try { cfg.public.approvers = [toHex(v)] } catch (e) { bad(e.message) } }
  }
  if (!P.grantors?.length || isPlaceholder(P.grantors?.[0])) {
    const dflt = cfg.public.approvers?.[0]
    say('')
    say('    Whose signed grants admit an outside participant?')
    say(`    ${c.dim}Defaults to the approver. Separate them only if a different key issues grants.${c.off}`)
    const v = await ask('grantor npub or hex', dflt ? nip19.npubEncode(dflt) : '')
    if (v) { try { cfg.public.grantors = [toHex(v)] } catch (e) { bad(e.message) } }
  }

  // A consent grant belongs to a HIVE, not to a single channel. One owner can operate several
  // hives, so this must be a stable community id rather than an owner key or an inbox UUID.
  const needConsentIdentity = cfg.public.mirror_require_consent || !!cfg.public.mirror_consent_hive_id
  if (needConsentIdentity && consentMissing().length) {
    say('')
    say('    This hive gates mirrored feeds on each author\'s consent. Name the hive they are consenting to.')
    const hiveId = await ask('stable hive community_id (64 hex)')
    if (/^[0-9a-f]{64}$/i.test(hiveId)) cfg.public.mirror_consent_hive_id = hiveId.toLowerCase()
    else if (hiveId) bad('community_id must be 64 hexadecimal characters; it was not saved')
    const hiveName = await ask('hive display name', cfg.public.mirror_consent_hive_name || '')
    if (hiveName) cfg.public.mirror_consent_hive_name = hiveName
    const hiveHandle = await ask('hive handle (for example you@example.com)', cfg.public.mirror_consent_hive_handle || '')
    if (hiveHandle) cfg.public.mirror_consent_hive_handle = hiveHandle
    const termsUrl = await ask('terms URL', cfg.public.mirror_consent_terms_url || '')
    if (termsUrl) cfg.public.mirror_consent_terms_url = termsUrl
    const consentUrl = await ask('public consent signing page URL', cfg.public.mirror_consent_url || '')
    if (consentUrl) cfg.public.mirror_consent_url = consentUrl
  }
  await rl.close()

  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n')
  say('')
  good(`config written to ${CONFIG.replace(ROOT + '/', '')}`)
  note('config.json is git-ignored; it holds no secrets — those live in .env')
}

// --- what is left, and the order it must happen in -----------------------------------------------
head('Host — administrator acts, with their own scripts')
todo('Provision the non-root bridge user:  sh deploy/bridge-user.sh')
todo('Ship the code:                       sh deploy/deploy.sh read <user>@<host>')
todo('Seat the agent credentials yourself over ssh stdin — never argv, never a file in this repo')
note('stage, verify the staged key derives to the intended identity, then swap, then destroy the old copy')
todo('Apply the firewall:                  deploy/nave-fw.nft')
note('it permits NTP egress on purpose — a dropped clock silently corrupts every time-based gate')

head('Coding agents — optional, and never key collection')
todo('Print the safe session/MCP hand-off: node tools/waggle-init.mjs --agent-launch')
note('the agent creates its own key, requests a scoped admission, and receives a grant; no owner or wizard ever copies its nsec')
todo('For a standing Nvoy MCP agent, use an encrypted NIP-49 key file in that agent runtime')
note('MCP is for delegated private data and sealed conversations; the public mirror/consent loop does not require it')

head('After it runs — the steps that prove it, rather than assume it')
todo('Prove the firewall loaded and the clock is synced:  sudo deploy/verify-firewall.sh')
note('applying is not loading — a correct ruleset once sat on a box for a day without')
note('entering the kernel. Exit 3 means INCONCLUSIVE, which is not an all-clear.')
todo('Confirm the deployed build matches git:  sh deploy/verify-deployed.sh')
todo('Schedule the tripwire, then make it fire once on purpose')
note('a detector that has never fired is not a detector, it is an assumption with a timer')
note('npm test rehearses both controls offline; the live drill is still worth doing once')
todo('Publish the agent relay list:        node tools/publish_relay_list.mjs')
todo('Admit a participant, if you want one: sh tools/grant-setup.sh')

// --- verdict --------------------------------------------------------------------------------------
head('Readiness')
let ready = true
if (blocking) { bad(`${blocking} blocking environment problem(s) above`); ready = false }
try {
  const now = JSON.parse(readFileSync(CONFIG, 'utf8'))
  const p = now.public || {}
  const missing = ['inbox', 'approvers', 'grantors'].filter(k => !p[k] || (Array.isArray(p[k]) ? !p[k].length || isPlaceholder(p[k][0]) : isPlaceholder(p[k])))
  if (p.mirror_require_consent) missing.push(...consentFields.filter(k => !p[k] || isPlaceholder(p[k])))
  if (missing.length) { todo(`config still needs: ${missing.join(', ')}`); ready = false } else good('config has the values the bridge refuses to start without')
} catch { todo('no config yet'); ready = false }

say('')
if (ready) {
  say(`  ${c.ok}Configuration is complete.${c.off} The remaining steps are host acts, listed above.`)
  say(`  Run the safety gates before you ship:  ${c.b}npm test${c.off}`)
} else {
  say(`  ${c.warn}Not ready yet${c.off} — the marked items above are outstanding.`)
  say(`  Re-run this any time; it only asks about what is still missing.`)
}
say('')
process.exit(ready ? 0 : 1)
