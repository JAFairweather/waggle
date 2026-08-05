// #141 — admission and reachability are one lifecycle. A valid maintainer grant
// dynamically supplies a return address for p-tagged mentions/replies; a 441 removes it.
// No config edit or restart may be needed, and a bare admitted key must NOT turn every
// textual @mention into a delivery target (it has no configured human handle).

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'

const dir = mkdtempSync(resolve(tmpdir(), 'wb-admission-return-'))
const bridgeSk = generateSecretKey()
const grantorSk = generateSecretKey()
const grantorPk = getPublicKey(grantorSk)
const burnerPk = getPublicKey(generateSecretKey())
const authorPk = getPublicKey(generateSecretKey())
const CHAN = '55555555-5555-5555-5555-555555555555'

writeFileSync(resolve(dir, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: { relays: [], inbox: CHAN, staging_inbox: CHAN, watch_authors: [], watch_events: [], grantors: [grantorPk], return_lane: [] },
}))
process.env.CONFIG_PATH = resolve(dir, 'config.json')
process.env.SEND_JOURNAL_PATH = resolve(dir, 'send-journal.log')
process.env.SEEN_PATH = resolve(dir, 'seen.log')
process.env.POSTED_MAP_PATH = resolve(dir, 'posted.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.FORWARD_MODE = 'buzz'
process.env.WB_STUB_SEND = '1'
process.env.WB_NO_BOOT = '1'

const { processGrantEvent, activeReturnLane, scanReturnLane } = await import('../src/bridge.mjs')
const wire = ev => JSON.parse(JSON.stringify(ev))
const scope = () => {
  const salt = randomBytes(16).toString('hex')
  const hash = createHash('sha256').update(Buffer.concat([
    Buffer.from('waggle/da-scope/v1'), Buffer.from([0]), Buffer.from(CHAN), Buffer.from(salt, 'hex'),
  ])).digest('hex')
  return [hash, salt]
}
const grant = wire(finalizeEvent({ kind: 440, created_at: Math.floor(Date.now() / 1000), tags: [['p', burnerPk], ['da-scope', ...scope()], ['da-cap', 'admit']], content: '' }, grantorSk))
const journal = () => existsSync(process.env.SEND_JOURNAL_PATH)
  ? readFileSync(process.env.SEND_JOURNAL_PATH, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const returnRows = () => journal().filter(row => row.lane === 'return')
let failed = 0
const ok = (label, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) failed++ }

ok('an ungranted burner has no return address', activeReturnLane().length === 0)
processGrantEvent(grant)
ok('a valid grant auto-registers the burner as a return recipient', activeReturnLane().some(r => r.npub_hex === burnerPk && r.dynamic))

await scanReturnLane([{ id: 'a'.repeat(64), pubkey: authorPk, tags: [['p', burnerPk]], content: 'a structured reply for the burner' }])
ok('a p-tagged post reaches the admitted burner', returnRows().length === 1 && returnRows()[0].to === burnerPk.slice(0, 12))

await scanReturnLane([{ id: 'b'.repeat(64), pubkey: authorPk, tags: [], content: 'hello @someone else' }])
ok('a bare grant does not create a catch-all textual mention', returnRows().length === 1)

const rev = wire(finalizeEvent({ kind: 441, created_at: Math.floor(Date.now() / 1000) + 1, tags: [['e', grant.id]], content: '' }, grantorSk))
processGrantEvent(rev)
ok('a valid revocation removes the dynamic return address', !activeReturnLane().some(r => r.npub_hex === burnerPk))
await scanReturnLane([{ id: 'c'.repeat(64), pubkey: authorPk, tags: [['p', burnerPk]], content: 'must not leave after revocation' }])
ok('a revoked burner receives no later p-tagged carry', returnRows().length === 1)

console.log(failed ? `\nADMISSION RETURN FAIL — ${failed}` : '\nADMISSION RETURN PASS — grant and reachability share one lifecycle')
process.exit(failed ? 1 : 0)
