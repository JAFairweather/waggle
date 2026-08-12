// Browser copy of src/task_route_mention.mjs — #404.
//
// The console page is served from `console/` only and cannot import `src/`, so the grammar lives
// twice. Everything from the first `export` down is BYTE-IDENTICAL to the source file, and
// tests/task_route_mention.mjs asserts exactly that as well as comparing the two behaviourally.
// If you change one, change both; the suite fails on the first byte of difference.

export const TASK_ROUTE_MENTION_MAX = 32

// Broadcast at-words. Routing one of these binds an agent to every "@everyone" in the channel,
// which is a fan-out, not a route. Compared case-folded.
const RESERVED = new Set(['everyone', 'here', 'channel', 'all'])

// THE ALPHABET, written once (#408). Everything below derives from this string, and so does the
// matcher's word boundary in scanReturnLane. That is the whole point of hoisting it: the boundary
// `(?![\w-])` used to be correct only because the grammar was the slug alphabet `[a-z0-9_-]`, so
// every admissible character was already in `\w` or was `-` — the boundary class and the grammar
// were THE SAME SET. #404 widened the grammar and left the boundary alone, and the invariant broke
// silently: a route named `Dr` was carried `@Dr. Watson`, because `.` ends `\w` and so looked like
// the end of the name. Two classes that must agree must not be two literals.
//
// The separator is deliberately NOT in here — it is added for the allowlist and withheld from the
// boundary, which is the one real difference between the two. A space may appear INSIDE a mention
// and must not terminate it; every other admissible character must.
const MENTION_ALPHABET = "\\p{L}\\p{N}_.'\\-"

// Allowlist, one character at a time — the whole point is that nothing has to be enumerated as
// dangerous. A control character, a newline, a NBSP, a zero-width space and a second `@` are all
// refused because none of them is a letter, a number, or one of `_ - . '`. Written as four small
// checks rather than one shape regex on purpose: each fault gets its own sentence, and a class
// nobody can read is a class nobody can check.
const ALLOWED_CHAR = new RegExp(`[${MENTION_ALPHABET} ]`, 'u')
const STARTS_WELL = /^[\p{L}\p{N}]/u

const codepoint = ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`

// null when the value is a usable mention, otherwise the reason — and the reason is the product.
// `!ok` cannot tell a correct refusal from a correct refusal with a misleading message, and this
// message is the entire content of the console's error line. An invisible character in particular
// is named by codepoint and position, because "invalid mention" sends an operator hunting.
export function taskRouteMentionProblem(value) {
  if (typeof value !== 'string') return 'mention must be text'
  const raw = value.replace(/^@/, '')
  if (!raw) return 'mention is empty'
  if (raw.length > TASK_ROUTE_MENTION_MAX) return `mention is longer than ${TASK_ROUTE_MENTION_MAX} characters`
  if (raw.includes('@')) return 'mention holds a second @ — a route names one agent, not an at-word inside a sentence'
  if (/^\s|\s$/.test(raw)) return 'mention cannot start or end with a space'
  for (const [i, ch] of [...raw].entries()) {
    if (!ALLOWED_CHAR.test(ch)) return `mention holds an unsupported character at position ${i + 1} (${codepoint(ch)}) — letters, numbers, spaces and _ - . ' only`
  }
  if (!STARTS_WELL.test(raw)) return 'mention must start with a letter or number'
  if (raw.includes('  ')) return 'mention must separate words with a single space'
  if (RESERVED.has(raw.toLowerCase())) return `@${raw} is a broadcast at-word, not an agent`
  return null
}

// The value as STORED: the operator's own casing and spacing, with at most one leading `@` off.
// null when unusable — callers that need to say why call taskRouteMentionProblem.
export function taskRouteMention(value) {
  return taskRouteMentionProblem(value) === null ? String(value).replace(/^@/, '') : null
}

// The COMPARISON key. Folded the same way the matcher's `i` flag folds, so `@MC Claude` and
// `@mc claude` are one route rather than two rows that both fire.
export const taskRouteMentionKey = value => String(value == null ? '' : value).toLowerCase()

// THE MATCHER (#408). Lives here, next to the alphabet it depends on, rather than as a regex
// literal in scanReturnLane — the defect this replaces was precisely those two drifting apart.
//
// The trailing lookahead says "the name has not ended here". It is the alphabet MINUS the
// separator: any character that may appear inside a mention would mean the at-word in the body is
// a longer name than this route, and only a space is exempt because a space may be interior.
// Keeping `\p{L}`/`\p{N}` in the class also keeps every ASCII letter and digit that `\w` used to
// contribute, which is what still stops a route named `every` matching `@everyone` and `chan`
// matching `@channel` — the one direction the old boundary got right.
//
// There is deliberately no LEADING boundary. Buzz writes the at-word at a word start, and adding
// one would be a behaviour change beyond this fix; `mail@Dennis` matching is pre-existing and
// belongs to whoever revisits it.
const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g
export function taskRouteMentionMatcher(mention) {
  const m = String(mention == null ? '' : mention).replace(/^@/, '')
  if (!m) return null
  return new RegExp(`@${m.replace(RE_ESCAPE, '\\$&')}(?![${MENTION_ALPHABET}])`, 'iu')
}

// Does this body name this mention? The one question scanReturnLane actually asks.
export function taskRouteMentioned(body, mention) {
  const re = taskRouteMentionMatcher(mention)
  return !!re && re.test(String(body == null ? '' : body))
}
