// Read-side Buzz API resilience — the public lane must remain alive when a read fails.
//
// The production incident behind this suite was an intermittent Buzz 500/404: channel-name
// resolution called process.exit() and pollCommands left its rejected promise unhandled, so
// systemd restarted the complete lane every five seconds. These tests drive real bridge exports:
// no socket, no Buzz CLI, no false comfort from a wrapper production never calls.

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(resolve(tmpdir(), 'wb-read-resilience-'))
const data = join(dir, 'data')
mkdirSync(data, { recursive: true })
writeFileSync(join(dir, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: [], inbox: 'waggle-test', staging_inbox: 'waggle-test',
    watch_authors: [], watch_events: [], approvers: [], grantors: [],
    scan_authors: [], scan_channels: [], relay_channels: ['waggle-test'], return_lane: [],
  },
}, null, 2))

process.env.CONFIG_PATH = join(dir, 'config.json')
process.env.SEEN_PATH = join(data, 'seen.log')
process.env.RLSEEN_PATH = join(data, 'return-lane-seen.log')
process.env.RELAYSEEN_PATH = join(data, 'relay-lane-seen.log')
process.env.POSTED_MAP_PATH = join(data, 'posted-map.log')
process.env.PUB_WATERMARK_PATH = join(data, 'pub-watermark')
process.env.SCAN_WATERMARK_PATH = join(data, 'scan-watermark.json')
process.env.SEND_JOURNAL_PATH = join(data, 'send-journal.log')
process.env.FORWARD_MODE = 'buzz'
process.env.WB_NO_BOOT = '1'
process.env.CHANNEL_RESOLVE_RETRY_MAX_MS = '1'

const { __setTransportForTests } = await import('../src/egress.mjs')
const { PUB, resolveChannels, pollCommands, __resetReadPollingForTests } = await import('../src/bridge.mjs')

let fails = 0
const ok = (name, condition) => { console.log(`${condition ? 'ok  ' : 'FAIL'} — ${name}`); if (!condition) fails++ }
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// A failed name lookup must leave routing OFF and retry, not exit the bridge process.
let calls = 0
let restore = __setTransportForTests(async (argv, options) => {
  calls++
  if (calls === 1) throw new Error('relay error 500: simulated')
  ok('resolver asks only for the closed read verb', argv.join(' ') === 'channels list')
  ok('resolver read has a bounded CLI timeout', options?.timeout === 20_000)
  return JSON.stringify([{ name: 'waggle-test', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }])
})
let resolved = false
resolveChannels(() => { resolved = true })
await wait(30)
restore()
ok('a transient channel-list failure is retried in-process', calls === 2 && resolved)
ok('retry resolves every configured channel name to a UUID', PUB.inbox === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' && PUB.staging === PUB.inbox && PUB.relayChannels[0] === PUB.inbox)

// A staging-read failure must settle normally, defer the next attempt, and never become an
// unhandled rejection that brings down Node/systemd.
__resetReadPollingForTests()
let reads = 0
restore = __setTransportForTests(async (argv, options) => {
  reads++
  ok('command polling uses messages get', argv.slice(0, 2).join(' ') === 'messages get')
  ok('command polling has a bounded CLI timeout', options?.timeout === 20_000)
  throw new Error('relay error 404: simulated')
})
ok('a failed command read settles false rather than rejecting', await pollCommands(0) === false)
ok('backoff suppresses an immediate repeat read', await pollCommands(1) === false && reads === 1)
ok('the bounded backoff retries after its first delay', await pollCommands(1000) === false && reads === 2)
restore()

// A slow read must hold the single-flight lease; the periodic timer cannot stack another CLI
// child behind it while the upstream is stalled.
__resetReadPollingForTests()
let release
reads = 0
restore = __setTransportForTests(async () => {
  reads++
  return new Promise(resolve => { release = resolve })
})
const first = pollCommands(0)
await wait(0)
ok('an in-flight command read suppresses an overlapping poll', await pollCommands(1) === false && reads === 1)
release('[]')
ok('the original in-flight poll can still settle cleanly', await first === true)
restore()

console.log(fails ? `\nREAD RESILIENCE FAIL — ${fails}` : '\nREAD RESILIENCE PASS — non-fatal resolver + bounded command polling')
process.exit(fails ? 1 : 0)
