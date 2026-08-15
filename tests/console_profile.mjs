// console_profile — the agent's NAME, published from the console (#487, second leg).
//
// This is the leg that decides whether `@Name` resolves in Buzz. Buzz writes the `users` row an
// at-word resolves against only in `handle_kind0_profile`, keyed on `event.pubkey`, and `event.rs`
// refuses any event whose pubkey differs from the authenticated identity — so the agent's own key
// must publish its own kind:0, and no bridge can do it on its behalf. Admission (#494) makes the
// key able to authenticate; this makes it addressable. Neither one is the other.
//
// THE PROPERTY THIS SUITE EXISTS FOR: a relay's OK is not a publish. Relays return OK and drop, and
// others answer 503 while the write succeeds. So `pushed` and `proven` are separate fields, and the
// case that reads best and means least — every relay said OK, no read-back served it — is walked
// explicitly rather than assumed impossible.
//
// AND THE ONE THAT MUST NOT BE PAPERED OVER: the community read-back is EXPECTED to be refused.
// Membership buys write, not read (#399) — a community read-back answers `403 RBAC: access denied`
// for an admitted key, the same refusal an unadmitted key gets, so it distinguishes nothing. That
// is INCONCLUSIVE. Reporting it as failure sends the operator to fix a working publish; reporting
// it as a pass claims a proof nobody performed.
//
// Both directions on every guard: each refusal is paired with a case that still gets through.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PUBLIC_RELAYS } from '../src/relays.mjs'
import * as pp from '../console/profile-publish.mjs'
import * as webNip98 from '../console/nip98.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

console.log('\nconsole_profile\n')

const PUB = 'a'.repeat(64)

// ------------------------------------------------------------------------------------------
console.log('1. the relay list is the one the rest of the estate uses')
// A page publishing to a different set from the one the bridge reads is a profile nobody looks for
// — and it would fail silently, because both sides would be working perfectly.
check(pp.PUBLIC_RELAYS.join(',') === DEFAULT_PUBLIC_RELAYS.join(','),
  `the lifted list matches src/relays.mjs exactly (${pp.PUBLIC_RELAYS.length} relays)`)
check(pp.PUBLIC_RELAYS.length >= 2, 'and it is a real list — a one-relay publish has no redundancy to prove anything with')
check(Object.isFrozen(pp.PUBLIC_RELAYS), 'and frozen, so a caller cannot quietly edit the estate-wide set')

// ------------------------------------------------------------------------------------------
console.log('\n2. the template — a name, or a refusal')
const t = pp.profileTemplate({ name: 'Pi Agent', now: 1000 })
check(t.kind === 0 && t.created_at === 1000 && Array.isArray(t.tags), 'it is a kind:0 with the time it was given')
check(!t.sig && !t.pubkey, 'and it is UNSIGNED — nothing on this page holds a key to sign it with')
const parsed = JSON.parse(t.content)
check(parsed.name === 'Pi Agent' && parsed.display_name === 'Pi Agent',
  'it carries both name and display_name — Buzz resolves the at-word against display_name')
for (const bad of ['', '   ', null, undefined]) {
  let err = null
  try { pp.profileTemplate({ name: bad }) } catch (e) { err = e.message }
  check(err !== null, `an empty name (${JSON.stringify(bad)}) REFUSES rather than publishing a blank face`)
  check(/looks like success/.test(String(err)),
    '  …and says why it matters: a blank profile is indistinguishable from never having published')
}
// POSITIVE CONTROL — the guard is not refusing everything.
check(pp.profileTemplate({ name: ' Pi ' }).content.includes('"name":"Pi"'),
  'while an ordinary name is trimmed and gets through (POSITIVE CONTROL)')

// ------------------------------------------------------------------------------------------
console.log('\n3. content is ADOPTED, never invented')
// The failure worth preventing is a second, drifting profile that disagrees with the one already
// published — two faces for one key, and the newer one wins wherever it is seen first.
const existing = [
  { kind: 0, pubkey: PUB, created_at: 10, content: JSON.stringify({ name: 'Old', about: 'the original blurb', picture: 'https://x/y.png', nip05: 'pi@example' }) },
  { kind: 0, pubkey: PUB, created_at: 5, content: JSON.stringify({ name: 'Older' }) },
]
const adopted = pp.adoptFrom(existing, PUB)
check(adopted.name === 'Old' && adopted.nip05 === 'pi@example', 'the NEWEST published profile is adopted, not the first seen')
const merged = JSON.parse(pp.profileTemplate({ name: 'Pi Agent', adopted, now: 1 }).content)
check(merged.name === 'Pi Agent' && merged.display_name === 'Pi Agent', 'a typed name overrides the adopted one')
check(merged.about === 'the original blurb' && merged.nip05 === 'pi@example',
  'while every field the operator did not touch SURVIVES — a publish that blanks them is a silent loss')
