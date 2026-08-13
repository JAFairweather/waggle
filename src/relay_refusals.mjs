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

/// THE JOURNAL IS A SURFACE AN OPERATOR READS AND ACTS ON (#405), so text that arrived from outside
/// is bounded and defused before it becomes a line — the same reason `render.mjs` defuses a note
/// body on the in-door. Two things a relay controls can hurt here, neither needing it to be hostile
/// on purpose:
///
///   - A NEWLINE synthesises what looks like another journal line. The tripwire reads these
///     journals, so a reason carrying a line break followed by `RELAY[buzz] ok -> ...` puts a
///     sentence in the bridge's mouth. An ESC sequence rewrites what the operator sees more
///     directly still.
///   - LENGTH. Nothing truncated this: a megabyte reason was a megabyte journal line.
///
/// THE RELAY URL IS DEFUSED TOO, not only the reason. On the return lane the relay set comes from
/// the recipient's own `kind:10050`, so the URL is chosen by the same party as the reason — and
/// defusing one while interpolating the other into the same line fixes half an injection.
///
/// READABILITY IS THE CONSTRAINT, not an afterthought. `pow: 28 bits needed. (12)` has to survive
/// byte for byte, because the whole point of #374 was that this string reaches the operator; a
/// guard that mangles the ordinary case hides the fault it exists to reveal. So control characters
/// collapse to a space rather than being stripped or escaped into noise, and truncation SAYS that
/// it truncated and by how much — a reason 40 000 characters long is itself the news, and silently
/// cutting it to 200 reports a hostile relay as a chatty one.
export const REFUSAL_TEXT_MAX = 200

export function defuseJournalText(value, max = REFUSAL_TEXT_MAX) {
  const raw = String(value ?? '')
  // C0 (U+0000-U+001F: CR, LF, TAB, ESC, NUL), DEL (U+007F), and C1 (U+0080-U+009F, which some
  // terminals still act on). Whole ranges rather than the characters anyone has abused so far —
  // naming what may pass is what stays correct when someone finds a new one.
  const flat = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max)}... (truncated, ${raw.length} chars)`
}

/// Everything outside brackets, lowercased and squeezed: the part of a refusal that is about the
/// relay's rule rather than about this particular event.
///
/// COMPUTED FROM THE RAW REASON, deliberately — and the consequence runs the opposite way to the
/// one it is tempting to write down. JS `\s` does not cover NUL, ESC or most of C0, so a control
/// character SURVIVES the squeeze and VARIES the key, while `defuseJournalText` maps it to a space
/// so every one of those lines renders identically. Two reasons differing only by an invisible
/// character are therefore two refusals that both log, and the second prints
///
///     RELAY REFUSAL CHANGED …: pow: 28 bits needed. — was "pow: 28 bits needed."
///
/// a changed line where nothing visible changed. Defusing before the comparison instead does not
/// fix it: a NUL walked along the string still yields 401 lines from 500 sends, because inserting a
/// space mid-word is a genuinely different string after the squeeze. Both measured in the #420
/// review, which is why the decision stands and this paragraph replaces the justification that
/// claimed a suppression that does not happen.
///
/// The root is not the control character. `defuseJournalText` bounds the LENGTH of a line; nothing
/// bounds the COUNT, and 500 sends of freely varied wording is 500 lines with no invisible
/// character anywhere. That predates this module and needs a per-relay cap in a window (#422).
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
      // Defused on the way IN, so every consumer of the row — this line, `summary()`, `rows()` —
      // is safe by construction rather than by each of them remembering (#405). The KEY above is
      // computed from the raw reason and is deliberately untouched: defusing before comparison
      // would change what counts as the same refusal, and that behaviour is tested.
      r.reason = defuseJournalText(reason)
      const shown = r.reason || '(no reason given)'
      const shownRelay = defuseJournalText(url)
      log(was === null
        ? `RELAY REFUSED ${shownRelay}: ${shown} — first time; further identical refusals are counted, not logged (#374)`
        : `RELAY REFUSAL CHANGED ${shownRelay}: ${shown} — was "${was || '(no reason given)'}"; ${r.refused} refusal(s) from this relay so far`)
      return 'logged'
    },

    /// A snapshot for a periodic summary. Copies, so a caller cannot edit the ledger by accident.
    rows() { return [...rows.values()].map(r => ({ ...r })) },

    /// One line per relay that has ever refused, or null when none has — a summary that prints
    /// "all fine" every tick is a summary nobody reads.
    summary() {
      const bad = [...rows.values()].filter(r => r.refused > 0)
      if (!bad.length) return null
      return bad.map(r => `${defuseJournalText(r.relay)}: refused ${r.refused} of ${r.refused + r.accepted} — ${r.reason || '(no reason given)'}`).join(' · ')
    },

    size() { return rows.size },
    reset() { rows.clear() },
  }
}

/// Explain ONE fanout call's refusals — never the ledger's lifetime view (#402). `summary()` above
/// answers "what has this relay ever done", which is the right question for a periodic operator
/// report and the wrong one for "why was THIS send short": a relay that refused hours ago, on a
/// different send, to a different relay set, is unrelated history, and printing it next to an
/// unrelated short ratio is the #374 misattribution moved one level up — the reader blames a relay
/// that was never dialed.
///
/// Takes exactly what the caller collected from its own fanout call, so it is scoped by
/// construction: no relay it never talked to, no refusal from a different send. First reason per
/// relay only — a caller that wants the ledger's fuller history has `summary()`.
export function explainSendRefusals(refusals) {
  if (!refusals || !refusals.length) return null
  const byRelay = new Map()
  for (const r of refusals) {
    const relay = String(r?.relay || '')
    if (!relay || byRelay.has(relay)) continue
    byRelay.set(relay, defuseJournalText(r?.reason) || '(no reason given)')
  }
  if (!byRelay.size) return null
  return [...byRelay].map(([relay, reason]) => `${defuseJournalText(relay)}: ${reason}`).join(' · ')
}
