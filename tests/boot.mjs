// Boot suite — does `node src/bridge.mjs` actually start? (#154)
//
// Every other suite sets WB_NO_BOOT=1, which is correct for them: they drive exported functions
// and must not open sockets. The consequence is that until this file existed, **the boot block was
// never executed by CI at all** — module-level initialisation, store load order, config resolution
// and the gate-summary logging were all unexercised.
//
// That gap is exactly the risk of splitting bridge.mjs into modules (#154). A missing export, a
// circular import, or a store loaded before the directory it writes into exists would leave every
// other suite green and the process dead on the box. `verify-deployed.sh` would not catch it
// either — it compares file hashes, and a tree that matches git perfectly can still fail to boot.
//
// So this spawns the real entry point as a child process, with SEALED_LANES=off and dryrun so it
// opens nothing, and asserts it initialises and exits cleanly.
//
// Run: node tests/boot.mjs   (exit 0 = pass, 1 = fail)

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'wb-boot-'))
const data = join(dir, 'data')
mkdirSync(data, { recursive: true })

const CFG = join(dir, 'config.json')
writeFileSync(CFG, JSON.stringify({
  relays: [], recipients: [{ name: 'A', npub_hex: 'aa', inbox: '11111111-1111-1111-1111-111111111111' }],
  public: {
    relays: [], inbox: '22222222-2222-2222-2222-222222222222',
    staging_inbox: '33333333-3333-3333-3333-333333333333',
    watch_authors: [], watch_events: [], approvers: [], grantors: [],
    scan_authors: [], scan_channels: [], relay_channels: [], return_lane: [],
  },
}))

let fails = 0
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }

// Public lane only, no relays configured, dryrun: it initialises, finds nothing to listen on, and
// drains. Every state path points into the temp dir, so production state is untouched.
const env = {
  ...process.env,
  CONFIG_PATH: CFG,
  FORWARD_MODE: 'dryrun',
  SEALED_LANES: 'off',
  SEEN_PATH: join(data, 'seen.log'),
  RLSEEN_PATH: join(data, 'return-lane-seen.log'),
  RELAYSEEN_PATH: join(data, 'relay-lane-seen.log'),
  POSTED_MAP_PATH: join(data, 'posted-map.log'),
  PUB_WATERMARK_PATH: join(data, 'pub-watermark'),
  SCAN_WATERMARK_PATH: join(data, 'scan-watermark.json'),
  SEND_JOURNAL_PATH: join(data, 'send-journal.log'),
}
delete env.WB_NO_BOOT   // the entire point of this suite

let out = '', code = 0
try {
  out = execFileSync(process.execPath, ['src/bridge.mjs'], {
    cwd: REPO, env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (e) {
  code = e.status ?? 1
  out = (e.stdout || '') + (e.stderr || '')
}

ok('`node src/bridge.mjs` boots and exits cleanly', code === 0)
// A module that fails to resolve, or a circular import, surfaces here and nowhere else.
ok('  no module-resolution or import failure', !/ERR_MODULE_NOT_FOUND|Cannot find module|ERR_REQUIRE_CYCLE/.test(out))
ok('  no uncaught exception during initialisation', !/^\s*(TypeError|ReferenceError|SyntaxError)/m.test(out))
ok('  no FATAL', !/FATAL/.test(out))

// Boot-order evidence: these lines only print if initialisation actually reached them, in order.
ok('  reaches the banner (config parsed, recipients resolved)', /waggle — mode=dryrun/.test(out))
ok('  reaches the public-lane summary (PUB built, channels resolved)', /public read lane -> inbox/.test(out))
ok('  reaches the gate summary (rate caps + A7 wired)', /gates: staging=/.test(out))

if (fails) {
  console.error('\n--- child output ---')
  console.error(out.split('\n').slice(0, 25).join('\n'))
}
console.log(fails ? `\nboot: ${fails} check(s) failed` : '\nboot: all checks passed')
process.exit(fails ? 1 : 0)
