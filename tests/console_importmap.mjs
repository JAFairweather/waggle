// console_importmap.mjs — every console page must MAP every bare specifier its module graph imports.
//
// Why this exists. `console/agents.html` shipped with an importmap covering `nostr-tools` but not
// `nostr-tools/pool`, which `console/signer-session.mjs` reaches through `vendor/nave-connect.mjs`.
// The browser then failed to resolve the module and STOPPED EXECUTING THE WHOLE SCRIPT — so not one
// handler on the page was ever attached. Every button was inert.
//
// The two things that make this worth a suite of its own:
//
//   1. It is INVISIBLE to everything else. `npm test` has no browser. `node --check` passes, because
//      the syntax is fine. The page renders its full markup, so a screenshot looks correct. Even the
//      browser console is quiet by the time you attach to it — I loaded the page, read the console,
//      found no errors, and concluded it worked. It did not. The only symptom is that nothing
//      happens when you click, which is exactly what a page you have not clicked looks like.
//   2. `console/following.html` had the SAME defect, already on main, in production. It was not
//      found by review, by CI, or by use.
//
// So this asserts the property mechanically rather than trusting anyone to notice. It is static: it
// parses import statements out of the page's inline module and every local module it reaches, and
// checks each bare specifier against that page's own importmap. Static is the point — a runtime
// check would need a browser, and the absence of one is how this survived.
//
//   node tests/console_importmap.mjs

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONSOLE = join(ROOT, 'console')

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

// A bare specifier is anything that is not a path. Those are the ones an importmap must name;
// './x.mjs' and '../y.mjs' resolve on their own.
const isBare = spec => !spec.startsWith('.') && !spec.startsWith('/')
const IMPORT_RE = /(?:^|\n)\s*import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function specifiersIn(text) {
  const out = []
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) out.push(m[1])
  }
  return out
}

// Walk the local module graph from a page, collecting every bare specifier reachable from it.
function reachableBareSpecifiers(startText, startDir) {
  const bare = new Set()
  const seen = new Set()
  const queue = [[startText, startDir]]
  while (queue.length) {
    const [text, dir] = queue.shift()
    for (const spec of specifiersIn(text)) {
      if (isBare(spec)) { bare.add(spec); continue }
      const file = resolve(dir, spec)
      if (seen.has(file) || !existsSync(file)) continue
      seen.add(file)
      queue.push([readFileSync(file, 'utf8'), dirname(file)])
    }
  }
  return bare
}

const pages = readdirSync(CONSOLE).filter(f => f.endsWith('.html')).sort()
check(pages.length > 0, `found ${pages.length} console pages to check`)

let pagesWithModules = 0
for (const page of pages) {
  const html = readFileSync(join(CONSOLE, page), 'utf8')
  // Two shapes, and missing the second is how a page hides from a check like this: an INLINE
  // module, and an EXTERNAL one via src=. routing.html uses the second, so an inline-only scan
  // skipped it silently and reported ALL PASS while never looking at it.
  const inline = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(m => m[1])
  const external = [...html.matchAll(/<script type="module"[^>]*\ssrc="([^"]+)"/g)]
    .map(m => resolve(CONSOLE, m[1]))
    .filter(f => { const there = existsSync(f); check(there, `${page}: its module src exists (${f.replace(ROOT + '/', '')})`); return there })
    .map(f => readFileSync(f, 'utf8'))
  const moduleBody = [...inline, ...external].join('\n')
  if (!moduleBody.trim()) continue
  pagesWithModules++

  const mapMatch = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)
  const mapped = new Set()
  if (mapMatch) {
    let parsed
    try { parsed = JSON.parse(mapMatch[1]) } catch { parsed = null }
    check(parsed !== null, `${page}: its importmap is valid JSON`)
    for (const key of Object.keys(parsed?.imports || {})) mapped.add(key)
  }

  const needed = reachableBareSpecifiers(moduleBody, CONSOLE)
  const missing = [...needed].filter(spec => !mapped.has(spec)).sort()
  check(missing.length === 0,
    `${page}: every bare specifier its module graph reaches is in its importmap` +
      (missing.length ? ` — MISSING ${missing.join(', ')}; the browser stops executing the whole script and NO handler attaches` : ''))

  // Mapping a specifier to a file that is not there fails the same way, silently.
  for (const [spec, target] of Object.entries(JSON.parse(mapMatch?.[1] || '{"imports":{}}').imports || {})) {
    if (!target.startsWith('.')) continue
    check(existsSync(resolve(CONSOLE, target)), `${page}: "${spec}" maps to a file that exists (${target})`)
  }
}
check(pagesWithModules >= 5, `and ${pagesWithModules} of them actually carry a module to check — a scan that found none would pass vacuously`)

// NEGATIVE CONTROL. Every assertion above has only ever been asked to pass. Prove the walker can
// see a missing specifier at all, using the exact defect that shipped: a page importing
// signer-session.mjs with only `nostr-tools` mapped.
const control = reachableBareSpecifiers("import { consoleSigner } from './signer-session.mjs'", CONSOLE)
check(control.has('nostr-tools/pool'),
  'NEGATIVE CONTROL — the walker reaches nostr-tools/pool THROUGH signer-session and nave-connect, ' +
  'which is the transitive hop that made this invisible to eyeballing the page')
check(!control.has('./vendor/nave-connect.mjs'),
  'and it does not report relative paths as bare specifiers — those resolve without an importmap')

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
