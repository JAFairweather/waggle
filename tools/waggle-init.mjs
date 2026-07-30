#!/usr/bin/env node
// waggle-init.mjs — the guided setup. The executable form of the getting-started guide.
//
//   node tools/waggle-init.mjs            walk the setup, prompting only for what is missing
//   node tools/waggle-init.mjs --check    report readiness and change nothing
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

const c = { dim: '\x1b[2m', b: '\x1b[1m', ok: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m', off: '\x1b[0m' }
const say = (s = '') => console.log(s)
const head = (s) => { say(''); say(`  ${c.b}${s}${c.off}`); say(`  ${'─'.repeat(s.length)}`) }
const good = (s) => say(`    ${c.ok}✓${c.off} ${s}`)
const todo = (s) => say(`    ${c.warn}•${c.off} ${s}`)
const bad = (s) => say(`    ${c.bad}✗${c.off} ${s}`)
const note = (s) => say(`      ${c.dim}${s}${c.off}`)

const HEX64 = /^[0-9a-f]{64}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const toHex = (v) => {
  const s = String(v || '').trim()
  if (s.startsWith('npub1')) return nip19.decode(s).data
  if (HEX64.test(s)) return s.toLowerCase()
  throw new Error(`not an npub or 64-hex pubkey: ${s || '(empty)'}`)
}
const isPlaceholder = (v) => typeof v === 'string' && (v.startsWith('<') || /^[A-Z_]+$/.test(v) || v.includes('UUID_'))

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
let gaps = 0
for (const [k, ok, why] of checks) { if (ok) good(k); else { todo(`${k} — ${why}`); gaps++ } }

// --- interactive fill ---------------------------------------------------------------------------
if (!CHECK_ONLY && (gaps || !cfgExists)) {
  say('')
  const rl = createInterface({ input, output })
  const ask = async (q, dflt) => {
    const a = (await rl.question(`    ${q}${dflt ? ` [${dflt}]` : ''}: `)).trim()
    return a || dflt || ''
  }
  if (!cfgExists) { copyFileSync(EXAMPLE, CONFIG); cfg = JSON.parse(readFileSync(CONFIG, 'utf8')); say(`    created ${CONFIG.replace(ROOT + '/', '')} from the example`) }
  cfg.public = cfg.public || {}

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

head('After it runs — the steps that prove it, rather than assume it')
todo('Confirm the clock is synchronised on the host')
todo('Confirm the deployed build matches git:  sh deploy/verify-deployed.sh')
todo('Schedule the tripwire, then make it fire once on purpose')
note('a detector that has never fired is not a detector, it is an assumption with a timer')
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
