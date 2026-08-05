// Reuse the Access tab's persisted Nave signer on every owner-control surface. A page must not
// silently replace an established Bunker session with whichever window.nostr provider happens to
// be injected into that tab; that can sign as a different identity or return no event at all.
import { nip07Signer, parseSession, signerFromSession } from './vendor/nave-connect.mjs'

export const CONSOLE_SESSION_KEY = 'waggle-console-session'

export async function consoleSigner({
  storage = globalThis.localStorage,
  win = globalThis.window,
  parse = parseSession,
  restore = signerFromSession,
  browserSigner = nip07Signer,
} = {}) {
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
