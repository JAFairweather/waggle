// Return lane — carry a mention out to an admitted participant, and nothing else.
//
// The property under test is as much about what it REFUSES as what it sends. A bridge that
// forwarded a whole private channel outward would invert the consent the in door exists to
// enforce, so "only mentions, only outward, never their own words back" is the feature.
//
//   node tests/return_lane.mjs

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'

const dir = mkdtempSync(resolve(tmpdir(), 'wb-rl-'))
const bridgeSk = generateSecretKey()
const participantSk = generateSecretKey()
const participant = getPublicKey(participantSk)
const stranger = getPublicKey(generateSecretKey())
const participant2 = getPublicKey(generateSecretKey())   // a SECOND author, so attribution can be told apart

// Open a 1059 the way the recipient's own runtime would: unwrap to the seal with the wrap's
// ephemeral key, then unseal to the rumor with the seal author's. Doing it for real — rather than
// reaching into a descriptor — is what makes the assertion about what the reader actually sees.
const openWrapAs = async (sk, wrap) => {
  try {
    const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(sk, wrap.pubkey)))
    const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(sk, seal.pubkey)))
    return String(rumor.content || '')
  } catch { return null }
}

writeFileSync(resolve(dir, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: ['wss://example.invalid'], inbox: 'chan', staging_inbox: 'chan',
    watch_authors: [], watch_events: [], approvers: [], grantors: [],
    return_lane: [{ npub_hex: participant, mention: 'claude' }],
  },
}, null, 2))

process.env.CONFIG_PATH = resolve(dir, 'config.json')
process.env.SEND_JOURNAL_PATH = resolve(dir, 'send-journal.log')
process.env.SEEN_PATH = resolve(dir, 'seen.log')
process.env.POSTED_MAP_PATH = resolve(dir, 'posted.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.FORWARD_MODE = 'buzz'
process.env.WB_STUB_SEND = '1'
process.env.WB_NO_BOOT = '1'

const { scanReturnLane, PUB } = await import('../src/bridge.mjs')

let fails = 0
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }
const journal = () => existsSync(process.env.SEND_JOURNAL_PATH)
  ? readFileSync(process.env.SEND_JOURNAL_PATH, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []

ok('config parsed one return-lane participant', PUB.returnLane.length === 1 && PUB.returnLane[0].mention === 'claude')

await scanReturnLane([{ id: 'm1', pubkey: stranger, content: 'nothing to do with anyone' }])
ok('a message mentioning nobody is not carried out', journal().length === 0)

await scanReturnLane([{ id: 'm2', pubkey: stranger, content: 'hey @claude can you look at this' }])
const afterMention = journal()
ok('a mention IS carried out', afterMention.length === 1)
ok('it is journaled as the return lane', afterMention[0]?.lane === 'return')
ok('it is addressed to the participant', afterMention[0]?.to === participant.slice(0, 12))
ok('it is a gift-wrap', afterMention[0]?.kind === 1059)

await scanReturnLane([{ id: 'm2', pubkey: stranger, content: 'hey @claude can you look at this' }])
ok('the same message is not carried twice', journal().length === 1)

await scanReturnLane([{ id: 'm3', pubkey: participant, content: 'this is @claude speaking' }])
ok("a participant's own words are not echoed back to them", journal().length === 1)

await scanReturnLane([{ id: 'm4', pubkey: stranger, content: 'ask @CLAUDE about it' }])
ok('the mention match is case-insensitive', journal().length === 2)

// The hazard a substring match would create: a different person whose name merely starts with
// this one. Carrying a private message to the wrong recipient is the worst thing this lane can
// do, and it would do it silently.
await scanReturnLane([{ id: 'm5', pubkey: stranger, content: 'ask @claudex instead' }])
ok('a longer name starting with the mention does NOT match', journal().length === 2)

await scanReturnLane([{ id: 'm6', pubkey: stranger, content: 'thanks @claude!' }])
ok('a mention followed by punctuation still matches', journal().length === 3)

await scanReturnLane([{ id: 'm7', pubkey: stranger, content: '@claude' }])
ok('a mention alone on the line matches', journal().length === 4)

// --- #352: the carry says WHO wrote it ------------------------------------------------------
// End-to-end, through the real wrap, not by inspecting a descriptor. The bridge held the author's
// pubkey all along and simply did not pass it, so every carried reply arrived attributed to
// waggle — the carrier — and a reader could not answer "who said this?" except by writing style.
//
// This is asserted on the DECRYPTED body because the send journal records only {lane, to, kind}.
// A test that asserted on carryDescriptor's slots would be asserting the mechanism; what matters
// is that the author reaches the text the recipient actually reads. Written after a mutation —
// dropping the author in bridge.mjs — passed all 69 suites, which means the wiring had no cover
// at all and only the template was tested.
{
  const wraps = []
  const capture = async (wrap) => { wraps.push(wrap); return 1 }
  await scanReturnLane([{ id: 'm8', pubkey: stranger, content: 'over to @claude' }], { publish: capture })
  ok('the carry was captured for inspection', wraps.length === 1)
  const body = await openWrapAs(participantSk, wraps[0])
  ok('the carried text names the author, not only the recipient',
    !!body && body.includes(stranger.slice(0, 12)))
  // Both directions, or "names the author" cannot be told from "contains some hex".
  const other = []
  await scanReturnLane([{ id: 'm9', pubkey: participant2, content: 'also for @claude' }],
    { publish: async (w) => { other.push(w); return 1 } })
  const body2 = await openWrapAs(participantSk, other[0])
  ok('a different author produces a different attribution — the field is read, not decorative',
    !!body2 && body2.includes(participant2.slice(0, 12)) && !body2.includes(stranger.slice(0, 12)))
  // The recipient is still named. The author line must ADD identification, not replace it.
  ok('the recipient is still named alongside the author', !!body && body.includes('claude'))
  // And the message itself still crosses intact — an attribution line that ate the body would
  // pass every assertion above.
  ok('the carried body is still there, unchanged', !!body && body.includes('over to @claude'))
}

console.log(fails ? `\nRETURN LANE FAIL — ${fails}` : '\nRETURN LANE PASS — carries mentions out, and nothing else')
process.exit(fails ? 1 : 0)
