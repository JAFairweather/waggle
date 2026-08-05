import { finalizeEvent, generateSecretKey, getEventHash, nip44, verifyEvent } from 'nostr-tools'

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
  const seal = await signer.signEvent(sealDraft)
  if (!seal || typeof seal !== 'object' || Array.isArray(seal) || !verifyEvent(seal) || seal.pubkey !== owner || seal.kind !== sealDraft.kind ||
      seal.created_at !== sealDraft.created_at || seal.content !== sealDraft.content ||
      JSON.stringify(seal.tags) !== JSON.stringify(sealDraft.tags)) throw new Error('The signer returned an invalid or altered route seal.')
  const wrapKey = generateSecretKey()
  return finalizeEvent({ kind:1059, created_at:fuzzed(), tags:[['p',bridge]],
    content:nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wrapKey, bridge)) }, wrapKey)
}
