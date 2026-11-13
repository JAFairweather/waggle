// console_hive_onboard.mjs — the owner's onboard grant from the console (DESIGN_ONBOARDING_DELEGATE,
// Part 1, piece 6).
//
// What this suite holds:
//
//  1. The page drafts an onboard grant only past the owner's own ticks: terms it could read, his
//     agreement and his age confirmation. It never ticks either, and a terms version the fleet would
//     not accept is refused.
//  2. The drafted 440 carries `da-cap onboard`, the delegate in `p`, a scope over the owner's own key,
//     and the `policy` and `age` consent tags, as the fleet's fold reads them. When an nvoy checkout
//     is present (NVOY_DIR, or ../nvoy-main or ../nvoy beside this repo), its foldOnboardGrants is run
//     on the signed grant to prove the fleet reads it as live with both tags.
//  3. The issued grant reads back cold from simulated relays with both tags (applyChange, unchanged).
//  4. A 441 from the owner reads back and the fold shows the grant revoked, whatever the timestamps,
//     as the fleet does; a 441 from anyone else revokes nothing.
//  5. A live grant says whether the fleet accepts requests under it against the hive's current terms.
//
//   node tests/console_hive_onboard.mjs

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import { scopeHash } from '../console/scope-hash.mjs'
import { scopeHashSync } from '../src/scope_hash.mjs'
import { applyChange, draftRevoke } from '../console/hive-change.mjs'
import { ONBOARD_CAP, onboardGate, draftOnboardGrant, onboardGrantsOf, describeOnboard } from '../console/hive-onboard.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const threw = async fn => { try { await fn(); return null } catch (e) { return e.message } }

const ownerSk = generateSecretKey(), owner = getPublicKey(ownerSk)
const strangerSk = generateSecretKey(), stranger = getPublicKey(strangerSk)
const delegate = getPublicKey(generateSecretKey())
const sign = sk => t => finalizeEvent({ ...t, tags: t.tags.map(x => [...x]) }, sk)
const SALT = '00112233445566778899aabbccddeeff'
const TERMS = { ok: true, version: '2026-11-01', age: true, terms: 'the terms', privacy: 'the privacy notice' }
const tagOf = (ev, n) => ev.tags.find(t => t[0] === n)

// Simulated relays, as in console_hive_change.mjs: `ok` stores, `drop` acknowledges and stores nothing.
function relays(spec) {
  const state = new Map(Object.entries(spec).map(([url, mode]) => [url, { mode, store: new Map() }]))
  const connect = url => {
    const r = state.get(url)
    if (!r || r.mode === 'down') throw new Error('refused')
    const ws = { send(raw) {
      const m = JSON.parse(raw)
      setTimeout(() => {
        if (m[0] === 'EVENT') { if (r.mode === 'ok') r.store.set(m[1].id, m[1]); ws.onmessage?.({ data: JSON.stringify(['OK', m[1].id, true, '']) }) }
        if (m[0] === 'REQ') {
          const [, sub, ...filters] = m
          for (const ev of r.store.values()) if (filters.some(f => matches(ev, f))) ws.onmessage?.({ data: JSON.stringify(['EVENT', sub, ev]) })
          ws.onmessage?.({ data: JSON.stringify(['EOSE', sub]) })
        }
      }, 0)
    }, close() {} }
    setTimeout(() => ws.onopen?.(), 0)
    return ws
  }
  return { connect, state, urls: Object.keys(spec), all: () => [...new Map([...state.values()].flatMap(r => [...r.store])).values()] }
}
function matches(ev, f) {
  if (f.ids && !f.ids.includes(ev.id)) return false
  if (f.kinds && !f.kinds.includes(ev.kind)) return false
  if (f.authors && !f.authors.includes(ev.pubkey)) return false
  if (f['#e'] && !ev.tags.some(t => t[0] === 'e' && f['#e'].includes(t[1]))) return false
  return true
}
const TWO = ['wss://a.test', 'wss://b.test']
const opts = (net, over = {}) => ({ sign: sign(ownerSk), owner, verify: verifyEvent, connect: net.connect, relays: net.urls, timeoutMs: 200, ...over })

