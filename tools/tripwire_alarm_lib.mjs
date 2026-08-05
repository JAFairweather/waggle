// NIP-17 alarm construction for the out-of-process tripwire. The caller supplies a dedicated
// signer capability (preferably Bunker-backed); the identity nsec is not required here.
import { finalizeEvent, generateSecretKey, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'

const HEX64 = /^[0-9a-f]{64}$/
const exact = value => JSON.parse(JSON.stringify(value))
const SIGNED_EVENT_KEYS = ['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags']

function verifyExactSeal(signed, draft, signerPubkey) {
  const event = exact(signed)
  const keys = Object.keys(event).sort()
  if (JSON.stringify(keys) !== JSON.stringify(SIGNED_EVENT_KEYS) ||
      !verifyEvent(event) || event.pubkey !== signerPubkey || event.kind !== draft.kind ||
      event.created_at !== draft.created_at || event.content !== draft.content ||
      JSON.stringify(event.tags) !== JSON.stringify(draft.tags)) {
    throw new Error('tripwire-alarm: signer changed the sealed alarm event')
  }
  return event
}

export async function buildTripwireAlarmWrap(text, recipient, signer, {
  now = () => Math.floor(Date.now() / 1000),
  backdated = () => Math.floor(Date.now() / 1000 - Math.random() * 172800),
  wrapperSecret = generateSecretKey,
} = {}) {
  const to = String(recipient || '').toLowerCase()
  if (!HEX64.test(to)) throw new Error('tripwire-alarm: recipient is not a 64-hex pubkey')
  if (!signer || !HEX64.test(String(signer.pubkey || '')) || typeof signer.signEvent !== 'function' ||
      typeof signer.nip44Encrypt !== 'function') throw new Error('tripwire-alarm: dedicated signer is unavailable')
  const content = String(text || '')
  if (!content || Buffer.byteLength(content) > 4096) throw new Error('tripwire-alarm: message is empty or oversized')
  const createdAt = now(), sealAt = backdated(), wrapAt = backdated()
  if (![createdAt, sealAt, wrapAt].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('tripwire-alarm: timestamp is invalid')

  const rumor = { kind: 14, pubkey: signer.pubkey, created_at: createdAt, tags: [['p', to]], content }
  const sealDraft = { kind: 13, created_at: sealAt, tags: [], content: await signer.nip44Encrypt(to, JSON.stringify(rumor)) }
  const seal = verifyExactSeal(await signer.signEvent(exact(sealDraft)), sealDraft, signer.pubkey)
  const wsk = wrapperSecret()
  if (!(wsk instanceof Uint8Array) || wsk.length !== 32) throw new Error('tripwire-alarm: wrapper key is invalid')
  return finalizeEvent({ kind: 1059, created_at: wrapAt, tags: [['p', to]],
    content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wsk, to)) }, wsk)
}
