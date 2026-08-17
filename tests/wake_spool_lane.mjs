// The wake lane end to end: `tools/agent-inbox.mjs --spool` as a real subprocess, against a real
// websocket relay on loopback, opening real NIP-59 wraps with a real signer.
//
// WHY THIS SUITE EXISTS RATHER THAN MORE CASES IN `wake_spool.mjs`. That suite drives the module and
// proves `deliver()` records before it claims. The tool defeated that one frame up: `agent-inbox`
// keeps its own in-memory `seen` set, claimed the id BEFORE calling the spool, and never released it
// when the durable write failed — so the message was skipped by the replay that was supposed to
// recover it. Every assertion in the module suite stayed green through that. The defect lived in the
// gap between two files, which is the only place a per-file suite cannot look.
//
// So this one owns the seam, and it owns it by DRIVING the tool: a subprocess, a relay that replays
// on reconnect, and the spool directory read off disk afterwards. Nothing here inspects source text.
//
// The relay is scripted, not mocked: it speaks REQ/EVENT/EOSE/CLOSE over ws on 127.0.0.1:0, and it
// can be told to drop a connection so the tool reconnects and replays — which is the exact sequence
// the durable index exists to survive.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey, getEventHash } from 'nostr-tools'
import * as nip44 from 'nostr-tools/nip44'
import { bytesToHex } from '@noble/hashes/utils'

let passed = 0, failed = 0
const check = (cond, label, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL — ${label}${detail ? `  [${detail}]` : ''}`) }
}

const TOOL = fileURLToPath(new URL('../tools/agent-inbox.mjs', import.meta.url))
const ROOT = mkdtempSync(join(tmpdir(), 'wake-lane-'))
let n = 0
const freshDir = () => { const d = join(ROOT, `d${++n}`); mkdirSync(d, { recursive: true }); return d }

// --- identities -----------------------------------------------------------------------------------
// `self` is the reading agent. `courier` is the trusted sender — on the real return lane that is the
// bridge, and the trust list authenticates the courier, never the author. `stranger` is untrusted.
const selfSk = generateSecretKey(), selfPk = getPublicKey(selfSk)
const courierSk = generateSecretKey(), courierPk = getPublicKey(courierSk)
const strangerSk = generateSecretKey()

/** A real NIP-59 gift wrap addressed to `self`, sealed by `senderSk`. Built the way the egress lane
 *  builds one, so the tool's two `nip44Decrypt` calls are exercised rather than stubbed. */
const wrapFor = (senderSk, text) => {
  const senderPk = getPublicKey(senderSk)
  const now = Math.floor(Date.now() / 1000)
  const rumor = { kind: 14, pubkey: senderPk, created_at: now, tags: [['p', selfPk]], content: text }
  rumor.id = getEventHash(rumor)
  const seal = finalizeEvent({
    kind: 13, created_at: now, tags: [],
    content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(senderSk, selfPk)),
  }, senderSk)
  const wsk = generateSecretKey()
  return finalizeEvent({
    kind: 1059, created_at: now, tags: [['p', selfPk]],
    content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wsk, selfPk)),
  }, wsk)
}

// --- the scripted relay -----------------------------------------------------------------------------
/**
 * Serves `backfill()` then EOSE on every subscription. `dropAfterEose` closes the socket once, so the
 * tool reconnects and the next connection replays whatever `backfill()` then returns.
 *
 * `connections` is the control that makes a silent run mean something: if the second connection never
 * happened, a message that was skipped and a message that was never offered look identical.
 */
async function startRelay() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((res, rej) => { wss.once('listening', res); wss.once('error', rej) })
  const state = { backfill: () => [], dropAfterEose: false, connections: 0, sentIds: [] }
  wss.on('connection', socket => {
    state.connections++
    socket.on('message', bytes => {
      let frame
      try { frame = JSON.parse(bytes.toString()) } catch { return }
      if (frame[0] !== 'REQ') return
      const sub = frame[1]
      for (const ev of state.backfill()) {
        state.sentIds.push(ev.id)
        socket.send(JSON.stringify(['EVENT', sub, ev]))
      }
      socket.send(JSON.stringify(['EOSE', sub]))
      if (state.dropAfterEose) { state.dropAfterEose = false; setTimeout(() => socket.close(), 60) }
    })
  })
  return { url: `ws://127.0.0.1:${wss.address().port}`, state, close: () => wss.close() }
}

