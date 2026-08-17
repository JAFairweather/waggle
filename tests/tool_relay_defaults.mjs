// tool_relay_defaults.mjs — no tool in tools/ carries its own default relay set (#589).
//
// `src/relays.mjs` was created to end exactly this, and its own header says so: the pair
// `['wss://nos.lol', 'wss://relay.primal.net']` "was defined nine times", and seven of those were in
// tools/. Ten tools were converted. TWO WERE MISSED, and they were the two an onboarded agent runs
// every day:
//
//   tools/agent-send.mjs   'wss://nos.lol,wss://relay.primal.net'                       two
//   tools/agent-inbox.mjs  ['wss://nos.lol','wss://relay.primal.net','wss://ditto…']    three
//
// So the agent SPOKE on one set and LISTENED on another, and neither was the module's four. That is
// not a tidiness complaint. nos.lol has refused waggle's sealed wraps for want of 28 bits of
// proof-of-work since 2026-08-08 (#345), so a two-relay default whose first entry always refuses is
// an effective set of ONE — and a reply carried to a relay the agent does not subscribe to is lost
// with nothing anywhere reporting a failure. Measured live while filing #589: the old send default
// reported `accepted by 0/2 — NOT sent` twice in a row.
//
// A sweep found these two. What stops the eleventh is a check, not another sweep — the module's own
// comment records that the sweep already happened once and still left these behind.
//
// WHAT THIS ASSERTS, and why it is written this way:
//
//   1. A repo scan. Any tool holding a COMPLETE relay URL literal in code must import from
//      `src/relays.mjs`. Deliberately not "must hold no literal at all": `retract.mjs` and
//      `publish-dm-relay-list.mjs` legitimately extend DEFAULT_PUBLIC_RELAYS with one extra relay,
//      and a rule that refused them would be worked around rather than obeyed.
//   2. The two tools are RUN, and their resolved set read off stderr. A source match cannot tell
//      `relaySet(x)` from `relaySet(x, SOMETHING_ELSE)`, and the whole defect was a default nobody
//      looked at. Both are drivable without a network: agent-send stops at --dry-run, agent-inbox
//      resolves relays at :53 and dies for want of a signer at :98, before it dials anything.
//   3. A negative control on the scan, driven on purpose: a fixture with a literal and no import
//      must be reported. A scanner that has only ever returned clean cannot be told from one that
//      always does — and a clean report is exactly what CI gave for every day these two shipped.

import { readdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { DEFAULT_PUBLIC_RELAYS } from '../src/relays.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const ok = (name, cond, detail = '') => {
  if (cond) return console.log(`  ok   ${name}`)
  fails++
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('tool relay defaults (#589)')

// --- the scanner ------------------------------------------------------------------------------
// A complete relay URL is `wss://` plus a host with at least one dot. That discriminator is
// load-bearing: tools/ is full of `'wss://'` in usage strings and `.replace('wss://', '')` in
// output formatting, and a rule that fired on those would fire on nine innocent files at once.
const FULL_RELAY_URL = /wss:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/i

// Comments are stripped, because a header that DOCUMENTS the default set is not a file that holds
// one — `agent-send.mjs` now explains in prose what it used to hardcode, and must not be reported
// for saying so. `//` inside `wss://` is not a comment, hence the "not preceded by a colon" rule;
// a naive strip cuts every relay URL in the repo in half and reports the file clean.
function codeOnly (src) {
  const out = []
  let inBlock = false
  for (const raw of src.split('\n')) {
    let line = raw
    if (inBlock) {
      const close = line.indexOf('*/')
      if (close < 0) { out.push(''); continue }
      line = line.slice(close + 2)
      inBlock = false
    }
    const open = line.indexOf('/*')
    if (open >= 0) { inBlock = !line.includes('*/', open); line = line.slice(0, open) + (inBlock ? '' : line.slice(line.indexOf('*/', open) + 2)) }
    if (/^\s*(\/\/|\*)/.test(line)) { out.push(''); continue }
    out.push(line.replace(/(^|[^:])\/\/.*$/, '$1'))
  }
  return out.join('\n')
}

function scan (dir, files) {
  const offenders = []
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8')
    const code = codeOnly(src)
    if (!FULL_RELAY_URL.test(code)) continue
    if (/from '\.\.\/src\/relays\.mjs'/.test(src) || /from '\.\/relays\.mjs'/.test(src)) continue
    offenders.push(f)
  }
  return offenders
}

