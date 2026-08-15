// relay-reach.mjs — measure whether this browser reaches the relay's API, instead of asking a
// person to go and read a config value off the box (#499).
//
// The #486 plan opened with "what is BUZZ_CORS_ORIGINS on the live relay?" — a question for a human,
// answered by ssh'ing somewhere and reading an env file. Nobody needs that value. What they need to
// know is whether THIS ORIGIN reaches the API, and `GET /api/join-policy` takes no auth, so one
// request settles it. Reading config to predict an outcome the page can observe is the thing this
// repo's verification discipline refuses everywhere else; it should not get a pass here because the
// observation is a fetch.
//
// It also drops the operator out of the console, which is the one thing #486 exists to avoid.
//
// THE HONEST LIMIT, and why this module is not a diagnosis. A browser cannot tell a CORS block from
// an unreachable host: both are the same TypeError with no status, by design — the whole point of
// the same-origin policy is that the page learns nothing about a response it was not allowed to
// read. So `no-answer` names BOTH causes and carries the remedy for the one that is fixable from a
// config file. A module that picked one would send the operator to fix the wrong thing half the
// time, and it would be right often enough to be believed.

/// What the operator can do about a blocked origin — the actual config line, with their actual
/// origin in it. A remedy that says "check your CORS settings" is a remedy nobody can act on.
export function corsRemedy(origin) {
  const o = String(origin || '').trim() || 'https://<this-console-origin>'
  return `If the relay is up, this origin is not on its allow-list. Either leave BUZZ_CORS_ORIGINS unset — empty means permissive — or add exactly ${o} to it and restart the relay.`
}

/// Turn one probe result into a verdict. Pure, so every branch is assertable without a socket.
///
/// Three states, and they must not collapse:
///   reachable  — the API answered and this page could read it. The only one that proves anything.
///   answered   — an HTTP status came back. CORS is fine; the status is the operator's next lead.
///   no-answer  — no status at all. Blocked or down, and this page cannot tell which.
export function reachVerdict({ status = null, err = null, host = 'the relay', origin = '' } = {}) {
  if (status === null) {
    return {
      state: 'no-answer',
      // Both causes, in the order the operator can act on them, and never one presented as the fact.
      reason: `no answer from ${host} (${err?.message || err || 'no detail'}). A browser cannot tell these apart: the relay is unreachable, or it answered and its CORS policy withheld the response from this page. ${corsRemedy(origin)}`,
      reaches: false,
    }
  }
  if (status >= 200 && status < 300) {
    return {
      state: 'reachable',
      reason: `${host} answered ${status} and this page could read it — this origin reaches the API, so nothing needs changing on the relay.`,
      reaches: true,
    }
  }
  // A status of any kind proves the response was READABLE, which is the CORS question answered in
  // the affirmative. Saying so matters: a 404 here is a wrong URL, not a blocked origin, and those
  // two get fixed in completely different places.
  return {
    state: 'answered',
    reason: `${host} answered ${status}. The response was readable, so this origin is not blocked — the status is the thing to chase (a 404 is usually a wrong path, a 5xx is the relay's own problem).`,
    reaches: true,
    status,
  }
}

/// Probe the relay. Unauthenticated on purpose: `/api/join-policy` takes no auth, and signing one
/// would invent a requirement the relay does not have — and would then make a signing failure look
/// like a reach failure.
export async function probeRelay({ relayUrl, fetchImpl = globalThis.fetch, origin = globalThis.location?.origin || '' } = {}) {
  const base = String(relayUrl || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '')
  if (!base) return { state: 'no-relay', reaches: false, reason: 'no relay address given — there is nothing to probe.' }
  const host = base.replace(/^[a-z]+:\/\//i, '').split('/')[0] || 'the relay'
  let res
  try { res = await fetchImpl(`${base}/api/join-policy`, { method: 'GET', headers: { accept: 'application/json' } }) }
  catch (e) { return { ...reachVerdict({ status: null, err: e, host, origin }), url: base } }
  return { ...reachVerdict({ status: res.status, host, origin }), url: base }
}

// ── Remembering the address ─────────────────────────────────────────────────────────────────
//
// Typed once, not at every step. Same shape as `console/bridge-key-store.mjs`, and for the same
// reason it takes the verified state as an argument: a page that saves before anything answered
// remembers a typo and prefills it forever, which is a typo that survives the error that rejected
// it. Here the proof is a probe that actually reached the relay.
//
// An address, not a secret — but still only ever the address. Nothing else about the relay is
// stored, so there is no branch on which a credential could land in localStorage by accident.

export const RELAY_URL_STORAGE = 'waggle-relay-url'

const URL_OK = /^https?:\/\/[^\s/]+/i

export function loadRelayUrl(storage = globalThis.localStorage) {
  let value = null
  try { value = storage?.getItem(RELAY_URL_STORAGE) || null } catch { return '' }
  // A stored value that is not an address is not a prefill, it is a puzzle.
  return value && URL_OK.test(value) ? value : ''
}

export function rememberRelayUrl(relayUrl, probe, storage = globalThis.localStorage) {
  const value = String(relayUrl || '').replace(/\/$/, '')
  if (!URL_OK.test(value)) return false
  // Only a probe that REACHED it. `answered` counts — a readable 404 still proves the origin is not
  // blocked, and the operator is about to fix the path rather than retype the host.
  if (!probe || probe.reaches !== true || probe.url !== value) return false
  try { storage?.setItem(RELAY_URL_STORAGE, value) } catch { return false }
  return true
}
