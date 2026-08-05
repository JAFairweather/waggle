import { finalizeEvent, generateSecretKey, getEventHash, nip44, verifyEvent } from 'nostr-tools'

const SIGNED_EVENT_KEYS = ['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags']
function exactRouteSeal(seal, draft, owner) {
  if (!seal || typeof seal !== 'object' || Array.isArray(seal))
    throw new Error('The signer returned no signed route event.')
  const keys = Object.keys(seal).sort()
  if (JSON.stringify(keys) !== JSON.stringify(SIGNED_EVENT_KEYS))
    throw new Error(`The signer changed the route seal schema (received: ${keys.join(', ') || 'no fields'}).`)
  let valid = false
  try { valid = verifyEvent(JSON.parse(JSON.stringify(seal))) } catch { /* bounded below */ }
  if (!valid) throw new Error('The signer returned an invalid route-seal signature.')
  if (seal.pubkey !== owner) throw new Error('The signer used a different identity for the route seal.')
  if (seal.kind !== draft.kind) throw new Error('The signer changed the route-seal kind.')
  if (seal.created_at !== draft.created_at) throw new Error('The signer changed the route-seal timestamp.')
  if (seal.content !== draft.content) throw new Error('The signer changed the encrypted route command.')
  if (JSON.stringify(seal.tags) !== JSON.stringify(draft.tags)) throw new Error('The signer changed the route-seal tags.')
  return seal
}

// Build the only route-control wire artifact: a signed owner seal inside an ephemeral gift wrap.
// The returned event exposes only kind 1059 and the bridge p-tag. Every route field is encrypted.
export async function sealedTaskRouteCommand(signer, bridge, body, now = Math.floor(Date.now() / 1000)) {
  if (typeof signer?.getPublicKey !== 'function' || typeof signer?.signEvent !== 'function' ||
      typeof signer?.nip44Encrypt !== 'function') throw new Error('This signer cannot sign and encrypt NIP-44 messages.')
  if (!/^[0-9a-f]{64}$/.test(String(bridge || '').toLowerCase())) throw new Error('The bridge identity is invalid.')
  const owner = String(await signer.getPublicKey()).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(owner)) throw new Error('The signing identity is invalid.')
  const fuzzed = () => now - Math.floor(Math.random() * 172800)
  const rumor = { kind:14, pubkey:owner, created_at:now, tags:[['p',bridge]], content:JSON.stringify(body) }
  rumor.id = getEventHash(rumor)
  const encrypted = await signer.nip44Encrypt(bridge, JSON.stringify(rumor))
  const sealDraft = { kind:13, created_at:fuzzed(), tags:[], content:encrypted }
  const seal = exactRouteSeal(await signer.signEvent(sealDraft), sealDraft, owner)
  const wrapKey = generateSecretKey()
  return finalizeEvent({ kind:1059, created_at:fuzzed(), tags:[['p',bridge]],
    content:nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wrapKey, bridge)) }, wrapKey)
}
