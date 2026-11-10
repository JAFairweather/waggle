// console_hive_list.mjs — the hive manager's one list (#613 M1).
//
// What this suite holds:
//
//  1. No source can contribute a key the list drops. Every key named by the owner, a grant (grantor,
//     grantee or resolved subject), an agent card or the bridge roster is a row, for every subset
//     of sources. A list that loses a key is the three-registry problem #613 retires.
//  2. Roles are recognised from grants by the spec's recipes, and anything else is custom, never
//     silently dropped.
//  3. Revocation, NIP-40 expiry and duplicates are computed, not promised: a revoked or expired
//     grant gives no role, and of two live copies the older, the one nvoy no longer counts, is
//     listed under Needs you. Withdrawing the newer would end the approval.
//  4. "Who can give it work" is nvoy's own fold, vendored byte-exact at a pinned commit. If the file
//     changes, this fails until the pin is moved on purpose.
//  5. A card counts only as the agent's own signature naming the owner as a grantor, and answers
//     no card reports read "not reported", never a guess.
//  6. A relay has answered only when it sent EOSE. A timeout after some events is partial, and every
//     absence the page states is qualified unless each read it rests on was full.
//
//   node tests/console_hive_list.mjs

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import { scopeHash } from '../console/scope-hash.mjs'
import { readGrants, scopeTable, roleOf, duplicates, readCards, buildList, workSentence, quorumWarning, workCell, givesCell, nameSlots, slotted, faceMap, askCell, PLATFORMS, RUNS_ON, platformOf, byPlatform, relayCoverage, coverageText, CARD_D, CARD_KIND, GRANT_RELAYS, NOT_READ }
  from '../console/hive-list.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

// 4. The pin. Moving it is a deliberate act: re-vendor from nvoy, then update both lines.
const NVOY_PIN = '7af1d1ffadfd20ca352a8c5bcba34432b9612d42'
const VENDORED = {
  'nvoy-admission.mjs': 'c14082b1c9cee9faca9898ec2a12379fa5f533b654139212484d3ebe80cbd2ff',
  'nvoy-grant-relays.mjs': 'cb0ea44165fa83979eb2dcd9b015674651895acf18bc38c183a50190e37c58f9',
}
for (const [file, sha] of Object.entries(VENDORED)) {
  const got = createHash('sha256').update(readFileSync(join(ROOT, 'console/vendor', file))).digest('hex')
  check(got === sha, `vendor/${file} is nvoy's file at ${NVOY_PIN.slice(0, 7)}, byte for byte`)
}
check(GRANT_RELAYS.includes('wss://relay.nave.pub') && GRANT_RELAYS.length === 4, 'grants are read from the shared four-relay set')

const keys = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) } }
const owner = keys(), voice = keys(), pidog = keys(), djcodex = keys(), bridge = keys(), stranger = keys(), cardOnly = keys(), rosterOnly = keys(), granteeOnly = keys(), subjectOnly = keys(), unknown = keys()
const salt = () => Buffer.from(generateSecretKey()).toString('hex').slice(0, 32)
let clock = 1_800_000_000
const sign = (who, kind, tags, content = '') => finalizeEvent({ kind, created_at: clock++, tags, content }, who.sk)
const grant = async (from, to, cap, subject, extra = []) => {
  const s = salt()
  return sign(from, 440, [['p', typeof to === 'string' ? to : to.pk], ['da-cap', cap], ['da-scope', await scopeHash(subject, s), s], ...extra])
}
const revoke = (from, ev) => sign(from, 441, [['e', ev.id]])

