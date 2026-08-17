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
import { BunkerSigner } from 'nostr-tools/nip46'
import './ws_runtime.mjs'

const BUNKER = /^bunker:\/\/([0-9a-f]{64})/i

// `nostr-tools/nip46` does NOT import `pool.js`. It inlines its own copy — its own `_WebSocket`
// (nip46.js:1253), its own `try { _WebSocket = WebSocket } catch {}` (:1255), its own `SimplePool`
// (:1258) — and `BunkerSigner` constructs THAT class whenever no pool is passed (:1351). So the
// `useWebSocketImplementation` call in `ws_runtime.mjs` sets a variable in a different module and
// has no effect on this path, and nip46 exports no installer of its own. `params.pool` is the only
// lever it offers.
//
// Left alone on Node 20 the door reports `WebSocket is not defined` on every relay, and that
// surfaces as EOSE — byte-identical to a healthy relay with nothing to say (#578). It is the same
// silent shape as #576, one module further in, and it is why the fix has to be applied here rather
// than only where a raw socket is constructed.
//
// Everything that needs a `BunkerSigner` comes through this. `tests/ship_imports.mjs` enforces that
// this module is the only one allowed to import `nostr-tools/nip46`, because a caller that reaches
// for it directly reopens the door and nothing downstream can tell.
export { parseBunkerInput } from 'nostr-tools/nip46'

export function bunkerSignerFromUri(clientSecretKey, bunkerPointer, params = {}, { Pool = SimplePool } = {}) {
  return BunkerSigner.fromBunker(clientSecretKey, bunkerPointer, { ...params, pool: params.pool || new Pool() })
}

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
      // A verified signature by the pinned key proves the responder holds that key ONLY if the event
      // it signed is the event that was submitted. Nothing above compared the two, so a responder
      // holding no key at all could answer with a SCRAPED PUBLIC NOTE authored by the pinned
      // identity — every identity here publishes a kind:0 by design, so a qualifying event always
      // exists and is always public — and it verifies, and its pubkey matches, and the pin passes.
      //
      // Where the signed event IS the artifact being published, that substitution fails visibly
      // downstream and the wrapper is not what catches it. Where it is not, it is invisible and the
      // conclusion drawn from it is printed as fact: `tools/join.mjs` signs a challenge, discards
      // the return value, never publishes it, and prints `custody proved` — which gates the seat
      // write. `buildTripwireAlarmWrap` and `console/bunker-custody.mjs` each already do this
      // comparison for their own caller (#491). Doing it here is the same argument as the pin
      // itself: a check at the wrapper is the only shape that cannot be applied to some of the
      // signatures and not the others.
      const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
      const changed = []
      if (Number(event && event.kind) !== Number(signed.kind)) changed.push('kind')
      if (String((event && event.content) ?? '') !== String(signed.content ?? '')) changed.push('content')
      if (!same((event && event.tags) || [], signed.tags || [])) changed.push('tags')
      // `created_at` only when the caller set one — NIP-46 lets a signer stamp an absent one, and
      // refusing that would be refusing a compliant signer rather than an impostor.
      if (event && event.created_at != null && Number(event.created_at) !== Number(signed.created_at))
        changed.push('created_at')
      if (changed.length)
        fail(`the signer returned ${where} over a DIFFERENT event than the one submitted — ` +
          `${changed.join(', ')} changed. A signature by the right key over the wrong event proves ` +
          'the responder can fetch one of that key\'s public notes, not that it can sign. Nothing published.', 1)
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
