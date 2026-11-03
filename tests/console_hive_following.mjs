// #649 — Following on the hive page. The owner chooses which public writers enter the hive; one
// signed watchlist command changes it, and "done" is the bridge's next state showing it.
//
//  1. A pasted npub, nprofile, profile link or hex key resolves to the writer; a secret never does.
//  2. The page's draft is accepted by the bridge's REAL watchlist handler, and changes its list.
//  3. Signing refuses an edited or foreign-key event before anything is published.
//  4. "Done" is a newer bridge state showing the change, never a relay OK.
//  5. The page wires it in.
//
//   node tests/console_hive_following.mjs

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { followsOf, writerKey, draftFollow, followVerdict, applyFollow, WATCHLIST_D } from '../console/hive-following.mjs'

const key = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) } }
const O = key(), X = key(), W = key(), B = key()
const now = Math.floor(Date.now() / 1000)
let fails = 0
const check = (c, n) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }
const throws = (f, re) => { try { f(); return false } catch (e) { return re.test(e.message) } }

// ── 1. What the owner pastes ────────────────────────────────────────────────────────────────────
const npub = nip19.npubEncode(W.pk)
check(writerKey(npub, nip19.decode) === W.pk, 'an npub resolves to the writer')
check(writerKey(` ${npub.toUpperCase()} `, nip19.decode) === W.pk, '…in any case, with spaces around it')
check(writerKey(nip19.nprofileEncode({ pubkey: W.pk, relays: ['wss://nos.lol'] }), nip19.decode) === W.pk, 'an nprofile resolves to the writer')
check(writerKey(`https://primal.net/p/${npub}`, nip19.decode) === W.pk, 'a profile link resolves to the writer')
check(writerKey(W.pk.toUpperCase(), nip19.decode) === W.pk, 'a 64-character key resolves to the writer')
check(throws(() => writerKey(nip19.nsecEncode(W.sk), nip19.decode), /private key/), 'a private key is refused, and says so')
check(throws(() => writerKey('bunker://abc?relay=wss://x', nip19.decode), /Bunker/), 'so is a Bunker link')
check(throws(() => writerKey('jack', nip19.decode), /npub/), 'a bare name asks for an npub')
check(throws(() => writerKey(npub.slice(0, -3) + 'qqq', nip19.decode), /decode/), 'a damaged npub is caught')

// ── 2. The bridge's own handler accepts the page's draft ─────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'wb-hive-following-'))
writeFileSync(join(dir, 'config.json'), JSON.stringify({ relays: [], recipients: [], public: {
  relays: [], inbox: '3f2b9c14-7d0e-4a58-9b61-c8ee4a70d215', watch_authors: [], watch_events: [], approvers: [O.pk], grantors: [] } }))
process.env.CONFIG_PATH = join(dir, 'config.json')
process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'dryrun'
process.env.SEEN_PATH = join(dir, 'seen.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(B.sk).toString('hex')
const { handleWatchlistControlCommand, PUB } = await import('../src/bridge.mjs')
const follow = draftFollow({ bridge: B.pk, target: W.pk, follow: true, now: now - 5 })
check(follow.tags[0][1] === WATCHLIST_D && follow.tags[1][1] === B.pk, 'the draft is the narrow watchlist command, addressed to the bridge')
check(handleWatchlistControlCommand(finalizeEvent(follow, O.sk)).ok && PUB.authors.includes(W.pk), "the bridge's real handler accepts Follow and follows the writer")
check(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).public.watch_authors.includes(W.pk), '…and saves it')
check(!handleWatchlistControlCommand(finalizeEvent(draftFollow({ bridge: B.pk, target: X.pk, follow: true, now: now - 4 }), X.sk)).ok && !PUB.authors.includes(X.pk),
  'the same command signed by someone who is not an approver changes nothing')
check(handleWatchlistControlCommand(finalizeEvent(draftFollow({ bridge: B.pk, target: W.pk, follow: false, now: now - 3 }), O.sk)).ok && !PUB.authors.includes(W.pk),
  'Stop following removes them')
check(throws(() => draftFollow({ bridge: '', target: W.pk, follow: true }), /bridge key/), 'no bridge key, no draft')

