// NIP-17 recipient DM relay lists (kind:10050).
//
// A gift wrap is private mail. Its destination is therefore the recipient's signed
// preference, never a convenient relay chosen by the sender. NIP-17 says that no
// list means "not ready to receive messages", so callers receive [] rather than a
// public-relay fallback.
import { verifyEvent } from 'nostr-tools/pure'

const MAX_DM_RELAYS = 8

/// Loopback, private or link-local — the addresses that make a published inbox unreachable from
/// anywhere but this network. Kept identical, function for function, to `refuseReason`'s copy in
/// `console/dm-relay-publish.mjs`, and `tests/console_dm_relays.mjs` drives the same table through
/// both.
///
/// IPv6 is a separate branch, and both reasons for that were live defects (#584 review):
///
///   * **WHATWG `URL.hostname` returns an IPv6 host BRACKETED** — `[::1]`, never `::1`. So the three
///     comparisons this replaces matched nothing and every IPv6 loopback, ULA and link-local address
///     was ACCEPTED. Driven: `wss://[::1]`, `wss://[fc00::1]`, `wss://[fe80::1]` and
///     `wss://[::ffff:127.0.0.1]` all passed the guard on both sides.
///   * **The brackets are also the only thing that tells an address from a name.** `fc` and `fd` are
///     a ULA prefix in an address and two ordinary opening letters in a hostname, so testing
///     `startsWith('fc')` against an unbracketed host refuses `wss://fd-relay.example` — a public
///     relay with a perfectly ordinary name. Stripping the brackets in place would have fixed the
///     first defect and kept the second.
function privateHost(hostname) {
  const bracketed = /^\[(.*)\]$/.exec(hostname)
  if (!bracketed) return /^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)
  const addr = bracketed[1]
  // `::ffff:127.0.0.1` normalises to `::ffff:7f00:1`, which the IPv4 rule above cannot see. Rebuild
  // the dotted form and ask that rule the same question, rather than writing a second copy of it
  // that would then be differently wrong.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr)
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16)
    return privateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  if (addr === '::1' || addr === '::') return true      // loopback, and the unspecified address
  if (/^fe[89ab][0-9a-f]?:/.test(addr)) return true     // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{0,2}:/.test(addr)) return true    // fc00::/7 unique-local
  return false
}

function safeRelayUrl(value) {
  try {
    const u = new URL(String(value || '').trim())
    if (u.protocol !== 'wss:' || u.username || u.password || u.hash) return null
    const host = u.hostname.toLowerCase()
    // Do not turn a recipient-controlled event into a route to this host or an
    // obvious private network address. Public wss relays (including a recipient's
    // own relay) remain valid.
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null
    if (privateHost(host)) return null
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
