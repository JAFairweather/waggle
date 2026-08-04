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
// This module also OWNS THE KEY. Signing is not the only thing a private key does — the relay
// lane unseals inbound wraps with it too — and a ban on `finalizeEvent` alone would leave
// BRIDGE_SK spread across the file with nothing to stop the next signer appearing beside a
// decrypt. So the key is derived here, never exported, and callers get capabilities instead:
// `bridgePubkey()`, `hasBridgeKey()`, `openSealed()`, `sealAndWrap()`.
//
// INV-A3-2  exactly one function per transport invokes a signer. This is the Nostr one.
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import * as nip44 from 'nostr-tools/nip44'

// --- The key, held here and nowhere else ------------------------------------------------------
const BRIDGE_SK = (() => {
  const raw = process.env.BUZZ_PRIVATE_KEY
  if (!raw) return null
  try { return raw.startsWith('nsec1') ? nip19.decode(raw).data : Uint8Array.from(Buffer.from(raw, 'hex')) } catch { return null }
})()
const BRIDGE_PK = BRIDGE_SK ? getPublicKey(BRIDGE_SK) : null

// The PUBLIC key is safe to hand out and is needed all over bridge.mjs for REQ filters and
// self-comparison. The secret never leaves this module.
export const bridgePubkey = () => BRIDGE_PK
export const hasBridgeKey = () => !!BRIDGE_SK

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
  const statuses = new Set(['pending', 'asked', 'active', 'revoked'])
  const seen = new Set()
  const cleaned = follows.map((f) => {
    if (!f || typeof f !== 'object') reject('control state follow is not an object')
    const pubkey = hex64(f.pubkey, 'control state follow.pubkey')
    if (seen.has(pubkey)) reject('control state has duplicate follow')
    seen.add(pubkey)
    const consent = String(f.consent || '')
    if (!statuses.has(consent)) reject('control state follow.consent is invalid')
    return { pubkey, consent }
  }).sort((a, b) => a.pubkey.localeCompare(b.pubkey))
  if (typeof s.publishing !== 'boolean') reject('control state publishing is not boolean')
  // v1 originally carried just hive/bridge/publishing/follows. Operations was added as an
  // additive v1 summary, so old signed records must remain valid rather than being rewritten
  // under a fictional v2 contract.
  if (s.operations == null) return { v: 1, observed_at: observedAt, hive: { id: hiveId, name: hiveName, handle: hiveHandle }, bridge: hex64(s.bridge, 'control state bridge'), publishing: s.publishing, follows: cleaned }
  const operations = (typeof s.operations === 'object') ? s.operations : reject('control state operations is invalid')
  const exact = (obj, keys, label) => { if (Object.keys(obj).sort().join(',') !== keys.slice().sort().join(',')) reject(`${label} has unexpected fields`) }
  const count = (value, label) => { const n = Math.floor(num(value, label)); if (n < 0 || n > 1000000) reject(`${label} out of bounds`); return n }
  exact(operations, ['trust', 'lanes', 'gates', 'drops'], 'control state operations')
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
  return { v: 1, observed_at: observedAt, hive: { id: hiveId, name: hiveName, handle: hiveHandle }, bridge: hex64(s.bridge, 'control state bridge'), publishing: s.publishing, follows: cleaned,
    operations: { trust: { trusted_repliers: count(trust.trusted_repliers, 'trusted_repliers'), muted_authors: count(trust.muted_authors, 'muted_authors'), watched_notes: count(trust.watched_notes, 'watched_notes') }, lanes,
      gates: { consent_required: gates.consent_required, ask_per_hour: count(gates.ask_per_hour, 'ask_per_hour'), public_content_bytes: count(gates.public_content_bytes, 'public_content_bytes'), public_replier_per_min: count(gates.public_replier_per_min, 'public_replier_per_min'), public_channel_per_min: count(gates.public_channel_per_min, 'public_channel_per_min'), public_lane_per_hour: count(gates.public_lane_per_hour, 'public_lane_per_hour') },
      drops: { relay_preauth: count(drops.relay_preauth, 'relay_preauth'), relay_not_relay: count(drops.relay_not_relay, 'relay_not_relay') } } }
}

