#!/usr/bin/env node
// agent-send.mjs — the agent's end of waggle's outbound lane (#507).
//
// The other half of #505. That one receives; this one speaks. Both consume lanes the bridge already
// runs, which is why an onboarded agent needs no ssh account, no broker instance and no seated key:
// it authenticates by SIGNATURE, and the credential is the bunker pairing the join flow seats.
//
//   echo "@My Dude — the build is green" | node tools/agent-send.mjs --channel <uuid>
//   node tools/agent-send.mjs --channel <uuid> --broadcast < note.txt
//   node tools/agent-send.mjs --channel <uuid> --dry-run < note.txt      # build and report, publish nothing
//
// Body on stdin so multi-line text and @mentions survive intact.
//
// THE KEY IS NEVER HELD HERE. `loadNostrSigner` is a local key or a NIP-46 pairing to a bunker; a
// bunker-held identity works with no nsec existing anywhere. --expect pins custody, so a bunker
// holding more than one identity cannot sign this as somebody else.
//
// Exit: 0 the publish is PROVEN by read-back · 1 nothing was sent · 3 INCONCLUSIVE (accepted but not
// read back, or a signer/custody problem). There is no exit code that means "delivered", because
// this process cannot see the channel — see sendVerdict in src/relay_send_intent.mjs.

import { finalizeEvent, generateSecretKey, getEventHash } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { loadNostrSigner, withPinnedCustody } from '../src/nostr_signer.mjs'
import { buildIntent, sendVerdict } from '../src/relay_send_intent.mjs'

const flag = n => { const i = process.argv.indexOf(n); return i < 0 ? '' : (process.argv[i + 1] || '') }
const has = n => process.argv.includes(n)
const HEX64 = /^[0-9a-f]{64}$/
const die = (m, code = 3) => { console.error(`agent-send: ${m}`); process.exit(code) }

const channel = flag('--channel') || process.env.WAGGLE_RELAY_CHANNEL || ''
const bridge = String(flag('--bridge') || process.env.WAGGLE_BRIDGE_PUBKEY || '').toLowerCase()
if (!HEX64.test(bridge)) die('--bridge <64-hex> (or WAGGLE_BRIDGE_PUBKEY) is required — this seals to waggle\'s own key and will not guess it')
const RELAYS = (flag('--relays') || process.env.WAGGLE_RELAY_RELAYS || 'wss://nos.lol,wss://relay.primal.net')
  .split(',').map(s => s.trim()).filter(Boolean)
const dry = has('--dry-run')

const base = loadNostrSigner()
if (!base) die('no signer configured — set WAGGLE_BUNKER_URI_FILE and WAGGLE_NIP46_CLIENT_NSEC_FILE, or BUZZ_PRIVATE_KEY')
// --expect takes the full 64-hex key, not the 8-char prefix everyone reads keys by. Getting that
// wrong is the likeliest way to invoke this tool, and a stack trace is not a refusal anyone acts on.
let signer
try { signer = withPinnedCustody(base, flag('--expect')) } catch (e) { die(`--expect ${String(e?.message || e)} — pass the full key, not the 8-character prefix`, 1) }

const body = await new Promise(resolve => {
  let s = ''
  process.stdin.on('data', d => { s += d }).on('end', () => resolve(s.replace(/\s+$/, '')))
})

let self
try { self = await signer.userPubkey() } catch (e) { die(`the signer never answered — ${String(e?.message || e).slice(0, 140)}`) }

// Every refusal happens here, before anything is signed or published.
const intent = buildIntent({ body, channel, self, broadcast: has('--broadcast') })
if (intent.ok !== true) die(intent.reason, 1)

const rumor = { ...intent.rumor, tags: intent.rumor.tags.map(t => [...t]) }
rumor.id = getEventHash(rumor)

let seal
try {
  seal = await signer.signEvent({ kind: 13, created_at: rumor.created_at, tags: [],
    content: await signer.nip44Encrypt(bridge, JSON.stringify(rumor)) })
} catch (e) {
  // withPinnedCustody sets exitCode 1 for a custody mismatch and 2 for a signature that does not
  // verify. Neither is "the send failed" — both mean the identity is not what this agent thinks.
  die(String(e?.message || e).slice(0, 200), e?.exitCode ?? 3)
}

// The wrap's key is throwaway and its pubkey means nothing — that is the point of NIP-59. The seal
// inside carries the only signature that names the sender.
const wsk = generateSecretKey()
const wrap = finalizeEvent({ kind: 1059, created_at: rumor.created_at, tags: [['p', bridge]],
  content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wsk, bridge)) }, wsk)

console.error(`agent-send: ${wrap.id.slice(0, 12)}… sealed by ${self.slice(0, 8)}… -> waggle ${bridge.slice(0, 8)}…` +
  ` for channel ${channel.slice(0, 8)}…  [${body.length}B]`)
if (dry) { console.error('agent-send: --dry-run — nothing published'); process.exit(0) }

const publish = url => new Promise(resolve => {
  let ws, done = false
  const end = v => { if (done) return; done = true; try { ws.close() } catch { /* already gone */ } resolve(v) }
  try { ws = new WebSocket(url) } catch { return end(false) }
  const t = setTimeout(() => end(false), 12000)
  ws.onopen = () => ws.send(JSON.stringify(['EVENT', wrap]))
  ws.onmessage = e => {
    try {
      const m = JSON.parse(e.data)
      if (m[0] === 'OK' && m[1] === wrap.id) {
        clearTimeout(t)
        if (!m[2]) console.error(`  ${url}: REJECTED ${m[3] || ''}`)
        end(!!m[2])
      }
    } catch { /* a relay that speaks nonsense is one relay, not a crash */ }
  }
  ws.onerror = () => { clearTimeout(t); end(false) }
})

// A FRESH connection, asking for the event by id. This is the whole difference between "the relay
// said OK" and "the relay has it": relays return OK and drop, and others 503 while the write lands.
const readBack = url => new Promise(resolve => {
  let ws, done = false, found = false
  const end = () => { if (done) return; done = true; try { ws.close() } catch { /* already gone */ } resolve(found) }
  try { ws = new WebSocket(url) } catch { return end() }
  const t = setTimeout(end, 12000)
  ws.onopen = () => ws.send(JSON.stringify(['REQ', 'verify', { ids: [wrap.id] }]))
  ws.onmessage = e => {
    try {
      const m = JSON.parse(e.data)
      if (m[0] === 'EVENT' && m[2]?.id === wrap.id) found = true
      if (m[0] === 'EOSE') { clearTimeout(t); end() }
    } catch { /* ignore */ }
  }
  ws.onerror = () => { clearTimeout(t); end() }
})

const accepted = (await Promise.all(RELAYS.map(publish))).filter(Boolean).length
const proven = accepted ? (await Promise.all(RELAYS.map(readBack))).filter(Boolean).length : 0

const verdict = sendVerdict({ accepted, relays: RELAYS.length, readBack: proven,
  mentions: intent.mentions, broadcast: intent.broadcast })
console.log(verdict.text)
process.exit(verdict.published ? (verdict.proven ? 0 : 3) : 1)
