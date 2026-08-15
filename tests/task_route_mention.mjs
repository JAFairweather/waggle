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
  taskRouteMentioned, taskRouteMentionMatcher, taskRouteMentionArbitrate,
  taskRouteMentionSkeleton, taskRouteMentionConflict }
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
  // A name in one non-Latin script is a NAME (#416). The script rule below refuses Latin MIXED
  // with Cyrillic or Greek; paired here so that rule cannot quietly become "refuses foreign".
  ['Денис', 'Денис'],             // Denis, wholly Cyrillic
  ['Δήμητρα', 'Δήμητρα'],  // Dimitra, wholly Greek
  ['クロード', 'クロード'],                         // Katakana: never confusable with Latin
  ['Meſnil', 'Meſnil'],   // U+017F long s — a legal name on its own; #416 refuses it only
                                    // as a SECOND route beside a real `Mesnil`, which is the conflict
                                    // check, not the grammar. Storing it proves the two are separate.
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
// 1b. Confusable admission (#416). #414 made `@Mesnil` carry to a long-s twin as well, which fixed
// the mute and left interception open: the twin still receives everything addressed to the real
// name, just no longer exclusively. Arbitration cannot close that — it cannot tell an impostor
// from a namesake, and refusing on suspicion mutes real agents — so the refusal is at UPSERT.
// ---------------------------------------------------------------------------------------------
console.log('\nconfusable routes are refused at admission, not at arbitration')

