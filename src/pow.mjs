// NIP-13 proof-of-work: counting it, committing to it, and refusing to do too much of it (#346).
//
// A relay that demands proof-of-work drops out of the fan-out silently. nos.lol has been doing
// exactly that since 2026-08-08, refusing every sealed wrap with `pow: 28 bits needed. (12)`. This
// module is the arithmetic half of answering that: what a difficulty IS, how to reach one, and —
// the part that matters most on a 1-vCPU box — when to say no.
//
// WHY THERE IS NO "MINE THE EVENT WE ALREADY SENT" FUNCTION HERE.
// The obvious shape is: publish, see the refusal, mine, retry. It cannot be built. `sealAndWrap`
// signs the wrap with `const wsk = generateSecretKey()` and drops it on return — deliberately, since
// that is what keeps sealed traffic off the wire under the poster key. Mining adds a tag, a tag
// changes the id, and a changed id invalidates the signature. Re-signing needs a key that no longer
// exists, and re-SEALING produces a different event with a different id while journalSend,
// markRelaySeen, markLatency and the dedup stores all still hold the first one.
//
// So mining happens BEFORE the event is signed, to a target the caller already knows — remembered
// from the last refusal that relay gave (#374/#375). The cost is one refused message per relay per
// target change, paid once and visible in the journal. That is why this module exports
// `powTargetFromRefusal` alongside the miner: the refusal string is where the target comes from.
//
// WHERE THE CAP NUMBER COMES FROM, and why it is 16 rather than the 20 first proposed in #346.
//
// Cost is linear in payload size, and it cannot be avoided: NIP-01 serialises as
// `[0, pubkey, created_at, kind, tags, content]`, so the nonce sits BEFORE the content and every
// nonce re-hashes the whole event. There is no midstate to reuse. Measured here, same difficulty,
// three runs each, on this Mac:
//
//     200B payload   334,562 nonces/sec
//    1000B payload   137,651
//    3000B payload    58,749
//    8700B payload    22,066      <- a real waggle wrap; the last live send was 8701B
//
// A 15x collapse across the range. #346's proposed 20-bit cap came from a table measured on a
// ~3KB event, and at our actual size it does not hold: 2^20 nonces at 22k/sec is ~48s expected,
// and a direct run took 57.6s. On this Mac. The droplet is roughly 5x slower by #345's own
// comparison, which puts 20 bits near four minutes there — an outage, not a cost.
//
// So 16 bits: ~3s measured here, extrapolating to ~15s on the droplet. That still needs to be off
// the event loop, which is why the caller runs this in a worker. The cap is not a tuning knob.

import { Worker } from 'node:worker_threads'
import { getEventHash } from 'nostr-tools/pure'

/// The ceiling. Above this we do not mine — we publish without proof-of-work and let the relay
/// refuse, which is the honest outcome and a logged one. nos.lol's 28 sits deliberately above it.
export const POW_CAP = Number(process.env.POW_CAP || 16)

/// Leading zero BITS of an event id — NIP-13's difficulty. Bits, not hex characters: `0x0f` is four
/// leading zeroes and one nibble, and counting nibbles would under-report by up to three bits on
/// every id, which is the difference between committing to a target and lying about one.
export function powDifficulty(idHex) {
  const id = String(idHex || '')
  if (!/^[0-9a-f]{64}$/i.test(id)) return -1        // not an id; -1 so it can never read as "0 bits, fine"
  let bits = 0
  for (let i = 0; i < 64; i++) {
    const nibble = parseInt(id[i], 16)
    if (nibble === 0) { bits += 4; continue }
    // Math.clz32 counts leading zeroes in 32 bits; a nibble's own leading zeroes are that minus 28.
    return bits + (Math.clz32(nibble) - 28)
  }
  return bits
}

/// Parse a relay's refusal for the difficulty it is asking for, or null when this is not a
/// proof-of-work refusal at all.
///
/// Returning null for everything else is the whole job. A parser that guessed a target from an
/// unrelated refusal would set the bridge mining against a relay that blocked it for some completely
/// different reason — burning the box's only core on an event that will be refused anyway.
export function powTargetFromRefusal(reason) {
  const s = String(reason ?? '').toLowerCase()
  if (!/\bpow\b|proof.of.work|difficulty/.test(s)) return null
  // The FIRST number outside brackets. nos.lol says `pow: 28 bits needed. (12)` where 28 is the
  // demand and (12) is what this event happened to have — taking the wrong one would mine to a
  // target the relay never asked for and commit to it in the tag.
  const outside = s.replace(/\([^)]*\)/g, ' ')
  const m = outside.match(/(\d+)\s*bits?/) || outside.match(/(\d+)/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 && n <= 256 ? n : null
}

/// The event with its NIP-13 nonce tag set. Replaces any existing one rather than appending: two
/// nonce tags is an event a relay may reject outright, and it would also make the committed target
/// ambiguous.
export function withNonceTag(event, nonce, target) {
  const tags = (event.tags || []).filter(t => t?.[0] !== 'nonce')
  tags.push(['nonce', String(nonce), String(target)])
  return { ...event, tags }
}

