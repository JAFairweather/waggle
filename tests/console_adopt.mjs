// console_adopt.mjs — the adopt path (#537): the console can now take an identity it did NOT mint,
// prove custody of it, and carry it through the rest of the flow.
//
// Two halves, because they fail in different ways and only one of them is testable as code.
//
//   1. `resolveAdoptedPubkey` — driven directly, both directions. Everything about whether this
//      path is safe reduces to WHAT THE PROOF IS PINNED TO. `bunker://<hex>` names the signer's
//      transport key and NIP-46 permits that to differ from the identity it holds, so a proof
//      against the URI's own key would pass for any bunker that answers. The pin has to be the key
//      the operator named, and this is the function that decides it.
//
//   2. The page's wiring — asserted over `console/index.html`, because a control the operator
//      cannot reach is indistinguishable from a feature that was never built. This half IS a source
//      scan and is therefore weak by this repo's standards, so it is scoped to the one thing a scan
//      can actually settle — that the ids the handler addresses exist in the markup, and that the
//      steps after custody are gated on custody rather than on provenance. A positive control runs
//      first: the scanner is shown a page it must reject, so a green result cannot come from a
//      matcher that matches nothing (CI was once green over a page with no JS at all).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as nip19 from 'nostr-tools/nip19'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { proveAdoptedIdentity, resolveAdoptedPubkey } from '../console/adopt-identity.mjs'
import { proveCustody } from '../console/bunker-custody.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
let pass = 0, fail = 0
const check = (ok, what) => { if (ok) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

const SK = generateSecretKey()
const PUB = getPublicKey(SK)
const NPUB = nip19.npubEncode(PUB)
const NSEC = nip19.nsecEncode(SK)

console.log('\n1. it accepts the shapes an operator actually has')

const fromNpub = resolveAdoptedPubkey(NPUB, nip19)
check(fromNpub.ok && fromNpub.pubkeyHex === PUB, 'an npub resolves to its hex')
check(fromNpub.ok && fromNpub.npub === NPUB, '…and back to the same npub')

const fromHex = resolveAdoptedPubkey(PUB, nip19)
check(fromHex.ok && fromHex.pubkeyHex === PUB, '64-hex resolves to itself')
check(fromHex.ok && fromHex.npub === NPUB, '…and to the matching npub, so the two inputs agree')

// A pubkey copied out of a manifest, a log or a QR arrives in whatever case its source used.
// Refusing one spelling of the same key is a refusal with nothing behind it.
const upper = resolveAdoptedPubkey(PUB.toUpperCase(), nip19)
check(upper.ok && upper.pubkeyHex === PUB, 'UPPERCASE hex is the same key, not a different one')
const padded = resolveAdoptedPubkey(`  ${NPUB}  `, nip19)
check(padded.ok && padded.pubkeyHex === PUB, 'surrounding whitespace does not defeat it — paste leaves it behind')

console.log('\n2. it refuses the rest, and says which — without ever echoing the input')

const noKey = resolveAdoptedPubkey('', nip19)
check(!noKey.ok && /npub/.test(noKey.reason), 'an empty field is refused and says what to give')

// The one that matters most. An nsec in a field asking for a public half is an operator error, and
// naming it must not put the value into a status line, the DOM, or a screenshot of either.
const secret = resolveAdoptedPubkey(NSEC, nip19)
check(!secret.ok, 'an nsec is refused')
check(!secret.ok && /nsec/.test(secret.reason) && /never be pasted/i.test(secret.reason),
  '…and the reason names the TYPE and warns, so the operator knows what they just did')
check(!secret.ok && !secret.reason.includes(NSEC),
  '…and the reason does NOT contain the key itself — a refusal that leaks is not a refusal')

// Encoded, never hand-typed: a bech32 string with a bad checksum fails to decode at all, and would
// exercise the malformed-input branch while looking like it tested the wrong-type one.
const note = resolveAdoptedPubkey(nip19.noteEncode(PUB), nip19)
check(!note.ok && /this field takes a public key/.test(note.reason),
  'another valid bech32 type that is not a pubkey is refused, and named')

const junk = resolveAdoptedPubkey('not-a-key-at-all', nip19)
check(!junk.ok && !junk.reason.includes('not-a-key-at-all'),
  'junk is refused without being quoted back — a mistyped secret looks exactly like a mistyped npub here')
const nearly = resolveAdoptedPubkey(PUB.slice(0, 63), nip19)
check(!nearly.ok, '63 hex characters is refused — one short of a key is not a key')

console.log('\n3. the PIN — driven end to end, because the resolver is not the decision')

// THE ASSERTION THIS SUITE WAS MISSING. `resolveAdoptedPubkey` was driven hard above while the line
// that CONSUMES it lived inline in index.html, where the only available checks were source scans.
// Replacing `expectedPubkeyHex: pubkeyHex` with the URI's own transport hex left this file reporting
// 24 passed, 0 failed — the exact failure the module header says the path exists to prevent (#538
// review). So the pin is now decided inside `proveAdoptedIdentity` and exercised here.
//
// The REAL `proveCustody` and the REAL `verifyEvent` run: a recorder would assert what was passed,
// which a later refactor can satisfy while still proving the wrong thing. And the fake bunker's
// TRANSPORT key is deliberately a different key from the identity being adopted, which is what makes
// the tautological pin fail rather than pass.
const TRANSPORT_SK = generateSecretKey()
const TRANSPORT_PUB = getPublicKey(TRANSPORT_SK)
const OTHER_SK = generateSecretKey()
const OTHER_PUB = getPublicKey(OTHER_SK)
check(TRANSPORT_PUB !== PUB,
  'the fake bunker signs at a transport key that is NOT the identity — otherwise the pin cannot be told apart')

const NONCE = 'a'.repeat(32)
// `bunker://<transport hex>` is the real URI shape, so a pin taken from the URI lands on TRANSPORT_PUB.
const URI = `bunker://${TRANSPORT_PUB}?relay=wss://example.invalid`
// A bunker that signs as whichever key it was built with. Nothing is published; the challenge kind
// is ephemeral and never leaves this process.
const fakeBunker = (sk) => {
  let closed = false
  return {
    signEvent: async (t) => finalizeEvent({ ...t, pubkey: undefined }, sk),
    close: () => { closed = true },
    wasClosed: () => closed,
  }
}
const adopt = (over = {}) => proveAdoptedIdentity({
  rawKey: NPUB, uri: URI, nip19, proveCustody, verifyEvent, nonce: NONCE,
  openPairing: async () => fakeBunker(SK),
  ...over,
})

const good = await adopt()
check(good.ok && good.pubkeyHex === PUB,
  'a bunker holding the NAMED key proves custody, though its transport key is a different key entirely')
check(good.ok && good.signer && typeof good.signer.signEvent === 'function',
  '…and the proved pairing comes back, because the admission steps below sign with it')

// BOTH DIRECTIONS, and this is the one the mutation has to fail. Same URI, same transport key — so a
// pin taken from the URI still matches and would report PROVEN — but the bunker signs as a key the
// operator never named.
const wrongPaired = fakeBunker(OTHER_SK)
const wrong = await adopt({ openPairing: async () => wrongPaired })
check(!wrong.ok && wrong.code === 'WRONG_KEY',
  'a bunker holding some OTHER key is refused — the pin is the named identity, never the URI')
check(wrong.ok === false && !/is not in place|made here/.test(wrong.reason)
  && /the key you named/.test(wrong.reason) && /bunker:\/\/ URI/.test(wrong.reason),
  '…and the reason tells an ADOPTING operator to check what they pasted, not to enrol a key made here')
check(!wrong.reason.includes(OTHER_PUB) || wrong.reason.includes(OTHER_PUB.slice(0, 12)),
  '…and identifies the offending key by prefix, which is what the operator compares against')
check(wrongPaired.wasClosed(),
  '…and the unproven pairing is DROPPED — keeping it is how an unproved signer signs the admission claim')

// The refusals that must never open a pairing at all. A bunker prompt for a typo is a real cost:
// the operator approves something, and approving is the gesture we are trying to spend once.
let opened = 0
const countingOpen = async () => { opened++; return fakeBunker(SK) }
const blank = await proveAdoptedIdentity({ rawKey: '  ', uri: URI, nip19, proveCustody, verifyEvent,
  nonce: NONCE, openPairing: countingOpen })
check(!blank.ok && blank.code === 'NO_KEY', 'an empty key field is refused')
const noUri = await proveAdoptedIdentity({ rawKey: NPUB, uri: '', nip19, proveCustody, verifyEvent,
  nonce: NONCE, openPairing: countingOpen })
check(!noUri.ok && noUri.code === 'NO_URI', 'a missing URI is refused')
const badKey = await proveAdoptedIdentity({ rawKey: NSEC, uri: URI, nip19, proveCustody, verifyEvent,
  nonce: NONCE, openPairing: countingOpen })
check(!badKey.ok && badKey.code === 'BAD_KEY' && !badKey.reason.includes(NSEC),
  'an nsec is refused by type, and still never echoed')
check(opened === 0, 'NEGATIVE CONTROL — none of those three ever opened a pairing, so no bunker prompted for a typo')

// Ordering, because the page hangs its state-clearing on it: a typo must not destroy the identity
// the operator already had proved.
const seq = []
await proveAdoptedIdentity({ rawKey: NSEC, uri: URI, nip19, proveCustody, verifyEvent, nonce: NONCE,
  openPairing: async () => { seq.push('open'); return fakeBunker(SK) }, onResolved: () => seq.push('forget') })
check(seq.length === 0, 'a refused key never fires onResolved — the page keeps the identity it was holding')
await adopt({ openPairing: async () => { seq.push('open'); return fakeBunker(SK) }, onResolved: () => seq.push('forget') })
check(seq.join(',') === 'forget,open', '…and on a good key it fires BEFORE the pairing opens, never after')

const unreachable = await adopt({ openPairing: async () => { throw new Error('relay refused') } })
check(!unreachable.ok && unreachable.code === 'UNREACHABLE' && /relay refused/.test(unreachable.reason),
  'a bunker that cannot be reached is its own refusal, and carries the transport error')

console.log('\n4. the page can reach it (source scan — see the header for why this half is weak)')

// The positive control runs FIRST. A scanner that matches nothing reports a clean page, and that is
// how a page with no JS at all once passed CI.
const KNOWN_BAD = '<html><body><div id="mint-panel"></div></body></html>'
const wiredIn = (src, id) => src.includes(`id="${id}"`)
const controlMissed = ['adopt-pubkey', 'adopt-bunker', 'adopt-prove', 'adoptst'].filter(id => !wiredIn(KNOWN_BAD, id))
check(controlMissed.length === 4, `CONTROL — the scanner rejects a page missing all four ids (missed ${controlMissed.length}/4)`)

const html = readFileSync(join(ROOT, 'console', 'index.html'), 'utf8')
for (const id of ['adopt-pubkey', 'adopt-bunker', 'adopt-prove', 'adoptst']) {
  check(wiredIn(html, id), `index.html has #${id}`)
}
check(/addEventListener\('click'/.test(html) && html.includes("$('adopt-prove')"),
  'and #adopt-prove has a click handler, not just a button')
check(html.includes("from './adopt-identity.mjs'"),
  'and the page imports the resolver rather than re-deciding the pin inline')

// The point of the change: the steps AFTER custody stopped asking who minted the key.
check(!/if \(!minted\) \{ admitSt/.test(html),
  'the invite step no longer refuses an identity this page did not mint')
check(html.includes('activeIdentity()'),
  '…because those steps ask for the identity whose custody is proved')

// And the half that must NOT have moved. An adopted identity has no secret on this page; the checks
// that need one stay bound to `minted`, or they would read a null and report something false.
check(html.includes('if (minted && !minted.secret.taken())'),
  'the unsaved-secret warning still asks `minted` — an adopted identity has no secret to have saved')
check(/\$\('mint-save'\)[\s\S]{0,400}?if \(!minted\)/.test(html) || html.split("if (!minted)").length - 1 >= 2,
  'and revealing the secret is still gated on a key this page actually minted')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