{
  const CH = 'c'.repeat(64), REAL = 'a'.repeat(64), IMPOSTOR = 'b'.repeat(64)
  const existing = [{ channel: CH, participant: REAL, mention: 'Mesnil', sender: 's', protocol: 'p' }]
  const at = (mention, participant = IMPOSTOR, channel = CH) =>
    taskRouteMentionConflict(mention, existing, { channel, participant })

  // The skeleton, on its own. Both directions: it must fold the twins TOGETHER and leave two
  // genuinely different crew names APART, or "refuses the dangerous thing" is indistinguishable
  // from "refuses everything" — the 2026-08-01 failure, restated.
  ok('the long s folds onto a plain s',
    taskRouteMentionSkeleton('Meſnil') === taskRouteMentionSkeleton('Mesnil'))
  ok('so does the fi ligature, fullwidth text and a stripped accent',
    taskRouteMentionSkeleton('ﬁnn') === taskRouteMentionSkeleton('finn') &&
    taskRouteMentionSkeleton('ＭＣ Claude') === taskRouteMentionSkeleton('MC Claude') &&
    taskRouteMentionSkeleton('Mésnil') === taskRouteMentionSkeleton('Mesnil'))
  ok('two real crew names stay apart under the skeleton',
    taskRouteMentionSkeleton('My Dude') !== taskRouteMentionSkeleton('MC Claude') &&
    taskRouteMentionSkeleton('Dennis') !== taskRouteMentionSkeleton('Denise'))

  // The refusal, through the exported check.
  ok('a long-s twin of an existing route is refused for a different agent', at('Meſnil') !== null)
  ok('  …and the reason names BOTH names, because the operator\'s next move is to compare them',
    /@Meſnil/u.test(at('Meſnil') || '') && /@Mesnil/.test(at('Meſnil') || ''),
    JSON.stringify(at('Meſnil')))
  ok('  …and says what the consequence is, not merely that it is invalid',
    /reach the other/.test(at('Meſnil') || ''))

  // Every direction the check must NOT fire in. Each of these is a way the guard could be
  // "working" while actually refusing everything, which is the shape that shipped an outage here.
  ok('an unrelated name in the same channel is admitted', at('My Dude') === null)
  ok('the SAME agent may re-spell its own name — that is a rename, not interception',
    at('Meſnil', REAL) === null)
  ok('an identical mention for a different agent is still allowed — the operator can SEE that ' +
    'they typed the same name twice; a lookalike is the thing they cannot see',
    at('Mesnil') === null && at('mesnil') === null)
  ok('a lookalike in a DIFFERENT channel is not this channel\'s problem',
    at('Meſnil', IMPOSTOR, 'd'.repeat(64)) === null)
  ok('no existing routes, no conflict', taskRouteMentionConflict('Meſnil', [], { channel: CH, participant: IMPOSTOR }) === null)
  ok('an empty or absent mention does not throw and does not conflict',
    taskRouteMentionConflict('', existing, { channel: CH, participant: IMPOSTOR }) === null &&
    taskRouteMentionConflict(null, existing, { channel: CH, participant: IMPOSTOR }) === null)

  // A CROSS-SCRIPT LOOKALIKE IS ADMITTED, AND CANNOT INTERCEPT (#416, #426).
  //
  // Written as escapes for a reason that is not the usual one: these characters are perfectly
  // visible, and that is the problem — the lookalike and the real name are the same picture, so a
  // literal here would be a fixture no reviewer could check by reading it. The escape is the only
  // thing that makes the Cyrillic letter legible AS Cyrillic.
  //
  // A script-mixing rule refused all four of these at the grammar. It was removed under review
  // because it prevented no interception and refused real names (`Nikos \u03A0\u03B1\u03C0\u03AC\u03C2`, `\u0414enis`).
  // These assertions are what replaces it: each is a legal name, and none of them can take a
  // message aimed at its Latin twin, because the matcher does not fold across scripts either.
  const TWINS = [
    ['Me\u0455nil', 'Mesnil'],       // U+0455 dze, the twin of Latin s
    ['\u0410pple', 'Apple'],        // Cyrillic A leading an otherwise Latin word
    ['Dennis\u0430', 'Dennisa'],   // U+0430, the twin of Latin a
    ['\u039Cy Dude', 'My Dude'],     // Greek Mu, the twin of Latin M
  ]
  for (const [twin, latin] of TWINS) {
    ok(`a cross-script lookalike is a legal NAME: ${JSON.stringify(twin)}`,
      taskRouteMentionProblem(twin) === null, String(taskRouteMentionProblem(twin)))
    ok('  …and the skeleton does NOT fold it — no normalisation folds one script onto another',
      taskRouteMentionSkeleton(twin) !== taskRouteMentionSkeleton(latin))
    ok('  …so it is admitted beside its twin rather than refused',
      taskRouteMentionConflict(twin, [{ channel: CH, participant: REAL, mention: latin }],
        { channel: CH, participant: IMPOSTOR }) === null)
    // The direction that matters: being admitted is only safe because it cannot take the at-word.
    // Both directions, because a matcher that reached NEITHER would pass a one-sided assertion.
    ok('  …and a body addressed to the Latin name does NOT reach it',
      taskRouteMentioned(`@${latin} ship it`, twin) === false)
    ok('  …while the Latin name itself still carries — the guard is not refusing everything',
      taskRouteMentioned(`@${latin} ship it`, latin) === true)
  }
}

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
const mcOnly = getPublicKey(generateSecretKey())
// The tie pair. `Me\u017Fnil` is LATIN SMALL LETTER LONG S — written escaped because it is a
// letter nobody can tell from `f` or `s` at a glance, and a fixture nobody can read is a fixture
// nobody can check. It is the ONE character in U+0020–U+FFFF that regex `iu` folds onto an ASCII
// letter but `String.prototype.toLowerCase()` does not, so these two survive dedup as separate
// routes of equal length that each match the other's at-word.
const mesnilLong = getPublicKey(generateSecretKey())
const mesnilPlain = getPublicKey(generateSecretKey())
const MESNIL_LONG = 'Me\u017Fnil'
const crewSk = generateSecretKey(), crew = getPublicKey(crewSk)
const channel = 'a8186b53-537d-46ad-a7e7-b6486c58970e'

