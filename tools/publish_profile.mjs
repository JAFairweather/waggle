#!/usr/bin/env node
// publish_profile.mjs — one kind:0 on both sides of the wall, signed by a bunker (#367).
//
// WHY THIS EXISTS. An agent's `@Name` resolves against a `users` row that Buzz writes only in
// `handle_kind0_profile`, keyed on `event.pubkey` — so the name needs a kind:0 authored by the
// agent's OWN key on the community relay. waggle cannot publish it on the agent's behalf:
// `event.rs` rejects any event whose pubkey differs from the authenticated identity.
//
// LukeDog cleared that with a directly-held nsec, and became nameable. MC Claude's identity is
// Bunker-held by design (`docs/DESIGN_JOIN.md` — A lives in the owner's Bunker, the session holds
// a NIP-46 pairing and no key), so the same path stopped: every kind:0 publisher in this repo
// takes `--key <path>` and calls finalizeEvent locally. This tool is that gap closed. It signs
// through the same `loadNostrSigner` the sealed transport uses, so a bunker works and no nsec has
// to exist for the name to resolve.
//
// THE DUAL PUSH, and the honest shape of "common". `publish_relay_list.mjs` established the
// pattern for the kind:10002: plain event to the public trio, auth-tagged copy to the community
// relay over NIP-98. This is that pattern for the kind:0. The two copies carry the SAME CONTENT
// and are NOT the same event — the community copy carries the auth tag, so it has a different id.
// Common means one profile, verifiably byte-identical in `content`; it does not mean one event,
// and this tool never reports it as one.
//
// CONTENT IS ADOPTED, NEVER INVENTED. By default the profile is read back off the trio and reused
// verbatim, because the failure worth preventing is a second, drifting profile that disagrees with
// the one already published. `--content-file` exists for a first publish, when there is nothing to
// adopt. If neither yields content this tool refuses rather than writing an empty face.
//
// IT PRODUCES THE CUSTODY EVIDENCE #308 STATE 2 IS MISSING. A bunker URI is not proof the bunker
// controls the identity, and `signer.pubkey` is only what the URI CLAIMS. What proves it is a
// signature that verifies against the expected key, which this tool has in hand anyway — so it
// checks it, names it as the evidence, and refuses on a mismatch. Set EXPECT_PUBKEY to arm it.
//
//   WAGGLE_BUNKER_URI_FILE=<path> WAGGLE_NIP46_CLIENT_NSEC_FILE=<path> \
//   BUZZ_RELAY_URL=<same value the buzz CLI uses> BUZZ_AUTH_TAG='["auth","…"]' \
//   EXPECT_PUBKEY=<64-hex> node tools/publish_profile.mjs
//
//     --content-file <path>   publish this JSON instead of adopting the trio's copy
//     --dry-run               build, verify, print — publish nothing
//
// SECRETS. Nothing here reads a key from argv or prints one. The bunker pairing is two mode-0600
// files read by `loadNostrSigner`; this tool never sees the URI. BUZZ_AUTH_TAG is a bearer value
// and is never echoed — only whether it was present.
//
// Exit: 0 both sides confirmed by cold read-back · 1 bad input · 2 relay/network · 3 INCONCLUSIVE
//       (it ran and could not tell you — including a community relay that will not serve the
//       read-back) · 4 a relay answered and its answer is a refusal. That IS the result.

import WebSocket from 'ws'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { verifyEvent } from 'nostr-tools/pure'
import { DEFAULT_PUBLIC_RELAYS as TRIO } from '../src/relays.mjs'
import { loadNostrSigner } from '../src/nostr_signer.mjs'

const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1] }
const has = (n) => args.includes(n)
const now = () => Math.floor(Date.now() / 1000)
const say = (m) => console.error(m)
const die = (m, code = 1) => { console.error(`publish_profile: ${m}`); process.exit(code) }
const hash = (s) => createHash('sha256').update(s).digest('hex')

