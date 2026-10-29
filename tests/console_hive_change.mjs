// console_hive_change.mjs — changing who can give an agent work from the hive page (#613 M2, #617).
//
// What this suite holds:
//
//  1. A drafted grant has grant.mjs's tag layout and a scope hash both hash implementations agree on,
//     and nvoy's fold, run the way the page runs it, counts the signed result as a giver.
//  2. Only work capabilities are drafted, never for the agent itself, with a fresh salt each time.
//  3. Nothing is published unless the signer returns the event that was shown, signed by the key
//     the page read the hive as.
//  4. "Done" is earned by a cold read-back, against simulated relays: a relay that says OK and
//     drops the event is not storage, and a withdrawal is not done while any relay read still serves
//     the approval without it (#457).
//  5. A channel pass is drafted over the channel's id, as grant.mjs drafts it, so the bridge's own
//     recomputation over its channel matches; the page withdraws one only with a warning (#649).
//  6. The page itself signs through signFresh, publishes to the C3 relay set, and calls signEvent
//     nowhere directly.
//
//   node tests/console_hive_change.mjs

import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import { scopeHash } from '../console/scope-hash.mjs'
import { scopeHashSync } from '../src/scope_hash.mjs'
import { readGrants, scopeTable, buildList, GRANT_RELAYS } from '../console/hive-list.mjs'
import { WORK_CAPS, CHANGE_CAPS, PASS_CAPS, approvalsOf, draftGrant, draftPass, passesOf, channelIdOf, draftRevoke, freshSalt, workApprovals, describeChange, sameAsDrafted, applyChange, verdictText }
  from '../console/hive-change.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const threw = async fn => { try { await fn(); return null } catch (e) { return e.message } }

const ownerSk = generateSecretKey(), owner = getPublicKey(ownerSk)
const agent = getPublicKey(generateSecretKey()), colleague = getPublicKey(generateSecretKey())
const strangerSk = generateSecretKey()
const sign = sk => t => finalizeEvent({ ...t, tags: t.tags.map(x => [...x]) }, sk)
const SALT = '00112233445566778899aabbccddeeff'