// The sole public-event capability held by bridge.mjs.  The body and tags are fixed by the
// validator above; a caller supplies state, never event shape, kind, tags, or arbitrary content.
export function signControlState(state) {
  if (!BRIDGE_SK || !BRIDGE_PK) reject('no bridge key to sign control state')
  const checked = controlState(state)
  return finalizeEvent({
    kind: CONTROL_STATE_KIND,
    created_at: checked.observed_at,
    tags: [['d', 'waggle-control-state'], ['h', checked.hive.id], ['v', '1']],
    content: JSON.stringify(checked),
  }, BRIDGE_SK)
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
    whys: ['mention', 'reply'],
    build: ({ mention, why, body }, spec) => {
      if (!spec.whys.includes(why)) reject(`carry reason not in {${spec.whys.join('|')}}: ${JSON.stringify(why)}`)
      return `📥 **${handle(mention)}** — you were ${why === 'reply' ? 'replied to' : 'mentioned'} in the community.\n\n> ` +
        carried(body).replace(/\r/g, '').split('\n').join('\n> ') +
        `\n\n_carried out by waggle's return lane. Replying to this message reaches nobody; ` +
        `post from your own key and the bridge brings it back in._`
    },
  },
  // Machine-readable carrier contract for a grant-aware Nvoy runtime. The original kind:9 is
  // embedded byte-for-byte in semantic fields and verified again here; Waggle's seal proves only
  // transport/channel provenance and never replaces the original author's signature.
  return_task_carry: {
    whys: ['mention', 'reply'],
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
export function openSeal(ev) {
  if (!BRIDGE_SK) reject('no bridge key to open sealed mail')
  return JSON.parse(nip44.decrypt(ev.content, nip44.getConversationKey(BRIDGE_SK, ev.pubkey)))
}
export function openRumor(seal) {
  if (!BRIDGE_SK) reject('no bridge key to open sealed mail')
  return JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(BRIDGE_SK, seal.pubkey)))
}

// --- The one signing call on this transport ---------------------------------------------------
//
// sealAndWrap({ template, to, slots }, publish) -> { wrap, accepted, bytes }
//
// `to` is the recipient pubkey; the body comes from the catalogue and nowhere else. The seal is
// signed by the BRIDGE key (a NIP-17 seal names its real sender, so it must be); the wrap around
// it is signed by a THROWAWAY, which is why this traffic never appears on the wire as the poster
// key — and why the wrap id can never trip the tripwire.
export async function sealAndWrap({ template, to, slots }, publish) {
  if (!BRIDGE_SK) reject('no bridge key to seal with')
  if (typeof template !== 'string') reject('sealAndWrap requires a catalogue template name, not a string body')
  const toHex = hex64(to, 'recipient')
  const text = buildBody(template, slots)

  const now = Math.floor(Date.now() / 1000)
  // NIP-59 backdating: randomise wrap and seal timestamps into the past so an observer cannot
  // correlate a channel message with a delivery by timing alone.
  const fuzzed = () => now - Math.floor(Math.random() * 172800)

  const rumor = { kind: 14, pubkey: BRIDGE_PK, created_at: now, tags: [['p', toHex]], content: text }
  rumor.id = getEventHash(rumor)
  const seal = finalizeEvent({
    kind: 13, created_at: fuzzed(), tags: [],
    content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(BRIDGE_SK, toHex)),
  }, BRIDGE_SK)
  const wsk = generateSecretKey()
  const wrap = finalizeEvent({
    kind: 1059, created_at: fuzzed(), tags: [['p', toHex]],
    content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wsk, toHex)),
  }, wsk)

  const accepted = await publish(wrap)
  return { wrap, accepted, bytes: text.length }
}
