// The at-word an owner-managed task route matches on — #404.
//
// This is the SOURCE. `console/task-route-mention.mjs` is a byte-identical browser copy, because
// the console page is served from `console/` only and cannot import `src/`; `tests/
// task_route_mention.mjs` is the join that keeps them from drifting. Same arrangement as
// src/lanes.mjs ↔ console/routing-model.mjs.
//
// What it replaces, and why. Both halves used to require /^[a-z0-9][a-z0-9_-]{0,31}$/ and
// lowercase the value before storing it. The matcher (bridge.mjs, scanReturnLane) runs against the
// raw channel body, and Buzz writes the at-word from the member's `display_name` — so the body
// holds `@MC Claude` or `@My Dude`, with a space and a capital. A SPACED name was therefore
// unreachable: the grammar refused it at the form, and no value the grammar accepted could contain
// the space needed to match. (A single-token name such as `codex` or `Dennis` did work under the
// old grammar — the original framing in #404 overstated this as "no working input existed", which
// is corrected here because `docs/` inherits this header.)
//
// `return_lane` never had the restriction and has always held spaced names, so the widening here
// is the two halves agreeing with the mechanism, not a new capability.
//
// STORE WHAT THE OPERATOR TYPED. The matcher is already case-insensitive, so lowercasing on the
// way in buys nothing and loses the name the operator will read back in the console. Case folding
// belongs in the COMPARISON (taskRouteMentionKey), which is the only place two mentions are ever
// asked whether they are the same route.

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

// Does this body name this mention? True in isolation — see the arbitration below for what happens
// when a second route's mention also matches the same at-word.
export function taskRouteMentioned(body, mention) {
  const re = taskRouteMentionMatcher(mention)
  return !!re && re.test(String(body == null ? '' : body))
}

// ARBITRATION (#407, #409). A boundary cannot settle `@MC Claude` when both `mc` and `MC Claude`
// are routed in one channel, because the separator has to be two things at once. A space must
// TERMINATE a mention, or a route named `My Dude` would never match `@My Dude and …`. A space must
// also be INTERIOR to a mention, or `MC Claude` could not be a name at all. Both readings of
// `@MC Claude` are correct — one mention, or `mc` followed by the word "Claude" — so what is
// missing is arbitration, not a better character class. #411 withheld the space from the boundary
// deliberately and could not have fixed this; including the space would have broken every spaced
// mention instead.
//
// LONGEST WINS, PER `@` POSITION. Every candidate must begin at the SAME `@`, so the candidates at
// one position are all prefixes of one span and are totally ordered by length. That dissolves the
// awkward case raised in #409 — `MC Claude` against `Claude Ops` in `@MC Claude Ops` — because
// `Claude Ops` has no `@` in front of it there and is not a candidate at that position at all.
// Ties are impossible: two mentions matching the same span with the same length are the same
// mention case-folded, and those are collapsed to one row before the scan.
//
// A mention that loses at one at-word and wins at another IS CARRIED. Suppression is a statement
// about a single at-word, never about a route, which is why `carried` is resolved before
// `suppressed` is answered.
//
// Returns { carried, suppressed }: `carried` maps mention key -> mention as written; `suppressed`
// maps mention key -> { mention, by, at }, naming the longer mention that took the at-word and
// where. The caller logs from `suppressed` — a route that silently stops receiving a carry it used
// to receive presents as the return lane being flaky, which is the failure this repo keeps paying
// for.
export function taskRouteMentionArbitrate(body, mentions) {
  const text = String(body == null ? '' : body)
  const rows = []
  for (const value of (Array.isArray(mentions) ? mentions : [])) {
    const m = String(value == null ? '' : value).replace(/^@/, '')
    if (!m) continue
    const key = taskRouteMentionKey(m)
    if (rows.some(row => row.key === key)) continue
    // Sticky, so a candidate is tested AT the at-word rather than anywhere after it. A non-sticky
    // test would let a mention later in the body win an at-word it does not start.
    rows.push({ mention: m, key, re: new RegExp(`@${m.replace(RE_ESCAPE, '\\$&')}(?![${MENTION_ALPHABET}])`, 'iuy') })
  }
  const carried = new Map()
  const contested = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue
    let winner = null
    const hits = []
    for (const row of rows) {
      row.re.lastIndex = i
      if (!row.re.test(text)) continue
      hits.push(row)
      if (!winner || row.mention.length > winner.mention.length) winner = row
    }
    if (!winner) continue
    carried.set(winner.key, winner.mention)
    for (const row of hits) if (row.key !== winner.key) contested.push({ row, by: winner.mention, at: i })
  }
  const suppressed = new Map()
  for (const { row, by, at } of contested) {
    if (carried.has(row.key) || suppressed.has(row.key)) continue   // won elsewhere, or already recorded
    suppressed.set(row.key, { mention: row.mention, by, at })
  }
  return { carried, suppressed }
}
