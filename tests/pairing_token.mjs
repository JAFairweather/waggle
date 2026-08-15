// pairing_token.mjs — the one artifact in the ceremony that carries a credential.
//
// Everything here is written against the failure that would not announce itself. A token that
// pairs the wrong session still pairs a session; a token carrying an nsec still works; a URI read
// twice still connects. All three look like success, which is why every refusal below is paired
// with a legitimate value still getting through, and why the reasons are asserted rather than
// only the refusals — `!ok` cannot tell a correct refusal from a correct refusal with a
// misleading explanation, and the explanation is what the owner acts on.
//
//   node tests/pairing_token.mjs

import { buildPairingToken, readPairingToken, pairingUriFault, PAIRING_TOKEN_KIND } from '../src/pairing_token.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const refuses = (label, fn, pattern) => {
  try { fn(); check(false, `${label} (did not throw)`) }
  catch (e) { check(pattern.test(e.message), `${label}${pattern.test(e.message) ? '' : ` — wrong reason: ${e.message}`}`) }
}

const RID = 'a'.repeat(64)
const OTHER_RID = 'b'.repeat(64)
const IDENTITY = 'c'.repeat(64)
const SIGNER = 'd'.repeat(64)
const URI = `bunker://${SIGNER}?relay=wss%3A%2F%2Frelay.example&secret=deadbeef`
const NOW = 1_800_000_000
const EXP = NOW + 300

const build = (over = {}) => buildPairingToken({ requestId: RID, identityPubkey: IDENTITY, pairingUri: URI, expiresAt: EXP, ...over })
const read = (text, over = {}) => readPairingToken(text, { requestId: RID, now: NOW, ...over })

// ── 1. The happy path, first, so everything after it is a departure from something that works ──
{
  const sealed = build()
  const body = JSON.parse(sealed)
  check(body.v === 1 && body.rid === RID && body.a === IDENTITY, 'a built token names its version, its request and the identity it pairs')
  check(body.exp === EXP, 'and its expiry, because an unbounded pairing token is a standing credential')

  const got = read(sealed)
  check(got.ok === true, 'NEGATIVE CONTROL — a well-formed token for THIS request opens, so the reader is not simply refusing everything')
  check(got.identityPubkey === IDENTITY, 'and reports the identity the owner approved')
  check(got.pairing.take() === URI, 'and yields the pairing URI itself, byte-for-byte')
  check(PAIRING_TOKEN_KIND === 27494, 'the kind sits in the ephemeral range beside the join request')
}

// ── 2. Take-once. A value that can be read twice is a value that reaches a log the second time ──
{
  const got = read(build())
  check(got.ok && got.pairing.taken() === false, 'a freshly opened token has not been spent')
  const first = got.pairing.take()
  check(first === URI, 'the first take yields the pairing')
  check(got.pairing.take() === null, 'and the SECOND take yields null, not a copy — "shown once" is a property, not a promise')
  check(got.pairing.taken() === true, 'and the container says so')

  const dropped = read(build())
  check(dropped.ok, 'a token opened and never taken is still valid')
  dropped.pairing.forget()
  check(dropped.pairing.take() === null, 'forget() discards it without anyone reading it — the abandon path leaves nothing behind')
}

// ── 3. Bound to the request. The failure here pairs a session the owner never approved ─────────
{
  const forOther = buildPairingToken({ requestId: OTHER_RID, identityPubkey: IDENTITY, pairingUri: URI, expiresAt: EXP })
  const got = read(forOther)
  check(got.ok === false, 'a token minted for a DIFFERENT join request is refused')
  check(/different join request/.test(got.reason || ''), 'and the reason says so, rather than "malformed"')
  check(!(got.reason || '').includes(OTHER_RID), 'and does not echo the token’s own request id — that field is attacker-supplied')

  // The check must use the id the session SENT, not one read out of the token.
  const selfChecked = readPairingToken(forOther, { requestId: OTHER_RID, now: NOW })
  check(selfChecked.ok === true, 'NEGATIVE CONTROL — that same token DOES open for the session that actually sent that request')

  const noRid = read(JSON.stringify({ v: 1, a: IDENTITY, uri: URI, exp: EXP }))
  check(noRid.ok === false && /names no request/.test(noRid.reason), 'a token naming no request at all is refused for that reason')
  check(read(build(), { requestId: 'not-hex' }).ok === false, 'and a caller that cannot say which request it sent gets nothing')
}

// ── 4. An nsec where the pairing goes. This one works if it is not caught, which is the danger ──
{
  const NSEC = 'nsec1' + 'q'.repeat(58)
  refuses('sealing an nsec as a pairing is refused', () => build({ pairingUri: NSEC }), /nsec/)
  refuses('and the refusal says the session must hold a pairing, never the identity',
    () => build({ pairingUri: NSEC }), /never the identity itself/)
  check(/nsec/.test(pairingUriFault(NSEC)), 'pairingUriFault names it as an nsec at the unit level too')
  check(/encrypted nsec/.test(pairingUriFault('ncryptsec1' + 'q'.repeat(40))), 'an encrypted nsec gets its own name')
  check(/other way/.test(pairingUriFault('nostrconnect://' + SIGNER)), 'a nostrconnect:// URI is named as pointing the other way, not as a typo')

  const smuggled = read(JSON.stringify({ v: 1, rid: RID, a: IDENTITY, uri: NSEC, exp: EXP }))
  check(smuggled.ok === false, 'and a token that arrives carrying an nsec is refused on READ as well as on build')
  check(/never the identity itself/.test(smuggled.reason || ''), 'with the same reason, because the reader is the side that cannot trust the sender')

  // Both directions: the guard must still pass the thing it exists to allow.
  check(pairingUriFault(URI) !== null && read(build()).ok === true,
    'NEGATIVE CONTROL — a real bunker:// pairing is still accepted, so the screen is not refusing every URI')
}

