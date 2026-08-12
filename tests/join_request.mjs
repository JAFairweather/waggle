// join_request.mjs — a stranger's JSON, treated like one.
//
// The join request is the only artifact in the ceremony authored by someone the hive has not
// admitted. Its purpose text, label and capability list are attacker-controlled by definition, and
// they end up on the screen where an owner decides to grant channel access. So the fixtures here
// are hostile, and every refusal is paired with a legitimate request still getting through —
// a reader that refuses everything protects nothing and blocks the feature.
//
//   node tests/join_request.mjs

import { buildJoinRequest, readJoinRequest, JOIN_REQUEST_KIND, REQUESTABLE_CAPS, MAX_PURPOSE, MAX_LABEL }
  from '../src/join_request.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const refuses = (label, fn, pattern) => {
  try { fn(); check(false, `${label} (did not throw)`) }
  catch (e) { check(pattern.test(e.message), `${label}${pattern.test(e.message) ? '' : ` — wrong reason: ${e.message}`}`) }
}

const HIVE = 'a'.repeat(64), REQUESTER = 'b'.repeat(64), OTHER_HIVE = 'c'.repeat(64)
const NOW = 1_800_000_000
const signedAs = (ev, pubkey = REQUESTER) => ({ ...ev, pubkey, id: 'd'.repeat(64) })
const read = (ev, over = {}) => readJoinRequest(ev, { hivePubkey: HIVE, verify: () => true, now: NOW, ...over })

// ── Build: the happy path, and what it refuses to build ─────────────────────────────────────
{
  const ev = buildJoinRequest({ hivePubkey: HIVE, caps: ['task', 'task-relay'], purpose: 'ship the runbook', label: 'mc-claude', createdAt: NOW })
  check(ev.kind === JOIN_REQUEST_KIND, 'a built request carries the join-request kind')
  check(ev.tags.filter(t => t[0] === 'p').length === 1, 'and names exactly one hive')
  check(ev.tags.filter(t => t[0] === 'da-cap').length === 2, 'and one tag per requested capability')
  const round = read(signedAs(ev))
  check(round.ok && round.request.caps.join() === 'task,task-relay' && round.request.purpose === 'ship the runbook',
    'ROUND TRIP — what the builder emits is what the reader accepts, so the two cannot drift apart')
}
{
  refuses('a request must name a hive', () => buildJoinRequest({ caps: ['task'] }), /name the hive/)
  refuses('and must ask for something', () => buildJoinRequest({ hivePubkey: HIVE, caps: [] }), /at least one capability/)
  refuses('admit+read cannot be requested — it conveys channel key material',
    () => buildJoinRequest({ hivePubkey: HIVE, caps: ['admit+read'] }), /cannot be requested/)
  refuses('mirror cannot be requested — it is authored by the participant about themselves',
    () => buildJoinRequest({ hivePubkey: HIVE, caps: ['mirror'] }), /cannot be requested/)
  refuses('an over-long purpose is refused rather than truncated at the builder',
    () => buildJoinRequest({ hivePubkey: HIVE, caps: ['task'], purpose: 'x'.repeat(MAX_PURPOSE + 1) }), /longer than/)
  refuses('an over-long label likewise',
    () => buildJoinRequest({ hivePubkey: HIVE, caps: ['task'], label: 'y'.repeat(MAX_LABEL + 1) }), /longer than/)
  for (const bad of ['nsec1abcdef', 'bunker://relay?secret=x', 'e'.repeat(64), 'ncryptsec1zzz'])
    refuses(`a credential-shaped purpose is refused (${bad.slice(0, 12)}…)`,
      () => buildJoinRequest({ hivePubkey: HIVE, caps: ['task'], purpose: bad }), /credential/)
  // 'z' not 'b': a 64-character label made only of hex digits IS the shape of a pubkey, so the
  // credential screen refuses it — correctly. My first fixture here used 64 b's and was refused,
  // which is the guard working on the test rather than the test working on the guard.
  check(buildJoinRequest({ hivePubkey: HIVE, caps: ['task'], purpose: 'a'.repeat(MAX_PURPOSE), label: 'z'.repeat(MAX_LABEL) }).kind === JOIN_REQUEST_KIND,
    'while a purpose and label exactly at the cap are accepted — the boundary is inclusive, not off by one')
  refuses('and a 64-character all-hex label is refused, because it is indistinguishable from a key',
    () => buildJoinRequest({ hivePubkey: HIVE, caps: ['task'], label: 'abcdef01'.repeat(8) }), /credential/)
}