const teammate = await grant(owner, owner, 'task', pidog.pk)
const trusted = await grant(owner, owner, 'task+act', djcodex.pk)
const colleague = await grant(owner, djcodex.pk, 'task', pidog.pk)
const carrier = await grant(owner, bridge.pk, 'task-relay', pidog.pk)
const shadow = await grant(owner, voice.pk, 'shadow', owner.pk)
const guest = await grant(owner, granteeOnly.pk, 'admit', '00000000-0000-4000-8000-000000000000')
const custom = await grant(owner, stranger.pk, 'mirror', pidog.pk)
const copy = await grant(owner, owner, 'task', pidog.pk)
const gone = await grant(owner, owner, 'task', rosterOnly.pk)
const goneRevoke = revoke(owner, gone)
const lapsed = await grant(owner, owner, 'task', cardOnly.pk, [['expiration', '1000']])
const foreignRevoke = revoke(stranger, teammate)
// A grant from a second grantor that cardOnly's own card names: only nvoy's fold with the card's
// grantors counts it.
const second = await grant(djcodex, djcodex, 'task', cardOnly.pk)
const forSubject = await grant(owner, owner, 'task', subjectOnly.pk)
const forUnknown = await grant(owner, owner, 'task', unknown.pk)
// The same approval issued twice, and the newer copy withdrawn: the older one is still live.
const twiceOld = await grant(owner, owner, 'task+act', voice.pk)
const twiceNew = await grant(owner, owner, 'task+act', voice.pk)
const twiceRevoke = revoke(owner, twiceNew)
const forged = { ...JSON.parse(JSON.stringify(await grant(owner, owner, 'task+act', stranger.pk))), sig: '00'.repeat(64) }
const events = [teammate, trusted, colleague, carrier, shadow, guest, custom, copy, gone, goneRevoke, lapsed, foreignRevoke, forged, second, forSubject, forUnknown, twiceOld, twiceNew, twiceRevoke]

const { grants, events: verified, rejected } = readGrants(events, { verify: verifyEvent, now: clock * 1000 })
check(rejected === 1 && !grants.some(g => g.id === forged.id), 'a grant whose signature fails is rejected, not folded')
check(grants.find(g => g.id === gone.id)?.state === 'revoked', "the grantor's own 441 revokes the grant")
check(grants.find(g => g.id === teammate.id)?.state === 'live', "a 441 from anyone but the grantor revokes nothing")
check(grants.find(g => g.id === lapsed.id)?.state === 'expired', 'a passed NIP-40 expiration ends the grant')

const card = (who, body, created = clock++) => finalizeEvent({ kind: CARD_KIND, created_at: created, tags: [['d', CARD_D]], content: JSON.stringify(body) }, who.sk)
const body = (who, extra = {}) => ({ version: 1, instance: 'pi-dog', pubkey: who.pk, release: 'a'.repeat(40), grantors: [owner.pk], relays: [],
  may_post: { channels: 1, per_hour: 5, mentions: 2 }, may_set_profile: { per_day: 1 }, agent_limits: { max_hops: 3, per_sender_per_hour: 12 },
  delivery_mode: 'notify_only', harness: { runner: 'codex' }, summary: '', withheld: ['holdings', 'harness model'],
  not_reported: ['harness profile', 'last admitted task', 'last reply'], ...extra })
const cardEvents = [
  card(pidog, body(pidog), clock), card(pidog, body(pidog, { instance: 'pi-dog-old' }), clock - 100),
  card(cardOnly, body(cardOnly, { instance: 'card-only', grantors: [owner.pk, djcodex.pk] })),
  card(stranger, body(stranger, { grantors: [stranger.pk] })),
  card(djcodex, body(pidog)),
]
const cards = readCards(cardEvents, { owner: owner.pk, verify: verifyEvent })
check(cards.get(pidog.pk)?.instance === 'pi-dog', 'the newest valid card per key wins')
check(!cards.has(stranger.pk), 'a card that does not name the owner as a grantor is not part of this hive')
check(!cards.has(djcodex.pk), 'a card describing a different key than its signer is refused')

const roster = [{ pubkey: rosterOnly.pk, label: 'roster-only', status: 'admitted', return_lane: false }]
// subjectOnly stands for a key a future source supplies as a candidate without naming it as a row
// (nvoy's 10440 index, say). `unknown` is in no source at all, so its grant cannot be resolved.
const candidates = [owner.pk, bridge.pk, subjectOnly.pk, ...roster.map(a => a.pubkey), ...cards.keys(), ...grants.flatMap(g => [g.grantor, g.grantee])]
const table = await scopeTable(candidates, grants, scopeHash)
const profiles = new Map([[pidog.pk, { name: 'Pi Dog', picture: 'https://example.test/pidog.png' }], [djcodex.pk, { display_name: 'DJ Codex' }]])
const all = { owner: owner.pk, grantEvents: verified, grants, table, cards, roster, bridge: bridge.pk, profiles }
const { rows, needs } = buildList(all)
const row = pk => rows.find(r => r.pubkey === pk)

