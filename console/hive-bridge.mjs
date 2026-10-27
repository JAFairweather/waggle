// hive-bridge.mjs — the bridge's own controls, on the hive row (#613 M4c, #625).
//
// These are not approvals. Each is one signed command to the waggle bridge, the same kind 30078
// event the Agents page sends: `d` names the lane, `p` names the bridge, and the content is the
// command as canonical JSON. The bridge checks the signer is an approver and the command against its
// closed catalogue (src/agent_lifecycle.mjs, src/channel_seat.mjs), applies it, and republishes its
// roster. tests/console_hive_bridge.mjs runs every draft through those real parsers.
//
// "Done" follows the rest of the page: a relay's OK is not the change. A lifecycle command is done
// when the bridge publishes a newer roster that shows it. A seat never lands in the roster, so it is
// reported as sent, and the agent's own connection check is its proof.

import { requireFreshControlState } from './control-state-freshness.mjs'
import { sameAsDrafted, publishTo, relayHost } from './hive-change.mjs'

export const LIFECYCLE_D = 'waggle-agent-lifecycle'
export const SEAT_D = 'waggle-channel-seat'
// The relays the bridge reads commands from and publishes its roster to, as on the Agents page.
export const BRIDGE_RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.ditto.pub', 'wss://jskitty.com/nostr']
const HEX64 = /^[0-9a-f]{64}$/

// Declared again rather than imported, because console/ cannot import src/ at runtime. The suite
// asserts each agrees with its src/ twin.
export const CREDENTIAL_SHAPED = /nsec1|ncryptsec1|bunker:|^[0-9a-f]{64}$/i
const LABEL = /^[\x20-\x7e]{1,64}$/
const PRIVATE_KEY = /BEGIN [A-Z ]*PRIVATE KEY|PuTTY-User-Key-File|nsec1|ncryptsec1|bunker:/i
const SEAT_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{16,1024}={0,3}( [\x20-\x7e]{0,128})?$/

// The bridge compares content bytes against a canonical re-serialisation, so key order is wire format.
export const canonical = body => JSON.stringify(Object.fromEntries(Object.keys(body).sort().map(k => [k, body[k]])))

// What each command says in the confirm panel, and what the bridge's next roster must show for it to
// count. `entry` is the agent's roster row after the command, or undefined when it has no row.
export const BRIDGE_OPS = Object.freeze({
  agent_admit: { words: a => `Let ${a} in: it may post in the community under its own key.`, shows: e => e?.status === 'admitted' },
  agent_pause: { words: a => `Pause routing to ${a}. It stays in.`, shows: e => e?.status === 'paused' },
  agent_resume: { words: a => `Resume routing to ${a}.`, shows: e => e?.status === 'admitted' },
  agent_revoke: { words: a => `Remove ${a} from the community.`, shows: e => e?.status === 'revoked' },
  agent_forget: { words: a => `Forget ${a}: drop its removed row from the bridge's list.`, shows: e => !e },
  agent_return_lane: { words: (a, x) => x.enabled ? `Carry mentions of ${a} out to it.` : `Stop carrying mentions of ${a} out to it.`, shows: (e, x) => e?.return_lane === x.enabled },
  agent_rename: { words: (a, x) => `Rename ${a} to "${x.label}" on this console.`, shows: (e, x) => e?.label === x.label },
  channel_seat: { words: a => `Seat ${a}'s channel key on the broker.`, shows: null },
})

// The commands worth offering for a roster row: the ones the bridge's catalogue admits and that
// would change something (lifecycleAdmissible, minus its no-ops). Rename and seat are offered
// separately, because each takes a value.
export function offeredOps(entry) {
  if (!entry) return [{ op: 'agent_admit' }]
  const lane = entry.status === 'revoked' ? [] : [{ op: 'agent_return_lane', extra: { enabled: !entry.return_lane } }]
  if (entry.status === 'admitted') return [{ op: 'agent_pause' }, ...lane, { op: 'agent_revoke' }]
  if (entry.status === 'paused') return [{ op: 'agent_resume' }, ...lane, { op: 'agent_revoke' }]
  if (entry.status === 'revoked') return [{ op: 'agent_admit' }, { op: 'agent_forget' }]
  return []
}

