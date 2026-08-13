// pow_targets.mjs — what each relay has actually asked us for, and what to mine to (#346).
//
// `pow.mjs` says where the target comes from: "remembered from the last refusal that relay gave".
// Nothing remembered it. `relay_refusals.mjs` keeps the last reason per relay for reporting, but a
// reason is prose and a target is a number, and the difference is that one of them can be mined to.
//
// The rule this module exists to apply: PROOF-OF-WORK IS MONOTONE. An id with 16 leading zero bits
// also has 12 and 8, so one wrap mined to the highest demand satisfies every relay at or below it.
// That is what makes a single mine correct for a fan-out to relays with different demands — and it
// is the reason an over-cap relay must not be allowed to raise the target: it would double the cost
// per bit for a relay that is going to refuse anyway, and starve the ones we could have satisfied.
//
// Pure and injectable — no clock, no sockets, no files. It is fed the same `{relay, accepted,
// reason}` records the refusal ledger already sees.

import { POW_CAP, powTargetFromRefusal } from './pow.mjs'

export function powTargets({ cap = POW_CAP, maxRelays = 64 } = {}) {
  const demands = new Map()   // relay -> bits that relay last demanded

  return {
    /// Learn from one relay's answer. Only a proof-of-work REFUSAL teaches anything.
    ///
    /// An accept deliberately does NOT clear the demand. It is tempting — the relay took it, so
    /// surely it wants nothing — but the accept is very likely BECAUSE we mined, and forgetting on
    /// success would send the next wrap bare, collect a fresh refusal, and mine again: one refused
    /// message per send, forever, with the log reading as if the relay were flapping. A demand is
    /// lowered or replaced only by the relay saying a different number.
    record({ relay, accepted, reason } = {}) {
      const url = String(relay || '')
      if (!url || accepted) return null
      const target = powTargetFromRefusal(reason)
      if (target === null) return null       // refused for some other reason — not ours to act on
      // Insertion-ordered eviction, matching the refusal ledger: a full map must not make a newly
      // seen relay invisible, which would hide the relay nobody has data on yet.
      if (!demands.has(url) && demands.size >= maxRelays) demands.delete(demands.keys().next().value)
      demands.set(url, target)
      return target
    },

    /// What one relay last demanded, or null.
    demandFor(relay) {
      const v = demands.get(String(relay || ''))
      return Number.isInteger(v) ? v : null
    },

    /// What to mine a single wrap to, for a fan-out to `relays`.
    ///
    /// Returns `{ target, satisfies, overCap, unknown }`, where `target` is null when there is
    /// nothing worth mining to. The three lists are the point: a caller that logs only the target
    /// cannot say which relays it just decided to fail, and #346 asks for the cap firing to be
    /// visible rather than inferred from a missing message.
    ///
    ///   satisfies — relays whose demand this target meets
    ///   overCap   — relays demanding more than the ceiling. They will refuse, on purpose, and
    ///               that is cheaper than the mine (16 bits ~3s here, 20 ~58s, each bit doubling).
    ///   unknown   — relays that have never refused for proof-of-work. Mining does not hurt them:
    ///               a nonce tag is ignorable, and no relay refuses an event for having MORE work.
    targetFor(relays = []) {
      const list = [...new Set((relays || []).map(r => String(r || '')).filter(Boolean))]
      const satisfies = [], overCap = [], unknown = []
      let target = null
      for (const url of list) {
        const want = this.demandFor(url)
        if (want === null) { unknown.push(url); continue }
        if (want > cap) { overCap.push(url); continue }
        satisfies.push(url)
        if (target === null || want > target) target = want
      }
      // Monotonicity is what lets one number stand for the whole list: everything in `satisfies`
      // demanded at most `target`, so all of them are met by the single mine.
      return { target, satisfies, overCap, unknown, cap }
    },

    /// For logging and tests. A copy, so a caller cannot edit the memory by holding it.
    snapshot() { return [...demands].map(([relay, target]) => ({ relay, target })) },
  }
}
