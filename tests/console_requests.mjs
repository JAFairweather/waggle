// console_requests.mjs — the console's pending-request reader (#186, #141 piece 1).
//
// What this guards: the console renders admission requests that arrive as gift-wrapped DMs from
// STRANGERS. Anyone can wrap a DM to any npub, so every field here is attacker-chosen, and the
// only things standing between a forged request and the operator's signer are the two provenance
// checks in console/requests.mjs.
//
// The rule this suite is written to obey (CLAUDE.md, earned by a live outage): assert the
// property, not the mechanism, and assert BOTH directions. A parser that rejects the forgery is
// worthless if it also rejects the real request — that is precisely the shape of the bug that
// silently dropped every message to "My Dude". So every refusal assertion below is paired with a
// legitimate value that must still get through, and the fixtures use production-shaped strings
// (spaces, punctuation, markup characters) rather than "A" and "B".

import { finalizeEvent, generateSecretKey, getPublicKey, getEventHash, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import * as nip19 from 'nostr-tools/nip19'
import { parseRequest, readRequests, KIND } from '../console/requests.mjs'

let fails = 0
const ok = (name, cond, detail = '') => {
  if (cond) return console.log(`  ok   ${name}`)
  fails++
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('console pending requests (#186)')

// --- the maintainer, and a signer-shaped decrypt over their key ---------------------------------
const maintSk = generateSecretKey()
const maintPk = getPublicKey(maintSk)
// Mirrors the console's signer contract exactly: (senderPubkey, ciphertext) => plaintext.
const decrypt = async (pk, ct) => nip44.decrypt(ct, nip44.getConversationKey(maintSk, pk))
const deps = { decrypt, verifyEvent, decodeNpub: nip19.decode }

// Build a wrap the way request-admission.mjs does: rumor -> seal(13) -> wrap(1059).
// `opts.forgeRumorPubkey` and `opts.breakSeal` let a test bend exactly one link at a time.
function wrapFor(senderSk, body, opts = {}) {
  const senderPk = getPublicKey(senderSk)
  const now = Math.floor(Date.now() / 1000)
  const rumor = {
    kind: opts.rumorKind ?? KIND.dm,
    pubkey: opts.forgeRumorPubkey ?? senderPk,
    created_at: now,
    tags: [['p', maintPk]],
    content: typeof body === 'string' ? body : JSON.stringify(body),
  }
  rumor.id = getEventHash(rumor)
  let seal = finalizeEvent({
    kind: KIND.seal, created_at: now, tags: [],
    content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(senderSk, maintPk)),
  }, senderSk)
  if (opts.breakSeal) seal = { ...seal, sig: seal.sig.replace(/^../, seal.sig.startsWith('00') ? 'ff' : '00') }
  const wsk = generateSecretKey()
  return finalizeEvent({
    kind: KIND.wrap, created_at: now, tags: [['p', maintPk]],
    content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wsk, maintPk)),
  }, wsk)
}

const sessionSk = generateSecretKey()
const sessionPk = getPublicKey(sessionSk)
const CHANNEL = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
// A production-shaped purpose: spaces, an apostrophe, a hash, an angle bracket. If the parser or
// the renderer only ever saw "test", neither would be exercised the way real input exercises them.
const PURPOSE = "review #140's egress design with the crew <please>"

// --- 1. THE LEGITIMATE REQUEST MUST GET THROUGH -------------------------------------------------
// First, and deliberately first: every refusal below is only meaningful because this passes.
{
  const w = wrapFor(sessionSk, {
    type: 'access_request', npub: nip19.npubEncode(sessionPk),
    channel: CHANNEL, cap: 'admit', purpose: PURPOSE,
  })
  const r = await parseRequest(w, deps)
  ok('a well-formed request parses', !!r)
  ok('  sender is the seal signer', r?.from === sessionPk)
  ok('  grantee is the session key', r?.grantee === sessionPk)
  ok('  grantee is flagged as the sender', r?.granteeIsSender === true)
  ok('  channel survives verbatim', r?.channel === CHANNEL)
  ok('  cap defaults to admit', r?.cap === 'admit')
  ok('  purpose survives verbatim, punctuation and all', r?.purpose === PURPOSE,
    `got ${JSON.stringify(r?.purpose)}`)
}

// --- 2. THE OTHER VOCABULARY MUST ALSO GET THROUGH ----------------------------------------------
// This is the whole point of #186: one event, both consoles. If this regresses, waggle's own tool
// stops being readable here and the dual-surface claim quietly becomes false.
{
  const w = wrapFor(sessionSk, {
    type: 'waggle_admission_request', v: 1, npub: nip19.npubEncode(sessionPk),
    channel: CHANNEL, cap: 'admit', purpose: PURPOSE, ts: 1,
  }, { rumorKind: KIND.dm })
  ok('a waggle_admission_request parses (the legacy vocabulary)', !!(await parseRequest(w, deps)))
}
{
  const w = wrapFor(sessionSk, {
    type: 'access_request', channel: CHANNEL, purpose: PURPOSE,
  }, { rumorKind: KIND.nvoyMsg })
  const r = await parseRequest(w, deps)
  ok('an nvoy 24440 notice parses (the nvoy vocabulary)', !!r)
  ok('  a body with no npub falls back to the sender', r?.grantee === sessionPk)
}

