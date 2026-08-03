// consent_ask.mjs — the disclosure/ask side (docs/CONSENT.md §5/§6), driving the REAL bridge exports.
//
// This is waggle's FIRST unsolicited outbound seal to a stranger, so the tests are about the three
// anti-spam rules that ARE its safety: ask once per target ever, a global rate cap, and never a
// muted/grandfathered/already-consented target. Plus: the prefilled 440 must be a signable
// mirror-consent that verifies against the gate. No sockets — `publish`/`send` are injected.
//
//   node tests/consent_ask.mjs

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'

const tmp = mkdtempSync(join(tmpdir(), 'wb-consent-ask-'))
const CHAN = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
const TERMS = 'https://block.github.io/buzz/terms.html'
const bridgeSk = generateSecretKey(), bridgePk = getPublicKey(bridgeSk)

writeFileSync(join(tmp, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: ['wss://x'], inbox: CHAN, watch_authors: [], watch_events: [], grantors: [],
    mirror_require_consent: true,
    mirror_consent_terms_url: TERMS,
    mirror_ask_per_hour: 2,
    muted_authors: [],
  },
}))
process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'dryrun'
process.env.CONFIG_PATH = join(tmp, 'config.json')
process.env.SEEN_PATH = join(tmp, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(tmp, 'wm')
process.env.POSTED_MAP_PATH = join(tmp, 'pm.log')
process.env.MIRRORASKED_PATH = join(tmp, 'asked.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')

const { maybeAskConsent, sendConsentRequest, buildConsentPrefill, mirrorAsked, mirrorConsent, PUB } =
  await import('../src/bridge.mjs')
const { consentTosBlock } = await import('../src/nostr_egress.mjs')
const { verifyConsent } = await import('../src/consent.mjs')
const { buildBody } = await import('../src/nostr_egress.mjs')

let n = 0, pass = 0
const t = (name, cond) => { n++; if (cond) { pass++; console.log(`ok - ${name}`) } else console.error(`FAIL - ${name}`) }
const fresh = () => getPublicKey(generateSecretKey())

// --- 1. config: expected ToS hash DERIVED from the one producer (#200 folded in) ----------------
{
  const derived = createHash('sha256').update(consentTosBlock({ community: CHAN, termsUrl: TERMS })).digest('hex')
  t('mirror_expected_tos_hash is derived from consentTosBlock, not hand-set', PUB.mirrorExpectedTosHash === derived)
}

// --- 2. the prefilled 440 is a signable, verifiable mirror consent -------------------------------
{
  const pre = buildConsentPrefill()
  t('prefill is an UNSIGNED 440', pre.kind === 440 && !pre.sig)
  t('  grantee is the bridge, cap is mirror', pre.tags.find(x => x[0] === 'p')[1] === bridgePk && pre.tags.find(x => x[0] === 'da-cap')[1] === 'mirror')
  t('  tos is the derived expected hash (matches the gate)', pre.tags.find(x => x[0] === 'tos')[1] === PUB.mirrorExpectedTosHash)
  t('  the disclosure template accepts the prefill', typeof buildBody('consent_request', { community: CHAN, termsUrl: TERMS, prefill: pre }) === 'string')
  // a participant signs it unchanged → it verifies against the gate
  const psk = generateSecretKey()
  const signed = JSON.parse(JSON.stringify(finalizeEvent(pre, psk)))
  const v = verifyConsent(signed, { bridgePubkey: bridgePk, communityId: CHAN, expectedTosHash: PUB.mirrorExpectedTosHash })
  t('  signed unchanged, it verifies (participant == signer, tos bound)', v.ok && v.participant === getPublicKey(psk))
}

// --- 3. sendConsentRequest seals ONE disclosure DM to the target and records it ------------------
{
  const target = fresh()
  const sealed = []
  const mockPublish = async (wrap) => { sealed.push(wrap); return 2 }   // 2 relays accepted
  const accepted = await sendConsentRequest(target, mockPublish)
  t('a consent request is sealed and accepted', accepted === 2 && sealed.length === 1)
  t('  the wrap is a 1059 gift-wrap p-tagged to the target', sealed[0].kind === 1059 && sealed[0].tags.some(x => x[0] === 'p' && x[1] === target))
  t('  the target is recorded as asked (once-per-target §6)', mirrorAsked.has(target))
}

// --- 4. maybeAskConsent's guards (send injected as a spy — no I/O) -------------------------------
{
  let calls = 0
  const spy = async () => { calls++ }
  const eligible = fresh()
  t('an eligible fresh target IS asked', maybeAskConsent(eligible, spy) === true)

  const already = fresh(); mirrorAsked.add(already)
  t('an already-asked target is NOT re-asked (silence is a no)', maybeAskConsent(already, spy) === false)

  const consented = fresh(); mirrorConsent.set(consented, { recordId: 'x', tosHash: 'y', at: 1 })
  t('a target that already consented is NOT asked', maybeAskConsent(consented, spy) === false)

  const muted = fresh(); PUB.muted.push(muted)
  t('a muted target (explicit prior no) is NOT asked', maybeAskConsent(muted, spy) === false)

  const grand = fresh(); PUB.mirrorGrandfathered.push(grand)
  t('a grandfathered target is NOT asked', maybeAskConsent(grand, spy) === false)

  t('  …the spy fired ONLY for the eligible one', calls === 1)
}

// --- 5. the rate cap holds (mirror_ask_per_hour = 2) --------------------------------------------
// Only test-3 spent a real send before this (test-4 used the injected spy, which never calls
// askRateOk). So: one more allowed (count 1→2), the next fails closed (2 ≥ cap).
{
  const noop = async () => 1
  const a = await sendConsentRequest(fresh(), noop)
  const b = await sendConsentRequest(fresh(), noop)   // hits the 2/h cap
  t('the hourly ask cap fails closed once reached', a === 1 && b === 0)
}

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
