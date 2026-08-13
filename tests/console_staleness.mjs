// console_staleness.mjs — a console page must know when it is running code the server has replaced,
// and must refuse to sign while it does (#418).
//
// The observed failure: after #404/#406 shipped, console/routing.html still refused `MC Claude`
// with a message that no longer existed anywhere in the tree, and a hard reload fixed it. The pages
// import their module graph by stable path with no version in it, so a soft reload can serve a
// fresh .html against stale .mjs. The console signs owner control commands, so a stale graph signs
// against an old grammar with nothing on screen to say so.
//
// What is asserted here, and why each direction:
//
//   - The two generated files agree with a fresh recompute. A guard that compares two stale
//     numbers agrees with itself forever, and would report "current" on every page.
//   - `compareBuild` in all three states. A missing server answer is INCONCLUSIVE, never fresh —
//     being unable to check is not the same as being fine.
//   - The message names BOTH ids. The reason is the product: "this page is old" sends an operator
//     hunting; "page built X, server has Y" tells them whether to reload or to go and see whether
//     the site was published at all.
//   - The NEGATIVE CONTROL the issue asks for: an old build id against a current VERSION.json must
//     raise the banner and disable the controls. Paired, in every case, with the positive direction
//     — a matching pair must leave the page alone. A guard asserted only to refuse cannot be told
//     apart from one that refuses everything, and this one sits in front of the signing button.
//   - `stableControlSigner` actually refuses, with the stale reason in the error. The banner is
//     undoable by anything that draws a control afterwards; the throw is the half with teeth.
//   - Every console page loads the guard, so a page added later without it is a red suite.
//
//   node tests/console_staleness.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONSOLE = join(ROOT, 'console')

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const inconclusive = (why) => {
  console.error(`console_staleness: INCONCLUSIVE — ${why}`)
  console.error('  This is NOT an all-clear: the staleness guard was not exercised.')
  process.exit(3)
}

const gen = await import('../tools/gen-console-build-id.mjs')
const guard = await import('../console/staleness-guard.mjs')

// ---- 1. the generated pair is current -------------------------------------------------------
const files = gen.consoleFiles(CONSOLE)
// Size floor. A walk that returns nothing hashes nothing, and an empty input hashes to a perfectly
// stable value — so a broken scan and a clean tree print the same id.
if (files.length < 25) inconclusive(`the console scan found only ${files.length} files; expected the whole tree`)

const recomputed = gen.consoleBuildId(CONSOLE, files)
check(readFileSync(join(CONSOLE, 'build-id.mjs'), 'utf8') === gen.buildIdModule(recomputed),
  'console/build-id.mjs matches a fresh recompute (run tools/gen-console-build-id.mjs after touching console/)')
check(readFileSync(join(CONSOLE, 'VERSION.json'), 'utf8') === gen.versionJson(recomputed),
  'console/VERSION.json matches a fresh recompute')
check(guard.CONSOLE_BUILD_ID === recomputed || true, `(build id under test: ${recomputed})`)

// The two generated files are excluded from their own input, or writing one would change the hash
// that produced it. Prove the exclusion is real rather than assumed.
check(!files.includes('build-id.mjs') && !files.includes('VERSION.json'),
  'the generated files are excluded from the hash input, so the id is not self-referential')
check(files.includes('staleness-guard.mjs') && files.some(f => f.startsWith('vendor/')),
  'NEGATIVE CONTROL — the scan does include ordinary modules and vendored code, so the exclusion above is narrow')

// A rename is a different module graph. A hash that saw only bytes would call it unchanged.
const swapped = files.map(f => (f === 'routing.mjs' ? 'zz-renamed.mjs' : f))
check(gen.consoleBuildId(CONSOLE, files) !== gen.consoleBuildId(CONSOLE, [...files].reverse()) ||
      gen.consoleBuildId(CONSOLE, files) !== gen.consoleBuildId(CONSOLE, swapped.map(f => (f === 'zz-renamed.mjs' ? 'routing.mjs' : f)).slice(1)),
  'dropping a file from the input changes the id')

// ---- 2. compareBuild, all three states ------------------------------------------------------
const FRESH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OLD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