// 1. No source can contribute a key the list drops, for every subset of sources.
const SOURCES = {
  grants: { grants, grantEvents: verified },
  cards: { cards },
  roster: { roster, bridge: bridge.pk },
}
const expected = src => new Set([owner.pk,
  ...(src.grants ? grants.flatMap(g => [g.grantor, g.grantee, table.subjectOf(g.hash)]).filter(k => /^[0-9a-f]{64}$/.test(k || '')) : []),
  ...(src.cards ? cards.keys() : []),
  ...(src.roster ? [bridge.pk, ...roster.map(a => a.pubkey)] : [])])
let dropped = []
for (let mask = 0; mask < 8; mask++) {
  const on = Object.fromEntries(Object.keys(SOURCES).map((k, i) => [k, !!(mask & (1 << i))]))
  const input = { owner: owner.pk, table, profiles }
  for (const k of Object.keys(SOURCES)) if (on[k]) Object.assign(input, SOURCES[k])
  const got = new Set(buildList(input).rows.map(r => r.pubkey))
  for (const k of expected(on)) if (!got.has(k)) dropped.push(`${k.slice(0, 8)} with sources ${JSON.stringify(on)}`)
}
check(!dropped.length, `no subset of sources loses a key${dropped.length ? `: ${dropped[0]}` : ''}`)
for (const [pk, why] of [[cardOnly.pk, 'a card alone'], [rosterOnly.pk, 'the roster alone'], [granteeOnly.pk, 'a channel admit alone'], [stranger.pk, 'an unrecognised grant']])
  check(!!row(pk), `a key named by ${why} is a row`)
check(rows[0].pubkey === owner.pk && rows[0].isOwner, 'the owner is a row of the same kind, listed first')
check(row(rosterOnly.pk).stage === 'key' && row(cardOnly.pk).stage === 'tools' && row(voice.pk).stage === 'grants', 'each row says how far along it is')
check(row(pidog.pk).name === 'Pi Dog' && row(rosterOnly.pk).name === 'roster-only' && row(cardOnly.pk).name === 'card-only', 'names come from kind 0, then the roster label, then the card')
check(row(pidog.pk).picture === 'https://example.test/pidog.png' && row(djcodex.pk).picture === null, 'the photo comes from the same kind 0, and a key without one has none')

// 2. Recipes.
const roles = pk => row(pk).roles.map(r => r.role).sort()
check(JSON.stringify(roles(pidog.pk)) === JSON.stringify(['carrier', 'colleague', 'teammate', 'teammate']), 'Pi Dog is a teammate (twice: a duplicate), has DJ Codex as a colleague, and the bridge as its carrier')
check(roles(djcodex.pk).includes('trusted'), 'task+act from the owner makes a trusted teammate')
check(roles(voice.pk).includes('voice'), 'shadow from the owner to a key makes it the owner\'s voice')
check(roles(granteeOnly.pk).includes('guest') && !needs.some(n => n.grant?.cap === 'admit'), 'a channel admit is a channel pass, and never flagged for cleanup: the bridge needs it (#649)')
check(roles(stranger.pk).includes('custom') && needs.some(n => n.kind === 'custom' && n.grant.id === custom.id), 'a grant matching no recipe is custom and listed, never dropped')
check(!roles(rosterOnly.pk).length, 'a revoked grant gives no role')
check(!row(cardOnly.pk).roles.some(r => r.grant.id === lapsed.id), 'an expired grant gives no role')
check(!!row(subjectOnly.pk) && roles(subjectOnly.pk).includes('teammate'), 'a key known only as a resolved grant subject is a row with its role')
check(!row(unknown.pk) && needs.some(n => n.kind === 'custom' && n.grant.id === forUnknown.id && /unresolved scope/.test(n.text)), 'a grant for a key no source names is under Needs you as unresolved, not dropped')
check(roleOf({ grantor: stranger.pk, grantee: owner.pk, cap: 'task' }, { owner: owner.pk, subject: pidog.pk }).role === 'custom', 'a task grant from someone other than the owner is custom')
// The hive square's mention approval (#726) is a recipe, never "Matches no role".
{
  // DJ Codex may mention Pi Dog as @pidog: Pi Dog is the grantee, DJ Codex the hashed subject.
  const ev = await grant(owner, pidog.pk, 'mention', djcodex.pk, [['name', 'pidog']])
  const { grants: mg } = readGrants([ev], { verify: verifyEvent, now: clock * 1000 })
  const t = await scopeTable([djcodex.pk], mg, scopeHash)
  const built = buildList({ owner: owner.pk, grants: mg, table: t })
  const role = built.rows.find(r => r.pubkey === djcodex.pk)?.roles.find(r => r.role === 'mentions')
  check(role?.of === pidog.pk && role.name === 'pidog' && !built.needs.some(n => n.kind === 'custom'),
    'an owner mention grant is the subject\'s "May @mention" role, naming the grantee and the name, and is not under Needs you')
  check(roleOf({ grantor: stranger.pk, grantee: pidog.pk, cap: 'mention' }, { owner: owner.pk, subject: djcodex.pk }).role === 'custom' &&
    roleOf({ grantor: owner.pk, grantee: pidog.pk, cap: 'mention' }, { owner: owner.pk, subject: null }).role === 'custom',
    'a mention grant from someone else, or with an unresolved subject, stays custom')
}

