// watchlist.mjs — watch_authors hot-reload (#206 stage 1): change the watched set at RUNTIME,
// no restart. Drives the REAL addWatchAuthor/removeWatchAuthor against a temp config + dryrun
// routePublic. The properties that matter (and the trap they guard):
//   - PUB.authors AND the config file both update — a change that doesn't persist is lost on the
//     next real boot; a change that doesn't hit PUB.authors doesn't route;
//   - a registered refresher fires — this is the relay re-subscribe hook, the load-bearing half:
//     without it the routing would be right but nothing would FETCH the new author's posts (the
//     "two mechanisms, one load-bearing" trap the grant path already warned about);
//   - behaviourally: an added author's feed post is now routed as 'mirrored feed', a removed
//     author's is not. No sockets.
//
//   node tests/watchlist.mjs

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'

const tmp = mkdtempSync(join(tmpdir(), 'wb-watchlist-'))
const CHAN = '77777777-7777-7777-7777-777777777777'
const CFG = join(tmp, 'config.json')
const existing = getPublicKey(generateSecretKey())   // a pre-existing static watch author
writeFileSync(CFG, JSON.stringify({
  relays: [], recipients: [],
  public: { relays: [], inbox: CHAN, staging_inbox: CHAN, watch_authors: [existing], watch_events: [], grantors: [] },
}))
process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'dryrun'
process.env.CONFIG_PATH = CFG
process.env.SEEN_PATH = join(tmp, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(tmp, 'wm')
process.env.POSTED_MAP_PATH = join(tmp, 'pm.log')

const { addWatchAuthor, removeWatchAuthor, WATCH_REFRESHERS, PUB, routePublic } = await import('../src/bridge.mjs')

const realLog = console.log.bind(console)
let n = 0, pass = 0
const t = (name, cond) => { n++; if (cond) { pass++; realLog(`ok - ${name}`) } else realLog(`FAIL - ${name}`) }
const cfgAuthors = () => JSON.parse(readFileSync(CFG, 'utf8')).public.watch_authors
const wire = (ev) => JSON.parse(JSON.stringify(ev))
const feedPost = (sk) => wire(finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'hi' }, sk))

// Everything the bridge logs goes to buf; test output goes to realLog (as in consent_gate.mjs).
let buf = ''
console.log = console.error = (...a) => { buf += a.join(' ') + '\n' }
const routeOf = (ev) => { const b = buf.length; routePublic(ev); return buf.slice(b) }
const mirrored = (out) => /\(mirrored feed\)/.test(out)

// the relay re-subscribe hook — a spy in the SAME registry connectPublic would register into
let fired = 0
WATCH_REFRESHERS.add(() => { fired++ })

const sk = generateSecretKey(), X = getPublicKey(sk)

// --- 1. before add: X is a stranger, not mirrored ----------------------------------------------
t('X starts unwatched', !PUB.authors.includes(X))
t('  a stranger feed post is NOT routed as mirrored feed', !mirrored(routeOf(feedPost(sk))))

// --- 2. add X at runtime -----------------------------------------------------------------------
const firedBefore = fired
const r = addWatchAuthor(X)
t('addWatchAuthor returns added', r.ok === true && r.added === true)
t('  PUB.authors now includes X', PUB.authors.includes(X))
t('  the config file persisted X (survives a real reboot)', cfgAuthors().includes(X))
t('  the relay re-subscribe refresher fired (posts will actually be fetched)', fired === firedBefore + 1)
t('  now X\'s feed post IS routed as mirrored feed', mirrored(routeOf(feedPost(sk))))

// --- 3. idempotent add + validation ------------------------------------------------------------
const r2 = addWatchAuthor(X)
t('re-adding X is a no-op (already)', r2.ok === true && r2.already === true)
t('  the config has no duplicate', cfgAuthors().filter(a => a === X).length === 1)
t('addWatchAuthor rejects a non-hex pubkey (fails closed)', addWatchAuthor('not-a-key').ok === false)

// --- 4. remove X -------------------------------------------------------------------------------
const firedBefore2 = fired
const r3 = removeWatchAuthor(X)
t('removeWatchAuthor returns removed', r3.ok === true && r3.removed === true)
t('  PUB.authors no longer includes X', !PUB.authors.includes(X))
t('  the config file dropped X', !cfgAuthors().includes(X))
t('  the refresher fired again (relay filter updated)', fired === firedBefore2 + 1)
t('  X\'s feed post is no longer mirrored', !mirrored(routeOf(feedPost(sk))))

// --- 5. the pre-existing static author is untouched throughout ---------------------------------
t('the original watch_authors entry survived every mutation', cfgAuthors().includes(existing) && PUB.authors.includes(existing))

realLog(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
