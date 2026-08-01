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

console.info(pass ? '\nNIPDA PASS — admission tier holds' : '\nNIPDA FAIL')
process.exit(pass ? 0 : 1)