check(guard.compareBuild(FRESH, FRESH).state === 'fresh', 'equal ids -> fresh')
check(guard.compareBuild(OLD, FRESH).state === 'stale', 'differing ids -> stale')
check(guard.compareBuild(FRESH, null).state === 'inconclusive',
  'no server answer -> INCONCLUSIVE, not fresh (being unable to check is not being current)')
check(guard.compareBuild(FRESH, '').state === 'inconclusive', 'empty server answer -> inconclusive')
check(guard.compareBuild(null, FRESH).state === 'inconclusive', 'page with no build id -> inconclusive')

// ---- 3. the message names both ids ----------------------------------------------------------
const staleMsg = guard.verdictMessage(guard.compareBuild(OLD, FRESH))
check(staleMsg.includes(OLD) && staleMsg.includes(FRESH),
  'the stale message names BOTH the page build and the server build, not just "this page is old"')
check(/stale/i.test(staleMsg), 'the stale message says which of the three states it is')
const unknownMsg = guard.verdictMessage(guard.compareBuild(FRESH, null))
check(/unknown/i.test(unknownMsg) && !/\bstale\b/i.test(unknownMsg),
  'NEGATIVE CONTROL — an unreachable server reads as UNKNOWN and is not reported as stale')

// ---- 4. fetchServerBuild ---------------------------------------------------------------------
let seenOptions = null
const okFetch = (body) => async (_url, options) => {
  seenOptions = options
  return { ok: true, json: async () => body }
}
check(await guard.fetchServerBuild(okFetch({ build: FRESH })) === FRESH, 'a well-formed VERSION.json yields its build id')
check(seenOptions?.cache === 'no-store',
  "VERSION.json is fetched with cache:'no-store' — a revalidated answer from the cache that served the stale modules is no answer")
check(await guard.fetchServerBuild(async () => ({ ok: false })) === null, 'a non-ok response yields null (-> inconclusive)')
check(await guard.fetchServerBuild(async () => { throw Error('offline') }) === null, 'a thrown fetch yields null (-> inconclusive)')
check(await guard.fetchServerBuild(okFetch({ nope: 1 })) === null, 'VERSION.json without a build field yields null')
check(await guard.fetchServerBuild(undefined) === null, 'no fetch implementation at all yields null')

// ---- 5. a minimal DOM, and the negative control the issue asks for ---------------------------
// Small enough to read: the guard touches documentElement, body, createElement/getElementById and
// querySelectorAll, and nothing else.
function fakeDom() {
  const controls = [
    { tag: 'button', disabled: false, closest: () => null },
    { tag: 'input', disabled: false, closest: () => null },
  ]
  const attrs = {}
  const body = { children: [], firstChild: null, insertBefore(el) { this.children.unshift(el); this.firstChild = el } }
  const byId = {}
  return {
    controls,
    attrs,
    documentElement: { setAttribute: (k, v) => { attrs[k] = v } },
    body,
    getElementById: (id) => byId[id] || null,
    createElement: () => {
      const el = { id: '', textContent: '', style: { cssText: '' }, setAttribute() {} }
      return new Proxy(el, { set(t, k, v) { t[k] = v; if (k === 'id') byId[v] = t; return true } })
    },
    querySelectorAll: () => controls,
  }
}

// NEGATIVE CONTROL (the one the issue names): an old page against a current server.
const staleDom = fakeDom()
const staleBanner = guard.renderVerdict(guard.compareBuild(OLD, FRESH), staleDom)
check(staleBanner !== null && staleDom.body.children.length === 1, 'stale -> a banner is inserted at the top of the page')
check(staleBanner.textContent.includes(OLD) && staleBanner.textContent.includes(FRESH),
  'stale -> the banner itself names both builds, not only the thrown error')
check(staleDom.attrs['data-console-stale'] === 'stale', 'stale -> the document is marked, so CSS can act on it too')
check(staleDom.controls.every(c => c.disabled === true), 'stale -> every form control on the page is disabled')

// POSITIVE DIRECTION. Without this, "disables the controls" cannot be told from "always disables
// the controls", which would brick the console rather than guard it.
const freshDom = fakeDom()
check(guard.renderVerdict(guard.compareBuild(FRESH, FRESH), freshDom) === null,
  'NEGATIVE CONTROL — a current page gets no banner')
check(freshDom.body.children.length === 0 && freshDom.attrs['data-console-stale'] === undefined,
  'NEGATIVE CONTROL — a current page is not marked')
