// Which key the console is acting for — the question that has two answers and one wrong one.
//
// A brand-new agent's key is minted in the page and held for a moment. A standing agent's key
// (MC Claude, DJ Codex) lives in its own bunker and has never been in a browser. The steps that
// follow — join the relay, publish a name, declare an inbox — are identical for both, so the whole
// difference is resolved in one module, and this suite guards the two ways it can go wrong:
//
//   * acting for a minted key the page has already let go of, which cannot sign
//   * acting for a stale minted key when the operator has deliberately connected a signer
//
// Both produce something that looks entirely correct and signs as the wrong agent, or not at all.
//
//   node tests/agent_identity.mjs

import { agentIdentity, whyNoIdentity } from '../console/agent-identity.mjs'

let fails = 0
const ok = (n, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}${c || !d ? '' : ` — ${d}`}`); if (!c) fails++ }

const MINTED_PK = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888'
const SIGNER_PK = '1b53f548acebe8dd47252717104350006f49b5c981a86ad4cfaf58d3fd7a0f1e'
const CRYPTO = { decode: (v) => ({ data: `sk:${v}` }), finalize: (t, sk) => ({ ...t, sig: 'x', by: sk }),
  npubEncode: (pk) => `npub_${pk.slice(0, 8)}` }

const mintedKey = ({ taken = false } = {}) => {
  let cleared = taken
  return {
    display: { npub: 'npub_minted', pubkeyHex: MINTED_PK },
    secret: {
      taken: () => cleared,
      take() { cleared = true; return 'nsec1minted' },
      sign: (t, { decode, finalize }) => (cleared ? null : finalize(t, decode('nsec1minted').data)),
    },
  }
}
const bunker = () => ({ signEvent: async (t) => ({ ...t, sig: 'bunker', by: 'remote' }) })

// --- a freshly minted key, still in hand ---------------------------------------------------------
{
  const id = agentIdentity({ minted: mintedKey(), crypto: CRYPTO })
  ok('a minted key in hand is an identity', !!id && id.source === 'minted')
  ok('…reporting its own pubkey', id.pubkeyHex === MINTED_PK)
  ok('…and that there is a secret to save', id.holdsSecret === true)
  ok('…and it signs, without the caller knowing how', id.sign({ kind: 0 }).sig === 'x')
}

// --- a standing key behind its own bunker ---------------------------------------------------------
{
  const id = agentIdentity({ signer: bunker(), signerPubkey: SIGNER_PK, crypto: CRYPTO })
  ok('a connected signer is an identity', !!id && id.source === 'signer')
  ok('…reporting the signer\'s pubkey, not a minted one', id.pubkeyHex === SIGNER_PK)
  ok('…and says there is NOTHING to save, because the key was never here',
    id.holdsSecret === false)
  ok('…and signs through the signer', (await id.sign({ kind: 0 })).sig === 'bunker')
  ok('…deriving the npub from the signer\'s key', id.npub === `npub_${SIGNER_PK.slice(0, 8)}`)
}
{
  const id = agentIdentity({ signer: bunker(), signerPubkey: 'not-a-pubkey', crypto: CRYPTO })
  ok('a signer that reports no usable pubkey is NOT an identity', id === null)
  ok('…and says so distinctly', /did not report a usable public key/.test(whyNoIdentity({ signer: bunker() })))
}

// --- the one that signs as the wrong agent --------------------------------------------------------
{
  // Both present: the operator minted something earlier and has since connected a standing
  // identity's bunker. Acting for the minted key here would publish MC Claude's name onto a
  // throwaway key, verify perfectly, and be wrong.
  const id = agentIdentity({ minted: mintedKey(), signer: bunker(), signerPubkey: SIGNER_PK, crypto: CRYPTO })
  ok('with BOTH a minted key and a connected signer, the SIGNER wins',
    id.source === 'signer' && id.pubkeyHex === SIGNER_PK)
  ok('…and the minted key is not silently used instead', id.pubkeyHex !== MINTED_PK)
}

// --- the one that cannot sign at all --------------------------------------------------------------
{
  const id = agentIdentity({ minted: mintedKey({ taken: true }), crypto: CRYPTO })
  ok('a minted key the page has let go of is NOT an identity', id === null)
  // The reason is the whole point of this branch: "no key" and "the key went to a bunker" send the
  // operator to completely different places, and the second is the only one with a way forward.
  const gone = whyNoIdentity({ minted: mintedKey({ taken: true }) })
  ok('…and the reason names where the key went, not a missing key',
    /in a bunker now/.test(gone) && !/Make a key first/.test(gone))
  ok('…and points at connecting that bunker as the way forward',
    /connect that bunker/i.test(gone))
}
{
  // Saved BETWEEN the check and the signature: the window that would otherwise surface as a null
  // three calls later, reported as some unrelated kind of refusal.
  const m = mintedKey()
  const id = agentIdentity({ minted: m, crypto: CRYPTO })
  m.secret.take()
  let threw = null
  try { id.sign({ kind: 0 }) } catch (e) { threw = e.message }
  ok('a key saved after the identity was taken fails LOUDLY, not as a null',
    /no longer in this page/.test(String(threw)))
}
{
  ok('nothing at all is not an identity', agentIdentity({}) === null)
  ok('…and says to make one or connect one', /Make a key first/.test(whyNoIdentity({})))
}

// --- and the same fixtures minus the one defect still work ----------------------------------------
// Without these, every refusal above is equally satisfied by returning null for everything.
ok('a clean minted key still resolves', agentIdentity({ minted: mintedKey(), crypto: CRYPTO }) !== null)
ok('a clean signer still resolves', agentIdentity({ signer: bunker(), signerPubkey: SIGNER_PK, crypto: CRYPTO }) !== null)

console.log(fails ? `\nAGENT IDENTITY FAIL — ${fails}` : '\nAGENT IDENTITY PASS — the signer wins, a cleared key is nobody, and neither fails quietly')
process.exit(fails ? 1 : 0)
