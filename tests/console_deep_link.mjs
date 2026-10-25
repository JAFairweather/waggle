// console_deep_link.mjs — a link may fill a grant form or open a revoke; it may not choose a key.
//
// The beeswarm page links here with 8-hex prefixes, because that is all the sanitised swarm carries.
// The property that matters is that a link resolves only against keys and grant ids the console
// has already verified for the signed-in key. A link that could resolve to anything would let a
// crafted URL aim a grant at a stranger, and the confirm panel would show a well-formed grant to a
// key nobody reads.
//
// So these assert both directions: a known prefix fills, an unknown or ambiguous one refuses; a live
// grant opens its revoke, a revoked or foreign one does not. And the page wiring is checked for the
// one thing a link must never do, which is sign.
//
//   node tests/console_deep_link.mjs

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseIntent, resolvePrefix, resolveGrant, resolveRevoke } from '../console/deep-link.mjs'
import { ISSUABLE } from '../console/capability-vocabulary.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = true
const ok = (label, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const key = c => c.repeat(64)
const alpha = 'aaaa1111' + key('1').slice(8), beta = 'bbbb2222' + key('2').slice(8), twin = 'aaaa1111' + key('3').slice(8)
const me = key('9')

// --- parsing ---
ok('a revoke link names a grant by prefix', JSON.stringify(parseIntent('#revoke=E970D972')) === JSON.stringify({ action: 'revoke', grant: 'e970d972' }))
ok('a grant link names grantee, agent and cap', JSON.stringify(parseIntent('#grant=aaaa1111&on=bbbb2222&cap=task%2Bact')) === JSON.stringify({ action: 'grant', to: 'aaaa1111', on: 'bbbb2222', cap: 'task+act' }))
ok('a prefix shorter than 8 hex is not a key', parseIntent('#revoke=e970').action === 'invalid' && parseIntent('#grant=aaaa&on=bbbb2222').action === 'invalid')
ok('an npub, markup or a missing agent is refused, not guessed', parseIntent('#grant=npub1xyz&on=bbbb2222').action === 'invalid'
  && parseIntent('#grant=aaaa1111').action === 'invalid' && parseIntent('#grant=aaaa1111&on=bbbb2222&cap=<b>').action === 'invalid')
ok('no hash, or an unrelated one, is no intent', parseIntent('') === null && parseIntent('#access') === null)

// --- resolution: only what the console already holds ---
ok('a prefix of exactly one known key resolves to it', resolvePrefix('bbbb2222', [alpha, beta, me]).value === beta)
ok('a prefix of two known keys resolves to neither', resolvePrefix('aaaa1111', [alpha, twin, me]).value === null)
ok('a prefix of no known key resolves to nothing', resolvePrefix('cccc3333', [alpha, beta, me]).value === null)
const filled = resolveGrant({ to: 'aaaa1111', on: 'bbbb2222', cap: 'task' }, { known: [alpha, beta, me], issuable: ISSUABLE.agent })
ok('a grant link between two known keys fills all three fields', filled.to === alpha && filled.on === beta && filled.cap === 'task' && !filled.why)
ok('a grant link to a key this console never read is refused', /grantee/.test(resolveGrant({ to: 'dddd4444', on: 'bbbb2222', cap: 'task' }, { known: [alpha, beta, me], issuable: ISSUABLE.agent }).why || ''))
ok('a cap that cannot be issued over an agent is refused', !!resolveGrant({ to: 'aaaa1111', on: 'bbbb2222', cap: 'admit' }, { known: [alpha, beta], issuable: ISSUABLE.agent }).why)

const grants = [{ id: 'e970d972' + key('a').slice(8), grantee: alpha, live: true }, { id: '503099b6' + key('b').slice(8), grantee: alpha, live: false }]
ok('a live grant opens its revoke', resolveRevoke({ grant: 'e970d972' }, grants).grant === grants[0])
ok('a revoked grant says it is already revoked', resolveRevoke({ grant: '503099b6' }, grants).grant === null && /already revoked/.test(resolveRevoke({ grant: '503099b6' }, grants).why))
ok('a grant this key did not sign is not offered', resolveRevoke({ grant: 'ffff0000' }, grants).grant === null)

// --- wiring: the link fills; it never signs ---
const page = readFileSync(join(ROOT, 'console', 'index.html'), 'utf8')
const body = page.slice(page.indexOf('function applyIntent()'), page.indexOf('\n}\n', page.indexOf('function applyIntent()')))
ok('the page reads the link and applies it after this key\'s grants are verified', /parseIntent\(location\.hash\)/.test(page) && /renderRows\(\)\n\s+applyIntent\(\)/.test(page))
ok('applying a link waits for the signed-in key\'s own list', /lastGrantor !== signerPk/.test(body))
ok('applying a link never signs or confirms', body.length > 0 && !/signFresh|confirm-go|\.signEvent|publish\(/.test(body))
const mod = readFileSync(join(ROOT, 'console', 'deep-link.mjs'), 'utf8')
ok('the resolver imports nothing, so it cannot reach a signer', !/^import /m.test(mod))

process.exit(pass ? 0 : 1)
