// return_lane_notify.mjs — turning an opened message into something a runtime can be woken by (#548).
//
// `agent-inbox` already verifies the seal, refuses a rumor whose claimed author disagrees with the
// seal that carried it, and decrypts. Then it throws all of that structure away and prints prose for
// a person. So every agent here is polled by a human, and cross-agent work runs at the speed of
// somebody remembering to look. This module is the last step instead: the same verdict, rendered as
// one JSON line, plus the decision of whether it may run a command.
//
// THE GATE IS THE TRUST LIST, AND ONLY THE TRUST LIST. The proposal this came from said
// "trusted/mentioned"; the second half is a hole. Anyone may seal mail to this agent's key, so a
// mention that fires the hook hands every stranger on the open internet a trigger on this session —
// no code execution, the body is never executed, but an unauthenticated wake-up whenever they like.
// `forMe` is carried in the envelope for the agent to read. It is never a reason to run something.
//
// AND KNOW WHAT THE GATE ACTUALLY SAYS. On the return lane the seal author is always the bridge, so
// `--trust <bridge-key>` is the only configuration in which the hook can fire at all — and from
// there `mayAct` is true for every mention any community member sends. It means A TRUSTED COURIER
// DELIVERED THIS, never a trusted party said it. The original poster is in the rendered body as
// prose and not yet as a field, so a consumer wanting to re-gate on the author cannot do it from
// this record. Do not read `mayAct` as authorship.
//
// ONE THING NARROWS THAT GATE AND NOTHING WIDENS IT. The bridge's own carriage receipt for a send
// this agent just made is trusted, is `mayAct`, and is nobody speaking — so it does not wake anyone
// (#550). That test reads content, which would be unsafe if it could ever grant, so it is applied
// after the trust check and is only ever able to take away.

// Built with fromCharCode so this source stays pure ASCII. A class holding two invisible
// characters is a class nobody can review, and this repo has already paid for one.
const U2028 = String.fromCharCode(0x2028)
const U2029 = String.fromCharCode(0x2029)

const HEX64 = /^[0-9a-f]{64}$/i
// `relay_ack_ok`'s slots, sorted. Deliberately a literal and not an import: this module is the
// AGENT side, and reaching into the bridge's egress catalogue to read it would pull the bridge's
// key handling into a tool that runs on somebody else's laptop. The suite holds the two together.
const ACK_KEYS = 'buzz_event_id,channel,ok,ts'

/**
 * Is this the bridge acknowledging THIS agent's own send, rather than somebody speaking to it?
 *
 * Found by being woken by one (#550). The wake path fired end to end for the first time and what it
 * delivered was `{"ok":true,"channel":…,"buzz_event_id":…,"ts":…}` — the carriage receipt for a
 * message this agent had just sent. Sealed by the bridge, so on the trust list, so `mayAct`; but
 * nobody said it. On a lane where every send produces one, that is a session woken by its own echo,
 * and an agent that wakes for its own sends stops reading the ones that wake it for real.
 *
 * THE KEY SET IS PINNED EXACTLY, and `buzz_event_id` may be null. The first version required a
 * 64-hex id, and `relay_ack_ok` renders `buzz_event_id: null` whenever the caller's id is falsy
 * (`nostr_egress.mjs`) — which `bridge.mjs` passes for real, because `parseBuzzEventId` coming back
 * empty is an already-logged condition (#334) that falls through to the ack. So #550 was closed for
 * ordinary sends and left open for exactly the sends that lost their id: the ones least worth being
 * woken by. Caught in review, not by this suite, because the fixture was written from a receipt that
 * happened to have an id.
 *
 * Pinning the whole key set is the pattern `channel_seat_delivery.mjs` already uses, and it is what
 * makes accepting null safe: `{ok:true, buzz_event_id:null}` alone is a shape anything could take.
 * It also fails in the right direction — if the ack ever grows a field, this stops matching and the
 * receipts go back to waking somebody, which is noisy rather than silent.
 *
 * THE SHAPE IS OBSERVED, NOT CONTRACTED. The broker emits it, not this repo, so there is no emitter
 * here to pin against — the suite binds these conditions to the real `buildBody('relay_ack_ok')`
 * rather than to a hand-written string, so a renderer change breaks the test instead of the lane.
 *
 * A community member cannot dress a mention up as one. The bridge renders a carried mention as prose
 * with the sender quoted inside it ("📥 … you were mentioned … > their text"), so the body never
 * parses as JSON at the top level and their text can never be the whole content. Asserted with a
 * hostile fixture rather than reasoned, because the failure — a real mention silently not waking
 * anyone — is the expensive direction and looks exactly like a quiet lane.
 */
