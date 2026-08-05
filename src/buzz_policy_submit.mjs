// Bounded direct submission for the off-box Buzz policy service. This module
// submits one already-signed event; it never signs or renders. Ambiguous outcomes
// are explicit so callers can query/retry the same event rather than author another.
import { createHash } from 'node:crypto'
import { verifyEvent } from 'nostr-tools/pure'
import { canonicalJson } from './buzz_policy_core.mjs'

const MAX_RESPONSE_BYTES = 64 * 1024
const fail = message => { throw new Error(`buzz-policy-submit: ${message}`) }
const wireEvent = (event, kind, label) => {
  if (!event || Object.keys(event).sort().join(',') !== 'content,created_at,id,kind,pubkey,sig,tags' || event.kind !== kind) fail(`${label} is not an exact kind:${kind} wire event`)
  let valid = false; try { valid = verifyEvent(JSON.parse(JSON.stringify(event))) } catch { valid = false }
  if (!valid) fail(`${label} signature or id is invalid`)
  return event
}
const oneTag = (event, name) => {
  const tags = event.tags.filter(tag => tag[0] === name)
  if (tags.length !== 1) fail(`NIP-98 requires exactly one ${name} tag`)
  return tags[0]
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function boundedBody(response) {
  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) fail('response exceeds 65536 bytes')
    return text
  }
  const reader = response.body.getReader(); const chunks = []; let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) { try { await reader.cancel() } catch {} fail('response exceeds 65536 bytes') }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function submitSignedBuzzEvent({ endpoint, event, authorization, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  wireEvent(event, 9, 'Buzz event'); wireEvent(authorization, 27235, 'NIP-98 authorization')
  if (authorization.pubkey !== event.pubkey) fail('NIP-98 signer does not match Buzz event signer')
  let url; try { url = new URL(String(endpoint || '')) } catch { fail('endpoint is invalid') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/events')) fail('endpoint must be a fixed HTTPS /events URL')
  const body = canonicalJson(event), expectedPayload = digest(body)
  if (oneTag(authorization, 'u')[1] !== url.toString() || oneTag(authorization, 'method')[1] !== 'POST' ||
      oneTag(authorization, 'payload')[1] !== expectedPayload || !/^[A-Za-z0-9_-]{16,128}$/.test(oneTag(authorization, 'nonce')[1] || '')) fail('NIP-98 authorization does not bind this exact request')
  const authTags = event.tags.filter(tag => tag[0] === 'auth')
  if (authTags.length !== 1) fail('Buzz event requires exactly one policy-owned NIP-OA auth tag')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) fail('timeoutMs must be 1000..60000')
  const controller = new globalThis.AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs)
  let response, text
  try {
    response = await fetchImpl(url.toString(), { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json',
        authorization: `Nostr ${Buffer.from(canonicalJson(authorization)).toString('base64')}`,
        'x-auth-tag': canonicalJson(authTags[0]) }, body })
    text = await boundedBody(response)
  } catch (error) {
    return Object.freeze({ status: 'ambiguous', retryable: false, event_id: event.id, response_digest: digest(String(error?.name || 'network-error')) })
  } finally { clearTimeout(timer) }
  const responseDigest = digest(text)
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = null }
  if (response.status === 200 && parsed && Object.keys(parsed).sort().join(',') === 'accepted,event_id,message' &&
      parsed.accepted === true && parsed.event_id === event.id && typeof parsed.message === 'string') {
    return Object.freeze({ status: 'accepted', retryable: false, event_id: event.id, response_digest: responseDigest })
  }
  // A syntactically authoritative 4xx means the relay says the exact event was refused.
  // 429 is excluded: admission/rate limiting happens before body parse and is retryable
  // with the same event plus a fresh NIP-98 authorization.
  if (response.status >= 400 && response.status < 500 && response.status !== 429 && parsed && typeof parsed === 'object') {
    return Object.freeze({ status: 'refused', retryable: false, event_id: event.id, response_digest: responseDigest })
  }
  if (response.status === 429) return Object.freeze({ status: 'held', retryable: true, event_id: event.id, response_digest: responseDigest })
  return Object.freeze({ status: 'ambiguous', retryable: false, event_id: event.id, response_digest: responseDigest })
}