/// Mine an UNSIGNED event template to `target` bits, synchronously.
///
/// Returns `{ mined: true, event, achieved, target, iterations }` — where `achieved >= target`
/// always, and the committed target in the tag is what was asked for, never what was reached. A tag
/// claiming difficulty the id does not have is worse than no proof-of-work at all, because a relay
/// may ban on it.
///
/// Returns `{ mined: false, code, reason, target }` and NEVER a partially-mined event. `code` is
/// one of:
///   over_cap        — the ask is above POW_CAP. Not a failure to mine; a refusal to try.
///   exhausted       — the iteration budget ran out. Possible at any difficulty; more likely high.
///   already_signed  — the template carries a `sig`. Mining it would invalidate that signature, and
///                     returning a broken event would be far worse than refusing.
///   bad_target      — the target is not a usable number of bits.
export function mineSync(template, target, { cap = POW_CAP, maxIterations = 1 << 24 } = {}) {
  const t = Number(target)
  if (!Number.isInteger(t) || t <= 0) {
    return { mined: false, code: 'bad_target', target, reason: `${target} is not a number of bits to mine to` }
  }
  if (template?.sig) {
    return { mined: false, code: 'already_signed', target: t,
      reason: 'this event is already signed — adding a nonce would change its id and invalidate the signature. Mine the template, then sign it.' }
  }
  if (t > cap) {
    return { mined: false, code: 'over_cap', target: t,
      reason: `${t} bits is above the ${cap}-bit ceiling — refusing to mine. On a real 8.7KB wrap this machine manages ~22k nonces/sec, so each extra bit DOUBLES the cost: 16 bits ~3s, 20 bits ~58s, and the bridge droplet is roughly 5x slower again. Publishing without proof-of-work and being refused is the cheaper honest outcome (#346).` }
  }
  for (let nonce = 0; nonce < maxIterations; nonce++) {
    const candidate = withNonceTag(template, nonce, t)
    const id = getEventHash(candidate)
    const achieved = powDifficulty(id)
    if (achieved >= t) {
      // `id` is set here for the caller's benefit only; finalizeEvent recomputes it. The tags are
      // what carry the work, and they are what must survive into the signature.
      return { mined: true, event: { ...candidate, id }, achieved, target: t, iterations: nonce + 1 }
    }
  }
  return { mined: false, code: 'exhausted', target: t,
    reason: `no nonce below ${maxIterations} reached ${t} bits — the budget ran out, not the difficulty` }
}

/// Mine on a worker thread. Same contract as `mineSync` — same result shapes, same codes — with the
/// hashing off the thread that carries messages (#346).
///
/// The cheap refusals are answered HERE, before a thread is spawned: an over-cap ask, a signed
/// template and a bad target are all decidable from the arguments, and paying ~30ms of thread
/// startup to be told `over_cap` would make the refusal cost more than the mining it declined. That
/// is not an optimisation, it is the difference between a cap that protects the box and one that
/// merely relocates the cost.
///
/// Two failure codes exist only on this path:
///   worker_failed  — the thread errored or exited without answering. NEVER a partial event, and
///                    never a silent fall back to mining inline: a fallback would reintroduce the
///                    exact stall the worker exists to prevent, at the moment things are already
///                    going wrong.
///   timed_out      — the wall clock ran out. The worker is terminated, because a mine nobody is
///                    waiting for is a core the box needs back.
///
/// `timeoutMs` defaults generously relative to the cap: 16 bits measures ~3s here and ~15s on the
/// droplet, so 120s is a backstop against a wedged thread, not a difficulty budget. The iteration
/// budget inside `mineSync` is what bounds the work.
export async function mineAsync(template, target, { cap = POW_CAP, maxIterations, timeoutMs = 120000, workerUrl } = {}) {
  const cheap = mineSyncPrecheck(template, target, cap)
  if (cheap) return cheap

  const url = workerUrl || new URL('./pow_worker.mjs', import.meta.url)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Terminate unconditionally. On the success path the worker has already posted and is about
      // to exit on its own; on every other path it may not be, and this is the only handle to it.
      try { worker.terminate() } catch { /* already gone */ }
      resolve(value)
    }
    const timer = setTimeout(() => finish({
      mined: false, code: 'timed_out', target: Number(target),
      reason: `no answer from the mining worker within ${timeoutMs}ms — terminated rather than left holding the core`,
    }), timeoutMs)
    let worker
    try {
      worker = new Worker(url, { workerData: { template, target: Number(target), cap, maxIterations } })
    } catch (e) {
      clearTimeout(timer)
      return resolve({ mined: false, code: 'worker_failed', target: Number(target),
        reason: `could not start the mining worker: ${e?.message || e}` })
    }
    worker.on('message', finish)
    worker.on('error', e => finish({ mined: false, code: 'worker_failed', target: Number(target),
      reason: `the mining worker errored: ${e?.message || e}` }))
    // An exit with no message is the case a naive implementation hangs on forever. `finish` is
    // idempotent, so arriving here after a successful message is a no-op.
    worker.on('exit', code => finish({ mined: false, code: 'worker_failed', target: Number(target),
      reason: `the mining worker exited (${code}) without answering` }))
  })
}

/// The refusals both miners share, in the order `mineSync` applies them. Split out so the async path
/// can answer them without a thread AND give byte-identical reasons — two copies of a refusal string
/// is two chances for the sync and async paths to explain the same fault differently.
function mineSyncPrecheck(template, target, cap) {
  // A zero iteration budget makes mineSync answer its argument checks and then fall straight out of
  // a loop that never runs. Whether a refusal comes back at all is therefore mineSync's decision,
  // not a condition restated here — restating it is how the two paths drift.
  const verdict = mineSync(template, target, { cap, maxIterations: 0 })
  // `exhausted` is the loop's answer, not an argument's: it means every cheap check passed and the
  // real work is still to be done. Anything else is a refusal that needed no thread.
  return verdict.code === 'exhausted' ? null : verdict
}