// ── Read: verification is OBSERVED, not asserted ─────────────────────────────────────────────
// This used to take `verified: true` and refuse anything else. That catches "forgot to pass it"
// and cannot catch "asserted it without checking" — and since the only call shape that existed
// was a test helper hard-coding `true`, the obligation was never actually discharged anywhere.
// Now the verifier is injected and CALLED, so these assert that it ran.
{
  const ev = signedAs(buildJoinRequest({ hivePubkey: HIVE, caps: ['task'], createdAt: NOW }))
  const missing = readJoinRequest(ev, { hivePubkey: HIVE, now: NOW })
  check(!missing.ok && /verify\(ev\) function/.test(missing.reason),
    'a request is refused when no verifier is supplied — the check cannot be skipped silently')

  // The claim-shaped values that USED to work. Each is a caller asserting rather than checking.
  for (const notAFunction of [true, 'true', 1, {}, [], 'yes'])
    check(!readJoinRequest(ev, { hivePubkey: HIVE, verify: notAFunction, now: NOW }).ok,
      `and a bare ${JSON.stringify(notAFunction)} is not a verifier — an assertion is not a check`)

  let calledWith = null
  const spy = (e) => { calledWith = e; return true }
  check(readJoinRequest(ev, { hivePubkey: HIVE, verify: spy, now: NOW }).ok && calledWith === ev,
    'a real verifier lets it through AND was handed the event itself — proving the module called it rather than trusting it')

  check(!readJoinRequest(ev, { hivePubkey: HIVE, verify: () => false, now: NOW }).ok,
    'a verifier that says no is a refusal')
  for (const truthy of [1, 'true', {}, Promise.resolve(true)])
    check(!readJoinRequest(ev, { hivePubkey: HIVE, verify: () => truthy, now: NOW }).ok,
      `and only the boolean true counts, not ${typeof truthy === 'object' && truthy?.then ? 'a Promise' : JSON.stringify(truthy)} — a truthy return is not a pass`)
}

// ── Read: the id is inside the contract, not outside it ──────────────────────────────────────
// Found in review. Every other field here is bounded and screened; `id` was passed through raw,
// so a stranger's JSON reached the owner's screen unbounded AT THE MOMENT they decide to grant
// channel access. Invisible to the fixtures because `signedAs` always supplied a well-formed id
// — "the id field" and "a valid id" were the same value in every test.
{
  const base = buildJoinRequest({ hivePubkey: HIVE, caps: ['task'], createdAt: NOW })
  const withId = (id) => read({ ...base, pubkey: REQUESTER, id })

  const hostile = 'APPROVE ' + '7f3a'.repeat(8) + '‮' + 'X'.repeat(5000)
  const got = withId(hostile)
  check(!got.ok && /no usable id/.test(got.reason),
    'an id carrying a counterfeit APPROVE token, an RTL override and 5000 characters is REFUSED, not returned with ok:true')

  for (const bad of ['', undefined, null, 'd'.repeat(63), 'd'.repeat(65), 'g'.repeat(64), ' ' + 'd'.repeat(64)])
    check(!withId(bad).ok, `and a malformed id is refused (${JSON.stringify(String(bad).slice(0, 12))})`)

  const good = withId('D'.repeat(64))
  check(good.ok && good.request.id === 'd'.repeat(64),
    'NEGATIVE CONTROL — a well-formed id still gets through, lower-cased, so this is a validator and not a wall')
}