// 3. Duplicates and expiry under Needs you.
const dup = duplicates(grants, table.subjectOf)
check(dup.length === 1 && dup[0].keep.id === copy.id && dup[0].extra[0].id === teammate.id, 'two live copies of one grant: the newer is kept, the older is listed')
check(needs.filter(n => n.kind === 'duplicate').map(n => n.grant.id).join() === teammate.id, 'the older copy is under Needs you, once')
check(row(pidog.pk).roles.find(r => r.grant.id === teammate.id)?.inEffect === false && row(pidog.pk).roles.find(r => r.grant.id === copy.id)?.inEffect === true, 'the older copy is marked as having no effect')
check(needs.some(n => n.kind === 'expired' && n.grant.id === lapsed.id), 'an expired grant still published is under Needs you')
check(needs.some(n => n.kind === 'no-card' && n.pubkey === djcodex.pk), 'an agent with work grants and no card is under Needs you')

// 4. Who can give it work: nvoy's fold, in words.
const nameOf = pk => row(pk)?.name || pk.slice(0, 8)
check(workSentence(row(pidog.pk).answers.work, { owner: owner.pk, nameOf }) === 'You, DJ Codex and Your voice can give it work.',
  'Pi Dog: you, DJ Codex, and your voice can give it work')
check(row(pidog.pk).answers.work.carriers.includes(bridge.pk), 'the carrier is named apart from who gives work')
check(row(djcodex.pk).answers.act.withoutAsking.includes(owner.pk), 'task+act is what it may do without asking')
check(row(djcodex.pk).answers.work.grantorsFrom === 'assumed' && row(pidog.pk).answers.work.grantorsFrom === 'card', 'without a card the grantors are assumed, and the answer says so')
check(workSentence(row(cardOnly.pk).answers.work, { owner: owner.pk, nameOf }) === 'DJ Codex can give it work.', "the card's own grantors decide whose grants count")
check(workSentence(row(rosterOnly.pk).answers.work, { owner: owner.pk, nameOf }) === 'Nobody can give it work.', 'a revoked grant gives nobody work')

// The table's short answers (#634).
check(workCell(row(pidog.pk).answers.work, { owner: owner.pk, nameOf }).join(', ') === 'You, DJ Codex, Your voice', 'the table names who can give work, you first, and your voice as such')
check(workCell(row(rosterOnly.pk).answers.work, { owner: owner.pk, nameOf }).join() === 'Nobody' && workCell(row(rosterOnly.pk).answers.work, { owner: owner.pk, nameOf, incomplete: true }).join() === 'Nobody*',
  'nobody is starred when the read cannot vouch for it')