console.log('onboard grant: the owner ticks, the page drafts')
{
  check(!onboardGate(TERMS, {}).ok, 'nothing ticked: no grant')
  check(!onboardGate(TERMS, { agreed: true }).ok && /age/.test(onboardGate(TERMS, { agreed: true }).reason), 'terms agreed but no age tick: no grant, and it says the age tick is missing')
  check(!onboardGate(TERMS, { ageConfirmed: true }).ok, 'age ticked but terms not agreed: no grant')
  check(onboardGate(TERMS, { agreed: true, ageConfirmed: true }).ok, 'both ticked: the page may draft')
  check(!onboardGate({ ok: false, reason: 'timeout' }, { agreed: true, ageConfirmed: true }).ok, "terms it could not read: no grant, whatever was ticked")
  const noAge = { ...TERMS, age: false }
  check(!onboardGate(noAge, { agreed: true }).ok, 'even where the terms ask no age attestation, the onboard grant needs the age tick (the fleet requires it)')
  check(!onboardGate({ ...TERMS, version: 'two words' }, { agreed: true, ageConfirmed: true }).ok, 'a terms version the fleet would not accept is refused')
  const none = { ok: true, version: 'none', age: false, terms: '', privacy: '' }
  check(!onboardGate(none, { ageConfirmed: true }).ok && onboardGate(none, { agreed: true, ageConfirmed: true }).ok, 'a hive with no terms still needs the owner to tick for himself')

  const draft = () => draftOnboardGrant({ delegate, owner, terms: TERMS, agreed: true, ageConfirmed: true, scopeHash, salt: SALT, now: 1794600000 })
  const t = await draft()
  check(t.kind === 440 && t.content === '' && t.created_at === 1794600000, 'a 440 with no content')
  check(JSON.stringify(t.tags.map(x => x[0])) === JSON.stringify(['p', 'da-scope', 'da-cap', 'policy', 'age']), 'tags in order: p, da-scope, da-cap, policy, age')
  check(tagOf(t, 'p')[1] === delegate && tagOf(t, 'da-cap')[1] === ONBOARD_CAP, 'the delegate is the grantee, and the cap is onboard')
  check(tagOf(t, 'da-scope')[1] === scopeHashSync(owner, SALT) && tagOf(t, 'da-scope')[2] === SALT, "the scope is the owner's own key, salted, as both hash implementations agree")
  check(tagOf(t, 'policy')[1] === TERMS.version && tagOf(t, 'age')[1] === 'confirmed', "policy is the terms version he was shown, and age is confirmed")
  check(/age/.test(await threw(() => draftOnboardGrant({ delegate, owner, terms: TERMS, agreed: true, scopeHash, salt: SALT }))), 'draftOnboardGrant itself refuses without the age tick')
  check(/agree/.test(await threw(() => draftOnboardGrant({ delegate, owner, terms: TERMS, ageConfirmed: true, scopeHash, salt: SALT }))), 'draftOnboardGrant itself refuses without the agreement')
  check(!!await threw(() => draftOnboardGrant({ delegate: owner, owner, terms: TERMS, agreed: true, ageConfirmed: true, scopeHash, salt: SALT })), 'no onboard grant to oneself')
  check(!!await threw(() => draftOnboardGrant({ delegate: 'npub1x', owner, terms: TERMS, agreed: true, ageConfirmed: true, scopeHash, salt: SALT })), 'a delegate that is not a hex key is refused')
  const a = await draftOnboardGrant({ delegate, owner, terms: TERMS, agreed: true, ageConfirmed: true, scopeHash })
  const b = await draftOnboardGrant({ delegate, owner, terms: TERMS, agreed: true, ageConfirmed: true, scopeHash })
  check(tagOf(a, 'da-scope')[2] !== tagOf(b, 'da-scope')[2], 'a fresh salt each time')
  check(/terms \(2026-11-01\)/.test(describeOnboard({ action: 'give', delegate, policy: TERMS.version }, () => 'Dead Rabbit')) &&
    /Withdraw/.test(describeOnboard({ action: 'stop', grant: { id: 'ab'.repeat(32), delegate } }, () => 'Dead Rabbit')), 'the confirm panel names the terms version and the delegate')
}

