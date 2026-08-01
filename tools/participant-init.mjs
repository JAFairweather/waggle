#!/usr/bin/env node
// participant-init.mjs — onboard an outside participant, and prove the loop actually closes.
//
//   node tools/participant-init.mjs new    --name <label> [--out <path>]   mint an identity
//   node tools/participant-init.mjs publish --key <path>                   profile + relay list
//   node tools/participant-init.mjs verify  --key <path> --grantor <npub>  is the loop real?
//
// A bridge with nobody on the other side is a demo. The thing an operator actually wants is an
// outside collaborator who can speak and be heard — so the setup is not finished when the bridge
// is configured, it is finished when a message goes out and an answer comes back.
//
// This is the participant half. The operator half is waggle-init.mjs.
//
// Two rules it will not bend:
//   · The identity is minted HERE, on the participant's own machine, and the secret is written
//     to a file only that user can read. It is never printed to the terminal, never passed as an
//     argument, never sent anywhere. Whoever runs this holds the key; nobody has to be trusted
//     with it, which is the entire reason a participant has their own key rather than an API token.
//   · This tool cannot admit anyone. Admission is the operator's signature — this prints the
//     exact command they must run and then waits. A participant that could admit itself is not a
//     participant, it is a back door.

import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import WebSocket from 'ws'
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1] }
const die = (m) => { console.error(`participant-init: ${m}`); process.exit(1) }
const say = (s = '') => console.log(s)

const RELAYS = (process.env.RELAYS?.split(',') || ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'])
  .map(s => s.trim()).filter(Boolean)
const toHex = (v) => {
  const s = String(v || '').trim()
  if (s.startsWith('npub1')) return nip19.decode(s).data
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase()
  die(`not an npub or 64-hex key: ${s || '(empty)'}`)
}
const loadKey = (p) => {
  if (!p) die('--key <path> is required')
  if (!existsSync(p)) die(`no key file at ${p} — run: participant-init new --name <label>`)
  const raw = readFileSync(p, 'utf8').trim()
  const sk = raw.startsWith('nsec1') ? nip19.decode(raw).data : Uint8Array.from(Buffer.from(raw, 'hex'))
  return { sk, pk: getPublicKey(sk) }
}

function publish(ev) {
  return Promise.all(RELAYS.map(url => new Promise(res => {
    let ws; try { ws = new WebSocket(url) } catch { return res(`${url} CONNECT-FAIL`) }
    const done = (m) => { try { ws.close() } catch { /* */ } ; res(`${new URL(url).host.padEnd(20)} ${m}`) }
    const t = setTimeout(() => done('TIMEOUT'), 12000)
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', ev])))
    ws.on('message', d => { try { const m = JSON.parse(d.toString())
      if (m[0] === 'OK' && m[1] === ev.id) { clearTimeout(t); done(m[2] ? 'OK' : `REJECTED ${m[3] || ''}`) } } catch { /* */ } })
    ws.on('error', e => { clearTimeout(t); done(`ERR ${e.message}`) })
  })))
}

function query(url, filter, ms = 9000) {
  return new Promise(res => {
    const out = []; let done = false, answered = false, ws
    try { ws = new WebSocket(url) } catch { return res({ out, answered }) }
    const fin = () => { if (done) return; done = true; try { ws.close() } catch { /* */ } ; res({ out, answered }) }
    const t = setTimeout(fin, ms)
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'p', filter])))
    ws.on('message', d => { try { const m = JSON.parse(d.toString())
      if (m[0] === 'EVENT') out.push(m[2])
      if (m[0] === 'EOSE') { answered = true; clearTimeout(t); fin() }
      if (m[0] === 'CLOSED') { clearTimeout(t); fin() } } catch { /* */ } })
    ws.on('error', () => { clearTimeout(t); fin() })
  })
}

// --- new: mint an identity, locally, and never show the secret ---------------------------------
if (cmd === 'new') {
  const name = flag('--name') || die('new needs --name <label>')
  const out = resolve(flag('--out') || resolve(homedir(), '.waggle', `${name.replace(/[^\w.-]/g, '_')}.key`))
  if (existsSync(out)) die(`${out} already exists — refusing to overwrite an existing identity`)
  const sk = generateSecretKey()
  const pk = getPublicKey(sk)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, nip19.nsecEncode(sk), { mode: 0o600 })
  chmodSync(out, 0o600)
  say('')
  say(`  Identity minted for "${name}".`)
  say('')
  say(`    npub  ${nip19.npubEncode(pk)}`)
  say(`    hex   ${pk}`)
  say(`    key   ${out}  ${'(mode 0600 — only you can read it)'}`)
  say('')
  say('  The secret was written to that file and deliberately not printed here. It was')
  say('  generated on this machine and has not left it. Nobody — not the operator, not the')
  say('  bridge — needs it or should ever be given it. That is the point of a participant')
  say('  holding its own key rather than being issued a token by someone else.')
  say('')
  say('  Next:  node tools/participant-init.mjs publish --key ' + out)
  process.exit(0)
}

