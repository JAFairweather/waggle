// scope_hash.mjs — the construction that binds a grant to its subject, held against reality.
//
// A NIP-DA grant never names its subject. It carries sha256("waggle/da-scope/v1" || 0x00 ||
// subject || salt) with a fresh salt per grant. The construction was hand-written in three places
// — the issuer (tools/grant.mjs, node:crypto), the reader (console/index.html, WebCrypto), and
// nearly a third time in console/connect.html.
//
// Why that is dangerous in a way most duplication is not: **both failure modes are silent, and
// both produce a hash.**
//
//   * issuer drifts  → every grant it signs binds to a subject nothing can match. It verifies, it
//                      goes live, it admits nobody, forever.
//   * reader drifts  → live grants stop resolving in that surface while staying valid everywhere
//                      else, so the console shows an admitted agent as unadmitted.
//
// Neither raises an error. One hash looks exactly like another. So this suite does three things
// that a same-file self-check cannot:
//
//   1. compares the shared module against an INDEPENDENT node:crypto implementation, written out
//      longhand here rather than imported, so a bug in the module cannot hide by being shared
//   2. asserts the exact byte layout, so "it matches the other copy" cannot pass while both are
//      wrong in the same way
//   3. checks a LIVE VECTOR — the hash and salt from a grant signed by tools/grant.mjs and sitting
//      on the relays right now. Agreeing with ourselves is not the same as agreeing with what was
//      already signed, and only the third catches the case where every copy drifted together.
//
//   node tests/scope_hash.mjs

import { createHash } from 'node:crypto'
import { scopeHash, scopePreimage, SCOPE_LABEL } from '../console/scope-hash.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

// An independent implementation. Deliberately NOT importing anything from the module under test —
// a shared helper would let one bug satisfy both sides.
const reference = (subject, saltHex) => createHash('sha256').update(Buffer.concat([
  Buffer.from('waggle/da-scope/v1'),
  Buffer.from([0]),
  Buffer.from(subject),
  Buffer.from(saltHex, 'hex'),
])).digest('hex')

const OLIVER = 'ebc6eec1a7c36304c8093d2f60337045b60678e858fe3997eb9740215bfdd2f3'
const CHANNEL = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
const SALT = '5463a4e15781cbc705aedafa0423b08d'

// ── 1. The module agrees with an independent implementation ─────────────────────────────────
for (const [name, subject] of [['an agent pubkey', OLIVER], ['a channel uuid', CHANNEL]]) {
  const mine = await scopeHash(subject, SALT)
  check(mine === reference(subject, SALT), `${name}: matches an independent node:crypto implementation`)
  check(/^[0-9a-f]{64}$/.test(mine), `${name}: produces 64 lowercase hex`)
}

// ── 2. The byte layout, asserted rather than assumed ────────────────────────────────────────
{
  const buf = scopePreimage(OLIVER, SALT)
  const label = Buffer.from(SCOPE_LABEL)
  check(SCOPE_LABEL === 'waggle/da-scope/v1', 'the domain label is exactly "waggle/da-scope/v1"')
  check(Buffer.from(buf.slice(0, label.length)).equals(label), 'the label comes first')
  check(buf[label.length] === 0, 'followed by a single 0x00 separator')
  check(Buffer.from(buf.slice(label.length + 1, label.length + 1 + OLIVER.length)).toString() === OLIVER,
    'then the subject, as its UTF-8 bytes exactly as given')
  check(Buffer.from(buf.slice(label.length + 1 + OLIVER.length)).toString('hex') === SALT,
    'then the salt, raw bytes, last')
  check(buf.length === label.length + 1 + OLIVER.length + 16, 'and nothing else — 16-byte salt, no padding')
}

// ── 3. A LIVE VECTOR ────────────────────────────────────────────────────────────────────────
// Grant 01a41ce2d42a0a7c22e70342ea93bc5693180bfe11ec275c235afd0a3e13d80d, cap `task`, signed by
// tools/grant.mjs on 2026-08-09 and readable on relay.primal.net. Its subject is the agent below.
// If every copy of the construction drifted together, checks 1 and 2 would still pass and this is
// the only one that would not.
{
  const LIVE_HASH = 'b6c00312269a4dab018e32de4102ffcdb57434d18c88d84619fd1030ee809911'
  const LIVE_SALT = '5463a4e15781cbc705aedafa0423b08d'
  const computed = await scopeHash(OLIVER, LIVE_SALT)
  check(computed === LIVE_HASH,
    'LIVE VECTOR — recomputes the scope hash of a grant that is signed and on the relays right now')
}

// ── The subject is hashed as given, which is a real footgun ─────────────────────────────────
// tools/grant.mjs normalises npub → hex before hashing. A caller that forgets would hash the npub,
// produce a perfectly valid grant, and match nothing — the exact silent failure above.
{
  const npub = 'npub1a0rwasd8cd3sfjqf85hkqvmsgkmqv78gtrlrn9ltjaqzzkla6teswzz855'
  const asNpub = await scopeHash(npub, SALT)
  const asHex = await scopeHash(OLIVER, SALT)
  check(asNpub !== asHex,
    'hashing an npub gives a DIFFERENT hash than hashing its hex — callers must normalise first')
  check(/^[0-9a-f]{64}$/.test(asNpub),
    'and it still returns a well-formed hash, which is why this failure is silent')
}