check(JSON.parse(pp.profileTemplate({ name: 'Pi', adopted, about: 'new blurb', now: 1 }).content).about === 'new blurb',
  'and a field they did touch wins (POSITIVE CONTROL — adoption is not a wall)')
check(pp.adoptFrom([], PUB) === null && pp.adoptFrom(null, PUB) === null,
  'nothing to adopt yields null, so a first publish is not blocked on a profile that does not exist')
check(pp.adoptFrom([{ kind: 0, pubkey: PUB, created_at: 9, content: 'not json' }], PUB) === null,
  'and an unparseable existing profile is null rather than a throw that takes the flow down')
check(pp.adoptFrom([{ kind: 0, pubkey: 'b'.repeat(64), created_at: 99, content: '{"name":"Someone Else"}' }], PUB) === null,
  'ANOTHER KEY\'S profile is never adopted — that would publish someone else\'s face under this key')

// ------------------------------------------------------------------------------------------
console.log('\n4. a relay OK is not a publish')
// A WebSocket that is a table: what it says on EVENT, and what it serves on REQ. The two are set
// independently, which is the only way to build the case that matters.
function fakeWS({ accept = true, serve = null, eose = true, fail = false }) {
  return class {
    constructor(url) {
      this.url = url
      if (fail) { setTimeout(() => this.onerror?.({}), 0); return }
      setTimeout(() => this.onopen?.(), 0)
    }
    close() {}
    send(raw) {
      const msg = JSON.parse(raw)
      if (msg[0] === 'EVENT') {
        const ev = msg[1]
        setTimeout(() => this.onmessage?.({ data: JSON.stringify(['OK', ev.id, accept, accept ? '' : 'blocked: pow']) }), 0)
      } else {
        setTimeout(() => {
          if (serve) this.onmessage?.({ data: JSON.stringify(['EVENT', 'pp', serve]) })
          if (eose) this.onmessage?.({ data: JSON.stringify(['EOSE', 'pp']) })
        }, 0)
      }
    }
  }
}
const signed = { ...pp.profileTemplate({ name: 'Pi Agent', now: 100 }), id: 'd'.repeat(64), pubkey: PUB, sig: 'e'.repeat(128) }
const served = { ...signed, created_at: 100 }
const RELAYS = ['wss://a.example', 'wss://b.example']

{
  const r = await pp.publishPublic(signed, { relays: RELAYS, WS: fakeWS({ accept: true, serve: served }), timeoutMs: 50 })
  check(r.pushed === 2 && r.proven === 2, 'accepted and served back by both — proven')
}
{
  // THE CASE THAT READS BEST AND MEANS LEAST. Every relay says OK; no read-back serves it.
  const r = await pp.publishPublic(signed, { relays: RELAYS, WS: fakeWS({ accept: true, serve: null }), timeoutMs: 50 })
  check(r.pushed === 2, 'both relays SAID OK…')
  check(r.proven === 0, '…and NOTHING was served back — proven stays 0, because a relay can accept and drop')
  const v = pp.nameVerdict({ pub: r, community: null, communityRead: null })
  check(v.proven === false, 'and the verdict does not call it published')
  check(/accepted it and NONE served it back/.test(v.text) && /not published/.test(v.text),
    `and says so in the words the operator acts on — "${v.text.slice(0, 70)}…"`)
}
{
  // A relay that serves back a DIFFERENT profile is not a confirmation of this one.
  const other = { ...served, content: JSON.stringify({ name: 'Somebody Else' }) }
  const r = await pp.publishPublic(signed, { relays: RELAYS, WS: fakeWS({ accept: true, serve: other }), timeoutMs: 50 })
  check(r.proven === 0, 'a relay serving a DIFFERENT profile back does not count as proof of this one')
  check(r.answered === 2, '  …while still counting as answered, so "stale profile" is told apart from "silent relay"')
}
{
  // Answered-and-empty is a real negative. Never-answered is not — and they must not average.
  const r = await pp.publishPublic(signed, { relays: RELAYS, WS: fakeWS({ accept: true, serve: null, eose: false }), timeoutMs: 30 })
  check(r.answered === 0 && r.proven === 0,
    'a relay that never sent EOSE counts as UNANSWERED, not as "the profile is not there"')
}
{
  const r = await pp.publishPublic(signed, { relays: RELAYS, WS: fakeWS({ accept: false }), timeoutMs: 50 })
  check(r.pushed === 0 && r.said.every(s => /refused: blocked: pow/.test(s.said)),
    'a refusal is carried with the relay\'s own reason, not flattened to a count')
}