// ── Read: addressing ────────────────────────────────────────────────────────────────────────
{
  const base = buildJoinRequest({ hivePubkey: HIVE, caps: ['task'], createdAt: NOW })
  check(!read(signedAs({ ...base, tags: base.tags.filter(t => t[0] !== 'p') })).ok, 'a request naming no hive is refused')
  const twoHives = { ...base, tags: [['p', HIVE], ['p', OTHER_HIVE], ...base.tags.filter(t => t[0] === 'da-cap')] }
  check(!read(signedAs(twoHives)).ok,
    'a request naming TWO hives is refused — one artifact shown to several owners as if meant for each')
  check(!read(signedAs(buildJoinRequest({ hivePubkey: OTHER_HIVE, caps: ['task'], createdAt: NOW }))).ok,
    "and a request for someone else's hive is refused")
  check(read(signedAs({ ...base, tags: [['p', HIVE.toUpperCase()], ...base.tags.filter(t => t[0] === 'da-cap')] })).ok,
    'while case in the hive key does not change which hive it is')
}

// ── Read: time, and the two refusals that must stay distinct ────────────────────────────────
{
  const at = (t) => signedAs(buildJoinRequest({ hivePubkey: HIVE, caps: ['task'], createdAt: t }))
  const future = read(at(NOW + 600))
  const stale = read(at(NOW - 7200))
  check(!future.ok && /future/.test(future.reason), 'a request dated in the future is refused as such')
  check(!stale.ok && /expired/.test(stale.reason), 'and an old one is refused as expired')
  check(future.reason !== stale.reason,
    'and the two reasons DIFFER — folding them loses the signal that separates a clock problem from a stretched window')
  check(read(at(NOW + 60)).ok, 'a little forward skew is tolerated, because clocks are not perfect')
  check(read(at(NOW - 3599)).ok, 'and a request inside its window is accepted')
}

// ── Read: capabilities are refused whole, never narrowed ────────────────────────────────────
{
  const sneaky = signedAs({
    ...buildJoinRequest({ hivePubkey: HIVE, caps: ['task'], createdAt: NOW }),
    tags: [['p', HIVE], ['da-cap', 'task'], ['da-cap', 'admit+read']],
  })
  const got = read(sneaky)
  check(!got.ok && /cannot be requested/.test(got.reason),
    'a request mixing a legal cap with admit+read is refused ENTIRELY, not silently narrowed to the legal one')
  check(/admit\+read/.test(got.reason), 'and the refusal names which capability caused it')
  check(read(signedAs({ ...sneaky, tags: [['p', HIVE], ['da-cap', 'task']] })).ok,
    'while the same request without it is accepted — the refusal is about that cap, not about mixing')
}

// ── Read: the stranger's prose ──────────────────────────────────────────────────────────────
{
  const withBody = (content) => signedAs({ ...buildJoinRequest({ hivePubkey: HIVE, caps: ['task'], createdAt: NOW }), content })
  check(!read(withBody('{oh no')).ok, 'an unparseable body is refused')
  check(!read(withBody('[]')).ok, 'an array body is refused — JSON.parse succeeding is not the body being an object')
  check(!read(withBody('null')).ok, 'and a null body is refused')
  check(read(withBody('{}')).ok, 'but an empty object is fine — a request may simply say nothing about itself')
  const long = read(withBody(JSON.stringify({ purpose: 'z'.repeat(5000) })))
  check(long.ok && long.request.purpose.length === MAX_PURPOSE,
    'an over-long purpose from the wire is TRUNCATED rather than refused — the builder is ours, the wire is not')
  check(!read(withBody(JSON.stringify({ label: 'nsec1deadbeef' }))).ok,
    'a credential-shaped label from the wire is refused outright')
  const typed = read(withBody(JSON.stringify({ purpose: 42, label: { a: 1 } })))
  check(typed.ok && typed.request.purpose === '' && typed.request.label === '',
    'and non-string prose becomes empty rather than being rendered as [object Object]')
}

// ── NEGATIVE CONTROL ────────────────────────────────────────────────────────────────────────
{
  const good = read(signedAs(buildJoinRequest({ hivePubkey: HIVE, caps: REQUESTABLE_CAPS, purpose: 'do the thing', label: 'agent one', createdAt: NOW })))
  check(good.ok && good.request.caps.length === REQUESTABLE_CAPS.length,
    'NEGATIVE CONTROL — a request for every requestable capability is accepted, so this reader does not just refuse everything')
  check(good.request.requester === REQUESTER && good.request.hive === HIVE,
    'and it reports the requester and hive it actually read, rather than an empty shell that happens to be ok')
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
