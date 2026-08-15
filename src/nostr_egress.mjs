// src/nostr_egress.mjs — the Nostr-transport chokepoint (#134 A3 §2.5).
//
// The sibling of egress.mjs, and the reason INV-A3-2 can be stated at all. There are TWO egress
// transports, not one: the Buzz CLI signs kind:9 with BUZZ_PRIVATE_KEY, and this path signs
// NIP-59 envelopes with the bridge's own key IN-PROCESS. A ban that only watched the CLI was
// structurally blind to this half — it never spells `buzz` at all.
//
// Same shape as the Buzz chokepoint, second transport: one signing verb over a CLOSED set of
// envelope kinds (kind:13 seal, kind:1059 wrap) and a closed catalogue of bodies. No caller may
// hand it a free string either.
//
// This module also owns the identity CAPABILITY. The local key or remote Bunker connection lives
// one layer lower in nostr_signer.mjs; no caller can reach that backend directly. Callers get only:
// `bridgePubkey()`, `hasBridgeKey()`, `openSealed()`, `sealAndWrap()`.
//
// INV-A3-2  exactly one function per transport invokes a signer. This is the Nostr one.
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { loadNostrSigner } from './nostr_signer.mjs'
import { isConsentState } from './consent_state.mjs'   // the one consent vocabulary (#389)
import { createHash, randomBytes } from 'node:crypto'
import { mineAsync } from './pow.mjs'

// --- The key, held here and nowhere else ------------------------------------------------------
const BRIDGE_SIGNER = loadNostrSigner()
const BRIDGE_PK = BRIDGE_SIGNER?.pubkey || null

// The PUBLIC key is safe to hand out and is needed all over bridge.mjs for REQ filters and
// self-comparison. The secret never leaves this module.
export const bridgePubkey = () => BRIDGE_PK
export const hasBridgeKey = () => !!BRIDGE_SIGNER
export const bridgeSignerMode = () => !BRIDGE_SIGNER ? 'none' : BRIDGE_SIGNER.remote ? 'nip46' : 'local'

async function signExact(template, label) {
  if (!BRIDGE_SIGNER || !BRIDGE_PK) reject(`no bridge signer for ${label}`)
  const event = JSON.parse(JSON.stringify(await BRIDGE_SIGNER.signEvent(template)))
  let valid = false
  try { valid = verifyEvent(event) } catch { valid = false }
  if (!valid || event.pubkey !== BRIDGE_PK || event.kind !== template.kind ||
      event.created_at !== template.created_at || event.content !== template.content ||
      JSON.stringify(event.tags) !== JSON.stringify(template.tags)) reject(`bridge signer changed or invalidated ${label}`)
  return event
}

const configuredBuzzAuthTag = () => {
  const raw = String(process.env.BUZZ_AUTH_TAG || '').trim()
  if (!raw) return null
  let tag
  try { tag = JSON.parse(raw) } catch { reject('BUZZ_AUTH_TAG is not JSON') }
  if (!Array.isArray(tag) || tag.length !== 4 || tag[0] !== 'auth' || !tag.every(v => typeof v === 'string')) reject('BUZZ_AUTH_TAG is not one exact auth tag')
  return tag
}

// Closed kind:7 transaction for the return-lane acknowledgement. Preparation and submission are
// deliberately separate capabilities: bridge.mjs durably stores the exact signed event and its
// tripwire row between them. A restart therefore retries identical bytes, never re-signs.
export async function prepareRelayActionReaction(targetId, now = Math.floor(Date.now() / 1000)) {
  const target = hex64(targetId, 'reaction target')
  const auth = configuredBuzzAuthTag()
  return signExact({ kind: 7, created_at: Math.floor(num(now, 'reaction created_at')),
    tags: [...(auth ? [auth] : []), ['e', target]], content: '👍' }, 'relay action reaction')
}

function exactPreparedReaction(event) {
  const wire = JSON.parse(JSON.stringify(event))
  let valid = false
  try { valid = verifyEvent(wire) } catch { valid = false }
  const auth = configuredBuzzAuthTag()
  const expectedTags = [...(auth ? [auth] : []), ['e', wire.tags?.find(t => t[0] === 'e')?.[1]]]
  if (!valid || wire.pubkey !== BRIDGE_PK || wire.kind !== 7 || wire.content !== '👍' ||
      Object.keys(wire).sort().join(',') !== 'content,created_at,id,kind,pubkey,sig,tags' ||
      !/^[0-9a-f]{64}$/.test(String(expectedTags.at(-1)?.[1] || '')) || JSON.stringify(wire.tags) !== JSON.stringify(expectedTags)) {
    reject('prepared relay action reaction is invalid or outside the closed template')
  }
  return wire
}

