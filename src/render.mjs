// Extracted from bridge.mjs by #154. Behaviour is byte-identical; only the file boundary is new.
//
// Pure string transformation: no config, no I/O, no ambient state. That is why it is the safest
// module to lift out first, and why the render_states suite can drive it directly.
// --- Presentation. Follows TRUST — but a quarantined message still has to be READ, because a
// human is being asked to judge it. An earlier cut wrapped untrusted text in a code fence:
// safe, and unusable. Fences don't wrap, so the message ran off the edge behind a line-number
// gutter and truncated mid-sentence — we were asking for a decision about content the approver
// could not see. The guard was doing its job at the expense of the job.
//
// So: NEUTRALISE rather than ENCASE. The escaping below was always what made untrusted text
// safe; the fence was belt-and-braces charging legibility for it.
const ZWSP = '\u200B'   // an ESCAPE, never the literal: a character nobody can see in the
                       // source is a character nobody can review (CLAUDE.md; was literal until #443)

/// Characters that change what the APPROVE SCREEN SAYS without appearing in it (#443).
///
/// This is the screen where a human authorises attacker-controlled text, and the header above
/// states the stakes: a quarantined message has to be READ, because a human is being asked to judge
/// it. `defuseRefs` and `defuseMarkup` handle what the body can SUMMON and what chrome it can
/// IMITATE. Neither touches U+202E RIGHT-TO-LEFT OVERRIDE, which reorders the text being judged
/// while every byte-level check keeps passing, or an unterminated U+2066 isolate, which bleeds into
/// whatever renders next -- here the provenance line and `approve / follow / mute / reject`.
///
/// NOT `INVISIBLE_CLASS` from `relay_refusals.mjs`, which #443 suggested reusing. That class also
/// carries \p{Zs} and the WHOLE of \p{Cc}, which is right for a journal line -- one line, whitespace
/// already squeezed to single spaces. Here the string is PROSE inside a quote block: \p{Zs} would
/// mark every ordinary space and \p{Cc} would mark every newline, which `quoted()` splits on. So TAB,
/// LF and CR are excluded by hand. Marking them would not make the body safer, it would make it
/// unreadable, and the legibility constraint binds harder on this surface than on the journal.
///
/// U+00A0 NO-BREAK SPACE goes with the rest of \p{Zs} rather than being pulled back in, having been
/// thought about: it already renders as a space, so an approver reading the body sees exactly what
/// is there, and marking every one of them would be noise on the one screen that must stay legible.
/// The journal makes the opposite call because it asserts the codepoint IS a space; here nothing
/// downstream of the render depends on which one it was.
export const RENDER_INVISIBLE_CLASS =
  '[\\p{Cf}\\p{Zl}\\p{Zp}\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]'
const RENDER_INVISIBLE = new RegExp(RENDER_INVISIBLE_CLASS + '+', 'gu')

/// MARK, do not replace -- the opposite call to the journal's, and deliberately.
///
/// A journal line is a diagnostic string, so mapping an invisible to a space costs nothing. A
/// quarantined body is prose a human is reading for MEANING, and silently swapping in a space says
/// the note was innocent. The approver's decision turns on the fact that something was hidden
/// there at all, so the render names it: `[U+202E]`, or `[U+200B x47]` for a run.
///
/// Per RUN, not per character, which bounds the blow-up: a body of 100 000 zero-width spaces
/// becomes one mark rather than 800 000 characters of chrome. Interleaved invisibles still cost
/// about nine characters each -- stated rather than discovered, and the trade is worth it, because
/// interleaving IS the pattern worth showing an approver.
///
/// MUST RUN BEFORE `defuseRefs` and `defuseMarkup`, which INSERT U+200B themselves. Run after, it
/// would mark waggle's own zero-width spaces and turn every `@` and every line-leading `#` in the
/// body into `@[U+200B]`. The call order in `renderQuarantined` is the guard, and it is asserted.
export const defuseInvisible = (s) => String(s).replace(RENDER_INVISIBLE, (run) => {
  const cp = run.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  const size = [...run].length
  return size > 1 ? `[U+${cp} x${size}]` : `[U+${cp}]`
})
// A zero-width space after @ and nostr: — the reference RENDERS but never resolves to a real
// ping. Applied to every reposted body, vouched or not: nobody gets to summon a member.
export const defuseRefs = (s) => String(s)
  .replace(/@(?=[\w])/g, `@${ZWSP}`)
  .replace(/\bnostr:/gi, `nostr${ZWSP}:`)