export function isCarriageReceipt(content) {
  const s = String(content ?? '').trim()
  if (!s.startsWith('{') || !s.endsWith('}')) return false
  let r
  try { r = JSON.parse(s) } catch { return false }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false
  if (Object.keys(r).sort().join(',') !== ACK_KEYS) return false
  // `ok:false` is NOT swallowed. A send that did not land is news, and it is the one ack an agent
  // most needs to be woken by.
  if (r.ok !== true) return false
  if (!(r.buzz_event_id === null || HEX64.test(String(r.buzz_event_id)))) return false
  return typeof r.channel === 'string' && Number.isFinite(r.ts)
}

/**
 * One opened message as one line of JSON.
 *
 * `JSON.stringify` escapes \n and \r, so a body with newlines cannot break the line framing and a
 * hostile body cannot forge a second record. It does NOT escape U+2028/U+2029, which are valid in a
 * JSON string but line terminators to some readers — a splitter that treats them as breaks would see
 * two half-records. They are escaped here rather than stripped, because the agent should read the
 * body it was actually sent.
 *
 * The refused case is emitted too, and deliberately. A message this tool would not attribute is
 * something that happened; dropping it silently would leave a reader unable to tell a quiet lane
 * from one being fed forgeries.
 */
export function notifyLine(verdict, { id = null, receivedAt = null, firstSeen = true, live = null, bootstrap = false } = {}) {
  const v = verdict && typeof verdict === 'object' ? verdict : {}
  // The wrap id, and the only thing on this record an adapter can be idempotent on (#559). It is the
  // caller's job to pass one that has been VERIFIED — `open()` runs `verifyEvent` before it dedupes,
  // precisely so the id is a hash the relay cannot choose. An unverified id here would let a relay
  // pick which message a spool cursor believes it has already delivered.
  //
  // Absent serialises as null and the key is always present. A missing key and a null are different
  // states — "this daemon does not emit ids" versus "this record has none" — and an adapter that
  // cannot tell them apart will treat the first as the second and dedupe every record together.
  const wrapId = typeof id === 'string' && id ? id : null
  // Rumor time (`at`) is set by the SENDER; this is when this daemon saw it. They are separate keys
  // because a spool ordered by sender-controlled time is a spool a sender can reorder.
  const seenAt = Number.isSafeInteger(receivedAt) ? receivedAt : null
  // THE WAKE VERDICT, emitted as ONE field so no adapter re-derives it (#559).
  //
  // The stream is deliberately ungated — every record reaches stdout, refusals included, so a lane
  // being fed forgeries cannot look quiet. That is right, and it made an adapter filtering this
  // stream on `receipt:false` wake on mail from anyone who can seal a wrap to this key, which under
  // NIP-59 is everyone: a stranger's ordinary message is `ok:true, mayAct:false, receipt:false`. The
  // hook path refused exactly what that adapter woke on, and `tools/agent-inbox.mjs` had already
  // written down why — "anyone may seal mail to this key and a mention that runs a command hands
  // every stranger a trigger on this session". An adapter filters on `wake` and nothing else; the
  // alternative is every adapter re-deriving a conjunction, which is the adapter owning protocol
  // semantics, the thing this boundary exists to prevent. `hasCommand: true` because this asks the
  // gate's question, not "is a hook configured": the record must say the same thing whether or not
  // this process happens to have one.
  //
  // THE TRUST GATE IS NOT THE WHOLE ANSWER, and the two wrong ways to finish it both shipped as
  // proposals here before this landed (#557 review):
  //
  //   wake = invoke                — floods. Every relay replays its history pre-EOSE, so an adapter
  //                                  fires once per historical message on arm (#554). A Monitor is
  //                                  automatically STOPPED by a flood, so the flood ends as silence.
  //   wake = live && invoke        — drops mail. The reconnect replay holds two populations a relay
  //                                  cannot separate: messages already delivered, and messages that
  //                                  ARRIVED DURING THE DISCONNECT. Both land pre-EOSE. Gating on
  //                                  liveness suppresses the second forever, which is the very bug
  //                                  #557 was filed about, rebuilt inside the field meant to fix it.
  //
  // So the gate is FIRST-SEEN, not liveness. Liveness was only ever a stand-in for a dedupe index
  // that did not exist yet; a durable index retires the stand-in, and keeping both is what loses the
  // disconnect-window mail. `live` and `bootstrap` stay on the record as audit facts — they explain
  // why something arrived as replay — and they do not gate.
  //
  // `firstSeen` IS THE CALLER'S CLAIM AND THIS MODULE CANNOT CHECK IT. The index is durable state
  // and lives in the daemon. Reaching this function is supposed to mean the caller's dedupe already
  // claimed this id — `tools/agent-inbox.mjs` returns early on a hit, so every record it emits is
  // first-seen by construction.
  //
  // BOTH DEFAULTS POINT AT WAKING, deliberately. A caller that forgets either flag gets duplicate
  // wakes; a caller that forgets them under the opposite defaults gets silence. Those are not
  // symmetric: a duplicate is noise somebody notices, and a suppression is permanent, because a
  // first-seen claim is irreversible and no replay ever surfaces that message again. Wrong-and-loud
  // over wrong-and-quiet, the same direction the spool's fsync ordering takes.
  //
  // BOOTSTRAP IS THE ONE CASE LIVENESS STILL OWNS. A first-ever start has an empty index, so a relay
  // full of history is all-unseen and all-wake — the flood, arriving through the correct gate. The
  // daemon seeds the index from that population without waking and passes `bootstrap: true` to say
  // so. That is a per-run fact, not a per-message one, which is why it is a separate argument and
  // not folded into `firstSeen`: those records ARE first-seen, and recording them as anything else
  // would make the spool lie about what the index now contains.
  const isFirstSeen = firstSeen === true
  const isBootstrap = bootstrap === true
  const { wake, why: wakeReason } = wakeVerdict(v, { firstSeen, bootstrap })
  // A KEYLESS RECORD IS SERIALISED WHOLE, not squeezed into the keyed shape (src/notify_only.mjs).
  // The keyed shape has no `mode` and no `trust_evaluated`, so a notify-only wake rendered through
  // it reaches an adapter looking exactly like an ordinary one — an unauthenticated trigger wearing
  // the shape of an authenticated record. That is the same failure as #559 and worse, because here
  // the fields that would have given it away are the ones being dropped.
  //
  // ONE SERIALISER, SAME AS ONE GATE. The alternative was for the caller to spawn the hook itself
  // with its own JSON, which is two serialisers for one stream and how the two sides drift.
  //
  // ⚠ THE KEY SET IS PINNED AND THE RECORD IS NOT SPREAD. A `...v` here would put whatever the caller
  // happened to attach onto a stream other processes parse, and would let a forged extra field ride
  // out under this daemon's name. The keyed branch below normalises every field it emits; this one
  // does the same, and for the same reason.
  //
  // ⚠ `wake` IS A CONJUNCTION, because `wakeVerdict` has never heard of `coalesced`. It answers the
  // three keyed gates (refused · already-delivered · first-start backfill) and a coalesced arrival is
  // none of them — so the verdict says "wake" for a record that has already decided not to. Taking
  // the verdict alone would put `wake:true` on every suppressed arrival and hand an adapter filtering
  // on `wake` exactly the flood the coalescer exists to bound: 195 wakes for 195 arrivals. Found in
  // review, and it was NOT live only because this function was not yet on the notify-only path.
  // `wake_reason` needs no such repair — the `wake ? …` arm below already selects the record's own
  // coalesced reason in that case, because the VERDICT is what is true there.
  const notifyOnlyRecordOut = v.mode === 'notify-only' ? {
    ok: true,
    // The mode and the trust fact travel together and are never omitted. An adapter that cannot see
    // this is one that has mistaken an unauthenticated trigger for an authenticated record.
    mode: 'notify-only',
    id: wrapId,
    received_at: seenAt,
    first_seen: isFirstSeen,
    bootstrap: isBootstrap,
    live: live === null || live === undefined ? null : live === true,
    coalesced: v.coalesced === true,
    arrivals: Number.isSafeInteger(v.arrivals) && v.arrivals > 0 ? v.arrivals : 1,
    wake: wake && v.wake !== false,
    wake_reason: wake ? String(v.wake_reason || '') : wakeReason,
    trust_evaluated: false,
    mayAct: false,
    disposition: 'unopened',
    forMe: v.forMe === true,
    author: null,
    content: '',
    reason: String(v.reason || ''),
  } : null
  const record = notifyOnlyRecordOut || (v.ok === true
    ? {
        ok: true,
        id: wrapId,
        received_at: seenAt,
        wake,
        wake_reason: wakeReason,
        // THE THREE FACTS THE WAKE WAS COMPUTED FROM, each serialised on its own. One `wake:false`
        // cannot say whether this was history, an already-delivered replay, or a stranger — and an
        // operator debugging a quiet lane needs to tell those apart before they know what is wrong.
        // `live` never gates; it is here so a replay is explicable rather than mysterious, and it is
        // null when the emitter has no notion of a connection at all.
        first_seen: isFirstSeen,
        bootstrap: isBootstrap,
        live: live === null || live === undefined ? null : live === true,
        author: String(v.author || ''),
        disposition: String(v.disposition || ''),
        // The gate, restated in the record rather than left to be re-derived by every adapter that
        // reads this. An adapter that keys off `disposition === 'trusted'` and one that keys off
        // `mayAct` must never be able to disagree.
        mayAct: v.mayAct === true,
        // Addressed to this agent on the inside, under the sender's own signature — as opposed to
        // copied. Informational. See the header: this is not an authorisation.
        forMe: v.forMe === true,
        // Reported, never hidden. A receipt is still a record on the stream — it is the wake it does
        // not get, not the delivery. A reader tallying sends against acknowledgements needs these.
        receipt: isCarriageReceipt(v.content),
        at: Number.isSafeInteger(v.at) ? v.at : null,
        reason: String(v.reason || ''),
        content: String(v.content ?? ''),
      }
    // THE REFUSAL CARRIES AN ID TOO, and it is the branch that most needs one. An adapter that cannot
    // dedupe a refusal re-wakes on every restart for a lane being fed forgeries — the one case where
    // the records keep coming and none of them is worth waking for.
    : {
        ok: false, id: wrapId, received_at: seenAt,
        // Carried on this branch too, and not hardcoded to false. An adapter greps one field; a
        // record that simply omits it on refusals makes "absent" and "false" indistinguishable to
        // that grep, and the refusal branch is the one a forgery-fed lane produces in volume.
        wake, wake_reason: wakeReason,
        first_seen: isFirstSeen, bootstrap: isBootstrap,
        live: live === null || live === undefined ? null : live === true,
        reason: String(v.reason || 'refused'), disposition: 'refused', mayAct: false, forMe: false,
      })
  return JSON.stringify(record).split(U2028).join(String.raw`\u2028`).split(U2029).join(String.raw`\u2029`)
}

