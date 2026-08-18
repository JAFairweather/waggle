// notify_only.mjs — the keyless half of a wake.
//
// A watcher that opens sealed mail has to hold the agent's signer. That is why every watcher this
// project runs today sits on a machine we control, and it is the whole reason an agent on a host we
// do not control has never been woken: putting the bunker pairing on that host is the one thing the
// runtime handoff forbids ("the watcher, adapter, MCP client, model session, workstation, Waggle,
// and worker receive neither the nsec nor the Bunker capability").
//
// Notify-only splits the wake from the read. Subscribing to `{kinds:[1059], '#p':[self]}` needs no
// key at all — the p-tag is public — so a keyless watcher can learn THAT mail arrived and say so.
// What it cannot learn is anything else, and the record it emits has to be honest about that.
//
// ── What is unknowable without the key, and why the record says so out loud ─────────────────────
//
// `tools/agent-inbox.mjs:192`: the outer 1059 wrap is signed by a throwaway ephemeral key that says
// nothing about who wrote the message. Authorship is the SEAL's signature, one layer in, and
// reading it is a decrypt. So notify-only cannot evaluate `--trust`, cannot name an author, and
// cannot tell the bridge carrier from a stranger.
//
// That makes the wake ADVISORY. `mayAct` is false on every record this module emits, and it is
// false as a fact rather than as a default: an adapter that treats a notify-only wake as authority
// has been handed a trigger by anyone who can seal a wrap to a public key, which under NIP-59 is
// everyone. The trust gate does not disappear; it moves to whoever holds the key and does the pull.
//
// `trust_evaluated: false` is a separate key from `mayAct` on purpose. An adapter reading only
// `mayAct:false` cannot tell "we checked and this sender may not act" from "we could not check".
// Those are different states and the second is the one that means: go and pull.
//
// ── Why arrivals are coalesced ─────────────────────────────────────────────────────────────────
//
// Anyone may seal a wrap to a public key. With the trust gate moved to the pull, an ungated wake is
// a remote way to burn an agent's turns — the flood arriving through the correct gate. A wake is
// content-free, so "you have mail" does not need a count and N arrivals inside one window can share
// one wake. That caps the cost of any flood at a constant without dropping anything.
//
// THE WAKE IS COALESCED. THE RECORD NEVER IS. Every arrival gets its own durable record, because the
// dedupe claim that suppresses a replay is made per arrival — so a suppressed RECORD would leave an
// id claimed forever with nothing on disk to show for it, and that message would never be delivered
// again by anything. That is not a missed alarm, it is silent loss, which is the failure this file
// is otherwise written to prevent. Found by running the tool against real relays rather than by
// reasoning about it: 197 arrivals produced 197 durable claims and ONE record. The coalescer
// conserved correctly and the caller did not, which is why the suite drives the caller's loop and
// not only the primitive.

/**
 * Coalesce arrivals into at most one wake per window.
 *
 * THE PROPERTY THAT MATTERS IS CONSERVATION, not the rate. A coalescer that loses an arrival is
 * strictly worse than one that fires too often: too many wakes cost turns, a lost one costs a
 * message and looks exactly like a quiet lane. So every `offer` is counted into exactly one fire —
 * either the one it triggers or a later `flush` — and `pending()` is the outstanding balance.
 *
 * Time is an argument rather than a call to `Date.now()` so a suite can drive the window edges
 * exactly. The caller owns the timer; this owns the decision.
 */
export function makeCoalescer({ windowMs = 30_000 } = {}) {
  if (!Number.isFinite(windowMs) || windowMs < 0) throw new Error('windowMs must be a non-negative finite number')
  let lastFire = null
  let pending = 0
  return {
    /** An arrival. Returns `{ fire, count }`; `count` is how many arrivals that wake speaks for. */
    offer(now) {
      pending += 1
      // `lastFire === null` is the first arrival ever, which always fires — a watcher that stayed
      // silent through its own first message would be indistinguishable from one that is not running.
      if (lastFire === null || now - lastFire >= windowMs) {
        const count = pending
        pending = 0
        lastFire = now
        return { fire: true, count }
      }
      return { fire: false, count: 0 }
    },
    /**
     * The end of a window with arrivals suppressed inside it. Emits ONE wake for all of them.
     * Returns `{ fire:false, count:0 }` when there is nothing outstanding, so a timer that runs on a
     * quiet lane does not manufacture wakes.
     */
    flush(now) {
      if (pending === 0) return { fire: false, count: 0 }
      const count = pending
      pending = 0
      lastFire = now
      return { fire: true, count }
    },
    /** Arrivals seen but not yet spoken for. The suite asserts this reaches zero. */
    pending: () => pending,
  }
}

/**
 * The record a keyless watcher emits, as an object. Serialise with `JSON.stringify`.
 *
 * The two gates are deliberately the SAME two `wakeVerdict` applies in the keyed path, and the
 * suite asserts they agree rather than trusting that they were copied correctly:
 *
 *   firstSeen !== true  -> already delivered, nobody is woken again
 *   bootstrap === true  -> a first start's history is recorded, not announced
 *
 * The third gate `wakeVerdict` applies — the trust list — has no counterpart here, because there is
 * nothing to apply it to. That absence is the field `trust_evaluated`.
 */
export function notifyOnlyRecord({ id = null, receivedAt = null, firstSeen = true, live = null, bootstrap = false, arrivals = 1, coalesced = false } = {}) {
  const wrapId = typeof id === 'string' && id ? id : null
  const seenAt = Number.isSafeInteger(receivedAt) ? receivedAt : null
  const count = Number.isSafeInteger(arrivals) && arrivals > 0 ? arrivals : 1

  let wake = true
  let wakeReason = count > 1
    ? `${count} wraps addressed to this key arrived; their senders are unreadable without the signer`
    : 'a wrap addressed to this key arrived; its sender is unreadable without the signer'
  // COALESCED IS A RECORD THAT WAS WRITTEN AND DID NOT WAKE, and it is a distinct state from the two
  // gates below rather than a third way of saying "no". The arrival is on disk, it is not lost, and
  // a wake inside the same window speaks for it. Collapsing this into `first_seen:false` would tell
  // a reader the message had already been delivered, which is a different and false claim.
  if (coalesced === true) {
    wake = false
    wakeReason = 'recorded, and coalesced into another wake in the same window — the arrival is not lost, only the second alarm'
  }
  if (firstSeen !== true) {
    wake = false
    wakeReason = 'already delivered — no durable first-seen claim was made for this id, so nobody is woken again'
  } else if (bootstrap === true) {
    wake = false
    wakeReason = 'seeding the dedupe index on a first start — this history is recorded, not announced'
  }

  return {
    ok: true,
    mode: 'notify-only',
    id: wrapId,
    received_at: seenAt,
    first_seen: firstSeen === true,
    live: typeof live === 'boolean' ? live : null,
    bootstrap: bootstrap === true,
    coalesced: coalesced === true,
    arrivals: count,
    wake,
    wake_reason: wakeReason,
    // NOT A DEFAULT. Nothing in this path read the seal, so no sender was authenticated and the
    // trust list was never consulted. An adapter that acts on this record acts on an unauthenticated
    // trigger.
    trust_evaluated: false,
    mayAct: false,
    disposition: 'unopened',
    // The p-tag matched, which is the only thing "for me" can mean without opening anything.
    forMe: true,
    author: null,
    content: '',
    reason: 'notify-only: the wake says mail arrived. Pull it with a signer to learn from whom, and apply the trust list there.',
  }
}
