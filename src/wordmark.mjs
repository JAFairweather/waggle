// wordmark.mjs — `waggle` is always lowercase, and now something checks (#394).
//
// The rule is in CLAUDE.md under "claims that must never drift", and docs/AGENT_BRIEF.md states it
// to every agent we onboard. It had no mechanism, and it was wrong in 25 places across 7 files —
// including the README's first sentence and the title of the external review packet. Same shape as
// the suite-count drift of #172, and drifted for the same reason: maintained by hand.
//
// WHAT COUNTS AS CODE, AND WHY THE ANSWER IS "ONLY BACKTICKS". The obvious implementation also
// strips fenced and indented blocks, on the theory that a capital inside code may be a real
// identifier. Written that way first, it reported 22 instead of 25 — and the three it dropped were
// all prose:
//
//   - an ASCII architecture DIAGRAM inside a fence ("| Waggle verifies source and carries…"),
//     which a reader sees rendered exactly as written;
//   - an indented <img> tag whose alt text a screen reader reads aloud.
//
// A fence in this repo holds diagrams as often as code. So only inline backticks are stripped, and
// the permissive scan was checked against every Markdown file in the repo for false positives:
// there are none. If a genuine `Waggle` identifier ever appears in a fenced block, wrap it in
// backticks or add it to the quoting list below — deliberately, not by widening the blind spot.

// Inline code only. A capital inside backticks is far more likely to be an identifier than prose,
// and unlike a fence it is never a diagram.
const INLINE = /`[^`\n]*`/g

// `Waggle` as a standalone capitalised word. Not WAGGLE (screaming case is its own convention —
// WAGGLE_BRIEF.md, and AGENT_BRIEF names it in order to ban it), not Waggles, and not a path or URL
// segment such as docs/assets/waggle-… — hence the lookbehind on /.- as well as word characters.
const BARE = /(?<![\w/.-])Waggle(?![\w])/

/**
 * Lines that quote the rule in order to state it. Without this the guard is unfixable: the fix for
 * "never write Waggle" is a sentence containing the word Waggle.
 */
const QUOTING = /never\s+Waggle|not\s+Waggle|always\s+lowercase|lowercase.*Waggle/i

/**
 * Every place a Markdown file capitalises the wordmark.
 *
 * @param text  the file's contents
 * @returns Array<{ line, text }> — 1-indexed, because a guard that says "something is wrong
 *          somewhere" gets ignored. Line numbers survive the inline-code strip: matches are
 *          blanked to spaces rather than deleted.
 */
export function findWordmarkViolations(text) {
  if (typeof text !== 'string') return []
  const out = []
  text.split('\n').forEach((line, i) => {
    if (QUOTING.test(line)) return
    const scanned = line.replace(INLINE, m => ' '.repeat(m.length))
    if (BARE.test(scanned)) out.push({ line: i + 1, text: line.trim().slice(0, 120) })
  })
  return out
}

/** One actionable line per violation: file, line, and the prose it is in. */
export function describeWordmarkViolation(file, violation) {
  return `${file}:${violation.line}: capitalised wordmark — ${violation.text}`
}