// ── the relay round trips ────────────────────────────────────────────────────────────────────
// Two separate functions on purpose. A push that returns OK and a read that returns the event are
// different claims, and this repo only believes the second one.

function pushWs(url, ev) {
  return new Promise(res => {
    let ws
    try { ws = new WebSocket(url) } catch { return res({ url, note: 'CONNECT-FAIL', ok: false }) }
    const done = (note, ok) => { try { ws.close() } catch { /* closed */ } res({ url, note, ok }) }
    const t = setTimeout(() => done('TIMEOUT', false), 12000)
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', ev])))
    ws.on('message', d => {
      try {
        const m = JSON.parse(d.toString())
        if (m[0] === 'OK' && m[1] === ev.id) { clearTimeout(t); done(m[2] ? 'OK' : `REJECTED: ${m[3]}`, !!m[2]) }
      } catch { /* ignore non-JSON */ }
    })
    ws.on('error', e => { clearTimeout(t); done(`ERR ${e.message}`, false) })
  })
}

// Cold read-back: a fresh connection, and the answer is the newest kind:0 the relay will actually
// serve for this author. `answered` is tracked separately from `found` because a relay that never
// sent EOSE has told us nothing, and that is exit 3 rather than a failure.
function readBackWs(url, pubkey) {
  return new Promise(res => {
    let ws, newest = null, answered = false
    try { ws = new WebSocket(url) } catch { return res({ url, answered: false, newest: null }) }
    const done = () => { try { ws.close() } catch { /* closed */ } res({ url, answered, newest }) }
    const t = setTimeout(done, 12000)
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'pp', { kinds: [0], authors: [pubkey], limit: 5 }])))
    ws.on('message', d => {
      try {
        const m = JSON.parse(d.toString())
        if (m[0] === 'EVENT' && verifyEvent(m[2]) && m[2].pubkey === pubkey &&
            (!newest || m[2].created_at > newest.created_at)) newest = m[2]
        if (m[0] === 'EOSE' || m[0] === 'CLOSED') { answered = m[0] === 'EOSE'; clearTimeout(t); done() }
      } catch { /* ignore non-JSON */ }
    })
    ws.on('error', () => { clearTimeout(t); done() })
  })
}

const httpBase = () => process.env.BUZZ_RELAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '')

// The community-relay leg. NIP-98 over HTTP with the owner-minted auth tag, exactly as
// publish_relay_list.mjs does it — the only difference here is that the NIP-98 event is signed by
// the signer rather than by a secret key this process holds.
async function pushCommunity(signer, ev) {
  const url = httpBase() + '/events'
  const body = JSON.stringify(ev)
  const nip98 = await signer.signEvent({
    kind: 27235, created_at: now(), content: '',
    tags: [['u', url], ['method', 'POST'], ['payload', hash(body)]],
  })
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Nostr ' + Buffer.from(JSON.stringify(nip98)).toString('base64'),
      'x-auth-tag': process.env.BUZZ_AUTH_TAG,
    },
    body,
  })
  return { status: r.status, text: (await r.text()).slice(0, 200) }
}