console.log('onboard grant: issue, read back cold, fold, revoke')
{
  const net = relays(Object.fromEntries(TWO.map(u => [u, 'ok'])))
  const template = await draftOnboardGrant({ delegate, owner, terms: TERMS, agreed: true, ageConfirmed: true, scopeHash })
  const given = await applyChange(template, opts(net))
  check(given.verdict.done && given.verdict.holding.length === 2, 'the issued grant reads back cold from both relays')
  const held = net.all().find(e => e.id === given.signed.id)
  check(!!held && tagOf(held, 'policy')[1] === TERMS.version && tagOf(held, 'age')[1] === 'confirmed', 'the copy a relay serves back carries both consent tags')
  const swapped = await threw(() => applyChange(template, opts(net, { sign: t => sign(ownerSk)({ ...t, tags: t.tags.filter(x => x[0] !== 'age') }) })))
  check(/not the one shown/.test(swapped || ''), 'a signer that drops the age tag publishes nothing')
  const other = await threw(() => applyChange(template, opts(net, { sign: sign(strangerSk) })))
  check(/different key/.test(other || ''), 'a signer with another key publishes nothing (the scope binds the grant to its signer)')

  let shown = await onboardGrantsOf(net.all(), { owner, verify: verifyEvent, scopeHash, terms: TERMS })
  check(shown.length === 1 && shown[0].live && shown[0].delegate === delegate && shown[0].policy === TERMS.version && shown[0].age === 'confirmed', 'the grid shows it live, with its delegate, terms version and age')
  check(shown[0].usable.ok === true, 'and says the fleet accepts requests under it')
  check((await onboardGrantsOf(net.all(), { owner, verify: verifyEvent, scopeHash, terms: { ...TERMS, version: '2026-12-01' } }))[0].usable.ok === false,
    'once the hive serves new terms, the grid says to sign a new one')
  check((await onboardGrantsOf(net.all(), { owner, verify: verifyEvent, scopeHash, terms: { ok: false } }))[0].usable.ok === null, 'unreadable terms: usable is unknown, not yes')

  // Other people's grants and other caps are not his onboard grants.
  const foreign = sign(strangerSk)({ kind: 440, created_at: 1, content: '', tags: [['p', delegate], ['da-scope', scopeHashSync(stranger, SALT), SALT], ['da-cap', 'onboard'], ['policy', TERMS.version], ['age', 'confirmed']] })
  const task = sign(ownerSk)({ kind: 440, created_at: 1, content: '', tags: [['p', delegate], ['da-scope', scopeHashSync(owner, SALT), SALT], ['da-cap', 'task']] })
  const wrongScope = sign(ownerSk)({ kind: 440, created_at: 1, content: '', tags: [['p', delegate], ['da-scope', scopeHashSync(delegate, SALT), SALT], ['da-cap', 'onboard'], ['policy', TERMS.version], ['age', 'confirmed']] })
  const expired = sign(ownerSk)({ kind: 440, created_at: 1, content: '', tags: [['p', delegate], ['da-scope', scopeHashSync(owner, SALT), SALT], ['da-cap', 'onboard'], ['policy', TERMS.version], ['age', 'confirmed'], ['expiration', '2']] })
  const forged = { ...sign(ownerSk)({ kind: 440, created_at: 1, content: '', tags: template.tags }), sig: '00'.repeat(64) }
  shown = await onboardGrantsOf([...net.all(), foreign, task, wrongScope, forged, expired], { owner, verify: verifyEvent, scopeHash, terms: TERMS })
  check(shown.filter(g => g.live).length === 1 && !shown.some(g => g.id === foreign.id || g.id === task.id || g.id === wrongScope.id || g.id === forged.id),
    "only the owner's own verified onboard grants over his own key are shown")
  check(shown.find(g => g.id === expired.id)?.state === 'expired', 'an expired grant shows as ended, not live')

  // Revocation: a 441 from the owner, read back; it wins even when dated before the grant.
  const backdated = { ...draftRevoke({ grantId: given.signed.id }), created_at: given.signed.created_at - 3600 }
  const stopped = await applyChange(backdated, opts(net))
  check(stopped.verdict.done, 'the 441 reads back and no relay still serves the grant without it')
  shown = await onboardGrantsOf(net.all(), { owner, verify: verifyEvent, scopeHash, terms: TERMS })
  check(shown.find(g => g.id === given.signed.id)?.state === 'revoked', 'the grid shows it revoked, though the 441 is dated before the grant (as the fleet folds it)')
  const strangers441 = sign(strangerSk)(draftRevoke({ grantId: given.signed.id }))
  const second = await applyChange(await draftOnboardGrant({ delegate, owner, terms: TERMS, agreed: true, ageConfirmed: true, scopeHash }), opts(net))
  const foreign441 = sign(strangerSk)(draftRevoke({ grantId: second.signed.id }))
  shown = await onboardGrantsOf([...net.all(), strangers441, foreign441], { owner, verify: verifyEvent, scopeHash, terms: TERMS })
  check(shown.find(g => g.id === second.signed.id)?.live === true, "a 441 from someone else revokes nothing")

  // The fleet's own fold, when an nvoy checkout is here: it must read the console's grant as live with
  // both consent tags, and as revoked after the console's 441.
  const nvoyDir = [process.env.NVOY_DIR, join(ROOT, '..', 'nvoy-main'), join(ROOT, '..', 'nvoy')].find(d => d && existsSync(join(d, 'mcp/tools/onboard_delegate.mjs')))
  if (nvoyDir) {
    const { foldOnboardGrants } = await import(pathToFileURL(join(nvoyDir, 'mcp/tools/onboard_delegate.mjs')).href)
    const fleetFold = events => foldOnboardGrants(events, { grantors: [owner], verify: verifyEvent, scopeHash: scopeHashSync })
    const before = fleetFold([given.signed, second.signed])
    const asFleet = (before.live.get(delegate) || []).find(g => g.grantId === second.signed.id)
    check(!!asFleet && asFleet.policy === TERMS.version && asFleet.age === 'confirmed', "nvoy's foldOnboardGrants reads the console's grant as live, with policy and age")
    const after = fleetFold(net.all())
    check(!(after.live.get(delegate) || []).some(g => g.grantId === given.signed.id) && (after.live.get(delegate) || []).some(g => g.grantId === second.signed.id),
      "nvoy's fold agrees: the revoked grant is gone, the other still live")
  } else console.log('skip — no nvoy checkout here (set NVOY_DIR) for the fleet-fold cross-check')
}

console.log(pass ? '\nconsole hive onboard: all checks pass' : '\nconsole hive onboard: FAILURES')
process.exit(pass ? 0 : 1)
