// console_hive_what_if.mjs — "what happens if" on the hive page (#613 M3, criterion 5).
//
// What this suite holds:
//
//  1. The rows handed to nvoy's nativeGrant have exactly the shape attention.mjs --policy-only gives
//     the broker, so the vendored decision runs on the input the broker's runs on.
//  2. The answers follow the broker's order and rules: a DM from anyone but the owner is refused
//     before any grant is read, a voice gives work in a channel but never in a DM, a withdrawn or
//     replaced approval admits nothing, and the approval named is the one the fold counts.
//  3. What the page cannot see is said: no card, and limits whose counters live on the fleet.
//  4. The page offers the check and words it without protocol terms or keys in hex.
//
//   node tests/console_hive_what_if.mjs

import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import { scopeHash } from '../console/scope-hash.mjs'
import { scopeHashSync } from '../src/scope_hash.mjs'
import { readGrants, scopeTable, buildList, CARD_D, CARD_KIND } from '../console/hive-list.mjs'
import { nativeGrant } from '../console/vendor/nvoy-admission.mjs'
import { policyGrants, whatIf } from '../console/hive-what-if.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const key = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) } }
const O = key(), A = key(), C = key(), V = key(), S = key(), R = key(), N = key()
const SALT = 'ffeeddccbbaa99887766554433221100'
let t = 1700000000
const grant = (to, cap, subject = A.pk, sk = O.sk) => finalizeEvent({ kind: 440, created_at: ++t, tags: [['p', to], ['da-scope', scopeHashSync(subject, SALT), SALT], ['da-cap', cap]], content: '' }, sk)
const revoke = (ev, sk = O.sk) => finalizeEvent({ kind: 441, created_at: ++t, tags: [['e', ev.id]], content: '' }, sk)
const card = (k, extra = {}) => finalizeEvent({ kind: CARD_KIND, created_at: ++t, tags: [['d', CARD_D]], content: JSON.stringify({ version: 1, pubkey: k.pk, grantors: [O.pk], agent_limits: { max_hops: 10, per_sender_per_hour: 30 }, ...extra }) }, k.sk)

const ownerAct = grant(O.pk, 'task+act')                // the owner may task A, and A acts without asking
const ownerTask = grant(O.pk, 'task')                    // the owner's plain work approval, also held
const colleagueOld = grant(C.pk, 'task')
const colleague = grant(C.pk, 'task')                    // newer copy: the one the fold counts
const voice = finalizeEvent({ kind: 440, created_at: ++t, tags: [['p', V.pk], ['da-scope', scopeHashSync(O.pk, SALT), SALT], ['da-cap', 'shadow']], content: '' }, O.sk)
const gone = grant(R.pk, 'task')
const goneRevoke = revoke(gone)
const events = [ownerAct, ownerTask, colleagueOld, colleague, voice, gone, goneRevoke, grant(N.pk, 'task', N.pk)]

const { grants, events: grantEvents } = readGrants(events, { verify: verifyEvent })
const table = await scopeTable([O.pk, A.pk, C.pk, V.pk, S.pk, R.pk, N.pk], grants, scopeHash)
const cards = new Map([[A.pk, { ...JSON.parse(card(A).content), signedAt: t }]])
const { rows } = buildList({ owner: O.pk, grantEvents, grants, table, cards })
const rowA = rows.find(r => r.pubkey === A.pk), rowN = rows.find(r => r.pubkey === N.pk)
const names = { [A.pk]: 'Pi Dog', [C.pk]: 'DJ Codex', [V.pk]: 'Dead Rabbit', [S.pk]: 'a stranger', [R.pk]: 'Retired', [N.pk]: 'Newcomer' }
const nameOf = pk => pk === O.pk ? 'you' : names[pk] || 'someone'
const ask = (author, dm, row = rowA) => whatIf({ author, row, dm, owner: O.pk, nameOf })

// ── 1. The broker's input shape ──────────────────────────────────────────────────────────────────
const policy = policyGrants(rowA.answers.fold)
check(policy.length > 0 && policy.every(g => JSON.stringify(Object.keys(g)) === (g.shadow ? '["pubkey","cap","grant_id","grantor","shadow"]' : '["pubkey","cap","grant_id","grantor"]')),
  "every row has attention.mjs --policy-only's fields, in its order: pubkey, cap, grant_id, grantor, and shadow only when set")
