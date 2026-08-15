// console_relay_reach — the CORS question, measured instead of asked (#499).
//
// The plan for #486 opened by asking a person to read `BUZZ_CORS_ORIGINS` off the relay host. The
// value is not what anyone needs: what matters is whether THIS origin reaches the API, and one
// unauthenticated `GET /api/join-policy` settles it. This suite holds that the measurement stays a
// measurement — and, more importantly, that it never pretends to more than a browser can know.
//
// THE PROPERTY THIS EXISTS FOR: a browser cannot tell a CORS block from a dead host. Both are a
// TypeError with no status, by construction — the same-origin policy exists precisely so the page
// learns nothing about a response it may not read. A verdict that picks one would be right often
// enough to be believed and wrong often enough to send the operator to the wrong machine.
//
// Both directions on every guard.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as reach from '../console/relay-reach.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

console.log('\nconsole_relay_reach\n')

const ORIGIN = 'https://console.example'
const RELAY = 'https://relay.example'

// ------------------------------------------------------------------------------------------
console.log('1. the verdict, and the one thing a browser cannot know')
{
  const v = reach.reachVerdict({ status: null, err: new TypeError('Failed to fetch'), host: 'relay.example', origin: ORIGIN })
  check(v.state === 'no-answer' && v.reaches === false, 'a fetch with no status does not claim the relay is down')
  check(/unreachable/.test(v.reason) && /CORS policy withheld/.test(v.reason),
    '  …it names BOTH causes, because the page cannot tell them apart')
  check(v.reason.includes(ORIGIN),
    '  …and the remedy carries THIS origin, so it is a line to paste rather than advice to go and think')
  check(/leave BUZZ_CORS_ORIGINS unset/.test(v.reason),
    '  …including the empty-is-permissive case, which is the fix most of the time')
}
{
  const v = reach.reachVerdict({ status: 200, host: 'relay.example', origin: ORIGIN })
  check(v.state === 'reachable' && v.reaches === true, 'a 200 this page could read IS the answer to the CORS question')
  check(/nothing needs changing on the relay/.test(v.reason), '  …and says so plainly, so nobody goes looking for a config value')
}
{
  // The distinction that saves an afternoon: a readable 404 is a wrong path, not a blocked origin.
  const v = reach.reachVerdict({ status: 404, host: 'relay.example', origin: ORIGIN })
  check(v.state === 'answered' && v.reaches === true, 'a 404 still proves the response was READABLE — the origin is not blocked')
  check(/not blocked/.test(v.reason) && /wrong path/.test(v.reason), '  …and points at the path rather than at CORS')
  check(reach.reachVerdict({ status: 503, host: 'h', origin: ORIGIN }).reaches === true,
    'and a 5xx too — the relay\'s own problem, reported as the relay\'s own problem')
}
check(!reach.reachVerdict({ status: null, err: new Error('x'), host: 'h', origin: ORIGIN }).reason.includes('is down'),
  'NEGATIVE CONTROL — no branch states the relay is down, which is the conclusion this page may not draw')

// ------------------------------------------------------------------------------------------
console.log('\n2. the remedy names the origin, or it is not a remedy')
check(reach.corsRemedy(ORIGIN).includes(`add exactly ${ORIGIN}`), 'the config line carries the exact origin to add')
check(/<this-console-origin>/.test(reach.corsRemedy('')), 'and with no origin it says so with a placeholder rather than an empty gap')

// ------------------------------------------------------------------------------------------
console.log('\n3. the probe is UNAUTHENTICATED, and asks the one path that needs no auth')
{
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: 200 } }
  const p = await reach.probeRelay({ relayUrl: 'wss://relay.example/', fetchImpl, origin: ORIGIN })
  check(calls.length === 1 && calls[0].url === 'https://relay.example/api/join-policy',
    'it asks /api/join-policy, over https, with the wss scheme and trailing slash normalised')
  check(!('authorization' in (calls[0].init.headers || {})),
    'and sends NO authorization — signing one would invent a requirement the relay does not have, and a signer failure would then look like a reach failure')
  check(p.state === 'reachable' && p.url === 'https://relay.example', 'and reports the normalised base it actually probed')
}
{
  const fetchImpl = async () => { throw new TypeError('Failed to fetch') }
  const p = await reach.probeRelay({ relayUrl: RELAY, fetchImpl, origin: ORIGIN })
  check(p.state === 'no-answer' && p.reaches === false, 'a thrown fetch is no-answer, not "down"')
}
{
  const p = await reach.probeRelay({ relayUrl: '', fetchImpl: async () => { throw new Error('should not be called') }, origin: ORIGIN })
  check(p.state === 'no-relay' && p.reaches === false, 'no address at all is its own state — nothing was probed, so nothing is claimed')
}

