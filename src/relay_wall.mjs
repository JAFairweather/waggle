// relay_wall.mjs — is the community relay still refusing keys it does not know? (#447)
//
// waggle's routing model rests on one relay-side refusal: an external key cannot pass NIP-42 AUTH,
// so it cannot read the community. The return lane exists because of that refusal, the `kind:0`
// deadlock is a deadlock because of it, and #370's "do not plan work assuming native read" is
// premised on it. None of that is architecture. It is `BUZZ_REQUIRE_RELAY_MEMBERSHIP`, an env var
// on infrastructure waggle does not own, defaulting to false and parsed with an exact string
// compare — so `TRUE` yields an OPEN relay whose configuration reads closed, and the boot interlock
// that would catch a half-configured closed relay never fires because the bool already parsed false.
//
// This module is the judgement, kept apart from the socket so it can be tested without one. The
// socket driver is tools/relay-wall-probe.mjs.
//
// THE NEGATIVE CONTROL IS THE DESIGN, NOT A GARNISH. "The relay refused me" is the same observation
// whether the wall is up, the relay is down, the URL is wrong, the key is malformed, or the probe
// never ran. An alarm that has only ever passed cannot be distinguished from one that never fires.
// So a verdict of `intact` requires TWO facts, not one: a key that must be refused WAS refused, and
// a key that must be admitted WAS admitted. Missing the second is INCONCLUSIVE — never `intact`.

// Exit codes match tools/tripwire.mjs and deploy/verify-firewall.sh: 3 is "could not see enough to
// judge", and it is emphatically not 0. Being unable to check is not the same as being fine.
export const EXIT = {
  intact: 0,
  breach: 2,
  inconclusive: 3,
}

// NIP-42. The relay sends ["AUTH", <challenge>]; the client answers with a signed kind 22242 whose
// tags bind the response to THIS relay and THIS challenge. Binding both is what stops a challenge
// captured from one relay being replayed at another.
export const AUTH_KIND = 22242

export function buildAuthEvent ({ relayUrl, challenge, created_at }) {
  if (typeof relayUrl !== 'string' || !relayUrl) throw new Error('buildAuthEvent: relayUrl required')
  if (typeof challenge !== 'string' || !challenge) throw new Error('buildAuthEvent: challenge required')
  if (!Number.isInteger(created_at)) throw new Error('buildAuthEvent: created_at must be an integer')
  return {
    kind: AUTH_KIND,
    created_at,
    // Order is not significant to NIP-42, but both tags are: a response carrying only the challenge
    // is replayable at any relay that issued it.
    tags: [['relay', relayUrl], ['challenge', challenge]],
    content: '',
  }
}

// What one probe observed. Deliberately a small closed vocabulary — the verdict below switches on
// it, and a free-form string would let a new observation fall through to a default.
export const OBSERVED = {
  authenticated: 'authenticated',   // relay answered OK …, true
  refused: 'refused',               // relay answered OK …, false — an explicit, attributable refusal
  noChallenge: 'no-challenge',      // relay never issued an AUTH challenge
  unreachable: 'unreachable',       // could not connect, or the socket died before a verdict
  timedOut: 'timed-out',
  error: 'error',                   // malformed frame, signing failure, anything else
}

const CLEAN = new Set([OBSERVED.authenticated, OBSERVED.refused])

// Read a relay's reply to our AUTH into one of the OBSERVED values.
//
// `frames` is the ordered list of decoded relay messages seen for this connection. We look for the
// OK that names our event id: a relay may interleave NOTICE and other traffic, and matching on
// position rather than id has us reading somebody else's answer.
export function classifyAuthReply ({ frames, eventId, sawChallenge }) {
  if (!Array.isArray(frames)) return { observed: OBSERVED.error, detail: 'frames was not an array' }
  if (!sawChallenge) return { observed: OBSERVED.noChallenge, detail: 'relay issued no AUTH challenge' }
  for (const f of frames) {
    if (!Array.isArray(f) || f[0] !== 'OK' || f[1] !== eventId) continue
    // NIP-20: ["OK", <id>, <bool>, <message>]. A non-boolean third element is a relay we do not
    // understand, and guessing which way it meant is exactly the fail-open this alarm exists for.
    if (f[2] === true) return { observed: OBSERVED.authenticated, detail: String(f[3] || '') }
    if (f[2] === false) return { observed: OBSERVED.refused, detail: String(f[3] || '') }
    return { observed: OBSERVED.error, detail: `OK frame with a non-boolean verdict: ${JSON.stringify(f[2])}` }
  }
  return { observed: OBSERVED.error, detail: 'no OK frame named our AUTH event' }
}