/**
 * May this message run the `--on-message` command?
 *
 * Returns the reason either way, because a hook that silently does not fire is indistinguishable
 * from one that fired and did nothing — and the second is the conclusion an operator draws. The
 * caller logs this, so "the mail arrived and was not acted on, because X" is observable.
 */
export function notifyDecision(verdict, { hasCommand = true } = {}) {
  const v = verdict && typeof verdict === 'object' ? verdict : {}
  if (!hasCommand) return Object.freeze({ invoke: false, why: 'no --on-message command was given' })
  if (v.ok !== true) return Object.freeze({ invoke: false, why: 'the message was refused and was attributed to nobody' })
  // THE KEYLESS RECORD IS DECIDED HERE, NOT AROUND HERE (src/notify_only.mjs). A notify-only wake
  // could not be expressed in the fields below — it has no author to trust and `mayAct` is false on
  // every one of them — so the first version of this passed `invokeHook` an override that said
  // "fire anyway". That is a second gate, and two gates is precisely the shape that let an adapter
  // wake on mail the hook refused (#559). One function decides; this branch is that decision.
  //
  // It CANNOT widen the keyed path: it is reachable only on a record this repo builds with
  // `mode: 'notify-only'`, and such a record carries no content, no author and `mayAct:false`, so
  // nothing downstream can mistake it for an authenticated one. What it buys is a wake that means
  // "go and pull", which is the only thing a keyless watcher is able to say.
  if (v.mode === 'notify-only') {
    if (v.trust_evaluated !== false) {
      return Object.freeze({ invoke: false, why: 'a notify-only record must declare trust_evaluated:false; this one does not, so it is not the record this branch is for' })
    }
    return Object.freeze({ invoke: true, why: 'notify-only: a wrap addressed to this key arrived. Nobody was authenticated — pull it with a signer and apply the trust list there' })
  }
  if (v.mayAct !== true) {
    // Spelled out at the point of refusal, because this is the line the whole issue turns on.
    const who = String(v.author || '').slice(0, 12)
    return Object.freeze({
      invoke: false,
      why: v.forMe === true
        ? `sealed by ${who}…, which is not on the trust list — being addressed is not authority, so the hook did not run`
        : `sealed by ${who}…, which is not on the trust list — the hook did not run`,
    })
  }
  // A TRUSTED COURIER'S ECHO IS NOT NEWS (#550). This sits after the trust check, not before it,
  // so it can only ever narrow what the trust list already allowed — it is incapable of opening the
  // hook to anything, which is the property that makes a content-shaped test safe here at all.
  if (isCarriageReceipt(v.content)) {
    return Object.freeze({
      invoke: false,
      why: 'a carriage receipt for this agent\'s own send — delivered and recorded, but nobody said it, so the hook did not run',
    })
  }
  return Object.freeze({ invoke: true, why: `sealed by ${String(v.author || '').slice(0, 12)}…, which is on the trust list` })
}

