// A recipient relay-list publish is a narrow, signed NIP-17 replacement event.
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { buildDmRelayListEvent, buildDmRelayListTemplate, signDmRelayList } from '../tools/dm_relay_list_lib.mjs'
import { recipientDmRelays } from '../src/dm_relays.mjs'

let total = 0, passed = 0
const test = (name, condition) => { total++; if (condition) { passed++; console.log(`ok - ${name}`) } else console.error(`FAIL - ${name}`) }
const secretKey = generateSecretKey(), pubkey = getPublicKey(secretKey)
const event = JSON.parse(JSON.stringify(buildDmRelayListEvent(secretKey, [
  'wss://nos.lol/', 'wss://relay.primal.net', 'wss://relay.nave.pub', 'wss://nos.lol', 'http://bad.example', 'wss://localhost',
], 1_786_000_000)))

test('builds a signed kind:10050 event', event.kind === 10050 && verifyEvent(event) && event.pubkey === pubkey && event.content === '')
test('uses only canonical recipient relay tags', JSON.stringify(event.tags) === JSON.stringify([
  ['relay', 'wss://nos.lol'], ['relay', 'wss://relay.primal.net'], ['relay', 'wss://relay.nave.pub'],
]))
test('the bridge resolves exactly the published delivery set', JSON.stringify(recipientDmRelays([event], pubkey)) === JSON.stringify([
  'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nave.pub',
]))
test('refuses a list with no safe websocket relay', (() => { try { buildDmRelayListEvent(secretKey, ['http://bad.example', 'wss://localhost']); return false } catch { return true } })())

// ── Signing through a Bunker, with the identity proved on both sides (#381) ──────────────────
//
// The property that matters is an ORDERING one, and it is the #338 defect at the signing layer:
// a signer that resolves to the wrong key must be refused BEFORE it is asked for a signature.
// Checking afterwards is too late — the wrong identity has already signed, and a signature
// cannot be un-obtained. So every fake below records the order of its calls.

const DM_URLS = ['wss://nos.lol', 'wss://relay.primal.net']
const AT = 1_786_000_000
const fakeSigner = (sk, { returns } = {}) => {
  const calls = []
  return {
    calls,
    pubkey: getPublicKey(sk),
    async sign(template) {
      calls.push('sign')
      return returns ? returns(template) : finalizeEvent(template, sk)
    },
  }
}
const rejected = async (promise) => { try { await promise; return null } catch (e) { return e.message } }

const mineSk = generateSecretKey(), minePk = getPublicKey(mineSk)
const theirSk = generateSecretKey(), theirPk = getPublicKey(theirSk)

{
  // THE GUARD. A Bunker holds many keys; a copied environment points at whichever it was last
  // pointed at. This is exactly what happened in #338, one layer up.
  const wrong = fakeSigner(theirSk)
  const why = await rejected(signDmRelayList(wrong, DM_URLS, minePk, { createdAt: AT }))
  test('a signer resolving to another identity is refused', !!why)
  test('and sign() is NEVER called — the refusal precedes the signature, not follows it',
    wrong.calls.length === 0)
  // Assert the REASON, not only the refusal: !ok cannot tell a correct refusal from a correct
  // refusal with a misleading explanation, and this message is what an operator acts on.
  test('and the message names both keys, so the operator can see which is which',
    !!why && why.includes(theirPk.slice(0, 12)) && why.includes(minePk.slice(0, 12)))
}
{
  // BOTH DIRECTIONS. A guard that refuses everything passes every assertion above.
  const right = fakeSigner(mineSk)
  const event = await signDmRelayList(right, DM_URLS, minePk, { createdAt: AT })
  test('the CORRECT identity still signs and publishes — the guard is not "refuse everything"',
    event.kind === 10050 && event.pubkey === minePk && verifyEvent(event))
  test('and it signed exactly once', right.calls.length === 1)
  test('the Bunker path and the local path produce byte-identical content',
    JSON.stringify(event.tags) === JSON.stringify(buildDmRelayListEvent(mineSk, DM_URLS, AT).tags))
}
{
  // A remote signer is a network peer, not a library call. Trusting its answer because we
  // trusted the question is how something gets published that we did not compose.
  const liar = fakeSigner(mineSk, { returns: tmpl => finalizeEvent(tmpl, theirSk) })
  const why = await rejected(signDmRelayList(liar, DM_URLS, minePk, { createdAt: AT }))
  test('an event that comes back authored by a DIFFERENT key is refused', !!why && /authored by/.test(why))

  const swapper = fakeSigner(mineSk, {
    returns: tmpl => finalizeEvent({ ...tmpl, tags: [['relay', 'wss://attacker.example']] }, mineSk),
  })
  test('an event that comes back with different relay tags is refused — it verifies perfectly',
    !!(await rejected(signDmRelayList(swapper, DM_URLS, minePk, { createdAt: AT }))))

  const unsigned = fakeSigner(mineSk, { returns: tmpl => ({ ...tmpl, pubkey: minePk, id: 'x'.repeat(64), sig: '0'.repeat(128) }) })
  test('an event whose signature does not verify is refused',
    !!(await rejected(signDmRelayList(unsigned, DM_URLS, minePk, { createdAt: AT }))))

  const silent = { pubkey: '', sign: () => { throw new Error('should never be reached') } }
  test('a signer that reports no public key is refused, and never asked to sign',
    !!(await rejected(signDmRelayList(silent, DM_URLS, minePk, { createdAt: AT }))))
}
{
  // NEGATIVE CONTROL — prove the ordering assertion could fail. A sign-then-check implementation
  // passes "wrong identity is refused" identically; only calls.length tells them apart.
  const wrong = fakeSigner(theirSk)
  const signThenCheck = async (signer, urls, want) => {
    const ev = await signer.sign(buildDmRelayListTemplate(urls, AT))   // the defect: signs first
    if (ev.pubkey !== want) throw new Error('wrong identity')
    return ev
  }
  const why = await rejected(signThenCheck(wrong, DM_URLS, minePk))
  test('NEGATIVE CONTROL — a sign-then-check version ALSO refuses, so refusal alone proves nothing', !!why)
  test('NEGATIVE CONTROL — but it signed first (calls=1), which is the bug the order test catches',
    wrong.calls.length === 1)
}

console.log(`\n${passed}/${total} passed`)
process.exit(passed === total ? 0 : 1)