// ------------------------------------------------------------------------------------------
console.log('\n5. the community leg — where the at-word actually resolves')
const nip98 = { nip98Template: webNip98.nip98Template, nip98Header: webNip98.nip98Header }
const sign = async (tmpl) => ({ ...tmpl, id: 'f'.repeat(64), pubkey: PUB, sig: 'e'.repeat(128) })
const relayCall = answers => {
  const calls = []
  return { calls, impl: async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {}, body: init.body })
    const a = typeof answers === 'function' ? answers(url) : answers
    return { status: a.status, ok: a.status >= 200 && a.status < 300, text: async () => a.text ?? JSON.stringify(a.json ?? {}) }
  } }
}
{
  const r = relayCall({ status: 200, json: { accepted: true } })
  const out = await pp.publishCommunity({ relayUrl: 'wss://relay.example', signedEvent: signed, sign, fetchImpl: r.impl, nip98 })
  check(out.ok === true, 'a 200 with accepted:true lands')
  check(r.calls[0].url === 'https://relay.example/events', 'it POSTs the /events path over https, derived from the wss URL')
  check(!('x-auth-tag' in r.calls[0].headers),
    'and sends NO x-auth-tag when none was given — membership alone is sufficient to write (#482/#483)')
  check(r.calls[0].body === JSON.stringify(signed), 'the body is the signed event, byte for byte the bytes that were hashed')
}
{
  // POSITIVE CONTROL for the header: given one, it is sent — so its absence above is a choice.
  const r = relayCall({ status: 200, json: { accepted: true } })
  await pp.publishCommunity({ relayUrl: 'wss://relay.example', signedEvent: signed, sign, authTag: '["auth","x"]', fetchImpl: r.impl, nip98 })
  check(r.calls[0].headers['x-auth-tag'] === '["auth","x"]', 'while an auth tag that WAS given is sent through')
}
{
  // A refusal wearing a success code. Reading only the status here reports a name that never landed.
  const r = relayCall({ status: 200, json: { accepted: false, error: 'not a member' } })
  const out = await pp.publishCommunity({ relayUrl: 'wss://relay.example', signedEvent: signed, sign, fetchImpl: r.impl, nip98 })
  check(out.ok === false, 'a 200 carrying accepted:false is a REFUSAL, not a publish')
  check(/accepted:false/.test(out.reason), '  …and the reason says which, rather than reporting the 200')
}
{
  const r = relayCall({ status: 403, text: 'RBAC: access denied' })
  const out = await pp.publishCommunity({ relayUrl: 'wss://relay.example', signedEvent: signed, sign, fetchImpl: r.impl, nip98 })
  check(out.ok === false && /403/.test(out.reason) && /RBAC/.test(out.reason),
    'a 403 is refused with the relay\'s own words')
}
{
  const impl = async () => { throw new TypeError('Failed to fetch') }
  const out = await pp.publishCommunity({ relayUrl: 'wss://relay.example', signedEvent: signed, sign, fetchImpl: impl, nip98 })
  check(out.ok === false && out.reach === true && /CORS/.test(out.reason),
    'a fetch that never got a status names BOTH causes — a browser cannot tell a dead host from a withheld answer')
}
{
  let err = null
  try { await pp.publishCommunity({ relayUrl: '', signedEvent: signed, sign, nip98 }) } catch (e) { err = e.message }
  check(err !== null && /not skipped quietly/.test(err),
    'and no relay URL REFUSES — this is the leg that makes the at-word resolve, so it is not skipped silently')
}

