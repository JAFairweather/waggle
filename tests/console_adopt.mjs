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
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { resolveAdoptedPubkey } from '../console/adopt-identity.mjs'

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

console.log('\n3. the page can reach it (source scan — see the header for why this half is weak)')

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
