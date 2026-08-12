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
import { nip98Template, nip98Header, expectedUrl } from '../console/nip98.mjs'
import { refusal, exitFor, checkMintBounds, EXIT, CLAIM_RATE_LIMIT, MIN_TTL_SECS, MAX_TTL_SECS, MAX_USES }
  from '../src/relay_invite.mjs'

// console/nip98.mjs does not sign — the key stays with the caller, which is the console's signer
// in one case and a key file in the other. The test signs exactly as tools/relay-invite.mjs does.
// It is async because the builder hashes through Web Crypto, so the same file runs in the browser.
const build = async (opts) => { const { template, body } = await nip98Template(opts); return { event: finalizeEvent(template, opts.secretKey), body } }

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
const built = await build({ secretKey: sk, url, method: 'POST', body: JSON.stringify(bodyObj) })
const ev = built.event

ok('kind is 27235', ev.kind === 27235)
ok('it is signed by the key given, and verifies', ev.pubkey === pk && verifyEvent(ev))
ok('the u tag is the expected URL', tag(ev, 'u') === url)
ok('the method tag is upper-cased', tag(ev, 'method') === 'POST')
ok('a lower-case method is still sent upper-cased',
  tag((await build({ secretKey: sk, url, method: 'post', body: '{}' })).event, 'method') === 'POST')
ok('content is empty — nothing about the request rides in it', ev.content === '')

// The payload tag is verified with require_payload=true on both invite routes, so its absence is
// refused before the signature is even considered.
const expectedHash = createHash('sha256').update(Buffer.from(JSON.stringify(bodyObj), 'utf8')).digest('hex')
ok('the payload tag is the hex SHA-256 of the body', tag(ev, 'payload') === expectedHash)
ok('…and it is present at all — require_payload is true on these routes', !!tag(ev, 'payload'))

// The other direction. Without this, a payload tag hard-coded to a constant passes everything above.
const other = await build({ secretKey: sk, url, method: 'POST', body: JSON.stringify({ ttl_secs: 3601, max_uses: 1 }) })
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
  (await build({ secretKey: sk, url, body: '{}', now: 1700000000 })).event.created_at === 1700000000)

// The header is what actually goes on the wire.
const header = nip98Header(ev)
ok('the header carries the Nostr scheme', header.startsWith('Nostr '))
const decoded = JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'))
ok('…and base64-decodes to the same signed event, which still verifies',
  decoded.id === ev.id && decoded.sig === ev.sig && verifyEvent(decoded))

// An UNSIGNED template in the header fails at the relay as "invalid Schnorr signature", which
// sends the operator looking at their key rather than at the missing signing step. Refuse it here.
refused = null
try { nip98Header((await nip98Template({ url, body: '{}' })).template) } catch (e) { refused = e.message }
ok('an unsigned template is refused as a header, and says to sign it first', /SIGNED/.test(String(refused)))
refused = null
try { await nip98Template({ body: '{}' }) } catch (e) { refused = e.message }
ok('building without a url is refused, naming why the url matters', /tenant host/.test(String(refused)))

// ── What a refusal MEANS (#362) ───────────────────────────────────────────────────────────────
// The tool collapsed every non-401 failure into exit 2, "relay/network" — so a deliberate
// `403 join_policy_required` reached the operator as a suspected connectivity problem. These
// assert the REASON, not merely that something was refused: `!ok` cannot tell a correct refusal
// from a correct refusal nobody can act on.
{
  // Each refusal must name the thing to DO about it, not just restate the code.
  const cases = [
    ['join_policy_required', /--accept-terms/, 'names the flag that fixes it'],
    ['invite_expired', /Mint a new one/, 'says to mint again'],
    ['invite_exhausted', /uses left/, 'distinguishes exhausted from expired'],
    ['invite_invalid', /another relay/, 'points at the wrong-deployment case, not at expiry'],
  ]
  for (const [err, wants, why] of cases) {
    const msg = refusal(403, { error: err })
    ok(`403 ${err} — ${why}`, wants.test(msg) && msg.includes(err))
  }

  // Two refusals that are easy to conflate, and must not be.
  ok('invite_expired and invite_exhausted do not share an explanation',
    refusal(403, { error: 'invite_expired' }) !== refusal(403, { error: 'invite_exhausted' }))

  // 429 is a throttle, and reading it as a rejection of the code sends the operator to re-mint
  // a code that was fine.
  const throttled = refusal(429, { error: 'too many invite claim attempts' })
  ok('429 is explained as a throttle, not as a bad code',
    /throttle, not a rejection/.test(throttled) && new RegExp(String(CLAIM_RATE_LIMIT)).test(throttled))

  // Second-granularity created_at: a retry loop hits this and it looks like a signing failure.
  ok('a replay refusal is explained by the clock, not blamed on the key',
    /same second/.test(refusal(403, { error: 'auth event replay detected' })))

  // NEGATIVE CONTROL — an unknown error must still say something usable. A refusal explainer
  // that returns '' for anything it does not recognise is worse than none: the operator sees a
  // bare status and assumes the tool broke.
  ok('an unrecognised error is passed through rather than swallowed',
    refusal(400, { error: 'something_new' }) === 'something_new')
  ok('and with no body at all it still says so rather than returning empty',
    refusal(500, null, '') === '(no error body)')

  // The status split: 4xx is the relay DECIDING, 5xx is the relay FAILING. A retry loop must
  // back off on one and stop on the other, so this cannot be one bucket.
  ok('a 403 exits REFUSED, not NETWORK — the answer is an answer', exitFor(403) === EXIT.REFUSED)
  ok('a 429 exits REFUSED', exitFor(429) === EXIT.REFUSED)
  ok('a 503 exits NETWORK — that one really is the relay failing', exitFor(503) === EXIT.NETWORK)
  ok('a 401 stays INPUT — the signature is the caller\'s problem', exitFor(401) === EXIT.INPUT)
  ok('NEGATIVE CONTROL — 200 is still OK, so this is a classifier and not a wall',
    exitFor(200) === EXIT.OK)
}

// ── The mint bounds, both directions ──────────────────────────────────────────────────────────
{
  ok('a ttl below the relay minimum is caught locally, with the limit named',
    /minimum of 60s/.test(String(checkMintBounds(30, 1))))
  ok('a ttl above the 30-day maximum likewise',
    /maximum/.test(String(checkMintBounds(MAX_TTL_SECS + 1, 1))))
  ok('and uses above the cap', /10000/.test(String(checkMintBounds(3600, MAX_USES + 1))))
  // NEGATIVE CONTROL — the documented defaults, and both exact boundaries, must pass. A checker
  // that rejects everything would satisfy all three assertions above and block every real mint.
  ok('NEGATIVE CONTROL — the default 3600/1 is accepted', checkMintBounds(3600, 1) === null)
  ok('and both boundaries are inclusive, not off by one',
    checkMintBounds(MIN_TTL_SECS, 1) === null && checkMintBounds(MAX_TTL_SECS, MAX_USES) === null)
}

console.log(fails ? `\nNIP-98 AUTH FAIL — ${fails}` : '\nNIP-98 AUTH PASS — the envelope matches what buzz-auth verifies')
process.exit(fails ? 1 : 0)
