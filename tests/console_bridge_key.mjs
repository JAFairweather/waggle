// console_bridge_key.mjs — the console remembers ONE hive, in ONE place, and only after it has
// verified it (#322).
//
// The reported symptom was that three of five pages had never been taught to remember the bridge
// key. The measurement said otherwise: `agents.html` remembered it perfectly well, under
// `waggle-agents-bridge`, while every other page used `waggle-following-bridge`. The console was
// not forgetting — it was writing the answer somewhere the next page did not look.
//
// A split namespace is indistinguishable from a missing feature from the operator's chair, and the
// natural "fix" for it is a fourth key. So the assertion that matters here is not "agents.html now
// works"; it is that NO file under console/ names a bridge storage key except the one module that
// owns it. That is what stops this coming back on the next page — and it only stops it if the scan
// matches the SHAPE of such a name rather than the two we happen to have found already, because a
// fourth key gets invented under a name nobody has enumerated. Both scans run; the enumerated one
// stays because it gives the better failure message when the name IS one we know.
//
// The second half is ordering. All four pages wrote the key immediately after parsing the field,
// before a single relay had answered — so a well-formed key for a hive that does not exist was
// remembered and prefilled on every later visit, outliving the error message that rejected it.
// `rememberBridgeKey` now REQUIRES the verified state, which makes "save only after a load that
// verified" structural rather than a convention four pages are each trusted to follow.
//
//   node tests/console_bridge_key.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONSOLE = join(ROOT, 'console')
const STORE = 'bridge-key-store.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const inconclusive = (why) => {
  console.error(`console_bridge_key: INCONCLUSIVE — ${why}`)
  console.error('  This is NOT an all-clear: the invariant was not exercised.')
  process.exit(3)
}

const store = await import('../console/bridge-key-store.mjs')

// ---- 1. one owner for the storage name --------------------------------------------------------
const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { walk(full); continue }
    if (/\.(mjs|html|js)$/.test(entry)) files.push(full)
  }
}
walk(CONSOLE)
// Size floor. A scan that returns nothing finds no offending literal either, and prints the same
// clean result as a console that is genuinely tidy.
if (files.length < 20) inconclusive(`the console scan found only ${files.length} source files`)

const NAMES = [store.BRIDGE_KEY_STORAGE, ...store.LEGACY_BRIDGE_KEY_STORAGE]
const sources = new Map(files.map(f => [f, readFileSync(f, 'utf8')]))
const named = (f) => f.slice(CONSOLE.length + 1)

const offenders = files
  .filter(f => !f.endsWith(STORE))
  .filter(f => NAMES.some(n => sources.get(f).includes(n)))
  .map(named)
check(offenders.length === 0,
  `only ${STORE} names a KNOWN bridge storage key (${files.length} console sources scanned` +
  `${offenders.length ? `; offenders: ${offenders.join(', ')}` : ''})`)

