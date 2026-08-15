// relay_invite_signer.mjs — pick the identity a relay invite is signed with, and pin to it (#477).
//
// This lived in `tools/relay-invite.mjs` and could not be tested there. The tool is a script with
// top-level execution, so importing it runs it; the only reach a test had was spawning the command
// line, and every case a subprocess can drive uses a local key file — where the pairing address,
// the resolved identity and the pinned key are all the same value. Three mutations survived the
// full suite because of that (#478 review): pinning to `base.pubkey` instead of the resolved
// identity, and both banners naming the pairing address. Each is the exact defect this code exists
// to prevent, and none of them was a distinction the tests could make.
//
// So the decisions live here, behind injected dependencies, where a signer whose `userPubkey()`
// DIFFERS from its `pubkey` can be handed in directly. The injection is also what keeps this out of
// the egress ban's way: `src/` may not import the signer backend, so the caller brings it.
//
// The banner is built here for the same reason. It is the operator's only sight of which key is
// about to write a row that cannot be removed without it (#366), and as a bare `console.log` in the
// tool it was untestable — so getting it wrong was silent.

import * as nip19 from 'nostr-tools/nip19'
import { chooseSigningSource } from './relay_invite.mjs'

/** Exit codes, matching the tool's contract. 2 is "the signer failed", 1 is "you meant another key". */
const INPUT = 1, SIGNER = 2

/**
 * Resolve one signer for a run, or explain why not.
 *
 * @param opts   {{keyArg, uriFile, clientFile, expect, what}} — `what` names the state this run
 *               writes, so a mismatch is refused in the operator's terms rather than as hex.
 * @param deps   {{loadBunker, loadLocal, pin}} — the caller brings the signer backend.
 * @returns `{signer, identity, kind, remote}` on success. On failure `{error, code, signer?}` —
 *          `signer` is present when one was built, so the caller can close it before exiting.
 */
export async function resolveSigner({ keyArg, uriFile, clientFile, expect = '', what = 'this run' } = {}, deps = {}) {
  const { loadBunker, loadLocal, pin } = deps
  const choice = chooseSigningSource({ keyArg, uriFile, clientFile })
  if (choice.error) return { error: choice.error, code: INPUT, usage: true }

  // Shape-checked BEFORE anything is built or asked. On a bunker, resolving the identity means a
  // `connect` and a `get_public_key` — an approval tap on a fresh pairing — and making a typo cost
  // that before being told the value is malformed is a bad trade (#478 review). The COMPARISON has
  // to stay below, because there is nothing to compare against until the identity is resolved.
  const want = String(expect || '').trim().toLowerCase()
  if (want && !/^[0-9a-f]{64}$/.test(want)) {
    return { error: 'EXPECT_PUBKEY must be a 64-character hex pubkey', code: INPUT }
  }

  let base
  try { base = choice.kind === 'bunker' ? await loadBunker(uriFile, clientFile) : await loadLocal(keyArg) }
  catch (e) { return { error: `could not load the signing key: ${e.message}`, code: INPUT } }

  // ASK which identity it holds — never read it off the pairing. `bunker://<hex>` names the remote
  // SIGNER, and NIP-46 permits that key to differ from the user identity it signs with, so the hex
  // is a transport address. Pinning to it fails every signature as a custody mismatch; naming the
  // true identity in EXPECT_PUBKEY is then refused for disagreeing with the pairing. No third
  // option, and the error blames the identity rather than the assumption.
  let identity
  try { identity = String(await base.userPubkey() || '').trim().toLowerCase() }
  catch (e) { return { error: `could not establish which identity the signer holds: ${e.message}`, code: SIGNER, signer: base } }
  if (!/^[0-9a-f]{64}$/.test(identity)) {
    return { error: 'the signer did not report a usable identity, so nothing can be pinned to it', code: SIGNER, signer: base }
  }

  if (want && want !== identity) {
    // Refused before anything is signed. A claim inserts a relay_members row that cannot be removed
    // without that key's cooperation (#366), so the wrong identity here is permanent.
    return {
      error: `EXPECT_PUBKEY does not match the ${choice.kind === 'bunker' ? 'pairing' : 'key file'}:\n` +
        `  expected ${want}\n  signer is ${identity}\n` +
        `  Refusing before signing — ${what} writes state under whichever key signs.`,
      code: INPUT, signer: base,
    }
  }

  // Pinning to the RESOLVED identity when EXPECT_PUBKEY is unset is not a no-op: a bunker holding
  // several identities can answer sign_event as one it did not report here, and every signature
  // after the first is a fresh chance to. Unpinned, each signature would verify and nothing would
  // notice they came from different keys.
  return { signer: pin(base, want || identity), identity, kind: choice.kind, remote: !!base.remote }
}

/**
 * The line naming which key is about to act.
 *
 * Takes the resolved identity, never the signer — passing the signer is what let a banner print the
 * pairing's transport address, which is a key that signs nothing.
 */
export function signerBanner(verb, { identity, remote } = {}) {
  return `relay-invite: ${verb} as ${nip19.npubEncode(identity)} (${remote ? 'bunker pairing' : 'local key file'})`
}
