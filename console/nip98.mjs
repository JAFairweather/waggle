// nip98.mjs — the browser copy of `src/nip98.mjs` (#487).
//
// `src/nip98.mjs` says, in its own header, what to do on the day a console page needs this:
// "the arrangement to copy is `console/scope-hash.mjs` (#328): a browser copy that a test binds
// to this one, not a cross-boundary import in either direction." This is that day, and this is
// that copy. Nothing else about it is a new decision.
//
// The two boundaries have not moved. `tools/serve-console.mjs` pins DOCROOT to console/ and
// refuses anything above it, so the page cannot import ../src/. And console/ is absent from the
// deploy ship list, so `tools/relay-invite.mjs` could not load a copy that lived here — it did,
// once, and failed with ERR_MODULE_NOT_FOUND on the deployed box.
//
// The body below is byte-identical to its twin, which needed NO changes to run here: that file
// already routes hashing through Web Crypto rather than node:crypto, and already refuses to sign,
// both for exactly this eventuality. `tests/console_admission.mjs` renders both over the same
// inputs and asserts the outputs match, signature bytes included.
//
// The contract is not ours — it is `buzz-auth/src/nip98.rs`. Do not adjust either copy to make a
// request pass; the payload tag must be the SHA-256 of the bytes actually sent, which is why the
// builder hands the body string back rather than letting a caller re-serialise it.

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
