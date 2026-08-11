// Minting an agent's identity from the console, so inviting one does not require a terminal.
//
// The rule here is the estate's existing one, not a new one: **the agent never generates its own
// key.** An installer that asks an agent for its own key has taught it that being asked is normal
// (tools/mint-identity.mjs says the same thing, for the same reason). So the operator's machine
// mints, and the operator seats the secret into the runtime.
//
// What this module is careful about is the interval in which the secret exists. Two properties,
// and both are enforced rather than documented:
//
//   1. The public half and the private half are DIFFERENT objects. Everything the page renders,
//      copies into a grant, or puts in the DOM comes from `display` — which has no field that
//      could carry the secret, so a future edit cannot accidentally paint one on screen.
//   2. The private half is take-once. `secret.take()` yields the nsec exactly once and then
//      yields null forever. "Shown once" stops being a convention that the next edit can break.
//
// PEEK VS TAKE, and why both exist (#367). The key now goes into a BUNKER, and the page must prove
// the bunker has it before letting go — a proof that can fail, and must therefore be retryable.
// `peek()` is what the enrolment step uses: it shows the secret without spending it. `take()` is
// called exactly once, on a PROVEN custody check. An earlier flow called take() at the moment of
// download, which meant a blocked or discarded download destroyed the only copy while reporting
// success. Spending the secret on an ATTEMPT rather than on an OUTCOME was the whole defect.
//
// Nothing here writes to storage, to a URL, or to a log. There is deliberately no longer a
// key-file helper: a file on disk is the thing that gets lost, and under cooperative relay
// revocation a lost key is a relay member nobody can ever remove.

const NSEC_RE = /^nsec1[0-9a-z]{20,90}$/
const HEX64_RE = /^[0-9a-f]{64}$/

/// Mint a fresh identity. The four crypto primitives are injected so this module can be tested in
/// node against the same vendored bundle the page loads, and so it holds no import of its own that
/// a bundler could resolve differently in the two places.
export function mintAgentKey({ generateSecretKey, getPublicKey, nsecEncode, npubEncode }) {
  const sk = generateSecretKey()
  const pubkeyHex = String(getPublicKey(sk)).toLowerCase()
  if (!HEX64_RE.test(pubkeyHex)) throw new Error('minting produced something that is not a 64-character hex pubkey — refusing to hand it on')
  const npub = npubEncode(pubkeyHex)
  let nsec = nsecEncode(sk)
  if (!NSEC_RE.test(String(nsec))) throw new Error('minting produced something that is not an nsec — refusing to hand it on')

  return {
    // Safe to render, to log, to paste into a grant. There is deliberately no secret field here.
    display: Object.freeze({ npub, pubkeyHex }),
    secret: {
      // Take-once. A second caller gets null, not a copy — which is what makes "you are shown this
      // once" a property of the object rather than a promise made in the copy on screen.
      take() { const v = nsec; nsec = null; return v },
      // Read WITHOUT spending. The enrolment step needs the secret on screen while the custody
      // proof runs, because a proof that fails has to leave something to retry with.
      peek() { return nsec },
      taken() { return nsec === null },
      forget() { nsec = null },
    },
  }
}

