// Giving an agent a NAME, which is the last thing standing between a key and being talked to.
//
// Buzz resolves an at-word against a `users` row's `display_name`. That row is written by exactly
// one thing — `handle_kind0_profile` — keyed on `event.pubkey`, and the relay rejects any event
// whose pubkey differs from the authenticated identity. So **nobody can publish this profile on the
// agent's behalf**: not waggle, not the console operator, not an admin. The key has to do it itself,
// which needs NIP-42 AUTH, which needs a `relay_members` row — which is what the invite step just
// bought. This module is the step that spends it.
//
// The same signing function does both jobs here, and that is not a shortcut: the AUTH event proves
// which key is speaking, and the kind:0 must come from that same key or the relay drops it on the
// floor. Passing two different signers would produce a publish that succeeds at the socket and
// writes nobody's profile.
//
// WHAT COUNTS AS PROOF. A relay OK is not proof — relays return OK and drop. So this publishes and
// then reads back from a **fresh connection**, by id, and compares the name it finds against the
// name it asked for. `proven` is true only when that read-back succeeds; everything else says so
// plainly rather than reporting the OK as success.

const HEX64_RE = /^[0-9a-f]{64}$/

/// A name a person will type. The refusals here are about what survives a round trip through a
/// mention, not about taste.
export function profileContent({ name, about = '' }) {
  const display = String(name == null ? '' : name).trim()
  if (!display) throw new Error('a name is required — without one there is nothing for anybody to type')
  // A newline or a control character in a display name breaks the line the approver reads and can
  // forge structure in a rendered mention. Names with SPACES are fine and must stay fine: a slot
  // validator once refused every one of them and silently dropped a real recipient's messages.
  if (/[\u0000-\u001f\u007f]/.test(display)) throw new Error('a name cannot contain control characters or line breaks')
  if (display.length > 64) throw new Error('that name is too long to render in a mention — keep it under 64 characters')
  // Both spellings. `handle_kind0_profile` prefers `display_name` and falls back to `name`; other
  // Nostr clients read `name`. Writing one and not the other means the agent has a name in one
  // place and none in the other.
  return JSON.stringify({ display_name: display, name: display, about: String(about || '') })
}

export function profileTemplate({ name, about = '', nowSec }) {
  return { kind: 0, created_at: nowSec, tags: [], content: profileContent({ name, about }) }
}

/// Publish the agent's own profile to the community relay, then prove it landed.
///
/// `openPool` is called TWICE and must return a NEW pool each time — the read-back is worthless if
/// it can be answered out of the connection that did the writing.
export async function publishProfile({ relayUrl, name, about = '', pubkeyHex, sign, openPool, nowSec }) {
  if (typeof sign !== 'function') throw new Error('sign must be a function — the agent key signs both its own profile and the relay AUTH')
  const pk = String(pubkeyHex || '').toLowerCase()
  if (!HEX64_RE.test(pk)) throw new Error('publishProfile needs the agent\'s 64-character hex pubkey, to read the profile back by author')

  let signed
  try {
    signed = await sign(profileTemplate({ name, about, nowSec }))
  } catch (e) { return { ok: false, step: 'sign', outcome: 'cannot_sign', proven: false, detail: e.message } }
  if (!signed || !signed.id || !signed.sig) {
    return { ok: false, step: 'sign', outcome: 'cannot_sign', proven: false,
      detail: 'The agent key is no longer in this page, so it cannot sign its own profile. Make a new key and do this step before saving it.' }
  }

  const writePool = openPool()
  try {
    await writePool.publish([relayUrl], signed, { onauth: sign })
  } catch (e) {
    const msg = String(e && e.message || e)
    // The one refusal worth naming: it means the membership row is not there or not in force, which
    // is a completely different problem from a rejected event.
    if (/auth/i.test(msg)) {
      return { ok: false, step: 'publish', outcome: 'auth_refused', proven: false,
        detail: 'The relay would not let this key sign in, so its profile was never accepted. The invitation step is what grants that — check it ran against this same relay.' }
    }
    return { ok: false, step: 'publish', outcome: 'refused', proven: false, detail: msg }
  } finally { writePool.close([relayUrl]) }

  // COLD READ-BACK. New connection, filtered by author, matched by id. An OK from the socket above
  // has told us nothing that this does not tell us better.
  const readPool = openPool()
  let found = null
  try {
    found = await readPool.get([relayUrl], { kinds: [0], authors: [pk] }, { onauth: sign })
  } catch (e) {
    return { ok: false, step: 'readback', outcome: 'unreadable', proven: false,
      detail: `The profile was accepted but could not be read back: ${String(e && e.message || e)}` }
  } finally { readPool.close([relayUrl]) }

  if (!found) {
    return { ok: false, step: 'readback', outcome: 'not_served', proven: false,
      detail: 'The relay accepted the profile and then would not serve it back. That is a real failure, not a delay — nothing will resolve this name.' }
  }
  if (found.id !== signed.id) {
    // An older profile for the same key. Not nothing — but it is not what we just wrote.
    return { ok: false, step: 'readback', outcome: 'stale', proven: false,
      detail: 'The relay served an older profile for this key instead of the one just published.' }
  }

  let served = null
  try { served = JSON.parse(found.content).display_name } catch { served = null }
  return {
    ok: true, step: 'readback', outcome: 'named', proven: true, name: served,
    detail: `Read back cold from the relay by id — this key now answers to that name.`,
  }
}

