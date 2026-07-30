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

const dir = mkdtempSync(resolve(tmpdir(), 'wb-rl-'))
const bridgeSk = generateSecretKey()
const participant = getPublicKey(generateSecretKey())
const stranger = getPublicKey(generateSecretKey())

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

scanReturnLane([{ id: 'm1', pubkey: stranger, content: 'nothing to do with anyone' }])
ok('a message mentioning nobody is not carried out', journal().length === 0)

scanReturnLane([{ id: 'm2', pubkey: stranger, content: 'hey @claude can you look at this' }])
const afterMention = journal()
ok('a mention IS carried out', afterMention.length === 1)
ok('it is journaled as the return lane', afterMention[0]?.lane === 'return')
ok('it is addressed to the participant', afterMention[0]?.to === participant.slice(0, 12))
ok('it is a gift-wrap', afterMention[0]?.kind === 1059)

scanReturnLane([{ id: 'm2', pubkey: stranger, content: 'hey @claude can you look at this' }])
ok('the same message is not carried twice', journal().length === 1)

scanReturnLane([{ id: 'm3', pubkey: participant, content: 'this is @claude speaking' }])
ok("a participant's own words are not echoed back to them", journal().length === 1)

scanReturnLane([{ id: 'm4', pubkey: stranger, content: 'ask @CLAUDE about it' }])
ok('the mention match is case-insensitive', journal().length === 2)

// The hazard a substring match would create: a different person whose name merely starts with
// this one. Carrying a private message to the wrong recipient is the worst thing this lane can
// do, and it would do it silently.
scanReturnLane([{ id: 'm5', pubkey: stranger, content: 'ask @claudex instead' }])
ok('a longer name starting with the mention does NOT match', journal().length === 2)

scanReturnLane([{ id: 'm6', pubkey: stranger, content: 'thanks @claude!' }])
ok('a mention followed by punctuation still matches', journal().length === 3)

scanReturnLane([{ id: 'm7', pubkey: stranger, content: '@claude' }])
ok('a mention alone on the line matches', journal().length === 4)

console.log(fails ? `\nRETURN LANE FAIL — ${fails}` : '\nRETURN LANE PASS — carries mentions out, and nothing else')
process.exit(fails ? 1 : 0)
