// console_mention_fix.mjs — the fix for a one-way pair: draft a mention grant, say what it does,
// and prove from the agent's own card that it was taken (#691, docs/DESIGN_MENTION_RIGHTS.md, step 4).
//
// What this suite holds:
//
//  1. A mention grant has nvoy's layout (p, da-scope over the agent, da-cap mention, name), and a
//     name outside the manifest's rule, a self-grant or a bad key is refused, not drafted.
//  2. The proposed name is the giver's profile name put into the rule, or nothing.
//  3. The grant is read back with its name, and the page's own list of grants finds it.
//  4. The flag clears only when a card no older than the grant lists the grant's own id on the
//     giver's entry: the giver listed some other way, or the id under another key, is not proof; a
//     card that can't be read leaves it pending, and a refusal says so.
//  5. A name another key holds on the list is caught before signing.
//  6. Only your own live grants on an entry are offered for withdrawal.
//
// Every key is synthetic.
//
//   node tests/console_mention_fix.mjs

import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import { draftMention, mentionName, MENTION_NAME, draftRevoke, describeChange } from '../console/hive-change.mjs'
import { readGrants, scopeTable } from '../console/hive-list.mjs'
import { mentionGrantsOf, mentionStatus, nameClash, mentionWhatIf, ownGrantsOn, PENDING, oneWay } from '../console/owner-view.mjs'
import { scopeHash } from '../console/scope-hash.mjs'
import { describeGrant } from '../console/capability-vocabulary.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const threw = async fn => { try { await fn(); return null } catch (e) { return e.message } }
const key = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) } }
const SALT = '00112233445566778899aabbccddeeff'

const owner = key(), other = key(), agent = key(), giver = key(), peer = key()

// ── 1. The draft ─────────────────────────────────────────────────────────────────────────────────
const t = await draftMention({ grantee: giver.pk, agent: agent.pk, name: 'dead-rabbit', scopeHash, salt: SALT, now: 1700000000 })
check(t.kind === 440 && t.created_at === 1700000000 && t.content === '', 'a mention grant is a kind 440 with no content')
check(JSON.stringify(t.tags) === JSON.stringify([['p', giver.pk], ['da-scope', await scopeHash(agent.pk, SALT), SALT], ['da-cap', 'mention'], ['name', 'dead-rabbit']]),
  "its tags are nvoy's: p is the key it may mention, the scope hashes the agent, the cap is mention, and the name is the @name")
for (const bad of ['', '-rabbit', 'dead rabbit', 'a'.repeat(33), 'émile', 'x/y'])
  check(/must start with a letter or digit/.test(await threw(() => draftMention({ grantee: giver.pk, agent: agent.pk, name: bad, scopeHash }))), `the name ${JSON.stringify(bad)} is refused, as nvoy's fold would drop it`)
check(MENTION_NAME.test('a') && MENTION_NAME.test('a'.repeat(32)) && MENTION_NAME.test('MC.claude_2'), 'the rule takes one to 32 characters, any case, with dots and underscores')
check(/itself/.test(await threw(() => draftMention({ grantee: agent.pk, agent: agent.pk, name: 'me', scopeHash }))), 'an agent is never granted itself')
check(/public key/.test(await threw(() => draftMention({ grantee: 'npub1x', agent: agent.pk, name: 'x', scopeHash }))), 'a giver that is not a hex key is refused')
const fresh = await draftMention({ grantee: giver.pk, agent: agent.pk, name: 'dr', scopeHash })
check(/^[0-9a-f]{32}$/.test(fresh.tags[1][2]) && fresh.tags[1][2] !== SALT, 'each grant gets its own fresh salt')

// ── 2. The proposed name ─────────────────────────────────────────────────────────────────────────
check(mentionName('Dead Rabbit') === 'dead-rabbit', '"Dead Rabbit" becomes dead-rabbit')
check(mentionName('MC Claude') === 'mc-claude' && mentionName('Pi Dog 🐶') === 'pi-dog', 'spaces and symbols become one dash, trailing ones dropped')
check(mentionName('Émile  Zola') === 'emile-zola', 'accents are taken off, not dropped with their letter')
check(mentionName('...waggle') === 'waggle' && mentionName('j.a.f') === 'j.a.f', 'a leading dot is dropped; inner dots stay')
check(mentionName('🐝') === null && mentionName('') === null && mentionName(null) === null, 'nothing usable gives no name, so the owner types one')
check(mentionName('x'.repeat(40)).length === 32, 'a long name is cut to 32')

// ── 3. Read back with its name ───────────────────────────────────────────────────────────────────
const signed = finalizeEvent(t, owner.sk)
const task = finalizeEvent({ kind: 440, created_at: 1700000001, tags: [['p', giver.pk], ['da-scope', await scopeHash(agent.pk, SALT), SALT], ['da-cap', 'task']], content: '' }, owner.sk)
const byOther = finalizeEvent(await draftMention({ grantee: giver.pk, agent: agent.pk, name: 'dead-rabbit', scopeHash, salt: SALT, now: 1700000002 }), other.sk)
const { grants } = readGrants([signed, task, byOther], { verify: verifyEvent })
const g = grants.find(x => x.id === signed.id)
check(g?.cap === 'mention' && g.name === 'dead-rabbit' && g.live, 'a mention grant is read back with its name')
check(!Object.hasOwn(grants.find(x => x.id === task.id), 'name'), 'a task grant carries no name')
const table = await scopeTable([owner.pk, agent.pk, giver.pk], grants, scopeHash)
const mine = mentionGrantsOf(grants, { owner: owner.pk, giver: giver.pk, agent: agent.pk, subjectOf: table.subjectOf })
check(mine.length === 1 && mine[0].id === signed.id, "your own mention grants for the pair are found; the task grant and another grantor's are not")
check(mentionGrantsOf(grants, { owner: owner.pk, giver: giver.pk, agent: peer.pk, subjectOf: table.subjectOf }).length === 0, 'a grant over another agent is not this pair')
const ended = readGrants([signed, finalizeEvent(draftRevoke({ grantId: signed.id }), owner.sk)], { verify: verifyEvent }).grants
check(mentionGrantsOf(ended, { owner: owner.pk, giver: giver.pk, agent: agent.pk, subjectOf: table.subjectOf }).length === 0, 'a withdrawn grant is no longer yours to wait on')