// ── 3 & 4. Sign, publish, confirm ───────────────────────────────────────────────────────────────
function relays(modes) {
  const sent = []
  const connect = url => {
    if (modes[url] === 'down') throw new Error('refused')
    const ws = { send(raw) { const m = JSON.parse(raw); if (m[0] === 'EVENT') { sent.push(url); setTimeout(() => ws.onmessage?.({ data: JSON.stringify(['OK', m[1].id, true, '']) }), 0) } }, close() {} }
    setTimeout(() => ws.onopen?.(), 0)
    return ws
  }
  return { connect, sent }
}
const URLS = ['wss://a.example', 'wss://b.example']
const state = (at, follows) => ({ v: 1, observed_at: at, follows: follows.map(pubkey => ({ pubkey, consent: 'pending' })) })
const before = state(now - 30, [])
const signAs = (k, edit = t => t) => async t => finalizeEvent(edit({ ...t, tags: t.tags.map(x => [...x]) }), k.sk)
const run = (template, opts) => applyFollow(template, { owner: O.pk, verify: verifyEvent, relays: URLS, before, sleep: async () => {}, pollMs: 1, waitMs: 5, timeoutMs: 500, ...opts })
const rejects = async (p, re) => { try { await p; return false } catch (e) { return re.test(e.message) } }
const t = draftFollow({ bridge: B.pk, target: W.pk, follow: true })
{
  const net = relays({})
  check(await rejects(run(t, { sign: signAs(O, x => ({ ...x, content: x.content.replace('mirror', 'unmirror') })), connect: net.connect, readStates: async () => [] }), /not the one shown/) && net.sent.length === 0,
    'an event changed by the signer is refused before any relay is sent it')
  check(await rejects(run(t, { sign: signAs(X), connect: net.connect, readStates: async () => [] }), /different key/) && net.sent.length === 0, 'so is one signed by another key')
  check(await rejects(run(t, { sign: signAs(O), connect: net.connect, readStates: async () => [], before: state(now - 3600, []) }), /./) && net.sent.length === 0,
    'a bridge state too old to act on stops the change before it is signed')
}
check(await rejects(run(t, { sign: signAs(O), connect: relays({ [URLS[0]]: 'down', [URLS[1]]: 'down' }).connect, readStates: async () => [] }), /No relay accepted/), 'no relay accepting it is an error')
{
  const r = await run(t, { sign: signAs(O), connect: relays({}).connect, readStates: async () => [before] })
  check(r.verdict.done === false && /Not shown yet/.test(r.text) && /2 of 2 relays/.test(r.text), 'relays accepting it is "sent", not done')
}
{
  let reads = 0
  const r = await run(t, { sign: signAs(O), connect: relays({}).connect, readStates: async () => (++reads < 3 ? [before] : [state(now, [W.pk])]) })
  check(r.verdict.done === true && /now follows them/.test(r.text) && reads === 3, 'done once a newer bridge state shows them followed')
}
check(followVerdict(draftFollow({ bridge: B.pk, target: W.pk, follow: false }), state(now - 30, [W.pk]), [state(now, [])]).done === true, 'a stop is done when a newer state no longer lists them')
check(/may have refused/.test(followVerdict(t, before, [state(now, [])]).text), 'a newer state without the change says the bridge may have refused it')
{
  const ahead = state(now + 3600, [W.pk])
  check(followVerdict(t, before, [ahead], now).done === false && /Not shown yet/.test(followVerdict(t, before, [ahead], now).text), 'a far-future state alone is not done: it is outside the freshness rule')
  check(followVerdict(t, before, [state(now, []), ahead], now).done === false, 'a fresh state without the change beside a far-future one with it: not done')
  check(followVerdict(t, before, [ahead, state(now, [W.pk])], now).done === true, 'a fresh state with the change beside a far-future one: done')
  const r = await run(t, { sign: signAs(O), connect: relays({}).connect, readStates: async () => [before, ahead] })
  check(r.verdict.done === false && /Not shown yet/.test(r.text), 'the Follow flow does not report done from a far-future state')
}
check(followsOf({ follows: [{ pubkey: W.pk }, { pubkey: 'nope' }, { pubkey: W.pk }] }).join() === W.pk, 'the list keeps only real keys, once each')

// ── 5. The page ─────────────────────────────────────────────────────────────────────────────────
const page = readFileSync(new URL('../console/hive.html', import.meta.url), 'utf8')
check(/from '\.\/hive-following\.mjs'/.test(page) && /id="following-panel"/.test(page), 'the hive page has a Following section built on this module')
check(/applyFollow\(/.test(page) && /writerKey\(/.test(page) && /nip19\.decode/.test(page), '…which signs through applyFollow and reads pasted writers with writerKey')
check(!/consent/i.test(page.slice(page.indexOf('id="following-panel"'), page.indexOf('</section>', page.indexOf('id="following-panel"')))), '…and says nothing about consent')

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
