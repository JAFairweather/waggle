// Typed channel carry: Waggle preserves the complete original kind:9 signature and adds only its
// own carrier attestation. Nvoy can therefore authorize the original signer without treating the
// bridge as the instructor.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
process.env.RLREACTION_PATH = resolve(dir, 'reactions.log')
process.env.RLREACTIONSEEN_PATH = resolve(dir, 'reactions-seen.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.BUZZ_EVENT_ENDPOINT = 'https://hive.example/events'
process.env.FORWARD_MODE = 'buzz'; process.env.WB_NO_BOOT = '1'

const { scanReturnLane, sourceWireRejectReason, PUB, grantSet, rlPending, retryPendingCarries, rlReactionPending, rlReactionSeen, retryPendingReactions, rlKey, dropRlSeen } = await import('../src/bridge.mjs')
const { submitRelayActionReaction } = await import('../src/nostr_egress.mjs')
grantSet.set(participant, { grantId: '1'.repeat(64), grantor: author })
let pass = 0, fail = 0
const ok = (name, value) => { console.log(`${value ? 'ok  ' : 'FAIL'} — ${name}`); value ? pass++ : fail++ }
const source = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 1785870000,
  tags: [['h', 'private-signed-channel-address'], ['p', participant]], content: 'Codex, please inspect this.' }, authorSk)))
const wraps = []
const reactions = []
let journalWasReadyAtSubmit = false
const reactionOk = event => {
  reactions.push(event)
  journalWasReadyAtSubmit = readFileSync(process.env.SEND_JOURNAL_PATH, 'utf8').includes(event.id)
  return event.id
}
await scanReturnLane([source], { authors: PUB.scanAuthors, channel, publish: async wrap => { wraps.push(wrap); return 2 }, react: reactionOk })
ok('the opt-in recipient receives one sealed typed carry', wraps.length === 1 && wraps[0].kind === 1059)
ok('a landed relay action reacts once to the exact originating Buzz event', reactions.length === 1 && reactions[0].kind === 7 && reactions[0].content === '👍' && reactions[0].tags.some(t => t[0] === 'e' && t[1] === source.id))
ok('the exact reaction id is durably tripwire-journaled before submission starts', journalWasReadyAtSubmit)
ok('the bridge-authored kind:7 is recorded in the tripwire send journal',
  readFileSync(process.env.SEND_JOURNAL_PATH, 'utf8').split('\n').some(line => { try { const row = JSON.parse(line); return row.kind === 7 && row.lane === 'return-reaction' && row.source === source.id } catch { return false } }))
let submittedBody = '', submittedAuth = '', submittedUrl = ''
const exactSubmitted = await submitRelayActionReaction(reactions[0], async (url, request) => {
  submittedUrl = String(url)
  submittedBody = request.body
  submittedAuth = request.headers.authorization
  return { ok: true, status: 200, text: async () => JSON.stringify({ event_id: reactions[0].id, accepted: true, message: 'stored' }) }
})
ok('the writer submits the byte-identical prepared event with exact-body NIP-98 authorization',
  exactSubmitted === reactions[0].id && submittedUrl === 'https://hive.example/events' &&
  submittedBody === JSON.stringify(reactions[0]) && submittedAuth.startsWith('Nostr '))
let alteredPreparedRejected = false
try { await submitRelayActionReaction({ ...reactions[0], content: '❤️' }, async () => { throw new Error('must not submit') }) } catch { alteredPreparedRejected = true }
ok('the exact-event submitter refuses altered prepared bytes before network access', alteredPreparedRejected)
await scanReturnLane([source], { authors: PUB.scanAuthors, channel, publish: async wrap => { wraps.push(wrap); return 2 }, react: reactionOk })
ok('durable carry dedup also prevents a duplicate confirmation reaction', reactions.length === 1)
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
const reactionRetry = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 1785870006,
  tags: [['p', participant]], content: 'reaction retry' }, authorSk)))