// ── 4. The proof ─────────────────────────────────────────────────────────────────────────────────
const view = (mention, refused = [], signedAt = 1700000000) => ({ state: 'readable', signedAt, view: { mention, refused, channels: [] } })
check(mentionStatus(view([]), []).state === 'none', 'no grant of yours: nothing to wait on')
check(mentionStatus(view([]), mine).state === 'pending', 'signed, and the card does not list it yet: pending')
check(mentionStatus({ state: 'cant-tell', why: 'not-opened' }, mine).state === 'pending', 'a card that cannot be read leaves it pending, never taken')
const taken = mentionStatus(view([{ name: 'dead-rabbit', pubkey: giver.pk, source: 'grant', grants: [signed.id] }]), mine)
check(taken.state === 'taken', "the card listing the grant's own id is the proof")
check(!oneWay({ on: true, giver: giver.pk, agent: agent.pk, view: view([{ name: 'dead-rabbit', pubkey: giver.pk, source: 'grant', grants: [signed.id] }]) }), 'and with it the square is no longer one-way')
const listed = [{ name: 'dead-rabbit', pubkey: giver.pk, source: 'grant', grants: [signed.id] }]
check(mentionStatus(view([{ ...listed[0], pubkey: peer.pk }]), mine).state === 'pending', "the grant's id on another key's entry is not proof: it must sit on the giver's own entry")
check(mentionStatus(view(listed, [], 1699999999), mine).state === 'pending', 'a card older than the grant leaves it pending, even with the id on it')
check(mentionStatus(view(listed, [], 1700000000), mine).state === 'taken', 'a card signed in the same second as the grant counts')
const otherId = 'f'.repeat(64)
check(mentionStatus(view([{ name: 'dr', pubkey: giver.pk, source: 'grant', grants: [otherId] }]), mine).state === 'pending', 'the giver listed under some other grant is not proof that yours was taken')
const refused = mentionStatus(view([], [{ grant: signed.id, reason: 'the name dead-rabbit is held by another key' }]), mine)
check(refused.state === 'refused' && refused.refused[0].reason === 'the name dead-rabbit is held by another key', 'a refused grant says refused, with its reason')
const second = { ...mine[0], id: 'e'.repeat(64) }
check(mentionStatus(view([], [{ grant: signed.id, reason: 'x' }]), [mine[0], second]).state === 'pending', 'with a refused grant and a newer one signed, the newer one is pending')
check(PENDING('Pi Dog') === "Signed, waiting for Pi Dog to take it. The flag clears when Pi Dog's card lists this approval.", 'pending says who it waits on and what clears it')

// ── 5. A clashing name, before signing ──────────────────────────────────────────────────────────
const list = view([{ name: 'Peer', pubkey: peer.pk, source: 'manifest', grants: [] }, { name: null, pubkey: owner.pk, source: 'manifest', grants: [] }])
check(nameClash(list, 'peer', giver.pk)?.pubkey === peer.pk, "a name another key holds is caught, case-folded as nvoy compares it")
check(nameClash(list, 'peer', peer.pk) === null, "the key's own name is no clash")
check(nameClash(list, 'dead-rabbit', giver.pk) === null && nameClash({ state: 'cant-tell' }, 'peer', giver.pk) === null, 'a free name, or an unreadable list, finds no clash')
check(mentionWhatIf({ agentName: 'Pi Dog', giverName: 'you', name: 'dead-rabbit' }) === 'Pi Dog will be able to mention you as @dead-rabbit.', "the what-if line is the design's sentence")

// ── 6. Withdrawing ───────────────────────────────────────────────────────────────────────────────
const entry = { name: 'dead-rabbit', pubkey: giver.pk, source: 'grant', grants: [signed.id, byOther.id] }
const own = ownGrantsOn(entry, grants, owner.pk)
check(own.length === 1 && own[0].id === signed.id, "only your own grants on an entry are offered: another grantor's 441 is theirs to sign")
check(ownGrantsOn(entry, ended, owner.pk).length === 0, 'a grant already withdrawn is not offered again')
check(describeChange({ action: 'withdraw', grant: g, agent: agent.pk }, pk => pk === agent.pk ? 'Pi Dog' : pk === giver.pk ? 'you' : '?').endsWith('which says Pi Dog may mention you by name.'),
  'the withdrawal reads in plain words: the agent may mention the giver')
check(describeGrant({ cap: 'mention', grantee: 'you', subject: 'Pi Dog' }) === 'Pi Dog may mention you by name', 'the mention cap has its own sentence, the agent as the one who mentions')

if (!pass) { console.log('\nconsole_mention_fix: FAIL'); process.exit(1) }
console.log('\nconsole_mention_fix: ok')