// The scanner has to be able to see a URL at all before a clean report from it means anything.
ok('the scanner reads a bare relay URL as a relay URL', FULL_RELAY_URL.test(codeOnly("const R = ['wss://nos.lol']")))
ok('…and does NOT read a scheme fragment as one — `.replace(\'wss://\', \'\')` is formatting',
  !FULL_RELAY_URL.test(codeOnly("url.replace('wss://', '')")))
ok('…and does NOT read a documented URL in a comment as one',
  !FULL_RELAY_URL.test(codeOnly("// the default used to be wss://nos.lol\nconst R = relaySet(x)")))
ok('…and still sees a URL on a line that ALSO carries a trailing comment',
  FULL_RELAY_URL.test(codeOnly("const R = ['wss://nos.lol'] // note about wss://elsewhere.example")))

// --- 1. the repo scan -------------------------------------------------------------------------
const toolFiles = readdirSync(join(ROOT, 'tools')).filter(f => f.endsWith('.mjs'))
ok('tools/ is not empty — a scan of nothing reports everything clean', toolFiles.length > 5, `${toolFiles.length} file(s)`)
const offenders = scan(join(ROOT, 'tools'), toolFiles)
ok('no tool carries a relay URL without importing src/relays.mjs', offenders.length === 0, offenders.join(', '))

// The two that were missed, named explicitly. The scan above would pass if someone deleted them.
for (const f of ['agent-send.mjs', 'agent-inbox.mjs']) {
  const src = readFileSync(join(ROOT, 'tools', f), 'utf8')
  ok(`${f} takes its relay parsing from src/relays.mjs`, /(parseR|r)elaySet[^\n]*from '\.\.\/src\/relays\.mjs'/.test(src))
  ok(`${f} holds no relay URL of its own`, !FULL_RELAY_URL.test(codeOnly(src)))
}

// --- 2. NEGATIVE CONTROL on the scan --------------------------------------------------------
// Driven once, on purpose. Without this the scan above is a check that has only ever passed.
const tmp = mkdtempSync(join(tmpdir(), 'waggle-589-'))
writeFileSync(join(tmp, 'clean.mjs'), "import { relaySet } from '../src/relays.mjs'\nconst R = relaySet(process.env.X)\n")
writeFileSync(join(tmp, 'offender.mjs'), "// a tool that went its own way\nconst R = ['wss://nos.lol', 'wss://relay.primal.net']\nexport default R\n")
const caught = scan(tmp, ['clean.mjs', 'offender.mjs'])
ok('NEGATIVE CONTROL — a tool with its own literal and no import IS reported',
  caught.length === 1 && caught[0] === 'offender.mjs', caught.join(', ') || 'reported nothing')
ok('…and the importing tool beside it is NOT reported — the scan refuses the dangerous file, not every file',
  !caught.includes('clean.mjs'))

// --- 3. the tools are RUN, and their resolved set read back ------------------------------------
const BRIDGE = getPublicKey(generateSecretKey())   // a real curve point; a filler 64-hex fails later for unrelated reasons
const NSEC = Buffer.from(generateSecretKey()).toString('hex')
const CHANNEL = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
const line = (out, tool) => (out.split('\n').find(l => l.startsWith(`${tool}: relays `)) || '').replace(`${tool}: relays `, '').trim()

const send = spawnSync(process.execPath, [join(ROOT, 'tools', 'agent-send.mjs'), '--channel', CHANNEL, '--bridge', BRIDGE, '--dry-run'],
  { input: '@My Dude — probe\n', env: { ...process.env, BUZZ_PRIVATE_KEY: NSEC, WAGGLE_RELAY_RELAYS: '' }, encoding: 'utf8' })
