// channel_seat.mjs — seating an agent's channel public key on the broker, as a decision that can be
// checked before anything is written (#488).
//
// An agent's MCP channel is an ssh invocation to the broker under a forced command. For that to
// work, the agent's channel PUBLIC key has to be in the broker's authorized_keys under that command.
// Nothing in this repo wrote it, so `connect-agent --check` reported `channel-authorized` as UNKNOWN
// forever: correct, and with no path by which it could ever become anything else. A fresh agent
// finished install with a correct stanza, a correct keypair, and a channel that could not connect.
//
// This module is the part worth testing without a broker: what the line says, and whether writing it
// is the right thing to do. The runner (`channel_seat_runner.mjs`) does the I/O.
//
// THE RULE THAT SHAPES EVERYTHING HERE: the requester contributes a key, and nothing else. Every
// byte of the options prefix — the forced command, the restrictions, the instance it serves — comes
// from the broker's own root-owned config. An authorized_keys line is a grant of execution, and its
// options field is where the grant is bounded; a caller who can influence that field can widen their
// own authority in the act of asking for it. So an intent carrying its own options is not sanitised,
// it is refused: sanitising invites a next version that sanitises slightly less.
//
// The same reasoning as `buzz_policy_core.mjs`'s `recipientRoutes` — the requester never names the
// destination — applied to a different actuator.

import { createHash } from 'node:crypto'

export const SEAT_VERSION = 1
export const SEAT_OP = 'channel_seat'

const HEX64 = /^[0-9a-f]{64}$/i
// An instance name lands INSIDE the quoted command string in the options field. It is therefore held
// to the same closed identifier shape the policy plane uses for `policy_instance`: no quote, no
// backslash, no space, no shell metacharacter can appear in it, so there is no byte with which to
// end the quoted string early.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// Absolute path, and the same closed character set. The command is config-supplied rather than
// caller-supplied, but a broker whose config was written carelessly should still not produce a line
// that means something other than it reads.
const COMMAND = /^\/[A-Za-z0-9._\-/]{1,255}$/
// ed25519 only. The broker's channel keys are minted by `connect-agent` as ed25519 (`ssh-keygen -t
// ed25519`), so accepting other algorithms would only ever admit a key this project did not mint.
const KEY_LINE = /^ssh-ed25519 ([A-Za-z0-9+/]{16,1024}={0,3})(?: ([\x20-\x7e]{0,128}))?$/

const refuse = reason => Object.freeze({ ok: false, reason })

/**
 * Parse a seat intent body. Pure, and it never throws: the caller may be handing it bytes that
 * arrived over a socket.
 *
 * Returns `{ ok: true, agent, keyBlob, comment }` or `{ ok: false, reason }`.
 */
export function parseSeatIntent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('invalid seat intent')
  if (body.v !== SEAT_VERSION) return refuse('unsupported seat intent version')
  if (body.op !== SEAT_OP) return refuse('not a channel_seat intent')
  // Exact key set. An extra field is a refusal rather than something ignored — most of all here,
  // where the field an attacker would add is `options`.
  if (Object.keys(body).sort().join(',') !== 'agent,key,op,v') return refuse('invalid seat intent')

  const agent = String(body.agent || '').toLowerCase()
  if (!HEX64.test(agent)) return refuse('agent must be a 64-hex public key')

  if (typeof body.key !== 'string') return refuse('key must be an ssh public key line')
  // Newlines first and by name: a key carrying one is not a malformed key, it is an attempt to write
  // a SECOND authorized_keys line — one whose options field the requester would then own outright.
  if (/[\r\n]/.test(body.key)) return refuse('key must be a single line — a newline would seat a second, unbounded entry')
  const match = KEY_LINE.exec(body.key.trim())
  // An options prefix is the specific thing being refused, so it is named specifically. `restrict
  // ssh-ed25519 …` and `command="…" ssh-ed25519 …` both land here, and an operator who pasted a
  // whole authorized_keys line needs to be told which half to keep.
  if (!match) {
    return /ssh-ed25519 /.test(body.key)
      ? refuse('key must be the bare `ssh-ed25519 <blob>` line — options come from the broker, never from the intent')
      : refuse('key must be an ed25519 ssh public key')
  }
  return Object.freeze({ ok: true, agent, keyBlob: match[1], comment: match[2] || '' })
}

/**
 * `ssh-keygen -lf` prints this. Matching its format matters: the operator's way of checking a seat
 * is to run ssh-keygen against their own .pub and compare strings, and a fingerprint they cannot
 * compare is a fingerprint they will not check.
 */
export function keyFingerprint(keyBlob) {
  const blob = String(keyBlob || '')
  if (!/^[A-Za-z0-9+/]{16,1024}={0,3}$/.test(blob)) return null
  return `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`
}

/**
 * The line to write. Every byte of the options prefix comes from `seat` (the broker's config); the
 * intent contributes the key blob only, and the comment is the agent's own public key so a seat is
 * attributable to an identity rather than to whoever happened to paste it.
 *
 * `restrict` first, then the forced command: `restrict` turns everything off and later options turn
 * individual things back on, so an option order that put `command=` first would still be a correct
 * line — but this order is the one that reads as what it is.
 */
export function authorizedKeysLine(intent, { command, instance } = {}) {
  if (!intent || intent.ok !== true) throw new Error('channel-seat: a parsed intent is required')
  if (!COMMAND.test(String(command || ''))) throw new Error('channel-seat: forced command must be an absolute path in a closed character set')
  if (!ID.test(String(instance || ''))) throw new Error('channel-seat: instance is invalid')
  return `restrict,command="${command} ${instance}" ssh-ed25519 ${intent.keyBlob} ${intent.agent}`
}