// ── Simulated relays ─────────────────────────────────────────────────────────────────────────────
// Each relay is a store plus a behaviour: `ok` stores and acknowledges, `drop` acknowledges and
// stores nothing, `silent` opens and never answers, `down` refuses the connection.
function relays(spec) {
  const state = new Map(Object.entries(spec).map(([url, mode]) => [url, { mode, store: new Map(), received: 0 }]))
  const connect = url => {
    const r = state.get(url)
    if (!r || r.mode === 'down') throw new Error('refused')
    const ws = { send(raw) {
      const m = JSON.parse(raw)
      if (r.mode === 'silent') return
      setTimeout(() => {
        if (m[0] === 'EVENT') {
          r.received++
          if (r.mode === 'ok') r.store.set(m[1].id, m[1])
          ws.onmessage?.({ data: JSON.stringify(['OK', m[1].id, true, '']) })
        }
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
  const seed = (url, ev) => state.get(url).store.set(ev.id, ev)
  return { connect, seed, state, urls: Object.keys(spec), sent: () => [...state.values()].reduce((n, r) => n + r.received, 0) }
}
function matches(ev, f) {
  if (f.ids && !f.ids.includes(ev.id)) return false
  if (f.kinds && !f.kinds.includes(ev.kind)) return false
  if (f.authors && !f.authors.includes(ev.pubkey)) return false
  if (f['#e'] && !ev.tags.some(t => t[0] === 'e' && f['#e'].includes(t[1]))) return false
  return true
}
const FOUR = ['wss://a.test', 'wss://b.test', 'wss://c.test', 'wss://d.test']
const allOk = () => relays(Object.fromEntries(FOUR.map(u => [u, 'ok'])))
const opts = (net, over = {}) => ({ sign: sign(ownerSk), owner, verify: verifyEvent, connect: net.connect, relays: net.urls, timeoutMs: 200, ...over })

// ── 1. The drafted grant ─────────────────────────────────────────────────────────────────────────
const template = await draftGrant({ grantee: colleague, agent, cap: 'task', scopeHash, salt: SALT, now: 1700000000 })
check(JSON.stringify(template.tags.map(t => t[0])) === '["p","da-scope","da-cap"]' && template.kind === 440 && template.content === '',
  "a drafted grant has grant.mjs's tag layout: p, da-scope, da-cap, with empty content")
check(template.tags[0][1] === colleague && template.tags[2][1] === 'task' && template.tags[1][2] === SALT,
  'it names the grantee, the capability and the salt it was hashed with')
check(template.tags[1][1] === scopeHashSync(agent, SALT),
  "its scope hash is the agent hashed with that salt, as the bridge's own scopeHashSync computes it")

const signedGrant = sign(ownerSk)(template)
{
  const { grants, events } = readGrants([signedGrant], { verify: verifyEvent })
  const table = await scopeTable([owner, agent, colleague], grants, scopeHash)
  const { rows } = buildList({ owner, grantEvents: events, grants, table })
  const row = rows.find(r => r.pubkey === agent)
  check(row?.answers.work.givers.some(g => g.pubkey === colleague && g.caps.includes('task')),
    "nvoy's fold, run as the page runs it, counts the signed draft: the colleague can give the agent work")
}

// ── 2. What may be drafted ───────────────────────────────────────────────────────────────────────
check(JSON.stringify(WORK_CAPS) === '["task","task+act"]', 'who can give work is task and task+act')
check(JSON.stringify(CHANGE_CAPS) === '["task","task+act","task-relay","shadow"]', 'the page changes work, carrying and your voice, and nothing else')
for (const cap of ['admit', 'admit+read', 'mirror', 'nonsense'])
  check(/gives only/.test(await threw(() => draftGrant({ grantee: colleague, agent, cap, scopeHash }))), `${cap} is refused, not drafted`)
{
  const carry = await draftGrant({ grantee: colleague, agent, cap: 'task-relay', scopeHash, salt: SALT, now: 1700000050 })
  const voice = await draftGrant({ grantee: colleague, agent: owner, cap: 'shadow', scopeHash, salt: SALT, now: 1700000051 })
  check(carry.tags[2][1] === 'task-relay' && carry.tags[1][1] === scopeHashSync(agent, SALT), 'carrying is drafted over the agent')
  check(voice.tags[2][1] === 'shadow' && voice.tags[1][1] === scopeHashSync(owner, SALT), "a voice is drafted over the owner's own key, as nvoy's fold reads it")
  check(/itself/.test(await threw(() => draftGrant({ grantee: owner, agent: owner, cap: 'shadow', scopeHash }))), 'and never over the voice itself')
  const words = describeChange({ action: 'give', grantee: colleague, agent: owner, cap: 'shadow' }, pk => pk === owner ? 'you' : 'DJ Codex')
  check(words === 'Give: DJ Codex may speak for you when giving work.', `a voice is worded plainly ("${words}")`)
}
check(/itself/.test(await threw(() => draftGrant({ grantee: agent, agent, cap: 'task', scopeHash }))), 'an agent is never approved to give itself work')
check(/public key/.test(await threw(() => draftGrant({ grantee: 'npub1abc', agent, cap: 'task', scopeHash }))), 'a grantee that is not a hex key is refused')
check(/salt/.test(await threw(() => draftGrant({ grantee: colleague, agent, cap: 'task', scopeHash, salt: 'abcd' }))), 'a short salt is refused')
{
  const a = freshSalt(), b = freshSalt()
  check(/^[0-9a-f]{32}$/.test(a) && a !== b, 'each draft gets its own fresh 16-byte salt')
  const [g1, g2] = [await draftGrant({ grantee: colleague, agent, cap: 'task', scopeHash }), await draftGrant({ grantee: colleague, agent, cap: 'task', scopeHash })]
  check(g1.tags[1][1] !== g2.tags[1][1], 'so two grants over the same agent are not linkable by their scope hash')
}
const revokeTemplate = draftRevoke({ grantId: signedGrant.id, now: 1700000100 })
check(revokeTemplate.kind === 441 && JSON.stringify(revokeTemplate.tags) === JSON.stringify([['e', signedGrant.id]]), "a withdrawal is a 441 naming the approval's id")
check(/approval id/.test(await threw(() => draftRevoke({ grantId: 'abc' }))), 'a withdrawal of something that is not an id is refused')

// ── 3. Nothing is published unless the signer returns what was shown ────────────────────────────
{
  const net = allOk()
  const swapped = await threw(() => applyChange(template, opts(net, { sign: t => sign(ownerSk)({ ...t, tags: [['p', getPublicKey(strangerSk)], ...t.tags.slice(1)] }) })))
  check(/not the one shown/.test(swapped) && net.sent() === 0, 'a signer that returns a different grantee is refused, and no relay receives anything')
  // Through JSON, as a remote signer's answer arrives: a spread would carry nostr-tools' cached
  // "verified" mark across and the bad signature would pass unchecked.
  const forged = await threw(() => applyChange(template, opts(net, { sign: t => JSON.parse(JSON.stringify({ ...sign(ownerSk)(t), sig: '00'.repeat(64) })) })))
  check(/not the one shown/.test(forged) && net.sent() === 0, 'so is one that returns a bad signature')
  const otherKey = await threw(() => applyChange(template, opts(net, { sign: sign(strangerSk) })))
  check(/different key/.test(otherKey) && net.sent() === 0, 'and one signed by a different key from the one the page read the hive as')
  const redated = await threw(() => applyChange(template, opts(net, { sign: t => sign(ownerSk)({ ...t, created_at: t.created_at - 86400 * 365 }) })))
  check(/not the one shown/.test(redated) && net.sent() === 0, 'and one validly signed by the owner but re-dated, which could change which approval the fold counts')
  check(sameAsDrafted(signedGrant, template) && !sameAsDrafted({ ...signedGrant, content: 'x' }, template) && !sameAsDrafted({ ...signedGrant, created_at: template.created_at + 1 }, template),
    'sameAsDrafted compares kind, timestamp, tags and content')
}

// ── 4. Done is earned by the read-back ───────────────────────────────────────────────────────────
{
  const net = allOk()
  const steps = []
  const r = await applyChange(template, opts(net, { onStep: s => steps.push(s) }))
  check(r.verdict.done && r.verdict.holding.length === 4 && r.published.every(p => p.outcome === 'accepted'), 'a grant every relay stores is done, held on 4 of 4')
  check(/^Done\. 4 of 4 relays serve it back/.test(r.text), `and says so: "${r.text.slice(0, 60)}…"`)
  check(JSON.stringify(steps) === '["waiting for your signer","publishing","reading it back"]', 'the steps run in order: sign, publish, read back')
}
{
  const net = relays(Object.fromEntries(FOUR.map(u => [u, 'drop'])))
  const r = await applyChange(template, opts(net))
  check(r.published.every(p => p.outcome === 'accepted') && !r.verdict.done, 'every relay said OK and stored nothing: not done')
  check(/^Not done\..*OK is not storage/.test(r.text), 'and the page says an OK is not storage')
}
{
  const net = relays({ [FOUR[0]]: 'ok', [FOUR[1]]: 'drop', [FOUR[2]]: 'silent', [FOUR[3]]: 'down' })
  const r = await applyChange(template, opts(net))
  check(r.verdict.done && r.verdict.holding.length === 1, 'one relay that stores it is enough for done')
  check(/Only one relay holds it/.test(r.text), 'but the page warns that one relay is all that holds it')
  check(/2 of 4 relays did not answer the read-back in full \(c\.test, d\.test\)/.test(r.text), 'and names the relays that did not answer')
  check(r.published.find(p => p.url === FOUR[3]).outcome === 'unreachable' && r.published.find(p => p.url === FOUR[2]).outcome === 'timeout',
    'a refused connection is unreachable and a silent relay times out, each reported per relay')
}

// Withdrawals. The grant is already on every relay.
const withGrant = mode => { const net = relays(Object.fromEntries(FOUR.map(u => [u, mode(u)]))); for (const u of FOUR) net.seed(u, signedGrant); return net }
{
  const net = withGrant(() => 'ok')
  const r = await applyChange(revokeTemplate, opts(net))
  check(r.verdict.done && r.verdict.stale.length === 0, 'a withdrawal every relay stores is done')
  const held = [...net.state.values()].flatMap(s => [...s.store.values()])
  const { grants } = readGrants(held, { verify: verifyEvent })
  check(grants.length > 0 && grants.every(g => g.state === 'revoked'), "and the page's own fold over what the relays now hold reads the approval as withdrawn")
}
{
  const net = withGrant(u => u === FOUR[2] ? 'drop' : 'ok')
  const r = await applyChange(revokeTemplate, opts(net))
  check(!r.verdict.done && JSON.stringify(r.verdict.stale) === JSON.stringify([FOUR[2]]), 'one relay that still serves the approval without the withdrawal: not done (#457)')
  check(/^Not done\. c\.test still serves the approval without its withdrawal/.test(r.text), 'and the page names that relay')
}
{
  const net = withGrant(u => u === FOUR[3] ? 'silent' : 'ok')
  const r = await applyChange(revokeTemplate, opts(net))
  check(r.verdict.done && /1 of 4 relays did not answer/.test(r.text), 'a relay that does not answer cannot be checked; done on the others, and the page says which was not read')
}
{
  const net = withGrant(() => 'drop')
  const r = await applyChange(revokeTemplate, opts(net))
  check(!r.verdict.done && r.verdict.stale.length === 4, 'no relay keeps the withdrawal: not done, and every relay is listed as still serving the approval')
}
{
  // An earlier withdrawal by the same author counts wherever it is held; one by anyone else does not.
  const earlier = sign(ownerSk)(draftRevoke({ grantId: signedGrant.id, now: 1700000050 }))
  const byStranger = sign(strangerSk)(draftRevoke({ grantId: signedGrant.id, now: 1700000060 }))
  const net = withGrant(u => u === FOUR[1] ? 'drop' : 'ok')
  net.seed(FOUR[1], earlier)
  const r = await applyChange(revokeTemplate, opts(net))
  check(r.verdict.done, 'a relay that dropped this withdrawal but holds an earlier one from the same author is not stale')
  const net2 = withGrant(u => u === FOUR[1] ? 'drop' : 'ok')
  net2.seed(FOUR[1], byStranger)
  const r2 = await applyChange(revokeTemplate, opts(net2))
  check(!r2.verdict.done && r2.verdict.stale.includes(FOUR[1]), 'but a withdrawal by someone who did not give the approval does not count')
}
check(verdictText({ kind: 441, done: false, holding: [], stale: [], silent: [], of: 4 }).startsWith('Not done. It was signed and sent, but no relay served the withdrawal back'),
  'a withdrawal no relay holds, with nothing stale, still says not done')

// ── Which approvals stopping someone withdraws ───────────────────────────────────────────────────
{
  const t = (cap, sk = ownerSk, subject = agent, at = 1) => sign(sk)({ kind: 440, created_at: 1700000000 + at, tags: [['p', colleague], ['da-scope', scopeHashSync(subject, SALT), SALT], ['da-cap', cap]], content: '' })
  const other = getPublicKey(generateSecretKey())
  const evs = [t('task', ownerSk, agent, 1), t('task', ownerSk, agent, 2), t('task+act', ownerSk, agent, 3), t('admit', ownerSk, agent, 4), t('task', ownerSk, other, 5), t('task', strangerSk, agent, 6)]
  const gone = t('task', ownerSk, agent, 7)
  evs.push(gone, sign(ownerSk)({ kind: 441, created_at: 1700000100, tags: [['e', gone.id]], content: '' }))
  const { grants } = readGrants(evs, { verify: verifyEvent })
  const table = await scopeTable([agent, other, colleague, owner], grants, scopeHash)
  const found = workApprovals(grants, { agent, grantee: colleague, subjectOf: table.subjectOf })
  check(found.length === 4, `stopping the colleague finds 4 live work approvals over this agent, duplicates included (found ${found.length})`)
  check(!found.some(g => g.cap === 'admit') && !found.some(g => g.id === gone.id) && found.every(g => table.subjectOf(g.hash) === agent),
    'and never a channel pass, an approval already withdrawn, or one over a different agent')
  check(found.filter(g => g.grantor === owner).length === 3, "of which the page withdraws the owner's 3; the stranger's is theirs to withdraw")
  check(approvalsOf(grants, { subject: agent, grantee: colleague, caps: ['task-relay'], subjectOf: table.subjectOf }).length === 0 && found.every(g => g.cap !== 'task-relay'),
    'a carrying approval is a kind of its own: not found as work, and not found where none is held')
}

// ── Plain words ──────────────────────────────────────────────────────────────────────────────────
{
  const names = { [owner]: 'you', [agent]: 'Pi Dog', [colleague]: 'DJ Codex' }
  const nameOf = pk => names[pk] || 'someone'
  const give = describeChange({ action: 'give', grantee: colleague, agent, cap: 'task+act' }, nameOf)
  check(give === 'Give: DJ Codex may send instructions to Pi Dog, and Pi Dog may act on them.', `a grant reads as a sentence about named parties: "${give}"`)
  const stop = describeChange({ action: 'withdraw', grant: { id: signedGrant.id, cap: 'task', grantee: colleague }, agent }, nameOf)
  check(stop.startsWith(`Withdraw approval ${signedGrant.id.slice(0, 10)}…, which says DJ Codex may send instructions to Pi Dog`) && !/[0-9a-f]{64}/.test(stop + give),
    'a withdrawal names the approval it ends, and neither sentence carries a key in hex')
}

// ── Channel passes (#649) ────────────────────────────────────────────────────────────────────────
{
  const CHANNEL = 'a8186b53-0000-4000-8000-000000000001', other = 'b0000000-0000-4000-8000-000000000002'
  const pass = await draftPass({ grantee: agent, channel: CHANNEL.toUpperCase(), scopeHash, salt: SALT, now: 1700000000 })
  check(JSON.stringify(pass.tags) === JSON.stringify([['p', agent], ['da-scope', scopeHashSync(CHANNEL, SALT), SALT], ['da-cap', 'admit']]) && pass.kind === 440,
    "a pass has grant.mjs's layout, scoped to the lowercased channel id as the bridge recomputes it")
  check(/channel's UUID/.test(await threw(() => draftPass({ grantee: agent, channel: 'waggle-test', scopeHash }))) &&
    /public key/.test(await threw(() => draftPass({ grantee: 'nobody', channel: CHANNEL, scopeHash }))),
    'a pass needs a channel UUID and a grantee key; a channel name is refused')
  check(channelIdOf(` ${CHANNEL.toUpperCase()} `) === CHANNEL && channelIdOf('') === null && !CHANGE_CAPS.includes('admit') && PASS_CAPS.includes('admit'),
    'the channel id is trimmed and lowercased, and passes stay out of the approvals draftGrant gives')
  const g = (over) => ({ id: over.id, grantor: owner, grantee: agent, cap: 'admit', live: true, ...over })
  const here = g({ id: 'p1', salt: SALT, hash: scopeHashSync(CHANNEL, SALT) })
  const elsewhere = g({ id: 'p2', salt: SALT, hash: scopeHashSync(other, SALT) })
  const grants = [here, elsewhere, g({ id: 'p3', salt: SALT, hash: here.hash, live: false }), g({ id: 'p4', salt: SALT, hash: here.hash, grantor: colleague }),
    g({ id: 'p5', salt: SALT, hash: here.hash, cap: 'task' }), g({ id: 'p6', salt: SALT, hash: here.hash, grantee: colleague })]
  const unknown = await passesOf(grants, { grantee: agent, owner, channel: '', scopeHash })
  const known = await passesOf(grants, { grantee: agent, owner, channel: CHANNEL, scopeHash })
  check(unknown.here === null && unknown.mine.map(x => x.id).join() === 'p1,p2', "without the channel id, your live passes for it, and only yours, are listed")
  check(known.here.map(x => x.id).join() === 'p1', 'with it, only the pass for that channel: not a withdrawn one, a colleague\'s, a task grant or another agent\'s')
  const nameOf = pk => pk === agent ? 'Pi Dog' : 'someone'
  const words = describeChange({ action: 'give', grantee: agent, agent: CHANNEL, cap: 'admit' }, nameOf)
  check(words === 'Give: Pi Dog may post into channel a8186b53.', `a pass reads as posting into the named channel: "${words}"`)
  check(describeChange({ action: 'withdraw', grant: { id: signedGrant.id, cap: 'admit', grantee: agent }, agent: null }, nameOf).endsWith('which says Pi Dog may post into the channel.'),
    'and its withdrawal still reads plainly when the channel id is not known')
}

// ── 6. The page ──────────────────────────────────────────────────────────────────────────────────
const page = readFileSync(join(ROOT, 'console/hive.html'), 'utf8')
check(page.includes("from './hive-change.mjs'") && page.includes("from './guarded-signer.mjs'") && /applyChange\([^)]*\{[^}]*sign: t => signFresh\(t, signer\)/s.test(page),
  'hive.html applies changes through hive-change.mjs, signing with signFresh')
check(!/\.signEvent\s*\(/.test(page), 'and calls signEvent directly nowhere')
check(!/wss:\/\/[^'"]+['"]\s*,\s*['"]wss:\/\//.test(page.replace(/const ROSTER_RELAYS = \[[^\]]*\]/, '')),
  "it carries no relay list of its own beyond the roster's, so changes publish to the C3 set")
check(GRANT_RELAYS.includes('wss://relay.nave.pub') && GRANT_RELAYS.length === 4, 'the C3 set is the four grant relays, relay.nave.pub among them')
check(!/signs nothing yet/.test(page), 'the page no longer says it signs nothing')
check(/cap: 'task-relay', subject: r\.pubkey, grantee: hive\.bridge/.test(page) && /cap: 'shadow', subject: owner, grantee: r\.pubkey/.test(page),
  "the page changes carrying (the bridge, over the agent) and your voice (the identity, over your own key)")
check(/draftPass\(\{ grantee: r\.pubkey, channel, scopeHash \}\)/.test(page) && /passesOf\(hive\.grants, \{ grantee: r\.pubkey, owner, channel, scopeHash \}\)/.test(page),
  'the page gives a channel pass to the row, and finds the ones to stop among your own')
check(/const CUT_OFF = 'Without a pass, waggle refuses its posts and stops carrying mentions to it\.'/.test(page) && /\$\{CUT_OFF\}/.test(page),
  'withdrawing a pass says what the agent loses')

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
