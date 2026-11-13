// onboard-progress.mjs — what the fleet's runner tells the owner, and what the page reads for itself,
// in steps 3 and 4 of "Add an agent" (waggle #721, nvoy docs/ONBOARD_PHASE_B.md).
//
// The runner (`nvoy-onboard watch`) seals one receipt per setup request to the owner and signs it with
// its own Bunker-held key. The page pins that key: a receipt from any other key is not shown. A receipt
// is progress, never proof; the proofs stay what the page reads cold: the request, the writer list,
// the agent card and the agent's presence event.

import { SETUP_KIND } from './hive-add-agent.mjs'

// The runner's public key, hex (the Bunker key `nvoy-onboard`, paired on the fleet 2026-11-08; npub1l3q5dwey…x9ugnr).
// A receipt from any other key is not shown.
export const RUNNER = 'fc4146bb2407094e025ce645eda8df2d0cdea8c36b8312e8f530441049a1cd09'

export const RECEIPT_KIND = SETUP_KIND
export const receiptD = request => `nvoy-onboard:${request}`
export const WRITER_RELAY = 'wss://relay.nave.pub'
export const WRITERS_KIND = 30000
export const WRITERS_D = 'nave-relay-writers'
export const MAX_WRITERS = 1000
export const PRESENCE_D = 'nvoy-channel-presence'

