// #357 — the NIP-98 envelope Buzz's HTTP API expects.
//
// The contract is not ours; it is `buzz-auth/src/nip98.rs`, and a mistake in it is invisible from
// here — the relay answers 401 with a message the operator reads as "my key is wrong". So every
// rule that verifier enforces is asserted against the built event, and the payload rule is
// asserted in BOTH directions: the hash matches the exact body, and it stops matching when the
// body changes by one character. A test that only proved "a payload tag is present" could not tell
// a correct hash from a constant.
//
//   node tests/nip98_auth.mjs

import { createHash } from 'node:crypto'
import { generateSecretKey, getPublicKey, verifyEvent, finalizeEvent } from 'nostr-tools/pure'
import { nip98Template, nip98Header, expectedUrl } from '../src/nip98.mjs'

// src/nip98.mjs does not sign — the egress ban keeps finalizeEvent out of src/, so the key stays
// with the caller. The test signs exactly as tools/relay-invite.mjs does.
const build = (opts) => { const { template, body } = nip98Template(opts); return { event: finalizeEvent(template, opts.secretKey), body } }

let fails = 0
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }
const tag = (ev, k) => (ev.tags.find(t => t[0] === k) || [])[1]

const sk = generateSecretKey()
const pk = getPublicKey(sk)

// --- expectedUrl: the relay builds its own from the TENANT HOST, so the `u` tag must name it ----
ok('a wss relay URL compares as https', expectedUrl('wss://relay.example.test', '/api/invites') === 'https://relay.example.test/api/invites')
ok('a ws relay URL compares as http', expectedUrl('ws://localhost:3000', '/api/invites') === 'http://localhost:3000/api/invites')
ok('a port is part of the host and is kept', expectedUrl('wss://relay.example.test:8443', '/api/invites/claim') === 'https://relay.example.test:8443/api/invites/claim')
ok('an https relay URL stays https', expectedUrl('https://relay.example.test', '/api/invites') === 'https://relay.example.test/api/invites')
ok('a path on the relay URL is discarded — the request path is what counts',
  expectedUrl('wss://relay.example.test/nostr', '/api/invites') === 'https://relay.example.test/api/invites')

let refused = null
try { expectedUrl('', '/api/invites') } catch (e) { refused = e.message }
ok('an empty relay URL is refused, naming the env var', /BUZZ_RELAY_URL/.test(String(refused)))
refused = null
try { expectedUrl('wss://relay.example.test', 'api/invites') } catch (e) { refused = e.message }
ok('a path without a leading slash is refused', /start with a slash/.test(String(refused)))

// --- the event itself ---------------------------------------------------------------------------
const url = expectedUrl('wss://relay.example.test', '/api/invites')
const bodyObj = { ttl_secs: 3600, max_uses: 1 }
const built = build({ secretKey: sk, url, method: 'POST', body: JSON.stringify(bodyObj) })
const ev = built.event

ok('kind is 27235', ev.kind === 27235)
ok('it is signed by the key given, and verifies', ev.pubkey === pk && verifyEvent(ev))
ok('the u tag is the expected URL', tag(ev, 'u') === url)
ok('the method tag is upper-cased', tag(ev, 'method') === 'POST')
ok('a lower-case method is still sent upper-cased',
  tag(build({ secretKey: sk, url, method: 'post', body: '{}' }).event, 'method') === 'POST')
ok('content is empty — nothing about the request rides in it', ev.content === '')

// The payload tag is verified with require_payload=true on both invite routes, so its absence is
// refused before the signature is even considered.
const expectedHash = createHash('sha256').update(Buffer.from(JSON.stringify(bodyObj), 'utf8')).digest('hex')
ok('the payload tag is the hex SHA-256 of the body', tag(ev, 'payload') === expectedHash)
ok('…and it is present at all — require_payload is true on these routes', !!tag(ev, 'payload'))

// The other direction. Without this, a payload tag hard-coded to a constant passes everything above.
const other = build({ secretKey: sk, url, method: 'POST', body: JSON.stringify({ ttl_secs: 3601, max_uses: 1 }) })
ok('NEGATIVE CONTROL — a body differing by one character produces a different payload hash',
  tag(other.event, 'payload') !== tag(ev, 'payload'))
ok('…and the hash follows the body, not the key', tag(other.event, 'payload') ===
  createHash('sha256').update(Buffer.from(JSON.stringify({ ttl_secs: 3601, max_uses: 1 }), 'utf8')).digest('hex'))

// The returned body is the thing that must be sent. A caller that re-serialises signs one set of
// bytes and sends another, and the relay's refusal reads like a signing bug rather than this.
ok('the body handed back is byte-identical to the body that was hashed', built.body === JSON.stringify(bodyObj))
ok('…and hashing what was handed back reproduces the tag',
  createHash('sha256').update(Buffer.from(built.body, 'utf8')).digest('hex') === tag(ev, 'payload'))

// created_at is checked against SERVER time within ±60s, so a stale or injected timestamp is the
// difference between a working call and an opaque 401.
const now = Math.floor(Date.now() / 1000)
ok('created_at defaults to now', Math.abs(ev.created_at - now) <= 2)
ok('an explicit created_at is honoured — so a clock-skew case can be reproduced',
  build({ secretKey: sk, url, body: '{}', now: 1700000000 }).event.created_at === 1700000000)

// The header is what actually goes on the wire.
const header = nip98Header(ev)
ok('the header carries the Nostr scheme', header.startsWith('Nostr '))
const decoded = JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'))
ok('…and base64-decodes to the same signed event, which still verifies',
  decoded.id === ev.id && decoded.sig === ev.sig && verifyEvent(decoded))

// An UNSIGNED template in the header fails at the relay as "invalid Schnorr signature", which
// sends the operator looking at their key rather than at the missing signing step. Refuse it here.
refused = null
try { nip98Header(nip98Template({ url, body: '{}' }).template) } catch (e) { refused = e.message }
ok('an unsigned template is refused as a header, and says to sign it first', /SIGNED/.test(String(refused)))
refused = null
try { nip98Template({ body: '{}' }) } catch (e) { refused = e.message }
ok('building without a url is refused, naming why the url matters', /tenant host/.test(String(refused)))

console.log(fails ? `\nNIP-98 AUTH FAIL — ${fails}` : '\nNIP-98 AUTH PASS — the envelope matches what buzz-auth verifies')
process.exit(fails ? 1 : 0)
