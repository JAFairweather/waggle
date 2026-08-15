#!/usr/bin/env node
// agent-inbox.mjs — the agent's end of the return lane (#505).
//
// waggle carries a mention out as NIP-17 sealed mail to this agent's own kind:10050 relays. Nothing
// in this repo read it, so the last leg of "a mention reaches the agent" was a person at a relay
// client. This subscribes, opens what it can, and says plainly what it could not open.
//
//   node tools/agent-inbox.mjs --pubkey <64-hex> --trust <64-hex>[,<64-hex>…]
//   node tools/agent-inbox.mjs --pubkey <64-hex> --since 3600 --watch
//
// --watch holds the subscription open instead of exiting at EOSE. That is the difference between
// this and polling, and it is the whole point: an event arrives when it arrives, and the agent is
// not choosing an interval at which to be late.
//
// THE SIGNER IS NEVER HELD HERE. It comes from `loadNostrSigner`, which is either a local key or a
// NIP-46 pairing to a bunker; this file calls `nip44Decrypt` and never sees key material. A bunker
// that signs but does not implement `nip44_decrypt` cannot open this mail, and that is reported as
// INCONCLUSIVE rather than as an empty inbox — see the exit codes below.
//
// Exit: 0 read cleanly · 3 INCONCLUSIVE — no relay answered, or something could not be opened.
// There is deliberately no exit code that means "no mail", because this tool cannot distinguish a
// quiet inbox from a broken read without saying which it observed, and it always says.

import { readFileSync } from 'node:fs'
import { verifyEvent } from 'nostr-tools/pure'
import { loadNostrSigner } from '../src/nostr_signer.mjs'
import { inboxSummary, rumorVerdict, sealAuthor, wrapAddressedTo } from '../src/return_lane_inbox.mjs'

const flag = n => { const i = process.argv.indexOf(n); return i < 0 ? '' : (process.argv[i + 1] || '') }
const has = n => process.argv.includes(n)
const HEX64 = /^[0-9a-f]{64}$/
const die = m => { console.error(`agent-inbox: ${m}`); process.exit(3) }

const self = String(flag('--pubkey') || '').toLowerCase()
if (!HEX64.test(self)) die('--pubkey <64-hex> is required — this tool reads one identity\'s mail and will not guess which')

// Trust is a list this agent is GIVEN, never one it derives from the mail. A sender that could add
// itself to the allowlist by sending is not an allowlist.
const trustArg = flag('--trust') || (flag('--trust-file') ? readFileSync(flag('--trust-file'), 'utf8') : '')
const trusted = trustArg.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(k => HEX64.test(k))

const relayArg = flag('--relays')
const RELAYS = (relayArg ? relayArg.split(',') : ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.ditto.pub'])
  .map(s => s.trim()).filter(Boolean)
const since = Math.floor(Date.now() / 1000) - (Number(flag('--since')) || 172800)
const watch = has('--watch')

const signer = loadNostrSigner()
if (!signer) die('no signer configured — set WAGGLE_BUNKER_URI_FILE (and WAGGLE_NIP46_CLIENT_NSEC_FILE) or BUZZ_PRIVATE_KEY. Without one, sealed mail cannot be opened and this is INCONCLUSIVE, not empty')

let failed = 0
const verdicts = []
const seen = new Set()

// Two decrypts with a signature check BETWEEN them, exactly as src/nostr_egress.mjs insists: the
// seal's signature is the authorship proof, and doing the second (expensive) decrypt before it holds
// would run unauthenticated input through the signer.
async function open(wrap) {
  if (seen.has(wrap.id)) return
  seen.add(wrap.id)
  if (wrapAddressedTo(wrap, self).ok !== true) return
  let seal
  try { seal = JSON.parse(await signer.nip44Decrypt(wrap.pubkey, wrap.content)) }
  catch (e) {
    // Never counted as "no mail". This is the branch a bunker without nip44_decrypt lands in.
    failed++
    console.error(`  could not open a wrap — ${String(e?.message || e).slice(0, 160)}`)
    return
  }
  const author = sealAuthor(seal, verifyEvent)
  if (author.ok !== true) { verdicts.push(author); return }
  let rumor
  try { rumor = JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content)) }
  catch (e) { failed++; console.error(`  could not open a seal from ${author.author.slice(0, 12)}… — ${String(e?.message || e).slice(0, 160)}`); return }
  const verdict = rumorVerdict(rumor, { author: author.author, self, trusted })
  verdicts.push(verdict)
  if (verdict.ok === true) {
    const mark = verdict.disposition === 'trusted' ? 'TRUSTED' : verdict.disposition.toUpperCase()
    console.log(`\n[${mark}] ${verdict.author.slice(0, 16)}…${verdict.forMe ? '' : '  (this agent was copied, not addressed)'}`)
    console.log(`  ${verdict.reason}`)
    // Printed as content, never interpreted. A newline-prefixed body cannot forge the header above
    // it because the header is already written and this is one indented block.
    console.log(String(verdict.content).split('\n').map(l => `  | ${l}`).join('\n'))
  } else {
    console.log(`\n[REFUSED] ${verdict.reason}`)
  }
}

let answered = 0
await Promise.all(RELAYS.map(url => new Promise(resolve => {
  let ws, done = false
  const end = () => { if (done) return; done = true; try { ws.close() } catch { /* already gone */ } resolve() }
  try { ws = new WebSocket(url) } catch { return end() }
  const t = setTimeout(end, watch ? 0x7fffffff : 12000)
  ws.onopen = () => ws.send(JSON.stringify(['REQ', 'inbox', { kinds: [1059], '#p': [self], since, limit: 200 }]))
  ws.onmessage = async e => {
    try {
      const m = JSON.parse(e.data)
      if (m[0] === 'EVENT') await open(m[2])
      if (m[0] === 'EOSE') { answered++; if (!watch) { clearTimeout(t); end() } }
    } catch { /* a relay that speaks nonsense is one relay, not a crash */ }
  }
  ws.onerror = () => { clearTimeout(t); end() }
})))

const summary = inboxSummary({ verdicts, failed, reachable: answered, scanned: seen.size })
console.log(`\n${summary.text}`)
process.exit(summary.inconclusive ? 3 : 0)
