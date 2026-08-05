import { mkdtempSync, chmodSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PolicyJournal } from '../src/policy_journal.mjs'

let fails = 0
const t = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} — ${name}`); if (!ok) fails++ }
const rejects = (name, fn, pattern) => { try { fn(); t(name, false) } catch (e) { t(name, pattern.test(e.message)) } }
const dir = mkdtempSync(resolve(tmpdir(), 'waggle-policy-journal-'))
chmodSync(dir, 0o700)
const key = 'a'.repeat(64), request = 'b'.repeat(64), receipt = '{"signed":"receipt-one"}', event = 'd'.repeat(64)
const first = new PolicyJournal(dir)

const claim = first.claim(key, request, 100)
t('the first process atomically claims the key', claim.claimed && claim.record.status === 'in-flight')
t('the claim is a durable canonical record', first.get(key)?.claimed_at === 100)
const second = new PolicyJournal(dir)
const repeat = second.claim(key, request, 101)
t('a second process converges on the existing in-flight claim', !repeat.claimed && repeat.record.claimed_at === 100)
rejects('a duplicate process cannot complete the first process claim', () => second.commit(key, request, { receipt, buzzEventId: event, result: 'accepted' }), /does not own/)
rejects('the same key cannot be reused for different request bytes', () => second.claim(key, 'e'.repeat(64)), /another request digest/)
rejects('an unclaimed key cannot be committed', () => first.commit('f'.repeat(64), request, { receipt, result: 'refused' }), /unclaimed/)

const done = first.commit(key, request, { receipt, buzzEventId: event, result: 'accepted', completedAt: 110 })
t('completion atomically replaces the in-flight claim', done.status === 'terminal' && done.buzz_event_id === event)
const afterRestart = new PolicyJournal(dir).claim(key, request, 120)
t('a restarted process receives the terminal result and never reclaims', !afterRestart.claimed && afterRestart.record.status === 'terminal')
t('a duplicate commit returns the exact prior receipt bytes', second.commit(key, request, { receipt: '{"different":true}', result: 'refused' }).receipt === receipt)
rejects('an accepted result requires the policy-derived Buzz id', () => {
  const k = '1'.repeat(64); first.claim(k, '2'.repeat(64)); first.commit(k, '2'.repeat(64), { receipt, result: 'accepted' })
}, /requires buzz_event_id/)
rejects('an empty receipt cannot become terminal state', () => {
  const k = '6'.repeat(64); first.claim(k, '7'.repeat(64)); first.commit(k, '7'.repeat(64), { receipt: '', result: 'refused' })
}, /receipt must/)

const corruptKey = '4'.repeat(64)
writeFileSync(resolve(dir, `${corruptKey}.json`), '{}\n', { mode: 0o600 })
rejects('corrupt state fails loudly rather than looking unclaimed', () => first.get(corruptKey), /invalid version/)
const linkKey = '5'.repeat(64)
symlinkSync(resolve(dir, `${key}.json`), resolve(dir, `${linkKey}.json`))
rejects('a symlinked record is refused', () => first.get(linkKey), /private regular file/)
const hugeKey = '8'.repeat(64)
writeFileSync(resolve(dir, `${hugeKey}.json`), 'x'.repeat(96 * 1024 + 1), { mode: 0o600 })
rejects('an oversized record is refused before parsing', () => first.get(hugeKey), /record size/)

const orphanKey = '9'.repeat(64), orphanRequest = '3'.repeat(64), recoverySecret = 'recovery_secret_0123456789abcdef'
new PolicyJournal(dir).claim(orphanKey, orphanRequest, 500)
const recovery = new PolicyJournal(dir, { recoverySecret })
rejects('a bridge process cannot resolve an orphan without the policy-host secret', () => recovery.resolveOrphan(orphanKey, orphanRequest, 500, { recoverySecret: 'wrong_secret_0123456789abcdefgh', receipt }), /authorization failed/)
rejects('an operator cannot resolve a stale observation of the claim', () => recovery.resolveOrphan(orphanKey, orphanRequest, 499, { recoverySecret, receipt }), /changed since operator inspection/)
const resolved = recovery.resolveOrphan(orphanKey, orphanRequest, 500, { recoverySecret, receipt, completedAt: 510 })
t('an operator can terminalize a proven-dead orphan without claiming the post failed', resolved.status === 'terminal' && resolved.result === 'ambiguous' && resolved.buzz_event_id === null)
t('restart converges on the signed ambiguous receipt', new PolicyJournal(dir).claim(orphanKey, orphanRequest, 520).record.receipt === receipt)

console.log(fails ? `\npolicy_journal: ${fails} FAILED` : '\npolicy_journal: all checks passed')
process.exit(fails ? 1 : 0)
