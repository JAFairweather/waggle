// NIP-DA admission regression test (annex §4.1.1, S3 tier).
//
// Proves processGrantEvent + routePublic: a maintainer-signed 440 scoped to THIS channel
// admits a stranger's public kind:1 past quarantine ("granted participant"); a 441 revokes
// it (back to quarantine); a 440 signed by a NON-grantor is ignored; a 440 scoped to a
// DIFFERENT channel is ignored; a forged-signature grant is dropped.
//
// Real signatures throughout (wire-form, so verifyEvent doesn't short-circuit on the
// finalize symbol). Side-effect-free: dryrun + temp state. Drives the REAL exports.
//
// Run: node tests/nipda_admission.mjs   (exit 0 = pass, 1 = fail)

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'

const tmp = mkdtempSync(join(tmpdir(), 'wb-da-'))
const grantorSk = generateSecretKey()
const grantorPk = getPublicKey(grantorSk)
const strangerSk = generateSecretKey()
const strangerPk = getPublicKey(strangerSk)
const outsiderSk = generateSecretKey() // a non-grantor who tries to issue grants

const CHAN = '55555555-5555-5555-5555-555555555555'   // our community inbox (resolved uuid)
const STAGE = '66666666-6666-6666-6666-666666666666'
const OTHER_CHAN = '77777777-7777-7777-7777-777777777777'
const POC = 'e'.repeat(64)

