// The last step between a key and being talked to: it publishes its own name.
//
// Only the key itself can do this. `handle_kind0_profile` keys the `users` row on `event.pubkey`,
// and the relay rejects any event whose pubkey is not the authenticated identity — so waggle cannot
// do it, and neither can the console operator. What this suite guards is that the module never
// reports a name as landed on anything weaker than a cold read-back, because a relay OK is not
// delivery and this project has been caught by that before.
//
//   node tests/publish_profile.mjs

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { publishProfile, profileContent, profileTemplate } from '../console/publish-profile.mjs'

let fails = 0
const ok = (n, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}${c || !d ? '' : ` — ${d}`}`); if (!c) fails++ }

const sk = generateSecretKey(), pk = getPublicKey(sk)
const sign = async (t) => finalizeEvent(t, sk)
const RELAY = 'wss://relay.example.test'
const NOW = 1786470000

// A pool stand-in. `served` is what a fresh read-back will return; `opened` counts pools, because
// reusing one would let the write connection answer its own read.
const pools = ({ served = 'echo', publishError = null, getError = null, refuse = [] } = {}) => {
  const state = { opened: 0, published: [], authOn: [], closed: 0 }
  const openPool = () => {
    state.opened++
    let mine = null
    return {
      publish: async (urls, ev, opts) => {
        state.published.push({ urls, ev })
        state.authOn.push(opts && typeof opts.onauth === 'function')
        // A named relay that refuses THIS publish while others accept — nos.lol's 28-bit NIP-13
        // demand is exactly this shape, and it is permanent rather than transient.
        const no = (urls || []).find(u => refuse.includes(u))
        if (no) throw new Error(`pow: 28 bits needed (${no})`)
        if (publishError) throw new Error(publishError)
        mine = ev
        state.stored = ev
        return ['ok']
      },
      get: async (urls, filter, opts) => {
        state.lastFilter = filter
        state.authOn.push(opts && typeof opts.onauth === 'function')
        if (getError) throw new Error(getError)
        if (served === 'echo') return state.stored || null
        return served
      },
      close: () => { state.closed++; void mine },
    }
  }
  return { state, openPool }
}

// --- the happy path, and it is the ONLY thing allowed to say proven ------------------------------
{
  const { state, openPool } = pools()
  const res = await publishProfile({ relayUrl: RELAY, name: 'My Dude', pubkeyHex: pk, sign, openPool, nowSec: NOW })

  ok('it reports the name as landed', res.ok === true && res.outcome === 'named')
  ok('…and this is the one place `proven` is true', res.proven === true)
  ok('…and reports the name the relay actually served, not the one asked for', res.name === 'My Dude')

  // A NAME WITH A SPACE. The 2026-08-01 outage was exactly this, against a suite where every
  // fixture name was a single word.
  ok('a name with a space survives', JSON.parse(state.published[0].ev.content).display_name === 'My Dude')

  ok('the profile is a kind:0 signed by the AGENT', state.published[0].ev.kind === 0 && state.published[0].ev.pubkey === pk)
  ok('the relay AUTH handler is supplied on the write', state.authOn[0] === true)
  ok('…and on the read, which also needs to sign in', state.authOn.some((v, i) => i > 0 && v === true))

  // The read-back is worthless if the writing connection can answer it.
  ok('the read-back opens a SECOND pool', state.opened === 2)
  ok('…and asks for this author\'s profile', state.lastFilter.kinds[0] === 0 && state.lastFilter.authors[0] === pk)
  ok('both connections are closed', state.closed === 2)
}

// --- the failures. A relay OK is not delivery ----------------------------------------------------
{
  const { state, openPool } = pools({ served: null })   // accepted, then serves nothing
  const res = await publishProfile({ relayUrl: RELAY, name: 'Oliver', pubkeyHex: pk, sign, openPool, nowSec: NOW })
  ok('accepted-then-not-served is a FAILURE, not a success with a caveat',
    res.ok === false && res.outcome === 'not_served' && res.proven === false)
  ok('…and says it will not fix itself', /not a delay/i.test(res.detail))
  ok('…after genuinely publishing first', state.published.length === 1)
}
{
  // A relay that serves an older profile for the same key. The publish "worked"; this did not.
  const { openPool } = pools({ served: { id: 'some-older-id', content: JSON.stringify({ display_name: 'Old' }) } })
  const res = await publishProfile({ relayUrl: RELAY, name: 'Oliver', pubkeyHex: pk, sign, openPool, nowSec: NOW })
  ok('a stale profile read back is NOT proof', res.ok === false && res.outcome === 'stale' && res.proven === false)
}
{
  const { openPool } = pools({ publishError: 'auth-required: we only accept events from registered users' })
  const res = await publishProfile({ relayUrl: RELAY, name: 'Oliver', pubkeyHex: pk, sign, openPool, nowSec: NOW })
  ok('an AUTH refusal is named as one, and points at the invitation step',
    res.ok === false && res.outcome === 'auth_refused' && /sign in/i.test(res.detail) && /invitation/i.test(res.detail))
}
{
  const { openPool } = pools({ publishError: 'blocked: pubkey is banned' })
  const res = await publishProfile({ relayUrl: RELAY, name: 'Oliver', pubkeyHex: pk, sign, openPool, nowSec: NOW })
  ok('a non-AUTH rejection is NOT reported as an AUTH problem',
    res.ok === false && res.outcome === 'refused' && /banned/.test(res.detail))
}
{
  const { openPool } = pools({ getError: 'connection lost' })
  const res = await publishProfile({ relayUrl: RELAY, name: 'Oliver', pubkeyHex: pk, sign, openPool, nowSec: NOW })
  ok('a read-back that could not run is INCONCLUSIVE, not a pass',
    res.ok === false && res.outcome === 'unreadable' && res.proven === false)
}
{
  // The key has already been saved and cleared. `secret.sign()` returns null for that, by design.
  const { state, openPool } = pools()
  const res = await publishProfile({ relayUrl: RELAY, name: 'Oliver', pubkeyHex: pk, openPool, nowSec: NOW, sign: () => null })
  ok('a cleared key cannot name itself, and is told why',
    res.ok === false && res.outcome === 'cannot_sign' && /before saving/i.test(res.detail))
  ok('…and nothing is published', state.published.length === 0)
}

// --- and the same fixture minus the one defect still succeeds ------------------------------------
{
  const { openPool } = pools()
  const res = await publishProfile({ relayUrl: RELAY, name: 'Oliver', pubkeyHex: pk, sign, openPool, nowSec: NOW })
  ok('a clean run still succeeds — the refusals above are selective', res.ok === true && res.proven === true)
}

// --- the name itself -----------------------------------------------------------------------------
ok('both spellings are written, because Buzz reads one and other clients read the other', (() => {
  const c = JSON.parse(profileContent({ name: 'Kerouac' }))
  return c.display_name === 'Kerouac' && c.name === 'Kerouac'
})())
ok('the template is a kind:0 with no tags at the time given',
  profileTemplate({ name: 'X', nowSec: NOW }).kind === 0 && profileTemplate({ name: 'X', nowSec: NOW }).created_at === NOW)

const refuses = (name) => { try { profileContent({ name }); return null } catch (e) { return e.message } }
ok('an empty name is refused, and says why it matters', /nothing for anybody to type/.test(String(refuses('   '))))
ok('a newline in a name is refused', /control characters/.test(String(refuses('Ol\niver'))))
ok('a NUL is refused', /control characters/.test(String(refuses('Ol\u0000iver'))))
ok('a DEL is refused', /control characters/.test(String(refuses('Oli\u007fver'))))
ok('an absurdly long name is refused', /too long/.test(String(refuses('x'.repeat(65)))))

// BOTH DIRECTIONS. Every refusal above is equally satisfied by a validator that refuses everything,
// and one that refused every name with a space shipped a live outage here.
ok('a name with a SPACE is accepted', refuses('My Dude') === null)
ok('an ordinary name is accepted', refuses('Oliver') === null)
ok('a name with an apostrophe is accepted', refuses("O'Brien") === null)
ok('a name with an accent is accepted', refuses('Renée') === null)
ok('a name with an emoji is accepted', refuses('Neil 🛠') === null)
ok('a 64-character name is accepted — the limit is a limit, not an off-by-one', refuses('x'.repeat(64)) === null)
ok('surrounding whitespace is trimmed rather than refused',
  JSON.parse(profileContent({ name: '  Dennis  ' })).display_name === 'Dennis')

let threw = null
try { await publishProfile({ relayUrl: RELAY, name: 'X', pubkeyHex: 'not-hex', sign, openPool: pools().openPool, nowSec: NOW }) }
catch (e) { threw = e.message }
ok('a bad pubkey is refused up front — the read-back is by author and cannot work without it', /hex pubkey/.test(String(threw)))


// --- the inbox. A named agent with no kind:10050 is a reachable-looking dead end ------------------
// waggle refuses to deliver to a key with no NIP-17 list rather than choosing relays on its behalf,
// and it logged exactly that against a live agent: "RETURN not sent -> …: no valid kind:10050".
import { publishDmInbox } from '../console/publish-profile.mjs'

const DM = ['wss://nos.lol', 'wss://relay.primal.net']
{
  const { state, openPool } = pools()
  const res = await publishDmInbox({ dmRelays: DM, pubkeyHex: pk, sign, openPool, nowSec: NOW })
  ok('it reports the key as reachable', res.ok === true && res.outcome === 'reachable' && res.proven === true)
  ok('the event is a kind:10050 signed by the AGENT', state.published[0].ev.kind === 10050 && state.published[0].ev.pubkey === pk)
  ok('…listing every relay asked for, as relay tags',
    JSON.stringify(state.published[0].ev.tags) === JSON.stringify([['relay', DM[0]], ['relay', DM[1]]]))
  ok('…with empty content, because a delivery preference carries no message', state.published[0].ev.content === '')
  ok('it is published to PUBLIC relays, not the community one — sealed mail travels over open Nostr',
    JSON.stringify(state.published[0].urls) === JSON.stringify(DM))
  ok('the read-back opens a second pool and filters by kind and author',
    state.opened === 2 && state.lastFilter.kinds[0] === 10050 && state.lastFilter.authors[0] === pk)
}
{
  const { openPool } = pools({ served: null })
  const res = await publishDmInbox({ dmRelays: DM, pubkeyHex: pk, sign, openPool, nowSec: NOW })
  ok('accepted-then-not-served leaves the key UNREACHABLE, and says so',
    res.ok === false && res.outcome === 'not_served' && res.proven === false && /nothing can be delivered/i.test(res.detail))
}
{
  const { openPool } = pools({ served: { id: 'older', tags: [] } })
  const res = await publishDmInbox({ dmRelays: DM, pubkeyHex: pk, sign, openPool, nowSec: NOW })
  ok('an older list served back is not proof', res.ok === false && res.outcome === 'stale' && res.proven === false)
}
{
  const { state, openPool } = pools()
  const res = await publishDmInbox({ dmRelays: DM, pubkeyHex: pk, openPool, nowSec: NOW, sign: () => null })
  ok('a cleared key cannot declare its own inbox', res.ok === false && res.outcome === 'cannot_sign')
  ok('…and nothing is published', state.published.length === 0)
}
{
  // Publishing somewhere OTHER than the relays being declared is legitimate — waggle discovers the
  // list on its own read relays — so the two lists are separate parameters and must stay separate.
  const { state, openPool } = pools()
  await publishDmInbox({ dmRelays: DM, publishTo: ['wss://elsewhere.example'], pubkeyHex: pk, sign, openPool, nowSec: NOW })
  ok('the relays it is published TO and the relays it DECLARES are not conflated',
    JSON.stringify(state.published[0].urls) === JSON.stringify(['wss://elsewhere.example']) &&
    state.published[0].ev.tags.length === 2)
}

const inboxRefuses = async (dmRelays) => {
  try { await publishDmInbox({ dmRelays, pubkeyHex: pk, sign, openPool: pools().openPool, nowSec: NOW }); return null }
  catch (e) { return e.message }
}
ok('an empty relay list is refused, because it declares an inbox nobody can deliver to',
  /at least one wss/.test(String(await inboxRefuses([]))))
ok('a non-wss relay is dropped, and dropping them all is refused',
  /at least one wss/.test(String(await inboxRefuses(['http://nope.example', 'not a url']))))
// BOTH DIRECTIONS: the filter must keep the good ones rather than refusing everything.
ok('…while a valid relay alongside a junk one still gets through', await inboxRefuses(['wss://ok.example', 'nonsense']) === null)
ok('an ordinary list is accepted', await inboxRefuses(DM) === null)

// --- the same name, carried out to the public relays as well -------------------------------------
// The community relay is where `@Name` resolves. The public ones are where the identity is legible
// to anyone outside the wall. A key that answers to a name inside and is anonymous outside is half
// an identity — but the two are not equal, and the asymmetry is what these assert.
const PUBA = 'wss://relay.primal.net', PUBB = 'wss://nos.lol'
{
  const { state, openPool } = pools()
  const res = await publishProfile({ relayUrl: RELAY, name: 'My Dude', pubkeyHex: pk, sign, openPool,
    nowSec: NOW, alsoTo: [PUBA, PUBB] })

  ok('the name still proves on the community relay', res.proven === true && res.outcome === 'named')
  ok('…and reaches both public relays', res.alsoLanded.length === 2 && res.alsoFailed.length === 0)

  // The SAME event, not a re-signed one. Re-signing puts a different id on the public copy and
  // "the same profile" stops being checkable by id.
  const community = state.published.find(p => p.urls.includes(RELAY))
  const outward = state.published.filter(p => p.urls.includes(PUBA) || p.urls.includes(PUBB))
  ok('…carrying the identical signed event, by id',
    outward.length === 2 && outward.every(p => p.ev.id === community.ev.id))
  ok('…one relay at a time, so one refusal cannot mask another',
    outward.every(p => p.urls.length === 1))
  ok('…and the community relay is written BEFORE any public one',
    state.published.findIndex(p => p.urls.includes(RELAY)) === 0)
}
{
  // nos.lol refuses every one of these for want of 28 bits of proof-of-work. Permanent, expected,
  // and it must not read as a failure to publish — the name resolves where it counts regardless.
  const { openPool } = pools({ refuse: [PUBB] })
  const res = await publishProfile({ relayUrl: RELAY, name: 'My Dude', pubkeyHex: pk, sign, openPool,
    nowSec: NOW, alsoTo: [PUBA, PUBB] })

  ok('a public relay refusing does NOT unprove the name', res.ok === true && res.proven === true)
  ok('…the one that took it is reported as landed', res.alsoLanded.length === 1 && res.alsoLanded[0] === PUBA)
  ok('…the one that refused is named, with its reason', res.alsoFailed.length === 1
    && res.alsoFailed[0].relay === PUBB && /pow/i.test(res.alsoFailed[0].reason))
  ok('…and the operator is told the name still resolves anyway',
    /still resolves in the community/.test(res.detail))
}
{
  // The direction that matters most: public success can never rescue a community failure.
  const { state, openPool } = pools({ getError: 'connection reset' })
  const res = await publishProfile({ relayUrl: RELAY, name: 'My Dude', pubkeyHex: pk, sign, openPool,
    nowSec: NOW, alsoTo: [PUBA, PUBB] })
  ok('a community relay that cannot be read back is NOT proven, whatever the public relays did',
    res.ok === false && res.proven === false && res.outcome === 'unreadable')
  ok('…and no public relay is written at all, so nothing is published under an unproven name',
    !state.published.some(p => p.urls.includes(PUBA) || p.urls.includes(PUBB)))
}
{
  // NEGATIVE CONTROL for the whole feature: omitting alsoTo must leave the old behaviour untouched,
  // wording included. A caller that never asked for public relays should not be able to tell.
  const { state, openPool } = pools()
  const res = await publishProfile({ relayUrl: RELAY, name: 'My Dude', pubkeyHex: pk, sign, openPool, nowSec: NOW })
  ok('NEGATIVE CONTROL — with no public relays asked for, none are written',
    state.published.length === 1 && state.published[0].urls.includes(RELAY))
  ok('…and the sentence is unchanged, with nothing appended about relays that were never involved',
    res.detail === 'Read back cold from the relay by id — this key now answers to that name.')
  ok('…and it still proves', res.proven === true)
}
{
  // Junk in alsoTo is dropped rather than attempted — an http:// or empty entry is a config typo.
  const { state, openPool } = pools()
  const res = await publishProfile({ relayUrl: RELAY, name: 'My Dude', pubkeyHex: pk, sign, openPool,
    nowSec: NOW, alsoTo: [PUBA, 'http://not-a-relay.test', '  '] })
  ok('non-wss entries in the public list are dropped, not dialled',
    res.alsoLanded.length === 1 && !state.published.some(p => String(p.urls).includes('not-a-relay')))
}

console.log(fails ? `\nPUBLISH PROFILE FAIL — ${fails}` : '\nPUBLISH PROFILE PASS — a name is read back cold, and a name without an inbox is not reachable')
process.exit(fails ? 1 : 0)