const HEX64 = /^[0-9a-f]{64}$/
const ID = /^[a-z0-9][a-z0-9._-]{1,63}$/i
const SSH_TARGET = /^[a-z_][a-z0-9_-]{0,31}@[a-z0-9.-]+$/i
const HOST_KEY_TYPES = new Set(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'])
const STATES = new Set(['done', 'pending', 'refused'])
const PAIRING_URI = /^nostrconnect:\/\/[0-9a-f]{64}\?[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{1,2000}$/

const tagOf = (ev, k) => ev?.tags?.find(t => t[0] === k)?.[1]
// A plain copy, so a verification nostr-tools cached on an object edited since cannot vouch for it.
const checked = (ev, verify) => { try { return verify(JSON.parse(JSON.stringify(ev))) === true } catch { return false } }
const newestFirst = (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)
const expiredAt = (ev, nowS) => { const x = tagOf(ev, 'expiration'); return x !== undefined && !(Number(x) > nowS) }

export const receiptFilter = ({ runner, owner, request }) =>
  ({ kinds: [RECEIPT_KIND], authors: [runner], '#p': [owner], '#d': [receiptD(request)], limit: 10 })

// The newest receipt for this request: by the pinned runner, sealed to this owner, bound to this
// request by both d and e, signed, and not expired.
export function newestReceipt(events, { runner, owner, request, verify, now = Date.now() }) {
  if (!HEX64.test(runner || '')) return null
  const nowS = Math.floor(now / 1000)
  return (events || []).filter(ev => ev?.kind === RECEIPT_KIND && ev.pubkey === runner && tagOf(ev, 'd') === receiptD(request) &&
    tagOf(ev, 'p') === owner && tagOf(ev, 'e') === request && !expiredAt(ev, nowS) && checked(ev, verify)).sort(newestFirst)[0] || null
}

// The four fields of the install line, each by the installer's own rule (DESIGN_ADD_AN_AGENT, "What
// the page checks"). Exactly these four strings; anything else, or a value that fails, is refused and
// never repaired.
export function hostKeyOf(value) {
  const parts = typeof value === 'string' ? value.split(' ') : []
  if (parts.length !== 2 || !HOST_KEY_TYPES.has(parts[0]) || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) return null
  let body
  try { body = globalThis.atob(parts[1]) } catch { return null }
  const n = body.length >= 4 ? ((body.charCodeAt(0) << 24) | (body.charCodeAt(1) << 16) | (body.charCodeAt(2) << 8) | body.charCodeAt(3)) >>> 0 : 0
  return n === parts[0].length && body.slice(4, 4 + n) === parts[0] ? value : null
}
export function installFields(raw, { instance }) {
  const fail = () => { throw new Error("The fleet's install details don't pass their checks, so the page can't build the line.") }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail()
  const keys = Object.keys(raw).sort()
  if (keys.join() !== 'commit,host_key,instance,ssh_target' || keys.some(k => typeof raw[k] !== 'string')) fail()
  if (!ID.test(raw.instance) || raw.instance !== instance || !SSH_TARGET.test(raw.ssh_target) || !hostKeyOf(raw.host_key) ||
    !/^[0-9a-f]{40}$/.test(raw.commit)) fail()
  return { instance: raw.instance, ssh_target: raw.ssh_target, host_key: raw.host_key, commit: raw.commit }
}

// The opened receipt, checked as strictly as the install fields: who it is for, every step row, and the
// pairing link only in its own shape and only while it is still good.
export function openedReceipt(text, { name, request, now = Date.now() }) {
  let body
  try { body = JSON.parse(text) } catch { throw new Error("The fleet's receipt doesn't open as JSON.") }
  if (!body || body.v !== 1 || body.name !== name || body.request !== request || body.instance !== name) throw new Error("The fleet's receipt is for another request.")
  if (!Array.isArray(body.steps) || body.steps.length > 32) throw new Error("The fleet's receipt has no step list.")
  const steps = new Map()
  for (const s of body.steps) {
    if (!s || typeof s.step !== 'string' || s.step.length > 32 || !STATES.has(s.state) || typeof s.detail !== 'string') throw new Error("A step in the fleet's receipt is malformed.")
    steps.set(s.step, { state: s.state, detail: s.detail.slice(0, 300), at: Number.isFinite(s.at) ? s.at : null })
  }
  let pairing = null
  const p = body.pairing
  if (p !== undefined) {
    if (!p || typeof p.uri !== 'string' || !PAIRING_URI.test(p.uri) || !Number.isFinite(p.expires_at)) throw new Error("The pairing link in the fleet's receipt is malformed.")
    if (p.expires_at * 1000 > now && steps.get('paired')?.state !== 'done') pairing = { uri: p.uri, expiresAt: p.expires_at }
  }
  return { steps, pairing, install: body.install === undefined ? null : installFields(body.install, { instance: name }) }
}

// Step 3's rows from the fleet's receipt. The page's own read-backs (request, writer list, card) are
// added by the page; a row the receipt does not mention is "not started yet", never done.
export const TOOL_ROWS = Object.freeze([
  ['staged', 'Its own space on the server', 'a user and ports no other agent shares'],
  ['paired', 'Its signing connection', 'your Bunker answers as {name}'],
  ['checked', 'Its listener and post box', 'hears its rooms, posts as {name}'],
])
export function stepRow(opened, step) {
  const s = opened?.steps.get(step)
  if (!s) return { ok: false, state: opened ? 'Not started yet' : '' }
  return { ok: s.state === 'done', refused: s.state === 'refused', state: `${s.state === 'done' ? 'Done' : s.state === 'refused' ? 'Refused' : 'Waiting'}: ${s.detail}` }
}

// How old the newest receipt is: the runner republishes an unchanged one every 10 minutes, so one
// older than about two of those says the runner has stopped.
export const RUNNER_QUIET_S = 25 * 60
export const runnerQuiet = (receipt, now = Date.now()) => !!receipt && Math.floor(now / 1000) - receipt.created_at > RUNNER_QUIET_S

// The install line (DESIGN_ADD_AN_AGENT, "What runs"): nvoy at the pinned commit, its locked
// dependencies, then box-install.mjs from that checkout. Never a download piped into a shell. Every
// value is one single-quoted argument, and the rules above have already shut out quotes and spaces.
export const NVOY_REPO = 'https://github.com/JAFairweather/nvoy.git'
export function installLine(fields) {
  const f = installFields(fields, { instance: fields?.instance })
  const q = v => `'${v}'`
  return [
    `d="$HOME/.nvoy-box/src"`,
    `{ [ -d "$d/.git" ] || git clone -q ${q(NVOY_REPO)} "$d"; }`,
    `git -C "$d" fetch -q origin ${q(f.commit)}`,
    `git -C "$d" -c advice.detachedHead=false checkout -q --detach ${q(f.commit)}`,
    `npm --prefix "$d/mcp" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error`,
    `node "$d/mcp/tools/box-install.mjs" --instance ${q(f.instance)} --ssh-target ${q(f.ssh_target)} --host-key ${q(f.host_key)} --start`,
  ].join(' && ')
}

// The relay's writer list (nave.pub #157). The owner's newest signed list on the writer relay; each
// list replaces the last, so the page signs the whole set every time and never from a partial read.
export const writersFilter = owner => ({ kinds: [WRITERS_KIND], authors: [owner], '#d': [WRITERS_D], limit: 20 })
export function writersNow(events, { owner, verify }) {
  const list = (events || []).filter(ev => ev?.kind === WRITERS_KIND && ev.pubkey === owner &&
    ev.tags.filter(t => t[0] === 'd').map(t => t[1]).join() === WRITERS_D && checked(ev, verify)).sort(newestFirst)[0] || null
  return { list, keys: list ? [...new Set(list.tags.filter(t => t[0] === 'p' && HEX64.test(t[1] || '')).map(t => t[1]))] : [] }
}
export function writersPlan(read, { owner, agent, verify }) {
  if (!read || read.state !== 'complete') return { state: 'unread', text: "The writer relay didn't answer in full, so the list isn't known. Nothing is signed from a partial read." }
  const { list, keys } = writersNow(read.events, { owner, verify })
  if (keys.includes(agent)) return { state: 'listed', list, keys }
  if (keys.length + 1 > MAX_WRITERS) return { state: 'full', text: `The writer list already holds ${keys.length} keys, the most the relay takes.` }
  return { state: 'missing', list, keys: [...keys, agent] }
}
export function draftWriters(keys, { now = Math.floor(Date.now() / 1000), after = 0 } = {}) {
  if (!keys.length || keys.some(k => !HEX64.test(k))) throw new Error('A writer is not a public key.')
  // Newer than the list it replaces, or the relay keeps the old one.
  return { kind: WRITERS_KIND, created_at: Math.max(now, after + 1), content: '', tags: [['d', WRITERS_D], ...[...new Set(keys)].map(k => ['p', k])] }
}

// Step 4's proof (DESIGN_ADD_AN_AGENT, "Proof: a signed presence event"): the fingerprint of the key
// the owner pasted, computed here, and the agent's own presence event naming it as connected.
export async function fingerprint(channelKey) {
  const m = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(String(channelKey || '').trim())
  if (!m) return null
  // A body that isn't valid base64 (a fleet row or a paste such as 'ssh-ed25519 A') has no fingerprint:
  // null, never a throw, so the step that reads it redraws and says so.
  let bytes
  try { bytes = Uint8Array.from(globalThis.atob(m[1]), c => c.charCodeAt(0)) } catch { return null }
  const sum = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  return 'SHA256:' + globalThis.btoa(String.fromCharCode(...sum)).replace(/=+$/, '')
}
// A hosted agent's channel key, as the fleet reports it (#735 B2; nvoy ONBOARD_PHASE_B, `channel_key`). The
// key is made on the agent's herd-cloud login, and a reviewed helper stages its public half for the runner,
// which reports it in a `channel_key` row: `<type> <key> (SHA256:<fingerprint>), staged for the owner to
// bind`. That is reported work, never proof: the owner's bind is the act, and the presence event stays the
// proof. The page offers the key only in exactly that shape, for an ssh-ed25519 key, and only when the
// fingerprint it computes from the key itself matches the one the row states. Any other row is not offered,
// and a refused row is shown with the fleet's own words. `step` is 'feed_key' for a Pi or Codex wake feed.
const REPORTED = /^(ssh-ed25519) ([A-Za-z0-9+/]+={0,2}) \((SHA256:[A-Za-z0-9+/]{43})\)(, staged for the owner to bind)?$/
export async function reportedKey(opened, step = 'channel_key') {
  const s = opened?.steps?.get(step)
  if (!s) return { state: opened ? 'none' : 'unread' }
  if (s.state === 'refused') return { state: 'refused', text: s.detail }
  if (s.state !== 'done') return { state: 'pending', text: s.detail }
  const m = REPORTED.exec(s.detail)
  if (!m) return { state: 'malformed' }
  const key = `${m[1]} ${m[2]}`
  const fp = await fingerprint(key)
  return fp && fp === m[3] ? { state: 'reported', key, fingerprint: fp } : { state: 'malformed' }
}
// What step 4 says about that report, in the "the fleet says" voice: never "verified", never done.
export function reportedLine(r, name) {
  if (!r || r.state === 'unread') return 'Not read by this page yet'
  if (r.state === 'none') return `Waiting for the fleet: it hasn't reported ${name}'s channel key yet`
  if (r.state === 'pending') return `Waiting for the fleet: ${r.text}`
  if (r.state === 'refused') return `The fleet refused the staged key: ${r.text}`
  if (r.state === 'malformed') return "The fleet's report of the key doesn't pass the page's checks, so it isn't offered"
  return `Reported by the fleet: its channel key ${r.fingerprint}`
}

export const presenceFilter = agent => ({ kinds: [SETUP_KIND], authors: [agent], '#d': [PRESENCE_D], limit: 5 })
// `since` is the bind time in seconds. Without a finite, positive one there is nothing to be newer than,
// so no presence can be green: an unknown bind time never lets an old signed presence stand in for it.
export function presenceRow(events, { agent, instance, key, since = null, verify, now = Date.now() }) {
  const nowS = Math.floor(now / 1000)
  const ev = (events || []).filter(e => e?.kind === SETUP_KIND && e.pubkey === agent && tagOf(e, 'd') === PRESENCE_D && checked(e, verify)).sort(newestFirst)[0]
  if (!key) return { ok: false, state: 'Paste the key the line printed to check this' }
  if (!ev) return { ok: false, state: 'Waiting for the fleet: no presence from it yet' }
  let body = null
  try { body = JSON.parse(ev.content) } catch {}
  if (!body || body.instance !== instance || typeof body.key !== 'string') return { ok: false, state: 'Its presence event is malformed' }
  if (body.key !== key) return { ok: false, state: 'Connected with a different key from the one pasted here' }
  if (expiredAt(ev, nowS) || tagOf(ev, 'expiration') === undefined) return { ok: false, state: 'Connected before, not now' }
  if (!Number.isFinite(since) || since <= 0) return { ok: false, state: 'Waiting for the fleet: the bind time is not in its receipt yet' }
  if (ev.created_at < since) return { ok: false, state: 'Waiting for the fleet: its presence is older than the bind' }
  return body.connected === true ? { ok: true, state: 'Read back: connected with this key' } : { ok: false, state: 'Connected before, not now' }
}
