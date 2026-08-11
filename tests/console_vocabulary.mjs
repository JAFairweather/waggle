// The console must not speak the protocol's language at the person using it (#348).
//
// `admit`, `admitted` and `grant` are exact inside NIP-DA and close to meaningless to an owner
// deciding whether to let an agent into their community. `capability-vocabulary.mjs` already
// solved this for the capability itself; this suite is what stops the CHROME around it drifting
// back — a new button, a new table row, a new empty state.
//
// ── WHAT THIS SUITE DOES NOT COVER ────────────────────────────────────────────────────────────
// Part 1 scans static HTML with <script> and <style> removed. It therefore cannot see a string
// that only exists inside inline JS and reaches the DOM at runtime. That is not an oversight to
// be fixed by a cleverer regex — an HTML-shaped regex over JS template literals would report
// confident nonsense. Part 2 covers the JS side the only way that is trustworthy: by IMPORTING
// the modules that hold the copy and checking the exported values. Copy that lives in neither
// place — a literal buried in a page's own script — is unchecked, and a reviewer should treat a
// new one as a reason to move it into a vocabulary module rather than to widen this file.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let pass = 0, fail = 0
const ok = (name, value) => { console.log(`${value ? 'ok  ' : 'FAIL'} — ${name}`); value ? pass++ : fail++ }

const CONSOLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'console')

// The words themselves. `admit` catches `admitted`/`admitting`, `admission` is a SEPARATE stem
// and was missed by a first version of this pattern that only had `admit\w*` — four live
// occurrences in agents.html sailed through a green check. `grant` catches `grants`/`granted`.
// Two forms of the same pattern: `matchAll` needs /g, and `test()` on a /g regex carries
// `lastIndex` between calls and silently returns false on every other invocation.
const WORDS_SRC = String.raw`\b(?:admi(?:t|ssion)\w*|grant\w*)\b`
const PROTOCOL_WORDS = new RegExp(WORDS_SRC, 'gi')
const hasProtocolWord = (s) => new RegExp(WORDS_SRC, 'i').test(String(s))

// Strip the parts of an HTML file that are not read by a person, then keep only what is.
// `content=` is included because a meta description is read — in search results and link
// previews — even though it never renders on the page.
const visibleText = (html) => {
  const stripped = String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const text = stripped.replace(/<[^>]*>/g, '')          // element boundaries -> a marker
  const metas = [...String(html).matchAll(/<meta[^>]*name=["'](?:description)["'][^>]*content=["']([^"']*)["']/gi)].map(m => m[1])
  const attrs = [...stripped.matchAll(/\b(?:placeholder|title|aria-label)=["']([^"']*)["']/gi)].map(m => m[1])
  return [text, ...metas, ...attrs].join('')
}

const files = readdirSync(CONSOLE_DIR).filter(f => f.endsWith('.html')).sort()

// A scan of nothing reports everything clean. Put a floor under the input before believing the
// output — this repo has had a scan of an empty file come back green.
ok(`there are console pages to scan at all (found ${files.length})`, files.length >= 5)

const findings = []
for (const f of files) {
  const html = readFileSync(join(CONSOLE_DIR, f), 'utf8')
  ok(`  ${f} is large enough to be the real page (${html.length} bytes)`, html.length > 500)
  for (const m of visibleText(html).matchAll(PROTOCOL_WORDS)) findings.push(`${f}: "${m[0]}"`)
}

ok('no console page shows a person the words "admit" or "grant"',
  findings.length === 0)
if (findings.length) for (const x of findings.slice(0, 20)) console.log(`       ${x}`)

// ── the negative control ──────────────────────────────────────────────────────────────────────
// A scanner that has only ever passed is indistinguishable from one that looks nowhere. Feed it
// a page that IS bad and require it to say so — including one word inside a <script> and one
// inside a <style>, which it must NOT report, or the exemptions above are not doing their job.
const KNOWN_BAD = `<!doctype html><meta name="description" content="Live admissions.">
  <style>.admitted{color:red}</style>
  <h2>Admitted agents</h2><button id="admit">Admit as a member</button>
  <p>They are admitted only by your signed grant.</p>
  <script>const STATUSES = ['admitted']; const grantee = 1</script>`
const controlHits = [...visibleText(KNOWN_BAD).matchAll(PROTOCOL_WORDS)].map(m => m[0].toLowerCase())
ok('the scanner reports a page that IS bad (negative control)', controlHits.length > 0)
// Named individually rather than counted: a count is satisfied by finding the same word four
// times, which would not prove the meta description or the `admission` stem is reached at all.
ok('  it sees the heading, the button and the prose',
  controlHits.filter(w => w.startsWith('admit')).length >= 3 && controlHits.includes('grant'))
ok('  it reaches the meta description, which renders nowhere but is still read',
  controlHits.includes('admissions'))
ok('  and it does NOT report the wire value in <script> or the class in <style>',
  !/<script|STATUSES|grantee/.test(visibleText(KNOWN_BAD)))

// ── Part 2: the copy that lives in modules, checked by importing it ───────────────────────────
const { CAP_SENTENCE, CAP_LABEL, PLANE_COPY, ISSUABLE, describeGrant } = await import('../console/capability-vocabulary.mjs')
const { LANE_VIEW, DROP_VIEW, laneLabel } = await import('../console/routing-model.mjs')

// KEYS are wire values and must keep saying `admit` — only the values are read by a person.
const clean = (s) => !hasProtocolWord(s)
// The sentences are checked RENDERED, not as templates. `{grantee}` is a placeholder that no
// person ever sees — asserting on the raw template would report a finding for a word that is
// substituted away before it reaches a screen, and the only way to satisfy it would be to break
// the two-party structure that must not bend. A real name goes in, and a real name has a space
// in it: the 2026-08-01 outage was a name with a space against fixtures that had none.
const rendered = Object.keys(CAP_SENTENCE).map(cap =>
  describeGrant({ cap, grantee: 'My Dude', subject: 'Field Notes' }))
ok('every rendered capability sentence still names both parties',
  rendered.every(s => s.includes('My Dude') && s.includes('Field Notes')))
const allValues = [
  ...rendered,
  ...Object.values(CAP_LABEL),
  ...Object.values(PLANE_COPY).flatMap(p => [p.title, p.question, p.enforcedBy, p.caution]),
  ...Object.values(ISSUABLE).flat().map(i => i.reason).filter(Boolean),
  ...LANE_VIEW.flatMap(l => [l.label, l.dest, l.why, l.from]),
  DROP_VIEW.label, DROP_VIEW.dest, DROP_VIEW.why,
]
ok('every sentence, label and reason a person reads is free of protocol vocabulary',
  allValues.every(clean))
for (const v of allValues) if (!clean(v)) console.log(`       "${v}"`)

// The wire keys are still the wire keys. A rename here would be a protocol change, and this
// assertion is what makes the one above safe to satisfy by editing copy rather than by editing
// the capability set.
ok('the capability KEYS are untouched — copy changed, wire did not',
  Object.keys(CAP_SENTENCE).includes('admit') && Object.keys(CAP_SENTENCE).includes('admit+read'))
ok('the lane ids are untouched, and the label is a separate field',
  LANE_VIEW[1].id === 'granted participant' && laneLabel(LANE_VIEW[1]) !== LANE_VIEW[1].id)
// laneLabel must fall back rather than invent: an unlabelled lane shows its raw id.
ok('  an unlabelled lane renders its raw id rather than a friendly guess',
  laneLabel({ id: 'some new lane' }) === 'some new lane')

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
