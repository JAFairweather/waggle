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
// Nothing here writes to storage, to a URL, or to a log. The caller is expected to hand the nsec
// straight to a download and then call `secret.forget()`.

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
      taken() { return nsec === null },
      forget() { nsec = null },
      // USE the key without yielding it. The agent has to sign its own relay-join request, and
      // routing that through `take()` would mean the page hands the nsec out — to code that only
      // needed a signature — and destroys it, so the operator can no longer save it.
      //
      // `decode` and `finalize` are injected for the same reason the mint primitives are: this
      // module holds no import of its own that a bundler could resolve differently in the two
      // places it runs. Returns null once the secret is gone, rather than throwing, because "the
      // key was already saved and cleared" is an ordinary state the caller must handle.
      sign(template, { decode, finalize }) {
        if (nsec === null) return null
        return finalize(template, decode(nsec).data)
      },
    },
  }
}

/// The bytes of the key file the operator downloads. Deliberately identical in shape to what
/// tools/mint-identity.mjs writes — one nsec, one newline, nothing else. A file that also carried
/// the npub or a comment would be a file somebody pastes somewhere whole.
export function keyFileContents(nsec) {
  if (!NSEC_RE.test(String(nsec || ''))) throw new Error('refusing to build a key file from something that is not an nsec')
  return `${nsec}\n`
}

/// A filename that says what the file is without saying whose it is. The npub is not in it: a
/// downloaded file's name survives in shells, backups and screen shares long after the file has
/// been moved, and it should not be the thing that links an identity to a machine.
export function keyFileName() {
  return 'agent.nsec'
}
