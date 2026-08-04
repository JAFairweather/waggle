// nostr_signer.mjs — one identity capability for Waggle's sealed Nostr transport.
//
// Prefer a Bunker pairing held in mode-0600 files.  The participant nsec then never exists on
// this host; the only local secret is the NIP-46 client transport key, which cannot sign as the
// bridge.  BUZZ_PRIVATE_KEY remains as the legacy/local fallback until Buzz channel delivery has
// its own remote-signer transport (#54's second slice).

import { randomUUID } from 'node:crypto'
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from 'node:fs'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import * as nip44 from 'nostr-tools/nip44'
import { SimplePool } from 'nostr-tools/pool'

const BUNKER = /^bunker:\/\/([0-9a-f]{64})/i

function privateFile(path, label) {
  let fd
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW) }
  catch { throw new Error(`${label} cannot be read as a regular non-symlink file`) }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`)
    if (stat.mode & 0o077) throw new Error(`${label} must be mode 0600`)
    const value = readFileSync(fd, 'utf8').trim()
    if (!value) throw new Error(`${label} is empty`)
    return value
  } finally { closeSync(fd) }
}

function nsec(raw, label) {
  const decoded = nip19.decode(String(raw || '').trim())
  if (decoded.type !== 'nsec') throw new Error(`${label} must contain an nsec1 client credential`)
  return decoded.data
}

export function makeBunkerSigner(uriText, clientNsec, { Pool = SimplePool } = {}) {
  const raw = String(uriText || '').trim(), match = BUNKER.exec(raw)
  if (!match) throw new Error('WAGGLE_BUNKER_URI_FILE does not contain a valid bunker URI')
  const uri = new URL(raw)
  const relays = [...new Set(uri.searchParams.getAll('relay').filter(v => /^wss:\/\//.test(v)))]
  if (!relays.length) throw new Error('Waggle bunker URI needs at least one wss relay')
  const pubkey = match[1].toLowerCase(), secret = uri.searchParams.get('secret') || ''
  const clientKey = nsec(clientNsec, 'WAGGLE_NIP46_CLIENT_NSEC_FILE')
  const clientPubkey = getPublicKey(clientKey)
  const conversation = nip44.v2.utils.getConversationKey(clientKey, pubkey)
  const pool = new Pool(), pending = new Map()
  let subscribed = false, connected
  const subscribe = () => {
    if (subscribed) return
    subscribed = true
    pool.subscribeMany(relays, { kinds: [24133], authors: [pubkey], '#p': [clientPubkey] }, { onevent(event) {
      try {
        if (event.pubkey !== pubkey || !verifyEvent(event) ||
            !event.tags.some(t => t[0] === 'p' && t[1] === clientPubkey)) return
        const message = JSON.parse(nip44.v2.decrypt(event.content, conversation))
        const waiting = pending.get(message.id)
        if (!waiting) return
        pending.delete(message.id)
        message.error ? waiting.reject(new Error(`bunker: ${message.error}`)) : waiting.resolve(message.result)
      } catch { /* another client's response */ }
    } })
  }
  const rpc = (method, params, timeout = 60000) => new Promise((resolve, reject) => {
    subscribe()
    const id = randomUUID()
    let timer
    pending.set(id, {
      resolve(value) { clearTimeout(timer); resolve(value) },
      reject(error) { clearTimeout(timer); reject(error) },
    })
    const event = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000),
      tags: [['p', pubkey]], content: nip44.v2.encrypt(JSON.stringify({ id, method, params }), conversation) }, clientKey)
    void Promise.allSettled(pool.publish(relays, event))
    timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`nip46 ${method} timed out`)) }, timeout)
  })
  const ready = () => (connected ??= rpc('connect', [pubkey, secret], 15000))
  return Object.freeze({ pubkey, remote: true,
    async signEvent(event) { await ready(); return JSON.parse(await rpc('sign_event', [JSON.stringify(event)])) },
    async nip44Encrypt(peer, plaintext) { await ready(); return rpc('nip44_encrypt', [peer, plaintext]) },
    async nip44Decrypt(peer, ciphertext) { await ready(); return rpc('nip44_decrypt', [peer, ciphertext]) },
    close() { for (const p of pending.values()) p.reject(new Error('nip46 signer closed')); pending.clear(); try { pool.close(relays) } catch {} },
  })
}

function localSigner(raw) {
  const sk = raw.startsWith('nsec1') ? nsec(raw, 'BUZZ_PRIVATE_KEY') : Uint8Array.from(Buffer.from(raw, 'hex'))
  if (sk.length !== 32) throw new Error('BUZZ_PRIVATE_KEY is not a valid nsec or 64-hex key')
  const pubkey = getPublicKey(sk), conversation = peer => nip44.getConversationKey(sk, peer)
  return Object.freeze({ pubkey, remote: false,
    signEvent: async event => finalizeEvent(event, sk),
    nip44Encrypt: async (peer, plaintext) => nip44.encrypt(plaintext, conversation(peer)),
    nip44Decrypt: async (peer, ciphertext) => nip44.decrypt(ciphertext, conversation(peer)),
    close() {},
  })
}

export function loadNostrSigner(env = process.env, deps = {}) {
  const uriFile = String(env.WAGGLE_BUNKER_URI_FILE || '').trim()
  const clientFile = String(env.WAGGLE_NIP46_CLIENT_NSEC_FILE || '').trim()
  if (!!uriFile !== !!clientFile) throw new Error('set both WAGGLE_BUNKER_URI_FILE and WAGGLE_NIP46_CLIENT_NSEC_FILE')
  if (uriFile) return makeBunkerSigner(privateFile(uriFile, 'WAGGLE_BUNKER_URI_FILE'),
    privateFile(clientFile, 'WAGGLE_NIP46_CLIENT_NSEC_FILE'), deps)
  return env.BUZZ_PRIVATE_KEY ? localSigner(String(env.BUZZ_PRIVATE_KEY).trim()) : null
}
