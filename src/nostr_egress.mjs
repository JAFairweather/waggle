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
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
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
