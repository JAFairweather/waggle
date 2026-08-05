// Every owner-control surface must reuse the Access tab's session.
//
// `signer-session.mjs` exists because a page that calls `nip07Signer()` directly will
// silently sign under whichever `window.nostr` happens to be injected — or fail outright
// when there is none. Its header says so. But only one of three call sites had adopted it,
// so an owner signed in with a Bunker could activate an agent channel route and **could
// not** toggle publishing or manage following: those two pages reached for an extension
// that was not there and surfaced a raw provider error (#285).
//
// The regression is invisible to anyone testing with an extension installed, which is why
// it needs a test rather than care.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { consoleSigner, CONSOLE_SESSION_KEY } from '../console/signer-session.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const ok = (name, value) => { console.log(`${value ? 'ok  ' : 'FAIL'} — ${name}`); value ? pass++ : fail++ }

// ── no surface may reach for a raw browser signer ──────────────────────────────
// index.html is the one legitimate exception: it is the sign-in picker, so it CREATES the
// session that everything else then reuses. Naming the exception is the point — an
// unexplained allowance is how the other two drifted.
const SIGN_IN_PAGE = 'index.html'
const files = readdirSync(join(ROOT, 'console'))
  .filter(f => /\.(html|mjs)$/.test(f) && f !== 'signer-session.mjs')

const offenders = []
for (const f of files) {
  const src = readFileSync(join(ROOT, 'console', f), 'utf8')
  // The call, not the import name: `nip07Signer(` invoked outside the sign-in page.
  if (/\bnip07Signer\s*\(/.test(src) && f !== SIGN_IN_PAGE) offenders.push(f)
}
ok(`no console surface calls nip07Signer() directly except ${SIGN_IN_PAGE}`,
  offenders.length === 0, offenders.join(', '))
ok(`${SIGN_IN_PAGE} still creates a session (it is the sign-in surface)`,
  /\bnip07Signer\s*\(/.test(readFileSync(join(ROOT, 'console', SIGN_IN_PAGE), 'utf8')))

// Every page that signs an owner command must go through the shared session.
const OWNER_SURFACES = ['following.html', 'config.html', 'task-routes.mjs']
for (const f of OWNER_SURFACES) {
  const src = readFileSync(join(ROOT, 'console', f), 'utf8')
  ok(`${f} signs through the shared console session`, /consoleSigner\s*\(/.test(src))
}

// ── the session is preferred over an injected provider ───────────────────────
// The failure this prevents: a restored Bunker session being replaced by whatever
// window.nostr is present, which signs as a different identity.
const stubStore = (value) => ({ getItem: () => value, removeItem() {} })
const RESTORED = { id: 'restored-session-signer' }
const BROWSER = { id: 'injected-window-nostr' }

let restoredFrom = null
const withSession = await consoleSigner({
  storage: stubStore('{"kind":"nip46"}'), win: {},
  parse: (raw) => { restoredFrom = raw; return JSON.parse(raw) },
  restore: () => RESTORED,
  browserSigner: () => BROWSER,
})
ok('an established session is used, not the injected provider', withSession === RESTORED)
ok('the stored session is what gets parsed', restoredFrom === '{"kind":"nip46"}')

const noSession = await consoleSigner({
  storage: stubStore(null), win: {}, restore: () => RESTORED, browserSigner: () => BROWSER,
})
ok('with no session, an extension user still works — the fallback is the browser signer',
  noSession === BROWSER)

let removed = false
const broken = await consoleSigner({
  storage: { getItem: () => 'not json', removeItem() { removed = true } }, win: {},
  parse: () => { throw new Error('unparseable') },
  restore: () => RESTORED, browserSigner: () => BROWSER,
})
ok('an unparseable session is discarded rather than trusted', broken === BROWSER && removed)

const declined = await consoleSigner({
  storage: stubStore('{"kind":"local"}'), win: {},
  parse: (raw) => JSON.parse(raw),
  restore: () => null,               // nave-connect refuses to resurrect a local key
  browserSigner: () => BROWSER,
})
ok('a session the signer refuses to restore falls back rather than throwing', declined === BROWSER)

ok('the session key is the one the Access tab writes', CONSOLE_SESSION_KEY === 'waggle-console-session')

// ── freshness: one contract, not two ─────────────────────────────────────────
// A future-dated signed state must not read as fresh. Two of four readers applied the
// forward-skew clamp and two did not, so the same record was "fresh" on one page and
// rejected on another.
for (const f of ['following.html', 'config.html', 'task-routes.mjs', 'config-operations.mjs']) {
  const src = readFileSync(join(ROOT, 'console', f), 'utf8')
  ok(`${f} rejects a future-dated signed state`, /\+\s*60/.test(src))
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
