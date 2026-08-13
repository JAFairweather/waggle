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

/// Everything that can change what a line LOOKS like without being visible in it (#423).
///
/// Named by Unicode category rather than by codepoint — the same principle as the original C0/C1
/// range, and the reason that one has held. Naming what may pass stays correct when somebody finds
/// a control nobody had listed.
///
///   \p{Cc}  the 65 C0/C1/DEL controls this function already collapsed
///   \p{Cf}  format characters: U+202E RIGHT-TO-LEFT OVERRIDE and the U+2066-U+2069 isolates,
///           which REORDER the line with no C0 or C1 character anywhere in it; plus the zero-width
///           set (U+200B, U+200C, U+200D, U+2060, U+FEFF), U+00AD SOFT HYPHEN and the bidi marks
///   \p{Zl}  U+2028 LINE SEPARATOR
///   \p{Zp}  U+2029 PARAGRAPH SEPARATOR
///   \p{Zs}  the space separators, including U+00A0 NO-BREAK SPACE
///
/// U+202E is the one with teeth. The journal is text an operator reads and acts on — the premise
/// the whole of #405 rests on — and an override reorders it while every byte-level check keeps
/// passing. An unterminated isolate does the same to whatever prints on the line AFTER this one.
///
/// U+00A0 is here having been thought about rather than collapsed reflexively: it already renders
/// as a space, so mapping it to one costs nothing visible, and "already looks fine" is not the same
/// as "is a space". The suite asserts it now IS one.
///
/// EVERYTHING BECOMES A SPACE, including the zero-width characters, where deleting them would look
/// tidier. Deleting can JOIN two tokens into one that never existed; spacing can only ever separate.
/// A visible extra space is honest, and a fabricated word is not.
///
/// The cost, stated rather than discovered: an emoji sequence joined by U+200D comes apart into its
/// components. A relay refusal is not where emoji families belong, and ZWJ is itself a way to hide
/// what a string contains, so the trade is deliberate — but the ordinary case is the constraint, and
/// `pow: 28 bits needed. (12)` and non-ASCII relay wording are both asserted to survive intact.
// Exported as the SOURCE STRING, not as a compiled /g regex: the suite sweeps the plane against
// this exact class, and a /g regex carries `lastIndex` between calls, so a shared one would
// report a different answer on the second character it was asked about (#423).
export const INVISIBLE_CLASS = '[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Zs}]'
const INVISIBLE = new RegExp(`${INVISIBLE_CLASS}+`, 'gu')

export function defuseJournalText(value, max = REFUSAL_TEXT_MAX) {
  const raw = String(value ?? '')
  const flat = raw
    .replace(INVISIBLE, ' ')
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