ok('agent-send runs to a dry run', send.status === 0, `exit ${send.status}: ${String(send.stderr).slice(0, 160)}`)
ok('agent-send reports the relay set it would use', line(send.stderr, 'agent-send').length > 0, String(send.stderr).slice(0, 200))
ok('agent-send defaults to DEFAULT_PUBLIC_RELAYS, all four',
  line(send.stderr, 'agent-send') === DEFAULT_PUBLIC_RELAYS.join(' '), line(send.stderr, 'agent-send'))
ok('agent-send does NOT warn THIN on the default set', !/THIN RELAY SET/.test(send.stderr))

// agent-inbox resolves relays at :53 and dies for want of a signer at :98 — before it dials.
const SELF = getPublicKey(generateSecretKey())
const noSigner = { ...process.env, WAGGLE_RELAY_RELAYS: '' }
delete noSigner.BUZZ_PRIVATE_KEY; delete noSigner.WAGGLE_BUNKER_URI_FILE; delete noSigner.WAGGLE_NIP46_CLIENT_NSEC_FILE
const inbox = spawnSync(process.execPath, [join(ROOT, 'tools', 'agent-inbox.mjs'), '--pubkey', SELF], { env: noSigner, encoding: 'utf8' })
ok('agent-inbox stops at the signer, not at the network', inbox.status === 3 && /no signer configured/.test(inbox.stderr),
  `exit ${inbox.status}: ${String(inbox.stderr).slice(0, 160)}`)
ok('agent-inbox defaults to DEFAULT_PUBLIC_RELAYS, all four',
  line(inbox.stderr, 'agent-inbox') === DEFAULT_PUBLIC_RELAYS.join(' '), line(inbox.stderr, 'agent-inbox'))

// The property the whole issue is about, stated as one assertion rather than inferred from two.
ok('THE TWO HALVES OF THE LANE AGREE — speak set === listen set',
  line(send.stderr, 'agent-send') === line(inbox.stderr, 'agent-inbox') && line(send.stderr, 'agent-send').length > 0)

// Both directions: an operator override still gets through. A default that cannot be overridden is
// a different defect, and a test that only pinned the default would not notice it.
const oneRelay = spawnSync(process.execPath, [join(ROOT, 'tools', 'agent-send.mjs'), '--channel', CHANNEL, '--bridge', BRIDGE, '--dry-run', '--relays', 'wss://relay.example.org'],
  { input: '@My Dude — probe\n', env: { ...process.env, BUZZ_PRIVATE_KEY: NSEC }, encoding: 'utf8' })
ok('--relays still overrides the default', line(oneRelay.stderr, 'agent-send') === 'wss://relay.example.org', line(oneRelay.stderr, 'agent-send'))
ok('…and a one-relay override is called THIN, because 1/1 reads as a success',
  /THIN RELAY SET/.test(oneRelay.stderr) && /below the floor/.test(oneRelay.stderr), String(oneRelay.stderr).slice(0, 200))

const envSet = spawnSync(process.execPath, [join(ROOT, 'tools', 'agent-inbox.mjs'), '--pubkey', SELF],
  { env: { ...noSigner, WAGGLE_RELAY_RELAYS: 'wss://a.example.org,wss://b.example.org,wss://c.example.org' }, encoding: 'utf8' })
ok('WAGGLE_RELAY_RELAYS now configures the LISTEN half too — it used to be read by the speaking half only',
  line(envSet.stderr, 'agent-inbox') === 'wss://a.example.org wss://b.example.org wss://c.example.org', line(envSet.stderr, 'agent-inbox'))