// The scan above matches the names we have already discovered, which is strictly weaker than the
// property this suite claims. `waggle-agents-bridge` is caught today only because #322 found it and
// wrote it into LEGACY_BRIDGE_KEY_STORAGE — had this suite existed when agents.html was written, it
// would have passed. The next page does not have to argue with a test to invent a fourth key; it
// only has to pick a name nobody has enumerated, which is exactly what the last one did.
//
// So scan for the SHAPE. Deliberately narrow: `console/` has six other localStorage call sites, all
// in index.html (an access-list view, a session key, a dismiss key), and none of them match. A
// broader "any localStorage outside the store" would flag all six and stop being read, which is the
// failure mode ship_imports reasons about in #433.
const BRIDGE_KEY_SHAPE = /['"]waggle-[\w-]*bridge[\w-]*['"]/
const novel = files
  .filter(f => !f.endsWith(STORE))
  .filter(f => BRIDGE_KEY_SHAPE.test(sources.get(f)))
  .map(named)
check(novel.length === 0,
  'and no console source names a bridge storage key of ANY name, enumerated or not' +
  `${novel.length ? `; offenders: ${novel.join(', ')}` : ''}`)

// NEGATIVE CONTROL — both scans can find something, so the two zeroes above are results and not
// detectors that read nothing.
check(NAMES.every(n => sources.get(join(CONSOLE, STORE)).includes(n)),
  'NEGATIVE CONTROL — the same scan DOES find every storage name inside the store itself')
check(BRIDGE_KEY_SHAPE.test(sources.get(join(CONSOLE, STORE))),
  'NEGATIVE CONTROL — and the shape scan finds one inside the store too')

// The point of the shape scan, stated as a property rather than left to the file walk: it catches a
// name that appears NOWHERE in NAMES. Asserted on literals rather than by writing into console/, so
// the check cannot leave the tree dirty — and paired with the benign keys that share the `waggle-`
// prefix, because a pattern that flags everything and one that flags nothing fail identically.
const INVENTED = ["'waggle-routing-bridge'", '"waggle-bridge-key"', "'waggle-console-bridge-hex'"]
check(INVENTED.every(s => BRIDGE_KEY_SHAPE.test(s) && !NAMES.some(n => s.includes(n))),
  'a storage name no one has enumerated is still caught — the leg the NAMES scan cannot cover')
const BENIGN = ["'waggle.accesslist.view'", "'waggle-session'", "'waggle-dismissed-notice'", "'bridgekey'"]
check(BENIGN.every(s => !BRIDGE_KEY_SHAPE.test(s)),
  'NEGATIVE CONTROL — the console’s other waggle- prefixed keys are NOT flagged, so it refuses the dangerous thing rather than everything')

// ---- 2. every page that takes a bridge key goes through the store ------------------------------
const pages = readdirSync(CONSOLE).filter(f => f.endsWith('.html')).sort()
if (pages.length < 5) inconclusive(`found only ${pages.length} console pages`)

const reachesStore = (page) => {
  const html = readFileSync(join(CONSOLE, page), 'utf8')
  if (html.includes(STORE)) return true
  // a page whose logic lives in a src= module, e.g. routing.html -> routing.mjs
  for (const m of html.matchAll(/src="\.\/([\w.-]+\.mjs)"/g)) {
    try { if (readFileSync(join(CONSOLE, m[1]), 'utf8').includes(STORE)) return true } catch { /* absent */ }
  }
  return false
}
const withBridgeInput = pages.filter(p => readFileSync(join(CONSOLE, p), 'utf8').includes('id="bridge"'))
check(withBridgeInput.length >= 4, `pages taking a bridge key: ${withBridgeInput.join(', ') || '(none)'}`)
const unwired = withBridgeInput.filter(p => !reachesStore(p))
check(unwired.length === 0,
  `every page with a bridge field reaches the shared store${unwired.length ? ` (missing: ${unwired.join(', ')})` : ''}`)

// CONSUMERS — a page may READ the stored key without collecting one, and connect.html now does: it
// renders waggle's public key into the `agent-send --bridge` argument of the handoff document,
// because it is the only producer that has a key a load actually verified (#514 review). Without it
// the page printed a command that exits 3 before signing anything.
//
// "Has a bridge field" was standing in for the thing actually being protected, which is narrower:
// do not PREFILL a field from this value. index.html takes a GRANTOR key — the owner's, not the
// bridge's — and a confidently wrong 64-hex prefill is worse than an empty box. So the control now
// asserts that directly, and a consumer has to argue with the assertion below rather than with a
// proxy for it.
const CONSUMERS = ['connect.html']
const withoutBridgeInput = pages.filter(p => !withBridgeInput.includes(p) && !CONSUMERS.includes(p))
check(withoutBridgeInput.length > 0 && withoutBridgeInput.every(p => !reachesStore(p)),
  `NEGATIVE CONTROL — pages that neither collect nor consume the key do not read it (${withoutBridgeInput.join(', ')})`)
// The real rule, asserted on the consumer rather than assumed of it: read it, never seat it in an
// input. A prefill is the failure #322 refused; rendering it into a documented command is not.
for (const page of CONSUMERS) {
  const html = readFileSync(join(CONSOLE, page), 'utf8')
  check(html.includes('loadBridgeKey'), `${page} consumes the shared store rather than naming a storage key of its own`)
  check(!/\.value\s*=\s*loadBridgeKey|loadBridgeKey\(\)[^\n]*\.value\s*=/.test(html),
    `  …and does NOT prefill any field from it — that is the confidently-wrong-value failure #322 refused`)
}
check(!readFileSync(join(CONSOLE, 'index.html'), 'utf8').includes(STORE),
  'index.html does not prefill its grantor field from the bridge key — a different value, deliberately')

// ---- 3. persistence happens downstream of verification -----------------------------------------
// Structural, not stylistic: `rememberBridgeKey` must appear after the call that picks the freshest
// VERIFIED state, in every source that persists. The runtime guard below is what actually enforces
// it; this catches a page that has moved the call back to the top of load() and now silently fails
// to persist at all, which would look exactly like the bug this fixes.
const persisting = files.filter(f => !f.endsWith(STORE) && readFileSync(f, 'utf8').includes('rememberBridgeKey('))
check(persisting.length === 4, `four sources persist the key: ${persisting.map(f => f.slice(CONSOLE.length + 1)).join(', ')}`)
for (const f of persisting) {
  const src = readFileSync(f, 'utf8')
  const verified = src.indexOf('newestFreshControlState(')
  const remembered = src.indexOf('rememberBridgeKey(')
  check(verified > -1 && remembered > verified,
    `${f.slice(CONSOLE.length + 1)}: the key is written after the state is verified, not on parse`)
}

// ---- 4. the store itself ------------------------------------------------------------------------
const HEX = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const fakeStorage = (initial = {}) => {
  const data = { ...initial }
  return { data, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v } }
}
const verified = (bridge) => ({ bridge, observed_at: 1_760_000_000 })