/**
 * Should this record wake anybody? The trust gate, plus the two delivery facts it does not know.
 *
 * ONE FUNCTION SO THE TWO PATHS CANNOT DISAGREE. `notifyLine` serialises this as `wake` and
 * `invokeHook` gates on it, and they are the same call rather than two derivations of the same
 * rule. The version of this that had a hook gate on one side and a stream an adapter re-derived on
 * the other is how a proven, briefed adapter ended up waking on mail the hook path refused — a
 * stranger's ordinary message is `ok:true, mayAct:false, receipt:false`, and the adapter matched it.
 *
 * The reason is returned either way, and it names the FIRST fact that refused rather than the last
 * one checked, because this string is what an operator debugging a quiet lane reads before they know
 * what is wrong. "Refused" and "refused with a misleading explanation" are indistinguishable to an
 * assertion that only checks `!wake`.
 */
export function wakeVerdict(verdict, { firstSeen = true, bootstrap = false, hasCommand = true } = {}) {
  if (firstSeen !== true) {
    return Object.freeze({
      wake: false,
      why: 'already delivered — no durable first-seen claim was made for this id, so nobody is woken again',
    })
  }
  if (bootstrap === true) {
    return Object.freeze({
      wake: false,
      why: 'seeding the dedupe index on a first start — this history is recorded, not announced',
    })
  }
  const decision = notifyDecision(verdict, { hasCommand })
  return Object.freeze({ wake: decision.invoke === true, why: String(decision.why || '') })
}