check(/^Not on your or .+'s work$/.test(askCell(row(djcodex.pk).answers.act, { owner: owner.pk, nameOf })) && askCell({ withoutAsking: [owner.pk] }, { owner: owner.pk, nameOf }) === 'Not on your work',
  'task+act reads as not asking on that giver\'s work, yours named first')
check(askCell(row(pidog.pk).answers.act, { owner: owner.pk, nameOf }) === 'Yes, always' && askCell(row(pidog.pk).answers.act, { owner: owner.pk, nameOf, incomplete: true }) === 'Yes, always*',
  'with no task+act it always asks, starred when the read is partial')
check(askCell({ withoutAsking: [djcodex.pk, owner.pk] }, { owner: owner.pk, nameOf }) === "Not on your or DJ Codex's work", 'several are named, you first')
check(askCell({ withoutAsking: [] }, { owner: owner.pk, nameOf, incomplete: true, givers: 0 }) === '—', 'with nobody to give it work, asking has no answer')
check(givesCell(pidog.pk, rows, { owner: owner.pk, nameOf }).every(n => n !== 'Pi Dog') && givesCell(owner.pk, rows, { owner: owner.pk, nameOf }).includes('Pi Dog'),
  'gives work to is the same approvals read the other way: you give Pi Dog work, Pi Dog is never its own')
check(givesCell(stranger.pk, rows, { owner: owner.pk, nameOf }).join() === 'Nobody' && givesCell(stranger.pk, rows, { owner: owner.pk, nameOf, incomplete: true }).join() === 'Nobody*', 'a key no row names gives work to nobody')
{
  const slots = nameSlots([['You', 'Pi Dog', 'Your voice'], ['DJ Codex', 'You'], ['Nobody*'], ['—']])
  check(slots.join() === 'You,DJ Codex,Pi Dog,Your voice', 'a column holds every name once: you first, your voice last, nobody and dashes left out')
  check(slotted(['You', 'Your voice'], slots, 'DJ Codex').map(l => l.state).join() === 'present,self,absent,present',
    'each row has every name on its own line: present, its own line blank, the missing one marked')
  check(slotted(['Pi Dog'], slots, 'DJ Codex', ['DJ Codex', 'Pi Dog']).map(l => l.state).join() === 'self,self,present,self',
    'a name its column never holds is blank, not struck, so both columns can share lines')
  check(slotted(['Nobody*'], slots, 'Pi Dog') === null && slotted(['—'], slots, 'You') === null, 'a cell with nobody stays one line')
}

// nvoy counts only the newest approval per capability, and a replaced one never comes back: when the
// newer copy is withdrawn, the older, though never withdrawn, does not count. Needs you says so.
check(!row(voice.pk).answers.fold.get(owner.pk)?.has('task+act'), 'withdrawing the newer copy ends the approval, as nvoy decides')
check(needs.filter(n => n.kind === 'replaced').map(n => n.grant.id).join() === twiceOld.id, 'the older copy left with no effect is under Needs you, and nothing else is')

