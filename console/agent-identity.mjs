// Which key the invite/name/inbox steps are acting for — and there are two entirely different
// answers, which is why this is a module rather than an `if` in a click handler.
//
//   1. A key this page just minted and still holds. It signs from memory, once, and the operator
//      must save it before it is gone. That is the flow for a brand-new agent.
//   2. A key that already exists and lives behind its own NIP-46 bunker. MC Claude and DJ Codex are
//      this: standing identities whose secret has never been in a browser and must not start now.
//      There is nothing to save, and offering to save it would be offering something impossible.
//
// Everything downstream — `letOntoRelay`, `publishProfile`, `publishDmInbox` — takes a `sign`
// function and a pubkey and does not care which of these produced them. So the whole difference is
// resolved here, in one place, and the panel asks this module rather than inspecting either object.
//
// THE ONE RULE THAT MUST NOT BEND: a minted key that has been saved and cleared is NOT an identity
// this page can act for. It cannot sign, and the failure would otherwise surface three calls later
// as an unexplained null. `agentIdentity` returns null for it, so the panel refuses up front.

/// The identity currently in hand, or null if there is none that can sign.
///
/// `minted` is the object from `mintAgentKey`; `signer` is a connected NIP-46/NIP-07 signer paired
/// to an agent's own key. When both are present the SIGNER wins: an operator who has deliberately
/// connected a standing identity's bunker is telling us which key they mean, and silently acting
/// for a stale minted key instead would sign as the wrong agent while looking correct.
export function agentIdentity({ minted = null, signer = null, signerPubkey = null, crypto: c = {} } = {}) {
  const { decode, finalize, npubEncode } = c

  if (signer) {
    const pk = String(signerPubkey || '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pk)) return null
    return {
      source: 'signer',
      pubkeyHex: pk,
      npub: npubEncode ? npubEncode(pk) : null,
      // Nothing to save, and nothing this page could save even if asked: the key is in the bunker.
      holdsSecret: false,
      sign: (template) => signer.signEvent(template),
    }
  }

  if (minted && !minted.secret.taken()) {
    return {
      source: 'minted',
      pubkeyHex: minted.display.pubkeyHex,
      npub: minted.display.npub,
      holdsSecret: true,
      sign: (template) => {
        const signed = minted.secret.sign(template, { decode, finalize })
        // Between the check above and this call the operator may have hit save. Fail loudly rather
        // than handing null to a publisher that will report it as some other kind of refusal.
        if (!signed) throw new Error('the key is no longer in this page — it was saved and cleared, so it can no longer sign for itself')
        return signed
      },
    }
  }

  return null
}

/// Why there is nothing to act for. The panel shows this instead of guessing, because "make a key
/// first" and "that key has already been saved" send the operator to completely different places.
export function whyNoIdentity({ minted = null, signer = null } = {}) {
  if (signer) return 'That signer did not report a usable public key, so nothing can be signed for it.'
  if (!minted) return 'Make a key first, or connect the signer of a key that already exists.'
  if (minted.secret.taken()) {
    return 'That key has already been saved and cleared from this page, so it can no longer sign for itself. '
      + 'Make a new one and do these steps before saving it — or connect its signer, if it has one.'
  }
  return 'No key in hand.'
}