/**
 * Run the wake hook for one message.
 *
 * `spawn` is injected so a suite can drive this with the REAL `node:child_process.spawn` against a
 * real executable, rather than asserting that some string contains the right flags. A lost quote
 * passes every string assertion and dies in a shell; only running it settles that.
 *
 * THE ENVELOPE GOES IN ON STDIN. It is never interpolated into argv, and `shell: false` is written
 * out rather than left as the default, because that flag is the whole difference between delivering
 * a message and executing it. `command` is an executable path — this function never splits a string
 * into arguments, so there is no quoting to get wrong.
 *
 * THE CHILD'S STDOUT GOES TO STDERR, not to ours. Under --jsonl our stdout IS the record stream,
 * and a hook that prints anything would land a non-JSON line between two records — "print a line
 * saying what you woke" is the first thing anyone writes in a wake script. The operator still sees
 * that output; it just cannot corrupt the stream a reader is parsing.
 *
 * A hook that cannot be started, or that exits non-zero, is reported as a FAILURE. An alarm that
 * never fires and one that always fires are indistinguishable from outside, and a wake adapter that
 * is silently absent is the exact thing this exists to remove.
 */
export async function invokeHook({ command, verdict, spawn, id = null, receivedAt = null, firstSeen = true, live = null, bootstrap = false, hasCommand = Boolean(command) } = {}) {
  // THE SAME CALL `notifyLine` SERIALISES AS `wake`. Not the same rule written twice.
  //
  // `hasCommand` IS THE ONE ARGUMENT THE TWO SITES DELIBERATELY DISAGREE ON, and the asymmetry is the
  // point rather than an oversight (#561 review, item 3). This site passes `Boolean(command)`, because
  // it is about to run something and there must be something to run. `notifyLine` takes the default
  // `true`, because a record answers the GATE's question — "would this have been allowed to wake
  // anybody" — not "does this particular process happen to have a hook wired up". A spool written by
  // a daemon with no hook must say the same thing as one written by a daemon with one, or an adapter
  // reading it inherits a fact about somebody else's configuration.
  //
  // It cannot produce a disagreeing pair. With no command this returns before `notifyLine` is reached,
  // so no record is emitted here at all; the only record in that case is the stream's, which is
  // correct on its own terms. The suite pins the direction: `wake_reason` never blames a missing
  // --on-message.
  const decision = wakeVerdict(verdict, { firstSeen, bootstrap, hasCommand })
  if (!decision.wake) return Object.freeze({ ran: false, ok: true, why: decision.why })
  // THE SAME RECORD THE STREAM GETS, id included. A hook reading one shape and a spool reading
  // another would disagree about what arrived, and the disagreement would only show up as an adapter
  // that re-wakes on messages the stream considers already delivered.
  const line = notifyLine(verdict, { id, receivedAt, firstSeen, live, bootstrap }) + '\n'
  return await new Promise(resolve => {
    let child
    const fail = e => resolve(Object.freeze({
      ran: false, ok: false, why: `the hook could not be started — ${String(e?.message || e).slice(0, 160)}`,
    }))
    try { child = spawn(command, [], { shell: false, stdio: ['pipe', 2, 'inherit'] }) }
    catch (e) { return fail(e) }
    let settled = false
    child.on('error', e => { if (!settled) { settled = true; fail(e) } })
    child.on('close', code => {
      if (settled) return
      settled = true
      resolve(Object.freeze(code === 0
        ? { ran: true, ok: true, why: decision.why, code }
        : { ran: true, ok: false, code, why: `the hook exited ${code} — the message was delivered and the wake-up was not` }))
    })
    // A hook that does not read its stdin must not take the reader down with EPIPE.
    child.stdin?.on('error', () => {})
    child.stdin?.end(line)
  })
}
