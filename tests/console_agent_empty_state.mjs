// console_agent_empty_state.mjs — an empty agent roster is not an empty hive (#321).
//
// The Agents page listed nothing and said "Nobody is in this hive yet." An owner who had just
// issued a 440 grant read that as a broken bridge and went looking for the fault. There was none:
// a grant admits a key to the community, and the waggle lifecycle roster is a different registry.
// #392 named that disagreement `grant_no_row` — "the agent can act, the roster denies it exists".
//
// The Agents tab is retired (#613 M4d); the hive page is where an owner meets this now. Its list is
// built from every source at once, so the invariant is structural rather than a sentence: an empty
// roster removes no row, and the one line about the roster is scoped to the roster.
//
//   node tests/console_agent_empty_state.mjs

import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import { scopeHash } from '../console/scope-hash.mjs'
import { scopeHashSync } from '../src/scope_hash.mjs'
import { readGrants, scopeTable, buildList } from '../console/hive-list.mjs'
import { FINDINGS } from '../src/registry_reconcile.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const key = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) } }
const O = key(), A = key(), C = key()
const SALT = 'ffeeddccbbaa99887766554433221100'
let t = 1700000000
const grant = (to, cap, subject = A.pk) => finalizeEvent({ kind: 440, created_at: ++t, tags: [['p', to], ['da-scope', scopeHashSync(subject, SALT), SALT], ['da-cap', cap]], content: '' }, O.sk)

// ---- 1. an empty roster removes no row ------------------------------------------------------------
const { grants, events: grantEvents } = readGrants([grant(O.pk, 'task'), grant(C.pk, 'task')], { verify: verifyEvent })
const table = await scopeTable([O.pk, A.pk, C.pk], grants, scopeHash)
const empty = buildList({ owner: O.pk, grantEvents, grants, table, roster: [] })
const rowA = empty.rows.find(r => r.pubkey === A.pk)
check(rowA && rowA.roles.length > 0, 'an agent with a live grant and no roster row is on the list, with its role')
check(empty.rows.some(r => r.pubkey === C.pk), '  …and so is the colleague the grant names')
const seated = buildList({ owner: O.pk, grantEvents, grants, table, roster: [{ pubkey: A.pk, status: 'admitted', return_lane: false }] })
check(seated.rows.length === empty.rows.length, 'a roster row adds a source to an existing row; it does not decide who is listed')
// NEGATIVE CONTROL — the list is capable of being empty, so the rows above are a measurement.
check(buildList({ owner: O.pk, grants: [], table, roster: [] }).rows.every(r => r.pubkey === O.pk),
  'NEGATIVE CONTROL — with no grants, no cards and no roster, only the owner is listed')

// ---- 2. the roster line is scoped to the roster --------------------------------------------------
const page = readFileSync(join(ROOT, 'console', 'hive.html'), 'utf8')
const fn = page.slice(page.indexOf('function bridgeControls('), page.indexOf('\n}\n', page.indexOf('function bridgeControls(')))
check(fn.length > 200 && fn.includes(`el('b', null, "waggle's list")`), "the roster line is headed waggle's list, so its answer has a scope")
const absent = /:\s*'([^']*)'\)\)/.exec(fn.slice(fn.indexOf('const entry =')))?.[1]
check(absent === 'not on it.', `an agent the roster lacks reads "${absent}", a statement about that list`)
const ABSENCE_CLAIMS = ['Nobody is in this hive', 'This hive has admitted no agents', 'No agents', 'no agents yet', 'There are no agents']
check(!ABSENCE_CLAIMS.some(c => page.includes(c)), 'the hive page makes no claim about the hive being empty')
check(ABSENCE_CLAIMS.some(c => 'Nobody is in this hive yet.'.includes(c)), 'NEGATIVE CONTROL — the same check DOES flag the sentence this issue was filed about')

// ---- 3. bound to the reconciler that named this ------------------------------------------------
check(FINDINGS.grant_no_row?.authority === 'grant', `#392 still models this case as grant_no_row (authority=${FINDINGS.grant_no_row?.authority})`)
check(/roster/i.test(FINDINGS.grant_no_row?.detail || ''), 'and still describes it as a grant the roster does not reflect')

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