// ── Salt handling ───────────────────────────────────────────────────────────────────────────
{
  const a = await scopeHash(OLIVER, SALT)
  const b = await scopeHash(OLIVER, '00000000000000000000000000000000')
  check(a !== b, 'a different salt gives a different hash — which is what makes two grants unlinkable')
  let threw = ''
  try { await scopeHash(OLIVER, 'not-hex') } catch (e) { threw = e.message }
  check(/hex/.test(threw), `a malformed salt throws rather than silently hashing garbage: ${threw}`)
}

// ── DIFFERENTIAL MATRIX vs THE ISSUER ───────────────────────────────────────────────────────
// Raised in review: this module and tools/grant.mjs must agree on every input the issue path can
// produce, and where they diverge the divergence must be understood rather than discovered later.
//
// The issue path always produces a 16-byte CSPRNG salt as lowercase hex, so the malformed cases
// below are unreachable *from there*. They stop being unreachable the moment this function is used
// to VERIFY a salt that arrived from the wire — which tools/grant.mjs:216 already does when it
// recomputes from `tag[2]`. So the behaviour is pinned now, before that call site is ported.
{
  const issuer = (subject, saltHex) => {
    try {
      return createHash('sha256').update(Buffer.concat([
        Buffer.from('waggle/da-scope/v1'), Buffer.from([0]),
        Buffer.from(subject), Buffer.from(saltHex, 'hex')])).digest('hex')
    } catch (e) { return `THREW:${e.constructor.name}` }
  }
  const mine = async (subject, saltHex) => {
    try { return await scopeHash(subject, saltHex) } catch (e) { return `THREW:${e.constructor.name}` }
  }

  // Reachable from the issue path — these MUST agree.
  const reachable = [
    ['lowercase hex subject, 16-byte salt', OLIVER, SALT],
    ['channel uuid subject', CHANNEL, SALT],
    ['all-zero salt', OLIVER, '0'.repeat(32)],
    ['all-f salt', OLIVER, 'f'.repeat(32)],
  ]
  for (const [label, subject, salt] of reachable) {
    const a = issuer(subject, salt), b = await mine(subject, salt)
    check(a === b && !a.startsWith('THREW'), `${label}: issuer and this module agree (${String(a).slice(0, 12)}…)`)
  }

  // NOT reachable from the issue path. Pinned deliberately, and this module is the LOUDER of the
  // two on every one of them — a malformed salt raises instead of hashing something plausible.
  // That asymmetry is the point: silently agreeing on garbage is how a verify path ships a hash
  // that matches nothing and says nothing.
  const malformed = [
    ['empty salt', ''],
    ['odd-length salt', 'abc'],
    ['non-hex salt', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
  ]
  for (const [label, salt] of malformed) {
    const a = issuer(OLIVER, salt), b = await mine(OLIVER, salt)
    if (salt === '') {
      check(a === b, `${label}: both produce the same hash — an empty salt is well-defined on both sides`)
    } else {
      check(String(b).startsWith('THREW') && !String(a).startsWith('THREW'),
        `${label}: this module REFUSES where the issuer silently hashes something (${String(a).slice(0, 12)}…)`)
    }
  }

  // Case, which is the failure that actually shipped in this PR — on the plan side, not here.
  // Recorded from this end too, so the reason the planner lowercases is visible from both files.
  const upper = await scopeHash(OLIVER.toUpperCase(), SALT)
  const lower = await scopeHash(OLIVER, SALT)
  check(upper !== lower,
    'an UPPERCASE subject hashes differently — this is why console/connect-plan.mjs lowercases at the boundary')
  check(issuer(OLIVER.toUpperCase(), SALT) === upper,
    'and the issuer agrees on the uppercase hash too, so the divergence is in the CALLER, never here')
}

// ── NEGATIVE CONTROL ────────────────────────────────────────────────────────────────────────
// Every comparison above has only been asked to agree. Prove the comparison can see a drift, by
// running it against constructions that are wrong in the three most plausible ways.
{
  const noSeparator = createHash('sha256').update(Buffer.concat([
    Buffer.from('waggle/da-scope/v1'), Buffer.from(OLIVER), Buffer.from(SALT, 'hex')])).digest('hex')
  const wrongLabel = createHash('sha256').update(Buffer.concat([
    Buffer.from('waggle/da-scope/v2'), Buffer.from([0]), Buffer.from(OLIVER), Buffer.from(SALT, 'hex')])).digest('hex')
  const saltFirst = createHash('sha256').update(Buffer.concat([
    Buffer.from('waggle/da-scope/v1'), Buffer.from([0]), Buffer.from(SALT, 'hex'), Buffer.from(OLIVER)])).digest('hex')
  const real = await scopeHash(OLIVER, SALT)
  check(real !== noSeparator, 'NEGATIVE CONTROL — a dropped 0x00 separator is DETECTED')
  check(real !== wrongLabel, 'NEGATIVE CONTROL — a changed domain label is DETECTED')
  check(real !== saltFirst, 'NEGATIVE CONTROL — salt and subject swapped is DETECTED')
  check(real === reference(OLIVER, SALT),
    'and the real construction still agrees, so the controls are not passing because everything differs')
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
