// Return-lane SCAN — the #connector-facing detector added for the external-agent notify design
// (#110/#111). The base return_lane.mjs proves "carry a literal @name mention out, nothing else";
// this proves the parts that base did not exercise:
//
//   • the scan_authors SIGNER gate (default-closed when supplied, loud drop, never silent),
//   • p-tag mention detection unioned with the @name regex,
//   • per-(source × recipient) fan-out so "@a @b" reaches BOTH, each exactly once (finding #4),
//   • echo-skip in all three forms — direct signer, unique bound author, per-event registry —
//     AND the shared-author guard that keeps a shared bridge key from dropping cross-mentions,
//   • reply-to-agent via the agent-authored registry (agentAuthoredBy), why:'reply'.
//
//   node tests/return_lane_scan.mjs

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure'

const dir = mkdtempSync(resolve(tmpdir(), 'wb-rls-'))
const bridgeSk = generateSecretKey()
const bridgePk = getPublicKey(bridgeSk)

// Delivery keys (the agents' real Nostr keys — where sealed carries are addressed).
const claude = getPublicKey(generateSecretKey())
const dennis = getPublicKey(generateSecretKey())
const bumble = getPublicKey(generateSecretKey())
// Buzz-side signer keys. claudeSigner is bound to ONE entry (unique → drives echo-skip);
// sharedSigner is bound to two (ambiguous → must NOT drive skip, stands in for the shared bridge).
const claudeSigner = getPublicKey(generateSecretKey())
const sharedSigner = getPublicKey(generateSecretKey())
// A crew author allowed through the signer gate, and an outsider who is not.
const crew = getPublicKey(generateSecretKey())
const outsider = getPublicKey(generateSecretKey())

writeFileSync(resolve(dir, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: ['wss://example.invalid'], inbox: 'chan', staging_inbox: 'chan',
    watch_authors: [], watch_events: [], approvers: [], grantors: [],
    // Bridge key deliberately included — it must be stripped from the resolved gate.
    scan_authors: [crew, bridgePk],
    scan_channels: [],
    return_lane: [
      { npub_hex: claude, mention: 'claude', authors: [claudeSigner] },
      { npub_hex: dennis, mention: 'dennis', authors: [sharedSigner] },
      { npub_hex: bumble, mention: 'bumble', authors: [sharedSigner] },
    ],
  },
}, null, 2))