// 6. Coverage: a relay has answered only when it sent EOSE, and absence is qualified otherwise.
const mixed = relayCoverage(['complete', 'partial', 'none', 'complete'])
check(mixed.complete === 2 && mixed.partial === 1 && mixed.of === 4 && !mixed.full, 'a relay that timed out after some events is partial, not answered')
check(relayCoverage(['complete', 'complete']).full && !relayCoverage([]).full, 'a read is full only when every relay asked sent EOSE')
check(relayCoverage(['complete', 'complete', 'complete', 'none'], { quorum: true }).full && relayCoverage(['complete', 'complete', 'complete', 'none'], { quorum: true }).missing === 1, 'with a quorum, three of four relays answering is a full read, and one is counted missing')
check(!relayCoverage(['complete', 'complete', 'none', 'none'], { quorum: true }).full && !relayCoverage(['complete', 'complete', 'complete', 'partial'], { quorum: false }).full, 'two of four is not a quorum, and without quorum one missing relay is still not full')
check(!relayCoverage(['complete', 'none'], { quorum: true }).full && relayCoverage(['complete', 'partial', 'complete', 'complete'], { quorum: true }).full, 'a pair has no slack, and a relay that only partly answered does not count toward the quorum')
check(coverageText(relayCoverage(['partial', 'none'])).none && coverageText(relayCoverage(['none'])).lead === 'Unverifiable', 'partial answers alone never show as answered')
check(/2 of 4 relays answered in full, 1 sent only part/.test(Object.values(coverageText(mixed)).join(' ')), 'the coverage line says how many answered in full and how many in part')
const nobody = { givers: [] }
check(workSentence(nobody, { owner: owner.pk, nameOf: () => '' }) === 'Nobody can give it work.' && /^Nobody, as far as the relays that answered in full show/.test(workSentence(nobody, { owner: owner.pk, nameOf: () => '', incomplete: true })), '"nobody" is qualified when an approval read was not full')
const hive = readFileSync(join(ROOT, 'console/hive.html'), 'utf8')
check(!/end\(out\.length > 0\)/.test(hive) && /end\('complete'\)/.test(hive) && /out\.length \? 'partial' : 'none'/.test(hive), 'the page marks a relay complete only on EOSE')
check(['incomplete: partial.approvals', 'partial.cards ?', 'partial.keys ?', 'partial.approvals ? `It asks'].every(t => hive.includes(t)), 'every absence on the page is qualified by the read it rests on')
check(hive.includes('approvals: !cardRead.full ||'), 'an unread card qualifies who can give work, since its grantors are unknown')

// 5. Card answers: shown or "not reported", never guessed.
const a = row(pidog.pk).answers
check(a.post.per_hour === 5 && a.act.limits.max_hops === 3, 'where it can post and its limits come from the card')
check(a.holds === 'withheld' && a.how.profile === 'not reported' && a.proof.lastTask === 'not reported', 'withheld and unreported answers say so')
check(row(voice.pk).answers.post === null && row(voice.pk).answers.how === null, 'a row with no card reports no card, not empty answers')
check(NOT_READ.length === 3, 'the sources not read yet are named for the page')

// The page wires the module in, guarded and mapped like every other console page.
const page = readFileSync(join(ROOT, 'console/hive.html'), 'utf8')
check(page.includes("from './hive-list.mjs'") && page.includes('"nostr-tools/pure"'), 'hive.html imports the module and maps nostr-tools/pure for the vendored fold')
check(!/innerHTML\s*=(?!\s*'')/.test(page), 'hive.html writes signed text only through textContent')

// Grouped by where each agent runs (#634): you and your voice first, everyone unlisted last.
{
  const key = id => PLATFORMS.find(p => p.id === id).keys[0]
  const rows = [{ pubkey: 'f'.repeat(64), roles: [] }, { pubkey: key('buzz'), roles: [] }, { pubkey: key('lab'), roles: [] },
    { pubkey: 'e'.repeat(64), roles: [{ role: 'voice' }] }, { pubkey: '4'.repeat(64), isOwner: true, roles: [] }]
  check(platformOf(rows[4]) === 'you' && platformOf(rows[3]) === 'you', 'the owner and the owner\'s voice are one group')
  check(platformOf({ pubkey: '8f3829871ec5ed5dff1b6654d3ca878aa1f4312968f318b18b158e1d93f0a37f', roles: [] }) === 'you', 'your written voice, the Quill, sits in your group too')
  check(byPlatform(rows).map(g => g.platform.id).join() === 'you,lab,buzz,other', 'groups come in the listed order, and a key nobody listed is last')
  check(!byPlatform(rows).some(g => g.platform.id === 'grok'), 'a group with nobody in it is not shown')
  check(platformOf({ pubkey: 'a135942aa05d90fff5d2062c78c61c1208903be241d3a93cb55e7009e87a3d8b', roles: [] }) === 'lab', 'crystalclaude, a Claude Code session on its own box, sits with the frontier lab harnesses')
  const DR = 'fab8083206712754a4d41698c202db01339b16c37652d110e5e0ab57b75b1432'
  check(platformOf({ pubkey: DR, roles: [{ role: 'voice' }] }) === 'lab' && platformOf({ pubkey: DR, roles: [] }) === 'lab', 'Dead Rabbit is a Claude Code agent first: a voice grant does not move it into your group')
  check(platformOf({ pubkey: DR, isOwner: true, roles: [] }) === 'you', 'the owner is always in your group, whatever is listed')
  check(platformOf({ pubkey: 'd'.repeat(64), roles: [{ role: 'voice' }] }) === 'you', 'a voice nobody listed still sits in your group')
  check(RUNS_ON[DR] === 'Claude Code', 'the column names Dead Rabbit as Claude Code')
  check(PLATFORMS.flatMap(p => p.keys || []).every((k, i, all) => /^[0-9a-f]{64}$/.test(k) && all.indexOf(k) === i), 'every listed key is a key, in one group only')
  check(nameSlots([['Zed', 'You', 'Amy']], n => ({ You: 0, Zed: 1, Amy: 2 })[n]).join() === 'You,Zed,Amy', 'name lines follow the group order')
}

