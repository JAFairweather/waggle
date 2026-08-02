// requests.mjs — read pending admission requests out of gift-wrapped DMs (#186, #141 piece 1).
//
// A session that wants in mints a key and gift-wraps a request to the maintainer. Until now the
// only way to act on one was to read the sealed DM by hand and retype the npub into `grant.mjs`.
// This module turns a wrap into a structured request the console can render and act on; the
// console owns the DOM and the signing, this owns the unwrapping and — more importantly — the
// refusing.
//
// THE GOVERNING FACT: anyone on the open network can gift-wrap a DM to any npub. Reachability is
// not authority (docs/DM_TRUST_ALLOWLIST.md). So everything this module returns is a REQUEST, from
// an UNTRUSTED stranger, whose every string field is attacker-chosen. It is rendered so a human
// can judge it. It is never a fact, and it never authorises anything on its own.
//
// Provenance is checked the way docs/CONCORD_CONSUMER.md checks an invite — by signature, never by
// decryptability. That a ciphertext opened proves only that it was addressed to us; it proves
// nothing whatever about who wrote it. The two checks that do:
//
//   1. the SEAL carries a valid signature          → the sender is a real key, not a claim
//   2. the rumor's author == the seal's signer     → the sender cannot be forged
//
// Without (2) a stranger could wrap a rumor claiming any `pubkey` it liked and the console would
// render someone else's identity as the asker. NIP-59 puts the outer wrap under a throwaway key
// on purpose, so the wrap's own pubkey means nothing and is deliberately NOT used for identity.

export const KIND = { wrap: 1059, seal: 13, dm: 14, nvoyMsg: 24440 }

// Both shapes are accepted, and this is the point of #186 rather than an accident of history:
// nvoy's console lists anything with `type: 'access_request'` (a 24440 rumor), while waggle's own
// tool emitted `waggle_admission_request` (a NIP-17 kind:14 rumor). Reading both here is what lets
// ONE request event surface in BOTH consoles — the dual-surface approval, with no coordination
// needed beyond agreeing on a vocabulary.
const REQUEST_TYPES = new Set(['access_request', 'waggle_admission_request'])

const HEX64 = /^[0-9a-f]{64}$/i

/** Decode an npub or 64-hex key to hex, or null. Never throws — this parses hostile input. */
export function toHexKey(v, decodeNpub) {
  const s = String(v ?? '').trim()
  if (HEX64.test(s)) return s.toLowerCase()
  if (s.startsWith('npub1') && decodeNpub) {
    try { const d = decodeNpub(s); return d && d.type === 'npub' ? d.data : null } catch { return null }
  }
  return null
}

/**
 * Turn one 1059 gift wrap into a pending request, or null if it is not one / does not hold up.
 *
 * @param wrap        the 1059 event as it came off the relay
 * @param deps.decrypt   (senderPubkey, ciphertext) => Promise<string> — the signer's nip44 decrypt
 * @param deps.verifyEvent  (event) => boolean — real signature verification, not a stub
 * @param deps.decodeNpub   (npub) => {type,data} — nip19.decode, for the `npub` body field
 *
 * Returns { id, from, grantee, channel, cap, purpose, at, granteeIsSender } or null.
 * Rejection is silent by design: a malformed or forged wrap is not an error the operator can act
 * on, and surfacing every stranger's junk as a failure is how a real request gets lost in noise.
 * (Counting is the caller's job — see readRequests, which reports what it skipped.)
 */
export async function parseRequest(wrap, deps) {
  const { decrypt, verifyEvent, decodeNpub } = deps
  if (!wrap || wrap.kind !== KIND.wrap || typeof wrap.content !== 'string') return null

  let seal
  try { seal = JSON.parse(await decrypt(wrap.pubkey, wrap.content)) } catch { return null }
  if (!seal || seal.kind !== KIND.seal) return null

  // CHECK 1 — the seal's signature. This is the sender's identity, and the only thing that
  // establishes it. A seal that does not verify is discarded whole.
  if (!verifyEvent(seal)) return null

  let rumor
  try { rumor = JSON.parse(await decrypt(seal.pubkey, seal.content)) } catch { return null }
  if (!rumor || typeof rumor.content !== 'string') return null

  // CHECK 2 — the rumor's author must BE the seal's signer. A rumor is unsigned by design, so its
  // `pubkey` field is a claim; this is what turns the claim into a fact. Drop the mismatch rather
  // than rendering it, because a rendered mismatch is an impersonation with a UI around it.
  if (rumor.pubkey !== seal.pubkey) return null
  if (rumor.kind !== KIND.dm && rumor.kind !== KIND.nvoyMsg) return null

  let body
  try { body = JSON.parse(rumor.content) } catch { return null }
  if (!body || !REQUEST_TYPES.has(body.type)) return null
  if (typeof body.purpose !== 'string' || !body.purpose.trim()) return null

  // The key to be admitted. It defaults to the sender — the ordinary case, a session asking for
  // itself. A body naming a DIFFERENT key is a request to admit a third party, which is a
  // materially different thing to approve: the asker is not the beneficiary. We keep it, because
  // refusing outright would silently drop a legitimate flow (a runtime raising a request on an
  // agent's behalf, exactly nvoy's owner_npub extension) — but we FLAG it, and the console says so
  // in words, because an operator who thinks they are admitting the asker is being misled.
  const claimed = body.npub !== undefined ? toHexKey(body.npub, decodeNpub) : null
  if (body.npub !== undefined && !claimed) return null      // present but malformed: not renderable
  const grantee = claimed || rumor.pubkey

  return {
    id: String(wrap.id || ''),
    from: rumor.pubkey,
    grantee,
    granteeIsSender: grantee === rumor.pubkey,
    channel: typeof body.channel === 'string' ? body.channel : null,
    cap: body.cap === 'task' || body.cap === 'task+act' ? body.cap : 'admit',
    purpose: body.purpose,
    at: Number.isFinite(rumor.created_at) ? rumor.created_at : Number(wrap.created_at) || 0,
  }
}

/**
 * Parse a batch of wraps. Returns { requests, skipped, failed } — newest first.
 *
 * `skipped` and `failed` are reported, never swallowed. A console that shows "0 pending" after
 * silently failing to decrypt 40 wraps has told the operator the opposite of the truth, which is
 * the failure mode nvoy's own notice reader carries a comment about. Same rule as the rest of this
 * repo: being unable to check is not the same as being fine.
 */
export async function readRequests(wraps, deps) {
  const requests = []
  let skipped = 0, failed = 0
  for (const w of wraps || []) {
    let r = null
    try { r = await parseRequest(w, deps) } catch { failed++; continue }
    if (r) requests.push(r); else skipped++
  }
  requests.sort((a, b) => b.at - a.at)
  return { requests, skipped, failed }
}
