// NIP-17 recipient DM relay lists (kind:10050).
//
// A gift wrap is private mail. Its destination is therefore the recipient's signed
// preference, never a convenient relay chosen by the sender. NIP-17 says that no
// list means "not ready to receive messages", so callers receive [] rather than a
// public-relay fallback.
import { verifyEvent } from 'nostr-tools/pure'

const MAX_DM_RELAYS = 8

function safeRelayUrl(value) {
  try {
    const u = new URL(String(value || '').trim())
    if (u.protocol !== 'wss:' || u.username || u.password || u.hash) return null
    const host = u.hostname.toLowerCase()
    // Do not turn a recipient-controlled event into a route to this host or an
    // obvious private network address. Public wss relays (including a recipient's
    // own relay) remain valid.
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null
    if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return null
    if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return null
    return u.href.replace(/\/$/, '')
  } catch { return null }
}

function normalizeDmRelayList(values, cap = MAX_DM_RELAYS) {
  const seen = new Set(), out = []
  for (const value of values || []) {
    const url = safeRelayUrl(value)
    if (!url || seen.has(url)) continue
    seen.add(url); out.push(url)
    if (out.length >= cap) break
  }
  return out
}

function recipientDmRelays(events, recipient, cap = MAX_DM_RELAYS) {
  const target = String(recipient || '').toLowerCase()
  const current = (events || [])
    .filter(e => {
      if (!e || e.kind !== 10050 || String(e.pubkey || '').toLowerCase() !== target || !Array.isArray(e.tags)) return false
      try { return verifyEvent(e) } catch { return false }
    })
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0) || String(b.id || '').localeCompare(String(a.id || '')))[0]
  if (!current) return []
  return normalizeDmRelayList(current.tags.filter(t => Array.isArray(t) && t[0] === 'relay').map(t => t[1]), cap)
}

export { MAX_DM_RELAYS, safeRelayUrl, normalizeDmRelayList, recipientDmRelays }
