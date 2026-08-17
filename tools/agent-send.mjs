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
//   echo probe | node tools/agent-send.mjs --channel <uuid> --dry-run    # …and no @name is needed (#587)
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

// `ws` IS IMPORTED, NOT ASSUMED (#576). Every other relay-touching tool in this directory imports
// it; these two reached for a global `WebSocket` instead, which only exists on newer Node. That
// would be a version note and nothing more, except for the shape it fails in:
//
//   try { ws = new WebSocket(url) } catch { return end() }
//
// The catch swallows a ReferenceError exactly as it swallows a bad URL, so on a runtime without the
// global this reports NO CONNECTION rather than reporting that it cannot open one — and an agent
// reading an empty inbox has no way to tell that from no mail. Found onboarding an agent on Node 20.
import WebSocket from '../src/ws_runtime.mjs'
import { finalizeEvent, generateSecretKey, getEventHash } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { loadNostrSigner, withPinnedCustody } from '../src/nostr_signer.mjs'
import { buildIntent, envelopeTemplates, sendVerdict } from '../src/relay_send_intent.mjs'
import { relaySet, thinRelaySet } from '../src/relays.mjs'

const flag = n => { const i = process.argv.indexOf(n); return i < 0 ? '' : (process.argv[i + 1] || '') }
const has = n => process.argv.includes(n)
const HEX64 = /^[0-9a-f]{64}$/
const die = (m, code = 3) => { console.error(`agent-send: ${m}`); process.exit(code) }

const channel = flag('--channel') || process.env.WAGGLE_RELAY_CHANNEL || ''
const bridge = String(flag('--bridge') || process.env.WAGGLE_BRIDGE_PUBKEY || '').toLowerCase()
if (!HEX64.test(bridge)) die('--bridge <64-hex> (or WAGGLE_BRIDGE_PUBKEY) is required — this seals to waggle\'s own key and will not guess it')
// The default set comes from `src/relays.mjs` and from nowhere else. This line used to hold its own
// literal pair — nos.lol and primal — which is the exact duplication that module was created to end
// (`src/relays.mjs:3`, "it was defined nine times"). It mattered here more than anywhere: nos.lol
// has refused waggle's sealed wraps for want of 28 bits of proof-of-work since 2026-08-08 (#345), so
// a two-relay default whose first entry always refuses is an effective set of ONE, below the floor
// the module names — and this is the tool an onboarded agent speaks through every day. Measured on
// the live lane this session: the old default reported `accepted by 0/2` and NOT SENT twice in a
// row, while the same body on DEFAULT_PUBLIC_RELAYS landed 3/4.
// `allowLoopbackWs` keeps a capability this line had before it took its default from the module:
// an explicitly-passed `ws://127.0.0.1:PORT`, which is how this tool is driven against a local relay.
// Everything else is still wss-only, so the net effect is stricter than the hand-rolled parse — that one
// admitted `ws://` to any host on the internet.
const RELAYS = relaySet(flag('--relays') || process.env.WAGGLE_RELAY_RELAYS, undefined, { allowLoopbackWs: true })
// Printed before anything is signed, because a thin set is not a failure this run can report any
// other way: a fan-out to one relay that then accepts reports a cheerful `1/1`.
const thin = thinRelaySet(RELAYS)
if (thin) console.error(`agent-send: THIN RELAY SET — ${thin}`)
console.error(`agent-send: relays ${RELAYS.join(' ')}`)
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
//
// `allowUnaddressed: dry` exempts ONE refusal on a run that publishes nothing — the missing @name.
// The guard is about delivery and a dry run has none, so refusing one left a newly seated agent with
// no way to check that its signer answers and which key it signs as, short of sending a real message
// to a real person (#587). Every other refusal still stands, including on a dry run: an empty body
// or a malformed channel makes the report itself wrong, and the report is the entire product here.
const intent = buildIntent({ body, channel, self, broadcast: has('--broadcast'), allowUnaddressed: dry })
if (intent.ok !== true) die(intent.reason, 1)

const rumor = { ...intent.rumor, tags: intent.rumor.tags.map(t => [...t]) }
rumor.id = getEventHash(rumor)

// The seal and the wrap must NOT carry the send time — see `envelopeTemplates`, which owns that
// decision and is the only place a suite can assert it. Publishing `rumor.created_at` on both, which
// is what this did first, put the timing correlation the bridge deliberately removes onto a public
// relay.
const env = envelopeTemplates({ rumorCreatedAt: rumor.created_at, bridge })

let seal
try {
  seal = await signer.signEvent({ ...env.seal, tags: [...env.seal.tags],
    content: await signer.nip44Encrypt(bridge, JSON.stringify(rumor)) })
} catch (e) {
  // withPinnedCustody sets exitCode 1 for a custody mismatch and 2 for a signature that does not
  // verify. Neither is "the send failed" — both mean the identity is not what this agent thinks.
  die(String(e?.message || e).slice(0, 200), e?.exitCode ?? 3)
}

// The wrap's key is throwaway and its pubkey means nothing — that is the point of NIP-59. The seal
// inside carries the only signature that names the sender.
const wsk = generateSecretKey()
const wrap = finalizeEvent({ ...env.wrap, tags: env.wrap.tags.map(t => [...t]),
  content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wsk, bridge)) }, wsk)

console.error(`agent-send: ${wrap.id.slice(0, 12)}… sealed by ${self.slice(0, 8)}… -> waggle ${bridge.slice(0, 8)}…` +
  ` for channel ${channel.slice(0, 8)}…  [${body.length}B]`)
if (dry) {
  // Printed BEFORE the "nothing published" line, so the last thing on screen is not the reassuring
  // half. Exit stays 0: the build succeeded, and the probe this exists for is a script that reads
  // `$?`. The warning is what carries the news, which is why it is unconditional and verbatim from
  // the guard rather than a paraphrase written here.
  if (intent.unaddressed) console.error(`agent-send: WOULD REACH NOBODY — ${intent.reason}`)
  console.error('agent-send: --dry-run — nothing published')
  process.exit(0)
}

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