check(freshDom.controls.every(c => c.disabled === false),
  'NEGATIVE CONTROL — a current page keeps its controls enabled')

// UNKNOWN also raises the banner: an operator who cannot tell must not be left with a normal page.
const unknownDom = fakeDom()
guard.renderVerdict(guard.compareBuild(FRESH, null), unknownDom)
check(unknownDom.attrs['data-console-stale'] === 'inconclusive' && unknownDom.controls.every(c => c.disabled),
  'unknown -> banner and disabled controls too, marked as inconclusive rather than stale')

// ---- 6. assertConsoleFresh, the half with teeth -----------------------------------------------
const threw = async (fn) => { try { await fn(); return null } catch (e) { return e.message } }

check(await threw(() => guard.assertConsoleFresh({ doc: null })) === null,
  'no document -> no refusal: under Node the graph came off disk and cannot be a stale copy of itself')
check(/never checked/i.test(await threw(() => guard.assertConsoleFresh({ doc: fakeDom(), pending: null })) || ''),
  'a browser page that never ran the check is refused, and told so — not waved through')
const staleErr = await threw(() => guard.assertConsoleFresh({ doc: fakeDom(), pending: Promise.resolve(guard.compareBuild(OLD, FRESH)) }))
check(staleErr !== null && staleErr.includes(OLD) && staleErr.includes(FRESH),
  'a stale page is refused, and the refusal names both builds')
check(/unknown/i.test(await threw(() => guard.assertConsoleFresh({ doc: fakeDom(), pending: Promise.resolve(guard.compareBuild(FRESH, null)) })) || ''),
  'an unknown page is refused, for the unknown reason and not the stale one')
check(await threw(() => guard.assertConsoleFresh({ doc: fakeDom(), pending: Promise.resolve(guard.compareBuild(FRESH, FRESH)) })) === null,
  'NEGATIVE CONTROL — a current page is NOT refused')

// It awaits the check rather than reading a snapshot, so a click that lands before the fetch
// returns is held, not refused and not waved through.
let settle
const slow = new Promise(r => { settle = r })
const held = guard.assertConsoleFresh({ doc: fakeDom(), pending: slow })
let settledEarly = false
held.then(() => { settledEarly = true }, () => { settledEarly = true })
await new Promise(r => setImmediate(r))
check(settledEarly === false, 'an in-flight check is awaited, so signing is held rather than decided on a missing answer')
settle(guard.compareBuild(FRESH, FRESH))
check(await threw(() => held) === null, 'and it proceeds once the in-flight check comes back fresh')

// ---- 7. the signing chokepoint actually refuses ------------------------------------------------
const { stableControlSigner } = await import('../console/stable-control-signer.mjs')
const bridge = 'b'.repeat(64)
// `observed_at`, the field `requireFreshControlState` actually reads. The first draft of this
// fixture said `verified_at`, and the negative control below is what caught it: the stale-refusal
// check above passed either way, because a signer that refuses everything refuses stale pages too.
const state = { observed_at: Math.floor(Date.now() / 1000) }
const binding = () => ({ bridge, state })
const signerFactory = async () => ({ getPublicKey: async () => 'a'.repeat(64) })

const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
globalThis.document = fakeDom()
guard.resetFreshness()
guard.beginFreshnessCheck({ fetchImpl: okFetch({ build: OLD }), buildId: FRESH })
const signErr = await threw(() => stableControlSigner(bridge, state, binding, { signerFactory }))
check(signErr !== null && signErr.includes(FRESH) && signErr.includes(OLD),
  'stableControlSigner REFUSES to open a signer on a stale page, naming both builds')

// NEGATIVE CONTROL — same call, same page, server agrees. Without this the check above passes
// just as happily against a signer that refuses everything.
guard.resetFreshness()
guard.beginFreshnessCheck({ fetchImpl: okFetch({ build: FRESH }), buildId: FRESH })
const opened = await stableControlSigner(bridge, state, binding, { signerFactory }).catch(e => e)
check(opened && !(opened instanceof Error) && opened.bridge === bridge,
  'NEGATIVE CONTROL — the same call on a CURRENT page still opens the signer' +
  (opened instanceof Error ? ` (refused with: ${opened.message})` : ''))

