// Private helper for the participant-side DM relay-list publisher. This is
// intentionally outside src/: it signs with the participant's supplied key,
// never the bridge key that src/nostr_egress.mjs exclusively owns.

import { finalizeEvent } from 'nostr-tools/pure'
import { normalizeDmRelayList } from '../src/dm_relays.mjs'

export function buildDmRelayListEvent(secretKey, urls, createdAt = Math.floor(Date.now() / 1000)) {
  const relays = normalizeDmRelayList(urls)
  if (!relays.length) throw new Error('one or more valid wss:// recipient relays are required')
  return finalizeEvent({
    kind: 10050,
    created_at: Math.floor(createdAt),
    tags: relays.map(url => ['relay', url]),
    content: '',
  }, secretKey)
}
