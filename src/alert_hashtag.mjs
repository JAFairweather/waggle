// The alert hashtag a return-lane recipient subscribes to — #508.
//
// The other half of "mentions, or anything with the hashtag we've chosen to be an alert, push into
// the agent's context". The at-word half has been carried since #404; a hashtag matched none of the
// three signals `scanReturnLane` reads — a direct-reply marker, a `p` tag, an at-word — so a message
// flagging something for whichever agent is watching reached nobody, and nothing logged a refusal,
// because nothing ever considered it a candidate.
//
// PER RECIPIENT, NEVER GLOBAL. An agent subscribes to the alerts it wants; an agent that subscribes
// to none behaves exactly as it does today. A global tag would make every configured agent a
// recipient of every alert in the channel, which is a fan-out dressed as a feature.
//
// DEFAULT-CLOSED, and that is the direction that matters here. This matcher fans out to a live
// channel, so one that is too broad is worse than one that is absent: the at-word half at least
// fails toward silence, and a hashtag someone typed in passing does not. Every widening below was
// declined for that reason and the declines are written down, because the next reader will consider
// each of them again.

export const ALERT_TAG_MAX = 32

// THE ALPHABET, written once — same discipline as MENTION_ALPHABET in task_route_mention.mjs, and
// for the same reason: the grammar and the matcher's boundary must be one set, or they drift and
// the drift is silent. #408 is the whole argument; a route named `Dr` was carried `@Dr. Watson`
// because the boundary class and the grammar had been two literals.
//
// Letters, numbers and underscore. DELIBERATELY TIGHTER than the mention alphabet, which also
// carries `. ' -`:
//
//   `.` would make `#alert.` ambiguous with a sentence ending, and a tag that swallows the full
//       stop after it is a tag that stops matching the moment somebody writes a sentence.
//   `-` is admissible in a Nostr `t` tag and is refused anyway, because `#alert-2` and `#alert`
//       would then be two tags whose relationship is decided by the boundary rather than by the
//       operator. If a hyphenated tag is ever wanted, widening this string is the one edit.
//
// `\p{L}` and `\p{N}` rather than `\w`, so a tag in any script works and the boundary refuses the
// same characters the grammar does.
const ALERT_ALPHABET = '\\p{L}\\p{N}_'

const ALLOWED_CHAR = new RegExp(`[${ALERT_ALPHABET}]`, 'u')
const STARTS_WELL = /^[\p{L}\p{N}]/u

