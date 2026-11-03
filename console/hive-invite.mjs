// hive-invite.mjs — how a new agent joins the hive, from the Add an agent panel (#683, nvoy #291).
//
// On the fleet, the agent claims a single-use invite with its own key. The page mints that invite
// with the owner's key, seals it to the agent's key with the owner's signer (NIP-44), and puts only
// the sealed text in the signed add_agent request. The code is never shown, stored or logged: it is
// held here between the mint and the seal, and dropped.
//
// The terms are read as the agent's own step reads them (nvoy-onboard readTerms), because the agent
// claims only while the hive serves the version the owner agreed to. Unreadable is "can't tell",
// never "none". Agreeing and confirming age are the owner's ticks, passed exactly as ticked.

import { mintInvite, reachFailure } from './admission-client.mjs'
import { expectedUrl } from './nip98.mjs'
import { sealedShape } from './hive-add-agent.mjs'

// The relay the fleet's agents log in to (each instance manifest's buzz.relay).
export const HIVE_RELAY = 'wss://nave.communities.buzz.xyz'
// As long as nvoy-onboard keeps a request alive: a request older than 7 days is signed again.
export const INVITE_TTL_SECS = 7 * 24 * 3600
const HEX64 = /^[0-9a-f]{64}$/

// One /api/join-policy answer, read by the same rules as the agent's step.
export function termsFromRead({ status, json } = {}) {
  if (status !== 200) return { ok: false, reason: `HTTP ${status}` }
  if (json === undefined) return { ok: false, reason: 'not JSON' }
  if (!json || typeof json !== 'object' || !('policy' in json)) return { ok: false, reason: 'no policy field' }
  if (json.policy == null) return { ok: true, version: 'none', age: false, text: '' }
  // A policy with no version could not be agreed to: the agent would send "undefined" as the version.
  if (json.policy.version == null) return { ok: false, reason: 'the terms carry no version' }
  return { ok: true, version: String(json.policy.version), age: json.policy.age_attestation_required === true,
    text: typeof json.policy.terms_markdown === 'string' ? json.policy.terms_markdown : '' }
}

export async function readHiveTerms({ relayUrl, fetchImpl = globalThis.fetch }) {
  let res
  try { res = await fetchImpl(expectedUrl(relayUrl, '/api/join-policy'), { method: 'GET', headers: { accept: 'application/json' } }) }
  catch (e) { return { ok: false, reason: reachFailure(relayUrl, e) } }
  let json
  try { json = await res.json() } catch { json = undefined }
  return termsFromRead({ status: res.status, json })
}

// What must be true before anything is minted. Never ticks a box on the owner's behalf.
export function joinGate(terms, { agreed = false, ageConfirmed = false } = {}) {
  if (!terms?.ok) return { ok: false, reason: `Can't read the hive's terms (${terms?.reason || 'not read'}). Nothing was made; read them again.` }
  if (terms.version !== 'none' && agreed !== true) return { ok: false, reason: 'Tick that you agree to the hive\'s terms. That is yours to tick; the page never does.' }
  if (terms.age && ageConfirmed !== true) return { ok: false, reason: 'The hive\'s terms ask you to confirm the age requirement. Tick it only if it is true.' }
  return { ok: true }
}

const scrub = (text, code) => String(text || '').split(code).join('[invite]')

// Mint, then seal. Returns the join tags' values for draftAddAgent; the code itself never leaves.
export async function sealInvite({ relayUrl, agent, terms, agreed, ageConfirmed, signer, sign, mint = mintInvite, fetchImpl, now, onStep = () => {} }) {
  const gate = joinGate(terms, { agreed, ageConfirmed })
  if (!gate.ok) throw new Error(gate.reason)
  if (!HEX64.test(agent || '')) throw new Error('That is not the agent\'s public key.')
  if (typeof signer?.nip44Encrypt !== 'function') throw new Error('This signer cannot seal (NIP-44). Sign in with your Bunker. Nothing was made.')
  onStep('making a single-use invite')
  const minted = await mint({ relayUrl, sign, ttlSecs: INVITE_TTL_SECS, maxUses: 1, fetchImpl, now })
  if (!minted?.ok) throw new Error(`The hive did not make an invite: ${minted?.reason || 'no answer'}`)
  const code = String(minted.code)
  onStep('sealing it to the agent\'s key')
  const unused = 'The unused invite expires by itself in 7 days.'
  let invite = ''
  try { invite = await signer.nip44Encrypt(agent, code) }
  catch (e) { throw new Error(`Your Bunker did not seal the invite (${scrub(e?.message || e, code)}). Allow encrypt for this page in your Bunker, then sign again. ${unused}`) }
  if (!sealedShape(invite) || invite.includes(code)) throw new Error(`Your Bunker returned something that is not a sealed message. Nothing was sent. ${unused}`)
  return { invite, policy: terms.version, ...(ageConfirmed === true ? { age: 'confirmed' } : {}) }
}
