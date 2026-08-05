#!/usr/bin/env node
// Stage the preferred keyless tripwire alarm pairing without putting either credential on argv.
// The Bunker URI is read from stdin; this tool generates only the revocable NIP-46 transport key.
// The alarm identity's nsec remains in the Bunker and never exists on this host.
import { mkdirSync, openSync, writeFileSync, closeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { generateSecretKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'

const fail = message => { console.error(`tripwire-alarm-bunker-init: ${message}`); process.exit(1) }
const allowed = new Set(['--directory', '--recipient', '--poster'])
const parsed = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i], value = process.argv[i + 1]
  if (!allowed.has(name) || value == null || value.startsWith('--')) fail(`unknown or incomplete argument: ${name}`)
  if (parsed.has(name)) fail(`${name} may be supplied only once`)
  parsed.set(name, String(value).trim())
}
if (process.argv.some(value => /^nsec1|^bunker:\/\//i.test(value))) fail('never pass a Bunker URI or secret key on argv')
const arg = name => parsed.get(name) || ''
const directory = resolve(arg('--directory') || '/etc/waggle-tripwire')

function publicKey(value, label) {
  if (!value) fail(`${label} is required`)
  let result
  try { result = value.startsWith('npub1') ? nip19.decode(value).data : value.toLowerCase() }
  catch { fail(`${label} is not a valid npub`) }
  if (!/^[0-9a-f]{64}$/.test(result)) fail(`${label} must be an npub or 64-hex public key`)
  return result
}
const recipient = publicKey(arg('--recipient'), '--recipient')
const posterInput = arg('--poster'), poster = posterInput ? publicKey(posterInput, '--poster') : ''

let input = ''
for await (const chunk of process.stdin) {
  input += chunk
  if (Buffer.byteLength(input) > 8192) fail('Bunker URI input exceeds 8192 bytes')
}
const uriText = input.trim()
if (!uriText || /[\r\n]/.test(uriText)) fail('stdin must contain exactly one Bunker URI')
const match = /^bunker:\/\/([0-9a-f]{64})/i.exec(uriText)
if (!match) fail('stdin does not contain a valid bunker:// URI')
let uri
try { uri = new URL(uriText) } catch { fail('stdin does not contain a valid bunker:// URI') }
if (![...uri.searchParams.getAll('relay')].some(value => /^wss:\/\//.test(value))) fail('Bunker URI needs at least one wss relay')
const alarmPub = match[1].toLowerCase()
if (poster && alarmPub === poster) fail('alarm Bunker identity must differ from the bridge poster identity')

try { mkdirSync(dirname(directory), { recursive: true, mode: 0o700 }); mkdirSync(directory, { mode: 0o700 }) }
catch (error) { fail(`refusing existing/unwritable directory ${directory}: ${error.message}`) }
const writePrivate = (path, value) => {
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, value + '\n') } finally { closeSync(fd) }
}
try {
  writePrivate(resolve(directory, 'alarm.bunker-uri'), uriText)
  writePrivate(resolve(directory, 'alarm.client-nsec'), nip19.nsecEncode(generateSecretKey()))
  writePrivate(resolve(directory, 'alarm.to'), nip19.npubEncode(recipient))
} catch (error) { fail(`credential write failed: ${error.message}`) }

console.log(`tripwire alarm identity: ${nip19.npubEncode(alarmPub)}`)
console.log(`recipient: ${nip19.npubEncode(recipient)}`)
console.log(`credentials: ${directory}/alarm.bunker-uri + alarm.client-nsec + alarm.to (0600; secrets not printed)`)
console.log('Next: install/reload the unit, approve the Bunker pairing, run the positive sealed-delivery drill, then a clean timer tick.')