{ // #656 review: a face is found by name, so a name two rows share must not borrow either row's photo.
  const named = { a: 'Pi Dog', b: 'Twin', c: 'Twin', d: 'Plain' }
  const faces = faceMap([
    { pubkey: 'o', isOwner: true, picture: 'https://x/me.png' },
    { pubkey: 'a', picture: 'https://x/pi.png', roles: [{ role: 'voice' }] },
    { pubkey: 'b', picture: 'https://x/b.png' },
    { pubkey: 'c', picture: 'https://x/c.png' },
    { pubkey: 'd' },
  ], pk => named[pk])
  check(faces.get('You') === 'https://x/me.png' && faces.get('Pi Dog') === 'https://x/pi.png', 'a name wears its own row\'s photo')
  check(faces.get('Your voice') === 'https://x/pi.png', 'the voice line wears the voice key\'s photo')
  check(faces.has('Twin') && faces.get('Twin') === null, 'a name two rows share gets no photo, not either one')
  check(faces.get('Plain') === null, 'a row with no photo gives its name none')
}

{ // Every row carries a Copy npub button, by its name and in its details, with a by-hand fallback.
  const page = readFileSync(join(ROOT, 'console', 'hive.html'), 'utf8')
  check((page.match(/copyButton\((agent|key), r, keyText, detail\)/g) || []).length === 2, 'each row copies its npub from its name and from its details')
  check(/clipboard\.writeText\(npub\(r\.pubkey\)\)/.test(page), 'the button copies the npub, not the hex key')
  check(/catch \{[^}]*openSide\(\{ kind: 'name', pk: r\.pubkey \}\)[\s\S]{0,200}selectAllChildren\(keyText\)[\s\S]{0,40}said\('Select and copy'\)/.test(page), 'a refused clipboard opens its answers with the npub selected, and claims no copy')
}

console.log('console_hive_list: one list, every key kept, roles from recipes, nvoy\'s fold pinned')

// A quorum read warns beside the grid, naming what the missing relay could change (#734 review).
{
  const w = quorumWarning({ missing: 1, enough: true })
  check(/One approval relay did not answer/.test(w) && /withdrawal/.test(w) && /approval/.test(w) && /held only on a missing relay/.test(w) && /key held only there/.test(w), 'the quorum warning names the missing relay and the approval, withdrawal and key risk')
  check(quorumWarning({ missing: 0 }) === null && quorumWarning() === null, 'no warning when every relay answered')
  const few = quorumWarning({ missing: 2, enough: false })
  check(/Too few approval relays/.test(few) && !/One approval relay/.test(few) && /2 did not/.test(few), 'fewer than three answering never says exactly one relay failed')
  check(/2 approval relays did not answer/.test(quorumWarning({ missing: 2, enough: true })), 'the count is the real count')
  // Both of Neil's branches, on the real relayCoverage: three of four grant relays, and the card relay failing.
  const grant = relayCoverage(['complete', 'complete', 'complete', 'none'], { quorum: true })
  check(grant.full && !grant.all && grant.missing === 1, 'three of four grant relays is a quorum, and not every relay answered')
  const cardFailed = relayCoverage(['none'])
  check(!cardFailed.full && grant.missing > 0, 'a failed card read does not hide the grant read slack')
  const page = readFileSync(new URL('../console/hive.html', import.meta.url), 'utf8')
  check(/id="quorum-note"/.test(page) && /quorumWarning\(\{ missing: partial\.slack, enough: partial\.slackEnough \}\)/.test(page) && !/quorumWarning\([^)]*partial\.approvals/.test(page), 'the page shows the warning whenever a grant read has slack, whatever the card read did')
  check(/keys: !cardRead\.full \|\| !given\.all \|\| !held\.all/.test(page) && !/keys:[^\n]*(given|held)\.full/.test(page), 'identity completeness (keys) stays strict across every grant relay, not the quorum')
  check(/approvals: !cardRead\.full \|\| !given\.full \|\| !held\.full/.test(page), 'only the approval squares use the quorum threshold')
}

