// nostrconnect.mjs — the OTHER direction of NIP-46, which is the one that lets an agent seat itself.
//
// `bunker://` runs signer-first: the signer mints a URI carrying a secret, and something has to
// carry that string to the machine the agent runs on. The console proves custody of such a URI in
// the browser and then stops, because a web page cannot write to a filesystem. Everything that
// closes that gap moves a live credential — through a clipboard, a chat window, a relay — and the
// only step the operator is meant to take is an approval (#528).
//
// `nostrconnect://` runs client-first and moves nothing. The agent generates its own transport key
// on its own machine, prints a request, and the operator approves it in their signer's interface.
// `credentials/` is then written by the process that owns the directory, out of material it
// generated itself. `src/bunker_paste.mjs:43` already named this direction while refusing it.
//
// ── What proves what ───────────────────────────────────────────────────────────────────────────
//
// Two separate claims, and conflating them is how this goes wrong:
//
//   1. **Which approval this is.** The request carries a `secret`, and the signer echoes it back.
//      Only someone shown the request knows it, so the echo binds the response to the operator's
//      approval. A response that does not echo it is UNBOUND, and the adversary who can send one is
//      the **relay operator**, not a reader of published events: nothing here publishes anything.
//      The URI is printed to a terminal and `awaitApproval` only subscribes — but the subscription
//      filter is `{kinds:[24133], '#p':[clientPubkey]}`, so every relay passed in `--relay` is
//      handed the address to answer at. Correcting who this defends against because it is the
//      sentence the next person reasons from (#529 review).
//
//   2. **Which identity it holds.** Nothing in the handshake establishes this, and `get_public_key`
//      cannot: an impostor controls every RPC response it sends, so it will happily answer with the
//      key you were hoping for. What it cannot produce is a signature by that key **over the event
//      it was handed** — so custody is proven by signing a fresh challenge, verifying the signature
//      against the pinned key (`withPinnedCustody`) AND comparing the returned event back against
//      the one submitted (`assertChallengeProof`). Verification alone is not the claim: see that
//      function's header for the impostor it does not stop.
//
// Neither claim implies the other, and the caller is expected to establish both before it writes
// anything to disk.