check(store.loadBridgeKey(fakeStorage()) === '', 'nothing stored -> empty string, not null or undefined')
check(store.loadBridgeKey(fakeStorage({ [store.BRIDGE_KEY_STORAGE]: HEX })) === HEX, 'the shared key is read back')
check(store.loadBridgeKey(fakeStorage({ [store.BRIDGE_KEY_STORAGE]: 'not-a-key' })) === '',
  'a stored value that is not a bridge key is refused rather than prefilled')

// The migration is the reason the old name is still read. Dropping it outright would empty the box
// for exactly the operator who reported this.
const legacy = fakeStorage({ 'waggle-agents-bridge': HEX })
check(store.loadBridgeKey(legacy) === HEX, "agents.html's old key is still read, so nobody loses their prefill")
check(legacy.data[store.BRIDGE_KEY_STORAGE] === HEX, 'and it is migrated to the shared name on first read')
const both = fakeStorage({ [store.BRIDGE_KEY_STORAGE]: HEX, 'waggle-agents-bridge': OTHER })
check(store.loadBridgeKey(both) === HEX, 'NEGATIVE CONTROL — the shared key wins; the legacy one does not overwrite it')

const throwing = { getItem: () => { throw Error('private mode') }, setItem: () => { throw Error('private mode') } }
check(store.loadBridgeKey(throwing) === '', 'a storage that throws (private browsing) yields empty, not an exception')
check(store.rememberBridgeKey(HEX, verified(HEX), throwing) === false, 'and a write that throws reports false rather than escaping')

// The ordering guard, both directions.
const w1 = fakeStorage()
check(store.rememberBridgeKey(HEX, verified(HEX), w1) === true && w1.data[store.BRIDGE_KEY_STORAGE] === HEX,
  'NEGATIVE CONTROL — a verified load DOES persist the key (or this guard would just refuse everything)')
const w2 = fakeStorage()
check(store.rememberBridgeKey(HEX, null, w2) === false && !(store.BRIDGE_KEY_STORAGE in w2.data),
  'no verified state -> nothing is written: a typo cannot outlive the error that rejected it')
const w3 = fakeStorage()
check(store.rememberBridgeKey(HEX, verified(OTHER), w3) === false && !(store.BRIDGE_KEY_STORAGE in w3.data),
  'state verified for a DIFFERENT bridge -> nothing is written')
const w4 = fakeStorage()
check(store.rememberBridgeKey(HEX, { bridge: HEX, observed_at: 'soon' }, w4) === false,
  'state with no usable observed_at -> nothing is written')
const w5 = fakeStorage()
check(store.rememberBridgeKey('npub1nothex', verified('npub1nothex'), w5) === false,
  'a non-hex bridge is refused even with a matching state')

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
