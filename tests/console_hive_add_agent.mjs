// #649 / nvoy #289 — the setup requests behind "Add an agent".
//
//  1. add_agent carries only the closed set of public tags nvoy-onboard accepts, in its shape.
//  2. What the fleet would refuse is refused here before the owner is asked to sign.
//  3. bind_runtime carries the public channel key only; a private one never reaches a draft.
//  4. Sending refuses an edited or foreign-key event before anything is published, and a relay OK
//     is reported as "sent", never as done.
//  5. The cold read-back counts only the sent event, by the owner, with a valid signature.
//  6. Joining the hive (#683): the terms are read as the agent reads them, unread is never "none",
//     and the join tags pass nvoy's own rules or are refused before signing.
//  7. Mint, then seal, then sign: a failure at any step makes nothing further, and the invite code
//     never appears unsealed in a tag, a message, or the page.
//  8. The seven-step page (add-agent-flow.mjs): three signatures, each a newer add_agent for the same
//     agent; a step is done only from the newest request read back, valid and by the owner.
//
//   node tests/console_hive_add_agent.mjs

import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { readFileSync } from 'node:fs'
import { HARNESSES, agentName, draftAddAgent, draftBind, readBack, requestD, sendRequest, sealedShape, SETUP_KIND } from '../console/hive-add-agent.mjs'
import { STEPS, NOT_BUILT, PART_BUILT, newestAdd, joinOf, readBackSteps, workGrantPlan, pickerOf, sameAs, handoffState, hiveChoices, othersThan, fixedBy, changedFrom, giverPlan, reconcileGivers, goneLine, HANDOFF } from '../console/add-agent-flow.mjs'
import * as flow from '../console/add-agent-flow.mjs'
import { draftGrant, draftRevoke } from '../console/hive-change.mjs'
import { scopeHash } from '../console/scope-hash.mjs'
import { HIVE_RELAY, INVITE_TTL_SECS, joinGate, readHiveTerms, sealInvite, termsFromRead } from '../console/hive-invite.mjs'

const key = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) } }
const O = key(), X = key(), A = key(), G = key()
const room = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK0' + 'a'.repeat(40)
const installed = [{ id: 'pi-dog', pubkey: G.pk }]
let fails = 0
const check = (c, n) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }
const throws = (f, re) => { try { f(); return false } catch (e) { return re.test(e.message) } }
const base = { name: ' HR ', agent: A.pk, harness: 'claude-code', like: 'crystalclaude', givers: [O.pk, G.pk, G.pk], rooms: [room.toUpperCase()], installed, now: 1000 }

// ── 1. The shape nvoy-onboard reads ─────────────────────────────────────────────────────────────
const add = draftAddAgent(base)
check(add.kind === SETUP_KIND && add.content === '' && add.created_at === 1000, 'kind 30078, no content')
check(JSON.stringify(add.tags) === JSON.stringify([['d', 'nvoy-onboard/hr/add_agent'], ['op', 'add_agent'], ['p', A.pk], ['harness', 'claude-code'],
  ['like', 'crystalclaude'], ['giver', O.pk], ['giver', G.pk], ['room', room]]), 'the closed tag set, the name lowered, givers and rooms once each')
check(add.tags.every(tag => tag.length === 2 && typeof tag[1] === 'string'), 'every tag is a name and one value')
check(requestD('hr', 'bind_runtime') === 'nvoy-onboard/hr/bind_runtime', 'each op has its own d, so a bind does not replace the add')

