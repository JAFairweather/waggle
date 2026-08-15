// The alert hashtag — #508.
//
// The issue names the negative control as the whole test, and it is right to. This matcher fans out
// to a live channel, so one that is too broad is worse than one that is absent: it puts messages
// nobody meant for an agent into that agent's context, and every one of them looks like a correct
// carry from the inside. A suite that only ever asserts the tag FIRES cannot tell "carries the
// right thing" from "carries everything" — those two fail identically.
//
// So every positive here is paired: the tag fires, and a DIFFERENT tag does not; a subscriber is
// woken, and a non-subscriber in the same fan-out is not.
import { alertHashtag, alertHashtagProblem, alertHashtagKey, alertHashtags, alertHashtagMatcher, alertHashtagHit,
  returnCarryReason, RETURN_CARRY_REASONS, ALERT_TAG_MAX }
  from '../src/alert_hashtag.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

// ── The grammar ─────────────────────────────────────────────────────────────────────────────
check(alertHashtag('alert') === 'alert', 'a plain tag is usable')
check(alertHashtag('#alert') === 'alert', 'one leading # is taken off, because that is how people write it')
check(alertHashtag('Alert') === 'Alert', "and the operator's casing is KEPT — folding belongs in the comparison")
check(alertHashtagKey('#ALERT') === alertHashtagKey('alert'), 'and the comparison folds both ways')
check(alertHashtag('waggle_ops2') === 'waggle_ops2', 'letters, numbers and underscore')
check(alertHashtag('приоритет') === 'приоритет', 'and any script — \\p{L}, not \\w')