// ------------------------------------------------------------------------------------------
console.log('\n6. the community read-back is INCONCLUSIVE, and says so')
{
  const r = relayCall({ status: 403, text: 'RBAC: access denied' })
  const out = await pp.readBackCommunity({ relayUrl: 'wss://relay.example', pubkey: PUB, sign, fetchImpl: r.impl, nip98 })
  check(out.state === 'inconclusive', 'the 403 this is EXPECTED to get is inconclusive — not a pass and not a failure')
  check(/membership buys write, not read/.test(out.why),
    '  …and explains that the refusal says nothing about whether the profile landed')
  const v = pp.nameVerdict({ pub: { proven: 2, pushed: 2, asked: 2 }, community: { ok: true }, communityRead: out })
  check(v.communityAccepted === true && /INCONCLUSIVE/.test(v.text),
    'the verdict reports the community leg as ACCEPTED and its read-back as inconclusive, separately')
  check(v.proven === true && !/the at-word resolves/.test(v.text),
    '  …and never claims the at-word resolves on the strength of an accepted write')
}
{
  // POSITIVE CONTROL — a relay that DOES serve it back is reported as served. Without this, the
  // check above cannot tell "correctly inconclusive" from "always inconclusive".
  const r = relayCall({ status: 200, json: { events: [served] } })
  const out = await pp.readBackCommunity({ relayUrl: 'wss://relay.example', pubkey: PUB, sign, fetchImpl: r.impl, nip98 })
  check(out.state === 'served' && out.newest.content === signed.content,
    'a community relay that DOES serve it back reads as served (POSITIVE CONTROL)')
  const v = pp.nameVerdict({ pub: { proven: 2, pushed: 2, asked: 2 }, community: { ok: true }, communityRead: out })
  check(/the at-word resolves/.test(v.text), '  …and only THEN does the verdict say the at-word resolves')
}
{
  const r = relayCall({ status: 200, json: { events: [] } })
  const out = await pp.readBackCommunity({ relayUrl: 'wss://relay.example', pubkey: PUB, sign, fetchImpl: r.impl, nip98 })
  check(out.state === 'absent', 'a relay that answers with no events is ABSENT — a real negative, told apart from unreadable')
}
{
  const r = relayCall({ status: 200, text: '<html>not json</html>' })
  const out = await pp.readBackCommunity({ relayUrl: 'wss://relay.example', pubkey: PUB, sign, fetchImpl: r.impl, nip98 })
  check(out.state === 'inconclusive' && /not JSON/.test(out.why),
    'an answer this page cannot read is inconclusive rather than absent — it will not invent a query API')
}
{
  // A failed community leg must not be softened by a proven public one.
  const v = pp.nameVerdict({ pub: { proven: 2, pushed: 2, asked: 2 }, community: { ok: false, reason: '403 RBAC' }, communityRead: null })
  check(/did not land/.test(v.text) && /the at-word does not resolve/.test(v.text),
    'a proven PUBLIC half does not hide a failed community leg — the name is what the operator came for')
}

// ------------------------------------------------------------------------------------------
console.log('\n7. the page wires it, and signs as the AGENT')
const page = readFileSync(join(ROOT, 'console/index.html'), 'utf8')
const pageCode = [...page.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).join('\n').replace(/^\s*\/\/.*$/gm, '')
check(/from '\.\/profile-publish\.mjs'/.test(page), 'index.html imports the publisher rather than assembling events inline')
// The whole point of this leg: waggle cannot publish this profile, and neither can the operator's
// key. `event.rs` rejects any event whose pubkey differs from the authenticated identity.
// Named at each site, not matched loosely: `signFresh(t, agentSigner)` already appears on this page
// from the admission leg, so a pattern that vague would pass with the profile signed by anyone.
check(/const signed = await signFresh\(template, agentSigner\)/.test(pageCode),
  'the PROFILE ITSELF is signed by the agent\'s bunker — the operator\'s key could not write this row')
const communityCall = pageCode.match(/publishCommunity\(\{[\s\S]{0,220}?\}\)/)
check(communityCall && /sign: t => signFresh\(t, agentSigner\)/.test(communityCall[0]),
  '  …and so is the request that carries it to the community relay')
check(!/publishCommunity\(\{[\s\S]{0,220}?signFresh\(t, signer\)/.test(pageCode),
  '  …and never by the operator\'s console session, which the relay would refuse as a pubkey mismatch')
// The adoption call has to happen BEFORE the template is built, or there is nothing to adopt.
// Both indexes checked for presence first: `indexOf` returns -1 for a call that is not there, and
// -1 is less than everything — so an ordering test alone reports a PASS for a page that never reads.
const iRead = pageCode.indexOf('await readPublic('), iTmpl = pageCode.indexOf('profileTemplate({')
check(iRead >= 0 && iTmpl >= 0 && iRead < iTmpl,
  'and the already-published profile is read BEFORE the new one is built, so nothing gets blanked')
check(/nameVerdict\(/.test(pageCode), 'and the page renders the verdict rather than its own summary of the pushes')

console.log(`\n${pass} passed, ${fail} failed`)
assert.equal(fail, 0, `${fail} assertion(s) failed`)