// --- publish: make the identity discoverable ----------------------------------------------------
if (cmd === 'publish') {
  const keyPath = flag('--key')
  const { sk, pk } = loadKey(keyPath)
  const name = flag('--name') || 'waggle participant'
  const about = flag('--about') || 'An external participant on a waggle bridge. Admitted by a signed, revocable grant.'
  const picture = flag('--picture') || ''
  const now = Math.floor(Date.now() / 1000)

  const profile = finalizeEvent({ kind: 0, created_at: now, tags: [],
    content: JSON.stringify({ name, about, ...(picture ? { picture } : {}), bot: true }) }, sk)
  const relayList = finalizeEvent({ kind: 10002, created_at: now,
    tags: RELAYS.map(r => ['r', r]), content: '' }, sk)

  say('')
  say(`  Publishing as ${nip19.npubEncode(pk)}`)
  if (!picture) {
    say('')
    say('  No --picture given. If you add one later it must be a raster image (PNG), not SVG —')
    say('  Buzz renders SVG as a blank circle, which reads to everyone else as an impostor.')
  }
  say('')
  say('  kind:0 profile')
  for (const l of await publish(profile)) say('    ' + l)
  say('  kind:10002 relay list  (how others find where to reach you)')
  for (const l of await publish(relayList)) say('    ' + l)
  say('')
  say('  Next, the operator must admit you — they hold the signing key, not you:')
  say('')
  say(`    node tools/grant.mjs issue --to ${nip19.npubEncode(pk)} --channel <channel-uuid>`)
  say('')
  say('  Then prove it actually works:')
  say(`    node tools/participant-init.mjs verify --key ${keyPath} --grantor <operator npub>`)
  process.exit(0)
}

// --- verify: is any of this actually true? -------------------------------------------------------
if (cmd === 'verify') {
  const keyPath = flag('--key')
  const { pk } = loadKey(keyPath)
  const grantor = toHex(flag('--grantor') || die('verify needs --grantor <npub|hex>'))

  say('')
  say(`  Participant ${nip19.npubEncode(pk)}`)
  say('')

  // 1. discoverable
  const meEvents = new Map(); let answered = 0
  for (const url of RELAYS) {
    const { out, answered: a } = await query(url, { kinds: [0, 10002], authors: [pk] })
    if (a) answered++
    for (const e of out) meEvents.set(e.kind + ':' + e.id, e)
  }
  const hasProfile = [...meEvents.values()].some(e => e.kind === 0)
  const hasRelays = [...meEvents.values()].some(e => e.kind === 10002)
  say(`    ${hasProfile ? '✓' : '•'} profile published${hasProfile ? '' : ' — run: participant-init publish'}`)
  say(`    ${hasRelays ? '✓' : '•'} relay list published${hasRelays ? '' : ' — others cannot discover where to reach you'}`)

  // 2. admitted
  const grants = new Map()
  for (const url of RELAYS) {
    const { out } = await query(url, { kinds: [440, 441], authors: [grantor], limit: 300 })
    for (const e of out) grants.set(e.id, e)
  }
  const valid = [...grants.values()].filter(e => e.pubkey === grantor && verifyEvent(e))
    .sort((a, b) => a.created_at - b.created_at)
  const revoked = new Set(valid.filter(e => e.kind === 441).flatMap(e => e.tags.filter(t => t[0] === 'e').map(t => t[1])))
  const mine = valid.filter(e => e.kind === 440 && e.tags.some(t => t[0] === 'p' && t[1] === pk) && !revoked.has(e.id))
  const caps = [...new Set(mine.map(e => e.tags.find(t => t[0] === 'da-cap')?.[1]).filter(Boolean))]
  say(`    ${mine.length ? '✓' : '•'} admitted by the operator${mine.length ? ` — ${mine.length} live grant(s): ${caps.join(', ')}` : ' — nobody has signed you in yet'}`)

  // 3. reachable — can anything actually get back to this identity?
  const wraps = new Map()
  for (const url of RELAYS) {
    const { out } = await query(url, { kinds: [1059], '#p': [pk], limit: 50 })
    for (const e of out) wraps.set(e.id, e)
  }
  say(`    ${wraps.size ? '✓' : '•'} inbound reachable — ${wraps.size} sealed message(s) addressed to you`)

  say('')
  if (answered === 0) {
    say('    No relay answered. Nothing above is a finding — it is an unverifiable read, which')
    say('    is not the same as a failure. Try again before concluding anything.')
    process.exit(2)
  }
  const closed = hasProfile && hasRelays && mine.length && wraps.size
  if (closed) {
    say('    The loop is closed: you are discoverable, admitted, and reachable.')
  } else {
    say('    Not closed yet — the marked items above are outstanding. An installer that stops')
    say('    at "configured" has not established the thing that matters; this is why the last')
    say('    step is a check and not a checkbox.')
  }
  process.exit(closed ? 0 : 1)
}

die('usage: participant-init.mjs new --name <label> | publish --key <path> | verify --key <path> --grantor <npub>')
