// console_hive_bridge.mjs — the bridge's own controls on the hive row (#613 M4c, #625).
//
// What this suite holds:
//
//  1. Every command the hive page drafts is one the bridge's real parsers accept: the lane tag, the
//     bridge address and the canonical bytes, run through parseLifecycleCommand and parseSeatIntent.
//  2. The commands offered for a row are exactly the ones the bridge's catalogue would apply there,
//     no-ops left out (lifecycleAdmissible).
//  3. The paste checks agree with their src/ twins and refuse before anything is drafted.
//  4. "Done" is the bridge's next list showing the change, never a relay OK; a seat is only "sent".
//     Nothing is published unless the signed event is the one shown, by the owner, against a fresh list.
//  5. The page offers the controls and routes them through this module.
//
//   node tests/console_hive_bridge.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import { canonicalJson } from '../src/buzz_policy_core.mjs'
import { parseLifecycleCommand, lifecycleAdmissible, LIFECYCLE_OPERATION_NAMES, LIFECYCLE_COMMAND_D, CREDENTIAL_SHAPED as SRC_CREDENTIAL } from '../src/agent_lifecycle.mjs'
import { parseSeatIntent } from '../src/channel_seat.mjs'
import { SEAT_COMMAND_D } from '../src/channel_seat_runner.mjs'
import { LIFECYCLE_D, SEAT_D, CREDENTIAL_SHAPED, BRIDGE_OPS, offeredOps, draftBridgeCommand, commandOf, describeCommand, bridgeVerdict, applyBridgeCommand } from '../console/hive-bridge.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const throwsWith = (fn, re) => { try { fn(); return false } catch (e) { return re.test(e.message) } }

const key = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) } }
const O = key(), B = key(), A = key(), X = key()
const now = Math.floor(Date.now() / 1000)
// A well-formed ssh-ed25519 public key line: the length-prefixed type, then 32 key bytes.
const lp = b => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b])
const SSH = `ssh-ed25519 ${Buffer.concat([lp(Buffer.from('ssh-ed25519')), lp(Buffer.alloc(32, 7))]).toString('base64')} pi-dog@nave`

// ── 1. Drafts the bridge accepts ─────────────────────────────────────────────────────────────────
check(LIFECYCLE_D === LIFECYCLE_COMMAND_D && SEAT_D === SEAT_COMMAND_D, 'the lane tags are the ones the bridge and the broker filter on')
const drafts = [
  ...['agent_admit', 'agent_pause', 'agent_resume', 'agent_revoke', 'agent_forget'].map(op => ({ op })),
  { op: 'agent_return_lane', extra: { enabled: true } }, { op: 'agent_return_lane', extra: { enabled: false } },
  { op: 'agent_rename', extra: { label: 'Pi Dog' } },
]
let accepted = true, canon = true, addressed = true
for (const { op, extra } of drafts) {
  const t = draftBridgeCommand({ bridge: B.pk, agent: A.pk, op, extra, now })
  const body = commandOf(t)
  if (!parseLifecycleCommand(body).ok) accepted = false
  if (t.content !== canonicalJson(body)) canon = false
  if (t.kind !== 30078 || JSON.stringify(t.tags) !== JSON.stringify([['d', LIFECYCLE_D], ['p', B.pk]])) addressed = false
}
check(accepted, 'every lifecycle command drafted is accepted by parseLifecycleCommand, extra fields included')
check(canon, "and its content is byte-identical to the bridge's canonicalJson")
check(addressed, 'and it is a kind 30078 on the lifecycle lane, addressed to the bridge')
{
  const t = draftBridgeCommand({ bridge: B.pk, agent: A.pk, op: 'channel_seat', extra: { key: `  ${SSH}\n` }, now })
  check(t.tags[0][1] === SEAT_D && parseSeatIntent(commandOf(t)).ok && t.content === canonicalJson(commandOf(t)), 'a seat goes on the seat lane, trimmed, and parseSeatIntent accepts it')
}
check(throwsWith(() => draftBridgeCommand({ bridge: B.pk, agent: A.pk, op: 'agent_delete' }), /no command called agent_delete/), 'an operation outside the catalogue is refused')
check(throwsWith(() => draftBridgeCommand({ bridge: '', agent: A.pk, op: 'agent_pause' }), /bridge key is not set/), 'no bridge key, no draft')
check(commandOf(draftBridgeCommand({ bridge: B.pk, agent: A.pk, op: 'agent_pause', extra: { enabled: true, label: 'x' } })).enabled === undefined, 'a value a command does not take is dropped, not sent')