process.env.CONFIG_PATH = resolve(dir, 'config.json')
process.env.SEND_JOURNAL_PATH = resolve(dir, 'send-journal.log')
process.env.SEEN_PATH = resolve(dir, 'seen.log')
process.env.POSTED_MAP_PATH = resolve(dir, 'posted.log')
process.env.RLSEEN_PATH = resolve(dir, 'return-lane-seen.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.FORWARD_MODE = 'buzz'
process.env.WB_STUB_SEND = '1'
process.env.WB_NO_BOOT = '1'

const { scanReturnLane, recordPosted, PUB } = await import('../src/bridge.mjs')

let fails = 0
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }
const journal = () => existsSync(process.env.SEND_JOURNAL_PATH)
  ? readFileSync(process.env.SEND_JOURNAL_PATH, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []
// Run a scan and return only the journal entries it produced.
let cursor = 0
function scanDelta(msgs, opts) {
  const before = journal().length
  if (opts === undefined) scanReturnLane(msgs)
  else scanReturnLane(msgs, opts)
  const j = journal()
  cursor = j.length
  return j.slice(before)
}
const toOf = e => e.to
const short = k => k.slice(0, 12)

// --- config resolution ------------------------------------------------------
ok('three return-lane recipients parsed', PUB.returnLane.length === 3)
ok('the unique author binding is kept', PUB.returnLane[0].authors.length === 1 && PUB.returnLane[0].authors[0] === claudeSigner)
ok('scan_authors resolves the crew signer', PUB.scanAuthors.includes(crew))
ok('the bridge key is STRIPPED from the gate', !PUB.scanAuthors.includes(bridgePk))
ok('sharedSigner is flagged ambiguous', PUB.sharedAuthorKeys.has(sharedSigner))
ok('claudeSigner is NOT ambiguous (unique)', !PUB.sharedAuthorKeys.has(claudeSigner))

// --- signer gate ------------------------------------------------------------
let d = scanDelta([{ id: 'g1', pubkey: outsider, content: 'hey @claude look' }], { authors: PUB.scanAuthors })
ok('an outsider signer is gated out (no carry)', d.length === 0)

d = scanDelta([{ id: 'g2', pubkey: crew, content: 'hey @claude look' }], { authors: PUB.scanAuthors })
ok('a crew signer passes the gate', d.length === 1 && toOf(d[0]) === short(claude))
ok('a gated carry is labelled a mention', d[0]?.why === 'mention')

d = scanDelta([{ id: 'g3', pubkey: crew, content: 'hey @claude look' }], { authors: [] })
ok('an explicitly-empty gate is default-closed', d.length === 0)

// --- p-tag detection (no @name in body) -------------------------------------
d = scanDelta([{ id: 'p1', pubkey: crew, content: 'hello everyone', tags: [['p', claude]] }])
ok('a resolved p-tag delivers even with no @name text', d.length === 1 && toOf(d[0]) === short(claude))

// --- finding #4: one message fans out to EVERY match, each exactly once ------
d = scanDelta([{ id: 'f1', pubkey: crew, content: 'ping @claude and @dennis together' }])
const fanTargets = d.map(toOf).sort()
ok('"@claude @dennis" reaches BOTH recipients', d.length === 2 &&
  fanTargets[0] === [short(claude), short(dennis)].sort()[0] &&
  fanTargets[1] === [short(claude), short(dennis)].sort()[1])
d = scanDelta([{ id: 'f1', pubkey: crew, content: 'ping @claude and @dennis together' }])
ok('re-scanning the same message carries nothing new (per-recipient dedup)', d.length === 0)

// --- echo: unique bound author is the agent's own voice ---------------------
d = scanDelta([{ id: 'e1', pubkey: claudeSigner, content: 'this is @claude speaking' }])
ok('a unique bound author is echo-skipped', d.length === 0)

// --- echo GUARD: a shared author must NOT be skipped (else cross-mentions drop)
d = scanDelta([{ id: 'e2', pubkey: sharedSigner, content: 'over to @dennis please' }])
ok('a SHARED author is NOT skipped — the mention still delivers', d.length === 1 && toOf(d[0]) === short(dennis))

// --- echo: per-event registry (the bridge posted this event FOR claude) -----
recordPosted({ id: 'orig-r1', author: claude, buzz: 'reg1', dest: 'chan', q: false, ts: 0, agent: claude })
d = scanDelta([{ id: 'reg1', pubkey: crew, content: 'echo of @claude own words' }])
ok('a registry-attributed event is echo-skipped', d.length === 0)

// --- reply-to-agent via the registry, no body mention needed ----------------
recordPosted({ id: 'orig-p', author: claude, buzz: 'parenta', dest: 'chan', q: false, ts: 0, agent: claude })
d = scanDelta([{ id: 'rep1', pubkey: crew, content: 'good point, agreed', tags: [['e', 'parenta', '', 'reply']] }])
ok('a reply to an agent-authored post is carried', d.length === 1 && toOf(d[0]) === short(claude))
ok('it is labelled a reply, not a mention', d[0]?.why === 'reply')
d = scanDelta([{ id: 'rep1', pubkey: crew, content: 'good point, agreed', tags: [['e', 'parenta', '', 'reply']] }])
ok('the same reply is not carried twice', d.length === 0)

// --- reply to the thread ROOT (not the reply-marked parent) must NOT route ---
d = scanDelta([{ id: 'rep2', pubkey: crew, content: 'unrelated thread post', tags: [['e', 'parenta', '', 'root']] }])
ok('a root-tag to an agent post does NOT route (only reply-marked parents)', d.length === 0)

console.log(fails ? `\nRETURN LANE SCAN FAIL — ${fails}` : '\nRETURN LANE SCAN PASS — gate, p-tag, fan-out, echo (3 forms + shared guard), reply-detection')
process.exit(fails ? 1 : 0)