const splitLine = line => {
  const text = String(line || '').trim()
  if (!text || text.startsWith('#')) return null
  // An authorized_keys line is options (optional) then keytype, blob, comment. The keytype is the
  // anchor: everything before it is options, everything after is blob and comment.
  const at = text.indexOf('ssh-ed25519 ')
  if (at < 0) return null
  const [blob, ...rest] = text.slice(at + 'ssh-ed25519 '.length).split(/\s+/)
  return { options: text.slice(0, at).replace(/[\s,]+$/, ''), blob, comment: rest.join(' ') }
}

/**
 * Whether to write, and what the caller is allowed to conclude if not.
 *
 * Four outcomes, and the distinction between the middle two is the whole point:
 *
 *   seated         — not present; write it.
 *   already-seated — the exact line is present. Not an error, and not a second write: an operator
 *                    running the seat twice must see "already done", not an alarm and not a duplicate.
 *   conflict       — something for this agent, or this key, is present and DIFFERENT. Refuse.
 *   refused        — the intent itself is not admissible.
 *
 * `conflict` exists because the tempting implementation is "append if the exact line is absent",
 * which silently double-seats a rotated key: the old line still authenticates, so a key the owner
 * believes they replaced still opens the channel. Nothing about the resulting file looks wrong.
 */
export function seatDecision(intent, existingText, { command, instance } = {}) {
  if (!intent || intent.ok !== true) return Object.freeze({ result: 'refused', reason: intent?.reason || 'invalid seat intent' })
  let line
  try { line = authorizedKeysLine(intent, { command, instance }) }
  catch (error) { return Object.freeze({ result: 'refused', reason: String(error.message).replace(/^channel-seat: /, '') }) }

  const rawLines = String(existingText == null ? '' : existingText).split('\n')
  // Exact match on the whole line, not on a reconstruction of it. Rebuilding the line from parsed
  // fields would call two lines equal whenever the parse dropped whatever made them differ.
  if (rawLines.some(raw => raw.trim() === line)) {
    return Object.freeze({ result: 'already-seated', reason: 'this exact line is already present — nothing to write', line })
  }
  for (const entry of rawLines.map(splitLine).filter(Boolean)) {
    const sameKey = entry.blob === intent.keyBlob
    const sameAgent = entry.comment === intent.agent
    if (!sameKey && !sameAgent) continue
    if (sameKey && !sameAgent) {
      return Object.freeze({ result: 'conflict', reason: 'this key is already seated for a different agent — one key, one identity', line })
    }
    if (sameAgent && !sameKey) {
      return Object.freeze({ result: 'conflict', reason: 'this agent already has a DIFFERENT key seated — remove the old line deliberately, because appending would leave both able to connect', line })
    }
    return Object.freeze({ result: 'conflict', reason: 'this key is seated for this agent under different options — the existing grant is not the one being asked for', line })
  }
  return Object.freeze({ result: 'seated', reason: 'not present — the line will be appended', line })
}

/**
 * What the runner reports back, and what `connect-agent --seat-receipt` reads.
 *
 * It carries a fingerprint rather than the key, and no path, no host, no channel id: a receipt is
 * handed to an agent's machine, and the least it can name about the broker, the better. The
 * fingerprint is enough to check the one thing that matters — that the key seated is THIS agent's.
 */
export function seatReceipt(intent, decision, { instance, at } = {}) {
  return Object.freeze({
    v: SEAT_VERSION,
    op: SEAT_OP,
    result: decision.result,
    agent: intent.ok === true ? intent.agent : null,
    fingerprint: intent.ok === true ? keyFingerprint(intent.keyBlob) : null,
    instance: instance || null,
    reason: decision.reason,
    at: Number.isSafeInteger(at) ? at : null,
  })
}

/**
 * The agent-side half: does this receipt prove that THIS key is seated?
 *
 * Deliberately three-valued, and the middle value is the one this project keeps having to re-learn:
 * an absent or unreadable receipt is UNKNOWN, never MISSING and never a pass. A receipt naming a
 * DIFFERENT key is a real negative — the operator seated something, and it was not this.
 *
 * Like `--whoami` (#462), a receipt is a saved capture: it has no freshness and no binding to the
 * broker's current file. It proves the seat happened, not that it still stands.
 */
export function seatVerdict(receipt, { fingerprint, agent } = {}) {
  const unknown = reason => Object.freeze({ seated: null, reason })
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return unknown('no seat receipt — INCONCLUSIVE, not absent')
  if (receipt.v !== SEAT_VERSION || receipt.op !== SEAT_OP) return unknown('not a channel_seat receipt — INCONCLUSIVE')
  const want = String(fingerprint || '')
  if (!want) return unknown('no local key to compare the receipt against — INCONCLUSIVE')
  if (agent && String(receipt.agent || '') !== String(agent).toLowerCase()) {
    return Object.freeze({ seated: false, reason: `the receipt seats a different agent (${String(receipt.agent || 'none').slice(0, 16)}…) — this is not this agent's seat` })
  }
  if (receipt.fingerprint !== want) {
    return Object.freeze({ seated: false, reason: `the receipt seats ${receipt.fingerprint || 'no key'}, and this machine's channel key is ${want} — a seat was made, but not for this key` })
  }
  if (receipt.result === 'seated' || receipt.result === 'already-seated') {
    return Object.freeze({ seated: true, reason: `${receipt.result} on the broker for ${want} — a saved capture, so it proves the seat happened, not that it still stands` })
  }
  return Object.freeze({ seated: false, reason: `the broker refused this seat: ${String(receipt.reason || receipt.result || 'no reason given').slice(0, 200)}` })
}
