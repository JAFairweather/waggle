// Typed channel carry: Waggle preserves the complete original kind:9 signature and adds only its
// own carrier attestation. Nvoy can therefore authorize the original signer without treating the
// bridge as the instructor.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'

const dir = mkdtempSync(resolve(tmpdir(), 'wb-task-carry-'))
const bridgeSk = generateSecretKey(), bridge = getPublicKey(bridgeSk)
const participantSk = generateSecretKey(), participant = getPublicKey(participantSk)
const authorSk = generateSecretKey(), author = getPublicKey(authorSk)
const channel = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
writeFileSync(resolve(dir, 'config.json'), JSON.stringify({ relays: [], recipients: [], public: {
  relays: ['wss://example.invalid'], inbox: channel, staging_inbox: channel,
  watch_authors: [], watch_events: [], approvers: [], grantors: [],
  task_routes: [{ participant, sender: author, channel, mention: 'codex', protocol: 'nvoy-task-carry-v1' }],
} }))
process.env.CONFIG_PATH = resolve(dir, 'config.json')
process.env.SEND_JOURNAL_PATH = resolve(dir, 'send-journal.log')
process.env.SEEN_PATH = resolve(dir, 'seen.log')
process.env.POSTED_MAP_PATH = resolve(dir, 'posted.log')
process.env.RLSEEN_PATH = resolve(dir, 'rlseen.log')
process.env.RLPENDING_PATH = resolve(dir, 'pending.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.FORWARD_MODE = 'buzz'; process.env.WB_NO_BOOT = '1'

const { scanReturnLane, sourceWireRejectReason, PUB, grantSet } = await import('../src/bridge.mjs')
grantSet.set(participant, { grantId: '1'.repeat(64), grantor: author })
let pass = 0, fail = 0
const ok = (name, value) => { console.log(`${value ? 'ok  ' : 'FAIL'} — ${name}`); value ? pass++ : fail++ }
const source = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 1785870000,
  tags: [['h', 'private-signed-channel-address'], ['p', participant]], content: 'Codex, please inspect this.' }, authorSk)))
const wraps = []
await scanReturnLane([source], { authors: PUB.scanAuthors, channel, publish: async wrap => { wraps.push(wrap); return 2 } })
ok('the opt-in recipient receives one sealed typed carry', wraps.length === 1 && wraps[0].kind === 1059)
const seal = JSON.parse(nip44.decrypt(wraps[0].content, nip44.getConversationKey(participantSk, wraps[0].pubkey)))
const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(participantSk, seal.pubkey)))
const carry = JSON.parse(rumor.content)
ok('the carrier seal is signed by Waggle while the rumor remains addressed to the participant', verifyEvent(JSON.parse(JSON.stringify(seal))) && seal.pubkey === bridge && rumor.tags[0][1] === participant)
ok('the encrypted body uses the closed channel-task-carry schema', carry.v === 1 && carry.type === 'waggle-channel-task-carry' && carry.channel === channel && carry.reason === 'mention')
ok('the complete source wire event survives field-for-field',
  ['id', 'pubkey', 'created_at', 'kind', 'content', 'sig'].every(key => carry.source[key] === source[key]) &&
  JSON.stringify(carry.source.tags) === JSON.stringify(source.tags) && verifyEvent(JSON.parse(JSON.stringify(carry.source))))
ok('the original signer—not Waggle—remains independently provable', carry.source.pubkey === author && carry.source.pubkey !== bridge)
ok('source diagnostics disclose only field shape, never signed values',
  sourceWireRejectReason({ ...source, sig: undefined }) === 'sig:undefined:0' &&
  sourceWireRejectReason({ ...source, content: 7 }) === 'content:number' &&
  sourceWireRejectReason({ ...source, content: source.content + ' tampered' }) === 'signature-or-id-mismatch')

const second = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 1785870002,
  tags: [['p', participant]], content: 'another signed source' }, authorSk)))
second.content += ' tampered'
await scanReturnLane([second], { authors: PUB.scanAuthors, channel, publish: async wrap => { wraps.push(wrap); return 2 } })
ok('a tampered source is dropped before Waggle attests or publishes it', wraps.length === 1)
await scanReturnLane([JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 1785870003,
  tags: [['p', participant]], content: 'wrong channel assertion' }, authorSk)))],
{ authors: PUB.scanAuthors, channel: 'not-a-channel', publish: async wrap => { wraps.push(wrap); return 2 } })
ok('an unresolved/non-UUID source channel is refused', wraps.length === 1)

const otherSk = generateSecretKey(), other = getPublicKey(otherSk)
const wrongSender = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 1785870004,
  tags: [['p', participant]], content: 'right mention, wrong authorized sender' }, otherSk)))
await scanReturnLane([wrongSender], { authors: [author, other], channel, publish: async wrap => { wraps.push(wrap); return 2 } })
ok('a managed route binds its original signer even when the global scan gate contains that signer for another route', wraps.length === 1)
const wrongChannel = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 1785870005,
  tags: [['p', participant]], content: 'right sender, wrong channel' }, authorSk)))
await scanReturnLane([wrongChannel], { authors: [author], channel: '99999999-9999-4999-8999-999999999999', publish: async wrap => { wraps.push(wrap); return 2 } })
ok('a managed route binds its source channel instead of inheriting the global channel union', wraps.length === 1)
grantSet.delete(participant)
const revoked = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 1785870006,
  tags: [['p', participant]], content: 'admission revoked' }, authorSk)))
await scanReturnLane([revoked], { authors: [author], channel, publish: async wrap => { wraps.push(wrap); return 2 } })
ok('revoking participant admission removes a saved managed route from active fan-out', wraps.length === 1)

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