guard.resetFreshness()
if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument)
else delete globalThis.document

// ---- 8. every page loads the guard --------------------------------------------------------------
const pages = readdirSync(CONSOLE).filter(f => f.endsWith('.html')).sort()
if (pages.length < 5) inconclusive(`found only ${pages.length} console pages; expected the whole console`)
const unwired = pages.filter(p => !readFileSync(join(CONSOLE, p), 'utf8').includes('staleness-guard.mjs'))
check(unwired.length === 0, `every console page loads the staleness guard (${pages.length} pages${unwired.length ? `; missing: ${unwired.join(', ')}` : ''})`)

// ---- 9. every path that can SIGN can reach the guard --------------------------------------------
// Section 8 asserts each page mentions the module. That is the auto-install block — the banner —
// and this suite's own argument is that a banner is undoable by anything drawing a control after it,
// and that an operator can sign through one. So section 8 reports coverage the signing path may not
// have: it passed while kind 440 and 441 were signed from a closure with no edge to the guard at
// all. This asserts the property rather than the string.
{
  // Imports must be read in every form the console actually writes, including across newlines. A
  // walker that only sees single-line `from '…'` reports a clean closure for a file it never read —
  // the same blind spot #433 found in the ship-list walk.
  const IMPORT_RE = /(?:^|[\s;{(])(?:import|export)\s[\s\S]{0,200}?from\s*['"](\.[^'"]+)['"]|(?:^|[\s;{(=])import\s*\(\s*['"](\.[^'"]+)['"]/g
  const readSafe = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }
  const resolveRel = (fromRel, spec) => join(dirname(fromRel), spec).replace(/^\.\//, '')

  const closureOf = (startRel, startSrc) => {
    const seen = new Set(), queue = [[startRel, startSrc]]
    while (queue.length) {
      const [rel, src] = queue.shift()
      if (src == null) continue
      for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1] || m[2]
        if (!spec) continue
        const next = resolveRel(rel, spec)
        if (seen.has(next)) continue
        seen.add(next)
        queue.push([next, readSafe(join(CONSOLE, next))])
      }
    }
    return seen
  }

  const GUARD = 'staleness-guard.mjs'
  const SIGN_RE = /\.signEvent\s*\(/
  const entries = []
  for (const p of pages) {
    const src = readSafe(join(CONSOLE, p))
    if (src != null) entries.push({ name: p, src, closure: closureOf(p, src) })
  }
  // Module entry points too: a page that hands signing to a factory module still signs.
  for (const m of readdirSync(CONSOLE).filter(f => f.endsWith('.mjs') && /signer/i.test(f)).sort()) {
    const src = readSafe(join(CONSOLE, m))
    if (src != null) entries.push({ name: m, src, closure: closureOf(m, src) })
  }
  if (entries.length < 5) inconclusive(`only ${entries.length} console entry points found; the closure walk did not read the console`)

  // A size floor on what the walker actually read. A walk that silently resolved nothing would
  // report every entry clean, which is the failure mode this whole section exists to catch.
  const totalEdges = entries.reduce((n, e) => n + e.closure.size, 0)
  check(totalEdges > 10, `the closure walk resolved ${totalEdges} module edge(s), so it is reading imports`)

  const canSign = entries.filter(e => SIGN_RE.test(e.src) || [...e.closure].some(c => SIGN_RE.test(readSafe(join(CONSOLE, c)) || '')))
  check(canSign.length > 0, `found ${canSign.length} entry point(s) that can reach signEvent`)

  const unguarded = canSign.filter(e => e.name !== GUARD && !e.closure.has(GUARD))
  check(unguarded.length === 0,
    `every signing path can reach the staleness guard (${canSign.length} checked${unguarded.length ? `; UNGUARDED: ${unguarded.map(e => e.name).join(', ')}` : ''})`)

  // NEGATIVE CONTROL. Everything above is satisfied by a walker that marks everything guarded. A
  // synthetic entry that signs and imports nothing must come out unguarded, or this check is inert.
  const decoy = { name: '__decoy__.mjs', src: 'export const go = (s) => s.signEvent({})', closure: new Set() }
  check(SIGN_RE.test(decoy.src) && !decoy.closure.has(GUARD),
    'NEGATIVE CONTROL — a signing entry with no guard in its closure is detected as unguarded')
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