writeFileSync(join(tmp, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: [], inbox: CHAN, staging_inbox: STAGE,
    watch_authors: [], watch_events: [POC],
    grantors: [grantorPk],
  },
}))
process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'dryrun'
process.env.CONFIG_PATH = join(tmp, 'config.json')
process.env.SEEN_PATH = join(tmp, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(tmp, 'watermark')
process.env.POSTED_MAP_PATH = join(tmp, 'posted-map.log')

const { routePublic, processGrantEvent, grantSet } = await import('../src/bridge.mjs')

const wire = (ev) => JSON.parse(JSON.stringify(ev))
const now = () => Math.floor(Date.now() / 1000)
const salted = (chan) => {
  const salt = randomBytes(16).toString('hex')
  const hash = createHash('sha256').update(Buffer.concat([
    Buffer.from('waggle/da-scope/v1'), Buffer.from([0]), Buffer.from(chan), Buffer.from(salt, 'hex'),
  ])).digest('hex')
  return [hash, salt]
}
const grant = (sk, grantee, chan) => wire(finalizeEvent({
  kind: 440, created_at: now(),
  tags: [['p', grantee], ['da-scope', ...salted(chan)], ['da-cap', 'admit']], content: '',
}, sk))
const reply = (sk, pk) => wire(finalizeEvent({ kind: 1, created_at: now(), tags: [['e', POC]], content: 'a granted reply', pubkey: pk }, sk))

let buf = ''
console.log = console.error = (...a) => { buf += a.join(' ') + '\n' }
const routeOf = (ev) => { const before = buf.length; routePublic(ev); return buf.slice(before) }

let pass = true
const check = (cond, label) => { console.info(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

// Baseline: stranger reply with no grant -> STAGING.
check(/-> STAGING/.test(routeOf(reply(strangerSk, strangerPk))), 'ungranted stranger reply -> quarantine')

// A grant from a NON-grantor is ignored (authority check).
processGrantEvent(grant(outsiderSk, strangerPk, CHAN))
check(!grantSet.has(strangerPk), 'grant from non-grantor ignored')

// A grant scoped to a DIFFERENT channel is ignored (scope-hash binding).
processGrantEvent(grant(grantorSk, strangerPk, OTHER_CHAN))
check(!grantSet.has(strangerPk), 'grant scoped to another channel ignored')

// A forged-signature grant is dropped.
const forged = grant(grantorSk, strangerPk, CHAN); forged.sig = (forged.sig[0] === '0' ? '1' : '0') + forged.sig.slice(1)
processGrantEvent(forged)
check(!grantSet.has(strangerPk), 'forged-signature grant dropped')

// The real grant admits the stranger; the reply now routes to the community inbox.
const g = grant(grantorSk, strangerPk, CHAN)
processGrantEvent(g)
check(grantSet.has(strangerPk), 'valid grant admits the participant')
check(new RegExp(`-> inbox ${CHAN}`).test(routeOf(reply(strangerSk, strangerPk))), 'granted participant reply -> community inbox (no queue)')

// Revocation: the 441 e-tags the grant; the participant re-quarantines.
const rev = wire(finalizeEvent({ kind: 441, created_at: now(), tags: [['e', g.id]], content: '' }, grantorSk))
processGrantEvent(rev)
check(!grantSet.has(strangerPk), 'valid 441 revokes the grant')
check(/-> STAGING/.test(routeOf(reply(strangerSk, strangerPk))), 'revoked participant reply -> back to quarantine')

// ── #364: a grantee may hold SEVERAL grants, and revocation is per-grant ─────────────────────
//
// Everything above uses one grant, which is exactly why this went unnoticed: with a single grant
// the old last-write-wins map behaves identically. The two assertions immediately above are the
// negative control for this whole block — one grant in, one 441 out, still works — so "removes the
// right thing" cannot be satisfied here by "removes everything".
//
// The measured behaviour before this fix (issue #364, re-measured on this branch):
//   revoke the grant the map was NOT holding  -> silent, no line at all
//   revoke the grant it WAS holding           -> de-admitted, while another grant was still live
{
  const multiSk = generateSecretKey()
  const multiPk = getPublicKey(multiSk)
  const g1 = grant(grantorSk, multiPk, CHAN)
  const g2 = grant(grantorSk, multiPk, CHAN)
  const kill = (id) => wire(finalizeEvent({ kind: 441, created_at: now(), tags: [['e', id]], content: '' }, grantorSk))
  const logOf = (fn) => { const before = buf.length; fn(); return buf.slice(before) }

  logOf(() => { processGrantEvent(g1); processGrantEvent(g2) })
  check(grantSet.has(multiPk), 'two grants for one grantee: admitted')

  // Revoking either one must leave them admitted. Deliberately revoke g2 — the one the OLD code
  // stored — because that is the case that used to de-admit a key holding a live grant.
  const outOne = logOf(() => processGrantEvent(kill(g2.id)))
  check(grantSet.has(multiPk), 'revoking ONE of two grants leaves the grantee admitted — the other is still live (#364)')
  check(/keeps 1 live grant/.test(outOne),
    '…and says so, naming how many remain — the old code was silent here, which is what made it undiagnosable')
  check(/-> inbox/.test(routeOf(reply(multiSk, multiPk))), '…and the routing agrees: still past quarantine')

  const outAll = logOf(() => processGrantEvent(kill(g1.id)))
  check(!grantSet.has(multiPk), 'revoking the LAST grant removes the grantee')
  check(/held no other grant/.test(outAll), '…and the line distinguishes that from revoking one of several')
  check(/-> STAGING/.test(routeOf(reply(multiSk, multiPk))), '…and the routing agrees: back to quarantine')

  // The relay serves both 440s forever, so every reconnect replays them.
  const outReplay = logOf(() => { processGrantEvent(g1); processGrantEvent(g2) })
  check(!grantSet.has(multiPk), 'a reconnect replaying BOTH 440s does not re-admit a fully revoked grantee')
  check((outReplay.match(/drop\[revoked\]/g) || []).length === 2, '…and both are refused by id, loudly, not merely ignored')

  // A 441 for something nobody holds is ORDINARY — the 440 usually has not arrived yet — but it
  // must not look the same in the journal as a revocation that removed someone.
  //
  // Fired while a DIFFERENT grantee is admitted, deliberately. With an empty grantSet the loop body
  // never runs, so a version that deleted the target from every grantee rather than only from the
  // one holding it would pass unnoticed — it did, until this bystander was added.
  const bystanderSk = generateSecretKey(), bystanderPk = getPublicKey(bystanderSk)
  const gBystanderReplay = grant(grantorSk, bystanderPk, CHAN)
  processGrantEvent(gBystanderReplay)
  check(grantSet.has(bystanderPk), 'a bystander grantee is admitted')
  const unheld = logOf(() => processGrantEvent(kill('9'.repeat(64))))
  check(/revocation recorded/.test(unheld) && /no admitted grantee is holding/.test(unheld),
    'a 441 for a grant nobody holds is RECORDED and logged, not silently dropped')
  check(!/NIPDA revoked/.test(unheld), '…and is not reported as having revoked anybody')
  check(grantSet.has(bystanderPk) && !unheld.includes(bystanderPk.slice(0, 12)),
    '…and it does not touch, or even name, a grantee who was never holding that grant')

  // Replays happen on every reconnect. A 440 we already hold must not re-announce itself, or the
  // journal fills with admissions that did not happen.
  const quiet = logOf(() => processGrantEvent(grant(grantorSk, bystanderPk, CHAN)))
  check(/NIPDA granted/.test(quiet), 'a genuinely NEW grant for an already-admitted grantee is announced')
  const again = logOf(() => processGrantEvent(gBystanderReplay))
  check(!/NIPDA granted/.test(again),
    'but replaying a 440 already held says nothing — every reconnect replays, and re-announcing is journal flood')

  // Order-independence, re-pinned here because it is now the same model doing the work.
  const lateSk = generateSecretKey(), latePk = getPublicKey(lateSk)
  const gl = grant(grantorSk, latePk, CHAN)
  processGrantEvent(kill(gl.id))          // the 441 arrives FIRST, as most relays serve it
  processGrantEvent(gl)
  check(!grantSet.has(latePk), 'a 441 delivered before its own 440 still keeps the key out (#361/#368)')

  // …and the control for THAT: a grant with no revocation still admits, so the guard above is not
  // simply refusing every 440 that arrives late.
  const okSk = generateSecretKey(), okPk = getPublicKey(okSk)
  processGrantEvent(grant(grantorSk, okPk, CHAN))
  check(grantSet.has(okPk), 'an unrevoked grant arriving at the same point still admits')
}

console.info(pass ? '\nNIPDA PASS — admission tier holds, and a grantee may hold more than one grant' : '\nNIPDA FAIL')
process.exit(pass ? 0 : 1)
