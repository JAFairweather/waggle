// The task-route mention handle — #404.
//
// The defect this exists to have caught: `console/task-routes.mjs` and `normalizedTaskRoute` held
// the handle to /^[a-z0-9][a-z0-9_-]{0,31}$/ and lowercased it, while the matcher in
// scanReturnLane builds `new RegExp('@' + mention + '(?![\\w-])', 'i')` and runs it against the
// raw Buzz body — which holds the member's display_name, "@MC Claude" or "@My Dude". Every value
// the form accepted failed to match; every value that would have matched was refused. There was
// no working input, and 82 suites were green over it.
//
// They were green because every mention fixture in the tree was one lowercase word (`bumble`,
// `claude`, `codex`, `dennis`), and the only fixtures with a space were hostile inputs asserted to
// be REJECTED. So the shape of this suite is the remedy from CLAUDE.md, applied literally:
//
//   • every refusal is PAIRED with a legitimate spaced name that must still get through,
//   • every refusal asserts its REASON, not just `!ok` — the message is the whole thing an
//     operator acts on, and a correct refusal with a misleading message reads identically,
//   • the acceptances are proved END TO END through the real matcher, not through the validator,
//     because the validator and the matcher agreeing is exactly what was missing,
//   • fixtures are production-shaped: real crew names, with spaces and capitals.
//
//   node tests/task_route_mention.mjs

import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { getPublicKey, generateSecretKey, finalizeEvent } from 'nostr-tools/pure'

import { taskRouteMentionProblem, taskRouteMention, taskRouteMentionKey, TASK_ROUTE_MENTION_MAX,
  taskRouteMentioned, taskRouteMentionMatcher }
  from '../src/task_route_mention.mjs'