export async function submitRelayActionReaction(prepared, fetchImpl = globalThis.fetch) {
  const event = exactPreparedReaction(prepared)
  let endpoint
  // A Nostr relay URL is commonly wss:// and is not necessarily the Buzz event API. Keep the
  // write authority on a separately named, fixed HTTPS origin; accept the historical variable
  // only when it already names an HTTP(S) API so existing deployments do not break silently.
  const endpointBase = String(process.env.BUZZ_EVENT_ENDPOINT || process.env.BUZZ_RELAY_URL || 'http://localhost:3000')
  try { endpoint = new URL('/events', endpointBase) } catch { reject('BUZZ_EVENT_ENDPOINT is invalid') }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname)))) reject('Buzz event endpoint must be HTTPS or loopback HTTP')
  const body = JSON.stringify(event)
  const auth = await signExact({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [
    ['u', endpoint.toString()], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')],
    ['nonce', randomBytes(24).toString('base64url')],
  ] }, 'relay action NIP-98 authorization')
  const headers = { authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}`, 'content-type': 'application/json' }
  const authTag = configuredBuzzAuthTag()
  if (authTag) headers['x-auth-tag'] = JSON.stringify(authTag)
  let response
  try { response = await fetchImpl(endpoint, { method: 'POST', redirect: 'manual', signal: globalThis.AbortSignal.timeout(30_000), headers, body }) }
  catch (e) { throw new Error(`Buzz reaction submission outcome unknown: ${e?.name || 'network error'}`) }
  const text = await response.text()
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Buzz reaction response exceeded 64 KiB')
  if (!response.ok) throw new Error(`Buzz reaction submission failed HTTP ${response.status}`)
  let result
  try { result = JSON.parse(text) } catch { throw new Error('Buzz reaction response was not JSON') }
  if (result?.event_id !== event.id || result?.accepted !== true) throw new Error('Buzz reaction response did not accept the exact prepared event')
  return event.id
}

// NIP-78 application data. This is deliberately an addressable event: consumers ask for the
// latest `d=waggle-control-state` record from THIS bridge key, never try to infer operational
// truth from a stale cache or from an unverified web page.
export const CONTROL_STATE_KIND = 30078

// --- The catalogue of things waggle may say on this transport ---------------------------------
//
// Its bodies are machine JSON and one carried mention today, which is why §2.5 rates this lower
// urgency than the Buzz half — but "lower urgency" is not "optional": nothing structural stopped
// a future caller putting a sentence in an ack, and a second signer path is exactly how the Buzz
// side got into this state.
const reject = (why) => { throw new Error(`nostr-egress: ${why}`) }

const hex64 = (v, what) => {
  const s = String(v == null ? '' : v).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(s)) reject(`${what} is not a 64-hex id: ${JSON.stringify(String(v).slice(0, 24))}`)
  return s
}
const num = (v, what) => { const n = Number(v); if (!Number.isFinite(n)) reject(`${what} is not a number`); return n }
// Sanitises, does not reject — same reasoning as egress.mjs's `handle`, and the same incident.
// `return_carry.mention` is fed `r.mention` from return-lane config (bridge.mjs:1270), so a
// recipient configured with a spaced Buzz name would throw mid-carry. Milder than the Buzz side
// (rlSeen is rolled back, so a restart re-carries) but it still aborts the carry loop, taking
// every LATER recipient in that scan down with it.
//
// Kept as its own copy rather than imported from egress.mjs on purpose: this module owns the
// Nostr transport and must not depend on the Buzz one. That duplication is why the bug existed in
// two places at once — so if a third appears, the escapers should move to a shared module that
// neither transport owns.
const handle = (v) => {
  const s = String(v == null ? '' : v)
    .replace(/[`\r\n]/g, '')
    .replace(/[@[\]()*~]/g, '')   // `_` kept — legitimate in a handle, see egress.mjs
    .trim()
    .slice(0, 64)
  if (!s) reject(`handle empty after sanitising: ${JSON.stringify(String(v).slice(0, 32))}`)
  return s
}
// The community's own words, carried out to a guest. Untrusted in the same sense as the Buzz
// side's carried_body: quoted, never rendered as waggle's own voice.
const carried = (v) => String(v == null ? '' : v)