// ------------------------------------------------------------------------------------------
console.log('\n4. the address is remembered only after something answered')
{
  const store = new Map()
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  const probe = { reaches: true, url: RELAY, state: 'reachable' }
  check(reach.rememberRelayUrl(RELAY, probe, storage) === true, 'a probe that reached it is remembered')
  check(reach.loadRelayUrl(storage) === RELAY, '  …and read back on the next visit, so it is typed once')

  // Structural, not conventional: a page that saves too early has nothing to pass.
  store.clear()
  check(reach.rememberRelayUrl(RELAY, null, storage) === false,
    'with no probe it is NOT remembered — a typo saved before anything answered is prefilled forever')
  check(reach.rememberRelayUrl(RELAY, { reaches: false, url: RELAY }, storage) === false, 'nor after a probe that did not reach it')
  check(reach.rememberRelayUrl(RELAY, { reaches: true, url: 'https://other.example' }, storage) === false,
    'nor when the probe was of a DIFFERENT address — that would remember the wrong host under a proof it never got')
  check(reach.loadRelayUrl(storage) === '', '  …and after all three refusals nothing is stored (POSITIVE CONTROL on the refusals)')

  // An answered 404 counts: the origin is proven unblocked, and the operator is about to fix the
  // path rather than retype the host.
  check(reach.rememberRelayUrl(RELAY, { reaches: true, url: RELAY, state: 'answered' }, storage) === true,
    'BOTH DIRECTIONS — a readable non-2xx still counts as reached, because the CORS question is settled')

  store.set('waggle-relay-url', 'not-a-url')
  check(reach.loadRelayUrl(storage) === '', 'a stored value that is not an address is refused rather than prefilled as a puzzle')
  check(reach.loadRelayUrl({ getItem: () => { throw new Error('private mode') } }) === '',
    'and a storage that throws is empty, not a crash — private browsing is not a broken console')
}

// ------------------------------------------------------------------------------------------
console.log('\n5. one name for the stored address, and no secrets beside it')
const files = ['relay-reach.mjs', 'admission-client.mjs', 'index.html', 'bridge-key-store.mjs']
  .map(f => [f, readFileSync(join(ROOT, 'console', f), 'utf8')])
const namers = files.filter(([f, src]) => f !== 'relay-reach.mjs' && /'waggle-relay-url'/.test(src)).map(([f]) => f)
check(namers.length === 0,
  `only relay-reach.mjs names the storage key${namers.length ? ` — also named in: ${namers.join(', ')}` : ''} — a split namespace reads exactly like a missing feature`)
const reachSrc = files.find(([f]) => f === 'relay-reach.mjs')[1]
check(!/setItem\((?!RELAY_URL_STORAGE)/.test(reachSrc), 'and the module writes nothing to storage but the address')

// ------------------------------------------------------------------------------------------
console.log('\n6. the page wires it')
const page = readFileSync(join(ROOT, 'console', 'index.html'), 'utf8')
const pageCode = page.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '')
check(/from '\.\/relay-reach\.mjs'/.test(pageCode), 'index.html imports the probe rather than judging a fetch inline')
check(/probeRelay\(/.test(pageCode) && /rememberRelayUrl\(/.test(pageCode), 'and both runs it and remembers what it proved')
// What it remembers has to be what the probe RETURNED. The module refuses a fabricated proof only
// if it is handed the real one; a page that builds `{reaches:true}` at the call site walks straight
// past the guard, and that mutation survived until this assertion existed.
const remembered = /rememberRelayUrl\(([^)]*)\)/.exec(pageCode)
check(remembered && remembered[1].split(',')[1]?.trim() === 'probe',
  '  …and hands it the probe RESULT, not a proof the page assembled for itself')
check(/loadRelayUrl\(/.test(pageCode), 'and prefills from what it remembered, so the address is typed once')
check(!/BUZZ_CORS_ORIGINS on the relay before/.test(pageCode),
  'and no copy tells the operator to go and read a config value the page can measure')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
