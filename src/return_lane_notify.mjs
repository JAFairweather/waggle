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

/**
 * Is this the bridge acknowledging THIS agent's own send, rather than somebody speaking to it?
 *
 * Found by being woken by one (#550). The wake path fired end to end for the first time and what it
 * delivered was `{"ok":true,"channel":…,"buzz_event_id":…,"ts":…}` — the carriage receipt for a
 * message this agent had just sent. Sealed by the bridge, so on the trust list, so `mayAct`; but
 * nobody said it. On a lane where every send produces one, that is a session woken by its own echo,
 * and an agent that wakes for its own sends stops reading the ones that wake it for real.
 *
 * THE SHAPE IS OBSERVED, NOT CONTRACTED. The broker emits this, not this repo, so there is no
 * emitter here to pin against and this must fail SAFE: anything it cannot positively identify as a
 * receipt stays a message and still wakes. Hence all four conditions, not one.
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
  return r.ok === true && HEX64.test(String(r.buzz_event_id || '')) && typeof r.channel === 'string'
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
export function notifyLine(verdict) {
  const v = verdict && typeof verdict === 'object' ? verdict : {}
  const record = v.ok === true
    ? {
        ok: true,
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
    : { ok: false, reason: String(v.reason || 'refused'), disposition: 'refused', mayAct: false, forMe: false }
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
export async function invokeHook({ command, verdict, spawn, hasCommand = Boolean(command) } = {}) {
  const decision = notifyDecision(verdict, { hasCommand })
  if (!decision.invoke) return Object.freeze({ ran: false, ok: true, why: decision.why })
  const line = notifyLine(verdict) + '\n'
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