// A zero-width space before line-leading markdown, so an unvouched sender can't mint headings,
// rules, lists, tables or nested fences that imitate our own chrome. The impersonation that
// matters is a quarantined note dressed up as an approval notice. Quarantined text only — a
// vouched identity keeps its formatting.
export const defuseMarkup = (s) => String(s)
  .replace(/```/g, `\`${ZWSP}\`\``)
  .replace(/^(\s*)([#>\-*+`|=~_]|\d+[.)])/gm, `$1${ZWSP}$2`)
export const quoted = (s) => String(s).replace(/\r/g, '').split('\n').map(l => `> ${l}`).join('\n')

// One unmistakable state line, then the MESSAGE — readable, wrapping, set apart as a quote —
// then provenance and the actions. The old order buried the thing being judged under five
// lines of instructions, which is backwards for a screen whose only job is a human decision.
export function renderQuarantined({ body, mention = '', name, npub, when, claim = '', why, id }) {
  return `${mention}⏳ **QUARANTINED** — external Nostr reply, held out of every channel until you approve it.\n\n` +
    quoted(defuseMarkup(defuseRefs(defuseInvisible(body)))) + '\n\n' +
    `**from** ${name ? `**${defuseInvisible(name)}** · ` : ''}\`${npub}\`  ·  ${when}${claim}  ·  _${why}_\n` +
    `Reply **approve** · **follow** · **mute** · **reject** — or \`waggle-approve ${id}\``
}

// A vouched identity — released, granted, or a followed author. Reads as an ordinary message:
// flowing text, no code bubble, no gutter. A8 (native foreign-signed rendering) is what finally
// puts the participant's OWN avatar and name on it; until then this is a bridge-authored
// message that reads as cleanly as a repost can.
// `liveRefs` decides whether the body's @mentions survive (#94). Presentation follows trust, and
// defuseMarkup already states the rule this completes: "a vouched identity keeps its formatting."
// That exception was implemented for markup and never for refs, so EVERY reposted body had its
// mentions killed — a signed, revocably-granted participant's included. The cost was not
// cosmetic: an admitted agent could be carried into the room and still not wake a single
// colleague, which is the entire point of being admitted. That is what pushed operators onto a
// path that signs as the bridge instead. #94 diagnosed it exactly and was closed on a screenshot
// taken from that other path, where defuseRefs never runs.
//
// DEFAULT FALSE — fail closed. Only a live NIP-DA grant (signed, scoped, revocable by a 441)
// buys live refs. A mirrored feed does not: `watch_authors` streams an author's ENTIRE public
// feed inward, so honouring refs there would let any watched note summon the room. Nor does a
// standing follow (reply-trust is strictly narrower than admission), nor content a human released
// from quarantine — approving a stranger's note means "this may be published", never "this may
// summon people".
export function renderReleased({ body, name, npubShort, liveRefs = false }) {
  return `**${name || npubShort}**  ·  \`${npubShort}\`  ·  _via waggle_\n\n${liveRefs ? body : defuseRefs(body)}`
}

// Direct NIP-59 gift-wrap delivery. The recipient name is policy/config-owned and the wrap is a
// canonical one-line wire event; neither is prose supplied by the requesting bridge.
export function renderSealedDirect({ name, wrapJson }) {
  return `@${name}\n\nNew Armada DM — sealed, unwrap with your key:\n\n\`\`\`json\n${wrapJson}\n\`\`\`\n`
}

// Inbound Concord channel post (#191, option 1), delivered DECRYPTED into a seat's inbox because
// the box holds the community read-key. The seat reads plaintext and — if it chooses to answer —
// runs the deterministic seal-back keyed on `reply-to`. The body was authored by whoever posted
// in the channel, so it is NEUTRALISED (defuseRefs): a #general post containing "@someone" must
// not spuriously ping a Buzz member in the seat's inbox. `sender` is the rumor author's real
// pubkey (the routing invariant already proved the wrap was authored by the channel plane).
// `replyTo` is the inbound wrap id, surfaced verbatim so the seat can seal a reply to it.
export function renderChannelPlain({ channel, sender, body, replyTo }) {
  const who = String(sender).slice(0, 12)
  return `**#${channel}** · \`${who}…\` · _via waggle (decrypted)_\n\n` +
    defuseRefs(body) +
    `\n\n\`reply-to: ${replyTo}\``
}

// Repost a PLAINTEXT public note into a Buzz channel. `dest` is the community inbox for a
// trusted (allowlisted) note, or the STAGING inbox for a quarantined external reply (A1).
