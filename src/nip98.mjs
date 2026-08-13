// NIP-98 HTTP auth (kind:27235) — the signed envelope Buzz's HTTP API expects.
//
// Pure by design: this module builds and signs an event and returns a header value. It opens no
// socket and reads no file, so the shape can be asserted in a test without a relay, a key file or
// a network. `tools/relay-invite.mjs` is the only caller that does I/O.
//
// The contract is not ours — it is `buzz-auth/src/nip98.rs`, and every line below exists because
// that verifier checks it:
//
//   kind 27235 · Schnorr signature · `created_at` within ±60s of SERVER time · a `u` tag matching
//   the request URL (normalised: case-insensitive scheme and host, trailing slash stripped) · a
//   `method` tag matching case-insensitively · and a `payload` tag whose value is the hex SHA-256
//   of the exact request body.
//
// The payload tag is the one that bites. The invite routes are verified with `require_payload =
// true`, so a request without it is refused before the signature is even considered — and the hash
// must be of the bytes actually sent, not of an equivalent object. So this module takes the body
// as a STRING and hands the same string back for the caller to send. A caller that re-serialises
// between signing and sending produces a valid signature over the wrong bytes, which fails as
// "payload tag SHA-256 mismatch" and reads like a signing bug rather than a serialisation one.

// IT DOES NOT SIGN. That started as the egress ban's rule — no module under src/ may reach
// `finalizeEvent` except the two sanctioned signer modules — and it turns out to be the right shape
// anyway: the console signs through the operator's own signer (an extension or a bunker, never a
// key this page holds), and the CLI signs with a key from a file. Neither can be baked in here. So
// this builds an UNSIGNED template and whoever holds the key signs it.
//
// IT LIVES IN src/ because that is where its callers are, and because src/ SHIPS (#432). It used
// to live in console/ on the reasoning that the browser was one of its two callers — but no page
// under console/ ever imported it. The two importers were `tools/relay-invite.mjs` and
// `tests/nip98_auth.mjs`, both Node. Meanwhile console/ is not in the deploy ship list
// (`deploy/verify-deployed.sh:35`, `deploy/deploy-runner.sh:63`), so relay-invite could not load in
// the deployed tree at all: ERR_MODULE_NOT_FOUND on a resolver path that says nothing about a
// missing directory.
//
// So this is a move, not a fork. The header it replaces was right that two copies of a
// security-relevant builder is how two copies drift apart — that is exactly why there is still
// only one. If a console page ever does need this, the arrangement to copy is
// `console/scope-hash.mjs` (#328): a browser copy that a test binds to this one, not a
// cross-boundary import in either direction.
//
// Hashing goes through Web Crypto rather than `node:crypto`, so this file would still run
// unmodified in a browser if that day comes. That makes the builder ASYNC, which is the one thing
// to notice when calling it.

/// The URL the relay will compare against. It builds its own from the TENANT HOST — the Host
/// header the request arrives on — not from any configured URL, so the `u` tag has to name the
/// host being dialled. `wss://` deployments compare against `https`, `ws://` against `http`.
export function expectedUrl(relayUrl, path) {
  const raw = String(relayUrl || '').trim()
  if (!raw) throw new Error('no relay URL — set BUZZ_RELAY_URL to the same value the buzz CLI uses')
  const scheme = /^wss:\/\//i.test(raw) || /^https:\/\//i.test(raw) ? 'https' : 'http'
  let host
  try { host = new URL(raw.replace(/^ws(s?):\/\//i, (_, s) => (s ? 'https://' : 'http://'))).host }
  catch { throw new Error(`could not read a host out of the relay URL (${raw.split('://')[0] || '?'}://…)`) }
  if (!host) throw new Error('the relay URL has no host')
  if (!String(path || '').startsWith('/')) throw new Error(`path must start with a slash: ${JSON.stringify(path)}`)
  return `${scheme}://${host}${path}`
}

/// Build the unsigned auth event, and return the exact body string it commits to. Returning the
/// body is not convenience — it is what stops the caller sending different bytes from the ones
/// that were hashed.
export async function nip98Template({ url, method = 'POST', body = '', now = Math.floor(Date.now() / 1000) }) {
  if (!url) throw new Error('nip98Template needs a url — the relay compares it against the tenant host')
  const m = String(method).toUpperCase()
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
  const bytes = new TextEncoder().encode(bodyStr)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const payload = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
  return {
    template: {
      kind: 27235,
      created_at: now,
      tags: [['u', url], ['method', m], ['payload', payload]],
      content: '',
    },
    body: bodyStr,
  }
}

/// Wrap a SIGNED auth event in the header value the relay reads. Refuses an unsigned template,
/// because `Authorization: Nostr <unsigned>` fails as "invalid Schnorr signature" — a message that
/// sends the operator looking at their key rather than at the missing signing step.
export function nip98Header(signedEvent) {
  const ev = signedEvent || {}
  if (!ev.sig || !ev.id || !ev.pubkey) throw new Error('nip98Header needs a SIGNED event — sign the template first')
  // btoa over the UTF-8 bytes, not over the string: a multi-byte character in any tag would make
  // btoa throw on the raw string, and the only tag values here are a URL and hex — until somebody
  // adds one that is not.
  const json = new TextEncoder().encode(JSON.stringify(ev))
  return `Nostr ${btoa(String.fromCharCode(...json))}`
}
