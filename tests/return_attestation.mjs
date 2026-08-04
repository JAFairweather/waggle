import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'

const bridgeSk = generateSecretKey(), bridgePk = getPublicKey(bridgeSk)
const recipientSk = generateSecretKey(), recipientPk = getPublicKey(recipientSk)
const authorSk = generateSecretKey()
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
const { sealAndWrap } = await import('../src/nostr_egress.mjs')

const source = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 1234,
  tags: [['h', 'a8186b53-537d-46ad-a7e7-b6486c58970e']], content: 'original signed words' }, authorSk)))
let captured
const sent = await sealAndWrap({ template: 'return_carry', to: recipientPk,
  slots: { mention: 'codex', why: 'mention', body: source.content }, sourceEvent: source },
async wrap => { captured = wrap; return 1 })
assert.equal(sent.accepted, 1)
const seal = JSON.parse(nip44.decrypt(captured.content, nip44.getConversationKey(recipientSk, captured.pubkey)))
const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(recipientSk, seal.pubkey)))
assert.equal(seal.pubkey, bridgePk)
const tag = rumor.tags.find(t => t[0] === 'waggle-source')
assert.ok(tag, 'encrypted rumor carries source attestation')
const recovered = JSON.parse(Buffer.from(tag[1], 'base64url').toString('utf8'))
assert.deepEqual(recovered, source)
assert.equal(verifyEvent(recovered), true)

await assert.rejects(() => sealAndWrap({ template: 'return_carry', to: recipientPk,
  slots: { mention: 'codex', why: 'mention', body: 'forged' }, sourceEvent: { ...source, content: 'forged' } }, async () => 1),
/valid signed kind:9/, 'a forged source cannot leave the egress chokepoint')
await assert.rejects(() => sealAndWrap({ template: 'relay_ack_ok', to: recipientPk,
  slots: { channel: 'x', buzzEventId: null, ts: 1 }, sourceEvent: source }, async () => 1),
/only for return_carry/, 'source attestations cannot be attached to another template')

console.log('return_attestation: original signer survives encrypted bridge transport PASS')
