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
// WHAT IT IS NOT. It is not a store, and it is not durable. The caller supplies the map. Nothing
// here writes a file, so nothing here can fail to.
//
// THE STORE MUST BE SYNCHRONOUS, and the previous version of this comment was wrong about that in
// a way that destroyed data. It invited "a persistent store passed in" and said `entries()` and
// `delete()` were all it needed. Both were false. Every durable store is async, and an async
// `get` returns a Promise — which is truthy, so it passes the existence check, `delete` fires, and
// `at < undefined` is false, so the FIRST consume of a LIVE nonce deletes the record and reports
// `expired challenge`. Silent, and it fails in the direction of destroying state. It also needs
// `get`, `set` and `size`, so an operator implementing to that sentence got a TypeError.
//
// A store is now probed at construction and refused if it is async. To survive a restart, put a
// SYNCHRONOUS write-through facade over the durable thing — load into a Map at boot, persist on
// `set`/`delete` — rather than handing this an async map.

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
const isThenable = (v) => !!v && typeof v.then === 'function'

export function createChallengeRegistry({ ttlSecs = 300, store = new Map(), now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!Number.isFinite(ttlSecs) || ttlSecs <= 0) throw new Error('ttlSecs must be a positive number')
  for (const method of ['get', 'set', 'delete', 'entries']) {
    if (typeof store[method] !== 'function') throw new Error(`store must implement ${method}()`)
  }
  // Probe once, at construction, on a key that cannot exist. Cheaper than guessing, and it fails
  // here — before a nonce exists to destroy — rather than on the first real consume.
  // Any non-hex key is safe: every id this registry issues is 64-hex, so this cannot collide.
  if (isThenable(store.get('__async-probe__'))) {
    throw new Error('store must be synchronous — an async store silently destroys a live nonce on first consume (see header)')
  }

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
      if (isThenable(record)) throw new Error('store must be synchronous — refusing to delete a record read from an async store')
      if (!record) return { ok: false, reason: 'unknown or already-used challenge' }
      store.delete(id)
      if (!live(record, now())) return { ok: false, reason: 'expired challenge' }
      if (record.subject !== subject) return { ok: false, reason: 'challenge was issued for a different subject' }
      return { ok: true, record }
    },

    /**
     * Spend a nonce whose authority the caller has ALREADY established by other means.
     *
     * `consume` is for the open-presenter case: `src/agent_challenge.mjs` is reachable by anyone,
     * so the subject binding is the gate and burning on a mismatch denies a guessing attacker.
     *
     * Join is the opposite shape. `authorizeJoinReply` proves the sender is an approver BEFORE it
     * reaches the registry, so a subject check here is redundant — and destructive when the two
     * disagree, which they do as soon as there is more than one approver. Passing an approver as
     * the subject meant a legitimate second approver's byte-exact reply burned the request and
     * refused everyone, naming a concept the operator never configured. Found in review; every
     * test had a one-element approver list whose single member WAS the registry subject, so the
     * two values were the same constant and could never disagree.
     *
     * This is a separate method rather than an optional argument on purpose: an argument that can
     * be omitted turns "I established authority elsewhere" into "I forgot", and those must not
     * look alike at a call site.
     */
    spend(id) {
      if (typeof id !== 'string' || !HEX64.test(id)) return { ok: false, reason: 'malformed challenge id' }
      const record = store.get(id)
      if (isThenable(record)) throw new Error('store must be synchronous — refusing to delete a record read from an async store')
      if (!record) return { ok: false, reason: 'unknown or already-used challenge' }
      store.delete(id)
      if (!live(record, now())) return { ok: false, reason: 'expired challenge' }
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