// ── 5. Expiry ──────────────────────────────────────────────────────────────────────────────────
{
  const got = read(build(), { now: EXP })
  check(got.ok === false && /expired/.test(got.reason), 'a token is refused at the instant it expires, not one second after')
  check(read(build(), { now: EXP - 1 }).ok === true, 'NEGATIVE CONTROL — one second earlier it still opens')
  refuses('an unbounded token cannot be built at all', () => build({ expiresAt: undefined }), /must expire/)
  const noExp = read(JSON.stringify({ v: 1, rid: RID, a: IDENTITY, uri: URI }))
  check(noExp.ok === false && /no expiry/.test(noExp.reason), 'and one that arrives without an expiry is refused for that reason')
}

// ── 6. Shape. A field this build does not understand must not ride along unexamined ───────────
{
  const extra = read(JSON.stringify({ v: 1, rid: RID, a: IDENTITY, uri: URI, exp: EXP, scope: 'admit+read' }))
  check(extra.ok === false, 'a token carrying an unknown field is refused rather than having the field ignored')
  check(/scope/.test(extra.reason || ''), 'and the refusal names the field, so the operator knows which one')

  const v2 = read(JSON.stringify({ v: 2, rid: RID, a: IDENTITY, uri: URI, exp: EXP }))
  check(v2.ok === false && /is not 1/.test(v2.reason), 'a version this build does not speak is refused')
  check(read('not json').ok === false, 'text that is not JSON is refused')
  check(read('[]').ok === false, 'a JSON array is not an object and is refused')
  check(read('').ok === false, 'and an empty token is refused rather than treated as an empty object')

  const noId = read(JSON.stringify({ v: 1, rid: RID, a: 'nope', uri: URI, exp: EXP }))
  check(noId.ok === false && /no 64-hex identity/.test(noId.reason), 'a token naming no usable identity is refused')
  refuses('and one cannot be built either', () => build({ identityPubkey: 'nope' }), /64-hex identity/)

  // The refusal names the field because that is what makes it actionable — but the names are
  // attacker-supplied and the line is the one a person reads, so it is BOUNDED. Rule 2 refuses to
  // echo the token's own rid for the same reason; this is that rule applied twenty lines up.
  const body = { v: 1, rid: RID, a: IDENTITY, uri: URI, exp: EXP }
  for (let i = 0; i < 40; i++) body[`junk${String(i).padStart(2, '0')}`] = 1
  const many = read(JSON.stringify(body))
  check(many.ok === false, '40 unknown fields are refused')
  check(/40 fields/.test(many.reason), 'and the COUNT is reported, so nothing is hidden by the cap')
  check((many.reason.match(/junk/g) || []).length === 4, 'but only four are echoed, not forty')
  check(/and 36 more/.test(many.reason), 'with the remainder counted rather than dropped silently')
  check(many.reason.length < 200, `the whole line stays short (${many.reason.length} chars) — a token cannot use it as a canvas`)

  const longKey = 'x'.repeat(400)
  const clipped = read(JSON.stringify({ v: 1, rid: RID, a: IDENTITY, uri: URI, exp: EXP, [longKey]: 1 }))
  check(clipped.ok === false && clipped.reason.length < 120,
    `a single 400-char field name is clipped, not echoed whole (${clipped.reason.length} chars)`)
  check(/…/.test(clipped.reason), 'and the clip is visible, so the reader knows the name was truncated')

  // NEGATIVE CONTROL for the cap: the common case is ONE typo'd field, and it must still be named
  // in full. A bound that hid the useful case would be a worse bug than the one it fixed.
  const typo = read(JSON.stringify({ v: 1, rid: RID, a: IDENTITY, uri: URI, expp: EXP }))
  check(typo.ok === false && /expp/.test(typo.reason) && /1 field/.test(typo.reason),
    'NEGATIVE CONTROL — one mistyped field is still named in full and counted as 1')
}

// ── 7. Opening is not proof of custody, and the result must say so ────────────────────────────
{
  const got = read(build())
  check(got.custodyUnproven === true,
    'an opened token declares that custody is still UNPROVEN — possession of a URI is not control, and the caller owes a challenge before writing anything')
  check(!Object.prototype.hasOwnProperty.call(got, 'uri') && !Object.prototype.hasOwnProperty.call(got, 'pairingUri'),
    'and the plaintext URI is on no plain field of the result, so it cannot reach a log by being spread or stringified')
  check(!JSON.stringify(got).includes(SIGNER),
    'JSON.stringify of the whole result does not contain the pairing — the container survives the laziest possible logging')
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