// The verdict. Two probes in, one decision out.
//
//   mustBeRefused — a key holding no grant and no relay_members row. The wall is what stops it.
//   mustBeAdmitted — a key the relay is known to accept. Its ONLY job is to prove that a refusal
//                    above meant something. Without it we cannot tell a wall from an outage.
export function wallVerdict ({ mustBeRefused, mustBeAdmitted }) {
  const refused = mustBeRefused || { observed: OBSERVED.error, detail: 'no result for the must-be-refused probe' }
  const admitted = mustBeAdmitted || null

  // 1. The alarm, and it outranks everything. A key that should never have got in DID get in — that
  //    is the wall being down, and it is true whether or not the control worked. Do not soften this
  //    to inconclusive just because the other half of the probe had a bad day.
  if (refused.observed === OBSERVED.authenticated) {
    return {
      state: 'breach',
      exitCode: EXIT.breach,
      needsHuman: true,
      reason: `A key with no grant and no relay_members row AUTHENTICATED to the community relay. `
        + `The membership wall is not enforcing. Everything waggle claims about external keys being `
        + `unable to read is false while this holds${refused.detail ? ` (relay said: ${refused.detail})` : ''}.`,
    }
  }

  // 2. The must-be-refused probe has to have produced an attributable answer. "The socket closed"
  //    is not a refusal, and reporting it as one is how an alarm starts passing forever.
  if (!CLEAN.has(refused.observed)) {
    return {
      state: 'inconclusive',
      exitCode: EXIT.inconclusive,
      // A relay that answers but never challenges may well be a relay with the wall down. It may
      // equally be a probe bug or a relay that only challenges when a REQ demands it. We refuse to
      // call it either way, and we say so loudly rather than reporting intact.
      needsHuman: refused.observed === OBSERVED.noChallenge,
      reason: `Could not judge the wall: the must-be-refused key got '${refused.observed}'`
        + `${refused.detail ? ` (${refused.detail})` : ''}. `
        + (refused.observed === OBSERVED.noChallenge
          ? 'A relay that never asks for AUTH may be a relay that is not enforcing — this needs a human, not a retry.'
          : 'This is not evidence the wall is up.'),
    }
  }

  // 3. Refused, which is what we want to see — but it only counts if we also showed the relay can
  //    say yes to somebody. This is the branch the whole module exists for.
  if (!admitted) {
    return {
      state: 'inconclusive',
      exitCode: EXIT.inconclusive,
      needsHuman: false,
      reason: 'The must-be-refused key was refused, but no control key was configured, so this run '
        + 'cannot tell a wall from a relay that refuses everyone. Configure the control key; a '
        + 'refusal on its own is not a pass.',
    }
  }
  if (admitted.observed !== OBSERVED.authenticated) {
    return {
      state: 'inconclusive',
      exitCode: EXIT.inconclusive,
      needsHuman: false,
      reason: `The must-be-refused key was refused, but so was the control key `
        + `('${admitted.observed}'${admitted.detail ? `: ${admitted.detail}` : ''}). A relay refusing `
        + `everyone looks identical to a wall doing its job. No conclusion about the wall.`,
    }
  }

  return {
    state: 'intact',
    exitCode: EXIT.intact,
    needsHuman: false,
    reason: 'The membership wall is enforcing: a key with no grant was refused, and — the half that '
      + 'makes that meaningful — a key that should be admitted was admitted on the same run.',
  }
}