// 7. A herd-cloud seat no other source names (Crusty, 10 Nov) is one row, "no Buzz channel", in its table group; joining
// Buzz moves the same row to the new channel identity and keeps the Hive writer key as a separate identity on it.
{
  const { SEATS, rowKeyOf } = await import('../console/hive-seats.mjs')
  const { agentsOf } = await import('../console/hive-grid.mjs')
  const crusty = SEATS.find(x => x.label === 'Crusty'), writer = crusty.pubkey, channel = keys().pk
  check(/^[0-9a-f]{64}$/.test(writer) && /^[0-9a-f]{64}$/.test(crusty.channel) && crusty.channel !== writer && SEATS.every(x => Object.keys(x).sort().join() === 'channel,group,harness,label,pubkey'), 'SEATS holds Crusty: public writer key, a different public channel key, and no other fields')
  const t = await scopeTable([owner.pk], [], scopeHash)
  const rowsOf = (seats, extra = {}) => buildList({ owner: owner.pk, table: t, seats, ...extra }).rows
  // The signed request exists (James, 10 Nov 22:47): the row is keyed by the Bunker channel key, the writer key rides on it.
  const nowRows = rowsOf(SEATS)
  const nowRow = nowRows.find(r => r.pubkey === crusty.channel)
  check(nowRow && nowRow.name === 'Crusty' && nowRow.noBuzz === true && nowRow.hiveWriter === writer && RUNS_ON[crusty.channel] === 'Pi' && platformOf(nowRow) === 'third-party' && !nowRows.some(r => r.pubkey === writer),
    'with the channel key set: one row on it, no Buzz channel until the roster names it, the writer key shown, Pi, third-party, no stale writer row')
  check(agentsOf(nowRows).groups.find(g => g.platform.id === 'third-party').rows.some(r => r.pubkey === crusty.channel), 'and it is in the main grid')
  check(!rowsOf([]).some(r => r.pubkey === crusty.channel || r.pubkey === writer), 'without the seats source it is absent, which was the bug')
  // before the bind (channel not set): keyed by the writer key
  const unbound = [{ ...crusty, channel: null }]
  const before = rowsOf(unbound).find(r => r.pubkey === writer)
  check(before && before.noBuzz === true && before.hiveWriter === null && RUNS_ON[writer] === 'Pi', 'before a channel key exists: one row on the writer key, as the first version showed')
  const bound = [{ ...crusty, channel }]
  // a card without the roster is not membership: the card is published before the rooms step
  const cardOnly = rowsOf(bound, { cards: new Map([[channel, { instance: 'crusty', grantors: [owner.pk] }]]) }).find(r => r.pubkey === channel)
  check(cardOnly.noBuzz === true, 'card published but not on the roster: still no Buzz channel')
  // live: roster names the channel key
  const live = rowsOf(bound, { roster: [{ pubkey: channel, label: 'Crusty' }] }).find(r => r.pubkey === channel)
  check(live.noBuzz === false && live.hiveWriter === writer && live.name === 'Crusty', 'on the roster: no longer "no Buzz channel", still names its Hive writer key')
  check(rowsOf(bound, { roster: [{ pubkey: channel, label: 'Crusty' }] }).filter(r => r.name === 'Crusty').length === 1, 'exactly one Crusty row after joining')
}
if (!pass) { console.error('console_hive_list: FAILED'); process.exit(1) }