// --- 3. FORGED SENDER — the check that matters --------------------------------------------------
{
  const impostorSk = generateSecretKey()
  const w = wrapFor(impostorSk, {
    type: 'access_request', channel: CHANNEL, purpose: PURPOSE,
  }, { forgeRumorPubkey: sessionPk })          // claims to be the session key; sealed by someone else
  ok('a rumor whose author != the seal signer is refused', (await parseRequest(w, deps)) === null)
}
{
  const w = wrapFor(sessionSk, { type: 'access_request', channel: CHANNEL, purpose: PURPOSE },
    { breakSeal: true })
  ok('a seal with a broken signature is refused', (await parseRequest(w, deps)) === null)
}

// --- 4. NOT-A-REQUEST must not become one -------------------------------------------------------
// An ordinary DM is the common case here, not an edge case: the maintainer's inbox is full of
// them. Rendering one as a pending admission would be an invitation to grant on nonsense.
{
  const chat = wrapFor(sessionSk, { type: 'chat', message: 'morning' })
  ok('an ordinary DM is not a request', (await parseRequest(chat, deps)) === null)
  const plain = wrapFor(sessionSk, 'just some text, not even JSON')
  ok('a non-JSON DM is not a request', (await parseRequest(plain, deps)) === null)
  const noPurpose = wrapFor(sessionSk, { type: 'access_request', channel: CHANNEL })
  ok('a request with no purpose is refused', (await parseRequest(noPurpose, deps)) === null)
  const blank = wrapFor(sessionSk, { type: 'access_request', channel: CHANNEL, purpose: '   ' })
  ok('a request with a blank purpose is refused', (await parseRequest(blank, deps)) === null)
}

// --- 5. THIRD-PARTY GRANTEE — kept, but flagged -------------------------------------------------
// The asker is not always the beneficiary, and that is legitimate (a runtime asking on an agent's
// behalf). What must never happen is it looking identical to asking for yourself.
{
  const otherPk = getPublicKey(generateSecretKey())
  const w = wrapFor(sessionSk, {
    type: 'access_request', npub: nip19.npubEncode(otherPk),
    channel: CHANNEL, purpose: PURPOSE,
  })
  const r = await parseRequest(w, deps)
  ok('a request naming a third-party grantee is kept', !!r)
  ok('  …and is flagged as not-the-sender', r?.granteeIsSender === false)
  ok('  …with the third party as the grantee', r?.grantee === otherPk)
}
{
  const w = wrapFor(sessionSk, {
    type: 'access_request', npub: 'npub1obviously-not-valid', channel: CHANNEL, purpose: PURPOSE,
  })
  ok('a malformed npub is refused, not silently coerced to the sender',
    (await parseRequest(w, deps)) === null)
}

// --- 6. A WRAP WE CANNOT OPEN IS NOT AN ABSENCE -------------------------------------------------
// The failure this pairs with is the one nvoy left a comment about and CLAUDE.md states as a rule:
// "being unable to check is not the same as being fine". A batch that silently yields 0 requests
// after failing to decrypt everything reports our eyesight, not the world.
{
  const stranger = generateSecretKey()
  const notForUs = (() => {          // sealed to someone else entirely: our decrypt cannot open it
    const otherPk = getPublicKey(generateSecretKey())
    const wsk = generateSecretKey()
    return finalizeEvent({
      kind: KIND.wrap, created_at: 1, tags: [['p', otherPk]],
      content: nip44.encrypt('{}', nip44.getConversationKey(wsk, otherPk)),
    }, wsk)
  })()
  const good = wrapFor(stranger, { type: 'access_request', channel: CHANNEL, purpose: PURPOSE })
  const { requests, skipped } = await readRequests([notForUs, good], deps)
  ok('a batch reports the request it could read', requests.length === 1)
  ok('  …and counts the wrap it could not, rather than hiding it', skipped === 1)
}

// --- 6b. NVOY'S OWN TRAFFIC IS SPLIT OUT, NOT MISLABELLED ---------------------------------------
// Found by looking at the rendered page, not the code. Reading nvoy's vocabulary is what lets one
// request serve both consoles — and it means this console also sees nvoy's credential delegations.
// Those are real, readable access_requests that are NOT channel admissions; rendering them as
// "asks to be admitted" above a button that issues a CHANNEL grant is a label that does not match
// what the button does. Both directions asserted: the admission still gets through.
{
  const nvoyish = wrapFor(generateSecretKey(), {
    type: 'access_request', scope_name: 'gemini-api-key',
    purpose: 'Gemini API key for the PRIMARY engine model — proxied egress (M6)',
  })
  const admission = wrapFor(sessionSk, { type: 'access_request', channel: CHANNEL, purpose: PURPOSE })
  const { requests, other } = await readRequests([nvoyish, admission], deps)
  ok('a channel admission still lands in requests', requests.length === 1)
  ok('  …and it is the one naming a channel', requests[0]?.channel === CHANNEL)
  ok('an nvoy credential request does NOT land in requests',
    !requests.some(r => /Gemini/.test(r.purpose)))
  ok('  …it is reported in `other`, never silently dropped', other.length === 1)
  ok('  …with its purpose intact, so the count can be explained', /Gemini/.test(other[0]?.purpose || ''))
}

// --- 7. ORDERING ---------------------------------------------------------------------------------
{
  const a = wrapFor(generateSecretKey(), { type: 'access_request', channel: CHANNEL, purpose: 'older' })
  const b = wrapFor(generateSecretKey(), { type: 'access_request', channel: CHANNEL, purpose: 'newer' })
  // created_at is stamped by the sender, so equal timestamps are normal; assert the sort is stable
  // and total rather than asserting a specific order it cannot guarantee.
  const { requests } = await readRequests([a, b], deps)
  ok('every readable request in a batch is returned', requests.length === 2)
  ok('  …newest first', requests[0].at >= requests[1].at)
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
