// Private helper for the participant-side DM relay-list publisher. This is
// intentionally outside src/: it signs with the participant's supplied key,
// never the bridge key that src/nostr_egress.mjs exclusively owns.

import { finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { normalizeDmRelayList } from '../src/dm_relays.mjs'

// The unsigned template, separated from signing so a Bunker can sign it (#381). The local path
// below is now finalizeEvent applied to this, so both paths publish byte-identical content and
// there is no second definition of what a kind:10050 is.
export function buildDmRelayListTemplate(urls, createdAt = Math.floor(Date.now() / 1000)) {
  const relays = normalizeDmRelayList(urls)
  if (!relays.length) throw new Error('one or more valid wss:// recipient relays are required')
  return {
    kind: 10050,
    created_at: Math.floor(createdAt),
    tags: relays.map(url => ['relay', url]),
    content: '',
  }
}

export function buildDmRelayListEvent(secretKey, urls, createdAt = Math.floor(Date.now() / 1000)) {
  return finalizeEvent(buildDmRelayListTemplate(urls, createdAt), secretKey)
}

/**
 * Sign a kind:10050 through any signer — a local key or a NIP-46 Bunker — with the identity
 * proved on both sides of the signature (#381, and the defect class in #338).
 *
 * signer: { pubkey: string, sign(template): Promise<event> }
 *
 * TWO checks, and the ORDER of the first one is the point:
 *
 *   BEFORE — the signer's own public key must equal the expected identity. A Bunker holds many
 *   keys and a copied environment points at whichever one it was last pointed at. Asking it to
 *   sign and inspecting the result afterwards is too late: the wrong identity has already
 *   published. This is the Pair-step rule from DESIGN_CONNECT_REMOTE_AGENT.md Part V — "a
 *   mismatch is a hard stop, never a warning" — and it is what #338 had no equivalent of.
 *
 *   AFTER — the returned event must actually verify, carry that same pubkey, and carry the tags
 *   we asked for. A remote signer is a network peer, not a library call. Trusting its answer
 *   because we trusted the question is how a bridge publishes something it did not compose.
 */
export async function signDmRelayList(signer, urls, expectedPubkey, { createdAt } = {}) {
  const expected = String(expectedPubkey || '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('expected pubkey must be 64-character hex')

  const resolved = String(signer?.pubkey || '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(resolved)) throw new Error('signer did not report a public key; nothing signed')
  // Refuse BEFORE asking for a signature — see above.
  if (resolved !== expected) {
    throw new Error(`signer resolves to ${resolved.slice(0, 12)}…, expected ${expected.slice(0, 12)}… — nothing signed`)
  }

  const template = buildDmRelayListTemplate(urls, createdAt ?? Math.floor(Date.now() / 1000))
  const event = await signer.sign(template)

  if (!event || typeof event !== 'object') throw new Error('signer returned no event')
  if (event.kind !== 10050) throw new Error(`signer returned kind ${event.kind}, not 10050`)
  if (String(event.pubkey || '').toLowerCase() !== expected) {
    throw new Error(`signer returned an event authored by ${String(event.pubkey || 'nothing').slice(0, 12)}…, not ${expected.slice(0, 12)}…`)
  }
  if (!verifyEvent(event)) throw new Error('signer returned an event whose signature does not verify')
  if (JSON.stringify(event.tags) !== JSON.stringify(template.tags)) {
    throw new Error('signer returned different relay tags than were submitted; nothing published')
  }
  return event
}
