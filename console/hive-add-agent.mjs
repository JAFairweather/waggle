// hive-add-agent.mjs — the owner-signed setup requests behind "Add an agent" (#649, nvoy #289).
//
// The page drafts, the owner's signer signs, the page publishes. The fleet's `nvoy-onboard` reads
// the request, verifies the signer is a grantor of the agent it copies, and runs the tools. So the
// request carries public fields only, in the closed set nvoy accepts; anything else would be refused
// there, and is refused here first so the owner is not asked to sign something that cannot work.
//
// "Done" is never the relay's OK. Each step's proof is read back by the page itself.

import { sameAsDrafted, publishTo, relayHost } from './hive-change.mjs'

export const SETUP_KIND = 30078
export const HARNESSES = Object.freeze([
  ['claude-code', 'Claude Code'], ['codex', 'Codex'], ['pi', 'Pi'], ['openclaw', 'OpenClaw'], ['grokbot', 'Grok Bot'], ['hermes', 'Hermes'], ['antigravity', 'Gemini (Antigravity)']])
const HARNESS_IDS = HARNESSES.map(([id]) => id)
const NAME = /^[a-z0-9][a-z0-9._-]{1,63}$/
const HEX64 = /^[0-9a-f]{64}$/
const ROOM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SSH_PUBLIC = /^(ssh-ed25519|ecdsa-sha2-nistp256)\s+([A-Za-z0-9+/]+={0,2})(?:\s+\S.*)?$/
// The join tags, checked by nvoy-onboard's own rules (onboard_request.mjs) so a request the fleet
// would refuse is never put in front of the owner's signer.
export const POLICY = /^[A-Za-z0-9._:-]{1,64}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export const requestD = (name, op) => `nvoy-onboard/${name}/${op}`

// A NIP-44 v2 payload: version byte 2, a 32-byte nonce, at least 34 padded bytes, a 32-byte MAC.
export function sealedShape(value) {
  const text = String(value || '')
  if (!BASE64.test(text) || text.length < 132 || text.length > 87472) return false
  const bytes = globalThis.atob(text)
  return bytes.length >= 99 && bytes.charCodeAt(0) === 2
}

// The hive invite, sealed to the agent; the terms version the owner agreed to (or none); the age
// confirmation exactly as ticked.
function joinTags({ invite = '', policy = '', age } = {}) {
  if (!invite) throw new Error('The request needs the hive invite.')
  if (!sealedShape(invite)) throw new Error('The invite must be sealed to the agent, never plain.')
  if (!POLICY.test(policy)) throw new Error('The request needs the terms version you agreed to, or none.')
  if (age !== undefined && age !== 'confirmed') throw new Error('The age confirmation is confirmed, or absent.')
  return [['invite', invite], ['policy', policy], ...(age ? [['age', age]] : [])]
}

// The name the owner types, as the fleet will use it: lower case, no spaces.
export function agentName(text) {
  const name = String(text || '').trim().toLowerCase()
  if (!NAME.test(name)) throw new Error('Use 2 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.')
  return name
}