export function draftBridgeCommand({ bridge, agent, op, extra = {}, now = Math.floor(Date.now() / 1000) }) {
  if (!HEX64.test(bridge || '')) throw new Error('The waggle bridge key is not set in this browser.')
  if (!HEX64.test(agent || '')) throw new Error('The agent is not a public key.')
  if (!BRIDGE_OPS[op]) throw new Error(`The bridge has no command called ${op}.`)
  if (op === 'agent_rename') {
    // The credential check runs first: a rename goes to public relays inside the signed command.
    if (CREDENTIAL_SHAPED.test(extra.label || '')) throw new Error('That looks like a key or a Bunker URI. A rename is published to public relays, so this would make it world-readable. Nothing was sent.')
    if (!LABEL.test(extra.label || '')) throw new Error('A label is 1–64 printable characters on one line. Spaces are fine.')
    extra = { label: extra.label }
  } else if (op === 'channel_seat') {
    const key = String(extra.key || '').trim()
    if (PRIVATE_KEY.test(key)) throw new Error('That is a PRIVATE key or a signing URI. Nothing was sent. A seat needs the matching .pub file: the one line beginning ssh-ed25519.')
    if (/(^|\s)ssh-ed25519\s/.test(key) && !/^ssh-ed25519\s/.test(key)) throw new Error('Paste the ssh-ed25519 line only. What precedes it are authorized_keys options, which come from the broker\'s own config. Nothing was sent.')
    if (!SEAT_KEY.test(key)) throw new Error('That is not an ed25519 ssh public key. It is one line: ssh-ed25519, the base64 blob, and an optional comment. Nothing was sent.')
    extra = { key }
  } else if (op === 'agent_return_lane') {
    if (typeof extra.enabled !== 'boolean') throw new Error('Say whether to carry mentions or stop.')
    extra = { enabled: extra.enabled }
  } else extra = {}
  return { kind: 30078, created_at: now, tags: [['d', op === 'channel_seat' ? SEAT_D : LIFECYCLE_D], ['p', bridge]], content: canonical({ v: 1, op, agent, ...extra }) }
}

export const commandOf = template => JSON.parse(template.content)
export const describeCommand = (template, nameOf) => { const c = commandOf(template); return BRIDGE_OPS[c.op].words(nameOf(c.agent), c) }

// Judge the rosters read after publishing: done when one newer than the roster the change was drafted
// against shows the change.
export function bridgeVerdict(command, before, after) {
  const shows = BRIDGE_OPS[command.op].shows
  if (!shows) return { done: null, newer: false, text: 'Sent. A seat does not appear on the bridge\'s list: the agent\'s own connection check is the proof that it was seated.' }
  const newer = after.filter(s => s.observed_at > before.observed_at)
  const done = newer.some(s => shows(s.agents.find(a => a.pubkey === command.agent), command))
  return { done, newer: newer.length > 0, text: done ? 'Done. The bridge\'s list now shows it.'
    : newer.length ? 'Not done. The bridge published its list after the command, and the list does not show the change. It may have refused it.'
      : 'Not shown yet. The bridge has not published a newer list. Read the hive again in a minute.' }
}

// Sign, check it is the command shown, publish, then wait for the bridge's next roster. `readStates`
// returns the bridge's valid signed rosters; `before` is the one the page drew.
export async function applyBridgeCommand(template, { sign, owner, verify, connect, before, readStates, relays = BRIDGE_RELAYS, timeoutMs, waitMs = 30000, pollMs = 3000, sleep = ms => new Promise(r => setTimeout(r, ms)), onStep = () => {} }) {
  requireFreshControlState(before)
  onStep('waiting for your signer')
  const signed = await sign(template)
  let valid = false
  try { valid = verify(signed) } catch {}
  if (!valid || !sameAsDrafted(signed, template)) throw new Error('The signer returned an event that is not the one shown. Nothing was published.')
  if (signed.pubkey !== owner) throw new Error('Your signer signed with a different key from the one this page read the hive as. Nothing was published.')
  onStep('publishing')
  const published = await publishTo(signed, { relays, connect, timeoutMs })
  const accepted = published.filter(p => p.outcome === 'accepted')
  if (!accepted.length) throw new Error('No relay accepted the command. Nothing changed.')
  const command = commandOf(template)
  let verdict = bridgeVerdict(command, before, [])
  if (verdict.done !== null) {
    onStep("waiting for the bridge's list")
    for (let waited = 0; waited < waitMs; waited += pollMs) {
      await sleep(pollMs)
      verdict = bridgeVerdict(command, before, await readStates())
      if (verdict.done) break
    }
  }
  const sent = `${accepted.length} of ${relays.length} relays accepted it (${accepted.map(p => relayHost(p.url)).join(', ')}).`
  return { signed, published, verdict, text: `${verdict.text} ${sent}` }
}
