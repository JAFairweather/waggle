// Detect a console page running a STALE module graph, and stop it signing (#418).
//
// The failure this exists for was observed live: after #404/#406 shipped, console/routing.html
// still refused `MC Claude` with a message that no longer existed anywhere in the tree. A hard
// reload fixed it. Nothing on the page said the code was old, and nothing could have — the pages
// import their modules by stable path with no version in it, and the importmap covers only the
// bare `nostr-tools` specifiers, so every local module is a plain cacheable URL.
//
// That matters more here than on an ordinary site because this console SIGNS OWNER CONTROL
// COMMANDS. A stale graph signs against an old grammar, an old envelope shape or an old freshness
// rule, and renders normally while doing it. `control-state-freshness.mjs` and
// `confirmed-fresh-signer.mjs` already treat freshness at the signing boundary as load-bearing;
// the code doing the signing was the one thing neither of them covered.
//
// HOW IT WORKS. `build-id.mjs` is a module, so a browser reusing a cached graph reuses the OLD id.
// `VERSION.json` is fetched with `cache: 'no-store'`, so it always reports what the server holds.
// Disagreement means the page is running code the server has replaced. Both files are generated
// together by `tools/gen-console-build-id.mjs` and pinned by `tests/console_staleness.mjs`.
//
// THE BOOTSTRAP GAP, stated rather than papered over: a graph cached from before this module
// existed does not run this module, so the first reload after it ships is still on the operator.
// Every reload after that is covered.
//
// TWO HALVES, and only one is load-bearing. The banner and the disabled controls are the visible
// half — they can be undone by any code that renders controls afterwards, so they are legibility,
// not a guard. `assertConsoleFresh()` at the signing chokepoint is the half with teeth.

import { CONSOLE_BUILD_ID } from './build-id.mjs'

export const VERSION_URL = './VERSION.json'

// A verdict is one of three states, never a boolean. "Could not ask the server" is not "fresh" —
// the same distinction the repo's tools make when they exit 3 rather than 0.
export function compareBuild(local, server) {
  if (typeof local !== 'string' || !local) {
    return { state: 'inconclusive', reason: 'this page carries no build id', local: local || null, server: server || null }
  }
  if (typeof server !== 'string' || !server) {
    return { state: 'inconclusive', reason: 'the server did not return a build id', local, server: server || null }
  }
  if (local === server) return { state: 'fresh', reason: 'page and server agree', local, server }
  return { state: 'stale', reason: 'the server has replaced the code this page is running', local, server }
}

// The reason IS the product. "This page is old" sends an operator hunting; naming both ids tells
// them whether to reload or to go and look at whether the site was published at all.
export function verdictMessage(verdict) {
  const { state, reason, local, server } = verdict
  if (state === 'fresh') return `console build ${local} — current`
  if (state === 'stale') {
    return `This console page is STALE: ${reason}. Page built ${local}, server has ${server}. ` +
      'Reload with cache bypass (Shift-Reload) before signing anything.'
  }
  return `Console freshness is UNKNOWN: ${reason}. ` +
    `Page built ${local || '(none)'}, server reported ${server || '(nothing)'}. ` +
    'Being unable to check is not the same as being current — reload, or check that the site was published.'
}

export async function fetchServerBuild(fetchImpl = globalThis.fetch, url = VERSION_URL) {
  if (typeof fetchImpl !== 'function') return null
  let response
  // `no-store` bypasses the HTTP cache in both directions, which is the point: a revalidated
  // VERSION.json is no use if the browser is allowed to answer from the same cache that handed it
  // the stale modules.
  try { response = await fetchImpl(url, { cache: 'no-store' }) } catch { return null }
  if (!response || !response.ok) return null
  try {
    const body = await response.json()
    return typeof body?.build === 'string' ? body.build : null
  } catch { return null }
}

export async function checkFreshness({ fetchImpl, url, buildId = CONSOLE_BUILD_ID } = {}) {
  return compareBuild(buildId, await fetchServerBuild(fetchImpl, url))
}

let inflight = null
export const pendingFreshness = () => inflight
export const resetFreshness = () => { inflight = null }

export function beginFreshnessCheck(options = {}) {
  inflight = checkFreshness(options)
  return inflight
}

// The chokepoint. Awaits the check rather than reading a snapshot of it, so an operator who clicks
// sign before the fetch lands is held, not waved through — and not refused either.
//
// No document means no browser, which means no HTTP module cache, which means the failure mode does
// not exist. That is a statement about the environment, not an exemption: under Node the module
// graph came off disk at import time and cannot be a stale copy of itself.
export async function assertConsoleFresh({ pending = inflight, doc = globalThis.document } = {}) {
  if (!doc) return { state: 'fresh', reason: 'not a browser: no HTTP module cache to go stale', local: CONSOLE_BUILD_ID, server: CONSOLE_BUILD_ID }
  if (!pending) throw Error('Console freshness was never checked on this page, so it may be running replaced code. Reload before signing.')
  const verdict = await pending
  if (verdict.state !== 'fresh') throw Error(verdictMessage(verdict))
  return verdict
}

const BANNER_ID = 'console-staleness-banner'

// Visible half. Returns the banner element so a caller (and the suite) can read what it said.
export function renderVerdict(verdict, doc = globalThis.document) {
  if (!doc || verdict.state === 'fresh') return null
  doc.documentElement.setAttribute('data-console-stale', verdict.state)
  let banner = doc.getElementById(BANNER_ID)
  if (!banner) {
    banner = doc.createElement('div')
    banner.id = BANNER_ID
    banner.setAttribute('role', 'alert')
    banner.style.cssText = 'position:sticky;top:0;z-index:9999;padding:0.75rem 1rem;font-weight:600;' +
      'background:#7a1d1d;color:#fff;border-bottom:2px solid #ff6b6b'
    doc.body.insertBefore(banner, doc.body.firstChild)
  }
  banner.textContent = verdictMessage(verdict)
  for (const el of doc.querySelectorAll('button, input, select, textarea')) {
    if (el.closest && el.closest(`#${BANNER_ID}`)) continue
    el.disabled = true
  }
  return banner
}

// Auto-install when loaded as a page script. Kept behind the document check so importing this
// module under Node — which the suite does — starts no fetch and touches no DOM.
if (globalThis.document && globalThis.fetch) {
  beginFreshnessCheck().then(v => renderVerdict(v)).catch(() => {})
}