writeFileSync(resolve(dir, 'config.json'), JSON.stringify({ relays: [], recipients: [], public: {
  relays: ['wss://example.invalid'], inbox: 'chan', staging_inbox: 'chan',
  watch_authors: [], watch_events: [], approvers: [], grantors: [],
  scan_authors: [], scan_channels: [],
  task_routes: [
    { participant: myDude, sender: crew, channel, mention: 'My Dude', protocol: 'nvoy-task-carry-v1' },
    { participant: mcClaude, sender: crew, channel, mention: 'MC Claude', protocol: 'nvoy-task-carry-v1' },
    // `MC` is a whole-word prefix of `MC Claude`, which is the #407/#409 collision. It is in the
    // harness from the start rather than in a section of its own, so every assertion above runs
    // with the ambiguity present — a suppression rule is only trustworthy if the cases it must
    // NOT change are checked against it too.
    { participant: mcOnly, sender: crew, channel, mention: 'MC', protocol: 'nvoy-task-carry-v1' },
    { participant: mesnilLong, sender: crew, channel, mention: MESNIL_LONG, protocol: 'nvoy-task-carry-v1' },
    { participant: mesnilPlain, sender: crew, channel, mention: 'Mesnil', protocol: 'nvoy-task-carry-v1' },
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

const { scanReturnLane, PUB, grantSet, nearMissLedger } = await import('../src/bridge.mjs')
grantSet.set(myDude, { grantId: '1'.repeat(64), grantor: crew })
grantSet.set(mcClaude, { grantId: '2'.repeat(64), grantor: crew })
grantSet.set(mcOnly, { grantId: '3'.repeat(64), grantor: crew })
grantSet.set(mesnilLong, { grantId: '4'.repeat(64), grantor: crew })
grantSet.set(mesnilPlain, { grantId: '5'.repeat(64), grantor: crew })

ok('all five routes survive config parsing, spaces and all', PUB.taskRoutes.length === 5,
  String(PUB.taskRoutes.length))
ok("and keep the operator's casing on the way in",
  PUB.taskRoutes.map(r => r.mention).sort().join('|') === `MC|MC Claude|Mesnil|${MESNIL_LONG}|My Dude`,
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
  !to.includes(short(mcClaude)), to.join('|'))
// It carries to `MC` instead, and that is correct rather than a leak. `@MC Claudeé is …` and
// `@MC has this one …` are the same shape — `@MC`, a space, a word — so any rule that withheld the
// first would withhold the second, and `MC` would be unreachable in prose. The space terminates a
// mention; that is the price of spaced names being possible at all, and it is paid deliberately.
ok('  …it reaches the SHORT route instead, which the separator makes unavoidable',
  to.length === 1 && to[0] === short(mcOnly), to.join('|'))

to = await carriedBy('@My Dude — still here after all that')
ok('  …and the legitimate carry still lands, so the fix suppresses rather than blocks',
  to.length === 1 && to[0] === short(myDude), to.join('|'))

// ---------------------------------------------------------------------------------------------
// 6. Arbitration: longest wins per at-word (#407, #409).
// ---------------------------------------------------------------------------------------------
// #411 derived the boundary from the alphabet and fixed `@Dr. Watson`. It could not fix
// `@MC Claude`, and no boundary can: the separator has to TERMINATE a mention (or `My Dude` would
// never match `@My Dude and …`) and be INTERIOR to one (or `MC Claude` could not be a name), so
// both readings of `@MC Claude` are correct. What was missing is arbitration — longest wins, per
// at-word — and the shorter route's loss is logged rather than dropped quietly.
//
// Both directions, and the second one carries the weight: a suppression rule cannot be told from a
// rule that suppresses everything unless the shorter route is shown STILL CARRYING the at-words
// that really are its own. `MC` is in the harness config from the top of this file for that reason.
console.log('\narbitration — longest wins per at-word, both directions')

const arb = (body, mentions) => {
  const { carried, suppressed, nearMissed } = taskRouteMentionArbitrate(body, mentions)
  return { won: [...carried.values()].sort(), lost: [...suppressed.values()].map(s => s.mention).sort(),
    near: [...nearMissed.values()].map(n => `${n.mention} in ${n.word}`).sort() }
}
const ROUTES = ['MC', 'MC Claude', 'My Dude']
const ALL_ROUTES = [...ROUTES, MESNIL_LONG, 'Mesnil']

const ARBITRATE = [
  // body                                       won                        suppressed
  ['@MC Claude — please look at this.',         ['MC Claude'],             ['MC']],
  ['@MC please look at this.',                  ['MC'],                    []],
  ['@MC and @MC Claude both',                   ['MC', 'MC Claude'],       []],
  ['@My Dude and @MC Claude',                   ['MC Claude', 'My Dude'],  ['MC']],
  ['@MC CLAUDE shouting',                       ['MC Claude'],             ['MC']],
  ['@My Dude on their own',                     ['My Dude'],               []],
  ['@MCClaude is nobody',                       [],                        []],
  ['no at-words here',                          [],                        []],
]
for (const [body, won, lost] of ARBITRATE) {
  const got = arb(body, ROUTES)
  ok(`${JSON.stringify(body)} -> carries ${JSON.stringify(won)}`,
    got.won.join('|') === won.join('|'), got.won.join('|'))
  ok(`  …suppressing ${JSON.stringify(lost)}`, got.lost.join('|') === lost.join('|'), got.lost.join('|'))
}

// A route that LOSES one at-word and WINS another is carried. Suppression is a statement about one
// at-word, never about a route — get this wrong and a busy channel silently mutes a short name.
ok('losing one at-word does not mute a route that won another',
  arb('@MC Claude first, then @MC alone', ROUTES).lost.length === 0,
  JSON.stringify(arb('@MC Claude first, then @MC alone', ROUTES)))

// Order independence: the winner is the longest, not the first configured.
ok('the winner does not depend on route order',
  arb('@MC Claude', ['MC', 'MC Claude']).won.join('|') === arb('@MC Claude', ['MC Claude', 'MC']).won.join('|'))

// Size floor — an arbitration over no routes must report nothing rather than everything.
ok('no routes means nothing carries', arb('@MC Claude', []).won.length === 0)

// ---------------------------------------------------------------------------------------------
// Losing to the BOUNDARY is also a loss (#415). `suppressed` answers "which other route took it",
// which left the commoner case silent: `@MC Claudette` carries to `MC` and not to `MC Claude`, no
// route took it, nothing was logged, and the owner of `MC Claude` watched messages that visibly
// begin with their name reach somebody else with no line anywhere saying why.
// ---------------------------------------------------------------------------------------------
console.log('\nnear misses — the at-word that continued past the name')

ok('a route whose name is a prefix of a longer WORD is reported',
  arb('@MC Claudette please look', ROUTES).near.join('|') === 'MC Claude in @MC Claudette',
  JSON.stringify(arb('@MC Claudette please look', ROUTES)))
ok('  …and the at-word as written is IN the line, because that is the whole explanation',
  arb('@MC Claudeé said no', ROUTES).near.join('|') === 'MC Claude in @MC Claudeé')
ok('  …a possessive counts too — a different name, not this one',
  arb("@MC Claude's Assistant will", ROUTES).near.join('|') === "MC Claude in @MC Claude's")
ok('  …and the shorter route still CARRIES the at-word it legitimately owns',
  arb('@MC Claudette please look', ROUTES).won.join('|') === 'MC')

// BOTH DIRECTIONS. A near-miss report that fired on every at-word would be worse than silence: the
// log exists to be read, and one that always says something says nothing.
ok('an at-word that is nobody-and-nothing-like is not a near miss for anyone',
  arb('@Nobody at all', ROUTES).near.length === 0, JSON.stringify(arb('@Nobody at all', ROUTES)))
ok('a route that WON its at-word outright is not also reported as missing it',
  arb('@MC Claude — please look at this.', ROUTES).near.length === 0)
ok('an unrelated route is not dragged into someone else\'s near miss',
  !arb('@MC Claudette please look', ROUTES).near.some(n => n.startsWith('My Dude')))

// PRECEDENCE — carried beats suppressed beats near miss. Two lines about one route in one message
// is how a log starts being skimmed instead of read.
ok('a route that carried ELSEWHERE gets no near-miss line for the at-word it lost',
  arb('@MC Claudette and @MC Claude', ROUTES).near.length === 0,
  JSON.stringify(arb('@MC Claudette and @MC Claude', ROUTES)))
{
  const both = arb('@MC Claude then @MCX', ROUTES)
  ok('a route suppressed by another ROUTE is not ALSO reported as a near miss',
    both.lost.join('|') === 'MC' && both.near.length === 0, JSON.stringify(both))
}
// The two are genuinely different findings, and the operator does different things about them, so
// a body producing one of each must produce one of each.
{
  const mixed = arb('@My Dudette and @MC Claude', ROUTES)
  ok('a body with one of each reports one of each, under its own heading',
    mixed.lost.join('|') === 'MC' && mixed.near.join('|') === 'My Dude in @My Dudette',
    JSON.stringify(mixed))
}

// The word is outside-controlled text on its way to a journal (#405 is the same lesson). It cannot
// carry a control character — the continuation is drawn from the mention alphabet — and it is
// capped, or a 4 000-character word is a 4 000-character journal line chosen by the sender.
{
  const long = arb(`@MC Claude${'x'.repeat(4000)} hello`, ROUTES)
  ok('a monstrous word does not become a monstrous log line',
    long.near.length === 1 && long.near[0].length < 120, String(long.near[0]?.length))
  ok('  …and it SAYS it was cut, rather than silently reading as a shorter word',
    String(long.near[0] ?? '').endsWith('…'), JSON.stringify(long.near))
  const broken = arb('@MC Claude\u000Ayikes RETURN forged', ROUTES)
  ok('a newline right after the name cannot get into the reported word',
    !/[\u000A]/.test(broken.near.join('|') + broken.won.join('|')))
  ok('  …and that body is a plain carry, not a near miss — a newline ENDS the at-word',
    broken.won.join('|') === 'MC Claude' && broken.near.length === 0, JSON.stringify(broken))
}

// TIES ARE NOT BROKEN — the claim this fix originally rested on was false (#414 review).
// `taskRouteMentionKey` folds with `toLowerCase()` (Unicode case MAPPING); the matcher folds with
// regex `iu` (Unicode simple case FOLDING). Two different equivalence relations, so a same-length
// pair CAN survive dedup and reach the comparison. Breaking that tie by `>` broke it by array
// order: the message went to whichever route was configured first, and the other's owner was told
// a longer name had taken it — a false reason for a delivery to the wrong participant.
// This guard is DIAGNOSIS, not non-vacuity. The tie assertions below cannot pass vacuously —
// `won.length === 2` is unsatisfiable unless two rows survive dedup and both match at that at-word.
// What it buys is that a future fixture edit or fold change fails as "the fixture stopped being a
// tie" rather than as a bare "a tie carries to BOTH", which is otherwise a puzzle. Proven by
// degrading the precondition four ways: it fires in all four, and never alone.
ok('the fixture is still a genuine tie — same length, distinct keys, each matching the other',
  taskRouteMentionKey(MESNIL_LONG) !== taskRouteMentionKey('Mesnil') &&
  MESNIL_LONG.length === 'Mesnil'.length &&
  taskRouteMentioned('@Mesnil please look', MESNIL_LONG) &&
  taskRouteMentioned(`@${MESNIL_LONG} please look`, 'Mesnil'))

{
  const forward = arb('@Mesnil please look at this.', [MESNIL_LONG, 'Mesnil'])
  const reverse = arb('@Mesnil please look at this.', ['Mesnil', MESNIL_LONG])
  ok('a tie carries to BOTH rather than to one of them',
    forward.won.length === 2 && forward.lost.length === 0, JSON.stringify(forward))
  ok('  …and the outcome does not depend on the order they were configured in',
    forward.won.join('|') === reverse.won.join('|'), `${forward.won.join('|')} vs ${reverse.won.join('|')}`)
}

// The generalisation must not have loosened the rule it generalises: a genuinely longer name
// still takes the at-word, with the collision pair present in the route set.
ok('longest still wins when the lengths actually differ',
  arb('@MC Claude — please look at this.', ALL_ROUTES).won.join('|') === 'MC Claude' &&
  arb('@MC Claude — please look at this.', ALL_ROUTES).lost.join('|') === 'MC',
  JSON.stringify(arb('@MC Claude — please look at this.', ALL_ROUTES)))

// --- end to end, through the real scanReturnLane -----------------------------------------------
to = await carriedBy('@MC Claude — please look at this.')
ok('#407 live repro: the at-word reaches ONLY the longer route',
  to.length === 1 && to[0] === short(mcClaude), to.join('|'))

to = await carriedBy('@MC has this one on its own')
ok('and the shorter route still reaches its own agent',
  to.length === 1 && to[0] === short(mcOnly), to.join('|'))

to = await carriedBy('@MC and @MC Claude are two different agents')
ok('two at-words in one message reach two different agents',
  to.length === 2 && to.join('|') === [short(mcOnly), short(mcClaude)].sort().join('|'), to.join('|'))

to = await carriedBy('@Mesnil please look at this.')
// Carrying to both fixes the MUTE and the ORDER DEPENDENCE. It does not fix interception, and the
// name of this assertion used to say it did (#414 re-read). `@Mesnil` still reaches `Me\u017Fnil`, an
// agent nobody named; what changed is that it no longer reaches it EXCLUSIVELY. Arbitration cannot
// tell an impostor from a legitimate namesake — that closes at admission, not here (#416).
ok('end to end: a tie reaches BOTH agents, so the real agent is not displaced',
  to.length === 2 && to.join('|') === [short(mesnilLong), short(mesnilPlain)].sort().join('|'), to.join('|'))


// The suppression must be READABLE. A short route that quietly stops receiving presents as the
// return lane being flaky, which is the failure this repo keeps paying for — so assert the reason,
// not merely that the carry did not happen.
{
  const captured = []
  const realLog = console.log
  console.log = (...a) => { captured.push(a.join(' ')) }
  await carriedBy('@MC Claude — the suppression must be legible')
  console.log = realLog
  ok('the bridge logged something at all', captured.length > 0, `${captured.length} lines`)
  const line = captured.find(l => l.includes('skip[longer-name]'))
  ok('the suppressed route is NAMED, not dropped silently', !!line,
    captured.join(' / ').slice(0, 200))
  ok('  …and the line says which longer name took the at-word, and where',
    !!line && /@MC does not take the at-word at \d+ — @MC Claude is longer/.test(line), String(line))
}

// The NEAR MISS is a DIFFERENT reason and gets its own line (#415), deduped by content rather than
// by count (#425 review). Driven end to end, because the dedup lives at the log site and a unit
// test of the ledger alone would not prove the log site consults it.
{
  const captured = []
  const realLog = console.log
  console.log = (...a) => { captured.push(a.join(' ')) }
  const nearMisses = () => captured.filter(l => l.includes('skip[longer-word]'))
  await carriedBy('@MCX please look at this')            // @MC matched as a prefix; the word ran on
  const first = nearMisses().length
  await carriedBy('@MCX again, exactly the same typo')   // same (route, word) — one confusion, not two
  const repeat = nearMisses().length
  await carriedBy('@mcx once more, in lower case')       // the same confusion, written differently
  const folded = nearMisses().length
  await carriedBy('@MCY a DIFFERENT typo for the same route')
  const distinct = nearMisses().length
  console.log = realLog

  ok('a near miss is reported, under its own heading and not as a name clash',
    first === 1 && /@MC does not take the at-word at \d+ — @MCX continues past it/.test(nearMisses()[0] || ''),
    (nearMisses()[0] || captured.join(' / ')).slice(0, 200))
  ok('  …and the same at-word again is NOT reported again — one confusion, one line',
    repeat === first, `${first} -> ${repeat}`)
  ok('  …including in another case, because the key folds the way the route key folds',
    folded === first, `${first} -> ${folded}`)
  // The direction a count threshold gets wrong, and the reason the dedup is by content: a threshold
  // cannot tell a new confusion from the fortieth repeat of an old one, so it goes quiet on real,
  // standing drift — which is the failure #415 exists to stop, one layer down.
  ok('NEGATIVE CONTROL — a NEW at-word for the same route still gets its own line',
    distinct === first + 1, `${folded} -> ${distinct}`)
}

// The ledger on its own, for the bound. Its own instance, so it is not reading state the end-to-end
// block above left behind.
{
  const once = nearMissLedger({ cap: 3 })
  ok('the ledger reports a first sighting', once('mc', '@MCX') === true)
  ok('  …and refuses the same pair', once('mc', '@MCX') === false)
  ok('  …while a different ROUTE with the same word is a different confusion', once('my dude', '@MCX') === true)
  ok('  …and a different WORD for the same route is too', once('mc', '@MCY') === true)
  // Eviction, insertion-ordered: the fourth distinct pair pushes the first one out, so it reports
  // again rather than being remembered forever on a process meant to run for months. A cap that
  // never evicted would pass every assertion above.
  ok('NEGATIVE CONTROL — past the cap the OLDEST pair is evicted and reports again',
    once('mc', '@MCZ') === true && once('mc', '@MCX') === true)
  ok('  …while the newest pair is still remembered, so eviction is ordered and not a wipe',
    once('mc', '@MCZ') === false)
}

console.log(fails ? `\nTASK ROUTE MENTION FAIL — ${fails}` : '\nTASK ROUTE MENTION PASS — grammar, reasons, console join, boundary, arbitration, end-to-end carry')
process.exit(fails ? 1 : 0)
