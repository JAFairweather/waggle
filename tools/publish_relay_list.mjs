#!/usr/bin/env node
// Corrected NIP-65 relay-list (kind:10002) publisher — Phase 2(a).
//
// Fixes the two defects in the fleet's existing lists: they advertise the auth-gated
// fleet relay (401/NIP-42 to strangers — an outbox-model client mentioning us hits it
// and is refused) and nothing depends on it being there (Buzz-internal delivery doesn't
// use the 10002). Correct shape: TRIO-ONLY, drop the fleet relay.
//
// Markerless on purpose: in NIP-65 a markerless `r` tag MEANS read+write, which is
// exactly true today (our write relays == the relays the read lane watches == the trio).
// Add explicit read/write markers only when those sets actually diverge (member-
// configurable write relays, §9/C4) — markers on a symmetric list are non-idiomatic.
//
// NON-CUSTODIAL: each identity's holder runs this with THEIR OWN key in env. Run order:
// the read-lane engineer's first (the one identity with no list at all), then the rest.
//
//   BUZZ_PRIVATE_KEY=<nsec1…|hex> [BUZZ_RELAY_URL=… BUZZ_AUTH_TAG=…] \
//   [EXPECT_PUBKEY=<hex>] node tools/publish_relay_list.mjs
//
// Pushes the plain event to the public trio (per-relay OK frame reported) and, when the
// fleet env pair is present, an auth-tagged copy to the fleet relay over NIP-98 — the
// same dual-push as the proven profile publisher. Then READS BACK from each trio relay
// and asserts the newest served 10002 is the one just published: cold read-back is the
// only proof of federation. Publishing a 10002 is pure discoverability — it opens ZERO
// inbound flow (that gate is the read lane's per-recipient #p watch, a separate switch).

import WebSocket from 'ws'
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { createHash } from 'node:crypto'
import { DEFAULT_PUBLIC_RELAYS } from '../src/relays.mjs'

// One definition, in src/relays.mjs. This constant was named TRIO and held two entries — which is
// the shape of the bug in #345: nobody rereads a name they wrote themselves.
const TRIO = DEFAULT_PUBLIC_RELAYS
const now = () => Math.floor(Date.now() / 1000)
const die = (m) => { console.error(`publish_relay_list: ${m}`); process.exit(1) }

const raw = process.env.BUZZ_PRIVATE_KEY || die('set BUZZ_PRIVATE_KEY (nsec1… or 64-hex)')
const sk = raw.startsWith('nsec1') ? nip19.decode(raw).data : Uint8Array.from(Buffer.from(raw, 'hex'))
const pk = getPublicKey(sk)
if (process.env.EXPECT_PUBKEY && process.env.EXPECT_PUBKEY.toLowerCase() !== pk)
  die(`key mismatch: derived ${pk}, expected ${process.env.EXPECT_PUBKEY} — wrong identity in env`)

const relayTags = TRIO.map(r => ['r', r]) // trio-only, markerless (= read+write), no fleet relay

function pushWs(url, ev) {
  return new Promise(res => {
    let ws
    try { ws = new WebSocket(url) } catch { return res(`${url.padEnd(26)} CONNECT-FAIL`) }
    const done = m => { try { ws.close() } catch { /* closed */ } res(`${url.padEnd(26)} ${m}`) }
    const t = setTimeout(() => done('TIMEOUT'), 12000)
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', ev])))
    ws.on('message', d => {
      try {
        const m = JSON.parse(d.toString())
        if (m[0] === 'OK' && m[1] === ev.id) { clearTimeout(t); done(m[2] ? 'OK' : `REJECTED: ${m[3]}`) }
      } catch { /* ignore non-JSON */ }
    })
    ws.on('error', e => { clearTimeout(t); done(`ERR ${e.message}`) })
  })
}

// Keyless read-back: newest kind:10002 this relay serves for our pubkey.
function newest10002(url) {
  return new Promise(res => {
    let ws, best = null
    try { ws = new WebSocket(url) } catch { return res(null) }
    const done = () => { try { ws.close() } catch { /* closed */ } res(best) }
    const t = setTimeout(done, 10000)
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'rb', { kinds: [10002], authors: [pk], limit: 3 }])))
    ws.on('message', d => {
      try {
        const m = JSON.parse(d.toString())
        if (m[0] === 'EVENT' && m[2] && (!best || m[2].created_at > best.created_at)) best = m[2]
        if (m[0] === 'EOSE') { clearTimeout(t); done() }
      } catch { /* ignore */ }
    })
    ws.on('error', () => { clearTimeout(t); done() })
  })
}

async function pushFleet(ev) {
  const url = process.env.BUZZ_RELAY_URL.replace(/^wss:/, 'https:').replace(/\/$/, '') + '/events'
  const body = JSON.stringify(ev)
  const nip98 = finalizeEvent({
    kind: 27235, created_at: now(), content: '',
    tags: [['u', url], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')]],
  }, sk)
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Nostr ' + Buffer.from(JSON.stringify(nip98)).toString('base64'),
      'x-auth-tag': process.env.BUZZ_AUTH_TAG,
    },
    body,
  })
  return `fleet relay              ${r.status} ${(await r.text()).slice(0, 160)}`
}

const pub = finalizeEvent({ kind: 10002, created_at: now(), tags: relayTags, content: '' }, sk)
console.log(`kind:10002 for ${pk}\n  tags: ${JSON.stringify(relayTags)}\n  id ${pub.id.slice(0, 16)}…\n`)
console.log('== push (public trio, no auth) ==')
for (const r of TRIO) console.log('  ' + await pushWs(r, pub))

if (process.env.BUZZ_RELAY_URL && process.env.BUZZ_AUTH_TAG) {
  const authTag = JSON.parse(process.env.BUZZ_AUTH_TAG)
  const fleet = finalizeEvent({ kind: 10002, created_at: pub.created_at, tags: [...relayTags, authTag], content: '' }, sk)
  console.log('== push (fleet relay, NIP-98 + auth tag) ==')
  console.log('  ' + await pushFleet(fleet))
} else {
  console.log('== fleet push skipped (BUZZ_RELAY_URL / BUZZ_AUTH_TAG unset) ==')
}

console.log('\n== cold read-back (the only proof) ==')
let allOk = true
for (const r of TRIO) {
  const got = await newest10002(r)
  const ok = got && got.id === pub.id
  if (!ok) allOk = false
  console.log(`  ${r.padEnd(26)} ${got ? (ok ? `OK newest is ours (${got.created_at})` : `STALE/OTHER newest ${got.id.slice(0, 12)}… (${got.created_at})`) : 'NOT FOUND'}`)
}
console.log(allOk ? '\nFEDERATED — newest 10002 on every trio relay is this publish' : '\nNOT fully federated yet — re-check before relying on it (relays may need a moment; a later re-read is fine)')
process.exit(allOk ? 0 : 2)