/** Run the tool to completion and collect stdout/stderr separately — the JSONL contract is about
 *  which stream a line lands on, so they must never be merged here. */
function runTool(args, env, { killAfterMs = 0 } = {}) {
  return new Promise(resolve => {
    const p = spawn('node', [TOOL, ...args], {
      env: { ...process.env, BUZZ_PRIVATE_KEY: bytesToHex(selfSk), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', errOut = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { errOut += d })
    let timer = null
    if (killAfterMs) timer = setTimeout(() => p.kill('SIGINT'), killAfterMs)
    p.on('close', code => { if (timer) clearTimeout(timer); resolve({ code, out, errOut }) })
  })
}

const spoolIds = dir => {
  const p = join(dir, 'spool.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}
const indexSize = dir => {
  const p = join(dir, 'seen.log')
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0
}

const relay = await startRelay()
const base = ['--pubkey', selfPk, '--relays', relay.url, '--jsonl']
const trust = ['--trust', courierPk]

// ============================================================ must-fix 1: the claim is rolled back

console.log('\na durable write that failed must not leave the message claimed in memory')

// THE BLOCKER IS EISDIR, not a permission bit. `chmod` is ignored under root, and a test that cannot
// induce its own failure reports a pass for a case it never ran.
{
  const dir = freshDir()
  // Seed the marker so the run is steady rather than bootstrap — bootstrap records without waking,
  // and that would confound "was it spooled" with "was it announced".
  writeFileSync(join(dir, 'seen.log'), '')
  writeFileSync(join(dir, 'started'), 'seeded by the suite\n')

  const stuck = wrapFor(courierSk, 'the message that must survive a failed write')
  relay.state.backfill = () => [stuck]
  relay.state.dropAfterEose = true
  mkdirSync(join(dir, 'spool.jsonl'))          // connection 1 cannot append

  // Release the blocker while the tool is between connections, so connection 2 replays the SAME
  // wrap into a spool that now works.
  setTimeout(() => { try { rmSync(join(dir, 'spool.jsonl'), { recursive: true }) } catch { /* raced */ } }, 300)

  const before = relay.state.connections
  const r = await runTool([...base, ...trust, '--spool', dir, '--watch'], {}, { killAfterMs: 2500 })
  const records = spoolIds(dir)

  check(relay.state.connections >= before + 2,
    'the control: the relay served a second connection, so the replay really reached the tool',
    `connections=${relay.state.connections - before}`)
  check(/the in-memory claim is released/.test(r.errOut),
    'the failed write says the claim was released, not merely that it failed')
  check(records.length === 1,
    'the message the first connection could not write IS written by the replay — the memory claim did not outlive the failure',
    `spooled=${records.length}`)
  check(records[0]?.id === stuck.id,
    '  …and it is that same message, not some other one', `${records[0]?.id?.slice(0, 12)} vs ${stuck.id.slice(0, 12)}`)
}

// The control that makes the above mean something: with no blocker, one connection is enough.
{
  const dir = freshDir()
  writeFileSync(join(dir, 'seen.log'), ''); writeFileSync(join(dir, 'started'), 'seeded by the suite\n')
  const ev = wrapFor(courierSk, 'an ordinary message with nothing in the way')
  relay.state.backfill = () => [ev]
  relay.state.dropAfterEose = false
  const r = await runTool([...base, ...trust, '--spool', dir], {})
  check(spoolIds(dir).length === 1 && r.code === 0,
    'control: with the spool writable a single read records the message and exits 0',
    `spooled=${spoolIds(dir).length} code=${r.code}`)
  check(!/the in-memory claim is released/.test(r.errOut),
    '  …and says nothing about releasing a claim — the line above is a real failure path, not always-on prose')
}

// ============================================================ must-fix 2: the marker is written last

console.log('\nthe bootstrap marker counts the whole backfill, not whatever finished first')

// The marker is written LAST so a crash cannot leave it beside a half-filled index: that state reads
// as steady, and the unseeded remainder then wakes — the flood, arriving through the correct gate.
// EOSE is not "last": every open() for the backfill is still suspended inside two awaited decrypts.
{
  const dir = freshDir()
  const backfill = Array.from({ length: 8 }, (_, i) => wrapFor(courierSk, `backfill ${i}`))
  relay.state.backfill = () => backfill
  relay.state.dropAfterEose = false

  const r = await runTool([...base, ...trust, '--spool', dir, '--watch'], {}, { killAfterMs: 2500 })

  // READ DEFENSIVELY. An unsealed bootstrap is a real failure mode — it leaves the directory in the
  // index-without-marker state that refuses to start ever again — and it must be REPORTED, not
  // thrown. A suite that dies on ENOENT here names no assertion and reads as a broken test.
  const sealed = existsSync(join(dir, 'started'))
  check(sealed, 'the run sealed its bootstrap — an unsealed directory refuses every later start')
  const marker = sealed ? readFileSync(join(dir, 'started'), 'utf8') : ''
  const seeded = Number((marker.match(/seeded (\d+) id/) || [])[1])
  check(indexSize(dir) === 8, 'all 8 backfill ids reached the durable index', `index=${indexSize(dir)}`)
  check(seeded === 8,
    'and the marker records all 8 — written after the seeding it describes, not on the EOSE frame while 7 were still decrypting',
    `marker says ${seeded}`)
  check(/8 id\(s\) recorded without waking/.test(r.errOut),
    '  …and the operator is told the same number, because that line is what they would act on')
  check(spoolIds(dir).every(rec => rec.wake === false),
    'nothing in a first-ever backfill wakes anybody — it is recorded, not announced')
}

// ============================================================ must-fix 3: stdout is JSONL, all of it

console.log('\n--jsonl means every stdout line parses, including the first line of a restart')

{
  const dir = freshDir()
  const first = wrapFor(courierSk, 'seed the index so the next start has something to load')
  relay.state.backfill = () => [first]
  relay.state.dropAfterEose = false
  await runTool([...base, ...trust, '--spool', dir], {})
  check(indexSize(dir) >= 1, 'precondition: the first read left ids in the index for the restart to load',
    `index=${indexSize(dir)}`)

  // The restart is the case that broke: `durableSet.load` announces itself on every start, and that
  // line went to stdout — so line 1 of every restart threw for a reader doing JSON.parse per line.
  const second = wrapFor(courierSk, 'a second message, so stdout is not empty by accident')
  relay.state.backfill = () => [second]
  const r = await runTool([...base, ...trust, '--spool', dir], {})

  const lines = r.out.split('\n').filter(Boolean)
  let unparsed = null
  for (const l of lines) { try { JSON.parse(l) } catch { unparsed = l; break } }
  check(lines.length > 0, 'the restart put something on stdout — an empty stream would pass the next check for free',
    `${lines.length} line(s)`)
  check(unparsed === null, 'every stdout line is a JSON object', unparsed ? unparsed.slice(0, 80) : '')
  check(/loaded \d+ delivered id/.test(r.errOut),
    '  …and the index load line is still SAID, on stderr — moved, not silenced, or a surprising index size becomes invisible')
}

// ============================================================ the acceptance test: who wakes

console.log('\nan untrusted sender is recorded and wakes nobody; a trusted one wakes')

// THE THIRD RUN IS NOT OPTIONAL. Without a control proving the events reached the tool at all, a
// message that was correctly suppressed and a message that was never delivered are the same green.
{
  const dir = freshDir()
  writeFileSync(join(dir, 'seen.log'), ''); writeFileSync(join(dir, 'started'), 'seeded by the suite\n')
  const hookLog = join(dir, 'hook.log')
  const hookPath = join(dir, 'hook.sh')
  writeFileSync(hookPath, `#!/bin/sh\ncat >> ${JSON.stringify(hookLog)}\necho >> ${JSON.stringify(hookLog)}\n`, { mode: 0o755 })

  const fromStranger = wrapFor(strangerSk, 'a stranger seals mail to this key — anyone can')
  const fromCourier = wrapFor(courierSk, 'the courier this agent trusts')
  relay.state.backfill = () => [fromStranger, fromCourier]
  relay.state.dropAfterEose = false

  await runTool([...base, ...trust, '--spool', dir, '--on-message', hookPath], {})

  const recs = spoolIds(dir)
  const byId = id => recs.find(r => r.id === id)
  const hookFired = existsSync(hookLog) ? readFileSync(hookLog, 'utf8') : ''

  check(recs.length === 2,
    'BOTH messages are recorded — a lane being fed untrusted mail must not look like a quiet one',
    `spooled=${recs.length}`)
  check(byId(fromStranger.id)?.wake === false,
    'the untrusted message does not wake')
  check(byId(fromCourier.id)?.wake === true,
    'the trusted message DOES wake — without this, "nothing woke" could just mean the gate rejects everything')
  check(hookFired.includes(fromCourier.id) && !hookFired.includes(fromStranger.id),
    'and the hook ran for exactly the trusted one — the record stream and the hook agree on who woke')
}

// ============================================================ the forgery record reaches the disk

console.log('\na forged seal is recorded even when stdout is not being used')

// The forged-seal branch exists because a lane fed forgeries once put ZERO lines on stdout and looked
// exactly like a quiet lane. Under `--spool` with no `--jsonl` that record was written nowhere at
// all — the same silence, relocated. Run WITHOUT `--jsonl`, which is the configuration that broke.
{
  const dir = freshDir()
  writeFileSync(join(dir, 'seen.log'), ''); writeFileSync(join(dir, 'started'), 'seeded by the suite\n')

  // THE FORGERY IS BUILT THROUGH JSON, NEVER A SPREAD. `verifyEvent` memoises its result on a symbol
  // property, and an object spread copies that symbol — so `{...ev, sig}` verifies TRUE against the
  // cached verdict of the event it was copied from, and the fixture would silently not be a forgery.
  const honest = wrapFor(courierSk, 'this one is real')
  const forged = (() => {
    const inner = JSON.parse(JSON.stringify(finalizeEvent({
      kind: 13, created_at: Math.floor(Date.now() / 1000), tags: [],
      content: nip44.encrypt(JSON.stringify({ kind: 14, pubkey: courierPk, created_at: 1, tags: [['p', selfPk]], content: 'forged' }),
        nip44.getConversationKey(courierSk, selfPk)),
    }, courierSk)))
    inner.sig = inner.sig.replace(/^../, inner.sig.startsWith('00') ? 'ff' : '00')   // breaks the signature
    const wsk = generateSecretKey()
    return finalizeEvent({
      kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', selfPk]],
      content: nip44.encrypt(JSON.stringify(inner), nip44.getConversationKey(wsk, selfPk)),
    }, wsk)
  })()

  relay.state.backfill = () => [forged, honest]
  relay.state.dropAfterEose = false
  const r = await runTool(['--pubkey', selfPk, '--relays', relay.url, ...trust, '--spool', dir], {})

  const recs = spoolIds(dir)
  check(r.out === '' || !r.out.includes('{'),
    'precondition: this run is NOT --jsonl, so stdout carries no records — the disk is the only place left')
  check(recs.length === 2,
    'both the forgery and the honest message are on disk', `spooled=${recs.length}`)
  check(recs.some(x => x.ok === false),
    'the forged seal is recorded as a refusal — a lane being fed forgeries must never read as quiet')
  check(recs.some(x => x.ok === true && x.wake === true),
    '  …alongside the honest one, which still gets through — or the branch above would just mean everything is refused')
}

relay.close()
rmSync(ROOT, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
