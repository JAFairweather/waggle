// Reuse the Access tab's persisted Nave signer on every owner-control surface. A page must not
// silently replace an established Bunker session with whichever window.nostr provider happens to
// be injected into that tab; that can sign as a different identity or return no event at all.
import { nip07Signer, parseSession, signerFromSession } from './vendor/nave-connect.mjs'
import { assertConsoleFresh } from './staleness-guard.mjs'

export const CONSOLE_SESSION_KEY = 'waggle-console-session'

export async function consoleSigner({
  storage = globalThis.localStorage,
  win = globalThis.window,
  parse = parseSession,
  restore = signerFromSession,
  browserSigner = nip07Signer,
  assertFresh = assertConsoleFresh,
} = {}) {
  // The chokepoint, and the reason the guard belongs here rather than only in stableControlSigner:
  // four of the console's five signing paths reach a signer through this function and never touch
  // that one. connect.html signs kind 440 through it, and grant issuance is the least recoverable
  // thing this console does — so guarding only the routing path left 440s and 441s not merely
  // unguarded but with no edge to the guard at all (#418).
  //
  // Safe to run twice: stableControlSigner still calls it first, and both awaits resolve the same
  // in-flight check. Under Node — no document, so no HTTP module cache that can go stale — it
  // returns fresh instead of throwing, which is what keeps this suite socket-free.
  await assertFresh()
  let saved = null
  try { saved = storage?.getItem(CONSOLE_SESSION_KEY) || null } catch { /* private mode */ }
  if (saved) {
    try {
      const signer = restore(parse(saved), { win })
      if (signer) return signer
    } catch {
      try { storage?.removeItem(CONSOLE_SESSION_KEY) } catch { /* private mode */ }
    }
  }
  return browserSigner(win)
}