// ── 2. Refused before signing ───────────────────────────────────────────────────────────────────
check(throws(() => agentName('my agent'), /letters, digits/), 'a name with a space')
check(throws(() => agentName('-x'), /starting with/), 'a name that starts with a dash')
check(throws(() => draftAddAgent({ ...base, agent: 'npub1xyz' }), /public key/), 'a key that is not decoded hex')
check(throws(() => draftAddAgent({ ...base, harness: 'bash' }), /runs in/), 'a harness outside the list')
check(throws(() => draftAddAgent({ ...base, like: '' }), /start like/), 'no agent to start like')
check(throws(() => draftAddAgent({ ...base, agent: G.pk }), /already pi-dog/), 'a key that is already an agent')
check(throws(() => draftAddAgent({ ...base, name: 'pi-dog' }), /already an agent's name/), 'a name already in use')
check(throws(() => draftAddAgent({ ...base, givers: [A.pk] }), /itself/), 'an agent giving itself work')
check(throws(() => draftAddAgent({ ...base, rooms: ['waggle-test'] }), /room id/), 'a room by name, not id')

// ── 3. bind_runtime: the public half only ───────────────────────────────────────────────────────
const bind = draftBind({ ...base, channelKey: `${KEY} hr@yoga\n` })
check(JSON.stringify(bind.tags) === JSON.stringify([['d', 'nvoy-onboard/hr/bind_runtime'], ['op', 'bind_runtime'], ['p', A.pk],
  ['harness', 'claude-code'], ['like', 'crystalclaude'], ['channel_key', KEY]]), 'the key line, its comment (a host name) dropped')
check(throws(() => draftBind({ ...base, channelKey: '-----BEGIN OPENSSH PRIVATE KEY-----' }), /private/), 'a private key never becomes a draft')
check(throws(() => draftBind({ ...base, channelKey: 'ssh-rsa AAAAB3Nza' }), /starting ssh-ed25519/), 'an unsupported key type')
check(throws(() => draftBind({ ...base, channelKey: `${KEY}\n${KEY}` }), /one line/), 'two lines')
check(throws(() => draftBind({ ...base, harness: 'codex', channelKey: KEY }), /second key/), 'a Codex agent is refused: its wake feed needs a key this request cannot carry')
check(draftBind({ ...base, harness: 'antigravity', channelKey: KEY }).tags.some(t => t[0] === 'harness' && t[1] === 'antigravity'), 'an Antigravity agent binds its one channel key')

// ── 4. Sending ──────────────────────────────────────────────────────────────────────────────────
const relays = ['wss://a.example', 'wss://b.example']
const sockets = []
const connect = url => { const ws = { url, sent: [], close() {}, send(data) { this.sent.push(JSON.parse(data)); const ev = this.sent[0][1]; setTimeout(() => this.onmessage({ data: JSON.stringify(['OK', ev.id, url.includes('a.'), url.includes('a.') ? '' : 'blocked']) }), 0) } }; sockets.push(ws); setTimeout(() => ws.onopen(), 0); return ws }
const opts = { owner: O.pk, verify: verifyEvent, connect, relays, timeoutMs: 500 }
const sent = await sendRequest(add, { ...opts, sign: async t => finalizeEvent({ ...t }, O.sk) })
check(sent.accepted === 1 && /^Sent\. 1 of 2 relays have it \(a\.example\)\.$/.test(sent.text), 'a relay OK is "sent", never "done"')
let error = ''
const before = sockets.length
try { await sendRequest(add, { ...opts, sign: async t => finalizeEvent({ ...t, tags: [...t.tags, ['giver', X.pk]] }, O.sk) }) } catch (e) { error = e.message }
check(/not the one shown/.test(error) && sockets.length === before, 'an edited event is refused, nothing published')
error = ''
try { await sendRequest(add, { ...opts, sign: async t => finalizeEvent({ ...t }, X.sk) }) } catch (e) { error = e.message }
check(/different key/.test(error) && sockets.length === before, 'a foreign signer is refused, nothing published')

// ── 5. Reading it back ──────────────────────────────────────────────────────────────────────────
// Relays hand back parsed JSON, so build each case from a fresh plain copy: verifyEvent caches its answer on the object.
const mine = sent.signed, plain = () => JSON.parse(JSON.stringify(mine)), back = { owner: O.pk, verify: verifyEvent }
check(readBack([plain()], mine, back), 'the sent event, read back, counts')
check(!readBack([{ ...plain(), sig: '0'.repeat(128) }], mine, back), 'the same id with a bad signature does not count')
check(!readBack([{ ...plain(), content: 'x' }], mine, back), 'the same id over edited content does not count')
const foreign = JSON.parse(JSON.stringify(finalizeEvent({ kind: add.kind, created_at: add.created_at, tags: add.tags, content: '' }, X.sk)))
check(!readBack([{ ...foreign, id: mine.id }], mine, back), 'a different signer under the same id does not count')
check(!readBack([foreign], mine, back) && !readBack([], mine, back), 'another event, or nothing, does not count')

// ── 6. Joining the hive: terms and tags ─────────────────────────────────────────────────────────
const CODE = 'v2.single-use-invite-code-0123456789'
const seal = (text, to = A.pk) => nip44.encrypt(text, nip44.getConversationKey(O.sk, to))
const sealed = seal(CODE)
check(sealedShape(sealed) && !sealedShape(CODE) && !sealedShape(btoa('x'.repeat(120))), 'a NIP-44 v2 payload is sealed; plain text, or base64 without the version byte, is not')
const V = 'a7b4425bfb6ffd909da7bb50a49b4cc818e09d74dbae20207b9f6cc9ef64920d'
const joined = draftAddAgent({ ...base, join: { invite: sealed, policy: V, age: 'confirmed' } })
check(JSON.stringify(joined.tags.slice(-3)) === JSON.stringify([['invite', sealed], ['policy', V], ['age', 'confirmed']]), 'the sealed invite, the agreed version and the age confirmation')
const noTerms = draftAddAgent({ ...base, join: { invite: sealed, policy: 'none' } })
check(JSON.stringify(noTerms.tags.slice(-2)) === JSON.stringify([['invite', sealed], ['policy', 'none']]) && !noTerms.tags.some(t => t[0] === 'age'), 'no terms: policy none, and no age tag unless ticked')
check(!add.tags.some(t => ['invite', 'policy', 'age'].includes(t[0])), 'without join, no join tags')
check(throws(() => draftAddAgent({ ...base, join: { invite: CODE, policy: V } }), /sealed to the agent, never plain/), 'a plain invite code never becomes a draft')
check(throws(() => draftAddAgent({ ...base, join: { invite: sealed } }), /terms version/), 'an invite without the agreed version')
check(throws(() => draftAddAgent({ ...base, join: { invite: sealed, policy: 'v 1' } }), /terms version/), 'a version outside nvoy\'s pattern')
check(throws(() => draftAddAgent({ ...base, join: { invite: sealed, policy: V, age: 'yes' } }), /confirmed, or absent/), 'age is confirmed, or absent')
check(throws(() => draftAddAgent({ ...base, join: {} }), /needs the hive invite/), 'a join with no invite')

const T = terms => termsFromRead(terms)
const live = T({ status: 200, json: { policy: { version: V, age_attestation_required: true, terms_markdown: 'Be kind.', privacy_markdown: 'We keep little.' } } })
check(live.ok && live.version === V && live.age === true && live.terms === 'Be kind.' && live.privacy === 'We keep little.', 'terms served: their version, whether they ask for age, and both documents')
const privacyOnly = T({ status: 200, json: { policy: { version: '2', privacy_markdown: 'We keep little.' } } })
check(privacyOnly.ok && privacyOnly.terms === '' && privacyOnly.privacy === 'We keep little.', 'a privacy-only policy shows its one document')
check(!T({ status: 200, json: { policy: { version: '2' } } }).ok, 'terms with no document to read are not agreed to')
const NONE = JSON.stringify({ ok: true, version: 'none', age: false, terms: '', privacy: '' })
check(JSON.stringify(T({ status: 200, json: {} })) === NONE, 'the relay\'s no-terms answer, 200 {}, is "no terms"')
check(JSON.stringify(T({ status: 200, json: { policy: null } })) === NONE, 'policy null reads the same')
check(!T({ status: 404, json: {} }).ok, 'a 404 is unread, never "none"')
const errorBody = T({ status: 200, json: { error: 'policy unavailable' } })
check(!errorBody.ok && errorBody.reason === 'no policy field', 'an error object with no policy is unread, never "none"')
check(!T({ status: 200, json: { policy: null, error: 'policy unavailable' } }).ok, 'a null policy beside other fields is unread')
check(!joinGate(errorBody).ok, 'an error answer makes no invite')
check(!T({ status: 200, json: undefined }).ok && !T({ status: 200, json: null }).ok && !T({ status: 200, json: [] }).ok, 'not JSON, null, or not an object is unread')
check(!T({ status: 200, json: { policy: 'v1' } }).ok && !T({ status: 200, json: { policy: [] } }).ok, 'a policy that is not an object is unread')
check(!T({ status: 200, json: { policy: { age_attestation_required: false, terms_markdown: 'x' } } }).ok, 'terms with no version cannot be agreed to')
let asked = ''
const termsBack = await readHiveTerms({ relayUrl: 'wss://hive.example', fetchImpl: async url => { asked = url; return { status: 200, json: async () => ({ policy: null }) } } })
check(asked === 'https://hive.example/api/join-policy' && termsBack.version === 'none', 'read over https from the relay\'s wss address')
await readHiveTerms({ fetchImpl: async url => { asked = url; return { status: 200, json: async () => ({}) } } })
check(asked === 'https://nave.communities.buzz.xyz/api/join-policy', 'by default, from the hive relay')
const down = await readHiveTerms({ relayUrl: 'wss://hive.example', fetchImpl: async () => { throw new TypeError('Failed to fetch') } })
check(!down.ok && /could not complete the request to hive\.example/.test(down.reason), 'a relay that does not answer is unread')
const html = await readHiveTerms({ relayUrl: 'wss://hive.example', fetchImpl: async () => ({ status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } }) })
check(!html.ok && html.reason === 'not JSON', 'a relay that serves a web page is unread')
check(HIVE_RELAY === 'wss://nave.communities.buzz.xyz' && INVITE_TTL_SECS === 604800, 'the hive the fleet logs in to; an invite lives as long as a request')

check(!joinGate(down).ok && /Can't read the hive's terms/.test(joinGate(down).reason), 'unread terms: nothing is made')
check(/agree/.test(joinGate(live, { ageConfirmed: true }).reason), 'terms not agreed: nothing is made')
check(/age requirement/.test(joinGate(live, { agreed: true }).reason), 'age asked and not confirmed: nothing is made')
check(joinGate(live, { agreed: true, ageConfirmed: true }).ok && joinGate(T({ status: 200, json: {} })).ok, 'agreed and confirmed, or no terms at all')

// ── 7. Mint, then seal ──────────────────────────────────────────────────────────────────────────
function world({ mintFails = '', encrypt } = {}) {
  const w = { log: [], minted: null }
  w.mint = async opts => { w.log.push('mint'); w.minted = opts; return mintFails ? { ok: false, reason: mintFails } : { ok: true, code: CODE } }
  w.signer = { nip44Encrypt: encrypt || (async (pk, text) => { w.log.push('seal'); return seal(text, pk) }) }
  return w
}
const ask = (w, extra = {}) => sealInvite({ agent: A.pk, terms: live, agreed: true, ageConfirmed: true,
  signer: w.signer, sign: async () => { throw new Error('mint is stubbed') }, mint: w.mint, ...extra })
const caught = async f => { try { await f(); return '' } catch (e) { return e.message } }

let w = world(), got = await ask(w)
check(JSON.stringify(w.log) === JSON.stringify(['mint', 'seal']), 'minted first, then sealed')
check(w.minted.maxUses === 1 && w.minted.ttlSecs === INVITE_TTL_SECS && w.minted.relayUrl === HIVE_RELAY, 'single use, for 7 days, at the hive')
w = world(); await ask(w, { relayUrl: 'wss://elsewhere.example' })
check(w.minted.relayUrl === HIVE_RELAY, 'minted only at the hive the agent claims at, whatever else is passed')
check(got.policy === V && got.age === 'confirmed' && nip44.decrypt(got.invite, nip44.getConversationKey(A.sk, O.pk)) === CODE, 'the agent\'s key opens it to the code')
check(!JSON.stringify(got).includes(CODE), 'the code is not in anything returned')
check(!JSON.stringify(draftAddAgent({ ...base, join: got })).includes(CODE), 'the code is not in the draft')
check((await ask(world(), { ageConfirmed: false, terms: T({ status: 200, json: { policy: { version: '3', terms_markdown: 'x' } } }) })).age === undefined, 'age not ticked: no age tag')

w = world(); error = await caught(() => ask(w, { agreed: false }))
check(/agree/.test(error) && w.log.length === 0, 'not agreed: nothing minted')
w = world(); error = await caught(() => ask(w, { terms: down }))
check(/Can't read/.test(error) && w.log.length === 0, 'terms unread: nothing minted')
w = world(); error = await caught(() => ask(w, { signer: {} }))
check(/cannot seal/.test(error) && w.log.length === 0, 'a signer that cannot encrypt: nothing minted')
w = world(); error = await caught(() => ask(w, { agent: 'npub1x' }))
check(/public key/.test(error) && w.log.length === 0, 'no agent key: nothing minted')
w = world({ mintFails: 'this key does not hold owner or admin in relay_members' }); error = await caught(() => ask(w))
check(/did not make an invite: this key does not hold owner or admin/.test(error) && JSON.stringify(w.log) === '["mint"]', 'mint refused: the relay\'s reason, nothing sealed')
w = world({ encrypt: async (pk, text) => { throw new Error(`permission denied for nip44_encrypt of ${text}`) } }); error = await caught(() => ask(w))
check(/Allow encrypt for this page in your Bunker/.test(error) && /expires by itself in 7 days/.test(error), 'the Bunker refuses encrypt: say how to allow it, and that the unused invite expires')
check(!error.includes(CODE) && /\[invite\]/.test(error), 'a refusal that echoes the code has it scrubbed')
w = world({ encrypt: async (pk, text) => text }); error = await caught(() => ask(w))
check(/not a sealed message/.test(error) && !error.includes(CODE), 'a signer that hands the code back plain: refused, nothing sent')

// The page: mint and seal before the signature that publishes, and the code never reaches it.
const page = readFileSync(new URL('../console/add-agent.html', import.meta.url), 'utf8')
const send = page.slice(page.indexOf('async function send('), page.indexOf("$('tools-go').onclick"))
const join = page.slice(page.indexOf("$('join-go').onclick"), page.indexOf("$('work-go').onclick"))
check(send.indexOf('draftAddAgent({ ...f, join: joined || undefined })') > 0 && send.indexOf('draftAddAgent({ ...f, join: joined || undefined })') < send.indexOf('await build('), 'a form mistake is caught before anything is minted')
check(send.indexOf('await build(') > 0 && send.indexOf('await build(') < send.indexOf('await sendRequest(template'), 'the invite is made before the publishing signature is asked for')
check(join.indexOf('await sealInvite(') > 0 && join.indexOf('await sealInvite(') < join.indexOf('return draftAddAgent({ ...f, join })'), 'the page seals before it drafts the request that carries the invite')
check(!/\.code\b|mintInvite/.test(page), 'the page never handles the code: only the sealed invite comes back to it')
check(!/loadRelayUrl|relayUrl:/.test(page), 'the page does not mint at a relay the Access page last probed')
check(page.indexOf('id="privacy-read"') > 0 && page.indexOf('id="terms-read"') < page.indexOf('id="ticks"') && page.indexOf('id="privacy-read"') < page.indexOf('id="ticks"'), 'both documents are shown above the tick')
check(/<input type="checkbox" id="agree">/.test(page) && /<input type="checkbox" id="age">/.test(page) && !/id="(agree|age)"[^>]*checked/.test(page), 'two ticks, neither ticked for the owner')
check(!/sessionStorage\.setItem\([^)]*joined|localStorage\.setItem\([^)]*join/.test(page) && !/invite/.test(page.slice(page.indexOf('const form = {'), page.indexOf('\n', page.indexOf('const form = {')))), 'the sealed invite is never kept in the browser: it is read back from the request')
const hive = readFileSync(new URL('../console/hive.html', import.meta.url), 'utf8')
check(/<a id="add-open" class="button small" href="add-agent.html">/.test(hive) && !/id="add-panel"/.test(hive), 'Add an agent is its own page, opened from the hive page')

// The seven steps: three signatures, each a newer add_agent carrying everything chosen so far.
check(STEPS.map(s => s.label).join('|') === 'Name it|Make its key|Set up its tools|Start it on its box|Join the hive|Who can give it work|Prove it works', 'the rail has the seven steps of the design, in its order')
check(Object.keys(NOT_BUILT).join() === '7' && Object.keys(PART_BUILT).join() === '4', 'the step the page cannot do yet, and the step it does only in part, say so, and nothing else does')
check(!Object.keys(NOT_BUILT).some(n => n in PART_BUILT), 'a step is either not built or partly built, never both')

// Step 4: paste the public half the line printed, sign it as bind_runtime, read that very event back.
check(/<input id="channel-key"/.test(page) && /id="box-go"/.test(page) && /id="box-status"/.test(page), 'step 4 has the paste field, its own button and its own status')
check(/send\('box-status', 'box-go', f => draftBind\(/.test(page), 'step 4 signs a bind_runtime through the same send path as the other signatures')
check(/'#d': \[requestD\(form\.name, 'bind_runtime'\)\]/.test(page) && /readBack\(back\.events, signed/.test(page), 'step 4 reads back the very bind it sent, by its own d, not the add_agent')
check(/PART_BUILT\[s\.n\] \? 'partly built'/.test(page) && /\$\('box-later'\)\.textContent = PART_BUILT\[4\]/.test(page), 'the rail and the step say step 4 is partly built, never done')
const sealedJoin = { invite: nip44.encrypt('code', nip44.getConversationKey(O.sk, A.pk)), policy: 'v1', age: 'confirmed' }
const flowFields = { name: 'hr', agent: A.pk, harness: 'claude-code', like: 'crystalclaude', installed }
const atT = (t, extra = {}) => finalizeEvent(draftAddAgent({ ...flowFields, ...extra, now: t }), O.sk)
const req3 = atT(100, { givers: [O.pk] }), req5 = atT(200, { givers: [O.pk], join: sealedJoin }), req6 = atT(300, { givers: [O.pk, G.pk], join: sealedJoin })
const flowOpts = { owner: O.pk, name: 'hr', agent: A.pk, verify: verifyEvent }
check(newestAdd([req3, req6, req5], flowOpts)?.id === req6.id, 'the newest request wins, as the fleet resolves it')
check(newestAdd([finalizeEvent(draftAddAgent({ ...flowFields, now: 400 }), X.sk), req3], flowOpts)?.id === req3.id, 'a request signed by anyone else is not the owner\'s')
check(newestAdd([{ ...req6, tags: req6.tags.filter(t => t[0] !== 'giver') }, req3], flowOpts)?.id === req3.id, 'an edited request fails its signature and does not count')
check(newestAdd([finalizeEvent(draftAddAgent({ ...flowFields, agent: G.pk, installed: [], now: 500 }), O.sk)], flowOpts) === null, 'a request for another key under this name is not this agent\'s')
check(joinOf(req3) === null && JSON.stringify(joinOf(req5)) === JSON.stringify(sealedJoin), 'the invite is read back sealed, exactly as signed, and absent before step 5')
check(draftAddAgent({ ...flowFields, join: joinOf(req5) }).tags.some(t => t[0] === 'invite' && t[1] === sealedJoin.invite), 'the invite read back drafts again, so step 6 keeps it')
let flowSteps = readBackSteps(req3)
check(flowSteps[3] && !flowSteps[5] && !flowSteps[6], 'after step 3: tools asked for, no invite yet')
flowSteps = readBackSteps(req6)
check(flowSteps[3] && flowSteps[5] && !flowSteps[6] && flowSteps.givers.join() === [O.pk, G.pk].join(), 'givers alone do not make step 6 done')
const granted = { held: [O.pk, G.pk], missing: [] }
check(readBackSteps(req6, { sixth: req6.id, plan: granted })[6] && !readBackSteps(req5, { sixth: req6.id, plan: granted })[6], 'step 6 is done only when the newest request is the one sent from step 6')
check(!readBackSteps(req6, { sixth: req6.id })[6] && !readBackSteps(req6, { sixth: req6.id, plan: { held: [O.pk], missing: [G.pk] } })[6], 'and only when every giver holds your approval: a giver on the request alone is heard as data only (#716)')

// Step 6's approvals (#716): one task 440 from the owner per giver, over the agent, owner first.
{
  const grant = async (grantee, { cap = 'task', agent = A.pk, by = O.sk, now = 1000 } = {}) => finalizeEvent(await draftGrant({ grantee, agent, cap, scopeHash, now }), by)
  const plan = events => workGrantPlan({ owner: O.pk, agent: A.pk, givers: [G.pk, O.pk, G.pk, A.pk], events, verify: verifyEvent, scopeHash })
  let p = await plan([])
  check(p.missing.join() === [O.pk, G.pk].join() && !p.held.length, 'nothing signed: every giver needs one, the owner first, the agent itself and repeats dropped')
  const gO = await grant(O.pk), gG = await grant(G.pk)
  p = await plan([gO, gG])
  check(!p.missing.length && p.held.join() === [O.pk, G.pk].join(), 'a live task grant from the owner over this agent counts for its grantee')
  p = await plan([gO, await grant(G.pk, { cap: 'task+act' })])
  check(!p.missing.length, 'task+act counts as work too')
  p = await plan([gO, await grant(G.pk, { agent: X.pk })])
  check(p.missing.join() === G.pk, "an approval over another agent does not count for this one")
  p = await plan([gO, await grant(G.pk, { by: X.sk })])
  check(p.missing.join() === G.pk, "an approval signed by someone else is not the owner's")
  p = await plan([gO, gG, finalizeEvent(draftRevoke({ grantId: gG.id, now: 1001 }), O.sk)])
  check(p.missing.join() === G.pk && p.held.join() === O.pk, 'a withdrawn approval needs signing again')
  p = await plan([gO, { ...gG, tags: gG.tags.map(t => t[0] === 'p' ? ['p', X.pk] : t) }])
  check(p.missing.join() === G.pk, 'an edited approval fails its signature and does not count')
  const tmpl = await draftGrant({ grantee: O.pk, agent: A.pk, cap: 'task', scopeHash })
  const scope = tmpl.tags.find(t => t[0] === 'da-scope')
  check(tmpl.kind === 440 && tmpl.tags[0][1] === O.pk && tmpl.tags.find(t => t[0] === 'da-cap')[1] === 'task' && scope[1] === await scopeHash(A.pk, scope[2]) && !JSON.stringify(tmpl).includes(A.pk), 'the drafted approval is grant.mjs\'s shape: p = giver, cap task, the agent only as a salted hash')
  check(/\.then\(\(\) => form\.sixth !== before && latest\?\.id === form\.sixth && signWorkGrants\(\)\)/.test(page), 'the page signs approvals only after step 6\'s own request reads back')
  check(/draftGrant\(\{ grantee, agent: form\.agent, cap: 'task', scopeHash \}\)/.test(page) && /applyChange\(template, \{ sign: t => signFresh\(t, signer\), owner,/.test(page), 'each approval goes through the hive page\'s apply path: shown event, owner key, read back cold')
}
check(!readBackSteps(null)[3], 'nothing read back: nothing done')

// ── 9. Step 6 is a search with chips, built for 50 (#698) ─────────────────────────────────────────
check(HARNESSES.some(([id, label]) => id === 'hermes' && label === 'Hermes'), 'Hermes is offered in Runs in')
check(HARNESSES.some(([id, label]) => id === 'antigravity' && label === 'Gemini (Antigravity)'), 'Gemini (Antigravity) is offered in Runs in')
check(!HARNESSES.some(([id]) => id === 'buzz'), 'Buzz is where agents talk, not a harness')
const pickGroups = [{ id: 'you', label: 'You' }, { id: 'lab', label: 'Frontier lab harnesses' }, { id: 'other', label: 'Everyone else' }]
const many = [{ pubkey: 'o', label: 'You', where: 'Your Bunker' }]
for (let i = 0; i < 50; i++) many.push({ pubkey: `k${i}`, label: `Agent ${i}`, where: i % 2 ? 'Codex' : 'Hermes' })
const groupOf = c => c.pubkey === 'o' ? 'you' : c.where === 'Codex' ? 'lab' : 'other'
let pick = pickerOf(many, { chosen: ['o', 'k1'], groups: pickGroups, groupOf })
check(pick.groups.map(g => g.n).join() === '1,25,25' && pick.groups.every(g => g.open), 'every group is shown, open, with its count')
check(pick.chips.map(c => c.pubkey).join() === 'o,k1' && pick.groups[1].picked === 1 && pick.groups[1].rows.find(r => r.pubkey === 'k1').on, 'ticked agents show as chips and stay ticked in their group')
pick = pickerOf(many, { chosen: [], folded: { lab: true }, groups: pickGroups, groupOf })
check(!pick.groups[1].open && pick.groups[2].open, 'a folded group stays folded without a search')
pick = pickerOf(many, { chosen: [], q: 'hermes', folded: { other: true }, groups: pickGroups, groupOf })
check(pick.groups.length === 1 && pick.groups[0].id === 'other' && pick.groups[0].open && pick.groups[0].rows.length === 25, 'a search shows only matching groups, opened even if folded')
pick = pickerOf(many, { chosen: [], q: 'Agent 7', groups: pickGroups, groupOf })
check(pick.groups[0].rows.map(r => r.pubkey).join() === 'k7', 'a search matches by name')
check(pickerOf(many, { q: 'nobody-by-this-name', groups: pickGroups, groupOf }).none, 'a search with no match says so')
const handoff = { owner: 'o', complete: true, givers: { mc: ['o', 'k3', 'gone'] } }
check(sameAs(handoff, { owner: 'o', like: 'mc' }, many).join() === 'o,k3', 'Same as copies the agent\'s givers, only those still offered')
check(sameAs(handoff, { owner: 'x', like: 'mc' }, many) === null, 'another owner\'s hive is not copied')
check(sameAs(null, { owner: 'o', like: 'mc' }, many) === null && sameAs(handoff, { owner: 'o', like: 'pi' }, many) === null, 'nothing read from the hive: Same as is off')
check(handoffState({ ...handoff, complete: false }, 'o') === 'partial' && sameAs({ ...handoff, complete: false }, { owner: 'o', like: 'mc' }, many) === null, 'a short read of the hive: Same as is off, so a shorter giver list is never signed')
check(sameAs({ owner: 'o', givers: handoff.givers }, { owner: 'o', like: 'mc' }, many) === null, 'a handoff that does not say it was read in full counts as short')

// The picker offers everyone the hive grid draws, not only agents with cards.
const P = key(), Bz = key()
const hiveHandoff = { owner: O.pk, complete: true, givers: {}, hive: [{ pubkey: P.pk, label: 'Dennis', where: 'in your hive' }, { pubkey: Bz.pk, label: 'Buzz Bee', where: 'Buzz' }, { pubkey: O.pk, label: 'You' }, { pubkey: 'not-a-key', label: 'x' }] }
check(hiveChoices(hiveHandoff, O.pk).map(c => c.label).join() === 'Dennis,Buzz Bee', "people and Buzz agents with no card are offered; the owner and malformed entries aren't")
check(hiveChoices(hiveHandoff, X.pk).length === 0 && hiveChoices(null, O.pk).length === 0, "another owner's hive, or none read: nothing extra is offered")
check(hiveChoices({ ...hiveHandoff, complete: false }, O.pk).length === 2, 'a short read still offers who it did read: offering a giver signs nothing')

// A reload part way through: the new agent's own card is not a duplicate of itself.
const withSelf = [...installed, { id: 'hr', pubkey: A.pk }]
check((() => { try { draftAddAgent({ ...flowFields, installed: withSelf }); return false } catch (e) { return /already/.test(e.message) } })(), 'without its read-back request, the same name and key is a duplicate')
const resumed = othersThan(withSelf, { name: 'hr', agent: A.pk, owner: O.pk, latest: req5 })
check(resumed.length === installed.length && draftAddAgent({ ...flowFields, installed: resumed }).kind === SETUP_KIND, "with this owner's request for that name and key read back, the page carries on")
check(othersThan([...installed, { id: 'hr', pubkey: G.pk }], { name: 'hr', agent: A.pk, owner: O.pk, latest: req5 }).length === installed.length + 1, 'another key under the same name is still a duplicate')
check(othersThan([...installed, { id: 'other', pubkey: A.pk }], { name: 'hr', agent: A.pk, owner: O.pk, latest: req5 }).length === installed.length + 1, 'the same key under another name is still a duplicate')
check(othersThan(withSelf, { name: 'hr', agent: A.pk, owner: X.pk, latest: req5 }).length === withSelf.length, "a request signed by someone else proves nothing")
check(othersThan(withSelf, { name: 'hr', agent: G.pk, owner: O.pk, latest: req5 }).length === withSelf.length, 'a request for another key proves nothing')
check(typeof HANDOFF === 'string' && readFileSync(new URL('../console/hive.html', import.meta.url), 'utf8').includes('sessionStorage.setItem(HANDOFF'), 'the hive writes the handoff Same as reads')
check(/complete: !\(partial\.approvals \|\| partial\.keys\)/.test(readFileSync(new URL('../console/hive.html', import.meta.url), 'utf8')), 'and marks it short when an approval or key read was short')

// A resumed request continues the first one: nvoy refuses a newer request whose harness or starting
// agent changed, so the page refuses it before any signature and keeps step 1 as it was sent.
{
  const sent = { tags: [['d', 'nvoy-onboard/hr/add_agent'], ['harness', 'claude-code'], ['like', 'crystalclaude']] }
  check(JSON.stringify(fixedBy(sent)) === JSON.stringify({ harness: 'claude-code', like: 'crystalclaude' }) && fixedBy(null) === null, 'the sent request fixes what it runs in and the agent it starts like')
  check(changedFrom(sent, { harness: 'claude-code', like: 'crystalclaude' }) === null && changedFrom(null, { harness: 'hermes', like: 'x' }) === null, 'the same choice, or nothing sent yet, signs as before')
  check(/^Its setup was already sent, so what it runs in can't change now\./.test(changedFrom(sent, { harness: 'hermes', like: 'crystalclaude' }) || ''), 'a changed harness is refused before signing')
  check(/so the agent it starts like can't change now\./.test(changedFrom(sent, { harness: 'claude-code', like: 'mc-claude' }) || ''), 'a changed starting agent is refused too')
  check(/what it runs in and the agent it starts like can't change now\. Put them back/.test(changedFrom(sent, { harness: 'hermes', like: 'mc-claude' }) || ''), 'and both, named together')
  check(/const gap = changedFrom\(latest, \{ harness: form\.harness, like: \$\('like'\)\.value \}\)\n  if \(gap\) throw new Error\(gap\)/.test(page), 'every signature checks the continuation first')
  check(/fixed = fixedBy\(latest\)\n  if \(fixed\) \{ form\.harness = fixed\.harness; form\.like = fixed\.like/.test(page) && /like\.disabled = !!fixed/.test(page) && /b\.disabled = !!fixed && id !== fixed\.harness/.test(page), 'and step 1 stays as the request fixed it')
}

// Step 6: the fleet changes only seat givers. Hive-only givers are outside it, and the page says so.
{
  const chips = [{ pubkey: 'a', label: 'You', isOwner: true }, { pubkey: 'b', label: 'MC Claude' }, { pubkey: 'c', label: 'Dennis', outside: true }]
  check(JSON.stringify(giverPlan(chips).outside.map(c => c.label)) === '["Dennis"]', 'outside givers are those with no seat; you need no list')
  check(/\.map\(c => \(\{ \.\.\.c, outside: true \}\)\)/.test(page), 'every hive-only giver is marked outside the fleet')
  check(!/puts <span data-name><\/span> on each one's mention list/.test(page) && !/Can give it work \(/.test(page), "the page no longer says the signature puts it on everyone's list")
  check(/the fleet runs nothing for/.test(page) && /That proves what you chose, not that each one can @mention/.test(page), 'it names who the fleet runs nothing for, and read-back is not the mention proof')
}

// A giver saved in this tab that the page no longer shows is never signed unseen.
{
  const groups = [{ id: 'all', label: 'All' }], groupOf = () => 'all'
  const shown = h => [{ pubkey: O.pk, label: 'You', isOwner: true }, ...hiveChoices(h, O.pk)]
  const chosen = [O.pk, P.pk, Bz.pk]
  const before = reconcileGivers(chosen, shown(hiveHandoff))
  check(!before.gone.length, 'every saved giver is still offered: nothing to drop')
  const newer = { ...hiveHandoff, hive: hiveHandoff.hive.filter(c => c.pubkey !== Bz.pk) }
  const after = reconcileGivers(chosen, shown(newer))
  check(JSON.stringify(after.gone) === JSON.stringify([Bz.pk]) && JSON.stringify(after.kept) === JSON.stringify([O.pk, P.pk]), 'a newer hive read without Buzz Bee: its saved key is gone, the rest kept')
  check(!pickerOf(shown(newer), { chosen, groups, groupOf }).chips.some(c => c.pubkey === Bz.pk), 'and it has no chip, which is why it must not be signed')
  const other = reconcileGivers(chosen, shown({ ...hiveHandoff, owner: Bz.pk }))
  check(JSON.stringify(other.gone) === JSON.stringify([P.pk, Bz.pk]), "another owner's hive read: givers from this one are gone")
  check(goneLine([], k => k) === null && /^2 chosen earlier aren't in this hive's list now: p, b\. Nothing is signed until you drop them in step 6/.test(goneLine(['p', 'b'], k => k)), 'the page names them and how to clear them')
  check(/^One chosen earlier isn't/.test(goneLine(['p'], k => k)), 'and one, in the singular')
  check(goneLine(['p', 'b'], (k, head = 12) => `${k}:${head}`).includes('p:12, b:12'), 'each key is shortened alone, never with its index as the length')
  check(/const gone = goneLine\(reconcileGivers\(givers, choices\(\)\)\.gone, shortNpub\)\n  if \(gone\) throw new Error\(gone\)/.test(page), 'every signature refuses while a saved giver is hidden')
  check(/if \(!loaded\) throw new Error/.test(page), 'and none is checked before your agents are read')
  check(/\$\('giver-drop'\)\.onclick = \(\) => setGivers\(kept\)/.test(page) && /id="giver-gone"/.test(page), 'step 6 shows them, with one button to drop them')
}

// Every function of the flow module the page calls is imported, so none is a ReferenceError at run time.
{
  const imported = new Set(page.match(/import \{([^}]+)\} from '\.\/add-agent-flow\.mjs'/)[1].split(',').map(x => x.trim()))
  const used = Object.keys(flow).filter(k => typeof flow[k] === 'function' && new RegExp(`\\b${k}\\(`).test(page))
  const missing = used.filter(k => !imported.has(k))
  check(used.length > 5 && !missing.length, `every flow function the page calls is imported${missing.length ? `: missing ${missing.join(', ')}` : ''}`)
}

if (fails) { console.error(`\nconsole_hive_add_agent: ${fails} failing`); process.exit(1) }
console.log('\nconsole_hive_add_agent: all passed')