// ── 2. What a row offers ─────────────────────────────────────────────────────────────────────────
const entries = [undefined, ...['admitted', 'paused', 'revoked'].flatMap(status => [true, false].map(return_lane => ({ pubkey: A.pk, status, return_lane })))]
let offeredOk = true, complete = true
for (const entry of entries) {
  const offered = offeredOps(entry)
  for (const { op, extra } of offered) {
    const verdict = lifecycleAdmissible(parseLifecycleCommand({ v: 1, op, agent: A.pk, ...extra }), entry)
    if (!verdict.ok || verdict.noop) offeredOk = false
    if (op === 'agent_return_lane' && extra.enabled === entry.return_lane) offeredOk = false
  }
  for (const op of LIFECYCLE_OPERATION_NAMES) {
    if (op === 'agent_rename' || op === 'agent_return_lane') continue
    // Letting a paused agent in again is what Resume does, so the row offers Resume alone.
    if (op === 'agent_admit' && entry?.status === 'paused') continue
    const verdict = lifecycleAdmissible(parseLifecycleCommand({ v: 1, op, agent: A.pk }), entry)
    if (verdict.ok && !verdict.noop && !offered.some(o => o.op === op)) complete = false
  }
  if (entry && entry.status !== 'revoked' && !offered.some(o => o.op === 'agent_return_lane')) complete = false
}
check(offeredOk, 'every command offered is one the catalogue applies to that row, and none is a no-op')
check(complete, 'and every command the catalogue would apply there is offered')
check(JSON.stringify(offeredOps(undefined)) === '[{"op":"agent_admit"}]', 'a key not on the list is offered only letting it in')

// ── 3. Paste checks ──────────────────────────────────────────────────────────────────────────────
check(CREDENTIAL_SHAPED.source === SRC_CREDENTIAL.source && CREDENTIAL_SHAPED.flags === SRC_CREDENTIAL.flags, "the rename credential check is src/agent_lifecycle.mjs's CREDENTIAL_SHAPED")
const rename = label => () => draftBridgeCommand({ bridge: B.pk, agent: A.pk, op: 'agent_rename', extra: { label } })
check(throwsWith(rename('nsec1qqqq'), /looks like a key/) && throwsWith(rename(X.pk), /looks like a key/) && throwsWith(rename('bunker://x'), /looks like a key/), 'a rename that looks like a key or a Bunker URI is refused as one')
check(throwsWith(rename('x'.repeat(65)), /1–64 printable/) && throwsWith(rename('two\nlines'), /1–64 printable/), 'a label that is too long or spans lines is refused')
const seat = k => () => draftBridgeCommand({ bridge: B.pk, agent: A.pk, op: 'channel_seat', extra: { key: k } })
check(throwsWith(seat('-----BEGIN OPENSSH PRIVATE KEY-----\nabc'), /PRIVATE key/), 'a private key pasted as a seat is named as one, before any shape complaint')
check(throwsWith(seat(`restrict ${SSH}`), /ssh-ed25519 line only/), 'an authorized_keys options prefix is refused as itself')
check(throwsWith(seat('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ'), /not an ed25519/), 'a key of another type is refused')
check(parseSeatIntent({ v: 1, op: 'channel_seat', agent: A.pk, key: `restrict ${SSH}` }).ok === false, "  …and the broker side refuses the same paste, so the two agree")

// ── 4. Done, and refusals before publishing ──────────────────────────────────────────────────────
const state = (at, agents) => ({ observed_at: at, agents })
const before = state(now - 60, [{ pubkey: A.pk, status: 'admitted', return_lane: true }])
const pause = commandOf(draftBridgeCommand({ bridge: B.pk, agent: A.pk, op: 'agent_pause' }))
check(bridgeVerdict(pause, before, [state(now, [{ pubkey: A.pk, status: 'paused', return_lane: true }])]).done === true, 'done when a newer list shows the change')
check(bridgeVerdict(pause, before, [state(now, [{ pubkey: A.pk, status: 'admitted', return_lane: true }])]).done === false && /may have refused/.test(bridgeVerdict(pause, before, [state(now, before.agents)]).text), 'not done when a newer list does not show it')
check(/Not shown yet/.test(bridgeVerdict(pause, before, [before]).text), 'and "not shown yet" when no newer list has been published, however right the old one looks')
const forget = commandOf(draftBridgeCommand({ bridge: B.pk, agent: A.pk, op: 'agent_forget' }))
check(bridgeVerdict(forget, before, [state(now, [])]).done === true, 'a forget is done when the row is gone from a newer list')
const seatCmd = commandOf(draftBridgeCommand({ bridge: B.pk, agent: A.pk, op: 'channel_seat', extra: { key: SSH } }))
check(bridgeVerdict(seatCmd, before, []).done === null && /connection check/.test(bridgeVerdict(seatCmd, before, []).text), 'a seat is never called done here: the roster does not show seats')