// The agent's first profile, which its own broker publishes on first start (#717). nvoy-onboard
// refuses the same shapes: a name of one line, 1 to 64 characters; an about of at most 500, and only
// with a name, since a first profile must set one.
export function profileTags({ displayName = '', about = '' } = {}) {
  const name = String(displayName).trim(), line = String(about).trim()
  if (!name && !line) return []
  if (!name) throw new Error('Give it a display name to go with the line about it.')
  if (/nsec1|bunker:|nostrconnect:|PRIVATE KEY|secret=/i.test(name + line)) throw new Error('That looks like a secret. A profile is public; take it out.')
  if (name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('The display name is one line of up to 64 characters.')
  if (line.length > 500 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(line)) throw new Error('The line about it is up to 500 characters.')
  return [['display_name', name], ...(line ? [['about', line]] : [])]
}

function common({ name, agent, harness, like, installed = [] }) {
  const n = agentName(name)
  if (!HEX64.test(agent || '')) throw new Error('That is not the agent\'s public key.')
  if (!HARNESS_IDS.includes(harness)) throw new Error('Pick what it runs in.')
  if (!like) throw new Error('Pick an agent for it to start like.')
  const taken = installed.find(entry => entry.pubkey === agent || entry.id === n)
  if (taken) throw new Error(taken.pubkey === agent ? `That key is already ${taken.id}.` : `${n} is already an agent's name.`)
  return n
}

// add_agent: who it is, what it runs in, whom it starts like, who may give it work, its rooms, the
// name it shows (when given), and (when `join` is given) how it joins the hive.
export function draftAddAgent({ name, agent, harness, like, givers = [], rooms = [], displayName, about, join, installed = [], now = Math.floor(Date.now() / 1000) }) {
  const n = common({ name, agent, harness, like, installed })
  const g = [...new Set(givers)]
  if (g.some(pk => !HEX64.test(pk))) throw new Error('A giver is not a public key.')
  if (g.includes(agent)) throw new Error('An agent does not give itself work.')
  const r = [...new Set(rooms.map(room => String(room).toLowerCase()))]
  if (r.some(room => !ROOM.test(room))) throw new Error('A room is not a Buzz room id.')
  const shown = profileTags({ displayName, about })
  const j = join === undefined ? [] : joinTags(join)
  return { kind: SETUP_KIND, created_at: now, content: '', tags: [['d', requestD(n, 'add_agent')], ['op', 'add_agent'], ['p', agent],
    ['harness', harness], ['like', like], ...g.map(pk => ['giver', pk]), ...r.map(room => ['room', room]), ...shown, ...j] }
}

// bind_runtime: the channel key the install line made on the agent's box. Public half only.
export function draftBind({ name, agent, harness, like, channelKey, now = Math.floor(Date.now() / 1000) }) {
  const n = common({ name, agent, harness, like })
  if (harness === 'codex') throw new Error('A Codex agent needs a second key for its wake feed, and this request carries only one. Step 4 cannot bind it yet.')
  const line = String(channelKey || '').trim()
  if (/PRIVATE KEY|nsec1|bunker:|nostrconnect:/i.test(line)) throw new Error('That is private. Paste only the line that starts ssh-ed25519.')
  const m = SSH_PUBLIC.exec(line)
  if (!m || line.includes('\n')) throw new Error('Paste the one line the install printed, starting ssh-ed25519.')
  return { kind: SETUP_KIND, created_at: now, content: '', tags: [['d', requestD(n, 'bind_runtime')], ['op', 'bind_runtime'], ['p', agent],
    ['harness', harness], ['like', like], ['channel_key', `${m[1]} ${m[2]}`]] }
}

// Sign, check it is the request drafted and by the owner the page read as, then publish.
export async function sendRequest(template, { sign, owner, verify, connect, relays, timeoutMs, onStep = () => {} }) {
  onStep('waiting for your signer')
  const signed = await sign(template)
  let valid = false
  try { valid = verify(signed) } catch {}
  if (!valid || !sameAsDrafted(signed, template)) throw new Error('The signer returned an event that is not the one shown. Nothing was published.')
  if (signed.pubkey !== owner) throw new Error('Your signer signed with a different key from the one this page read the hive as. Nothing was published.')
  onStep('publishing')
  const published = await publishTo(signed, { relays, connect, timeoutMs })
  const accepted = published.filter(p => p.outcome === 'accepted')
  if (!accepted.length) throw new Error('No relay accepted the request. Nothing was sent to the fleet.')
  return { signed, accepted: accepted.length, text: `Sent. ${accepted.length} of ${relays.length} relays have it (${accepted.map(p => relayHost(p.url)).join(', ')}).` }
}

// The cold read-back counts only the very event that was sent, signed by the owner, with a valid signature.
export function readBack(events, signed, { owner, verify }) {
  return events.some(e => {
    if (e?.id !== signed.id || e.pubkey !== owner || e.kind !== SETUP_KIND) return false
    try { return verify(e) === true } catch { return false }
  })
}
