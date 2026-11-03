// #649 / nvoy #289 — the setup requests behind "Add an agent".
//
//  1. add_agent carries only the closed set of public tags nvoy-onboard accepts, in its shape.
//  2. What the fleet would refuse is refused here before the owner is asked to sign.
//  3. bind_runtime carries the public channel key only; a private one never reaches a draft.
//  4. Sending refuses an edited or foreign-key event before anything is published, and a relay OK
//     is reported as "sent", never as done.
//
//   node tests/console_hive_add_agent.mjs

import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { agentName, draftAddAgent, draftBind, requestD, sendRequest, SETUP_KIND } from '../console/hive-add-agent.mjs'

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

// ── 4. Sending ──────────────────────────────────────────────────────────────────────────────────
const relays = ['wss://a.example', 'wss://b.example']
const sockets = []
const connect = url => { const ws = { url, sent: [], close() {}, send(data) { this.sent.push(JSON.parse(data)); const ev = this.sent[0][1]; setTimeout(() => this.onmessage({ data: JSON.stringify(['OK', ev.id, url.includes('a.'), url.includes('a.') ? '' : 'blocked']) }), 0) } }; sockets.push(ws); setTimeout(() => ws.onopen(), 0); return ws }
const opts = { owner: O.pk, verify: verifyEvent, connect, relays, timeoutMs: 500 }
const sent = await sendRequest(add, { ...opts, sign: async t => finalizeEvent(t, O.sk) })
check(sent.accepted === 1 && /^Sent\. 1 of 2 relays have it \(a\.example\)\.$/.test(sent.text), 'a relay OK is "sent", never "done"')
let error = ''
const before = sockets.length
try { await sendRequest(add, { ...opts, sign: async t => finalizeEvent({ ...t, tags: [...t.tags, ['giver', X.pk]] }, O.sk) }) } catch (e) { error = e.message }
check(/not the one shown/.test(error) && sockets.length === before, 'an edited event is refused, nothing published')
error = ''
try { await sendRequest(add, { ...opts, sign: async t => finalizeEvent(t, X.sk) }) } catch (e) { error = e.message }
check(/different key/.test(error) && sockets.length === before, 'a foreign signer is refused, nothing published')

if (fails) { console.error(`\nconsole_hive_add_agent: ${fails} failing`); process.exit(1) }
console.log('\nconsole_hive_add_agent: all passed')