let fails = 0
const ok = (name, cond, detail = '') => {
  if (cond) return console.log(`ok   — ${name}`)
  fails++
  console.log(`FAIL — ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------------------------
// 1. The grammar. Accepts and refusals in ONE table so neither half can be extended alone.
// ---------------------------------------------------------------------------------------------
console.log('grammar — accept and refuse, paired')

// Names that must route. These are what Buzz display names actually look like.
const ACCEPT = [
  ['My Dude', 'My Dude'],
  ['MC Claude', 'MC Claude'],
  ['@My Dude', 'My Dude'],                       // one leading @ is stripped, the name is kept
  ['Dennis', 'Dennis'],
  ['codex', 'codex'],
  ['mc-claude', 'mc-claude'],                    // a slug is still a legal name, just not the only one
  ['agent_1', 'agent_1'],
  ["Sarah O'Brien", "Sarah O'Brien"],
  ['Dr. Who 3', 'Dr. Who 3'],
  ['José Ramírez', 'José Ramírez'],   // non-ASCII letters are letters
  ['A'.repeat(TASK_ROUTE_MENTION_MAX), 'A'.repeat(TASK_ROUTE_MENTION_MAX)],
]
for (const [input, stored] of ACCEPT) {
  ok(`accepts ${JSON.stringify(input)}`, taskRouteMentionProblem(input) === null,
    String(taskRouteMentionProblem(input)))
  ok(`stores ${JSON.stringify(input)} as typed — no lowercasing`, taskRouteMention(input) === stored,
    JSON.stringify(taskRouteMention(input)))
}

// Refusals, each with the exact reason. `!ok` cannot tell these apart, and the operator reads the
// reason, so the reason is what is asserted.
//
// Every invisible character below is written as an ESCAPE, never as a literal: a literal NUL and a
// literal NBSP have each broken tooling in this repo, and a shell heredoc once silently ate the
// character a check existed to exercise, reporting a pass for a case it never ran.
const REFUSE = [
  ['everyone', /broadcast at-word/],
  ['@everyone', /broadcast at-word/],
  ['Everyone', /broadcast at-word/],             // folded, so the fold cannot be walked around
  ['here', /broadcast at-word/],
  ['channel', /broadcast at-word/],
  ['all', /broadcast at-word/],
  ['Dennis @everyone', /second @/],              // the 2026-08-01 shape: an at-word inside a value
  ['My Dude @here', /second @/],
  [' My Dude', /start or end with a space/],
  ['My Dude ', /start or end with a space/],
  ['My  Dude', /single space/],                  // a double space would never match the body
  ['My\u00A0Dude', /U\+00A0/],                   // NBSP, named by codepoint
  ['My\u200BDude', /U\+200B/],                   // zero-width space
  ['My\u0000Dude', /U\+0000/],
  ['My\nDude', /U\+000A/],
  ['My\tDude', /U\+0009/],
  ['-leading', /start with a letter or number/],
  ['.hidden', /start with a letter or number/],
  ['', /empty/],
  ['@', /empty/],
  ['A'.repeat(TASK_ROUTE_MENTION_MAX + 1), /longer than 32/],
  [null, /must be text/],
  [42, /must be text/],
]
for (const [input, reasonRe] of REFUSE) {
  const problem = taskRouteMentionProblem(input)
  ok(`refuses ${JSON.stringify(input)}`, problem !== null)
  ok(`  …and says why: ${reasonRe}`, typeof problem === 'string' && reasonRe.test(problem),
    JSON.stringify(problem))
  ok('  …and stores nothing', taskRouteMention(input) === null)
}

// Distinct is not enough on its own, but collapsing IS a failure: seven fault families told apart
// in seven sentences, or the operator is told "invalid" seven ways that mean the same thing.
{
  const families = ['everyone', 'Dennis @everyone', 'My\u00A0Dude', ' My Dude', 'My  Dude', '-leading', '']
  const messages = families.map(taskRouteMentionProblem)
  ok('the seven fault families produce seven different messages',
    new Set(messages).size === families.length, messages.join(' | '))
}

// Comparison folds, storage does not. Both directions — a fold that made everything equal would
// pass the first assertion alone.
ok('two spellings of one name compare equal',
  taskRouteMentionKey('MC Claude') === taskRouteMentionKey('mc claude'))
ok('two different names do NOT compare equal',
  taskRouteMentionKey('MC Claude') !== taskRouteMentionKey('My Dude'))

// ---------------------------------------------------------------------------------------------
// 2. The join. `console/task-route-mention.mjs` is a copy because the page cannot import src/.
// ---------------------------------------------------------------------------------------------
console.log('\nthe console copy cannot drift')

const shared = url => {
  const text = readFileSync(url, 'utf8')
  const at = text.indexOf('export const TASK_ROUTE_MENTION_MAX')
  return at === -1 ? null : text.slice(at)
}
const srcShared = shared(new URL('../src/task_route_mention.mjs', import.meta.url))
const copyShared = shared(new URL('../console/task-route-mention.mjs', import.meta.url))
ok('both files carry the shared section', typeof srcShared === 'string' && typeof copyShared === 'string')
ok('the shared section is byte-identical', srcShared === copyShared)
// Size floor: two empty reads compare equal, and would report clean.
ok('the shared section is not empty', (srcShared || '').length > 500, `${(srcShared || '').length} bytes`)

// A real import, not a scrape — a renamed export fails to resolve instead of quietly matching
// nothing (the reasoning src/lanes.mjs ↔ console/routing-model.mjs already records).
const copy = await import('../console/task-route-mention.mjs')
ok('the copy exports the same surface',
  ['taskRouteMentionProblem', 'taskRouteMention', 'taskRouteMentionKey', 'TASK_ROUTE_MENTION_MAX']
    .every(k => k in copy))
const corpus = [...ACCEPT.map(([v]) => v), ...REFUSE.map(([v]) => v)]
ok('the copy returns the same verdict AND the same reason for every fixture',
  corpus.every(v => copy.taskRouteMentionProblem(v) === taskRouteMentionProblem(v)))
ok('and the same stored value', corpus.every(v => copy.taskRouteMention(v) === taskRouteMention(v)))

// Nobody restates the grammar. One missed copy is a console that refuses what the bridge accepts.
{
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) { if (entry.name !== 'vendor' && entry.name !== 'assets') walk(rel); continue }
      if (!/\.(mjs|html)$/.test(entry.name)) continue
      if (rel === 'src/task_route_mention.mjs' || rel === 'console/task-route-mention.mjs') continue // the definitions
      // The mention grammar exactly, not any slug: `[a-z_][a-z0-9_-]{0,31}` is a POSIX USERNAME
      // and lives legitimately in three policy modules. Matching that too would make this check
      // fire on unrelated code, and a check that cries wolf is a check that gets deleted.
      if (/\[a-z0-9\]\[a-z0-9_-\]\{0,31\}/.test(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'))) offenders.push(rel)
    }
  }
  for (const root of ['console', 'src', 'tools', 'deploy']) walk(root)
  ok('no file restates the old slug grammar', offenders.length === 0, offenders.join(', '))
}

ok('the console page validates through the shared module',
  /from '\.\/task-route-mention\.mjs'/.test(readFileSync(new URL('../console/task-routes.mjs', import.meta.url), 'utf8')))

// ---------------------------------------------------------------------------------------------
// 3. END TO END, through the real matcher. This is the assertion the tree did not have.
// ---------------------------------------------------------------------------------------------
console.log('\nend to end — a spaced display name reaches its agent')

const dir = mkdtempSync(resolve(tmpdir(), 'wb-mention-'))
const bridgeSk = generateSecretKey()
const myDude = getPublicKey(generateSecretKey())
const mcClaude = getPublicKey(generateSecretKey())
const crewSk = generateSecretKey(), crew = getPublicKey(crewSk)
const channel = 'a8186b53-537d-46ad-a7e7-b6486c58970e'

writeFileSync(resolve(dir, 'config.json'), JSON.stringify({ relays: [], recipients: [], public: {
  relays: ['wss://example.invalid'], inbox: 'chan', staging_inbox: 'chan',
  watch_authors: [], watch_events: [], approvers: [], grantors: [],
  scan_authors: [], scan_channels: [],
  task_routes: [
    { participant: myDude, sender: crew, channel, mention: 'My Dude', protocol: 'nvoy-task-carry-v1' },
    { participant: mcClaude, sender: crew, channel, mention: 'MC Claude', protocol: 'nvoy-task-carry-v1' },
  ],
} }))
process.env.CONFIG_PATH = resolve(dir, 'config.json')
process.env.SEND_JOURNAL_PATH = resolve(dir, 'send-journal.log')
process.env.SEEN_PATH = resolve(dir, 'seen.log')
process.env.POSTED_MAP_PATH = resolve(dir, 'posted.log')
process.env.RLSEEN_PATH = resolve(dir, 'rlseen.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.FORWARD_MODE = 'buzz'
process.env.WB_STUB_SEND = '1'
process.env.WB_NO_BOOT = '1'

const { scanReturnLane, PUB, grantSet } = await import('../src/bridge.mjs')
grantSet.set(myDude, { grantId: '1'.repeat(64), grantor: crew })
grantSet.set(mcClaude, { grantId: '2'.repeat(64), grantor: crew })

ok('both spaced routes survive config parsing', PUB.taskRoutes.length === 2)
ok("and keep the operator's casing on the way in",
  PUB.taskRoutes.map(r => r.mention).sort().join('|') === 'MC Claude|My Dude',
  PUB.taskRoutes.map(r => r.mention).join('|'))

const journal = () => existsSync(process.env.SEND_JOURNAL_PATH)
  ? readFileSync(process.env.SEND_JOURNAL_PATH, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []
let seq = 0
async function carriedBy(body) {
  const before = journal().filter(r => r.lane === 'return').length
  const wire = JSON.parse(JSON.stringify(finalizeEvent(
    { kind: 9, created_at: 1000 + (seq++), tags: [['h', channel]], content: body }, crewSk)))
  await scanReturnLane([wire], { authors: PUB.scanAuthors, channel })
  return journal().filter(r => r.lane === 'return').slice(before).map(r => r.to).sort()
}
const short = k => k.slice(0, 12)

// The positive half. Both names, in one message, through the matcher in scanReturnLane.
let to = await carriedBy('@My Dude and @MC Claude — please both look at this.')
ok('"@My Dude" and "@MC Claude" BOTH reach their agent',
  to.length === 2 && to.join('|') === [short(myDude), short(mcClaude)].sort().join('|'), to.join('|'))

to = await carriedBy('hey @my dude, one more thing')
ok("matching ignores case, so the operator's casing is not a second thing to get right",
  to.length === 1 && to[0] === short(myDude), to.join('|'))

// NEGATIVE CONTROLS, so the positives above are not "everything is carried".
to = await carriedBy('@My Dudette is a different person')
ok('a longer name that merely starts the same does NOT route', to.length === 0, to.join('|'))
to = await carriedBy('no at-words in this message at all')
ok('a message naming nobody routes to nobody', to.length === 0, to.join('|'))
to = await carriedBy('@Dennis has this one')
ok('an at-word with no route routes to nobody', to.length === 0, to.join('|'))

// The pre-fix failure, restated as a live assertion: the slug the old form produced is not what
// Buzz writes into the body, so it must not be what routes.
to = await carriedBy('@mydude what do you think')
ok('the old slug form of the name does not route — the display name is the handle',
  to.length === 0, to.join('|'))

// ---------------------------------------------------------------------------------------------
// 5. The word boundary, which must be the mention alphabet minus the separator (#408).
// ---------------------------------------------------------------------------------------------
// `(?![\w-])` was correct only while the grammar WAS the slug alphabet: every admissible character
// was in `\w` or was `-`, so the boundary class and the grammar were the same set. #404 widened the
// grammar and left the boundary alone, and a route named `Dr` began receiving `@Dr. Watson` while
// the real `Dr. Watson` received nothing. Two classes that must agree cannot be two literals, so
// the matcher now derives from MENTION_ALPHABET — and this table is what says so.
//
// Both directions in ONE table, deliberately: a boundary that only ever suppresses cannot be told
// from one that suppresses everything, and that is the exact failure mode this repo keeps paying
// for. `carry: false` rows are the fix; `carry: true` rows are the proof it did not overreach.
console.log('\nboundary — the alphabet minus the separator, both directions')

const BOUNDARY = [
  // [mention, body, must it carry?, why this row exists]
  ['Dr',        '@Dr. Watson — please look',   false, 'the #408 defect itself: `.` is not in \\w, so the old boundary ended the name'],
  ['Dan',       "@Dan'ielle can you check",    false, "`'` is not in \\w either"],
  ['Jos',       '@José replied',               false, 'a non-ASCII letter is not in \\w — \\w is ASCII-only'],
  ['My Dude',   '@My Dudeé said no',           false, 'the same hole one word later'],
  ['My Dude',   "@My Dude's Assistant will",   false, "a possessive is a different name, not this one"],
  ['every',     '@everyone gather round',      false, 'the direction the OLD boundary got right — must stay right'],
  ['chan',      '@channel wide notice',        false, 'ditto: the class must keep \\w\'s ASCII letters'],
  ['Dr. Watson', '@Dr. Watson — please look',  true,  'the real recipient, who received nothing before'],
  ['My Dude',   '@My Dude — please look',      true,  'the ordinary case must survive the fix'],
  ['My Dude',   '@my dude — please look',      true,  'still case-insensitive'],
  ['My Dude',   '@My Dude! urgent',            true,  'ordinary punctuation still ends the name'],
  ['My Dude',   '@My Dude, and also',          true,  'a comma is not part of a name'],
  ["O'Brien",   "@O'Brien please review",      true,  'an apostrophe INSIDE the name still matches'],
  ['codex',     '@Codex please look',          true,  'a single-token name — this always worked, and must keep working'],
  ['MC Claude', '@MC Claude — please look',    true,  'a space is interior and must not terminate'],
  ['MC',        '@MC Claude — please look',    true,  'NOT fixed here and deliberately so — see #409, the ambiguity is a design call'],
]
for (const [mention, body, want, why] of BOUNDARY) {
  ok(`${want ? 'carries' : 'suppresses'} ${JSON.stringify(mention)} in ${JSON.stringify(body)} — ${why}`,
    taskRouteMentioned(body, mention) === want)
}

// A table of literals proves the table. This proves the RULE the table is drawn from, so a future
// widening of the grammar cannot pass by leaving the boundary behind — which is the whole defect.
{
  const interior = [...'\u00e9A9_.\'-']            // one character from each part of the alphabet
  const missed = interior.filter(ch => taskRouteMentioned(`@Ann${ch}x`, 'Ann'))
  ok('every non-separator character in the alphabet terminates a shorter route',
    missed.length === 0, `leaked: ${JSON.stringify(missed)}`)
  ok('  …and the separator does NOT, because a space may be interior to a name',
    taskRouteMentioned('@Ann Boleyn', 'Ann'))
}

// Size floor and a live matcher, so an empty or broken input cannot report clean.
ok('the matcher is a real RegExp with the unicode flag', taskRouteMentionMatcher('My Dude') instanceof RegExp &&
  taskRouteMentionMatcher('My Dude').flags.includes('u'))
ok('an empty mention yields no matcher rather than one that matches everything',
  taskRouteMentionMatcher('') === null && taskRouteMentioned('@anything', '') === false)
ok('the boundary table is not empty', BOUNDARY.length >= 16, `${BOUNDARY.length} rows`)
ok('and holds both verdicts', BOUNDARY.some(r => r[2]) && BOUNDARY.some(r => !r[2]))

// Every admitted codepoint, in an interior position: the matcher must build and must find its own
// at-word. Adding the `u` flag changes escape semantics, so this is checked rather than assumed.
{
  let built = 0, threw = 0, missedSelf = 0
  for (let cp = 0x20; cp <= 0x2FFF; cp++) {
    const ch = String.fromCodePoint(cp)
    if (taskRouteMentionProblem(`A${ch}B`) !== null) continue
    built++
    try { if (!taskRouteMentioned(`@A${ch}B stop`, `A${ch}B`)) missedSelf++ } catch { threw++ }
  }
  ok(`every admitted codepoint builds a matcher that finds its own at-word (${built} admitted)`,
    built > 1000 && threw === 0 && missedSelf === 0, `threw=${threw} missedSelf=${missedSelf}`)
}

// ---------------------------------------------------------------------------------------------
// 6. The boundary defect, end to end through the real scanReturnLane (#408).
// ---------------------------------------------------------------------------------------------
// The table above drives the matcher directly. bridge.mjs imports that exact function, but "the
// module is right" and "the lane uses it" are different claims, and only the second one is the
// thing that broke. These two bodies both carried to My Dude before this fix.
to = await carriedBy("@My Dude's Assistant will handle it")
ok('a possessive does NOT carry to the agent whose name it starts with', to.length === 0, to.join('|'))

to = await carriedBy('@MC Claudeé is someone else entirely')
ok('a non-ASCII letter continuing the name does NOT carry — \\w could not see it',
  to.length === 0, to.join('|'))

to = await carriedBy('@My Dude — still here after all that')
ok('  …and the legitimate carry still lands, so the fix suppresses rather than blocks',
  to.length === 1 && to[0] === short(myDude), to.join('|'))

console.log(fails ? `\nTASK ROUTE MENTION FAIL — ${fails}` : '\nTASK ROUTE MENTION PASS — grammar, reasons, console join, boundary, end-to-end carry')
process.exit(fails ? 1 : 0)