// Assert the REASON, not only the refusal. `!ok` cannot tell a correct refusal from a correct
// refusal that sends the operator hunting, and this message is the whole of what they act on.
const why = v => alertHashtagProblem(v) || ''
check(/must be text/.test(why(42)), 'a number is refused as not text')
check(/is empty/.test(why('#')), 'a bare # is refused as empty, not as a bad character')
check(/longer than 32/.test(why('a'.repeat(ALERT_TAG_MAX + 1))), 'over-long is refused BY LENGTH, and the limit is in the message')
check(alertHashtagProblem('a'.repeat(ALERT_TAG_MAX)) === null, '  …and exactly at the limit is fine — the boundary is not off by one')
check(/second #/.test(why('al#ert')), 'a second # is refused with its own sentence')
check(/must start with a letter or number/.test(why('_alert')), 'a leading underscore is refused for STARTING wrongly, not for the character')
// A hyphen is ADMITTED (#508 review). It reads as a tightening worth having until you notice the
// same argument condemns `#alert`/`#alerting`, which the trailing lookahead already settles — and
// that refusing it rejected `p0-incident` at config load, so an operator's subscription silently
// did not exist. A dot is still refused, so the alphabet is a decision and not an absence of one.
check(alertHashtagProblem('alert-2') === null, 'a hyphen is admitted — ordinary in a Nostr t tag, and refusing it dropped real subscriptions')
check(/position 6 \(U\+002E\)/.test(why('alert.2')),
  '  …while a dot is still refused by position and codepoint, so the alphabet is legible and deliberate')
check(/position 6 \(U\+00A0\)/.test(why('alert\u00A0two')),
  'and a non-breaking space is named by codepoint, because "invalid tag" sends an operator hunting')
check(/position 6 \(U\+200B\)/.test(why('alert\u200Bx')), '  …as is a zero-width space, which is invisible in every editor')

// ── The list parser ─────────────────────────────────────────────────────────────────────────
{
  // `bad.tag` rather than `bad-tag`: the hyphen is admitted now, so the old fixture stopped
  // exercising the unsupported-character branch it was written for. `p0-incident` rides along to
  // prove the list path keeps a hyphenated tag rather than only the single-value path.
  const { tags, problems } = alertHashtags(['#alert', 'ops', '#ALERT', 'bad.tag', '', 'p0-incident'])
  check(tags.join(',') === 'alert,ops,p0-incident', 'the list keeps the usable tags, in order')
  check(tags.length === 3, '  …and folds a case-variant duplicate rather than subscribing twice')
  check(problems.length === 2 && problems.every(p => p.why), 'and REPORTS what it dropped, with a reason for each')
  check(problems.some(p => /unsupported character/.test(p.why)) && problems.some(p => /is empty/.test(p.why)),
    '  …and the two reasons are different — a silently discarded tag is a subscription the operator thinks they have')
  check(alertHashtags(null).tags.length === 0 && alertHashtags('alert').tags.length === 0,
    'a missing or non-array config is no subscription at all, never a wildcard')
}

// ── The body matcher: fires ─────────────────────────────────────────────────────────────────
const hits = (body, tag) => !!alertHashtagMatcher(tag)?.test(body)
check(hits('#alert the build is down', 'alert'), 'at the start of a line')
check(hits('the build is down #alert', 'alert'), 'after a space')
check(hits('the build is down (#alert)', 'alert'), 'inside brackets')
check(hits('#ALERT', 'alert'), 'case-insensitively')
check(hits('line one\n#alert', 'alert'), 'after a newline')

// ── …and does NOT. This half is the point. ──────────────────────────────────────────────────
check(!hits('#alerting soon', 'alert'), 'NEGATIVE — a longer word is not the tag: #alerting does not raise #alert')
check(!hits('#alert2', 'alert'), 'NEGATIVE — nor does a digit continuing it')
check(!hits('#alert_x', 'alert'), 'NEGATIVE — nor an underscore, which is in the alphabet')
check(!hits('see https://example.com/runbook#alert', 'alert'),
  'NEGATIVE — a URL FRAGMENT does not raise the alert; a pasted link is not somebody raising an alarm')
check(!hits('see https://example.com/#alert', 'alert'), '  …including the bare /#alert form')
check(!hits('page#alert', 'alert'), '  …and a fragment with no slash either')
check(!hits('##alert', 'alert'), 'NEGATIVE — ## is not a second tag')
check(!hits('alert', 'alert'), 'NEGATIVE — the word without a # is not a tag; this lane is opt-in by punctuation')
check(!hits('@alert', 'alert'), 'NEGATIVE — nor an at-word, which is the OTHER signal entirely')
check(!hits('#ops', 'alert'), 'NEGATIVE — a DIFFERENT tag does not fire. The control this whole file exists for.')

// ── The hit resolver: both sources, and neither by accident ─────────────────────────────────
{
  const sub = ['alert', 'ops']
  const t = tag => alertHashtagHit('nothing in the body', [tag], sub)
  check(t('alert')?.via === 't-tag', 'a Nostr t tag raises it')
  check(t('ALERT')?.tag === 'alert', '  …case-folded, and it names WHICH tag fired')
  check(t('alerting') === null, 'NEGATIVE — a t tag is compared whole: `alerting` is not `alert`')
  check(t('ops')?.tag === 'ops', 'a second subscribed tag works too — the list is a list, not a first-entry')
  check(t('release') === null, 'NEGATIVE — an unsubscribed t tag raises nothing')

  const b = body => alertHashtagHit(body, [], sub)
  check(b('build is down #alert')?.via === 'body', 'the in-body form raises it, and says it came from the body')
  check(b('build is down')?.via === undefined && b('build is down') === null, 'NEGATIVE — an ordinary message raises nothing')
  check(b('#alerting') === null, 'NEGATIVE — and the body form keeps its word boundary through the resolver')

  // Both sources are read because clients disagree about which one they write. Reading one and not
  // the other makes the feature work in some clients and not others, invisibly from the channel.
  check(alertHashtagHit('#alert', ['alert'], sub)?.via === 't-tag',
    'when both carry it, the t tag is the source reported — one hit, not two')

  // The subscription is what gates it, in both directions.
  check(alertHashtagHit('#alert', ['alert'], []) === null,
    'NEGATIVE — an agent subscribing to NOTHING is not woken by a tag anybody raises')
  check(alertHashtagHit('#alert', ['alert'], null) === null, '  …nor by an absent subscription list')
  check(alertHashtagHit('#alert', ['alert'], ['ops']) === null,
    'NEGATIVE — nor an agent subscribed to a DIFFERENT tag. This is the fan-out failure that matters.')
  check(alertHashtagHit('#alert', ['alert'], ['alert'])?.tag === 'alert',
    '  …and BOTH DIRECTIONS: the agent that DID subscribe is still woken, in the same shape')

  // A subscription that is not a list of strings is not a subscription. A wildcard reached by
  // passing the wrong type would be the broadest possible failure and the quietest.
  for (const bad of ['alert', 42, {}, [1], [null], [{}], true]) {
    if (alertHashtagHit('#alert', ['alert'], bad) !== null) {
      check(false, `  …and a malformed subscription ${JSON.stringify(bad) ?? String(bad)} is not a wildcard`)
    }
  }
  check(true, 'and no malformed subscription value — a bare string, a number, an object, a ragged array — becomes a wildcard')
}

// ── The carry templates admit `alert`, and still refuse the rest ────────────────────────────
//
// `why` reaches an ALLOWLIST in both carry templates, and `reject()` throws out of the fan-out
// loop — so a value outside the list does not fail one carry, it takes every LATER recipient in
// that scan with it. A first draft of the bridge change passed `alert:<tag>`, which would have done
// exactly that on the first alert ever raised.
{
  const { renderTemplate } = await import('../src/nostr_egress.mjs')
    .then(m => ({ renderTemplate: m.renderTemplate || null }))
    .catch(() => ({ renderTemplate: null }))
  if (!renderTemplate) {
    // Not exported — assert against the source instead, and say so rather than skipping silently.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/nostr_egress.mjs', import.meta.url), 'utf8')
    if (src.length < 2000) {
      console.error(`alert_hashtag: INCONCLUSIVE — nostr_egress.mjs read back only ${src.length} bytes`)
      process.exit(3)
    }
    const lists = [...src.matchAll(/whys:\s*\[([^\]]*)\]/g)].map(m => m[1])
    check(lists.length === 2, `both carry templates declare a whys list (found ${lists.length})`)
    check(lists.every(l => /'alert'/.test(l)), "and both admit 'alert' — a reason the allowlist did not know would abort the scan")
    check(lists.every(l => /'mention'/.test(l) && /'reply'/.test(l)), 'and both still admit the two that were already there')
    check(!/whys:\s*\[[^\]]*'alert:/.test(src), 'NEGATIVE — no template admits a reason with a value pasted into it')
  }
}

// ── a non-string subscription entry is not a subscription ───────────────────────────────────────
// The malformed-subscription loop above passed even with the type guard removed, because none of
// its values happened to COLLIDE with the tag under test — it proved the code did not crash, not
// that the guard did anything. `[1]` is the case that shows it: without the guard it coerces to the
// live subscription `#1`, so a stray number in config becomes a silent subscription instead of a
// logged refusal.
{
  // The parser's OWN output is where a coerced entry does its damage, and it is silent there: the
  // value passes validation as `String(value)` and then fails conversion, so a null lands in the
  // subscription list and `problems` stays empty. The operator is told nothing is wrong while
  // holding a subscription that can never fire. Asserting only through `alertHashtagHit` misses it
  // entirely, because a null tag simply matches nothing.
  const { tags, problems } = alertHashtags([1])
  check(tags.every(t => typeof t === 'string' && t), 'a non-string entry never becomes a tag — no null is pushed into the subscription list')
  check(problems.length === 1 && /must be text/.test(problems[0].why),
    '  …and it is REPORTED, with its own reason — a silently dropped entry is a subscription the operator thinks they have')
}
check(alertHashtagHit('#1', ['1'], [1]) === null,
  'a NUMBER in the subscription list does not become a live subscription to that digit')
check(alertHashtagHit('#1', ['1'], ['1'])?.tag === '1',
  '  …and BOTH DIRECTIONS: the same tag subscribed as a STRING is still honoured')

// ── the carry reason is a closed set ────────────────────────────────────────────────────────────
//
// This is the assertion the mutation run demanded. `why = alert:${tag}` was caught by reading the
// egress allowlist, and then nothing in 106 suites failed when it was reintroduced — a defect that
// aborts the whole fan-out, invisible to the suite. The decision now lives in one function and the
// closed set is checked against the templates that enforce it.
{
  const combos = []
  for (const mentioned of [true, false]) {
    for (const repliedTo of [true, false]) {
      for (const alerted of [null, { tag: 'alert', via: 'body' }, { tag: "alert'; DROP", via: 't-tag' }]) {
        combos.push({ mentioned, repliedTo, alerted })
      }
    }
  }
  const reasons = combos.map(c => returnCarryReason(c))
  check(reasons.every(r => r === null || RETURN_CARRY_REASONS.includes(r)),
    `every one of the ${combos.length} signal combinations yields null or a declared reason — nothing else is reachable`)
  check(reasons.every(r => r === null || /^[a-z]+$/.test(r)),
    '  …and no reason carries channel-derived text, however hostile the tag that fired')
  check(returnCarryReason({}) === null && returnCarryReason() === null,
    'NEGATIVE — no signal is not a carry, and the absent case is null rather than a default reason')

  // Precedence, asserted in both directions rather than assumed.
  check(returnCarryReason({ mentioned: true, repliedTo: true, alerted: { tag: 'x' } }) === 'mention',
    'a mention wins over everything — the strongest signal names the carry')
  check(returnCarryReason({ repliedTo: true, alerted: { tag: 'x' } }) === 'reply', '  …a reply wins over an alert')
  check(returnCarryReason({ alerted: { tag: 'x' } }) === 'alert', '  …and an alert alone is an alert, not nothing')

  // The set is only closed if the templates agree. Read from source, with a size floor: a scan of a
  // file that came back short reports everything clean.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/nostr_egress.mjs', import.meta.url), 'utf8')
  if (src.length < 2000) {
    console.error(`alert_hashtag: INCONCLUSIVE — nostr_egress.mjs read back only ${src.length} bytes`)
    process.exit(3)
  }
  const lists = [...src.matchAll(/whys:\s*\[([^\]]*)\]/g)].map(m => m[1])
  check(lists.length === 2, `both carry templates declare a whys list (found ${lists.length})`)
  check(lists.every(l => RETURN_CARRY_REASONS.every(r => l.includes(`'${r}'`))),
    'and EVERY reason this function can return is admitted by BOTH templates — a reason outside the list aborts the scan, not the carry')

  // The bridge must decide it here and nowhere else. A wiring assertion, and named as one.
  const bridge = readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8')
  if (bridge.length < 50000) {
    console.error(`alert_hashtag: INCONCLUSIVE — bridge.mjs read back only ${bridge.length} bytes`)
    process.exit(3)
  }
  check(/const why = returnCarryReason\(\{ mentioned, repliedTo, alerted \}\)/.test(bridge),
    'the return-lane scan takes its reason from returnCarryReason, rather than building one inline')
  check(!/why = [`'"]?alert:/.test(bridge), 'NEGATIVE — and nowhere builds a reason with a tag name pasted into it')
  check(/alertHashtagHit\(body, ttags, r\.alert_tags\)/.test(bridge),
    'and the alert is resolved from BOTH the body and the t tags, against this recipient\'s own subscription')
  check(/t\[0\] === 't' && t\[1\]/.test(bridge), '  …with the t tags actually extracted from the event, or the tag-carried form is invisible')
}


// ── the two boundary cases the review pushed on (#508 review) ────────────────────────────────────
//
// Both are BOTH-DIRECTION pairs on purpose. A lookbehind that suppressed every `(#alert` would
// satisfy the markdown case and silently kill a real alarm somebody wrote as "(#alert)"; a check
// that only asserted the refusal could not tell those two apart.
{
  const hit = (body, tag) => alertHashtagHit(body, [], [tag])

  check(!hit('[see the runbook](#alert)', 'alert'),
    'a markdown link target does not raise the lane — `](` before the # is a link, not an alarm')
  check(!!hit('the build is down (#alert)', 'alert'),
    '  …but a person writing (#alert) still does, so what is excluded is the link form, not the bracket')
  check(!hit('https://example.com/runbook#alert', 'alert'),
    'a URL fragment still does not raise it — the case the first lookbehind was written for')
  check(!!hit('#alert at the start of a line', 'alert'), '  …and an ordinary alarm still fires')

  // `-` was refused until this review. The cost was not theoretical: `p0-incident` was rejected at
  // config load, so an operator's subscription silently did not exist.
  const parsed = alertHashtags(['p0-incident'])
  check(parsed.tags.length === 1 && parsed.tags[0] === 'p0-incident',
    'a hyphenated tag survives config parsing — admissible in a Nostr t tag, and it was being dropped')
  check(parsed.problems.length === 0, '  …with no problem reported against it')
  check(!!hit('paging #p0-incident now', 'p0-incident'), '  …and it fires from the body')
  // The boundary still holds in the other direction: the shorter tag must not match inside it.
  check(!hit('paging #p0-incident now', 'p0'),
    '  …while #p0 does NOT match inside #p0-incident, so the operator still owns where a tag ends')
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
