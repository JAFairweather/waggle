// console_agent_empty_state.mjs — an empty agent roster is not an empty hive (#321).
//
// The Agents page listed nothing and said "Nobody is in this hive yet." An owner who had just
// issued a 440 grant read that as a broken bridge and went looking for the fault. There was none:
// a grant admits a key to the community, and the waggle lifecycle roster is a different registry
// that only this page writes to. #392 named that disagreement `grant_no_row` — "the agent can act,
// the roster denies it exists" — and this is the screen where an owner meets it.
//
// #321 is still open on WHICH registry should win, and this suite deliberately does not touch that.
// It pins only the part the issue settles regardless: the empty state must not assert absence.
//
// WHAT IS ASSERTED, AND HOW. The branch is extracted from the page and executed against a fake
// DOM, so the assertions are on the sentence an operator actually reads, not on source that
// merely contains the right words. A page whose script drifts from what it renders would pass a
// grep and fail here.
//
// The banned strings are exact claims of absence, not keywords. "empty hive" is in the CORRECT
// text, inside "that is not the same as an empty hive" — banning the words rather than the claim
// would forbid the fix and pass the bug.
//
//   node tests/console_agent_empty_state.mjs

import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FINDINGS } from '../src/registry_reconcile.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'console', 'agents.html')

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const inconclusive = (why) => {
  console.error(`console_agent_empty_state: INCONCLUSIVE — ${why}`)
  console.error('  This is NOT an all-clear: the invariant was not exercised.')
  process.exit(3)
}

const html = readFileSync(PAGE, 'utf8')
// Size floor. A page that failed to read is a page with no offending sentence in it, and it prints
// the same clean result as a page that was fixed.
if (html.length < 4000) inconclusive(`console/agents.html read back only ${html.length} bytes`)

// ---- extract the empty-roster branch -----------------------------------------------------------
const OPEN = 'if (!state.agents.length) {'
const CLOSE = '\n  for (const a of state.agents) {'
const from = html.indexOf(OPEN)
const to = html.indexOf(CLOSE, from)
if (from < 0 || to < 0) inconclusive(`ANCHOR MISS — the empty-roster branch was not found in agents.html (open=${from}, close=${to})`)
const branch = html.slice(from + OPEN.length, to).replace(/\n\s*return\s*\n\s*\}\s*$/, '')

// ---- render it against a fake DOM --------------------------------------------------------------
// Only the three things the branch touches. Anything else it reaches for should throw rather than
// be quietly absorbed, so a branch that grew a dependency fails loudly instead of rendering blank.
const renderBranch = (source) => {
  const text = (node) => node.children.map(c => (typeof c === 'string' ? c : text(c))).join('')
  const node = (tag) => ({ tag, children: [], href: null, className: null,
    set textContent(v) { this.children = v == null ? [] : [String(v)] },
    appendChild(c) { this.children.push(c); return c } })
  const el = (tag, cls, t) => { const n = node(tag); if (cls) n.className = cls; if (t != null) n.textContent = t; return n }
  const document = { createElement: node, createTextNode: (t) => String(t) }
  const list = node('div')
  // eslint-disable-next-line no-new-func
  new Function('el', 'document', 'list', source)(el, document, list)
  return { list, rendered: text(list) }
}

const { list, rendered } = renderBranch(branch)
// Floor deliberately low. It exists to catch a branch that rendered NOTHING, which would pass
// every banned-phrase check below for the wrong reason. Setting it anywhere near the length of a
// real sentence would report INCONCLUSIVE for the exact bug this suite is here to catch — the
// reported line, "Nobody is in this hive yet.", is 27 characters.
if (rendered.length < 10) inconclusive(`the branch rendered only ${rendered.length} characters — it is not saying anything to assert on`)
console.log(`\n  rendered: ${rendered}\n`)

// ---- 1. it does not claim the hive is empty -----------------------------------------------------
// Exact claims, not keywords. Each one was, or could plausibly be, the sentence on the page.
const ABSENCE_CLAIMS = [
  'Nobody is in this hive',
  'This hive has admitted no agents',
  'No agents',
  'no agents yet',
  'There are no agents',
]
const found = ABSENCE_CLAIMS.filter(c => rendered.includes(c))
check(found.length === 0,
  `the empty state makes no claim about the hive being empty${found.length ? ` (found: ${found.map(f => JSON.stringify(f)).join(', ')})` : ''}`)

// NEGATIVE CONTROL — the detector fires. A banned-phrase check that cannot find its own phrases
// reports the same clean pass on a page that was never fixed.
const asIfUnfixed = "list.appendChild(el('p', 'note', 'Nobody is in this hive yet. Letting someone in is a decision.'))"
const unfixed = renderBranch(asIfUnfixed).rendered
check(ABSENCE_CLAIMS.some(c => unfixed.includes(c)),
  'NEGATIVE CONTROL — the same check DOES flag the sentence this issue was filed about')

// And the ban is on the claim, not the vocabulary: the corrected text is allowed to discuss an
// empty hive in order to deny it. A keyword ban would have forbidden the fix.
check(!ABSENCE_CLAIMS.includes('empty hive') && rendered.includes('empty hive'),
  'NEGATIVE CONTROL — "empty hive" survives, because the fix uses those words to negate the claim')

// ---- 2. it says what a grant does, and where to look --------------------------------------------
check(/\b440\b/.test(rendered) && /grant/i.test(rendered),
  'it names the grant as the thing that admits a key without creating a row here')
check(/roster|seated|through this page/i.test(rendered),
  'it says what this list actually is, so the empty result has a scope')

const links = list.children.filter(c => typeof c !== 'string')
  .flatMap(c => c.children.filter(x => typeof x !== 'string' && x.tag === 'a'))
check(links.length === 1, `exactly one link out of the empty state (found ${links.length})`)
check(links[0]?.href === '/console/', `and it points at the Access page (href=${links[0]?.href})`)
check(/Access/.test(rendered), 'the link is named for the page it goes to')

// NEGATIVE CONTROL — the link scan is capable of finding nothing, so the 1 above is a measurement.
const bare = renderBranch("list.appendChild(el('p', 'note', 'nothing here'))")
check(bare.list.children.flatMap(c => (typeof c === 'string' ? [] : c.children))
  .filter(x => typeof x !== 'string' && x.tag === 'a').length === 0,
  'NEGATIVE CONTROL — the same scan finds no link in a branch that renders none')

// ---- 3. bound to the reconciler that named this ------------------------------------------------
// The sentence on the page is one half of a disagreement `src/registry_reconcile.mjs` describes in
// full. If that finding is renamed or dropped, the model behind this text has moved and somebody
// needs to re-read the text rather than discover the drift from an owner.
check(FINDINGS.grant_no_row?.authority === 'grant',
  `#392 still models this case as grant_no_row (authority=${FINDINGS.grant_no_row?.authority})`)
check(/roster/i.test(FINDINGS.grant_no_row?.detail || ''),
  'and still describes it as a grant the roster does not reflect')

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
