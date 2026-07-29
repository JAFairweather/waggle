// A7 NIP-09 deletion-propagation demonstration / regression test.
//
// Proves routeDelete (bridge.mjs): a watched author's VALID kind:5 withdraws our reposted
// copy of their note; a different author's delete of the same note is refused (authorship
// rule); an unknown target is a no-op; a replayed delete id is deduped to one action; a
// corrupted signature is dropped before anything is touched.
//
// Uses REAL signatures: two throwaway keys generated per run, both configured as watched
// authors via a test-written CONFIG_PATH (no test backdoor enters bridge.mjs — the a1
// trick of grounding in the live config can't sign as the real watched author).
//
// Side-effect-free: WB_STUB_SEND short-circuits every buzz CLI call after the real
// markSeen/watermark/posted-map bookkeeping, and all state paths point into a temp dir.
//
// Run: node tests/a7_deletion.mjs   (exit 0 = pass, 1 = fail)

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'

const tmp = mkdtempSync(join(tmpdir(), 'wb-a7-'))

const authorSk = generateSecretKey()
const authorPk = getPublicKey(authorSk)
const otherSk = generateSecretKey()   // second WATCHED author — exercises the authorship rule,
const otherPk = getPublicKey(otherSk) // not the (earlier) watched-author scope check

const COMMUNITY = '11111111-1111-1111-1111-111111111111'
const STAGING = '22222222-2222-2222-2222-222222222222'
writeFileSync(join(tmp, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: [], inbox: COMMUNITY, staging_inbox: STAGING,
    watch_authors: [authorPk, otherPk], watch_events: [],
    since_secs: 3600, deletes_per_hour: 20,
  },
}))

process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'buzz'      // exercise the real bookkeeping path…
process.env.WB_STUB_SEND = '1'         // …with every buzz CLI call stubbed out
process.env.CONFIG_PATH = join(tmp, 'config.json')
process.env.SEEN_PATH = join(tmp, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(tmp, 'watermark')
process.env.POSTED_MAP_PATH = join(tmp, 'posted-map.log')

const { routePublic, routeDelete, postedMap } = await import('../src/bridge.mjs')

let buf = ''
const cap = (...a) => { buf += a.join(' ') + '\n' }
console.log = cap
console.error = cap

const now = () => Math.floor(Date.now() / 1000)
// Serialize to WIRE FORM: finalizeEvent stamps a verified-symbol that verifyEvent trusts
// blindly, but a relay-delivered event is plain JSON — which is also what the bridge sees.
const sign = (sk, tmpl) => JSON.parse(JSON.stringify(finalizeEvent({ created_at: now(), tags: [], content: '', ...tmpl }, sk)))

// Repost three notes by the primary watched author (posted-map entries via the stub seam).
const note1 = sign(authorSk, { kind: 1, content: 'note one' })
const note3 = sign(authorSk, { kind: 1, content: 'note three' })
const note4 = sign(authorSk, { kind: 1, content: 'note four' })
routePublic(note1); routePublic(note3); routePublic(note4)

// Case A — valid delete by the same author -> tier-1 (stub) withdrawal.
const del1 = sign(authorSk, { kind: 5, tags: [['e', note1.id]] })
routeDelete(del1)
// Case B — the OTHER watched author deletes note3 -> author-mismatch, copy untouched.
const delMismatch = sign(otherSk, { kind: 5, tags: [['e', note3.id]] })
routeDelete(delMismatch)
// Case C — delete referencing an unknown id -> no action.
const delUnknown = sign(authorSk, { kind: 5, tags: [['e', 'a'.repeat(64)]] })
routeDelete(delUnknown)
// Case D — the SAME delete id replayed (relay fan-in) -> deduped, still one action total.
routeDelete(del1)
// Case E — corrupted signature targeting note4 -> dropped before any lookup.
const delBadSig = sign(authorSk, { kind: 5, tags: [['e', note4.id]] })
delBadSig.sig = (delBadSig.sig[0] === '0' ? '1' : '0') + delBadSig.sig.slice(1)
routeDelete(delBadSig)

const out = buf
const count = (sub) => out.split('\n').filter(l => l.includes(sub)).length

let pass = true
const check = (cond, label) => { console.info(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

check(count(`A7 ok[stub-delete]: withdrew ${note1.id.slice(0, 12)}`) === 1,
  'valid same-author delete -> exactly one tier-1 withdrawal')
check(postedMap.get(note1.id)?.deleted === true,
  'posted-map marks note1 withdrawn')
check(count('A7 drop[author-mismatch]') === 1 && postedMap.get(note3.id)?.deleted === false,
  'cross-author delete refused, note3 copy untouched')
check(!out.includes(`withdrew ${'a'.repeat(12)}`) && count('A7 ok[') === 1,
  'unknown target -> no action')
check(count('A7 drop[bad-signature]') === 1 && postedMap.get(note4.id)?.deleted === false,
  'corrupted signature dropped, note4 copy untouched')

console.info(pass ? '\nA7 PASS — deletion propagation holds' : '\nA7 FAIL')
process.exit(pass ? 0 : 1)
