#!/usr/bin/env node
// session-profile.mjs — give a session key a face (#141, the continuity price it named).
//
// #141's own comments state the cost of mint-per-session plainly: "a burner renders as its bare
// npub, not as 'Claude', unless the session also publishes a kind:0 profile naming it." This is
// that publish. A session mints a key, gets admitted, and then wears a name the crew can read —
// distinct per session, obviously the same family, and honestly marked as an agent.
//
//   NVOY_NSEC=$(cat <path>) node tools/session-profile.mjs --purpose "reviewing #140"
//   NVOY_NSEC=… node tools/session-profile.mjs --og          # the standing identity
//   NVOY_NSEC=… node tools/session-profile.mjs --dry-run     # build + print, publish nothing
//
// NAMING. Every session is `Claude - <8 hex of its own pubkey>` — derived, not chosen, so two
// sessions cannot collide and a name is checkable against the key it claims. The one standing
// identity (78856ed6…, the key that holds the long-lived grant) is `Claude - OG` under --og:
// it is the identity with continuity, so it gets the name with continuity.
//
// THE ICON IS DELIBERATELY THE SAME FOR ALL. The carpenter's square was minted for this identity
// on day 3 — "right and true builder of their specs". Sessions are the same worker, not a crowd
// of strangers, and one icon says so at a glance. The NAME carries which session; the icon
// carries which team.
//
// SECRETS. The key arrives by env only, never argv — argv is world-readable in `ps` and lands in
// shell history. Nothing here prints it, and a profile is public by construction: everything this
// publishes is meant to be read by anyone.

import WebSocket from 'ws'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'

const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1] }
const has = (n) => args.includes(n)
const die = (m) => { console.error(`session-profile: ${m}`); process.exit(1) }

const RELAYS = (process.env.RELAY_RELAYS || 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
  .split(',').map(s => s.trim()).filter(Boolean)

// The shared face. A URL, not embedded data: one asset, changed in one place for every session.
const PICTURE = process.env.SESSION_PICTURE || 'https://nave.pub/assets/avatars/claude.svg'

const raw = process.env.NVOY_NSEC || process.env.SESSION_NSEC
if (!raw) die('set NVOY_NSEC (or SESSION_NSEC) — the key must arrive by env, never on the command line')
let sk
try { sk = raw.startsWith('nsec1') ? nip19.decode(raw).data : Uint8Array.from(Buffer.from(raw.trim(), 'hex')) }
catch { die('NVOY_NSEC is not a valid nsec or 64-hex key') }
if (!sk || sk.length !== 32) die('NVOY_NSEC is not a valid 32-byte key')

const pk = getPublicKey(sk)
const npub = nip19.npubEncode(pk)
const isOg = has('--og')
const name = flag('--name') || (isOg ? 'Claude - OG' : `Claude - ${pk.slice(0, 8)}`)
const purpose = flag('--purpose')

// about: what this session is FOR, when it said. A burner that names its own errand is far easier
// to reason about in a channel than one more anonymous key, and it makes an abandoned session
// obvious rather than mysterious.
const about = flag('--about') || (isOg
  ? 'Right and true. Head of development for waggle — the Nostr ↔ Buzz Bridge '
    + '(github.com/JAFairweather/waggle). The standing identity; session keys are Claude - <8 hex>. '
    + 'Agent identity; all coordination DMs are CC-d to my operator by standing convention.'
  : `Ephemeral waggle session key${purpose ? ` — ${purpose}` : ''}. Minted for one session and `
    + 'discarded after it; admitted by a scoped, revocable grant. The standing identity is Claude - OG.')

const profile = {
  name,
  display_name: name,
  about,
  picture: PICTURE,
  // bot:true is not decoration — §7's ToS posture leans on the agent-disclosure clause, and an
  // agent identity that does not declare itself is the thing that clause exists to prohibit.
  bot: true,
  ...(isOg ? { nip05: 'claude@nave.pub', website: 'https://github.com/JAFairweather/waggle' } : {}),
}

const ev = finalizeEvent({
  kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(profile),
}, sk)

console.error(`session-profile: ${name}`)
console.error(`  npub    ${npub}`)
console.error(`  picture ${PICTURE}`)
console.error(`  event   ${ev.id}`)
console.error(`  content ${ev.content}`)

if (has('--dry-run')) { console.error('session-profile: --dry-run — nothing published'); process.exit(0) }

// Publish, then READ IT BACK COLD. A relay OK is not proof — relays return OK and drop, and this
// repo's oldest rule is that a publish is proven by fetching it back from a fresh connection.
// Reporting "profile set" off an OK frame would be the exact failure the rule exists to stop.
function publish(url) {
  return new Promise(res => {
    let ws
    try { ws = new WebSocket(url) } catch { return res({ url, ok: false, note: 'no connection' }) }
    let done = false
    const fin = (ok, note) => { if (done) return; done = true; try { ws.close() } catch { /* closed */ } res({ url, ok, note }) }
    const t = setTimeout(() => fin(false, 'timeout'), 12000)
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', ev])))
    ws.on('message', d => { try {
      const m = JSON.parse(d.toString())
      if (m[0] === 'OK' && m[1] === ev.id) { clearTimeout(t); fin(!!m[2], m[2] ? 'accepted' : `rejected ${m[3] || ''}`) }
    } catch { /* not for us */ } })
    ws.on('error', e => { clearTimeout(t); fin(false, `error ${e.message}`) })
  })
}

// Fresh connection, by id — not the socket we just wrote on.
function readBack(url) {
  return new Promise(res => {
    let ws
    try { ws = new WebSocket(url) } catch { return res({ url, found: false, answered: false }) }
    let done = false, found = false, answered = false
    const fin = () => { if (done) return; done = true; try { ws.close() } catch { /* closed */ } res({ url, found, answered }) }
    const t = setTimeout(fin, 10000)
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'p', { kinds: [0], authors: [pk], limit: 1 }])))
    ws.on('message', d => { try {
      const m = JSON.parse(d.toString())
      if (m[0] === 'EVENT' && m[2]?.id === ev.id) found = true
      if (m[0] === 'EOSE') { answered = true; clearTimeout(t); fin() }
    } catch { /* ignore */ } })
    ws.on('error', () => { clearTimeout(t); fin() })
  })
}

const wrote = await Promise.all(RELAYS.map(publish))
for (const r of wrote) console.error(`  publish ${r.url.replace('wss://', '').padEnd(20)} ${r.note}`)

await new Promise(r => setTimeout(r, 1500))   // let the write settle before asking for it back
const back = await Promise.all(RELAYS.map(readBack))
for (const r of back) {
  console.error(`  readback ${r.url.replace('wss://', '').padEnd(20)} ${r.answered ? (r.found ? 'FOUND' : 'not found') : 'no answer'}`)
}

const confirmed = back.filter(r => r.found).length
const silent = back.filter(r => !r.answered).length
console.error(`session-profile: confirmed on ${confirmed}/${RELAYS.length} relay(s) by cold read-back`
  + (silent ? ` · ${silent} did not answer (unknown, not absent)` : ''))
console.log(npub)

// Exit 3 = INCONCLUSIVE, the convention tripwire.mjs and verify-firewall.sh already use: no relay
// answered, so we did not learn that the profile is missing — we learned nothing. Distinct from
// exit 1 (relays answered and it is genuinely not there).
if (!confirmed && silent === RELAYS.length) process.exit(3)
process.exit(confirmed ? 0 : 1)