const url = (v, what) => {
  const s = String(v == null ? '' : v).trim()
  let u; try { u = new URL(s) } catch { reject(`${what} is not a URL: ${JSON.stringify(s.slice(0, 48))}`) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') reject(`${what} must be http(s): ${JSON.stringify(s.slice(0, 48))}`)
  return s
}

// A public control-plane record is *not* another general-purpose signing primitive.  Its schema
// lives beside the key and is closed: callers can report the bridge's own observed state, but
// cannot turn a status publisher into a public-prose or arbitrary-event sender (#67 / #134).
const controlState = (v) => {
  const s = (v && typeof v === 'object') ? v : reject('control state is not an object')
  if (s.v !== 1) reject('control state version must be 1')
  const observedAt = Math.floor(num(s.observed_at, 'control state observed_at'))
  if (observedAt <= 0) reject('control state observed_at must be positive')
  const hive = (s.hive && typeof s.hive === 'object') ? s.hive : reject('control state hive is missing')
  const hiveId = hex64(hive.id, 'control state hive.id')
  const hiveName = handle(hive.name)
  const hiveHandle = String(hive.handle == null ? '' : hive.handle).replace(/[\r\n`]/g, '').trim().slice(0, 128)
  if (!hiveHandle) reject('control state hive.handle empty')
  const follows = Array.isArray(s.follows) ? s.follows : reject('control state follows is not an array')
  if (follows.length > 1000) reject('control state has too many follows')
  // The vocabulary is IMPORTED, not restated (#389). A word the projection can emit and this schema
  // rejects fails closed after signing, on a record nobody looks at until the console renders blank —
  // and the two lists sat far enough apart that a fifth state would have been added to one of them.
  const seen = new Set()
  const cleaned = follows.map((f) => {
    if (!f || typeof f !== 'object') reject('control state follow is not an object')
    const pubkey = hex64(f.pubkey, 'control state follow.pubkey')
    if (seen.has(pubkey)) reject('control state has duplicate follow')
    seen.add(pubkey)
    const consent = String(f.consent || '')
    if (!isConsentState(consent)) reject('control state follow.consent is invalid')
    return { pubkey, consent }
  }).sort((a, b) => a.pubkey.localeCompare(b.pubkey))
  if (typeof s.publishing !== 'boolean') reject('control state publishing is not boolean')
  // Per-agent lifecycle rows (#309). Additive exactly like `operations` below: absent means omitted,
  // so records signed before this field remain valid. The projection in bridge.mjs already
  // re-derives and shape-checks each field; it is checked AGAIN here because this schema sits beside
  // the key and is the last thing between a caller and a signed public artifact. Two checks that
  // fail independently are the point — one of them being right is not the same as both being right.
  //
  // This field was omitted when the console screen landed, and because the schema REBUILDS the
  // object from an exact field list rather than rejecting unknown keys, `agents` was silently
  // stripped on every publish while the console rendered "no agents admitted" and looked fine.
  const agentStatuses = new Set(['admitted', 'paused', 'revoked'])
  let agents = null
  if (s.agents != null) {
    const rows = Array.isArray(s.agents) ? s.agents : reject('control state agents is not an array')
    if (rows.length > 1000) reject('control state has too many agents')
    const seenAgents = new Set()
    agents = rows.map((a) => {
      if (!a || typeof a !== 'object') reject('control state agent is not an object')
      if (Object.keys(a).sort().join(',') !== 'label,pubkey,return_lane,status') reject('control state agent has unexpected fields')
      const pubkey = hex64(a.pubkey, 'control state agent.pubkey')
      if (seenAgents.has(pubkey)) reject('control state has duplicate agent')
      seenAgents.add(pubkey)
      if (!agentStatuses.has(String(a.status))) reject('control state agent.status is invalid')
      if (typeof a.return_lane !== 'boolean') reject('control state agent.return_lane is not boolean')
      let label = null
      if (a.label != null) {
        if (typeof a.label !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(a.label)) reject('control state agent.label is invalid')
        // A label is free owner-supplied text on its way into a SIGNED, WORLD-READABLE record, and
        // the shape check above cannot tell prose from a credential — a bech32 nsec is 63 printable
        // ASCII characters and passes it cleanly. The realistic vector is an owner mis-pasting into
        // the label field, so refuse the paste rather than publish it.
        // Declared here rather than imported from agent_lifecycle.mjs on purpose: this schema sits
        // beside the key and is the last independent check before signing. tests/agent_lifecycle.mjs
        // asserts it agrees with the catalogue's copy and the console's, so independence does not
        // become drift. Bare 64-hex included — private keys live as raw hex in env vars in this
        // stack, and no bare hex string is a legitimate display label.
        if (/nsec1|ncryptsec1|bunker:|^[0-9a-f]{64}$/i.test(a.label)) reject('control state agent.label looks like a credential')
        label = a.label
      }
      return { pubkey, status: String(a.status), label, return_lane: a.return_lane }
    }).sort((x, y) => x.pubkey.localeCompare(y.pubkey))
  }
  const withAgents = agents === null ? {} : { agents }
  // v1 originally carried just hive/bridge/publishing/follows. Operations was added as an
  // additive v1 summary, so old signed records must remain valid rather than being rewritten
  // under a fictional v2 contract.
  if (s.operations == null) return { v: 1, observed_at: observedAt, hive: { id: hiveId, name: hiveName, handle: hiveHandle }, bridge: hex64(s.bridge, 'control state bridge'), publishing: s.publishing, follows: cleaned, ...withAgents }
  const operations = (typeof s.operations === 'object') ? s.operations : reject('control state operations is invalid')
  const exact = (obj, keys, label) => { if (Object.keys(obj).sort().join(',') !== keys.slice().sort().join(',')) reject(`${label} has unexpected fields`) }
  const count = (value, label) => { const n = Math.floor(num(value, label)); if (n < 0 || n > 1000000) reject(`${label} out of bounds`); return n }
  // `consent_asks` is OPTIONAL, exactly like `agents` above: a bridge that has not been updated
  // signs without it, and that record must stay valid rather than being rejected by a newer console.
  exact(operations, operations.consent_asks == null
    ? ['trust', 'lanes', 'gates', 'drops']
    : ['trust', 'lanes', 'gates', 'drops', 'consent_asks'], 'control state operations')
  const trust = (operations.trust && typeof operations.trust === 'object') ? operations.trust : reject('control state trust is missing')
  exact(trust, ['trusted_repliers', 'muted_authors', 'watched_notes'], 'control state trust')
  const lanes = (operations.lanes && typeof operations.lanes === 'object') ? operations.lanes : reject('control state lanes is missing')
  exact(lanes, ['public_read', 'sealed', 'return_watch', 'relay_ingress'], 'control state lanes')
  if (!Object.values(lanes).every(x => typeof x === 'boolean')) reject('control state lanes are not booleans')
  const gates = (operations.gates && typeof operations.gates === 'object') ? operations.gates : reject('control state gates is missing')
  exact(gates, ['consent_required', 'ask_per_hour', 'public_content_bytes', 'public_replier_per_min', 'public_channel_per_min', 'public_lane_per_hour'], 'control state gates')
  if (typeof gates.consent_required !== 'boolean') reject('control state consent_required is not boolean')
  const drops = (operations.drops && typeof operations.drops === 'object') ? operations.drops : reject('control state drops is missing')
  exact(drops, ['relay_preauth', 'relay_not_relay'], 'control state drops')
  // The consent-ask budget (#331). Bounded counters, rebuilt field by field like everything else
  // here — the owner acts on this number, so a caller cannot smuggle prose through it.
  let consentAsks = null
  if (operations.consent_asks != null) {
    const a = (typeof operations.consent_asks === 'object') ? operations.consent_asks : reject('control state consent_asks is invalid')
    exact(a, ['per_hour', 'used_this_window', 'remaining', 'window_resets_in'], 'control state consent_asks')
    const perHour = count(a.per_hour, 'consent_asks.per_hour')
    const used = count(a.used_this_window, 'consent_asks.used_this_window')
    const remaining = count(a.remaining, 'consent_asks.remaining')
    // A budget that does not add up is worse than none: it would tell the owner asks are available
    // when the next one will be refused. Refuse to sign it rather than publish a number that lies.
    if (used > perHour || remaining > perHour || used + remaining !== perHour) reject('control state consent_asks does not add up')
    consentAsks = { per_hour: perHour, used_this_window: used, remaining, window_resets_in: count(a.window_resets_in, 'consent_asks.window_resets_in') }
  }
  return { v: 1, observed_at: observedAt, hive: { id: hiveId, name: hiveName, handle: hiveHandle }, bridge: hex64(s.bridge, 'control state bridge'), publishing: s.publishing, follows: cleaned, ...withAgents,
    operations: { trust: { trusted_repliers: count(trust.trusted_repliers, 'trusted_repliers'), muted_authors: count(trust.muted_authors, 'muted_authors'), watched_notes: count(trust.watched_notes, 'watched_notes') }, lanes,
      gates: { consent_required: gates.consent_required, ask_per_hour: count(gates.ask_per_hour, 'ask_per_hour'), public_content_bytes: count(gates.public_content_bytes, 'public_content_bytes'), public_replier_per_min: count(gates.public_replier_per_min, 'public_replier_per_min'), public_channel_per_min: count(gates.public_channel_per_min, 'public_channel_per_min'), public_lane_per_hour: count(gates.public_lane_per_hour, 'public_lane_per_hour') },
      drops: { relay_preauth: count(drops.relay_preauth, 'relay_preauth'), relay_not_relay: count(drops.relay_not_relay, 'relay_not_relay') },
      ...(consentAsks ? { consent_asks: consentAsks } : {}) } }
}

// The sole public-event capability held by bridge.mjs.  The body and tags are fixed by the
// validator above; a caller supplies state, never event shape, kind, tags, or arbitrary content.
export async function signControlState(state) {
  if (!BRIDGE_SIGNER || !BRIDGE_PK) reject('no bridge signer to sign control state')
  const checked = controlState(state)
  return signExact({
    kind: CONTROL_STATE_KIND,
    created_at: checked.observed_at,
    tags: [['d', 'waggle-control-state'], ['h', checked.hive.id], ['v', '1']],
    content: JSON.stringify(checked),
  }, 'control state')
}

// --- In-door consent (docs/CONSENT.md §5/§7) --------------------------------------------------
//
// THE CANONICAL ToS BLOCK, verbatim (Kerouac, §7). It is a SOURCE LITERAL, never a caller slot,
// because its sha256 is the `tos` hash the consent 440 binds to (§7): if any caller could vary the
// wording, the hash would not mean "these exact terms". The only fills are {COMMUNITY} and
// {TERMS_URL}, both INSIDE the hash on purpose (a different community's terms yield a different hash
// by construction), and the literal `v1` marker so a wording revision is a new hash, never silent.
// Exported so bridge.mjs computes `expectedTosHash` from this SAME producer — one canonicalization,
// three consumers (the block shown, the prefilled 440's `tos` tag, the bridge's expected hash).
export function consentTosBlock({ hiveId, hiveName, hiveHandle, termsUrl }) {
  const id = hex64(hiveId, 'hiveId')
  const name = handle(hiveName)
  // A hive handle is explanatory text, not an executable address. Keep its familiar `@` rather
  // than running it through `handle()` (which intentionally removes markup punctuation).
  const h = String(hiveHandle == null ? '' : hiveHandle).replace(/[\r\n`]/g, '').trim().slice(0, 128)
  if (!h) reject('hiveHandle empty')
  const terms = url(termsUrl, 'termsUrl')
  return [
    `**waggle — mirror consent (v1)**`,
    ``,
    `Hello from waggle. ${name}'s hive (${h}) would love to share your public wisdom in its meadow — with the bees already in the hive. Nothing crosses unless you say yes.`,
    ``,
    `1. **What happens.** Your public Nostr content would be reposted into ${name} (${h}) — a private, invite-walled Buzz hive you are not a member of.`,
    `2. **Who sees it.** Only members of ${name}, inside their space, under that hive's own terms (${terms}).`,
    `3. **How it's posted, honestly.** Today the mirror reposts your content under the bridge's own key, attributed to you — not as your own signed event. Until that limitation is fixed, moderation and the platform's content license attach to the operator's copy, not to you.`,
    `4. **Your public self is untouched.** Your notes stay yours on the open network. This covers only the mirrored copy inside ${name}; it does not change, claim, or move your originals.`,
    `5. **You can stop it anytime.** Revoke and no new content crosses — a \`441\`, or ask the operator / use the console. Content already seen can't be un-seen; that's physics, not a permission you're giving.`,
    ``,
    `**The boundary.** Your consent is for this one hive, not for one chat channel: \`community_id:${id}\`. The director may route a consented feed to one or more channels inside this hive; moving it between those channels does not widen your consent.`,
    ``,
    `**To agree:** return a signed \`440\` naming waggle, capability \`mirror\`, scoped to this hive, carrying the hash of these terms. **To decline:** ignore this — silence is a no, and you won't be asked again. An explicit no is honored permanently.`,
    ``,
    `Nothing of yours crosses until you say yes.`,
  ].join('\n')
}

// The unsigned 440 the participant signs. It is validated before being put in a fragment-only
// link to Nvoy's signer page, so the disclosure can only ever ask them to sign a mirror-consent
// grant to THIS bridge — never an arbitrary event dressed as "sign this".
const prefill440 = (v) => {
  const ev = (v && typeof v === 'object') ? v : reject('prefill is not an object')
  if (ev.kind !== 440) reject('prefill is not a 440')
  const tag = (k) => (ev.tags || []).find(t => t[0] === k)
  if (tag('da-cap')?.[1] !== 'mirror') reject('prefill is not a mirror capability')
  if (!tag('p')?.[1]) reject('prefill names no grantee')
  if (!tag('da-scope')) reject('prefill has no scope')
  if (!tag('tos')?.[1]) reject('prefill carries no tos hash')
  if (ev.sig) reject('prefill must be UNSIGNED — the participant supplies the signature')
  return JSON.stringify(ev)
}

const consentLink = ({ consentUrl, hiveId, hiveName, hiveHandle, termsUrl, prefill }) => {
  const base = url(consentUrl, 'consentUrl')
  const checked = JSON.parse(prefill440(prefill))
  const request = { hiveId: hex64(hiveId, 'hiveId'), hiveName: handle(hiveName), hiveHandle: String(hiveHandle).replace(/[\r\n`]/g, '').trim(), termsUrl: url(termsUrl, 'termsUrl'), prefill: checked }
  if (!request.hiveHandle) reject('hiveHandle empty')
  const out = new URL(base)
  // A fragment never reaches Pages, HTTP logs, or a Referer header. It holds no secret, but keeps
  // this unsigned draft out of routine server logs all the same.
  out.hash = `request=${Buffer.from(JSON.stringify(request)).toString('base64url')}`
  return out.toString()
}

const CATALOGUE = {
  // Relay-lane acks. Typed JSON, never prose — a caller picks ok/err and supplies fields.
  relay_ack_ok: {
    build: ({ channel, buzzEventId, ts }) => JSON.stringify({
      ok: true,
      channel: String(channel),
      buzz_event_id: buzzEventId ? hex64(buzzEventId, 'buzzEventId') : null,
      ts: num(ts, 'ts'),
    }),
  },
  relay_ack_err: {
    // `reason` is a closed set, not a message. An ack that could carry an arbitrary reason string
    // is a free-text path wearing a JSON hat — and one of these already WAS composed at the call
    // site (`over ${PUB.maxContentBytes}B cap`, interpolating config into the wire).
    //
    // The rendered strings below are byte-identical to what the lane sent before #134: A3 changes
    // what waggle CAN say, never what crosses. A granted participant's client parsing `reason`
    // sees exactly what it saw yesterday.
    reasons: {
      'channel not allowlisted': () => 'channel not allowlisted',
      'not admitted': () => 'not admitted',
      'empty body': () => 'empty body',
      'rate cap': () => 'rate cap',
      'over cap': ({ cap }) => `over ${num(cap, 'cap')}B cap`,
      // Buzz refused the post and declared it non-retryable, so waggle stopped rather than
      // replaying it forever. Deliberately says only THAT it was refused, never why: Buzz's
      // message is platform free text and the whole point of this table is that no free text
      // reaches the wire. The reason is in the journal and the undelivered record.
      'refused by buzz': () => 'refused by buzz',
    },
    build: ({ reason, channel, ts, cap }, spec) => {
      const render = spec.reasons[reason]
      if (!render) reject(`ack reason not in {${Object.keys(spec.reasons).join('|')}}: ${JSON.stringify(reason)}`)
      return JSON.stringify({
        ok: false,
        reason: render({ cap }),
        channel: channel == null ? null : String(channel),
        ts: num(ts, 'ts'),
      })
    },
  },
  // The return lane's actual product: a community message carried out to a guest the community
  // relay will not serve. The prose is here; the caller supplies who, why, and the body.
  return_carry: {
    // #508. `alert` is a THIRD reason and not a variant of the other two: nobody addressed this
    // agent — it subscribed to a tag and the tag was raised. Saying "you were mentioned" for one
    // would be the template asserting something that did not happen, which is the failure this
    // allowlist exists to prevent. Which tag fired is not carried here: the slot is an allowlisted
    // token so that a value from the channel can never reach the rendered prose, and the body the
    // agent receives holds the hashtag anyway.
    whys: ['mention', 'reply', 'alert'],
    // `author` is the pubkey of whoever wrote the carried message (#352). Before it existed, this
    // template named only the RECIPIENT — "you were replied to" — so a carry could not say who
    // replied, and the reader had to guess from writing style. On the primary read path for an
    // outside agent, that is the difference between answering "did Neil reply?" and not.
    //
    // Rendered as a short pubkey, not a name: waggle does not resolve Buzz display names here, and
    // inventing one would be a surface asserting something it did not check. A pubkey is stable and
    // verifiable, which is what identification needs.
    //
    // OPTIONAL on purpose. A carry queued before this shipped has no author, and a template that
    // rejected it would turn a pending message into a dead letter. Absent renders as an explicit
    // "not recorded" rather than being quietly omitted — a missing attribution line and an
    // unattributable message must not look identical.
    build: ({ mention, why, body, author }, spec) => {
      if (!spec.whys.includes(why)) reject(`carry reason not in {${spec.whys.join('|')}}: ${JSON.stringify(why)}`)
      const who = author == null || author === ''
        ? '_author not recorded — this carry predates #352_'
        : (/^[0-9a-f]{64}$/i.test(String(author))
          ? `\`${String(author).toLowerCase().slice(0, 12)}…\``
          : reject(`carry author is not a 64-char hex pubkey: ${JSON.stringify(String(author).slice(0, 24))}`))
      const reason = why === 'reply' ? 'were replied to' : why === 'alert' ? 'subscribe to a hashtag raised' : 'were mentioned'
      return `📥 **${handle(mention)}** — you ${reason} in the community.\n\n` +
        `from ${who}\n\n> ` +
        carried(body).replace(/\r/g, '').split('\n').join('\n> ') +
        `\n\n_carried out by waggle's return lane. Replying to this message reaches nobody; ` +
        `post from your own key and the bridge brings it back in._`
    },
  },
  // Machine-readable carrier contract for a grant-aware Nvoy runtime. The original kind:9 is
  // embedded byte-for-byte in semantic fields and verified again here; Waggle's seal proves only
  // transport/channel provenance and never replaces the original author's signature.
  return_task_carry: {
    // #508, same third reason. The typed carry puts it in `reason`, which a runtime switches on —
    // so it is admitted here explicitly rather than by widening the check.
    whys: ['mention', 'reply', 'alert'],
    build: ({ channel, why, source }, spec) => {
      const ch = String(channel || '').toLowerCase()
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ch)) reject('task carry channel is not a UUID')
      if (!spec.whys.includes(why)) reject(`task carry reason not in {${spec.whys.join('|')}}: ${JSON.stringify(why)}`)
      const ev = source && typeof source === 'object' && !Array.isArray(source) ? JSON.parse(JSON.stringify(source)) : reject('task carry source is not an event')
      if (Object.keys(ev).sort().join(',') !== 'content,created_at,id,kind,pubkey,sig,tags' || ev.kind !== 9) reject('task carry source is not an exact kind:9 wire event')
      let ok = false; try { ok = verifyEvent(ev) } catch { ok = false }
      if (!ok) reject('task carry source signature is invalid')
      return JSON.stringify({ v: 1, type: 'waggle-channel-task-carry', channel: ch, reason: why, source: ev })
    },
  },
  // In-door consent request (docs/CONSENT.md §5). waggle's FIRST unsolicited outbound seal to a
  // stranger — the disclosure IS the ask. Its prose and signing URL are fixed: Nvoy reviews the
  // canonical terms and asks the participant's own signer to publish the prefilled 440. The safety
  // of SENDING this at all lives in bridge.mjs's §6 once-per-target ask-record.
  consent_request: {
    build: ({ consentUrl, hiveId, hiveName, hiveHandle, termsUrl, prefill }) => {
      const link = consentLink({ consentUrl, hiveId, hiveName, hiveHandle, termsUrl, prefill })
      const hive = handle(hiveName)
      const hiveHandleText = String(hiveHandle).replace(/[\r\n`]/g, '').trim()
      return `Hello from ${hive} (${hiveHandleText}) on Buzz.xyz.\n\n` +
        `The people and agents tending this hive have been enjoying your public writing and would love to bring it in from the meadow, ` +
        `so the hive can read and discuss it together.\n\n` +
        `May waggle mirror your public Nostr posts into this one hive? Nothing crosses unless you say yes.\n\n` +
        `To review the exact terms and choose your own Nostr signer, open this consent card:\n${link}\n\n` +
        `If it is not for you, simply leave this note alone — silence is a no, and you will not be asked again.`
    },
  },
}

export const NOSTR_TEMPLATE_NAMES = Object.freeze(Object.keys(CATALOGUE))

// Exported so the catalogue test can drive body construction without signing anything.
export function buildBody(template, slots = {}) {
  const spec = CATALOGUE[template]
  if (!spec) reject(`unknown template ${JSON.stringify(template)}`)
  return spec.build(slots, spec)
}

// --- Reading the bridge's own sealed inbox ----------------------------------------------------
//
// Not egress, but it is the other thing the key does, and it lives here so that BRIDGE_SK has
// exactly one home. Each throws rather than returning a sentinel; the caller never sees the key.
//
// DELIBERATELY TWO CALLS, not one. The caller must verify the seal's signature BETWEEN them —
// that is the authorship proof (§2.4), and it is what keeps the second (expensive) decrypt off
// unauthenticated input on the §7 DoS surface. A single open-it-all helper would quietly decrypt
// the inner rumor before anything had proven the seal was authentic, and the ordering would be
// lost in a refactor with nothing to catch it. Keep them separate.
export async function openSeal(ev) {
  if (!BRIDGE_SIGNER) reject('no bridge signer to open sealed mail')
  return JSON.parse(await BRIDGE_SIGNER.nip44Decrypt(ev.pubkey, ev.content))
}
export async function openRumor(seal) {
  if (!BRIDGE_SIGNER) reject('no bridge signer to open sealed mail')
  return JSON.parse(await BRIDGE_SIGNER.nip44Decrypt(seal.pubkey, seal.content))
}

// --- The one signing call on this transport ---------------------------------------------------
//
// sealAndWrap({ template, to, slots }, publish) -> { wrap, accepted, bytes }
//
// `to` is the recipient pubkey; the body comes from the catalogue and nowhere else. The seal is
// signed by the BRIDGE key (a NIP-17 seal names its real sender, so it must be); the wrap around
// it is signed by a THROWAWAY, which is why this traffic never appears on the wire as the poster
// key — and why the wrap id can never trip the tripwire.
export async function sealAndWrap({ template, to, slots, powTarget = null, mine = mineAsync }, publish) {
  if (!BRIDGE_SIGNER) reject('no bridge signer to seal with')
  if (typeof template !== 'string') reject('sealAndWrap requires a catalogue template name, not a string body')
  const toHex = hex64(to, 'recipient')
  const text = buildBody(template, slots)

  const now = Math.floor(Date.now() / 1000)
  // NIP-59 backdating: randomise wrap and seal timestamps into the past so an observer cannot
  // correlate a channel message with a delivery by timing alone.
  const fuzzed = () => now - Math.floor(Math.random() * 172800)

  const rumor = { kind: 14, pubkey: BRIDGE_PK, created_at: now, tags: [['p', toHex]], content: text }
  rumor.id = getEventHash(rumor)
  const seal = await signExact({
    kind: 13, created_at: fuzzed(), tags: [],
    content: await BRIDGE_SIGNER.nip44Encrypt(toHex, JSON.stringify(rumor)),
  }, 'NIP-17 seal')
  const wsk = generateSecretKey()
  let wrapTemplate = {
    kind: 1059, created_at: fuzzed(), tags: [['p', toHex]],
    content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wsk, toHex)),
  }

  // Proof-of-work, when some relay in this fan-out has told us it wants some (#346). It happens
  // HERE, in the two statements between building the template and signing it, because that is the
  // only place it can: `wsk` is generated on the line above and dropped on the line below, and a
  // nonce tag changes the id, so mining any later would need a key that no longer exists. Everything
  // downstream — journalSend, markRelaySeen, markLatency, the dedup stores — keys on `wrap.id`, and
  // all of them see it after this point, so none of them can be holding a pre-mining id.
  //
  // Default OFF and byte-identical to before when no target is known, which is the state of every
  // relay that has not refused us. A failure to mine is never fatal: publishing without the work and
  // being refused is the outcome we already have, and it costs one message instead of the box.
  let pow = null
  if (Number.isInteger(powTarget) && powTarget > 0) {
    // getEventHash needs the author, and finalizeEvent would only fill it in later — mining against
    // a template with no pubkey would produce a nonce for an id the signed event never has.
    // Not named `template`: that identifier is this function's catalogue-NAME parameter, and a
    // second meaning for it is the one place in this path a reader has to stop and check which.
    const mineable = { ...wrapTemplate, pubkey: getPublicKey(wsk) }
    pow = await mine(mineable, powTarget)
    if (pow.mined) wrapTemplate = { ...wrapTemplate, tags: pow.event.tags }
  }

  const wrap = finalizeEvent(wrapTemplate, wsk)

  const accepted = await publish(wrap)
  return { wrap, accepted, bytes: text.length, pow }
}
