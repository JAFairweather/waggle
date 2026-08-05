import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../src/buzz_policy_core.mjs'
import { submitSignedBuzzEvent } from '../src/buzz_policy_submit.mjs'

let fails = 0
const t = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} — ${name}`); if (!ok) fails++ }
const rejects = async (name, fn, pattern) => { try { await fn(); t(name, false) } catch (e) { t(name, pattern.test(e.message)) } }
const sk = generateSecretKey(), endpoint = 'https://hive.example/events', now = 2_000_000_000
const event = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: now, content: 'derived', tags: [['h', 'a8186b53-537d-46ad-a7e7-b6486c58970e'], ['auth', 'a'.repeat(64), '', 'b'.repeat(128)]] }, sk)))
const body = canonicalJson(event), auth = JSON.parse(JSON.stringify(finalizeEvent({ kind: 27235, created_at: now, content: '', tags: [
  ['u', endpoint], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')], ['nonce', 'nonce_0123456789'],
] }, sk)))
const response = (status, value) => ({ status, body: null, text: async () => typeof value === 'string' ? value : JSON.stringify(value) })
let call
const accepted = await submitSignedBuzzEvent({ endpoint, event, authorization: auth, fetchImpl: async (url, options) => {
  call = { url, options }; return response(200, { event_id: event.id, accepted: true, message: '' })
} })
t('an authoritative matching 200 is accepted', accepted.status === 'accepted' && accepted.event_id === event.id)
t('submission pins exact body, NIP-98, NIP-OA header, and forbids redirects', call.options.body === body && call.options.redirect === 'error' && call.options.headers.authorization.startsWith('Nostr ') && call.options.headers['x-auth-tag'] === canonicalJson(event.tags[1]))
const duplicate = await submitSignedBuzzEvent({ endpoint, event, authorization: auth, fetchImpl: async () => response(200, { event_id: event.id, accepted: true, message: 'duplicate:' }) })
t('the same stored event reported as duplicate remains accepted', duplicate.status === 'accepted')
const mismatch = await submitSignedBuzzEvent({ endpoint, event, authorization: auth, fetchImpl: async () => response(200, { event_id: 'f'.repeat(64), accepted: true, message: '' }) })
t('a mismatched success body is ambiguous, never success', mismatch.status === 'ambiguous' && !mismatch.retryable)
const refused = await submitSignedBuzzEvent({ endpoint, event, authorization: auth, fetchImpl: async () => response(403, { error: 'forbidden' }) })
t('an authoritative non-rate-limit 4xx is terminal refusal', refused.status === 'refused')
const held = await submitSignedBuzzEvent({ endpoint, event, authorization: auth, fetchImpl: async () => response(429, { error: 'rate-limited: pre-ingest' }) })
t('429 holds the same event for fresh-auth retry', held.status === 'held' && held.retryable)
const network = await submitSignedBuzzEvent({ endpoint, event, authorization: auth, fetchImpl: async () => { throw new Error('socket closed') } })
t('a network loss is ambiguous and cannot authorize re-signing', network.status === 'ambiguous' && !network.retryable)
await rejects('authorization for another payload is refused before fetch', () => submitSignedBuzzEvent({ endpoint, event, authorization: finalizeEvent({ kind: 27235, created_at: now, content: '', tags: [['u', endpoint], ['method', 'POST'], ['payload', '0'.repeat(64)], ['nonce', 'nonce_0123456789']] }, sk), fetchImpl: async () => response(200, {}) }), /exact request/)
await rejects('another signing identity cannot supply HTTP authorization', () => submitSignedBuzzEvent({ endpoint, event, authorization: finalizeEvent({ kind: 27235, created_at: now, content: '', tags: [['u', endpoint], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')], ['nonce', 'nonce_0123456789']] }, generateSecretKey()) }), /does not match/)
const oversized = await submitSignedBuzzEvent({ endpoint, event, authorization: auth, fetchImpl: async () => response(200, 'x'.repeat(64 * 1024 + 1)) })
t('oversized response data fails closed as ambiguous', oversized.status === 'ambiguous' && !oversized.retryable)
t('the fixture signer is the submitted identity', event.pubkey === getPublicKey(sk))

console.log(fails ? `\nbuzz_policy_submit: ${fails} FAILED` : '\nbuzz_policy_submit: all checks passed')
process.exit(fails ? 1 : 0)