check(policy.every(g => /^[0-9a-f]{64}$/.test(g.grant_id) && g.grantor === g.grantor.toLowerCase()), 'grant ids are hex and grantors lower-case, as the broker passes them')
// The answer is nativeGrant's, for every author and both places.
let agree = true
for (const author of [O.pk, C.pk, V.pk, S.pk, R.pk, A.pk]) for (const dm of [false, true]) {
  if (author === A.pk) continue
  const expected = nativeGrant({ author, dm, grants: policy, grantors: [O.pk] })
  const got = ask(author, dm)
  if (Boolean(expected) !== got.work || (expected && expected.grant_id !== got.grant.grant_id)) agree = false
}
check(agree, "for every author, in a channel and in a DM, the answer is the vendored nativeGrant's: same verdict, same approval")

// ── 2. The broker's rules, in words ──────────────────────────────────────────────────────────────
{
  const r = ask(O.pk, false)
  check(r.work && r.grant.cap === 'task+act' && /^Admitted as work in a channel it listens in, through your act-without-asking approval from you/.test(r.text) && /may act on it without asking/.test(r.text),
    `the owner, in a channel: work, on the act-without-asking approval nativeGrant prefers ("${r.text.slice(0, 70)}…")`)
  check(ask(O.pk, true).work, 'and in a DM too: the owner is the one author a DM admits')
}
{
  const r = ask(C.pk, false)
  check(r.work && r.grant.grant_id === colleague.id && /asks before acting/.test(r.text), "a colleague in a channel: work, through the newer copy of its approval, the one nvoy's fold counts")
  const d = ask(C.pk, true)
  check(!d.work && /In a DM only Pi Dog's owner can give it work/.test(d.text) && d.grant === null, 'the same colleague in a DM: chat only, refused before any approval is read')
}
{
  const r = ask(V.pk, false)
  check(r.work && r.grant.shadow && /as your voice/.test(r.text), "the owner's voice in a channel: work, as your voice")
  check(!ask(V.pk, true).work, 'but never in a DM: a voice is not the owner')
}
check(!ask(S.pk, false).work && /holds no live approval to give Pi Dog work/.test(ask(S.pk, false).text), 'a stranger: chat only, because it holds no approval')
check(!ask(R.pk, false).work, 'an author whose approval was withdrawn: chat only')
check(!ask(A.pk, false).work && /its own messages/.test(ask(A.pk, false).text), 'an agent is never given work by its own message')

// ── 3. What the page cannot see ──────────────────────────────────────────────────────────────────
check(ask(O.pk, false).caveats.some(c => /chain of agent messages stops at 10 hops/.test(c)) && !ask(O.pk, false).caveats.some(c => /an hour/.test(c)),
  'for the owner only the hop limit applies; the hourly cap is not charged to a grantor')
check(ask(C.pk, false).caveats.some(c => /at most 30 admitted an hour from DJ Codex, and a chain stops at 10 hops/.test(c) && /counters are on the fleet/.test(c)),
  'for anyone else both limits apply, and the page says the counters are on the fleet')
{
  const r = ask(O.pk, false, rowN)
  check(rowN && !rowN.card && r.caveats.some(c => /no agent card/.test(c) && /only your approvals are counted/.test(c)), 'an agent with no card: the answer says nothing is reported about what runs, and whose approvals count')
}
const allText = [O.pk, C.pk, V.pk, S.pk, R.pk].flatMap(a => [false, true].flatMap(dm => { const r = ask(a, dm); return [r.text, ...r.caveats] })).join(' ')
check(!/[0-9a-f]{64}/.test(allText), 'no answer carries a key or an id in hex')

// ── 4. The page ──────────────────────────────────────────────────────────────────────────────────
const page = readFileSync(join(ROOT, 'console/hive.html'), 'utf8')
check(page.includes("from './hive-what-if.mjs'") && /whatIf\(\{/.test(page), 'hive.html answers "what happens if" through hive-what-if.mjs')
check(/id="what-if-panel"/.test(page) && /What happens if/.test(page), 'and offers it in its own panel')

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