import { randomBytes } from 'node:crypto'
import { getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import * as nip44 from 'nostr-tools/nip44'
import { SimplePool } from 'nostr-tools/pool'
import './ws_runtime.mjs'
import { URLSearchParams } from 'node:url'

/// NIP-46 request/response kind. The same kind carries the whole conversation in both directions.
export const NIP46_KIND = 24133

/// What waggle's lanes actually need from a signer, and nothing beyond it.
///
/// `nip44_decrypt` is in the list because an agent reads its own sealed mail; a pairing granted
/// sign-only signs happily and then reports an empty inbox, which is the failure mode this project
/// specialises in — it looks exactly like nobody having written.
export const REQUIRED_PERMS = Object.freeze(['sign_event', 'nip44_encrypt', 'nip44_decrypt'])

/// A fresh binding secret. Hex rather than base64 so it survives a QR, a terminal and a clipboard
/// without an encoding argument; 16 bytes because it defends a single short-lived approval window.
export const mintSecret = (bytes = 16) => randomBytes(bytes).toString('hex')

const wss = r => /^wss:\/\/[^\s]+$/.test(String(r || '').trim())

/**
 * Render the `nostrconnect://` request the operator approves.
 *
 * The relay list is the ONLY channel the response can arrive on, so an empty one is refused rather
 * than defaulted: a request nothing can answer waits out its timeout and reports as "not approved",
 * which sends the operator to their signer to debug a fault that is on this side.
 */
export function nostrconnectUri({ clientPubkey, relays = [], secret, name, url, image,
  perms = REQUIRED_PERMS } = {}) {
  const pub = String(clientPubkey || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(pub)) throw new Error('nostrconnect: clientPubkey must be 64-character hex')
  const set = [...new Set((Array.isArray(relays) ? relays : [relays]).map(r => String(r || '').trim()).filter(wss))]
  if (!set.length) throw new Error('nostrconnect: at least one wss:// relay is required — the response has no other way back')
  const bind = String(secret || '').trim()
  if (bind.length < 16) throw new Error('nostrconnect: secret must be at least 16 characters — it is what binds the approval')
  const q = new URLSearchParams()
  for (const r of set) q.append('relay', r)
  q.append('secret', bind)
  if (perms && perms.length) q.append('perms', [...perms].join(','))
  if (name) q.append('name', String(name))
  if (url) q.append('url', String(url))
  if (image) q.append('image', String(image))
  return `nostrconnect://${pub}?${q.toString()}`
}

/// The `bunker://` form of a pairing that has already been approved, for storing on disk. Built
/// from what the response revealed rather than from anything typed.
export function bunkerUriFrom({ signerPubkey, relays = [], secret } = {}) {
  const pub = String(signerPubkey || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(pub)) throw new Error('nostrconnect: signerPubkey must be 64-character hex')
  const set = [...new Set((Array.isArray(relays) ? relays : [relays]).map(r => String(r || '').trim()).filter(wss))]
  if (!set.length) throw new Error('nostrconnect: a stored pairing needs at least one wss:// relay')
  const q = new URLSearchParams()
  for (const r of set) q.append('relay', r)
  if (secret) q.append('secret', String(secret))
  return `bunker://${pub}?${q.toString()}`
}

/**
 * Read one candidate response.
 *
 * Returns `null` for anything that is not addressed to this request — a relay serves whatever it
 * has, and another client's traffic on the same relay is ordinary, not suspicious. Returns a result
 * object for anything that IS addressed here, including a refusal, because "the operator declined"
 * and "nothing arrived" are different outcomes and the caller reports them differently.
 *
 * `bound` is the security-bearing field. It is true only when the response echoed the secret, and a
 * caller that writes credentials on `bound: false` has accepted a pairing from whoever answered
 * first — see the header.
 */
export function readApproval(event, { clientKey, clientPubkey, secret, decrypt = nip44.v2.decrypt } = {}) {
  if (!event || event.kind !== NIP46_KIND) return null
  const from = String(event.pubkey || '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(from)) return null
  if (!(event.tags || []).some(t => t[0] === 'p' && String(t[1]).toLowerCase() === clientPubkey)) return null
  // Untrusted input off a relay: `verifyEvent` throws on a malformed event rather than returning
  // false, and letting that escape would surface as a crash instead of "not for us".
  let valid = false
  try { valid = verifyEvent(event) } catch { valid = false }
  if (!valid) return null
  let message
  try {
    message = JSON.parse(decrypt(event.content, nip44.v2.utils.getConversationKey(clientKey, from)))
  } catch { return null }  // sealed to a different conversation, or not a NIP-46 payload
  if (message && message.error) {
    return { signerPubkey: from, bound: String(message.result || '') === String(secret), refused: true,
      error: String(message.error) }
  }
  const result = String(message && message.result != null ? message.result : '')
  if (!result) return null
  if (result === String(secret)) return { signerPubkey: from, bound: true, refused: false, result }
  // `ack` is what a signer sends when it does not implement the echo. It is a real response from a
  // real signer AND it is exactly what an impostor sends, and those are indistinguishable here. It
  // is surfaced rather than dropped so the caller can say which of the two it is refusing to
  // assume, but `bound` stays false.
  if (result === 'ack') return { signerPubkey: from, bound: false, refused: false, result }
  return null
}

/**
 * Hold the relays open until a BOUND approval addressed to this request arrives.
 *
 * Resolving on the first response would hand an observer a wedge rather than merely a detection:
 * an unbound `ack` arriving milliseconds ahead of the operator's genuine approval would win, the
 * real approval behind it would be discarded, and — since the client key is minted fresh every run
 * — the operator would re-approve straight back into it, forever (#529 review). So an unbound
 * response is recorded and the wait CONTINUES; only a bound one ends it.
 *
 * Always resolves `{ approval, unbound }`. `approval` is `null` on timeout rather than rejecting:
 * not being approved yet is an ordinary outcome of a flow that waits on a human, and the caller
 * reports it as INCONCLUSIVE (exit 3) rather than as a failure. `unbound` is what was seen and not
 * acted on, which is the difference between "nothing arrived" and "something answered and could not
 * be attributed" — being unable to check is not the same as being fine.
 */
export function awaitApproval({ relays, clientKey, secret, timeoutMs = 180000,
  Pool = SimplePool, decrypt = nip44.v2.decrypt, onEvent } = {}) {
  const clientPubkey = getPublicKey(clientKey)
  const pool = new Pool()
  return new Promise(resolve => {
    let done = false, timer
    const unbound = []
    const finish = approval => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { sub && sub.close && sub.close() } catch { /* already closed */ }
      try { pool.close(relays) } catch { /* already closed */ }
      resolve({ approval, unbound })
    }
    const sub = pool.subscribeMany(relays, { kinds: [NIP46_KIND], '#p': [clientPubkey] }, {
      onevent(event) {
        if (onEvent) onEvent(event)
        const got = readApproval(event, { clientKey, clientPubkey, secret, decrypt })
        if (!got) return
        // Including a refusal. An unbound error is attacker-controlled text, and reporting it as
        // the operator's own signer's words is exactly the attribution this module refuses to make.
        if (!got.bound) { unbound.push(got); return }
        finish(got)
      },
    })
    timer = setTimeout(() => finish(null), timeoutMs)
  })
}

/**
 * The custody proof, checked against what was ASKED — not only against the pin.
 *
 * `withPinnedCustody` verifies the returned event and compares its pubkey to the pinned key. That
 * is a weaker claim than "the responder signed this", because nothing there compares the event
 * returned against the event submitted. An impostor holding no key at all can answer `sign_event`
 * with a **scraped public note authored by the pinned identity** — every identity here publishes a
 * `kind:0` by design, so a qualifying event always exists and is always public — and it verifies,
 * and its pubkey matches, and the pin passes (#529 review).
 *
 * Elsewhere that substitution fails visibly downstream, because the signed event IS the artifact
 * being published. Here nothing is published, so it would be invisible and the conclusion drawn
 * from it printed as fact. `console/bunker-custody.mjs` compares the challenge back for the same
 * reason (#491); this is that check on the node side.
 *
 * Throws with `exitCode` 1 — a wrong event is bad input, the same class as a custody mismatch. The
 * challenge value is never printed: it is the binding secret's sibling and belongs in no log.
 */
export function assertChallengeProof(signed, { kind, challenge } = {}) {
  const tag = ((signed && signed.tags) || []).find(t => t[0] === 'challenge')
  const gotKind = Number(signed && signed.kind)
  // Two independent failures, so two independent clauses. One combined sentence reported a challenge
  // tag as wrong when only the kind was — and the operator acts on the reason, so that sends them
  // hunting a nonce mismatch that is not there (#529 review).
  const kindOk = gotKind === Number(kind)
  const tagOk = String((tag && tag[1]) || '') === String(challenge) && String(challenge || '') !== ''
  if (!kindOk || !tagOk) {
    const why = [
      kindOk ? null : `asked for kind:${kind}, got kind:${gotKind || 'none'}`,
      tagOk ? null : `the challenge tag is ${tag ? 'not the one submitted' : 'absent'}`,
    ].filter(Boolean).join(', and ')
    const e = new Error(
      `the signer returned a valid signature over a DIFFERENT event than the one it was asked to ` +
      `sign — ${why}. A signature by the right key over the wrong ` +
      'event proves the responder can fetch one of that key\'s public notes, not that it can sign.')
    e.exitCode = 1
    throw e
  }
  return signed
}

/// The client transport key, in the form `credentials/bunker-client` holds it.
export const clientNsec = clientKey => nip19.nsecEncode(clientKey)