// --- 4. an explicit set that is entirely refused REFUSES — it does not become the defaults (#591) --
// The blocker My Dude drove: `relaySet` falls back when the parse yields nothing, and it cannot tell
// "unset" from "nothing survived". Taking the module's default therefore introduced a redirection —
// name one private relay, get four public ones, exit 0, and THIN silent because four is above the
// floor. For a tool that signs and fans out, the substituted set carries the wrap's `p` tag and its
// timing to parties the operator explicitly did not name.
//
// Asserted in BOTH directions and on BOTH tools, because a refusal on its own cannot be told from a
// tool that refuses every --relays: each arm below is paired with the surviving-value control above.
// And the reason is asserted, not only the refusal — the operator acts on the message, and "relays
// must be wss://" is what tells them their `ws://relay.internal` was a scheme problem and not a
// typo in the host.
const REFUSED = 'ws://relay.internal.example:7777'
const sendRefused = spawnSync(process.execPath, [join(ROOT, 'tools', 'agent-send.mjs'), '--channel', CHANNEL, '--bridge', BRIDGE, '--dry-run', '--relays', REFUSED],
  { input: '@My Dude — probe\n', env: { ...process.env, BUZZ_PRIVATE_KEY: NSEC }, encoding: 'utf8' })
ok('agent-send REFUSES an explicit --relays that is entirely undialable', sendRefused.status !== 0, `exit ${sendRefused.status}`)
ok('…and does NOT publish to the public defaults instead — the redirection is the whole defect',
  !DEFAULT_PUBLIC_RELAYS.some(r => (line(sendRefused.stderr, 'agent-send') || '').includes(r)),
  line(sendRefused.stderr, 'agent-send') || '(no relay line — correct)')
ok('…and the reason names the refused value AND the rule, so the operator can act on it',
  sendRefused.stderr.includes(REFUSED) && /wss:\/\//.test(sendRefused.stderr) && /127\.0\.0\.1/.test(sendRefused.stderr),
  String(sendRefused.stderr).slice(0, 240))

const inboxRefused = spawnSync(process.execPath, [join(ROOT, 'tools', 'agent-inbox.mjs'), '--pubkey', SELF],
  { env: { ...noSigner, WAGGLE_RELAY_RELAYS: REFUSED }, encoding: 'utf8' })
ok('agent-inbox refuses it too — a watcher listening where you did not point it reports itself healthy and hears nothing',
  inboxRefused.status !== 0 && inboxRefused.stderr.includes(REFUSED), `exit ${inboxRefused.status}: ${String(inboxRefused.stderr).slice(0, 160)}`)
ok('…and it refuses at the relay set, BEFORE the signer check it would otherwise die on — so the message is about the right thing',
  !/no signer configured/.test(inboxRefused.stderr), String(inboxRefused.stderr).slice(0, 200))

// A PARTIAL drop is named and the run continues. Both halves: the survivor is still used, and the
// refused entry is still reported — a tool that silently kept going would look identical on the
// first assertion alone.
const partial = spawnSync(process.execPath, [join(ROOT, 'tools', 'agent-send.mjs'), '--channel', CHANNEL, '--bridge', BRIDGE, '--dry-run', '--relays', `${REFUSED},wss://relay.example.org`],
  { input: '@My Dude — probe\n', env: { ...process.env, BUZZ_PRIVATE_KEY: NSEC }, encoding: 'utf8' })
ok('a PARTIAL drop still runs, on exactly the entries that survived',
  partial.status === 0 && line(partial.stderr, 'agent-send') === 'wss://relay.example.org', `exit ${partial.status}: ${line(partial.stderr, 'agent-send')}`)
ok('…and says which entry it dropped — a silent partial drop is the same defect one size smaller',
  /DROPPED/.test(partial.stderr) && partial.stderr.includes(REFUSED), String(partial.stderr).slice(0, 200))
// The control that keeps every refusal above honest: an UNSET value still falls back, at exit 0.
ok('NEGATIVE CONTROL — an unset relay value still falls back to the defaults and runs; only a REFUSED one dies',
  send.status === 0 && line(send.stderr, 'agent-send') === DEFAULT_PUBLIC_RELAYS.join(' '))

console.log(fails ? `\ntool_relay_defaults: ${fails} check(s) failed` : '\nall checks passed')
process.exit(fails ? 1 : 0)
