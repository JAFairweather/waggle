#!/usr/bin/env node
// mint-consent.mjs — a PARTICIPANT signs their in-door consent (docs/CONSENT.md §4/§5).
//
// The subject-side counterpart to tools/grant.mjs: where grant.mjs is the maintainer admitting
// someone (authority → subject), this is the data subject consenting to be mirrored (subject →
// bridge). The grantor is the participant, and their signature IS the consent (§3, the inversion).
//
// It exists for two honest reasons: (1) the automated ask-DM path (bridge builds the prefill, the
// participant only signs) is a separate build — until it lands, a participant who wants in signs
// here; and (2) a live end-to-end test of the enforcement gate needs a real, participant-signed
// consent on the wire, which this produces.
//
//   NVOY_NSEC=nsec1…  node tools/mint-consent.mjs --hive <community_id> --hive-name <name> --hive-handle <handle> [--terms-url https://…]
//   node tools/mint-consent.mjs --mint --hive <community_id> --hive-name <name> --hive-handle <handle> --terms-url https://…   # mint a fresh key
//   NVOY_NSEC=…  node tools/mint-consent.mjs revoke --grant <440 id>
//   DRY_RUN=1 …                                                                 # build, publish nothing
//
// The `tos` hash is computed from the SAME producer the bridge and the disclosure DM use
// (src/nostr_egress.mjs `consentTosBlock`), so a consent minted here matches a version-bound gate.
// Pass --tos-hash to override (e.g. to test a superseded-terms hold). Key by env or a 0600 tmpfile,
// never argv; nothing here prints a secret.

import { finalizeEvent, getPublicKey, generateSecretKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import WebSocket from 'ws'
import { consentTosBlock } from '../src/nostr_egress.mjs'
import { relaySet } from '../src/relays.mjs'

const args = process.argv.slice(2)
const cmd = args[0] === 'revoke' ? 'revoke' : 'consent'
const flag = (n, d) => { const i = args.indexOf(n); return i > -1 && args[i + 1] ? args[i + 1] : d }
const has = (n) => args.includes(n)
const die = (m) => { console.error(`mint-consent: ${m}`); process.exit(1) }
const HIVE = (flag('--hive', flag('--community-id', process.env.MIRROR_CONSENT_HIVE_ID)) || '').toLowerCase()
if (!/^[0-9a-f]{64}$/.test(HIVE)) die('--hive must be the hive\'s 64-hex Concord community_id (consent never scopes to a channel)')
const BRIDGE = (flag('--bridge', process.env.WAGGLE_BRIDGE_PUBKEY ||
  '84753207f2c6ae73af247da174e8e7c91a7d939a8eb0b4c2b98b54ea567786e6')).toLowerCase()
const RELAYS = relaySet(process.env.RELAY_RELAYS)
const DRY = !!process.env.DRY_RUN

// The key — env, or minted fresh to a 0600 tmpfile (path on stdout, never the nsec).
let sk, keyPath = null
if (process.env.NVOY_NSEC) {
  const raw = process.env.NVOY_NSEC
  try { sk = raw.startsWith('nsec1') ? nip19.decode(raw).data : Uint8Array.from(Buffer.from(raw.trim(), 'hex')) } catch { die('NVOY_NSEC is not a valid nsec/hex') }
} else if (has('--mint')) {
  sk = generateSecretKey()
  const dir = mkdtempSync(resolve(tmpdir(), 'waggle-consent-'))
  keyPath = resolve(dir, 'participant.nsec')
  writeFileSync(keyPath, nip19.nsecEncode(sk), { mode: 0o600 })
} else {
  die('provide the participant key via NVOY_NSEC, or --mint to create a throwaway one')
}
const pk = getPublicKey(sk)
const npub = nip19.npubEncode(pk)

const publish = (ev) => Promise.all(RELAYS.map(url => new Promise(res => {
  let ws; try { ws = new WebSocket(url) } catch { return res(`${url} no-connect`) }
  let done = false
  const fin = (m) => { if (done) return; done = true; try { ws.close() } catch { /* */ } res(`${url.replace('wss://', '')}: ${m}`) }
  const t = setTimeout(() => fin('timeout'), 9000)
  ws.on('open', () => ws.send(JSON.stringify(['EVENT', ev])))
  ws.on('message', d => { try { const m = JSON.parse(d.toString()); if (m[0] === 'OK' && m[1] === ev.id) { clearTimeout(t); fin(m[2] ? 'OK' : `REJECTED ${m[3] || ''}`) } } catch { /* */ } })
  ws.on('error', e => { clearTimeout(t); fin(`ERR ${e.message}`) })
})))

if (cmd === 'revoke') {
  const target = flag('--grant') || die('revoke needs --grant <the consent 440 event id>')
  if (!/^[0-9a-f]{64}$/i.test(target)) die('--grant must be a 64-hex event id')
  // p-tag the bridge: its consent subscription filters on #p:[BRIDGE_PK], so a 441 without it is
  // invisible to the bridge and the revocation silently fails OPEN (caught in live test 2026-08-03).
  const ev = finalizeEvent({ kind: 441, created_at: Math.floor(Date.now() / 1000), tags: [['e', target.toLowerCase()], ['p', BRIDGE]], content: '' }, sk)
  console.error(`mint-consent: 441 revoking ${target.slice(0, 12)}… as ${npub}`)
  if (DRY) { console.error('DRY_RUN — nothing published'); console.log(ev.id); process.exit(0) }
  for (const line of await publish(ev)) console.error('  ' + line)
  console.log(ev.id)
  process.exit(0)
}

// Build the consent 440 — the SAME shape the bridge's disclosure DM would prefill.
const salt = randomBytes(16).toString('hex')
const scopeHash = createHash('sha256').update(Buffer.concat([
  Buffer.from('waggle/da-scope/v1'), Buffer.from([0]), Buffer.from(HIVE), Buffer.from(salt, 'hex'),
])).digest('hex')

// tos hash: from the canonical block (one producer), unless overridden.
let tosHash = flag('--tos-hash')
if (!tosHash) {
  const termsUrl = flag('--terms-url')
  if (!termsUrl) die('need --terms-url https://… to compute the terms hash, or --tos-hash <hex> to set it directly')
  const hiveName = flag('--hive-name') || die('need --hive-name for the human-readable hive identity')
  const hiveHandle = flag('--hive-handle') || die('need --hive-handle (for example jaf@dequalsf.com)')
  tosHash = createHash('sha256').update(consentTosBlock({ hiveId: HIVE, hiveName, hiveHandle, termsUrl })).digest('hex')
}

const ev = finalizeEvent({
  kind: 440, created_at: Math.floor(Date.now() / 1000),
  tags: [['p', BRIDGE], ['da-scope', scopeHash, salt], ['da-cap', 'mirror'], ['tos', tosHash]],
  content: '',
}, sk)

console.error(`mint-consent: mirror consent 440 ${ev.id.slice(0, 12)}…`)
console.error(`  participant ${npub}`)
console.error(`  → bridge ${BRIDGE.slice(0, 12)}…  hive ${HIVE.slice(0, 12)}… (salted; id never public)  tos ${tosHash.slice(0, 12)}…`)
if (keyPath) console.error(`  key (0600, path only): ${keyPath}   ·   burn: shred -u ${keyPath}`)
if (DRY) { console.error('DRY_RUN — nothing published'); console.log(ev.id); process.exit(0) }
for (const line of await publish(ev)) console.error('  ' + line)
console.error(`  next: revoke with  NVOY_NSEC=… node tools/mint-consent.mjs revoke --grant ${ev.id}`)
console.log(ev.id)
