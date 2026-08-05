#!/usr/bin/env node
// Mint the independent, zero-authority tripwire alarm identity directly into root-owned files.
// The secret is never printed or accepted on argv. Refuses an existing directory: rotation uses
// a fresh staging directory so the current working alarm remains recoverable until the drill passes.
import { mkdirSync, openSync, writeFileSync, closeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'

const fail = message => { console.error(`tripwire-alarm-init: ${message}`); process.exit(1) }
const allowed = new Set(['--directory', '--recipient', '--poster'])
const parsed = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i]
  const value = process.argv[i + 1]
  if (!allowed.has(name) || value == null || value.startsWith('--')) fail(`unknown or incomplete argument: ${name}`)
  if (parsed.has(name)) fail(`${name} may be supplied only once`)
  parsed.set(name, String(value).trim())
}
const arg = name => parsed.get(name) || ''
// There is deliberately no import path. Public 64-hex values remain valid in the two public-key
// slots, but an nsec anywhere on argv is always an operator mistake.
if (process.argv.some(value => /^nsec1/i.test(value))) fail('never pass a secret key on argv')

const directory = resolve(arg('--directory') || '/etc/waggle-tripwire')
const recipientInput = arg('--recipient')
const posterInput = arg('--poster')
if (!recipientInput) fail('--recipient <operator npub> is required')
let recipient
try { recipient = recipientInput.startsWith('npub1') ? nip19.decode(recipientInput).data : recipientInput.toLowerCase() } catch { fail('recipient is not a valid npub') }
if (!/^[0-9a-f]{64}$/.test(recipient)) fail('recipient must be an npub or 64-hex public key')
let poster = ''
if (posterInput) {
  try { poster = posterInput.startsWith('npub1') ? nip19.decode(posterInput).data : posterInput.toLowerCase() } catch { fail('poster is not a valid npub') }
  if (!/^[0-9a-f]{64}$/.test(poster)) fail('poster must be an npub or 64-hex public key')
}

try { mkdirSync(dirname(directory), { recursive: true, mode: 0o700 }); mkdirSync(directory, { mode: 0o700 }) }
catch (e) { fail(`refusing existing/unwritable directory ${directory}: ${e.message}`) }
const sk = generateSecretKey(), alarmPub = getPublicKey(sk)
if (poster && alarmPub === poster) fail('generated alarm identity unexpectedly equals poster; run again in a fresh directory')
const writePrivate = (path, value) => {
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, value + '\n') } finally { closeSync(fd) }
}
try {
  writePrivate(resolve(directory, 'alarm.nsec'), nip19.nsecEncode(sk))
  writePrivate(resolve(directory, 'alarm.to'), nip19.npubEncode(recipient))
} catch (e) { fail(`credential write failed: ${e.message}`) }

console.log(`tripwire alarm identity: ${nip19.npubEncode(alarmPub)}`)
console.log(`recipient: ${nip19.npubEncode(recipient)}`)
console.log(`credentials: ${directory}/alarm.nsec + alarm.to (0600; secret not printed)`)
console.log('Next: install/reload the unit, run the positive sealed-delivery drill, then a clean timer tick.')