/// Declare where this key wants sealed mail delivered — NIP-17's kind:10050.
///
/// WITHOUT THIS, A NAMED AGENT IS STILL UNREACHABLE, and waggle says so rather than guessing:
/// `RETURN not sent -> …: no valid kind:10050 recipient DM relay list (NIP-17)`. NIP-17 treats a
/// missing list as "not ready for DMs", and waggle honours that instead of falling back to relays
/// the recipient never asked for — a fallback would deliver somebody's private mail to a relay of
/// the bridge's choosing.
///
/// This goes to PUBLIC relays, not the community one. Sealed mail travels over open Nostr; the
/// community relay is where the name lives, and the two are not interchangeable.
export async function publishDmInbox({ dmRelays, publishTo, pubkeyHex, sign, openPool, nowSec }) {
  if (typeof sign !== 'function') throw new Error('sign must be a function — only this key can declare its own inbox')
  const pk = String(pubkeyHex || '').toLowerCase()
  if (!HEX64_RE.test(pk)) throw new Error('publishDmInbox needs the agent\'s 64-character hex pubkey, to read the list back by author')
  const relays = (dmRelays || []).map(u => String(u).trim()).filter(u => /^wss:\/\//i.test(u))
  if (!relays.length) throw new Error('a recipient relay list needs at least one wss:// relay — an empty list is worse than none, it declares an inbox nobody can deliver to')
  const targets = (publishTo && publishTo.length) ? publishTo : relays

  let signed
  try {
    signed = await sign({ kind: 10050, created_at: nowSec, tags: relays.map(u => ['relay', u]), content: '' })
  } catch (e) { return { ok: false, step: 'sign', outcome: 'cannot_sign', proven: false, detail: e.message } }
  if (!signed || !signed.id || !signed.sig) {
    return { ok: false, step: 'sign', outcome: 'cannot_sign', proven: false,
      detail: 'The agent key is no longer in this page, so it cannot declare its own inbox. Make a new key and do this before saving it.' }
  }

  const writePool = openPool()
  try {
    await writePool.publish(targets, signed, { onauth: sign })
  } catch (e) {
    return { ok: false, step: 'publish', outcome: 'refused', proven: false, detail: String(e && e.message || e) }
  } finally { writePool.close(targets) }

  // waggle looks for this on its own read relays, so proving it exists on ours is the closest this
  // page can get. Cold, and from a second connection, for the same reason as everything else here.
  const readPool = openPool()
  let found = null
  try {
    found = await readPool.get(targets, { kinds: [10050], authors: [pk] }, { onauth: sign })
  } catch (e) {
    return { ok: false, step: 'readback', outcome: 'unreadable', proven: false,
      detail: `The inbox was accepted but could not be read back: ${String(e && e.message || e)}` }
  } finally { readPool.close(targets) }

  if (!found) {
    return { ok: false, step: 'readback', outcome: 'not_served', proven: false,
      detail: 'The relays accepted the inbox declaration and then would not serve it back, so nothing can be delivered to this key yet.' }
  }
  if (found.id !== signed.id) {
    return { ok: false, step: 'readback', outcome: 'stale', proven: false,
      detail: 'An older inbox declaration was served back instead of the one just published.' }
  }
  return {
    ok: true, step: 'readback', outcome: 'reachable', proven: true, relays,
    detail: 'Inbox declared and read back cold — waggle can now deliver to this key.',
  }
}