let failedPrepared
await scanReturnLane([reactionRetry], { authors: [author], channel, publish: async wrap => { wraps.push(wrap); return 2 }, react: async event => { failedPrepared = JSON.stringify(event); throw new Error('temporary Buzz outage') } })
ok('a failed confirmation does not undo or repeat the landed sealed carry', wraps.length === 2 && rlReactionPending.has(reactionRetry.id))
const retried = []
const realFetch = globalThis.fetch
globalThis.fetch = async (_url, request) => {
  const event = JSON.parse(request.body)
  retried.push(event)
  return { ok: true, status: 200, text: async () => JSON.stringify({ event_id: event.id, accepted: true, message: 'stored' }) }
}
try { await retryPendingReactions() } finally { globalThis.fetch = realFetch }
ok('a failed confirmation retries independently and clears only after success', retried.length === 1 && retried[0].tags.some(t => t[0] === 'e' && t[1] === reactionRetry.id) && !rlReactionPending.has(reactionRetry.id))
ok('the production retry path submits the byte-identical prepared event instead of re-signing', JSON.stringify(retried[0]) === failedPrepared)

// Review regression: simulate process death at the only dangerous boundary. The reaction debt
// must already be durable while the source×recipient carry completion is still absent.
const crashSource = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 1785870007,
  tags: [['p', participant]], content: 'crash ordering' }, authorSk)))
const crashKey = rlKey(crashSource.id, participant)
let crashed = false
try {
  await scanReturnLane([crashSource], { authors: [author], channel, publish: async wrap => { wraps.push(wrap); return 2 },
    react: async () => {}, afterReactionOwed: () => { throw new Error('simulated process exit') } })
} catch (e) { crashed = e.message === 'simulated process exit' }
ok('a crash after accepted carry cannot lose its reaction obligation', crashed && rlReactionPending.has(crashSource.id))
ok('reaction debt commits before carry completion, so restart may safely recover',
  !rlReactionSeen.has(crashSource.id) && !readFileSync(process.env.RLSEEN_PATH, 'utf8').includes(crashKey) &&
  readFileSync(process.env.RLREACTION_PATH, 'utf8').includes(crashSource.id))
dropRlSeen(crashKey) // simulated restart discards the pre-commit in-memory claim
await retryPendingReactions(async event => event.id)

// Review regression: recipient A lands now, recipient B is queued and lands later. Completion is
// source-level, so B's carry retry must not create a second reaction for the same channel message.
const participant2Sk = generateSecretKey(), participant2 = getPublicKey(participant2Sk)
PUB.returnLane.push({ ...PUB.returnLane[0], npub_hex: participant2 })
grantSet.set(participant2, { grantId: '2'.repeat(64), grantor: author })
const partial = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 1785870008,
  tags: [['p', participant], ['p', participant2]], content: 'partial fanout' }, authorSk)))
let fanoutAttempt = 0
const partialReactions = []
await scanReturnLane([partial], { authors: [author], channel,
  publish: async wrap => { wraps.push(wrap); return fanoutAttempt++ === 0 ? 2 : 0 },
  react: async event => { partialReactions.push(event); return event.id } })
ok('partial fanout reacts once when its first recipient lands', partialReactions.length === 1 && rlReactionSeen.has(partial.id) && rlPending.size() === 1)
await retryPendingCarries({ publish: async wrap => { wraps.push(wrap); return 2 }, react: async event => { partialReactions.push(event); return event.id } })
ok('a later recipient retry cannot react to an already-confirmed source again', partialReactions.length === 1 && rlPending.size() === 0)
grantSet.delete(participant2)
PUB.returnLane.pop()
grantSet.delete(participant)
const wrapsBeforeRevoked = wraps.length
const revoked = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 1785870006,
  tags: [['p', participant]], content: 'admission revoked' }, authorSk)))
await scanReturnLane([revoked], { authors: [author], channel, publish: async wrap => { wraps.push(wrap); return 2 } })
ok('revoking participant admission removes a saved managed route from active fan-out', wraps.length === wrapsBeforeRevoked)

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
