// What a relay said when it refused, kept once rather than thrown away (#374).
//
// NIP-01's acknowledgement is `["OK", <id>, <bool>, <message>]`. The wrap publisher read the first
// three fields and dropped the fourth, so a refusal survived only as a count that came back one
// lower. Live consequence: `nos.lol` has refused every sealed wrap since 2026-08-08 with
//
//     pow: 28 bits needed. (12)
//
// and that string appears nowhere in the bridge journal. The lane reports `3/4` and an operator has
// to reproduce the send by hand to learn which relay and why — while a relay that is merely slow
// produces byte-identical output. There is nothing to grep for, so there is nothing to alarm on.
//
// THE TRAP THIS MODULE EXISTS TO AVOID. The obvious fix — log the message — floods. A relay
// refusing every send would write a line per send, onto a box whose journals the tripwire reads.
// The obvious fix to THAT — log a reason only once — quietly stops reporting when the reason
// changes, which is the one moment the line was worth having.
//
// So: log the first occurrence, suppress repeats, and log again when the reason is genuinely
// DIFFERENT. Which requires deciding what "different" means, and that decision is the whole reason
// this is a module with a test rather than three lines in the publisher:
//
//     pow: 28 bits needed. (12)
//     pow: 28 bits needed. (9)
//     pow: 28 bits needed. (17)
//
// Those are one refusal, not three. The parenthesised number is the difficulty THIS event happened
// to have, so it changes on every single send — compare the raw strings and suppression never
// engages at all, and the "fix" is the flood it was written to prevent. The bracketed part is
// dropped for the comparison and KEPT for display, because `28` is news when it changes and `(12)`
// never is.

/// Everything outside brackets, lowercased and squeezed: the part of a refusal that is about the
/// relay's rule rather than about this particular event.
export function refusalKey(reason) {
  return String(reason ?? '')
    .replace(/\([^)]*\)/g, ' ')        // per-event detail: the achieved difficulty, a byte count, an id
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim()
}

/// A bounded per-relay ledger. Keyed on the relay, so it is bounded by the size of the relay set no
/// matter how inventive the messages get; `cap` is a backstop for a caller that fans out to a list
/// built from something an outsider controls.
///
/// `log` is injected rather than imported so the suppression rule can be driven with no journal.
export function refusalLedger({ cap = 64, log = () => {} } = {}) {
  const rows = new Map()   // relay -> { refused, accepted, reason, key, firstAt, lastAt }

  const row = (relay) => {
    let r = rows.get(relay)
    if (!r) {
      r = { relay, refused: 0, accepted: 0, reason: null, key: null, firstAt: null, lastAt: null }
      // Insertion-ordered eviction. Dropping the OLDEST rather than refusing to add: a full ledger
      // must not make a newly-added relay invisible, which would hide exactly the relay whose
      // behaviour nobody has seen yet.
      if (rows.size >= cap) rows.delete(rows.keys().next().value)
      rows.set(relay, r)
    }
    return r
  }

  return {
    /// Record one relay's answer. Returns what it did, so a caller (and a test) can tell a
    /// suppressed repeat from a silently ignored frame — those look identical from the outside.
    ///
    /// `accepted` is the relay's own boolean. A `true` frame carrying a message is still an ACCEPT:
    /// `["OK", id, true, "duplicate: have this event"]` is the healthiest answer there is, and
    /// reading its message as a refusal would report the working relays as the broken ones.
    record({ relay, accepted, reason = '', at = Math.floor(Date.now() / 1000) }) {
      const url = String(relay || '')
      if (!url) return 'ignored'
      const r = row(url)
      r.lastAt = at
      if (r.firstAt === null) r.firstAt = at
      // An accept ENDS the refusal episode, so the next refusal is logged even if it repeats the
      // last reason. Without this, "this relay started refusing again after a week" is silently
      // folded into "this relay is still refusing" — two different events for an operator, and only
      // the first is actionable. A relay that genuinely alternates will now log each episode; that
      // is noisier and correct, because alternating IS a different condition from steady refusal.
      if (accepted) { r.accepted++; r.key = null; return 'accepted' }
      r.refused++
      const key = refusalKey(reason)
      if (r.key === key) return 'suppressed'
      const was = r.reason                 // captured BEFORE the overwrite; the line is useless without it
      r.key = key
      r.reason = String(reason ?? '')
      const shown = r.reason || '(no reason given)'
      log(was === null
        ? `RELAY REFUSED ${url}: ${shown} — first time; further identical refusals are counted, not logged (#374)`
        : `RELAY REFUSAL CHANGED ${url}: ${shown} — was "${was || '(no reason given)'}"; ${r.refused} refusal(s) from this relay so far`)
      return 'logged'
    },

    /// A snapshot for a periodic summary. Copies, so a caller cannot edit the ledger by accident.
    rows() { return [...rows.values()].map(r => ({ ...r })) },

    /// One line per relay that has ever refused, or null when none has — a summary that prints
    /// "all fine" every tick is a summary nobody reads.
    summary() {
      const bad = [...rows.values()].filter(r => r.refused > 0)
      if (!bad.length) return null
      return bad.map(r => `${r.relay}: refused ${r.refused} of ${r.refused + r.accepted} — ${r.reason || '(no reason given)'}`).join(' · ')
    },

    size() { return rows.size },
    reset() { rows.clear() },
  }
}