// The read-back on the community leg is ATTEMPTED, and whatever happens is reported as itself.
// This tool does not know that relay's query API and will not invent one: an unparseable or
// refused answer is INCONCLUSIVE, never a pass. Being unable to check is not the same as fine.
async function readBackCommunity(signer, pubkey) {
  const url = `${httpBase()}/events?kinds=0&authors=${pubkey}&limit=5`
  let nip98
  try {
    nip98 = await signer.signEvent({
      kind: 27235, created_at: now(), content: '',
      tags: [['u', url], ['method', 'GET']],
    })
  } catch (e) { return { reachable: false, why: `could not sign the read: ${e.message}` } }
  let r
  try {
    r = await fetch(url, {
      headers: {
        authorization: 'Nostr ' + Buffer.from(JSON.stringify(nip98)).toString('base64'),
        'x-auth-tag': process.env.BUZZ_AUTH_TAG,
      },
    })
  } catch (e) { return { reachable: false, why: `read failed: ${e.message}` } }
  const text = await r.text()
  if (!r.ok) return { reachable: false, why: `${r.status} ${text.slice(0, 160)}` }
  let events
  try {
    const parsed = JSON.parse(text)
    events = Array.isArray(parsed) ? parsed : (parsed.events || parsed.data || null)
  } catch { return { reachable: false, why: `answer was not JSON this tool can read: ${text.slice(0, 120)}` } }
  if (!Array.isArray(events)) return { reachable: false, why: 'answer had no event array this tool recognises' }
  const mine = events.filter(e => e && e.kind === 0 && e.pubkey === pubkey && verifyEvent(e))
  const newest = mine.sort((a, b) => b.created_at - a.created_at)[0] || null
  return { reachable: true, newest }
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────

const dryRun = has('--dry-run')
const contentFile = flag('--content-file')

let signer
try { signer = loadNostrSigner(process.env) } catch (e) { die(e.message) }

const expect = (process.env.EXPECT_PUBKEY || '').toLowerCase()
if (expect && !/^[0-9a-f]{64}$/.test(expect)) die('EXPECT_PUBKEY must be 64-character hex')

say(`publish_profile: signing via ${signer.remote ? 'a remote signer (NIP-46)' : 'a local key'} as ${signer.pubkey}`)
if (signer.remote && !expect)
  say('  note: EXPECT_PUBKEY is unset, so the custody check below proves a signature but not that it is the identity you meant.')

// Adopt the existing profile unless one was handed in. Reading first also means a run that cannot
// see the trio at all stops here rather than publishing a face nobody asked for.
let content = null
if (contentFile) {
  try { content = readFileSync(contentFile, 'utf8').trim() } catch (e) { die(`--content-file: ${e.message}`) }
  try { JSON.parse(content) } catch { die('--content-file must hold the JSON body of a kind:0 (an object)') }
  say(`  content adopted from ${contentFile}`)
} else {
  say('  reading the existing kind:0 off the trio to adopt its content verbatim…')
  const seen = await Promise.all(TRIO.map(u => readBackWs(u, signer.pubkey)))
  const answered = seen.filter(s => s.answered).length
  const newest = seen.map(s => s.newest).filter(Boolean).sort((a, b) => b.created_at - a.created_at)[0]
  for (const s of seen)
    say(`    ${s.url.replace('wss://', '').padEnd(22)} ${s.answered ? (s.newest ? 'has one' : 'none') : 'NO ANSWER'}`)
  if (!answered) die('no trio relay answered, so this is a fact about the read, not about the profile', 3)
  if (!newest) die('no existing kind:0 to adopt. Pass --content-file for a first publish.', 3)
  content = newest.content
  say(`  adopted the copy from ${new Date(newest.created_at * 1000).toISOString()} (content sha256 ${hash(content).slice(0, 16)}…)`)
}

// Two events, same content. The community copy carries the auth tag, which is why its id differs —
// stated here because "one profile" and "one event" are not the same claim.
const created_at = now()
const trioEvent = await signer.signEvent({ kind: 0, created_at, tags: [], content })

if (!verifyEvent(trioEvent)) die('the signer returned an event that does not verify — nothing published', 2)
if (expect && trioEvent.pubkey !== expect)
  die(`CUSTODY MISMATCH: the signer signed as ${trioEvent.pubkey}, not ${expect}. Nothing published.`, 1)
say(`  CUSTODY PROVEN: a signature by ${trioEvent.pubkey} verifies${expect ? ' and equals EXPECT_PUBKEY' : ''}.`)
say(`    This is the pubkey-comparison evidence #308 state 2 asks for — a signature from where the key lives,`)
say('    not a manifest value or an npub read off a screen. Narrow: it proves custody right now, nothing later.')

const community = process.env.BUZZ_RELAY_URL && process.env.BUZZ_AUTH_TAG
let communityEvent = null
if (community) {
  const authTag = (() => { try { return JSON.parse(process.env.BUZZ_AUTH_TAG) } catch { return die('BUZZ_AUTH_TAG must be a JSON array, e.g. \'["auth","…"]\'') } })()
  if (!Array.isArray(authTag)) die('BUZZ_AUTH_TAG must be a JSON array')
  communityEvent = await signer.signEvent({ kind: 0, created_at, tags: [authTag], content })
  if (!verifyEvent(communityEvent)) die('the signer returned a community copy that does not verify', 2)
}

say('')
say(`  trio copy       ${trioEvent.id}`)
say(`  community copy  ${communityEvent ? communityEvent.id : '(skipped — BUZZ_RELAY_URL / BUZZ_AUTH_TAG unset)'}`)
say(`  same content    sha256 ${hash(content).slice(0, 16)}… — different ids, because the community copy carries the auth tag`)

if (dryRun) { say('publish_profile: --dry-run — nothing published'); process.exit(0) }

say('')
say('== push ==')
const pushed = await Promise.all(TRIO.map(u => pushWs(u, trioEvent)))
for (const p of pushed) say(`  ${p.url.replace('wss://', '').padEnd(22)} ${p.note}`)
let communityPush = null
if (communityEvent) {
  try { communityPush = await pushCommunity(signer, communityEvent) } catch (e) { communityPush = { status: 0, text: e.message } }
  say(`  community relay        ${communityPush.status} ${communityPush.text}`)
}

// Cold read-back. Fresh connections, and the assertion is on the CONTENT hash rather than the id,
// because the two copies are deliberately different events.
say('')
say('== cold read-back ==')
const want = hash(content)
const back = await Promise.all(TRIO.map(u => readBackWs(u, signer.pubkey)))
let trioConfirmed = 0, trioSilent = 0
for (const b of back) {
  const match = b.newest && hash(b.newest.content) === want
  if (!b.answered) trioSilent++
  if (match) trioConfirmed++
  say(`  ${b.url.replace('wss://', '').padEnd(22)} ${b.answered ? (match ? 'CONFIRMED' : (b.newest ? 'serves a DIFFERENT profile' : 'not found')) : 'no answer'}`)
}

let communityVerdict = 'skipped'
if (communityEvent) {
  const r = await readBackCommunity(signer, signer.pubkey)
  if (!r.reachable) { communityVerdict = 'INCONCLUSIVE'; say(`  community relay        INCONCLUSIVE — ${r.why}`) }
  else if (r.newest && hash(r.newest.content) === want) { communityVerdict = 'confirmed'; say('  community relay        CONFIRMED') }
  else { communityVerdict = 'absent'; say(`  community relay        ${r.newest ? 'serves a DIFFERENT profile' : 'not found'}`) }
}

say('')
say(`publish_profile: trio ${trioConfirmed}/${TRIO.length} confirmed · community ${communityVerdict}`)

// The verdict, in the order that matters. A refusal is a result and gets its own code; being
// unable to see is exit 3 and never a pass; only both sides confirmed is a 0.
if (communityPush && communityPush.status >= 400) {
  say(`  the community relay REFUSED the push (${communityPush.status}). That is the answer, not a failure of this tool.`)
  process.exit(4)
}
if (!trioConfirmed && trioSilent === TRIO.length) process.exit(3)
if (communityVerdict === 'INCONCLUSIVE') {
  say('  the trio leg is proven; the community leg is not — this tool could not read that relay back.')
  say('  Do not record the name as resolving on the strength of a push that was never read back.')
  process.exit(3)
}
if (!trioConfirmed || (communityEvent && communityVerdict !== 'confirmed')) process.exit(2)
process.exit(0)