// Simulated relays: each acknowledges what it is sent, or refuses the connection.
function relays(modes) {
  const sent = []
  const connect = url => {
    if (modes[url] === 'down') throw new Error('refused')
    const ws = { send(raw) { const m = JSON.parse(raw); if (m[0] === 'EVENT') { sent.push(url); setTimeout(() => ws.onmessage?.({ data: JSON.stringify(['OK', m[1].id, true, '']) }), 0) } }, close() {} }
    setTimeout(() => ws.onopen?.(), 0)
    return ws
  }
  return { connect, sent }
}
const URLS = ['wss://a.example', 'wss://b.example']
const signAs = (k, edit = t => t) => async t => finalizeEvent(edit({ ...t, tags: t.tags.map(x => [...x]) }), k.sk)
const run = async (template, opts) => applyBridgeCommand(template, { owner: O.pk, verify: verifyEvent, relays: URLS, before: state(now - 30, before.agents), sleep: async () => {}, pollMs: 1, waitMs: 5, timeoutMs: 500, ...opts })
const rejects = async (p, re) => { try { await p; return false } catch (e) { return re.test(e.message) } }
const pauseT = draftBridgeCommand({ bridge: B.pk, agent: A.pk, op: 'agent_pause' })
{
  const net = relays({})
  check(await rejects(run(pauseT, { sign: signAs(O, t => ({ ...t, created_at: t.created_at - 86400 })), connect: net.connect, readStates: async () => [] }), /not the one shown/) && net.sent.length === 0, 'a re-dated command is refused before any relay is sent anything')
  check(await rejects(run(pauseT, { sign: signAs(O, t => ({ ...t, content: t.content.replace('agent_pause', 'agent_revoke') })), connect: net.connect, readStates: async () => [] }), /not the one shown/), 'so is one whose command was changed')
  check(await rejects(run(pauseT, { sign: signAs(X), connect: net.connect, readStates: async () => [] }), /different key/) && net.sent.length === 0, 'and one signed by a key other than the one the hive was read as')
  check(await rejects(run(pauseT, { sign: signAs(O), connect: net.connect, readStates: async () => [], before: state(now - 3600, before.agents) }), /./) && net.sent.length === 0, 'a list too old to act on stops the command before it is signed')
}
check(await rejects(run(pauseT, { sign: signAs(O), connect: relays({ [URLS[0]]: 'down', [URLS[1]]: 'down' }).connect, readStates: async () => [] }), /No relay accepted/), 'no relay accepting it is an error, not a pending change')
{
  let reads = 0
  const later = [state(now + 1, [{ pubkey: A.pk, status: 'paused', return_lane: true }])]
  const r = await run(pauseT, { sign: signAs(O), connect: relays({}).connect, readStates: async () => (++reads < 2 ? [] : later) })
  check(r.verdict.done === true && reads === 2 && /Done\..*2 of 2 relays accepted it/.test(r.text), 'it waits for the bridge\'s next list and stops as soon as that list shows the change')
}
{
  const r = await run(pauseT, { sign: signAs(O), connect: relays({}).connect, readStates: async () => [] })
  check(r.verdict.done === false && /Not shown yet/.test(r.text), 'relays accepting it, with no newer list, is "not shown yet", never done')
}
{
  let reads = 0
  const r = await run(draftBridgeCommand({ bridge: B.pk, agent: A.pk, op: 'channel_seat', extra: { key: SSH } }), { sign: signAs(O), connect: relays({}).connect, readStates: async () => { reads++; return [] } })
  check(r.verdict.done === null && reads === 0 && /^Sent\./.test(r.text), 'a seat is reported sent, without waiting on a list that will never show it')
}
check(describeCommand(pauseT, pk => pk === A.pk ? 'Pi Dog' : '?') === 'Pause routing to Pi Dog. It stays in.', 'the confirm panel names the agent, not its key')
check(Object.values(BRIDGE_OPS).every(o => !/admi(t|ssion)|grant/i.test(o.words('Pi Dog', { enabled: true, label: 'x' }))), 'no command is worded with "admit" or "grant"')

// ── 5. The page ──────────────────────────────────────────────────────────────────────────────────
const page = readFileSync(join(ROOT, 'console/hive.html'), 'utf8')
check(page.includes("from './hive-bridge.mjs'") && /function bridgeControls\(/.test(page) && /bridgeControls\(box, r,/.test(page), "each row's editor carries the bridge's controls from hive-bridge.mjs")
check(/controlStateFresh\(state\.observed_at\)/.test(page), 'and offers them only against a list fresh enough to act on')
check(/c\.bridge\s*\?\s*await applyBridgeCommand\(/.test(page) && /before: hive\.rosterState/.test(page), 'a bridge command is signed through the same confirm panel, judged against the list the page drew')
check(/offeredOps\(entry\)/.test(page) && /draftBridgeCommand\(\{ bridge: hive\.bridge, agent: r\.pubkey/.test(page), 'it offers what offeredOps allows, for the row it is on')

// The Agents tab is retired into this page (#613 M4d): its old address forwards here, and no page
// links to it any more.
const old = readFileSync(join(ROOT, 'console/agents.html'), 'utf8')
check(/http-equiv="refresh" content="0; url=\/console\/hive\.html"/.test(old) && old.length < 2000, 'the old Agents address forwards to the hive page and carries no page of its own')
const linking = readdirSync(join(ROOT, 'console')).filter(f => f.endsWith('.html') && f !== 'agents.html' && readFileSync(join(ROOT, 'console', f), 'utf8').includes('agents.html'))
check(linking.length === 0, `no console page links to the Agents tab${linking.length ? ` (still: ${linking.join(', ')})` : ''}`)
check(/look\.onclick = \(\) => checkFound\(r, look, out\)/.test(page) && /hive\.rosterState\?\.agents\.find\(a => a\.pubkey === r\.pubkey\)/.test(page),
  "the Agents tab's liveness check is on each hive row, judged against the bridge's own list")

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