const codepoint = ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`

// null when the value is a usable tag, otherwise the reason — and the reason is the product. `!ok`
// cannot tell a correct refusal from a correct refusal with a misleading explanation, and this
// message is what an operator acts on when a tag they configured never fires. An invisible
// character is named by codepoint and position, because "invalid tag" sends them hunting.
export function alertHashtagProblem(value) {
  if (typeof value !== 'string') return 'alert tag must be text'
  const raw = value.replace(/^#/, '')
  if (!raw) return 'alert tag is empty'
  if (raw.length > ALERT_TAG_MAX) return `alert tag is longer than ${ALERT_TAG_MAX} characters`
  if (raw.includes('#')) return 'alert tag holds a second # — configure one tag per entry'
  for (const [i, ch] of [...raw].entries()) {
    if (!ALLOWED_CHAR.test(ch)) return `alert tag holds an unsupported character at position ${i + 1} (${codepoint(ch)}) — letters, numbers and _ only`
  }
  if (!STARTS_WELL.test(raw)) return 'alert tag must start with a letter or number'
  return null
}

// The value as STORED, with at most one leading `#` off; null when unusable. Casing is kept, like
// the mention grammar keeps it: folding happens in the COMPARISON, which is the only place two tags
// are ever asked whether they are the same, and lowercasing on the way in loses what the operator
// will read back.
export function alertHashtag(value) {
  return alertHashtagProblem(value) === null ? String(value).replace(/^#/, '') : null
}

// The COMPARISON key. Folded the same way the body matcher's `i` flag folds.
export const alertHashtagKey = value =>
  String(value == null ? '' : value).replace(/^#/, '').toLowerCase()

// Parse a configured list into usable tags, dropping the rest. Returns { tags, problems } so a
// caller can log what it refused — a tag silently discarded at load is a subscription the operator
// believes they have.
export function alertHashtags(values) {
  const tags = []
  const problems = []
  const seen = new Set()
  for (const value of (Array.isArray(values) ? values : [])) {
    // Judged on the RAW value, not on a coercion of it. Validating `String(value)` and then
    // converting `value` meant a number passed the check and then failed the conversion, so a
    // null was pushed into the subscription list — a tag that matches nothing and reports no
    // problem. One value, judged once, is the only way the reason and the result agree.
    const why = alertHashtagProblem(value)
    if (why) { problems.push({ value, why }); continue }
    const tag = alertHashtag(value)
    const key = alertHashtagKey(tag)
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return { tags, problems }
}

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g

// THE BODY MATCHER. Two boundaries, and unlike the at-word matcher this one has a LEADING boundary
// as well — a difference that is a decision, not an inconsistency with task_route_mention.mjs.
//
// The trailing lookahead is the alphabet, so `#alert` does not match `#alerting`. Same rule as the
// at-word's, same reason.
//
// The leading lookbehind is what the at-word matcher does not have, and it is here because `#` is
// the URL fragment delimiter. Without it `https://example.com/runbook#alert` fires the alert lane,
// and a link pasted into a channel is not somebody raising an alarm. Excluded before the `#`:
//
//   letters and numbers and `_`  — `page#alert`, and it keeps the boundary symmetric
//   `/`                          — `…/#alert`, the common fragment form
//   `#`                          — `##alert`, which is not a second tag
//
// A space, a newline, start-of-text, `(`, `[`, `"` and every ordinary punctuation mark are all
// still fine, so the forms people actually write — at the start of a line, after a space, inside
// brackets — all match.
export function alertHashtagMatcher(tag) {
  const t = String(tag == null ? '' : tag).replace(/^#/, '')
  if (!t) return null
  return new RegExp(`(?<![${ALERT_ALPHABET}/#])#${t.replace(RE_ESCAPE, '\\$&')}(?![${ALERT_ALPHABET}])`, 'iu')
}

// Does this message raise one of this recipient's alerts?
//
// TWO SOURCES, because clients disagree about which one they write. Nostr defines the `t` tag and
// some clients extract it from the body; others write only the body text and leave the tags alone.
// Reading one and not the other would make the feature work in some clients and not in others, and
// the operator has no way to tell which from inside the channel.
//
// Returns { tag, via } naming WHICH subscribed tag fired and where it was found, or null. The name
// is the product: it goes in the carry's log line, and "carried by alert" without saying which tag
// is a line nobody can act on when an agent starts receiving more than it expected.
//
// `t` tags are compared as whole values, case-folded — that is what a tag IS, so no boundary
// applies. The body goes through the matcher above.
// WHY A CARRY HAPPENED — and it is a token from a CLOSED SET, never a sentence.
//
// This function exists because the value is load-bearing in a way that is invisible where it is
// produced. `why` reaches an allowlist in both return-lane carry templates (`whys` in
// src/nostr_egress.mjs) and a value outside that list calls `reject()`, which THROWS OUT OF THE
// FAN-OUT LOOP — so it does not fail one carry, it takes every LATER recipient in that scan with
// it. That is the #168 failure shape exactly: one bad value, everybody after it silently dropped.
//
// A first draft of the #508 bridge change built `alert:${tag}`, which would have done precisely
// that on the first alert ever raised. It was caught by reading, and then a mutation run showed
// nothing in 106 suites would have caught it — so the decision moved here, where the suite asserts
// that every reachable return value is one the templates admit. WHICH tag fired belongs in the log
// line, where an operator reads it.
export const RETURN_CARRY_REASONS = Object.freeze(['mention', 'reply', 'alert'])

export function returnCarryReason({ mentioned = false, repliedTo = false, alerted = null } = {}) {
  if (mentioned) return 'mention'
  if (repliedTo) return 'reply'
  if (alerted) return 'alert'
  return null                       // no signal is not a carry, and null is not a reason
}

export function alertHashtagHit(body, tTags, subscribed) {
  // One gate, not two. There was a type check here as well, and a mutation run showed nothing
  // could tell whether it was present — `alertHashtags` already refuses a non-string entry with a
  // reason, and a non-array outright. A guard no test can distinguish from its own absence is not
  // defence in depth; it is a second place for the rule to drift.
  const { tags } = alertHashtags(subscribed)
  if (!tags.length) return null
  const present = new Set()
  for (const t of (Array.isArray(tTags) ? tTags : [])) {
    if (typeof t === 'string' && t) present.add(alertHashtagKey(t))
  }
  const text = String(body == null ? '' : body)
  for (const tag of tags) {
    if (present.has(alertHashtagKey(tag))) return { tag, via: 't-tag' }
  }
  for (const tag of tags) {
    const re = alertHashtagMatcher(tag)
    if (re && re.test(text)) return { tag, via: 'body' }
  }
  return null
}
