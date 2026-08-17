// The public relay set, defined once.
//
// It was defined nine times. `tools/` alone hardcoded `['wss://nos.lol', 'wss://relay.primal.net']`
// in seven files and `config.example.json` prescribed the same pair to every new operator. That
// pair stopped being redundant on 2026-08-08, when nos.lol began refusing waggle's sealed
// gift-wraps for want of 28 bits of NIP-13 proof-of-work (#345):
//
//     nos.lol: REJECTED pow: 28 bits needed. (12)
//     relay.primal.net: OK
//     accepted by 1/2 relay(s)
//
// One relay left. A single outage is then a silent delivery stop, and there is nowhere in the code
// to fix it once, because the pair is written out by hand in every caller. Hence this module: the
// default set has ONE definition, and a caller that wants a different one says so through its own
// environment variable rather than by editing a literal that six other files also have.
//
// TWO THINGS THIS MODULE DOES NOT KNOW, both of which cost a round trip to learn:
//
//   1. **NIP-11 does not advertise the requirement.** nos.lol's relay information document declares
//      no `limitation.min_pow_difficulty` at all — checked 2026-08-11 — and refuses at write time
//      anyway. So a relay cannot be screened for proof-of-work in advance by reading its own
//      document, and any mining design that keys off the advertised target (#346) would do nothing
//      for the one relay that prompted it. Reacting to the refusal is the only trigger that works.
//   2. **Answering is not accepting.** Every URL below opened a socket and answered a REQ on
//      2026-08-11, and a deliberately invalid host and a 503ing relay.damus.io both failed in the
//      same probe, so the check can say no. But a REQ is a read. Nothing here proves any of these
//      accepts an 8KB `kind:1059` from waggle's key — only a live send does, and the fan-out ratio
//      in the journal is where that shows.
//
// And the trade this set makes, stated rather than buried: a wrap is opaque, but its envelope is
// not. Each additional relay is one more party holding "this pubkey addressed that pubkey at this
// time". More relays buys redundancy AND spreads that metadata. Four is a judgement, not a law.

/// The default outbound set. `nos.lol` stays in it deliberately: it refuses large sealed wraps, but
/// it serves reads and small writes (profiles, relay lists) and is one of the most widely queried
/// relays there is. Removing it would cost reach to fix a problem the other entries already fix.
/// Until #346 lands, expect sealed sends to report `n-1/n` because of it — that is the known
/// refusal, not a new fault.
export const DEFAULT_PUBLIC_RELAYS = Object.freeze([
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
  'wss://jskitty.com/nostr',
])

/// Fewer than this and one outage is a delivery stop rather than a degraded ratio. Not enforced —
/// an operator may have a good reason — but `thinRelaySet` names it so nobody discovers it during
/// the outage.
export const REDUNDANCY_FLOOR = 3

/// Parse an operator-supplied list into a usable relay set.
///
/// Deliberately strict about what it dials and deliberately loud about nothing: a malformed entry
/// is DROPPED, and the legitimate entries around it still get through. Dropping the whole list on
/// one bad entry would turn a typo into an outage; dialling it would turn a typo into a connection
/// to whatever that string resolves to.
///
/// Returns `fallback` only when the input yields nothing at all, so `RELAYS=""` means "I did not
/// set this", not "publish to nowhere" — a caller that fans out to an empty array reports a
/// cheerful `0/0` and looks like a success.
///
/// `allowLoopbackWs` admits `ws://` for LOOPBACK HOSTS ONLY. The wss-only rule below exists to keep
/// the envelope off the wire, and a socket to 127.0.0.1 is not on a wire — but the option is opt-in
/// rather than the default because "it's only local" is how a rule like this gets widened by
/// accident. It exists for `agent-inbox`/`agent-send`, which accepted `ws://` to ANY host before
/// they took their defaults from here (#589); routing them through this function without it would
/// have removed a live capability, and with it they end up stricter than they were.
export function relaySet(value, fallback = DEFAULT_PUBLIC_RELAYS, { allowLoopbackWs = false } = {}) {
  const seen = new Set()
  const out = []
  for (const raw of String(value ?? '').split(/[,\s]+/)) {
    const url = raw.trim()
    if (!url) continue
    // wss only. A `ws://` relay would carry the envelope in clear over the wire, and the sealed
    // lane's whole claim is that the envelope is the only thing anyone sees — no need to hand it
    // to the network as well.
    //
    // The loopback exemption names the three spellings and nothing else. `127.0.0.1` is matched as a
    // whole octet — a `[^\s/]*` here would admit `ws://127.0.0.1.evil.example`, which is a remote
    // host whose name starts with a loopback address.
    const loopback = allowLoopbackWs && /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url)
    if (!loopback && !/^wss:\/\/[^\s/]+/i.test(url)) continue
    // Two spellings of one host are one relay, and counting them twice is redundancy that is not
    // there. Compared without the trailing slash and case-insensitively on the host.
    const key = url.replace(/\/+$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(url.replace(/\/+$/, ''))
  }
  return out.length ? out : [...fallback]
}

/// Why this set is thin, or null if it is not. A string, because the caller logs it and the number
/// on its own ("2") sends nobody anywhere.
export function thinRelaySet(relays) {
  const n = Array.isArray(relays) ? relays.length : 0
  if (n === 0) return 'no relays configured at all — a fan-out to nothing reports 0/0 and reads as a send that simply landed nowhere'
  if (n < REDUNDANCY_FLOOR) {
    return `only ${n} relay(s) — below the floor of ${REDUNDANCY_FLOOR}, so one refusing or offline relay is a delivery stop rather than a reduced ratio (#345)`
  }
  return null
}
