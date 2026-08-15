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

export function makeBunkerSigner(uriText, clientNsec, {
  Pool = SimplePool,
  uriLabel = 'WAGGLE_BUNKER_URI_FILE',
  clientLabel = 'WAGGLE_NIP46_CLIENT_NSEC_FILE',
} = {}) {
  const raw = String(uriText || '').trim(), match = BUNKER.exec(raw)
  if (!match) throw new Error(`${uriLabel} does not contain a valid bunker URI`)
  const uri = new URL(raw)
  const relays = [...new Set(uri.searchParams.getAll('relay').filter(v => /^wss:\/\//.test(v)))]
  if (!relays.length) throw new Error('Waggle bunker URI needs at least one wss relay')
  const pubkey = match[1].toLowerCase(), secret = uri.searchParams.get('secret') || ''
  const clientKey = nsec(clientNsec, clientLabel)
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
  // `pubkey` above is the REMOTE SIGNER's key — the hex in `bunker://<hex>`. NIP-46 permits that to
  // differ from the user identity the signer holds, and `get_public_key` is the method that
  // resolves the second. Nothing here called it, so callers that read `.pubkey` as "who this signs
  // as" were reading the transport address. Pinning custody to it dead-ends both ways: pin to the
  // URI hex and every signature is a CUSTODY MISMATCH, or name the true identity and it is refused
  // for disagreeing with the pairing. There is no third configuration, so it must be asked.
  //
  // `pubkey` keeps its meaning for every existing caller; this is the value to pin against.
  let identity
  const userPubkey = async () => {
    if (identity) return identity
    await ready()
    const got = String(await rpc('get_public_key', [], 15000) || '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(got)) {
      throw new Error(`${uriLabel}: get_public_key returned ${got ? 'a malformed pubkey' : 'nothing'} — ` +
        'cannot establish which identity this bunker signs as, so nothing may be pinned to it')
    }
    return (identity = got)
  }
  return Object.freeze({ pubkey, remote: true, userPubkey,
    // timeoutMs matters where a human approves the prompt: NIP-98 wants created_at within ±60s of
    // server time, so the default 60s can return a locally valid signature the relay calls stale.
    async signEvent(event, { timeoutMs } = {}) { await ready(); return JSON.parse(await rpc('sign_event', [JSON.stringify(event)], timeoutMs ?? 60000)) },
    async nip44Encrypt(peer, plaintext) { await ready(); return rpc('nip44_encrypt', [peer, plaintext]) },
    async nip44Decrypt(peer, ciphertext) { await ready(); return rpc('nip44_decrypt', [peer, ciphertext]) },
    close() { for (const p of pending.values()) p.reject(new Error('nip46 signer closed')); pending.clear(); try { pool.close(relays) } catch {} },
  })
}

export function loadBunkerSignerFiles(uriFile, clientFile, deps = {}, {
  uriLabel = 'WAGGLE_BUNKER_URI_FILE',
  clientLabel = 'WAGGLE_NIP46_CLIENT_NSEC_FILE',
} = {}) {
  if (!!uriFile !== !!clientFile) throw new Error(`set both ${uriLabel} and ${clientLabel}`)
  if (!uriFile) return null
  return makeBunkerSigner(privateFile(uriFile, uriLabel), privateFile(clientFile, clientLabel), {
    ...deps, uriLabel, clientLabel,
  })
}

export function makeLocalSigner(raw, label = 'BUZZ_PRIVATE_KEY') {
  const sk = raw.startsWith('nsec1') ? nsec(raw, label) : Uint8Array.from(Buffer.from(raw, 'hex'))
  if (sk.length !== 32) throw new Error(`${label} is not a valid nsec or 64-hex key`)
  const pubkey = getPublicKey(sk), conversation = peer => nip44.getConversationKey(sk, peer)
  return Object.freeze({ pubkey, remote: false,
    // Local: the key IS the identity, so no round trip. Present so a caller can pin the same way
    // against either backend rather than branching on `remote`.
    userPubkey: async () => pubkey,
    signEvent: async event => finalizeEvent(event, sk),
    nip44Encrypt: async (peer, plaintext) => nip44.encrypt(plaintext, conversation(peer)),
    nip44Decrypt: async (peer, ciphertext) => nip44.decrypt(ciphertext, conversation(peer)),
    close() {},
  })
}

// A signer's `pubkey` is only what the pairing CLAIMS. What proves custody is a signature that
// verifies against the key you expected — and a bunker answers every sign_event as an INDEPENDENT
// round trip, so proving the first one proves nothing about the fourth. A bunker holding more than
// one identity, a session paired to the wrong one, or an owner tapping a different account on the
// second approval prompt all land in the same place: one checked signature and the rest trusted.
//
// So the check is a wrapper rather than a call site. Every event the signer returns is verified and
// compared against one pinned key, which is the only shape that cannot be applied to some of the
// signatures and not the others. Errors carry the caller's exit code: 1 is a custody mismatch (bad
// input — the wrong identity), 2 is a signature that does not verify at all (a broken signer).
export function withPinnedCustody(signer, expect = '') {
  const pinned = String(expect || '').trim().toLowerCase()
  if (pinned && !/^[0-9a-f]{64}$/.test(pinned)) throw new Error('pinned pubkey must be 64-character hex')
  let signatures = 0
  const fail = (message, code) => { const e = new Error(message); e.exitCode = code; throw e }
  return Object.freeze({
    pubkey: signer.pubkey, remote: signer.remote, pinned,
    userPubkey: () => signer.userPubkey(),
    get signatures() { return signatures },
    async signEvent(event, opts) {
      const signed = await signer.signEvent(event, opts)
      const n = ++signatures
      const where = `signature ${n} (kind:${event && event.kind})`
      // verifyEvent THROWS on a malformed event rather than returning false, and an event straight
      // off a bunker is untrusted input. Letting that throw escape would surface as a crash instead
      // of the named refusal this exists to give.
      let valid = false
      try { valid = !!signed && verifyEvent(signed) } catch { valid = false }
      if (!valid) fail(`the signer returned ${where} that does not verify — nothing published`, 2)
      if (pinned && signed.pubkey !== pinned)
        fail(`CUSTODY MISMATCH on ${where}: the signer signed as ${signed.pubkey}, not ${pinned}. Nothing published.`, 1)
      return signed
    },
    nip44Encrypt: (peer, plaintext) => signer.nip44Encrypt(peer, plaintext),
    nip44Decrypt: (peer, ciphertext) => signer.nip44Decrypt(peer, ciphertext),
    close: () => signer.close(),
  })
}

export function loadNostrSigner(env = process.env, deps = {}) {
  const uriFile = String(env.WAGGLE_BUNKER_URI_FILE || '').trim()
  const clientFile = String(env.WAGGLE_NIP46_CLIENT_NSEC_FILE || '').trim()
  const remote = loadBunkerSignerFiles(uriFile, clientFile, deps)
  if (remote) return remote
  return env.BUZZ_PRIVATE_KEY ? makeLocalSigner(String(env.BUZZ_PRIVATE_KEY).trim()) : null
}
