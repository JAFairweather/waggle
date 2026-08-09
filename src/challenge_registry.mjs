// challenge_registry.mjs — issue a nonce, consume it exactly once, refuse it ever after.
//
// WHY THIS EXISTS. `src/agent_challenge.mjs` (#311) verifies that a response is correctly signed
// by the key it claims — and is deliberately stateless, so it cannot tell a first use from a
// replay. Its own header names the hazard: kind 27492 is in the ephemeral range, relays broadcast
// it, so within the TTL anyone who observes a response can present it as proof on their own
// connection. The defence was a CALLER OBLIGATION comment, which was fine while there were no
// callers.
//
// Join is the first caller (docs/DESIGN_JOIN.md), so the obligation becomes code here. My Dude's
// review of #311 asked for exactly this shape: `issue -> verify-consumes -> second verify refuses`.
//
// The DM approval path needs the same guarantee for the same reason. An approval reply is a
// signed message on a relay; if it can be replayed, "approve once" is not a thing the owner did.
// So this is written as a general single-use nonce registry rather than a challenge-only one.
//
// WHAT IT IS NOT. It is not a store, and it is not durable. The caller supplies the map. An
// in-memory Map is right for a challenge that lives for seconds; a join request that must survive
// a restart needs a persistent store passed in, and `entries()`/`delete()` are all this needs from
// it. Nothing here writes a file, so nothing here can fail to.

const HEX64 = /^[0-9a-f]{64}$/

// Nonces are 32 bytes of CSPRNG, rendered as the same 64-hex shape every id in this estate uses.
// Guessability is the whole game: the id is what proves the holder saw the message it was minted
// for, so it must not be derived from a timestamp, a counter, or anything an observer can predict.
function mintId() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * @param {object}   [opts]
 * @param {number}   [opts.ttlSecs]  how long an issued nonce stays consumable
 * @param {Map}      [opts.store]    Map-compatible; supply a durable one to survive a restart
 * @param {function} [opts.now]      seconds-resolution clock, injectable so tests need no sleeps
 */
export function createChallengeRegistry({ ttlSecs = 300, store = new Map(), now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!Number.isFinite(ttlSecs) || ttlSecs <= 0) throw new Error('ttlSecs must be a positive number')

  // Expiry is enforced on read, not by a timer. A timer would make correctness depend on the
  // process staying alive, and this registry's entire job is to be right about something that
  // happened before a restart.
  const live = (record, at) => record && at < record.expiresAt

  return {
    /**
     * Mint a single-use nonce bound to a subject. The subject is whatever the consumer must match
     * — an agent pubkey for a challenge, a request id for an approval. Binding it here is what
     * stops a nonce minted for one purpose being spent on another.
     */
    issue(subject, detail = null) {
      if (typeof subject !== 'string' || subject === '') throw new Error('a challenge must be bound to a non-empty subject')
      const at = now()
      const id = mintId()
      const record = { id, subject, detail, issuedAt: at, expiresAt: at + ttlSecs }
      store.set(id, record)
      return record
    },

    /**
     * Spend a nonce. Returns `{ ok: true, record }` on the FIRST correct use and
     * `{ ok: false, reason }` on every other call — unknown, expired, wrong subject, or replayed.
     *
     * The consume is unconditional once the id is known to exist: a wrong-subject attempt burns
     * the nonce rather than leaving it for another try. A nonce that survives a failed attempt is
     * an oracle — an attacker learns "wrong subject" and keeps guessing on the same id.
     */
    consume(id, subject) {
      if (typeof id !== 'string' || !HEX64.test(id)) return { ok: false, reason: 'malformed challenge id' }
      const record = store.get(id)
      if (!record) return { ok: false, reason: 'unknown or already-used challenge' }
      store.delete(id)
      if (!live(record, now())) return { ok: false, reason: 'expired challenge' }
      if (record.subject !== subject) return { ok: false, reason: 'challenge was issued for a different subject' }
      return { ok: true, record }
    },

    /** Drop expired records. Purely housekeeping — `consume` already refuses them. */
    sweep() {
      const at = now()
      let dropped = 0
      for (const [id, record] of [...store.entries()]) if (!live(record, at)) { store.delete(id); dropped++ }
      return dropped
    },

    /** Outstanding records, expired ones included. For diagnostics; never a decision input. */
    size: () => store.size,
  }
}
