// consent_request.mjs — the disclosure-DM template (src/nostr_egress.mjs, docs/CONSENT.md §5/§7).
//
// This is waggle's first UNSOLICITED outbound seal to a stranger, so the template's whole job is to
// make free text impossible and bind the terms by hash. The tests target the two ways that fails:
//   - the ToS block drifting (so the `tos` hash a participant signs no longer means "these terms");
//   - the prefill slot carrying something OTHER than a mirror-consent grant to this bridge (so the
//     disclosure could ask a stranger to sign an arbitrary event dressed as "sign this").
//
//   node tests/consent_request.mjs

import { createHash } from 'node:crypto'
import { buildBody, consentTosBlock, NOSTR_TEMPLATE_NAMES } from '../src/nostr_egress.mjs'

let n = 0, pass = 0
const t = (name, cond) => { n++; if (cond) { pass++; console.log(`ok - ${name}`) } else console.error(`FAIL - ${name}`) }
const sha = (s) => createHash('sha256').update(s).digest('hex')

const HIVE = 'c'.repeat(64)
const HIVE_NAME = 'JA Fairweather\'s hive'
const HIVE_HANDLE = 'jaf@dequalsf.com'
const TERMS = 'https://block.github.io/buzz/terms.html'
const CONSENT_URL = 'https://jafairweather.github.io/nvoy/consent.html'
const bridge = 'b'.repeat(64)

// A well-formed UNSIGNED prefill 440 whose tos = hash of the canonical block (as the bridge builds it).
const tosHash = sha(consentTosBlock({ hiveId: HIVE, hiveName: HIVE_NAME, hiveHandle: HIVE_HANDLE, termsUrl: TERMS }))
const prefill = {
  kind: 440, created_at: 1000,
  tags: [['p', bridge], ['da-scope', 'a'.repeat(64), 'c'.repeat(32)], ['da-cap', 'mirror'], ['tos', tosHash]],
  content: '',
}

// --- 1. the template is in the closed catalogue --------------------------------------------------
t('consent_request is a registered nostr template', NOSTR_TEMPLATE_NAMES.includes('consent_request'))

// --- 2. the ToS block is DETERMINISTIC and community-bound (the hash must be stable) -------------
{
  const a = consentTosBlock({ hiveId: HIVE, hiveName: HIVE_NAME, hiveHandle: HIVE_HANDLE, termsUrl: TERMS })
  const b = consentTosBlock({ hiveId: HIVE, hiveName: HIVE_NAME, hiveHandle: HIVE_HANDLE, termsUrl: TERMS })
  t('the ToS block renders identically for the same inputs (stable hash)', sha(a) === sha(b))
  t('a different hive id yields a different block/hash by construction',
    sha(consentTosBlock({ hiveId: 'f'.repeat(64), hiveName: HIVE_NAME, hiveHandle: HIVE_HANDLE, termsUrl: TERMS })) !== sha(a))
  t('the visible @ handle survives into the signed terms', a.includes(HIVE_HANDLE))
  t('the v1 marker is present (a wording rev is a new hash, never silent)', /mirror consent \(v1\)/.test(a))
  t('all five §7 disclosures are in the block', /What happens/.test(a) && /Who sees it/.test(a) &&
    /How it's posted, honestly/.test(a) && /public self is untouched/.test(a) && /stop it anytime/.test(a))
}

// --- 3. the built DM carries cover line + block + the prefill, and binds the SAME hash -----------
{
  const body = buildBody('consent_request', { consentUrl: CONSENT_URL, hiveId: HIVE, hiveName: HIVE_NAME, hiveHandle: HIVE_HANDLE, termsUrl: TERMS, prefill })
  t('the DM opens with a warm but explicit consent invitation', /small invitation from waggle/.test(body))
  t('the DM contains a fragment-only Nvoy signing link, not raw event JSON', body.includes(`${CONSENT_URL}#request=`) && !body.includes('```json') && !body.includes('"da-scope"'))
  t('the prefill\'s tos hash equals the canonical block shown by the signer (bound, not drifting)',
    prefill.tags.find(x => x[0] === 'tos')[1] === sha(consentTosBlock({ hiveId: HIVE, hiveName: HIVE_NAME, hiveHandle: HIVE_HANDLE, termsUrl: TERMS })))
}

// --- 4. the prefill slot refuses anything but a mirror-consent grant to this bridge -------------
const mustThrow = (name, slots) => {
  n++
  try { buildBody('consent_request', slots); console.error(`FAIL - ${name} (did not throw)`) }
  catch { pass++; console.log(`ok - ${name}`) }
}
mustThrow('refuses a prefill that is not a 440', { consentUrl: CONSENT_URL, hiveId: HIVE, hiveName: HIVE_NAME, hiveHandle: HIVE_HANDLE, termsUrl: TERMS, prefill: { ...prefill, kind: 1 } })
mustThrow('refuses a non-mirror capability (e.g. admit)', { consentUrl: CONSENT_URL, hiveId: HIVE, hiveName: HIVE_NAME, hiveHandle: HIVE_HANDLE, termsUrl: TERMS,
  prefill: { ...prefill, tags: [['p', bridge], ['da-scope', 'a'.repeat(64), 'c'.repeat(32)], ['da-cap', 'admit'], ['tos', tosHash]] } })
mustThrow('refuses a prefill that carries no tos hash', { consentUrl: CONSENT_URL, hiveId: HIVE, hiveName: HIVE_NAME, hiveHandle: HIVE_HANDLE, termsUrl: TERMS,
  prefill: { ...prefill, tags: [['p', bridge], ['da-scope', 'a'.repeat(64), 'c'.repeat(32)], ['da-cap', 'mirror']] } })
mustThrow('refuses an ALREADY-SIGNED prefill (the participant must supply the signature)',
  { consentUrl: CONSENT_URL, hiveId: HIVE, hiveName: HIVE_NAME, hiveHandle: HIVE_HANDLE, termsUrl: TERMS, prefill: { ...prefill, sig: 'f'.repeat(128) } })
mustThrow('refuses a non-https terms URL', { consentUrl: CONSENT_URL, hiveId: HIVE, hiveName: HIVE_NAME, hiveHandle: HIVE_HANDLE, termsUrl: 'javascript:alert(1)', prefill })

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
