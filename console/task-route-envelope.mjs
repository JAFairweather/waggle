import { finalizeEvent, generateSecretKey, getEventHash, nip44, verifyEvent } from 'nostr-tools'

const SIGNED_EVENT_KEYS = ['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags']
const wire = value => JSON.parse(JSON.stringify(value))

function exactSeal(signed, draft, owner) {
  let seal
  try { seal = wire(signed) } catch { throw new Error('The signer did not return a Nostr event.') }
  if (!seal || typeof seal !== 'object' || Array.isArray(seal)) throw new Error('The signer did not return a Nostr event.')
  if (JSON.stringify(Object.keys(seal).sort()) !== JSON.stringify(SIGNED_EVENT_KEYS)) throw new Error('The signer added unsupported fields to the route seal.')
  if (!verifyEvent(seal)) throw new Error('The signer returned a route seal with an invalid signature.')
  if (seal.pubkey !== owner) throw new Error(`The signer switched identities while signing (expected ${owner.slice(0, 12)}…, received ${String(seal.pubkey).slice(0, 12)}…).`)
  if (seal.kind !== draft.kind || seal.created_at !== draft.created_at || seal.content !== draft.content ||
      JSON.stringify(seal.tags) !== JSON.stringify(draft.tags)) throw new Error('The signer altered the encrypted route seal before signing it.')
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
  const seal = exactSeal(await signer.signEvent(wire(sealDraft)), sealDraft, owner)
  const wrapKey = generateSecretKey()
  return finalizeEvent({ kind:1059, created_at:fuzzed(), tags:[['p',bridge]],
    content:nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wrapKey, bridge)) }, wrapKey)
}
