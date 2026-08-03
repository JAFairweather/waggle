// waggle — non-custodial Nostr ↔ Buzz bridge
// -----------------------------------------------------------------------------
// A SUBSCRIBER, not a poller: holds open REQ subscriptions to the Armada relays
// for kind:1059 gift-wraps #p-tagged to our agents, and forwards each SEALED
// event into that agent's Buzz inbox so the buzz-acp harness wakes the agent to
// unwrap it with its own in-runtime key.
//
// NON-CUSTODIAL: this process holds NO agent nsec and never unwraps mail CARRIED FOR OTHERS —
// a DM between two members, a Concord plane wrap — those it routes on the public outer `p` tag
// only. It DOES unwrap gift-wraps addressed to its OWN key (the relay lane, DESIGN_RELAY_INGRESS
// §2): opening your own mail is not opening someone else's. It needs its own Buzz posting identity
// (BUZZ_PRIVATE_KEY) to post into channels, plus its own Nostr key (BRIDGE key) to open relay-lane
// requests sealed to it. Safe on a server that holds no OTHER party's keys.
//
// Promoted from the .scratch prototype (the outbox engineer, 2026-07-24) by the read-lane engineer:
//   - config externalized to config.json (relays + recipients + inbox UUIDs)
//   - dedup is now DURABLE (survives restarts) so a bounce can't re-deliver
//   - the NIP-59 48h backdate window is the DEFAULT, not an opt-in flag
//
// Env:
//   FORWARD_MODE = buzz (default) | dryrun     dryrun = log only; buzz = post via CLI
//   SINCE_SECS   = DM lookback window in seconds (default 172800 = 48h; see NIP-59 note
//                  below). Set 0 for now-only.
//   CHANNEL_SINCE_SECS = Concord channel-lane lookback (default 3600 = 1h). Concord streams
//                  don't backdate created_at, so this needs only a short restart-heal window,
//                  NOT the 48h DM window — a 48h channel backfill would flood inboxes on boot.
//   CONFIG_PATH  = path to config.json (default ./config.json next to package.json)
//   SEEN_PATH    = path to durable dedup store (default ./data/seen-ids.log)
//   SEEN_CAP     = max ids retained in the durable store (default 100000)
//
// NIP-59 note: a gift-wrap's created_at is randomized up to ~48h INTO THE PAST.
// A relay matches a newly-arrived-but-backdated wrap against an active filter's
// `since`, so a since=now subscription silently drops fresh DMs. We default the
// lookback to 48h and lean on durable id-dedup to make re-delivery a no-op.
import WebSocket from 'ws'
// Only verifyEvent remains here: every signing symbol moved to nostr_egress.mjs with the key
// (A3 §2.5). Verification is a public-key operation and belongs wherever input is judged.
import { verifyEvent } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { emit, query, checkConfigRenderable } from './egress.mjs'
import { bridgePubkey, hasBridgeKey, openSeal, openRumor, sealAndWrap, consentTosBlock } from './nostr_egress.mjs'
import { verifyConsent } from './consent.mjs'   // in-door consent (#131/#132, docs/CONSENT.md §8)
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Extracted leaf modules (#154). Each is dependency-free of config and ambient state, which is why
// these four came out first — the split is staged, not big-bang.
import { log, err } from './log.mjs'
import { durableSet, durableQueue } from './stores.mjs'
import { fanout } from './fanout.mjs'
import { defuseRefs, defuseMarkup, quoted, renderQuarantined, renderReleased } from './render.mjs'
import { hex as concordHex, publicChannel, openChannelWrap } from './concord_lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const CONFIG_PATH = process.env.CONFIG_PATH || resolve(ROOT, 'config.json')
const SEEN_PATH = process.env.SEEN_PATH || resolve(ROOT, 'data', 'seen-ids.log')
const SEEN_CAP = Number(process.env.SEEN_CAP || 100000)
// Return-lane dedup store — same append-only, capped lifecycle as seen-ids, but a SEPARATE file:
// its keys are (source_id × recipient) composites, not bare event ids, so one community message
// carries out to every matching recipient exactly once and never re-delivers across a restart.
const RLSEEN_PATH = process.env.RLSEEN_PATH || resolve(ROOT, 'data', 'return-lane-seen.log')
const MIRRORASKED_PATH = process.env.MIRRORASKED_PATH || resolve(ROOT, 'data', 'mirror-asked.log')
const RLPENDING_PATH = process.env.RLPENDING_PATH || resolve(ROOT, 'data', 'return-lane-pending.log')
// Bounded, or one permanently-unreachable recipient retries forever. On the ~4-minute scan poll
// this is roughly two hours of outage before a carry is dead-lettered — long enough to ride out a
// relay flap, short enough that a dead key is surfaced the same day.
const RLPENDING_MAX_ATTEMPTS = Number(process.env.RLPENDING_MAX_ATTEMPTS || 30)
const RLSEEN_CAP = Number(process.env.RLSEEN_CAP || 100000)
// Relay-lane dedup store (DESIGN_RELAY_INGRESS §6): wraps addressed to waggle's OWN key that it
// unwraps and relays into a channel. Its own append-only capped file — checked BEFORE decryption
// (replay protection; a fresh-wrap flood misses here by design, the decrypt budget bounds that).
const RELAYSEEN_PATH = process.env.RELAYSEEN_PATH || resolve(ROOT, 'data', 'relay-lane-seen.log')
const RELAYSEEN_CAP = Number(process.env.RELAYSEEN_CAP || 100000)
const FORWARD_MODE = process.env.FORWARD_MODE || 'buzz'
// SEALED_LANES=off runs the PUBLIC read lane ONLY — no DM lane, no Concord channel lane. Use this
// on a SECOND instance (e.g. a local read-lane host) when another instance already owns the sealed
// lanes: dedup is per-process (module-level `seen` + its own seen-ids.log), so two instances both
// routing the sealed lanes deliver every wrap TWICE, byte-identical (research & verification, 2026-07-28). Default on.
const SEALED_LANES = (process.env.SEALED_LANES || 'on').toLowerCase() !== 'off'
const SINCE_SECS = process.env.SINCE_SECS != null ? Number(process.env.SINCE_SECS) : 172800 // 48h
const SINCE = Math.floor(Date.now() / 1000) - SINCE_SECS
// Concord channel streams DON'T backdate created_at (CORD-01: "created_at is not tweaked"),
// so the 48h NIP-59 window is DM-specific noise here — a 48h channel backfill would dump
// tens of historical posts into every inbox on boot. The channel lane only needs "from now,
// plus a short heal for restart gaps." Durable dedup still prevents any re-delivery.
const CHANNEL_SINCE_SECS = process.env.CHANNEL_SINCE_SECS != null ? Number(process.env.CHANNEL_SINCE_SECS) : 3600 // 1h
const CHANNEL_SINCE = Math.floor(Date.now() / 1000) - CHANNEL_SINCE_SECS


// --- config -----------------------------------------------------------------
if (!existsSync(CONFIG_PATH)) {
  err(`FATAL: no config at ${CONFIG_PATH}. Copy config.example.json → config.json and fill inbox UUIDs.`)
  process.exit(1)
}
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const RELAYS = cfg.relays || []
const RECIPIENTS = {} // hex -> { name, inbox, npub_hex }
for (const r of cfg.recipients || []) RECIPIENTS[r.npub_hex] = { name: r.name, inbox: r.inbox, npub_hex: String(r.npub_hex || '').toLowerCase() }
const TARGETS = Object.keys(RECIPIENTS)

// --- Concord channel planes (additive; empty => pure DM bridge, no behavior change) --------
// A public Concord channel's chat is a stream of kind:1059 wraps authored BY the channel's
// derived plane pubkey (Concord inverts NIP-59: the outer p-tag is random, routing is by
// `authors`). Two delivery modes, one gate:
//
//   DEFAULT (no read-key): forward the SEALED wrap to every member's inbox; the agent derives
//   the plane key from ITS OWN community_root (held in-runtime) and decrypts. NON-CUSTODIAL: we
//   hold the plane PUBKEY only — a public address, never community_root.
//
//   OPT-IN (#191, option 1): if the box is given the community read-key WB_COMMUNITY_ROOT and a
//   channel carries a channel_id, we DERIVE the plane key here and deliver PLAINTEXT — the seat
//   never touches Concord. This is a DELIBERATE, reversible READ concession for that channel: the
//   box can now read it. It is a read-only trade — no member's SIGNING key is ever held (that
//   invariant is unchanged; seal-back stays in each seat's own runtime). Pull the env var and
//   redeploy to return to sealed-forward. Absent the root, absent a channel_id, or on ANY
//   derivation mismatch, every channel falls back to the sealed-forward behavior above, byte for
//   byte — so a wrong or missing read-key can only ever be as safe as today, never worse.
//
// config.channels[]: { name, plane_pubkey, channel_id?, epoch?, recipients: [<recipient name>...] }
// community_root is a SECRET read-capability — it arrives ONLY via the WB_COMMUNITY_ROOT env var,
// never config.json, and is never logged.
const PLANES = {} // plane_pubkey_hex -> { name, recipients, channelId?, epoch?, planeKey? }
const NAME_TO_REC = {}
for (const hex of TARGETS) NAME_TO_REC[RECIPIENTS[hex].name] = RECIPIENTS[hex]
// Decode the read-key once, loudly. A malformed value disables decrypt (sealed-forward) rather
// than crashing the bridge — the concord_lib guards throw on a bad root, and we catch that here.
let COMMUNITY_ROOT = null
if (process.env.WB_COMMUNITY_ROOT) {
  try { COMMUNITY_ROOT = concordHex(process.env.WB_COMMUNITY_ROOT) }
  catch (e) { err(`WARN: WB_COMMUNITY_ROOT is set but not valid hex (${e.message}) — inbound decrypt DISABLED, forwarding SEALED`) }
}
for (const c of cfg.channels || []) {
  if (!c.plane_pubkey) { err(`WARN: channel '${c.name}' has no plane_pubkey — skipping`); continue }
  const recips = (c.recipients || []).map(n => NAME_TO_REC[n]).filter(Boolean)
  const missing = (c.recipients || []).filter(n => !NAME_TO_REC[n])
  if (missing.length) err(`WARN: channel '${c.name}' names unknown recipient(s): ${missing.join(', ')}`)
  if (!recips.length) { err(`WARN: channel '${c.name}' has no resolvable recipients — skipping`); continue }
  const planePk = c.plane_pubkey.toLowerCase()
  const entry = { name: c.name, recipients: recips, channelId: c.channel_id || null, epoch: c.epoch ?? null }
  // Opt-in decrypt: derive the plane key and PROVE it against the configured plane_pubkey before
  // trusting it. A mismatch means the read-key, channel_id, or epoch is wrong — we then decline to
  // decrypt (sealed-forward) rather than deliver something derived from a bad key. This is the
  // guard James and Neil signed off: the box only reads a channel it can prove it has the key for.
  if (COMMUNITY_ROOT && entry.channelId) {
    try {
      const pk = publicChannel(COMMUNITY_ROOT, concordHex(entry.channelId), entry.epoch ?? 0)
      if (pk.pub !== planePk) {
        err(`WARN: channel '${c.name}' derived plane ${pk.pub.slice(0, 12)}… != configured ${planePk.slice(0, 12)}… — read-key/channel_id/epoch mismatch; forwarding SEALED (no decrypt)`)
      } else {
        entry.planeKey = pk
        log(`channel '${c.name}': inbound decrypt ENABLED — box holds the read-key, deliveries are PLAINTEXT (reversible read concession)`)
      }
    } catch (e) {
      err(`WARN: channel '${c.name}' plane derivation failed (${e.message}) — forwarding SEALED (no decrypt)`)
    }
  }
  PLANES[planePk] = entry
}
const PLANE_AUTHORS = Object.keys(PLANES)

// --- Public kind:1 read lane (additive; absent => zero behavior change) -------
// The INBOX DOOR for open-Nostr interop (POC, 2026-07-27). Unlike the two sealed
// lanes above, public kind:1 notes are PLAINTEXT — there is nothing to unwrap and NO
// key is ever held. We hold an open REQ to a set of PUBLIC relays (damus/nos.lol/
// primal) and repost each matching note into a Buzz channel as a human-readable
// message. NON-CUSTODIAL by construction: read public data, repost its content.
// This is the "outside world → us" half; the outbox half (federating a member's
// kind:1 out to public relays) lives elsewhere.
// cfg.public: { relays:[...], inbox:"<uuid>", watch_authors:[hex...], watch_events:[id...], since_secs? }
//   watch_authors — pull a chosen author's public kind:1 into Buzz.
//   watch_events  — catch kind:1 REPLIES (#e) to one of our own published notes
//                   (closes the round-trip: stranger's Damus reply lands back in Buzz).
const PUB_SINCE_SECS = cfg.public && cfg.public.since_secs != null ? Number(cfg.public.since_secs) : 3600
// A3: a persisted watermark lets a restart resume from the last delivered note instead of
// re-reading the whole `since` window every boot. OVERLAP re-reads a small margin to absorb
// relay clock skew; durable id-dedup (A2) makes that overlap a no-op instead of a re-post.
const PUB_WATERMARK_PATH = process.env.PUB_WATERMARK_PATH || resolve(ROOT, 'data', 'pub-watermark')
const PUB_WATERMARK_OVERLAP = Number(process.env.PUB_WATERMARK_OVERLAP || 120)
function loadPubWatermark() {
  try { const v = Number(readFileSync(PUB_WATERMARK_PATH, 'utf8').trim()); return Number.isFinite(v) && v > 0 ? v : null }
  catch { return null }
}
let pubWatermark = loadPubWatermark()
// A7: NIP-09 deletion propagation. The posted-map records every public note we repost
// (original id -> our Buzz copy) so an author's later kind:5 can withdraw the copy. The
// kind:5 lookback is intentionally LONGER than the kind:1 watermark: deletes are rare,
// idempotent under dedup, and a delete issued while the lane was down must not be missed.
const POSTED_MAP_PATH = process.env.POSTED_MAP_PATH || resolve(ROOT, 'data', 'posted-map.log')
// #171 — the durable record of what did NOT get delivered.
//
// Both Buzz lanes commit the event id to durable dedup BEFORE the async send, deliberately:
// "we favor never double-post (the §8 firehose line) over never drop" (routePublic). That
// tradeoff is a real position and this does not reverse it — reversing it is a policy call for
// the maintainer, not a bug fix (see #171).
//
// What it DOES fix is that the losing side of that trade was invisible. A failed send produced
// one ERR line in a journal that rotates, and the message was gone with no record that it had
// ever existed. On 2026-08-01 that made a config-validation regression indistinguishable from
// silence until someone went looking. An append-only list of undelivered messages costs nothing,
// changes no delivery behaviour, and turns "gone" into "recoverable, and countable".
const UNDELIVERED_PATH = process.env.UNDELIVERED_PATH || resolve(ROOT, 'data', 'undelivered.log')
// Tripwire send-journal: every event id THIS process publishes as the poster identity,
// appended synchronously. An out-of-process watcher (tools/tripwire.mjs) diffs the poster's
// on-relay events against this journal — any post signed by our key that is NOT here means
// the key signed something we did not (theft / a second signer). Process rate-limits cannot
// catch that; this can. (Q1, waggle's finding, 2026-07-30.)
const SEND_JOURNAL_PATH = process.env.SEND_JOURNAL_PATH || resolve(ROOT, 'data', 'send-journal.log')
function journalSend(id, meta) {
  if (!id) return
  try { mkdirSync(dirname(SEND_JOURNAL_PATH), { recursive: true }); appendFileSync(SEND_JOURNAL_PATH, JSON.stringify({ id, ...meta, ts: Math.floor(Date.now() / 1000) }) + '\n') }
  catch (e) { err(`tripwire: journal append failed for ${String(id).slice(0, 12)}…: ${e.message}`) }
}
// The bridge's own identity, used to SEAL outbound return-lane mail. A NIP-17 seal names its
// real sender, so this has to be the bridge's key — the wrap around it is signed by a throwaway,
// which is why this traffic never appears on the wire as the poster key.
// A3 §2.5: the key itself lives in nostr_egress.mjs — signing is not the only thing it does (the
// relay lane unseals with it too), so one module owns it and hands out capabilities instead.
const BRIDGE_PK = bridgePubkey()

const POSTED_CAP = Number(process.env.POSTED_CAP || 100000)
const DEL_SINCE_SECS = Number(process.env.DEL_SINCE_SECS || 172800) // 48h
function bumpPubWatermark(ts) {
  if (!Number.isFinite(ts) || ts <= 0 || (pubWatermark && ts <= pubWatermark)) return
  pubWatermark = ts
  try { mkdirSync(dirname(PUB_WATERMARK_PATH), { recursive: true }); writeFileSync(PUB_WATERMARK_PATH, String(ts)) }
  catch (e) { err(`pub watermark: write failed: ${e.message}`) }
}
const PUB = cfg.public ? {
  relays: cfg.public.relays || [],
  // Channel values accept a UUID or a NAME (resolved at boot via `buzz channels list`).
  // The default community channel is the one named "waggle".
  inbox: cfg.public.inbox || 'waggle',
  // A1: un-allowlisted external replies quarantine into this STAGING channel for human
  // approval — they never reach a community channel automatically. Null => hold-and-log
  // (default-closed): a stranger's reply is never auto-delivered anywhere.
  staging: cfg.public.staging_inbox || null,
  authors: (cfg.public.watch_authors || []).map(s => s.toLowerCase()),
  events: (cfg.public.watch_events || []).map(s => s.toLowerCase()),
  window: PUB_SINCE_SECS,
  since: pubWatermark ? (pubWatermark - PUB_WATERMARK_OVERLAP) : (Math.floor(Date.now() / 1000) - PUB_SINCE_SECS),
  backfillLimit: Number(cfg.public.backfill_limit != null ? cfg.public.backfill_limit : 50),      // A4
  maxContentBytes: Number(cfg.public.max_content_bytes != null ? cfg.public.max_content_bytes : 16384), // A6
  replierPerMin: Number(cfg.public.replier_per_min != null ? cfg.public.replier_per_min : 5),     // A6
  channelPerMin: Number(cfg.public.channel_per_min != null ? cfg.public.channel_per_min : 20),    // A6
  lanePerHour: Number(cfg.public.lane_per_hour != null ? cfg.public.lane_per_hour : 200),         // A6
  deletesPerHour: Number(cfg.public.deletes_per_hour != null ? cfg.public.deletes_per_hour : 20), // A7
  // Approval workflow: @mention prepended to a quarantine header so the arrival notifies
  // the approver through the existing Buzz mention path. Mutes are the reject verb's
  // durable form — a muted author's replies stop reaching staging at all.
  approverMention: cfg.public.approver_mention || null,
  muted: (cfg.public.muted_authors || []).map(s => String(s).toLowerCase()),
  // Reply-trust vs feed-follow are DIFFERENT grants: a trusted replier's replies to our
  // notes skip the quarantine; a watched author's entire public feed mirrors in.
  trustedRepliers: (cfg.public.trusted_repliers || []).map(s => String(s).toLowerCase()),
  // Pubkeys allowed to issue in-channel approval commands (signed kind:9 replies in staging).
  approvers: (cfg.public.approvers || []).map(s => String(s).toLowerCase()),
  // [{ npub_hex, mention }] — an admitted participant, and the @name that reaches them in
  // channel. Empty by default: the return lane carries nothing until someone is named.
  returnLane: (cfg.public.return_lane || []).map(r => ({
    npub_hex: String(r.npub_hex || r.npub || '').toLowerCase(),
    mention: String(r.mention || '').replace(/^@/, ''),
    // The Buzz-side key(s) that sign THIS agent's own words in-channel. Distinct from npub_hex:
    // npub_hex is the delivery address (the agent's real Nostr key, which the community relay
    // will not serve), while an external agent's posts arrive signed by a Buzz-side key. Binding
    // them makes "the agent's own messages" expressible for echo-skip WITHOUT the blanket
    // signer-skip flagged in review: a bound author drives echo-skip only while it is
    // UNIQUE to one entry (see PUB.sharedAuthorKeys below); a key shared across entries — today's
    // single bridge key signs every agent's posts, reposts and quarantine headers — is ambiguous
    // and defers to the per-event registry (agentAuthoredBy) instead. Optional; `author`/`authors`.
    // The bridge key is filtered out here, at parse, mirroring scanAuthors' exclusion at :233.
    // Binding it to an entry would make boundUnique fire on every bridge-signed message (today
    // that is ALL of them — reposts and quarantine headers included), silently treating them as
    // the agent's own words. Config can reach the key; the parser must not honor it. (Finding 1.)
    authors: (Array.isArray(r.authors) ? r.authors : (r.author != null ? [r.author] : []))
      .map(s => String(s || '').toLowerCase())
      .filter(s => /^[0-9a-f]{64}$/.test(s) && s !== String(BRIDGE_PK || '').toLowerCase()),
  })).filter(r => /^[0-9a-f]{64}$/.test(r.npub_hex) && r.mention),
  // Working channel(s) the return-lane detector scans for @mentions of, and replies to, an
  // admitted agent. Resolved at boot like inbox/staging. DEFAULT EMPTY, and NEVER implicitly
  // staging: pollCommands keeps reading staging alone for signed approval commands, and
  // working-channel traffic must never reach handleCommand (a #connector post is not a console
  // command). A name or a UUID; unresolvable names are fatal in buzz mode.
  scanChannels: (cfg.public.scan_channels || []).map(v => String(v || '')).filter(Boolean),
  // Relay lane (DESIGN_RELAY_INGRESS): channels an admitted agent may inject into by sealing a
  // request to waggle's OWN key, instead of publishing a public kind:1 first. DEFAULT EMPTY, and
  // NEVER implicitly inbox — an unlisted destination is dropped loudly. Resolved at boot like
  // inbox/staging. Conveys no capability beyond the public lane EXCEPT destination selection, which
  // is exactly what this allowlist gates (§3).
  relayChannels: (cfg.public.relay_channels || []).map(v => String(v || '')).filter(Boolean),
  // §7 flood mitigations. The decrypt budget is the ONE load-bearing one: unwrapping is decryption
  // work on UNAUTHENTICATED input (the outer wrap is ephemeral-signed, so sender limiting is
  // useless pre-decrypt). Per-minute global cap; exhaustion drops pre-decrypt and UNACKABLY.
  relayDecryptBudget: Number(cfg.public.relay_decrypt_budget != null ? cfg.public.relay_decrypt_budget : 120),
  relayMaxWrapBytes: Number(cfg.public.relay_max_wrap_bytes != null ? cfg.public.relay_max_wrap_bytes : 65536),
  // Signer gate on the scan carry-out — filled below, after approvers/grantors are known.
  scanAuthors: [],
  // Keys whose signed 440/441 events the bridge honors for admission. Defaults to the
  // approvers set — the same authority that runs the quarantine console.
  grantors: (cfg.public.grantors || cfg.public.approvers || []).map(s => String(s).toLowerCase()),
  // In-door consent (#131/#132, docs/CONSENT.md §8). ENFORCEMENT is OFF by default: with it off,
  // the consent set is still built (observability) but never gates, so behaviour is unchanged and
  // the crew's feeds keep mirroring. Flip mirror_require_consent on only once every non-grandfathered
  // watched author holds a consent record. Grandfathered authors (the pre-consent crew, who joined
  // as members) are exempt while enforcement is on.
  mirrorRequireConsent: /^(1|true|yes|on)$/i.test(String(cfg.public.mirror_require_consent || '')),
  mirrorGrandfathered: (cfg.public.mirror_grandfathered || []).map(s => String(s).toLowerCase())
    .filter(s => /^[0-9a-f]{64}$/.test(s)),
  // The disclosure/ask side (§5/§6). The terms URL and community name feed the ONE ToS producer
  // (nostr_egress `consentTosBlock`); with a terms URL set and a bridge key present, the bridge
  // ASKS (sends the consent-request DM) when it holds an un-consented author. Rate-capped, once per
  // target (§6). Absent terms URL → asking is OFF (enforcement can still gate; nobody is DM'd).
  mirrorConsentTermsUrl: cfg.public.mirror_consent_terms_url || null,
  mirrorConsentCommunity: cfg.public.mirror_consent_community_name || cfg.public.inbox,
  mirrorAskPerHour: Number(cfg.public.mirror_ask_per_hour != null ? cfg.public.mirror_ask_per_hour : 20),
} : null

// §7 version-binding, from ONE producer (crew review of #199 → #200). The gate's expected hash, the
// DM prefill's `tos`, and the block a participant sees all derive from the same `consentTosBlock`,
// so they cannot drift. `mirror_expected_tos_hash` remains an explicit override; otherwise it is
// derived from the community name + terms URL when both are present. Null → presence-only.
if (PUB) {
  PUB.mirrorExpectedTosHash = (() => {
    if (cfg.public.mirror_expected_tos_hash) return String(cfg.public.mirror_expected_tos_hash).toLowerCase()
    if (PUB.mirrorConsentTermsUrl && PUB.mirrorConsentCommunity) {
      try { return createHash('sha256').update(consentTosBlock({ community: PUB.mirrorConsentCommunity, termsUrl: PUB.mirrorConsentTermsUrl })).digest('hex') } catch { return null }
    }
    return null
  })()
}

// scan_authors — the SIGNER gate on the return-lane carry-out (§5 of the notify design: spam and
// abuse control plus defense-in-depth, NOT the load-bearing safety property, which is the
// wake/payload split in the action layer). Its own config key so widening the roster is config,
// not code. Absent => the declared-trust FLOOR (same cascade shape as grantors→approvers above):
// the keys the bridge is already configured to trust to write in. The live crew roster is supplied
// via cfg.public.scan_authors and held durable by the read-box restore; if it is dropped, the gate
// floors to declared trust rather than opening wide OR silently emptying. This repo commits no real
// keys, so the roster lives in (gitignored) config, never as a literal in public source — code is
// the mechanism, config is the trust set, exactly as for every other gate here. The bridge's own
// key is never admitted: it is skip-self/echo, keyed through the registry, not this gate.
if (PUB) {
  const explicit = Array.isArray(cfg.public.scan_authors) && cfg.public.scan_authors.length
  PUB.scanAuthors = (explicit
    ? cfg.public.scan_authors.map(s => String(s).toLowerCase())
    : [...new Set([...PUB.approvers, ...PUB.grantors, ...PUB.trustedRepliers])]
  ).filter(k => /^[0-9a-f]{64}$/.test(k) && k !== String(BRIDGE_PK || '').toLowerCase())

  // Author-binding consumption (finding #2). An entry's bound author key lets echo-skip fire on
  // the agent's OWN in-channel posts even though they arrive signed by a Buzz-side key, not the
  // delivery key. But skipping on a SHARED key would silently drop a second agent's cross-mention
  // (the forward hazard raised in review: today one bridge key signs everyone). So a bound author is honored for
  // echo-skip only while UNIQUE to a single entry; a key bound to two or more entries is ambiguous
  // and defers to the per-event registry. sharedAuthorKeys is that ambiguity set, computed once.
  // Degrades correctly: the shared bridge key is ambiguous now → registry/gate handle echo; give
  // each agent its own posting key later and its binding becomes unique and activates, no code
  // change. Reply-attribution never uses this — a reply carries its parent's id, not its signer,
  // so routing a reply to an agent's post can only come from the event-level registry.
  const authorCounts = new Map()
  for (const r of PUB.returnLane) for (const a of new Set(r.authors)) authorCounts.set(a, (authorCounts.get(a) || 0) + 1)
  PUB.sharedAuthorKeys = new Set([...authorCounts].filter(([, n]) => n > 1).map(([a]) => a))
}

// Channel-name resolution: public.inbox / staging_inbox may be a Buzz channel NAME instead
// of a UUID — resolved once at boot (and by tools) via `buzz channels list`, so config reads
// as intent ("waggle-test") instead of hex. Unresolvable names are fatal in buzz mode.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function resolveChannels(cb) {
  const pending = PUB ? [PUB.inbox, PUB.staging, ...PUB.scanChannels, ...PUB.relayChannels].filter(v => v && !UUID_RE.test(v)) : []
  if (!pending.length) return cb()
  if (FORWARD_MODE !== 'buzz') { err(`WARN: channel name(s) ${pending.join(', ')} left unresolved in ${FORWARD_MODE} mode`); return cb() }
  query('channels_list').then((so) => {
    const byName = new Map()
    try {
      for (const c of JSON.parse(String(so).slice(String(so).indexOf('[')))) {
        byName.set(String(c.name || '').toLowerCase(), c.id || c.channel_id || c.uuid)
      }
    } catch { err('FATAL: could not parse `buzz channels list` output'); process.exit(1) }
    const one = (v, what) => {
      if (!v || UUID_RE.test(v)) return v
      const id = byName.get(v.toLowerCase())
      if (!id) { err(`FATAL: no Buzz channel named '${v}' (${what}) — create it or use a UUID`); process.exit(1) }
      log(`channel ${what}: '${v}' -> ${id}`)
      return id
    }
    PUB.inbox = one(PUB.inbox, 'inbox')
    PUB.staging = one(PUB.staging, 'staging_inbox')
    PUB.scanChannels = PUB.scanChannels.map((v, i) => one(v, `scan_channel[${i}]`))
    PUB.relayChannels = PUB.relayChannels.map((v, i) => one(v, `relay_channel[${i}]`))
    cb()
  }).catch((e) => {
    // Unresolvable channel names are FATAL in buzz mode — booting with a name we could not
    // resolve would route nowhere, silently. Default closed: refuse to start rather than run
    // half-addressed. (process.exit inside `one` throws past this catch by design; re-exit.)
    err(`FATAL: cannot resolve channel names — 'buzz channels list' failed: ${e.message}`)
    process.exit(1)
  })
}

const unresolved = (cfg.recipients || []).filter(r => !r.inbox || r.inbox.startsWith('INBOX_UUID_'))
if (unresolved.length) {
  err(`WARN: ${unresolved.length} recipient(s) have placeholder inbox UUIDs — their DMs will fail to route:`,
    unresolved.map(r => r.name).join(', '))
}
if (FORWARD_MODE === 'buzz' && !process.env.BUZZ_PRIVATE_KEY) {
  err('WARN: FORWARD_MODE=buzz but BUZZ_PRIVATE_KEY is unset — buzz sends will fail auth. Set the bridge identity.')
}


// DM + public lane dedup: forwarded event ids, re-hydrated on boot so a bounce (or a SINCE
// backfill) never re-delivers something already pushed. Commit-before-dispatch on the public
// lane is deliberate and stays that way — see routePublic: "never double-post" is chosen over
// "never drop". The claim/rollback verbs exist here now; nothing calls them, on purpose.
const seenStore = durableSet({ path: SEEN_PATH, cap: SEEN_CAP, label: 'dedup', noun: 'seen ids' })
const seen = seenStore.mem
const loadSeen = () => seenStore.load()
const markSeen = (id) => seenStore.commit(id)

// #171 — record a message that was accepted for delivery and then failed to land. The id is
// already durably seen by the time this runs, so nothing will retry it: this file IS the message,
// as far as any later recovery is concerned. Keep it machine-readable and append-only, for the
// same reason the send-journal is: something else has to be able to read it without parsing prose.
//
// Deliberately never throws. A failure to record a failure must not take down the lane, and a
// disk-full box should still deliver what it can — but it must SAY so, or the silence this exists
// to end just moves one level up.
function recordUndelivered({ lane, dest, recipient, id, author, reason }) {
  const line = JSON.stringify({
    ts: Math.floor(Date.now() / 1000), lane, dest, recipient: recipient || null,
    id, author: author || null, reason: String(reason || '').slice(0, 300),
  })
  try {
    mkdirSync(dirname(UNDELIVERED_PATH), { recursive: true })
    appendFileSync(UNDELIVERED_PATH, line + '\n')
  } catch (e) {
    err(`UNDELIVERED: could not record the loss of ${String(id).slice(0, 12)}… — ${e.message}`)
  }
}

// Relay-lane dedup — a SEPARATE file. Committed on any DETERMINISTIC outcome (posted, a reject, or
// a decrypt/verify failure that will never become valid) so a relay re-serving that wrap is cheap;
// NOT committed on a transient budget drop, which may succeed on retry. A wrap id here is never
// mixed into `seen` — separate stores, they cannot collide.
//
// Claim/rollback (#121 finding #2): the entry check and the durable write sit on opposite sides of
// an ASYNC buzz send, so without a claim taken synchronously at dispatch, every copy of the same
// wrap arriving before the first send returns passes the check and posts again. That is not a rare
// race but the NORMAL case — a sender publishes to N relays and the bridge subscribes to all of
// them. Claim on dispatch, persist on success, roll back on failure so it still retries.
const relaySeenStore = durableSet({ path: RELAYSEEN_PATH, cap: RELAYSEEN_CAP, label: 'relay-lane dedup', noun: 'seen wrap ids' })
const relaySeen = relaySeenStore.mem
const loadRelaySeen = () => relaySeenStore.load()
const markRelaySeen = (id) => relaySeenStore.commit(id)
const addRelaySeen = (id) => relaySeenStore.claim(id)
const dropRelaySeen = (id) => relaySeenStore.rollback(id)

// A7 posted-map: append-only JSONL, same lifecycle as seen-ids. One {id, author, buzz,
// dest, ts} record per reposted public note, plus {id, deleted:true} once withdrawn — the
// deleted marker makes a second, different kind:5 for the same target a no-op (the seen
// set only dedups the SAME delete id re-served by another relay).
// `agent` (optional) is the return-lane delivery npub this bridge post was authored FOR — the
// primitive both echo-skip and reply-to-agent detection read. Set when the bridge reposts an
// admitted agent's own public note (author === a return_lane npub_hex). Keying on WHO the bridge
// posted for — never on the shared bridge signing key — is what keeps a second agent's cross
// mentions from being swept up as echoes when the roster grows.
const postedMap = new Map() // orig event id -> { author, buzz, dest, deleted, agent }
function loadPostedMap() {
  if (!existsSync(POSTED_MAP_PATH)) return
  const lines = readFileSync(POSTED_MAP_PATH, 'utf8').split('\n').filter(Boolean).slice(-POSTED_CAP)
  for (const line of lines) {
    try {
      const r = JSON.parse(line)
      if (!r || !r.id) continue
      if (r.deleted) { const e = postedMap.get(r.id); if (e) e.deleted = true; continue }
      postedMap.set(r.id, { author: r.author, buzz: r.buzz || null, dest: r.dest, q: !!r.q, deleted: false, agent: r.agent || null })
      if (r.buzz) stagingByBuzzId.set(String(r.buzz).toLowerCase(), { orig: r.id, author: r.author, dest: r.dest, q: !!r.q, agent: r.agent || null })
    } catch { err(`A7: skipping corrupt posted-map line`) }
  }
  if (postedMap.size) log(`A7: loaded ${postedMap.size} posted-map entries from ${POSTED_MAP_PATH}`)
}
function recordPosted(rec) {
  postedMap.set(rec.id, { author: rec.author, buzz: rec.buzz || null, dest: rec.dest, q: !!rec.q, deleted: false, agent: rec.agent || null })
  // Keyed lowercase to match agentAuthoredBy's read (:972). A raw write against a lowercasing read
  // fails closed silently on any uppercase id — return-lane reply/echo-attribution misses. (Finding 4.)
  if (rec.buzz) stagingByBuzzId.set(String(rec.buzz).toLowerCase(), { orig: rec.id, author: rec.author, dest: rec.dest, q: !!rec.q, agent: rec.agent || null })
  try { mkdirSync(dirname(POSTED_MAP_PATH), { recursive: true }); appendFileSync(POSTED_MAP_PATH, JSON.stringify(rec) + '\n') }
  catch (e) { err(`A7: posted-map append failed for ${rec.id}: ${e.message}`) }
}
function recordWithdrawn(id) {
  const e = postedMap.get(id)
  if (e) e.deleted = true
  try { appendFileSync(POSTED_MAP_PATH, JSON.stringify({ id, deleted: true }) + '\n') }
  catch (er) { err(`A7: posted-map append failed for ${id}: ${er.message}`) }
}
// The buzz CLI's stdout carries the created event id (JSON or plain text); without it a
// later withdrawal falls back to the follow-up-tombstone tier, so a miss is safe.
function parseBuzzEventId(stdout) {
  const s = String(stdout || '')
  try {
    const j = JSON.parse(s)
    const v = j.event_id || j.id || j.event
    if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) return v
  } catch { /* not JSON — fall through to scan */ }
  const m = s.match(/\b[0-9a-f]{64}\b/)
  return m ? m[0] : null
}

// --- Lane-2 rate caps (annex §4.1.1; C3-approved shipping defaults) ----------
// The binding constraint is harness WAKE-RATE per recipient, not relay bandwidth: every
// delivered wrap can spin a full agent turn. Per-plane + per-recipient keying so one noisy
// plane can never starve a quiet one (UC-2 fan-out bounded without collateral throttling).
// EVERY drop is logged with a reason — and only the HASHED channel id (the raw Concord
// channel_id is a secret).
const LANE2_CAPS_PATH = process.env.LANE2_CAPS_PATH || resolve(ROOT, 'config', 'lane2_caps.json')
const LANE2_DROPS_PATH = process.env.LANE2_DROPS_PATH || resolve(ROOT, 'data', 'lane2_drops.log')
const L2_DEFAULTS = {
  perPlane: { maxEventBytes: 65536, postsPerMinute: 20, postsPerHour: 300, perRecipientPerMinute: 12 },
  burst: { bootBackfillMax: 50, recipientBurst: 6 },
  global: { totalPostsPerHour: 2000 },
}
const L2 = (() => {
  try {
    const f = JSON.parse(readFileSync(LANE2_CAPS_PATH, 'utf8'))
    return {
      perPlane: { ...L2_DEFAULTS.perPlane, ...(f.perPlane || {}) },
      burst: { ...L2_DEFAULTS.burst, ...(f.burst || {}) },
      global: { ...L2_DEFAULTS.global, ...(f.global || {}) },
    }
  } catch { return L2_DEFAULTS }
})()
const planeHash = (pk) => createHash('sha256').update(String(pk)).digest('hex').slice(0, 12)
const l2PlaneMin = new Map(), l2PlaneHr = new Map(), l2Global = []
// Per-recipient token bucket: capacity = recipientBurst above the sustained rate; refill at
// perRecipientPerMinute/60 tokens per second. Sustained throughput == the /min cap; short
// legitimate clusters ride the burst.
const l2Bucket = new Map() // `${plane}:${inbox}` -> { tokens, at }
let l2BootRemaining = L2.burst.bootBackfillMax
function l2Drop(reason, plane, ev) {
  err(`LANE2 drop[${reason}]: plane ${planeHash(plane)} — ${String(ev.id || '?').slice(0, 12)}…`)
  try {
    mkdirSync(dirname(LANE2_DROPS_PATH), { recursive: true })
    appendFileSync(LANE2_DROPS_PATH, JSON.stringify({ reason, plane_id_hash: planeHash(plane), event_id: ev.id, ts: Math.floor(Date.now() / 1000) }) + '\n')
  } catch { /* the err() line above still stands */ }
}
// Plane + global gate. Returns false (and logs) when the event must not fan out at all.
function l2PlaneOk(plane, ev, nowMs) {
  // byteLength, not .length: the cap is named maxEventBytes and every other size gate here
  // (public content, relay wrap, relay body) measures bytes. String .length counts UTF-16 code
  // units, so non-ASCII content sails past a cap it should have hit — the one lane where the
  // measure disagreed with the name.
  if (Buffer.byteLength(JSON.stringify(ev)) > L2.perPlane.maxEventBytes) { l2Drop('size', plane, ev); return false }
  const boot = l2BootRemaining > 0
  const mins = slide(l2PlaneMin.get(plane) || [], nowMs, 60_000)
  if (!boot && mins.length >= L2.perPlane.postsPerMinute) { l2Drop('plane-per-min', plane, ev); return false }
  const hrs = slide(l2PlaneHr.get(plane) || [], nowMs, 3600_000)
  if (hrs.length >= L2.perPlane.postsPerHour) { l2Drop('plane-per-hour', plane, ev); return false }
  slide(l2Global, nowMs, 3600_000)
  if (l2Global.length >= L2.global.totalPostsPerHour) { l2Drop('global-per-hour', plane, ev); return false }
  if (boot) l2BootRemaining--
  mins.push(nowMs); l2PlaneMin.set(plane, mins)
  hrs.push(nowMs); l2PlaneHr.set(plane, hrs)
  l2Global.push(nowMs)
  return true
}
// Per-recipient gate: the wake-rate cap. A capped recipient skips THIS delivery; the
// plane's other recipients still receive it.
function l2RecipientOk(plane, inbox, ev, nowMs, boot) {
  if (boot) return true // boot allowance covers the recipient thrash ceiling too
  const key = `${plane}:${inbox}`
  const b = l2Bucket.get(key) || { tokens: L2.burst.recipientBurst, at: nowMs }
  b.tokens = Math.min(L2.burst.recipientBurst, b.tokens + ((nowMs - b.at) / 1000) * (L2.perPlane.perRecipientPerMinute / 60))
  b.at = nowMs
  if (b.tokens < 1) { l2Bucket.set(key, b); l2Drop(`recipient-rate:${inbox.slice(0, 8)}`, plane, ev); return false }
  b.tokens -= 1
  l2Bucket.set(key, b)
  return true
}

// --- NIP-DA admission tier (annex §4.1.1 — S3: granted external participants) --
// PUBLIC signed grants from the maintainer admit a known external identity past the
// quarantine: kind 440 admits, 441 revokes, both verified (signature + grantor set +
// salted scope-hash binding to THIS channel) and consumed statelessly — the grant set is
// rebuilt from the relays on every boot, so there is nothing to migrate and revocation
// needs no restart. Provisional kinds sit behind one config knob (Marmot-band renumber).
const NIPDA_PATH = process.env.NIPDA_KINDS_PATH || resolve(ROOT, 'config', 'nipda_kinds.json')
const NIPDA = (() => {
  const d = { grant: 440, revocation: 441, index: 10440, dataset: 30440, scopeTag: 'da-scope', capTag: 'da-cap' }
  try { return { ...d, ...JSON.parse(readFileSync(NIPDA_PATH, 'utf8')) } } catch { return d }
})()
const scopeHash = (channelId, saltHex) =>
  createHash('sha256').update(Buffer.concat([
    Buffer.from('waggle/da-scope/v1'), Buffer.from([0]), Buffer.from(String(channelId)), Buffer.from(saltHex, 'hex'),
  ])).digest('hex')
const grantSet = new Map() // grantee pubkey -> { grantId, grantor }
function processGrantEvent(ev) {
  if (!ev || !ev.id || !PUB) return
  const grantors = PUB.grantors
  if (!grantors.includes(String(ev.pubkey || '').toLowerCase())) return
  let ok = false
  try { ok = verifyEvent(ev) } catch { ok = false }
  if (!ok) { err(`NIPDA drop[bad-signature]: kind${ev.kind} ${String(ev.id).slice(0, 12)}…`); return }
  if (ev.kind === NIPDA.revocation) {
    const target = (ev.tags || []).filter(t => t[0] === 'e').map(t => t[1])[0]
    for (const [pk, g] of grantSet) if (g.grantId === target) {
      grantSet.delete(pk)
      log(`NIPDA revoked: grantee ${pk.slice(0, 12)}… (441 ${ev.id.slice(0, 12)}…)`)
    }
    return
  }
  if (ev.kind !== NIPDA.grant) return
  const grantee = (ev.tags || []).filter(t => t[0] === 'p').map(t => t[1])[0]
  const scope = (ev.tags || []).find(t => t[0] === NIPDA.scopeTag)
  const cap = (ev.tags || []).find(t => t[0] === NIPDA.capTag)?.[1]
  if (!grantee || !scope || !cap) return
  // The salted hash binds the grant to a channel without the channel id riding publicly;
  // the bridge knows its own channel id, so it recomputes and compares.
  if (scope[1] !== scopeHash(PUB.inbox, scope[2] || '')) return // scoped to some other channel — not ours
  if (cap !== 'admit' && cap !== 'admit+read') return
  grantSet.set(String(grantee).toLowerCase(), { grantId: ev.id, grantor: ev.pubkey })
  log(`NIPDA granted: ${String(grantee).slice(0, 12)}… admitted (${cap}, 440 ${ev.id.slice(0, 12)}…)`)
}

// In-door consent (#131/#132, docs/CONSENT.md §8). A SEPARATE lane from grantSet by construction —
// processGrantEvent above rejects any 440 whose author is not a maintainer grantor (:577), and a
// consent's author is the external participant, so it would drop there before it was ever read. The
// consent record is authored by the DATA SUBJECT granting waggle a `mirror` capability, verified by
// consent.mjs (grantee == this bridge, cap == 'mirror', scope == PUB.inbox, author == subject). Its
// own subscription (`pmc`) feeds it, and it is consulted only by routePublic — and only when
// mirror_require_consent is on. Off (the default), this set is built for observability and gates
// nothing, so the deploy changes no behaviour.
const mirrorConsent = new Map() // participant pubkey -> { recordId, tosHash, at }
// `pmc` finds consents because a 440 p-tags the bridge. A participant's later 441 need not
// repeat that p-tag, though, so it would otherwise be invisible and leave consent fail-open.
// Every live public socket registers a refresher that subscribes by the accepted 440 ids (the
// `e` tags a valid revocation must carry). Batching keeps each relay filter modest while retaining
// coverage for every active consent record.
const CONSENT_REVOCATION_BATCH = 100
const CONSENT_REFRESHERS = new Set()
function consentRecordIds() {
  return Array.from(new Set(Array.from(mirrorConsent.values()).map(r => r.recordId))).sort()
}
function refreshConsentRevocations() {
  for (const f of CONSENT_REFRESHERS) { try { f() } catch (e) { err(`consent: revocation refresh failed: ${e?.message || '?'}`) } }
}
function processConsentEvent(ev) {
  if (!ev || !ev.id || !PUB || !BRIDGE_PK) return
  if (ev.kind === NIPDA.revocation) {
    // Only the grantor withdraws their own consent: a 441 counts iff signed by the same participant
    // whose consent record it e-tags. A 441 from anyone else is ignored (consent.mjs's rule, here).
    const author = String(ev.pubkey || '').toLowerCase()
    const held = mirrorConsent.get(author)
    if (!held) return
    const targets = (ev.tags || []).filter(t => t[0] === 'e').map(t => t[1])
    if (targets.includes(held.recordId)) {
      mirrorConsent.delete(author)
      refreshConsentRevocations()
      log(`mirror consent revoked: ${author.slice(0, 12)}… (441 ${ev.id.slice(0, 12)}…)`)
    }
    return
  }
  if (ev.kind !== NIPDA.grant) return
  const v = verifyConsent(ev, { bridgePubkey: BRIDGE_PK, communityId: PUB.inbox })
  if (!v.ok) return
  const prev = mirrorConsent.get(v.participant)
  if (!prev || ev.created_at >= prev.at) {   // newest active consent per participant wins
    mirrorConsent.set(v.participant, { recordId: ev.id, tosHash: v.tosHash, at: ev.created_at })
    refreshConsentRevocations()
    log(`mirror consent: ${v.participant.slice(0, 12)}… → ${String(PUB.inbox).slice(0, 8)}… (440 ${ev.id.slice(0, 12)}…)`)
  }
}

// --- the disclosure/ask side (docs/CONSENT.md §5/§6) ------------------------------------------
// When enforcement HOLDS an un-consented author and asking is configured, the bridge sends the
// consent-request DM. This is waggle's FIRST unsolicited outbound seal to a stranger, so its safety
// is not an allowlist — it is these three rules, all here: ONCE per target ever (a durable ask
// record; silence is a no, §6), a global hourly RATE CAP, and never a muted or grandfathered target.
const mirrorAskedStore = durableSet({ path: MIRRORASKED_PATH, cap: 100000, label: 'consent asks', noun: 'asked targets' })
const mirrorAsked = mirrorAskedStore.mem
const askInFlight = new Set()   // prevents two rapid holds double-sending before the first records
let askWindowStart = 0, askWindowCount = 0
function askRateOk() {
  const t = Date.now()
  if (t - askWindowStart >= 3600_000) { askWindowStart = t; askWindowCount = 0 }
  if (askWindowCount >= PUB.mirrorAskPerHour) return false
  askWindowCount++
  return true
}
// The UNSIGNED prefill 440 the participant need only sign (Dennis's prefill-signer). Its `tos` is the
// derived expected hash, so a signed-unchanged prefill verifies against the version-bound gate by
// construction; the fresh salt rides in the da-scope tag the participant signs.
function buildConsentPrefill() {
  const salt = randomBytes(16).toString('hex')
  return {
    kind: 440, created_at: Math.floor(Date.now() / 1000),
    tags: [['p', BRIDGE_PK], ['da-scope', scopeHash(PUB.inbox, salt), salt], ['da-cap', 'mirror'], ['tos', PUB.mirrorExpectedTosHash || '']],
    content: '',
  }
}
async function sendConsentRequest(targetPub, publish = publishWrapToRelays) {
  if (!hasBridgeKey() || !PUB.mirrorConsentTermsUrl || !PUB.mirrorExpectedTosHash) return 0
  if (!askRateOk()) { err(`consent ask: rate cap ${PUB.mirrorAskPerHour}/h reached — not asking ${targetPub.slice(0, 12)}… this window`); return 0 }
  const accepted = await returnLaneSend(targetPub, {
    template: 'consent_request',
    slots: { community: PUB.mirrorConsentCommunity, termsUrl: PUB.mirrorConsentTermsUrl, prefill: buildConsentPrefill() },
  }, { lane: 'consent-ask' }, publish).catch(() => 0)
  if (accepted >= 1) { mirrorAskedStore.commit(targetPub); log(`consent ask -> ${targetPub.slice(0, 12)}… (disclosure DM sealed)`) }
  else err(`consent ask -> ${targetPub.slice(0, 12)}…: seal reached no relay — NOT marked asked, retries on the next hold`)
  return accepted
}
// Ask once, and only when: asking is configured, the target is a fresh subject with no consent yet,
// and it is neither muted (an explicit prior no) nor grandfathered. Fire-and-forget from the hold.
// `send` is injectable so the guard logic is testable without a socket.
function maybeAskConsent(targetPub, send = sendConsentRequest) {
  if (!PUB.mirrorConsentTermsUrl || !hasBridgeKey()) return false
  if (mirrorAsked.has(targetPub) || mirrorConsent.has(targetPub) || askInFlight.has(targetPub)) return false
  if (PUB.muted.includes(targetPub) || PUB.mirrorGrandfathered.includes(targetPub)) return false
  askInFlight.add(targetPub)
  Promise.resolve(send(targetPub)).finally(() => askInFlight.delete(targetPub))
  return true
}

// --- delivery ---------------------------------------------------------------
// Deliver a SEALED 1059 into the recipient's Buzz inbox. The agent unwraps it.
// `src` describes the unwrap path for the recipient: a DM opens with the agent's own
// key; a channel wrap opens with the plane key the agent derives from community_root.
function forward(rec, ev, src) {
  if (rec.inbox.startsWith('INBOX_UUID_')) { err(`route: ${rec.name} inbox unprovisioned — dropping ${ev.id.slice(0, 12)}…`); return }
  // Concord label is deliberately explicit about the inversion: the outer p-tag is a random
  // DECOY (not you), routing is by author, and decryption is via the channel plane key you
  // derive from the #general community_root — NOT an ECDH seal to any p-tag. A member whose
  // runtime lacks that root cannot open it; say so, rather than "go unwrap," so a missing
  // Concord grant reads as a provisioning gap instead of a bad route. (Cost six confused
  // rounds with a team member, 2026-07-24, before this said so.)
  if (FORWARD_MODE !== 'buzz') {
    log(`FORWARD[dryrun] -> ${rec.name} inbox ${rec.inbox}: ${src && src.channel ? `channel ${src.channel}` : 'DM'} 1059 ${ev.id.slice(0, 12)}… (${JSON.stringify(ev).length} B)`)
    return
  }
  if (process.env.WB_STUB_SEND) { log(`FORWARD[stub] -> ${rec.name} inbox ${rec.inbox}: 1059 ${ev.id.slice(0, 12)}…`); return }

  // #191 option 1: if the box holds this channel's plane key, decrypt HERE and deliver plaintext.
  // Any failure — a malformed wrap, an epoch we can't open — falls back to the sealed_envelope
  // below rather than dropping the message. The fallback is load-bearing: both this and route()
  // mark the event seen before the send resolves, so a throw that reached emit would lose the
  // message permanently. Decrypt-or-seal is decided synchronously, before that point.
  let descriptor = null
  let decrypted = false
  if (src && src.planeKey) {
    try {
      const { rumor } = openChannelWrap(src.planeKey, ev)
      descriptor = {
        template: 'channel_plaintext',
        dest: rec.inbox,
        slots: { channel: src.channel, sender: rumor.pubkey, body: String(rumor.content == null ? '' : rumor.content), replyTo: ev.id },
      }
      // Wake gate (#dead-wake, 2026-08-03): buzz-acp's `subscribe=Mentions` fires a seat wake ONLY
      // on a message carrying that seat's p-tag. A forward is authored by the bridge key and its
      // display body is de-fanged, so with no explicit recipient p-tag the seat never wakes on a
      // #general post that named it — the crew went silent on the plane for ~10 h on 2026-08-03.
      // Propagate the ORIGINAL rumor's p-tags: wake this recipient IFF the post actually p-tagged
      // them, so a post addressing nobody wakes nobody (no fan-out storm — safe now that meh=queue
      // means a mid-turn wake queues rather than cancel+merge-restarts). The @name in the body
      // stays de-fanged; the wake rides the explicit --mention p-tag, not the rendered text.
      if (rec.npub_hex && (rumor.tags || []).some(t => t[0] === 'p' && String(t[1] || '').toLowerCase() === rec.npub_hex)) {
        descriptor.mention = rec.npub_hex
      }
      decrypted = true
    } catch (e) {
      err(`FORWARD decrypt ERR -> ${rec.name}: ${e.message} — sealed fallback for ${ev.id.slice(0, 12)}…`)
    }
  }
  if (!descriptor) {
    descriptor = {
      template: 'sealed_envelope',
      dest: rec.inbox,
      slots: { name: rec.name, channel: (src && src.channel) || undefined, wrapJson: JSON.stringify(ev) },
    }
  }
  emit(descriptor).then(({ stdout }) => {
    log(`FORWARD[buzz] ok -> ${rec.name} inbox: ${decrypted ? 'plaintext ' : ''}${src && src.channel ? `${src.channel} ` : 'DM '}1059 ${ev.id.slice(0, 12)}…`)
    journalSend(parseBuzzEventId(stdout), { kind: 9, dest: rec.inbox, lane: 'sealed' })
  }).catch(e => {
    err(`FORWARD[buzz] ERR -> ${rec.name}: ${e.message}`)
    // The event was marked seen before this send (route()), and the mark is per EVENT, not per
    // recipient — so on a plane fan-out the others received it and this one silently did not.
    // That asymmetry is what made the 2026-08-01 loss read as "that agent isn't responding".
    recordUndelivered({ lane: 'sealed', dest: rec.inbox, recipient: rec.name, id: ev.id, author: ev.pubkey, reason: e.message })
  })
}

function route(ev) {
  if (!ev || !ev.id || seen.has(ev.id)) return

  // Channel-plane traffic: routed by AUTHOR (the derived plane pubkey), not by p-tag.
  // Every configured member of that channel gets a copy; each decrypts with the plane key.
  const plane = PLANES[ev.pubkey]
  if (plane) {
    const nowMs = Date.now()
    const boot = l2BootRemaining > 0
    // Lane-2 caps: plane/global gate first (drop fans out to nobody), then the
    // per-recipient wake-rate gate filters WHO receives this one.
    if (!l2PlaneOk(ev.pubkey, ev, nowMs)) { if (FORWARD_MODE === 'buzz') markSeen(ev.id); return }
    const recips = plane.recipients.filter(r => l2RecipientOk(ev.pubkey, r.inbox, ev, nowMs, boot))
    if (!recips.length) { if (FORWARD_MODE === 'buzz') markSeen(ev.id); return }
    // Same dedup discipline as DMs: only commit seen on a real buzz-mode delivery into a
    // provisioned inbox, so a dryrun or a placeholder inbox never suppresses later backfill.
    const willDeliver = FORWARD_MODE === 'buzz' && recips.some(r => !r.inbox.startsWith('INBOX_UUID_'))
    if (willDeliver) markSeen(ev.id)
    for (const r of recips) forward(r, ev, { channel: plane.name, planeKey: plane.planeKey })
    return
  }

  const ps = (ev.tags || []).filter(t => t[0] === 'p').map(t => t[1])
  // Relay lane (DESIGN_RELAY_INGRESS): a wrap p-tagged to waggle's OWN key is mail for us to open,
  // not a lane we carry for an agent — handled before the forward path, since our key is not in
  // TARGETS. Fully inert while relay_channels is empty (default-closed).
  if (BRIDGE_PK && PUB && PUB.relayChannels && PUB.relayChannels.length && ps.includes(BRIDGE_PK)) return handleRelayIngress(ev)
  const hits = ps.filter(p => TARGETS.includes(p))
  if (!hits.length) return // not for us; do NOT record — keep the dedup store to real deliveries
  // Record dedup ONLY for a genuinely committed delivery: buzz mode into at least
  // one provisioned inbox. Otherwise (dryrun, or DMs that arrived while inboxes were
  // still placeholders) we must NOT mark seen, or the eventual go-live backfill would
  // silently skip DMs that were never actually delivered. Marked synchronously so a
  // second relay serving the same wrap can't double-send before the first records it.
  const willDeliver = FORWARD_MODE === 'buzz' && hits.some(p => !RECIPIENTS[p].inbox.startsWith('INBOX_UUID_'))
  if (willDeliver) markSeen(ev.id)
  for (const p of hits) forward(RECIPIENTS[p], ev)
}

// --- public kind:1 delivery & routing ---------------------------------------
// A5: clamp a note's self-claimed created_at into [now-window, now]. A note stamped far in
// the future can't jump the queue; one stamped years ago can't bury itself. Backfill ordering
// sorts on the clamped value and the watermark (A3) advances on it, so a spoofed stamp can
// neither reorder the batch nor poison the resume point. The original is kept as a *claim*.
function clampCreated(ts, nowSec) {
  const n = Number(ts) || 0
  const c = Math.max(nowSec - PUB.window, Math.min(n, nowSec))
  return { clamped: c, outOfRange: n !== c }
}

// A6: sliding-window rate limiters (public lane only). Every drop is LOGGED with a reason —
// nothing is ever silently discarded. In-memory by design: a restart resets the windows, which
// is safe because durable id-dedup (A2) still prevents re-delivery of any already-forwarded id.
const slide = (arr, nowMs, win) => { while (arr.length && arr[0] <= nowMs - win) arr.shift(); return arr }

// One limiter, built twice. The public and relay lanes ran structurally identical checks — the
// same three windows, the same `slide`, the same PUB.* caps, the same commit-on-pass ordering —
// differing only in which counter maps they touched and how the drop line reads. That is an
// argument for separate STATE, which the lanes genuinely need so neither can starve the other. It
// was never an argument for separate LOGIC: a cap changed in one copy and not the other yields two
// different policies with nothing to notice it, because each lane's suite exercises only its own.
//
// Every call to laneLimiter builds its OWN three counters, so the lanes stay exactly as independent
// as they were. What they can no longer do is drift apart on policy.
//
// The drop lines are preserved byte-for-byte — operators grep these. `ref` is the trailing
// identifier: the event id on the public lane, where the subject is the note's AUTHOR and the id
// adds information; nothing on the relay lane, where the subject IS the sender and repeating it
// would be noise, so the tail falls back to the subject itself exactly as before.
function laneLimiter({ tag, subjectNoun }) {
  const lane = [], byChannel = new Map(), bySubject = new Map()
  return function ok(subject, dest, nowMs, ref = null) {
    const who = String(subject).slice(0, 12)
    const tail = ref ? ` — ${ref}` : ` — ${who}…`
    const subjTail = ref ? ` — ${ref}` : ''   // its own line already names the subject
    const l = slide(lane, nowMs, 3600_000)
    if (l.length >= PUB.lanePerHour) { err(`${tag} drop[rate]: lane cap ${PUB.lanePerHour}/h${tail}`); return false }
    const perCh = slide(byChannel.get(dest) || [], nowMs, 60_000)
    if (perCh.length >= PUB.channelPerMin) { err(`${tag} drop[rate]: channel cap ${PUB.channelPerMin}/min for ${dest}${tail}`); return false }
    const perS = slide(bySubject.get(subject) || [], nowMs, 60_000)
    if (perS.length >= PUB.replierPerMin) { err(`${tag} drop[rate]: ${subjectNoun} cap ${PUB.replierPerMin}/min for ${who}…${subjTail}`); return false }
    l.push(nowMs); perCh.push(nowMs); byChannel.set(dest, perCh); perS.push(nowMs); bySubject.set(subject, perS)
    return true
  }
}

const publicLimiter = laneLimiter({ tag: 'PUBLIC', subjectNoun: 'replier' })
// Public lane. Signature unchanged: it passes the whole event because its drop line names the note
// as well as the author.
function rateOk(ev, dest, nowMs) {
  return publicLimiter(ev.pubkey, dest, nowMs, `${ev.id.slice(0, 12)}…`)
}

// Relay lane (DESIGN_RELAY_INGRESS MUST-FIX 2). The public lane keys its subject cap on ev.pubkey;
// on a gift wrap that is the EPHEMERAL key, fresh per wrap, so per-sender limiting there is a
// no-op. This lane re-keys on the AUTHENTICATED seal.pubkey and so is POST-DECRYPT only — a flood
// is bounded before it by the decrypt budget, not here. Same PUB.* caps (§3: reuse, no new cap),
// its own counters.
const relayLimiter = laneLimiter({ tag: 'RELAY', subjectNoun: 'sender' })
function relayRateOk(sender, dest, nowMs) {
  return relayLimiter(sender, dest, nowMs)
}

// §7 decrypt-budget window + the pre-decrypt drop counter. The counter is LOUD by design: it is the
// number the #116 silence/accept-count alarm watches, so a flood spikes a monitored signal rather
// than a dead integer. The wire INTO the alarm lands once #116/#121 is in main (that seam does not
// exist here yet); the counter and its accessor exist now so the alarm can subscribe without a
// second edit to this path. `notRelay` is deliberately EXCLUDED from the flood total below — a
// well-formed DM to waggle that simply isn't a relay request is not an attack signal.
const relayDecWin = []
const relayDropCounts = { budget: 0, size: 0, decrypt: 0, verify: 0, mismatch: 0, notRelay: 0 }
function relayDropTotalPreAuth() {
  return relayDropCounts.budget + relayDropCounts.size + relayDropCounts.decrypt + relayDropCounts.verify + relayDropCounts.mismatch
}

// Friendly names: best-effort kind:0 lookup on the public relays, cached with a TTL. A
// profile name is UNTRUSTED, attacker-controlled text rendered outside the content fence —
// markdown/mention/link characters are stripped and the length capped before use.
const nameCache = new Map() // pubkey -> { name: string|null, ts }
const NAME_TTL_MS = 3600_000
// Bounded like every other in-memory store here (rlDropLogged, seen, relaySeen). The TTL only
// decides when an entry is re-fetched, never when it leaves — so without a cap the map grows one
// entry per distinct author ever reposted, on a process meant to run for months. Insertion-ordered
// eviction, same shape as rlDropOnce.
const NAME_CACHE_CAP = Number(process.env.NAME_CACHE_CAP || 5000)
function cacheName(pubkey, name) {
  nameCache.set(pubkey, { name, ts: Date.now() })
  if (nameCache.size > NAME_CACHE_CAP) nameCache.delete(nameCache.keys().next().value)
}

function fetchProfileName(pubkey, mkSocket) {
  const hit = nameCache.get(pubkey)
  if (hit && Date.now() - hit.ts < NAME_TTL_MS) return Promise.resolve(hit.name)
  // Best-effort: take the best name any relay offers; settle when all have answered or the 2s
  // budget runs out. A relay that never replies costs the timeout, never a hang.
  let best = null
  return fanout(PUB.relays, {
    timeoutMs: 2000,
    mkSocket,
    each: (ws, done) => {
      ws.on('open', () => ws.send(JSON.stringify(['REQ', 'nm', { kinds: [0], authors: [pubkey], limit: 1 }])))
      ws.on('message', d => {
        try {
          const m = JSON.parse(d.toString())
          if (m[0] === 'EVENT' && m[2] && m[2].pubkey === pubkey) {
            const p = JSON.parse(m[2].content || '{}')
            const raw = String(p.display_name || p.name || '').replace(/[`@\[\]()\n\r*_~]/g, '').trim().slice(0, 32)
            if (raw) best = raw
          }
          if (m[0] === 'EOSE') done()
        } catch { /* ignore bad frames */ }
      })
      ws.on('error', done)
    },
    collect: () => { cacheName(pubkey, best); return best },
  })
}

// No unwrap label, no key — already-public content.
async function forwardPublic(ev, why, dest, quarantine) {
  const author = ev.pubkey ? ev.pubkey.slice(0, 16) : '?'
  // If this public note is an admitted agent's OWN words (author === a return_lane delivery key),
  // record the repost as agent-authored so the return-lane detector never echoes it back and can
  // resolve a later reply to it. Keyed on the agent's real key, never on the bridge that signs it.
  const agent = PUB ? ((PUB.returnLane.find(r => r.npub_hex === String(ev.pubkey || '').toLowerCase()) || {}).npub_hex || null) : null
  const nowSec = Math.floor(Date.now() / 1000)
  const { clamped, outOfRange } = clampCreated(ev.created_at, nowSec)
  if (FORWARD_MODE !== 'buzz') {
    log(`PUBLIC[dryrun] -> ${quarantine ? 'STAGING' : 'inbox'} ${dest}: kind1 ${ev.id.slice(0, 12)}… by ${author}… (${why})${outOfRange ? ' [clamped]' : ''} :: ${JSON.stringify((ev.content || '').slice(0, 80))}`)
    return
  }
  // Reposted content is untrusted public text. It is delivered as a fenced block so a note
  // that happens to contain "@Name" or markdown can't inject a Buzz mention/format.
  const body = String(ev.content || '')
  // Friendly author identity: display name from the author's public kind:0 (UNTRUSTED text —
  // sanitized, rendered outside the fence) plus the npub, which is what a reader can
  // actually paste into a client. Best-effort with a 2s budget; falls back to npub alone.
  let name = null
  if (!process.env.WB_STUB_SEND) { try { name = await fetchProfileName(ev.pubkey) } catch { name = null } }
  let npub = null
  try { npub = nip19.npubEncode(ev.pubkey) } catch { npub = null }
  // Heavily contracted npub for the attribution line — enough to recognize/verify, not a wall.
  const npubShort = npub ? `${npub.slice(0, 10)}…${npub.slice(-5)}` : (ev.pubkey || '?').slice(0, 12) + '…'
  // #94: only a live NIP-DA grant earns live @mentions. grantSet is exactly the signed-and-
  // revocable set (`processGrantEvent`), so a 441 removes the ability to summon the room in the
  // same act that removes admission — no second switch to forget. Every other reason a note
  // reaches here (mirrored feed, standing follow, human-released quarantine) stays defused.
  const liveRefs = !quarantine && !!ev.pubkey && grantSet.has(String(ev.pubkey).toLowerCase())
  const descriptor = quarantine
    ? {
      template: 'quarantine_header',
      dest,
      slots: {
        body,
        approver: (quarantine && PUB.approverMention) || undefined,
        name,
        npub: npub || ev.pubkey,
        ts: clamped,
        claimedTs: outOfRange && ev.created_at ? Number(ev.created_at) : undefined,
        why,
        id: ev.id,
      },
    }
    : { template: 'released_post', dest, slots: { body, name, npubShort, liveRefs } }
  // Test seam: exercise the full buzz-mode path (markSeen/watermark/posted-map) without a
  // network send. The synthetic buzz id (orig id reversed — still 64 hex, still unique)
  // exercises the same capture shape the live path records.
  if (process.env.WB_STUB_SEND) {
    log(`PUBLIC[stub] -> ${quarantine ? 'STAGING' : 'inbox'} ${dest}: kind1 ${ev.id.slice(0, 12)}… by ${author}… (${why})`)
    recordPosted({ id: ev.id, author: ev.pubkey, buzz: ev.id.split('').reverse().join(''), dest, q: !!quarantine, ts: nowSec, agent })
    return
  }
  return emit(descriptor).then(({ stdout }) => {
    log(`PUBLIC[buzz] ok -> ${quarantine ? 'STAGING' : 'inbox'} ${dest}: kind1 ${ev.id.slice(0, 12)}… by ${author}… (${why})`)
    // A7: record the repost so the author's later kind:5 can withdraw it. A null buzz id
    // (stdout didn't carry one) degrades to the follow-up-tombstone tier — logged, safe.
    const buzzId = parseBuzzEventId(stdout)
    if (!buzzId) err(`A7 warn[no-id]: could not capture buzz event id for ${ev.id.slice(0, 12)}… — withdrawal will use follow-up tier`)
    recordPosted({ id: ev.id, author: ev.pubkey, buzz: buzzId, dest, q: !!quarantine, ts: nowSec, agent })
    journalSend(buzzId, { kind: 9, dest, lane: 'public' })
  }).catch(e => {
    err(`PUBLIC[buzz] ERR -> ${dest}: ${e.message}`)
    recordUndelivered({ lane: 'public', dest, recipient: null, id: ev.id, author: ev.pubkey, reason: e.message })
  })
}

function routePublic(ev) {
  if (!ev || !ev.id || ev.kind !== 1 || seen.has(ev.id)) return
  // Signature verification is MANDATORY, and it comes BEFORE the trust classification below —
  // because that classification reads `ev.pubkey`, which is just a claim until the signature
  // proves it. A relay is not a trusted party: the lane holds open REQs to several public ones,
  // and ONE hostile or compromised relay is enough to serve a note that says whatever it likes
  // under a watched author's key. Unverified, the highest-trust paths were the unguarded ones —
  // 'mirrored feed' and 'granted participant' route STRAIGHT to the community channel, skipping
  // the quarantine a stranger gets, and a granted author additionally earns live @mentions
  // (liveRefs below), so a forgery could summon the room. The release path already verified
  // (handleCommand), and so did routeDelete and processGrantEvent; this path did not, which
  // inverted the gradient — the more we trusted an identity, the less we checked it.
  // markSeen so the same forgery re-served by another relay is dropped cheaply.
  let okSig = false
  try { okSig = verifyEvent(ev) } catch { okSig = false }
  if (!okSig) {
    err(`PUBLIC drop[bad-signature]: kind1 ${ev.id.slice(0, 12)}… claims ${String(ev.pubkey || '?').slice(0, 12)}…`)
    if (FORWARD_MODE === 'buzz') markSeen(ev.id)
    return
  }
  // A1: classify by TRUST, not just by match. An allowlisted watched author is trusted; a
  // reply from anyone else is an untrusted stranger and is quarantined.
  const trusted = PUB.authors.includes(ev.pubkey)
  let why = null, quarantine = false
  if (trusted) why = 'mirrored feed'
  else if (grantSet.has(ev.pubkey)) why = 'granted participant' // §4.1 S3: admitted by signed 440, revocable by 441
  else if (PUB.events.length) {
    const es = (ev.tags || []).filter(t => t[0] === 'e').map(t => t[1])
    if (es.some(id => PUB.events.includes(id))) {
      if (PUB.trustedRepliers.includes(ev.pubkey)) why = 'standing follow' // reply-trust: no queue, no feed mirror
      else { why = 'reply to our note'; quarantine = true }
    }
  }
  if (!why) return

  // In-door consent gate (#131/#132, docs/CONSENT.md §8). DEFAULT-OFF: the whole block is inert
  // unless mirror_require_consent is on, so the deploy changes nothing and the crew keeps mirroring.
  // When on, a MIRRORED FEED (#131) or an un-trusted REPLY (#132) forwards only if its author holds
  // a consent record — or is grandfathered (the pre-consent crew). Granted participants and standing
  // follows are already consensual (they hold a key / were vouched by the maintainer) and are not
  // gated here. A held reply is dropped BEFORE staging — the invisible pre-consent hold §6 requires,
  // so the community never sees un-consented content. Never a silent drop (§7).
  if (PUB.mirrorRequireConsent && (why === 'mirrored feed' || why === 'reply to our note')) {
    const author = String(ev.pubkey).toLowerCase()
    // Consent must be PRESENT and (when a current-terms hash is configured) bound to THOSE terms.
    // §7 promises a material ToS change does not silently ride an old yes: with mirror_expected_tos_hash
    // set, a consent whose `tosHash` differs from the current terms fails closed — a v1 consenter is
    // held after a v1→v2 bump until they re-consent. Without it configured, the gate is presence-only
    // and warns once that §7 version-binding is unenforced (the honest state, not a silent gap).
    const rec = mirrorConsent.get(author)
    const consentBinds = rec && (!PUB.mirrorExpectedTosHash || rec.tosHash === PUB.mirrorExpectedTosHash)
    if (!consentBinds && !PUB.mirrorGrandfathered.includes(author)) {
      const why2 = rec && PUB.mirrorExpectedTosHash ? 'consent is bound to superseded terms' : 'participant has not consented'
      err(`PUBLIC hold[no-consent]: ${why} from ${author.slice(0, 12)}… held — ${why2} (default-closed, §8)`)
      maybeAskConsent(author)   // §5/§6: send the disclosure DM once, if asking is configured
      if (FORWARD_MODE === 'buzz') markSeen(ev.id)
      return
    }
  }

  // A1: an un-allowlisted reply routes to STAGING, never a community channel. With no staging
  // channel configured we HOLD (log only) — default-closed, so a stranger's reply can never
  // reach the community channel by default. (A reply whose author is allowlisted is trusted
  // and skips staging — the watch_authors set gates it in.)
  let dest = PUB.inbox
  if (quarantine) {
    // A muted author was explicitly rejected by the approver — their replies no longer
    // reach staging (still logged, per the A6 no-silent-drop rule).
    if (PUB.muted.includes(ev.pubkey)) { err(`PUBLIC drop[muted]: reply ${ev.id.slice(0, 12)}… by muted author ${ev.pubkey.slice(0, 12)}…`); markSeen(ev.id); return }
    if (!PUB.staging) { err(`PUBLIC hold: no staging channel — quarantined reply ${ev.id.slice(0, 12)}… by ${ev.pubkey.slice(0, 12)}… NOT delivered (default-closed)`); markSeen(ev.id); return }
    dest = PUB.staging
  }

  // A6: size cap then rate limits — every drop logged, none silent. markSeen on a drop so the
  // same id from another relay isn't reprocessed.
  const bytes = Buffer.byteLength(String(ev.content || ''), 'utf8')
  if (bytes > PUB.maxContentBytes) { err(`PUBLIC drop[size]: content ${bytes}B > cap ${PUB.maxContentBytes}B — ${ev.id.slice(0, 12)}…`); markSeen(ev.id); return }
  const nowMs = Date.now()
  if (!rateOk(ev, dest, nowMs)) { markSeen(ev.id); return }

  // A2/A3: commit-before-dispatch. markSeen persists the id synchronously BEFORE the async
  // send, so a kill -9 mid-send can never re-post it — we favor "never double-post" (the §8
  // firehose line) over "never drop". A3: advance the watermark on the CLAMPED created_at.
  if (FORWARD_MODE === 'buzz') {
    markSeen(ev.id)
    bumpPubWatermark(clampCreated(ev.created_at, Math.floor(nowMs / 1000)).clamped)
  }
  forwardPublic(ev, why, dest, quarantine)
}

// --- A7: NIP-09 deletion propagation ----------------------------------------
// A watched author's kind:5 withdraws our reposted copy of their note. Scope is
// deliberately WATCHED AUTHORS ONLY: kind:5 can't be pre-subscribed for arbitrary future
// strangers, and a stranger's quarantined reply is human-reviewed anyway (out of scope,
// per C decision). Signature verification is MANDATORY here — unlike the repost path,
// where the worst case is a mislabeled repost, a forged kind:5 would destroy our copies.
const rlDeletes = [] // [tsMs...] lane-wide hourly window (A6 discipline: drops logged)
function routeDelete(ev) {
  if (!ev || !ev.id || ev.kind !== 5 || seen.has(ev.id)) return
  if (!PUB.authors.includes(ev.pubkey)) return // scope: watched authors only
  let okSig = false
  try { okSig = verifyEvent(ev) } catch { okSig = false }
  if (!okSig) { err(`A7 drop[bad-signature]: kind5 ${ev.id.slice(0, 12)}… claims ${String(ev.pubkey || '?').slice(0, 12)}…`); return }
  const targets = (ev.tags || []).filter(t => t[0] === 'e' && /^[0-9a-f]{64}$/i.test(t[1] || '')).map(t => t[1].toLowerCase())
  const acts = []
  for (const id of targets) {
    const entry = postedMap.get(id)
    if (!entry || entry.deleted) continue
    // NIP-09 authorship rule: a watched author must not be able to delete ANOTHER
    // watched author's reposted note.
    if (entry.author !== ev.pubkey) { err(`A7 drop[author-mismatch]: kind5 by ${ev.pubkey.slice(0, 12)}… targets ${id.slice(0, 12)}… posted by ${String(entry.author).slice(0, 12)}…`); continue }
    acts.push({ id, entry })
  }
  if (!acts.length) return // unknown/already-withdrawn targets: leave unseen so a later repost+delete still works
  const nowMs = Date.now()
  slide(rlDeletes, nowMs, 3600_000)
  if (rlDeletes.length >= PUB.deletesPerHour) { err(`A7 drop[rate]: delete cap ${PUB.deletesPerHour}/h — ${ev.id.slice(0, 12)}…`); return }
  rlDeletes.push(nowMs)
  if (FORWARD_MODE !== 'buzz') {
    for (const a of acts) log(`A7[dryrun] would withdraw ${a.id.slice(0, 12)}… (buzz ${a.entry.buzz ? a.entry.buzz.slice(0, 12) + '…' : 'unknown'}) per kind5 ${ev.id.slice(0, 12)}…`)
    return
  }
  markSeen(ev.id) // A2 discipline: commit before dispatch — a bounce can't re-run the withdrawal
  for (const a of acts) withdraw(a.id, a.entry, ev)
}

// Three-tier withdrawal, logging which tier landed: (1) CLI-native delete with a public
// tombstone reason, (2) edit the copy down to a tombstone, (3) follow-up tombstone post
// when we never captured a buzz id or both mutations fail.
function withdraw(origId, entry, delEv) {
  const done = (tier) => { recordWithdrawn(origId); log(`A7 ok[${tier}]: withdrew ${origId.slice(0, 12)}… per kind5 ${delEv.id.slice(0, 12)}…`) }
  const stone = { author: entry.author, origId, delId: delEv.id }
  if (process.env.WB_STUB_SEND) { done(entry.buzz ? 'stub-delete' : 'stub-post'); return }
  const followUp = () => emit({ template: 'a7_tombstone', dest: entry.dest, slots: stone })
    .then(() => done('follow-up'))
    .catch(e3 => err(`A7 ERR[all-tiers]: could not withdraw ${origId.slice(0, 12)}…: ${e3.message}`))
  if (!entry.buzz) return followUp()
  emit({ template: 'a7_delete', targetId: entry.buzz, slots: {} })
    .then(() => done('delete'))
    .catch(() => emit({ template: 'a7_tombstone_edit', targetId: entry.buzz, slots: stone })
      .then(() => done('edit'))
      .catch(() => followUp()))
}

// --- In-Buzz approval console -------------------------------------------------
// The staging channel doubles as the approval surface: an authorized approver replies to a
// quarantined post with one word — approve | watch | mute | reject — and the bridge acts,
// confirming in the same thread. A command is an ordinary SIGNED kind:9 event; authority is
// the author pubkey checked against cfg.public.approvers. No command line, no ssh.
//   approve — release this one note to the community channel
//   follow  — release it AND grant reply-trust (their future replies skip the queue); 'watch' = alias
//   mute    — durable reject: this author's replies stop reaching staging
//   reject  — explicit no (records the decision; author stays quarantined)
const stagingByBuzzId = new Map() // buzz event id of a staging post -> { orig, author, dest }

// First-match: the first relay to serve the event by id ends the whole fan-out. A relay that never
// answers is not waited on beyond the budget. (The old copy never cleared its 10s timer, so the
// process held it open after settling; fanout disarms it.)
function fetchEventById(id, mkSocket) {
  let found = null
  return fanout(PUB.relays, {
    timeoutMs: 10000,
    mkSocket,
    each: (ws, done, settleNow) => {
      ws.on('open', () => ws.send(JSON.stringify(['REQ', 'fx', { ids: [id] }])))
      ws.on('message', d => {
        try {
          const m = JSON.parse(d.toString())
          if (m[0] === 'EVENT' && m[2] && m[2].id === id) { found = m[2]; settleNow() }
        } catch { /* ignore */ }
      })
      ws.on('error', done)
    },
    collect: () => found || null,
  })
}

function mutateConfig(fn) {
  try {
    const fresh = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    fn(fresh)
    writeFileSync(CONFIG_PATH, JSON.stringify(fresh, null, 2) + '\n')
    return true
  } catch (e) { err(`commands: config write failed: ${e.message}`); return false }
}

// --- watchlist hot-reload (#206 stage 1) ------------------------------------------------------
// watch_authors was the one trust input that needed a process RESTART to change. These change it
// at runtime: PUB.authors is updated, the config is rewritten (mutateConfig — the same path mutes
// already use), and every live relay connection re-issues its watched-author filter IN PLACE —
// mirroring how a grant already re-opens the granted-author subscription without a restart. Each
// connectPublic registers its re-subscribe in WATCH_REFRESHERS; refreshWatched fans a change out.
const WATCH_REFRESHERS = new Set()
function refreshWatched() {
  for (const f of WATCH_REFRESHERS) { try { f() } catch (e) { err(`watchlist: refresh failed: ${e?.message || '?'}`) } }
}
function addWatchAuthor(pk) {
  const hex = String(pk || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) return { ok: false, reason: 'not a 64-hex pubkey' }
  if (PUB.authors.includes(hex)) return { ok: true, already: true }
  // Persistence is the commit point.  A runtime-only addition would work until the next
  // restart, then silently disappear — worse than refusing the operator's request.  Write
  // first; only a durable success may alter the active filter.
  if (!mutateConfig(c => { c.public.watch_authors = Array.from(new Set([...(c.public.watch_authors || []).map(s => String(s).toLowerCase()), hex])) })) {
    return { ok: false, reason: 'could not persist watchlist' }
  }
  PUB.authors.push(hex)
  refreshWatched()
  log(`watchlist: +${hex.slice(0, 12)}… — now ${PUB.authors.length} watched, subscription updated (no restart)`)
  return { ok: true, added: true }
}
function removeWatchAuthor(pk) {
  const hex = String(pk || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) return { ok: false, reason: 'not a 64-hex pubkey' }
  const i = PUB.authors.indexOf(hex)
  if (i === -1) return { ok: true, already: true }
  // Same transaction boundary as add: do not let a failed write create a temporary live
  // removal that a restart reverses.
  if (!mutateConfig(c => { c.public.watch_authors = (c.public.watch_authors || []).map(s => String(s).toLowerCase()).filter(a => a !== hex) })) {
    return { ok: false, reason: 'could not persist watchlist' }
  }
  PUB.authors.splice(i, 1)
  refreshWatched()
  log(`watchlist: -${hex.slice(0, 12)}… — now ${PUB.authors.length} watched, subscription updated (no restart)`)
  return { ok: true, removed: true }
}

// A3: this took a `text: string` until #134, and its unrecognized-verb caller passed runtime
// operator input straight through — the free-text path that already had a live caller, not a
// hypothetical one. It now takes a VERB from the catalogue's closed set; the words live in
// egress.mjs where no caller can reach them.
function replyInStaging(parentBuzzId, verb, slots = {}) {
  emit({ template: verb, dest: PUB.staging, parentId: parentBuzzId, slots })
    .catch(e => err(`commands: confirmation reply failed: ${e.message}`))
}

// #206 stage 2. The staging channel is the signed operator console: an approver may manage the
// feed watchlist without a root shell, but only through an explicit two-word namespace so ordinary
// conversation cannot resemble a command. `watch` remains an alias for the DIFFERENT `follow`
// action below; whole-feed mirroring uses `waggle mirror` / `waggle unmirror`.
function watchlistTarget(raw) {
  const value = String(raw || '').trim().toLowerCase()
  if (/^[0-9a-f]{64}$/.test(value)) return value
  if (!value.startsWith('npub1')) return null
  try {
    const decoded = nip19.decode(value)
    return decoded.type === 'npub' && typeof decoded.data === 'string' && /^[0-9a-f]{64}$/.test(decoded.data)
      ? decoded.data.toLowerCase() : null
  } catch { return null }
}
function handleWatchlistCommand(m, words) {
  const action = words[1]
  if (!['mirror', 'unmirror'].includes(action) || words.length !== 3) return false
  const target = watchlistTarget(words[2])
  if (!target) {
    markSeen('cmd:' + m.id)
    replyInStaging(m.id, 'watchlist_ack', { verb: 'bad_target' })
    return true
  }
  const result = action === 'mirror' ? addWatchAuthor(target) : removeWatchAuthor(target)
  markSeen('cmd:' + m.id) // command is durable before its acknowledgement can be retried
  if (!result.ok) replyInStaging(m.id, 'watchlist_ack', { verb: 'persist_failed' })
  else if (result.added) replyInStaging(m.id, 'watchlist_ack', { verb: 'added', author: target })
  else if (result.removed) replyInStaging(m.id, 'watchlist_ack', { verb: 'removed', author: target })
  else replyInStaging(m.id, 'watchlist_ack', { verb: action === 'mirror' ? 'already' : 'not_watched', author: target })
  return true
}

async function handleCommand(m) {
  if (!m || !m.id || seen.has('cmd:' + m.id)) return
  if (!PUB.approvers.includes(String(m.pubkey || '').toLowerCase())) return // not an approver: not a command
  const raw = String(m.content || '').trim().toLowerCase()
  const words = raw.split(/\s+/)
  // Explicit signed watchlist administration, only from the staging poller that calls this
  // function. It has no quarantine parent because it manages the list itself, not one note.
  if (words[0] === 'waggle' && handleWatchlistCommand(m, words)) return
  let word = words[0]
  if (word === 'release') word = 'approve' // the labels say "released from quarantine" — honor the word
  if (word === 'watch') word = 'follow'    // the maintainer's verb: follow (watch kept as alias)
  if (!['approve', 'follow', 'mute', 'reject'].includes(word)) {
    // A single unrecognized word from an authorized approver on a pending post deserves an
    // answer, not silence. Multi-word replies are conversation — ignored.
    if (!raw.includes(' ') && raw.length <= 20) {
      const parentTry = (m.tags || []).filter(t => t[0] === 'e').map(t => t[1])[0]
      const stTry = parentTry && stagingByBuzzId.get(String(parentTry).toLowerCase())
      if (stTry && (stTry.q || stTry.dest !== PUB.inbox) && !seen.has('cmd:' + m.id)) {
        markSeen('cmd:' + m.id)
        replyInStaging(m.id, 'console_ack', { verb: 'unrecognized', echo: raw })
      }
    }
    return
  }
  const parent = (m.tags || []).filter(t => t[0] === 'e').map(t => t[1])[0]
  const st = parent && stagingByBuzzId.get(String(parent).toLowerCase())
  if (!st || !(st.q || st.dest !== PUB.inbox)) return // command must anchor to a QUARANTINED post (flag, or legacy staging dest)
  markSeen('cmd:' + m.id) // commit-before-dispatch: a crash can never double-execute a command
  log(`command '${word}' from approver ${m.pubkey.slice(0, 12)}… on ${st.orig.slice(0, 12)}…`)

  if (word === 'reject') return replyInStaging(m.id, 'console_ack', { verb: 'rejected' })

  if (word === 'mute') {
    if (!PUB.muted.includes(st.author)) PUB.muted.push(st.author)
    mutateConfig(c => { c.public.muted_authors = Array.from(new Set([...(c.public.muted_authors || []), st.author])) })
    return replyInStaging(m.id, 'console_ack', { verb: 'muted', author: st.author })
  }

  // approve / watch — release the note (refusing duplicates), then grant trust if asked.
  const prior = postedMap.get(st.orig)
  const alreadyReleased = prior && !prior.deleted && prior.dest === PUB.inbox && !prior.q
  if (!alreadyReleased) {
    const ev = await fetchEventById(st.orig)
    if (!ev) return replyInStaging(m.id, 'console_ack', { verb: 'no_original' })
    let ok = false
    try { ok = verifyEvent(ev) } catch { ok = false }
    if (!ok) return replyInStaging(m.id, 'console_ack', { verb: 'bad_signature' })
    if (!rateOk(ev, PUB.inbox, Date.now())) return replyInStaging(m.id, 'console_ack', { verb: 'rate_capped' })
    forwardPublic(ev, 'released from quarantine', PUB.inbox, false)
  }
  let granted = false
  if (word === 'follow') {
    if (!PUB.trustedRepliers.includes(st.author)) PUB.trustedRepliers.push(st.author)
    mutateConfig(c => { c.public.trusted_repliers = Array.from(new Set([...(c.public.trusted_repliers || []), st.author])) })
    granted = true
  }
  replyInStaging(m.id, alreadyReleased ? 'console_ack_already' : 'console_ack',
    alreadyReleased ? { granted } : { verb: 'released', granted })
}

// --- Return lane (#40) ------------------------------------------------------------------------
// The out door federates and the in door admits, but nothing carried the community's own words
// back OUT to an admitted participant. They could be spoken to in a channel they cannot read.
// An outside teammate who can be addressed but never hears anything is not a participant; they
// are a topic of conversation.
//
// Why the bridge has to do this rather than the participant subscribing for itself: the
// community relay is auth-gated and does not serve an external key. A participant admitted "by
// grant, no account" therefore CANNOT subscribe to the channel it was admitted to. The bridge
// holds workspace access and is the only party that can read the channel and carry it out. This
// is not the tidier design — it is the only available one.
//
// Only mentions are carried, never the whole channel. Forwarding everything would turn the
// bridge into a firehose pointed out of a private room, which is the exact opposite of the
// consent the in door spends all its effort enforcing.
// Return-lane dedup, durable and keyed per (source × recipient) — NOT per message. Finding #4:
// keying on the source id alone (and `break`ing after the first match) delivers a "@a @b" message
// to at most ONE recipient, then marks the whole message seen forever — silent under-delivery the
// instant the roster grows past one. The composite key lets a message fan out to every mentioned
// recipient, each carried exactly once; persistence makes that idempotent across a restart so a
// bounce never re-delivers (finding #1). Same append-only/capped lifecycle as loadSeen/markSeen.
// Persist-on-landed split (finding #2). claim suppresses a double-carry WITHIN a scan/overlap
// immediately, in memory; the DURABLE append happens only once the seal actually reached a relay —
// commit, called on ≥1 accept. A silent 0/N is rolled back so #5's overlap re-read re-carries it,
// and — because it never reached disk — a restart re-carries it too. The earlier
// commit-before-send would instead durably suppress a mention that was never delivered: #1's own
// durability then made the loss permanent and invisible. This lane is the one that uses all four
// verbs, which is why the primitive has them.
const rlSeenStore = durableSet({ path: RLSEEN_PATH, cap: RLSEEN_CAP, label: 'return lane', noun: 'carried (source×recipient) keys' })
const rlSeen = rlSeenStore.mem
const rlKey = (srcId, recipHex) => String(srcId) + '\x1f' + String(recipHex)

// #117: the un-landed carries. rlSeen answers "already carried"; this answers "still owed", and
// the difference matters because the scan cursor advances whether or not a carry landed. A 0/N is
// loud and retried by the overlap re-read, but only while the message stays inside that window —
// an outage sustained past it used to age the carry out and lose it. This queue retries from
// durable storage instead of from the window, so the cursor keeps advancing (no lane-wide stall
// from one dead recipient) and the carry survives anyway.
const rlPending = durableQueue({ path: RLPENDING_PATH, cap: 5000, label: 'return lane pending' })
const loadRlSeen = () => rlSeenStore.load()
const addRlSeen = (key) => rlSeenStore.claim(key)
const dropRlSeen = (key) => rlSeenStore.rollback(key)
const markRlSeen = (key) => rlSeenStore.commit(key)

// Drop-log dedup (finding #2). The signer-gate err() in scanReturnLane fires before the
// per-recipient rlSeen check, so without this a STATIC backlog of non-admitted signers re-logs
// every poll (15s at --limit 30 ≈ 172k lines/day) onto a box whose journals the tripwire reads.
// A drop is a transient observation, not durable state — all we need is "have I already shouted
// about THIS message id". Bounded, in-memory, insertion-ordered eviction keeps it capped.
const rlDropLogged = new Set()
const RL_DROP_LOG_CAP = Number(process.env.RL_DROP_LOG_CAP || 5000)
function rlDropOnce(id) {
  const k = String(id)
  if (rlDropLogged.has(k)) return false
  rlDropLogged.add(k)
  if (rlDropLogged.size > RL_DROP_LOG_CAP) rlDropLogged.delete(rlDropLogged.values().next().value)
  return true
}

// Publish a wrap to the public relays, resolving to the count that returned OK-true. Per-relay OK is
// the ONLY landing signal: a relay 503s or drops silently, and an explicit ["OK", id, false]
// rejection used to read byte-identical to an accept (the loop counted any inbound frame). Finding
// #2. Injectable (the `publish` seam on returnLaneSend) so the send-failure control can drive a
// chosen accept-count with no socket — the same shape #5's scanChannel(fetchPage) uses. WB_STUB_SEND
// keeps the socket-free tests honest: it means "assume it landed on every configured relay", so the
// crypto still runs but the count is positive, never a spurious 0/N.
function publishWrapToRelays(wrap, mkSocket) {
  if (process.env.WB_STUB_SEND) return Promise.resolve(PUB.relays.length || 1)
  // All-settled-with-a-count: per-relay OK-true is the ONLY landing signal. A relay that opens but
  // never OKs is bounded by the budget, and an explicit ["OK", id, false] rejection must not read
  // as an accept — counting any inbound frame was finding #2.
  let accepted = 0
  return fanout(PUB.relays || [], {
    timeoutMs: 10000,
    mkSocket,
    each: (ws, done) => {
      ws.on('open', () => ws.send(JSON.stringify(['EVENT', wrap])))
      ws.on('message', d => {
        try {
          const m = JSON.parse(d.toString())
          if (m[0] === 'OK' && m[1] === wrap.id) { if (m[2]) accepted++; done() }
        } catch { /* non-OK frame */ }
      })
      ws.on('error', done)
    },
    collect: () => accepted,
  })
}

async function returnLaneSend(toHex, descriptor, meta, publish = publishWrapToRelays) {
  if (!hasBridgeKey()) { err('return lane: no bridge key to seal with — skipping'); return 0 }
  try {
    const relays = (PUB.relays || []).length
    // A3 §2.5: the seal/wrap construction and the key both live in nostr_egress.mjs. `descriptor`
    // is {template, slots} — there is no parameter here that could carry a composed sentence.
    const { wrap, accepted, bytes } = await sealAndWrap({ template: descriptor.template, to: toHex, slots: descriptor.slots }, publish)
    // Journal stamped with the accept-count so the durable record is landed-reality, not intent: a
    // 0/N carry is written accepted:0, never a false "sent". The wrap's author is ephemeral and can
    // never trip the tripwire, so this record is a written-down intent — worth making a truthful one;
    // a landed carry (accepted ≥ 1) IS on a relay and so must be journaled for the tripwire.
    journalSend(wrap.id, { kind: 1059, lane: 'return', to: toHex.slice(0, 12), accepted, relays, ...meta })
    if (accepted < 1)
      err(`RETURN 0/${relays} -> ${toHex.slice(0, 12)}…: seal reached NO relay — NOT marked sent, will re-carry (wrap ${wrap.id.slice(0, 12)}…)`)
    else
      log(`RETURN ${accepted}/${relays} -> ${toHex.slice(0, 12)}…: sealed ${bytes}B (wrap ${wrap.id.slice(0, 12)}…)`)
    return accepted
  } catch (e) { err(`return lane: seal/send failed: ${e.message}`); return 0 }
}

// --- relay lane: an admitted agent speaks without speaking publicly (DESIGN_RELAY_INGRESS) ------
// A gift-wrap addressed to waggle's OWN key. waggle opens ITS OWN mail (not a lane it carries for
// others), proves the sender off the SIGNED seal, checks the same grantSet the public lane does,
// renders with the same renderReleased, and posts kind:9 as the roster member it already is — then
// seals an ack back, because the sender is not a member and cannot cold-read-back (§5).
function relayDrop(reason, id, deterministic = true) {
  // Pre-auth drop: UNACKABLE by construction (no verified seal.pubkey), so counted, never echoed
  // (no payload in the log — §7). A deterministic drop marks seen (a replay is then cheap); a
  // transient budget drop does NOT, so a re-served wrap may still succeed within a later window.
  if (relayDropCounts[reason] !== undefined) relayDropCounts[reason]++
  err(`RELAY drop[${reason}]: wrap ${String(id).slice(0, 12)}… (pre-auth, unackable)`)
  if (deterministic) markRelaySeen(id)
}
function relayReject(sender, id, reason, wantCh, extra = {}) {
  // Post-auth reject: the sender IS proven, so the refusal is ACKED — a drop and a silence must not
  // look the same (§5). Marked seen: the decision is deterministic for this wrap id.
  err(`RELAY reject: ${reason}${extra.cap ? ` (${extra.cap}B)` : ''} — sender ${sender.slice(0, 12)}… -> '${wantCh}' (wrap ${String(id).slice(0, 12)}…)`)
  markRelaySeen(id)
  returnLaneSend(sender, {
    template: 'relay_ack_err',
    slots: { reason, channel: wantCh, ts: Math.floor(Date.now() / 1000), ...extra },
  }, { lane: 'relay-ack' })
}
function resolveRelayDest(wantCh) {
  // Allowlist check against the resolved relay_channels (UUIDs at boot). DEFAULT EMPTY → nothing
  // passes. Accepts a UUID already in the set (a name would have been resolved to one at boot).
  const w = String(wantCh || '').toLowerCase()
  for (const c of (PUB.relayChannels || [])) if (String(c).toLowerCase() === w) return c
  return null
}
async function postRelay(ev, sender, dest, wantCh, body) {
  // Render identically to the public lane; a granted sender earns live @mentions (#118). Attribution
  // is the sender's own name + npub — this identity said this, and waggle carried it (§4).
  let name = null
  if (!process.env.WB_STUB_SEND) { try { name = await fetchProfileName(sender) } catch { name = null } }
  let npub = null
  try { npub = nip19.npubEncode(sender) } catch { npub = null }
  const npubShort = npub ? `${npub.slice(0, 10)}…${npub.slice(-5)}` : sender.slice(0, 12) + '…'
  const nowSec = Math.floor(Date.now() / 1000)
  const ackOk = (buzzId) => returnLaneSend(sender, { template: 'relay_ack_ok', slots: { channel: dest, buzzEventId: buzzId || null, ts: nowSec } }, { lane: 'relay-ack' })
  if (FORWARD_MODE !== 'buzz') {
    log(`RELAY[dryrun] -> ${dest}: from ${sender.slice(0, 12)}… (${Buffer.byteLength(body)}B) :: ${JSON.stringify(body.slice(0, 80))}`)
    return
  }
  if (process.env.WB_STUB_SEND) {
    const fakeId = ev.id.split('').reverse().join('')
    markRelaySeen(ev.id) // commit-after-"send"
    recordPosted({ id: ev.id, author: sender, buzz: fakeId, dest, q: false, ts: nowSec, agent: sender })
    journalSend(fakeId, { kind: 9, dest, lane: 'relay' })
    ackOk(fakeId)
    log(`RELAY[stub] -> ${dest}: from ${sender.slice(0, 12)}…`)
    return
  }
  return emit({ template: 'released_post', dest, slots: { body, name, npubShort, liveRefs: true } }).then(({ stdout: so }) => {
    // commit-AFTER-send (#114 finding-3): mark the wrap carried only once the kind:9 posted, so a
    // transient failure retries. Residual: a crash after this post but before the mark re-posts on
    // restart — kind:9 has no idempotency key, so the dup-on-crash residual stands (§6).
    const buzzId = parseBuzzEventId(so)
    markRelaySeen(ev.id)
    recordPosted({ id: ev.id, author: sender, buzz: buzzId, dest, q: false, ts: nowSec, agent: sender })
    journalSend(buzzId, { kind: 9, dest, lane: 'relay' })
    ackOk(buzzId)
    log(`RELAY[buzz] ok -> ${dest}: from ${sender.slice(0, 12)}… (wrap ${ev.id.slice(0, 12)}…)`)
  }).catch(e => {
    // A channel waggle is not a member of fails HERE with a distinct RELAY[buzz] ERR — it can never
    // masquerade as a §7 drop, and it is NOT marked seen, so it retries rather than dropping.
    dropRelaySeen(ev.id)
    err(`RELAY[buzz] ERR -> ${dest}: ${e.message} — claim rolled back, will retry`)
  })
}
function handleRelayIngress(ev) {
  if (!hasBridgeKey() || !PUB) return
  const nowMs = Date.now()
  if (relaySeen.has(ev.id)) return                                          // §6 dedup BEFORE decrypt
  const wrapBytes = Buffer.byteLength(JSON.stringify(ev))
  if (wrapBytes > PUB.relayMaxWrapBytes) return relayDrop('size', ev.id)     // §7 hard cap, cheap
  slide(relayDecWin, nowMs, 60_000)
  if (relayDecWin.length >= PUB.relayDecryptBudget) return relayDrop('budget', ev.id, false) // §7, transient
  relayDecWin.push(nowMs)
  // ---- expensive step: decryption of UNAUTHENTICATED input (the §7 DoS surface) ----
  let seal
  try { seal = openSeal(ev) }
  catch { return relayDrop('decrypt', ev.id) }
  let ok = false
  try { ok = verifyEvent(seal) } catch { ok = false }
  if (!ok || seal.kind !== 13) return relayDrop('verify', ev.id)            // authorship proof (§2.4)
  let rumor
  try { rumor = openRumor(seal) }
  catch { return relayDrop('decrypt', ev.id) }
  if (!rumor || String(rumor.pubkey) !== String(seal.pubkey)) return relayDrop('mismatch', ev.id) // bind unsigned rumor
  // ---- the sender is now AUTHENTICATED: every drop below is ACKED ----
  const sender = String(seal.pubkey).toLowerCase()
  const relayTag = (rumor.tags || []).find(t => t[0] === 'relay' && t[1])
  // Routing discriminator: kind:14 + a well-formed `relay` tag IS this lane. Its absence is not an
  // error — it is a real DM to waggle, which has no handler here; leave it silent, do not ack it as
  // a failed relay request, and do not count it as a flood signal.
  if (rumor.kind !== 14 || !relayTag) { relayDropCounts.notRelay++; markRelaySeen(ev.id); return }
  const wantCh = String(relayTag[1])
  const dest = resolveRelayDest(wantCh)
  if (!dest) return relayReject(sender, ev.id, 'channel not allowlisted', wantCh)
  if (!grantSet.has(sender)) return relayReject(sender, ev.id, 'not admitted', wantCh)
  const body = String(rumor.content || '')
  const bytes = Buffer.byteLength(body)
  if (!bytes) return relayReject(sender, ev.id, 'empty body', wantCh)
  if (bytes > PUB.maxContentBytes) return relayReject(sender, ev.id, 'over cap', wantCh, { cap: PUB.maxContentBytes })
  if (!relayRateOk(sender, dest, nowMs)) return relayReject(sender, ev.id, 'rate cap', wantCh)
  addRelaySeen(ev.id)   // claim BEFORE the async send: a copy from another relay must not post again
  postRelay(ev, sender, dest, wantCh, body)
}

// Which return-lane recipient (delivery npub) a given bridge-posted Buzz event was authored FOR,
// or null. This is the agent-authored registry read: reply-to-agent and echo-skip both key on it,
// never on the shared bridge signing key. Empty until the registry is fed (a repost of the agent's
// own public note, or a future recorded bridge-write), and it fails CLOSED — an unrecorded event
// resolves to null, never to a wrong recipient.
function agentAuthoredBy(buzzId) {
  const e = buzzId && stagingByBuzzId.get(String(buzzId).toLowerCase())
  return e && e.agent ? e.agent : null
}

// Scan a batch of channel messages for return-lane triggers and carry each out — exactly once.
// Two trigger types:
//   • @mention — a resolved p-tag EXACTLY equal to the recipient's delivery key (Buzz resolves an
//     @name to a server-side p-tag: exact match, survives display-name drift, no substring
//     hazard), OR the literal @name word-boundary match in the body. Both, unioned: the p-tag is
//     the reliable signal once the agent's key is a resolvable channel member, and the regex is
//     the floor for the common external-agent case where an @name resolves to no member at all.
//     Word boundary, not substring — "@claudex" must never deliver to "@claude"; a substring test
//     would carry a private message to the wrong recipient, silently, the more likely the longer
//     the roster.
//   • reply-to-agent — a reply whose DIRECT parent (the `reply`-marked e-tag, not the thread root)
//     is a bridge event the registry records as authored for this recipient. No body match needed.
//
// opts.authors, when supplied, is a SIGNER gate (spam/abuse control + defense-in-depth — NOT the
// load-bearing safety property; that is the wake/payload split in the action layer). A message
// whose signer is outside it is dropped, LOUDLY, before any carry-out. Supplying the option at all
// makes the gate default-closed: an explicitly-empty gate passes nobody (a misconfiguration that
// is WARNed at boot, never silent). The staging path passes no option and stays open — staging is
// human-gated content already.
//
// The carried body is DATA, never instruction: it is quoted into a sealed 1059 delivered to the
// recipient's own key. Nothing here starts a session, evaluates, or acts on the body — this lane
// only ever moves bytes to an address. The one place a body could reach a prompt is the action
// layer, where the wake is content-free and the body is read-plane data (design §5).
async function scanReturnLane(msgs, opts = {}) {
  if (!PUB.returnLane.length || !hasBridgeKey()) return
  const gateActive = opts.authors !== undefined            // an explicit (even empty) gate is default-closed
  const gate = gateActive ? new Set(opts.authors || []) : null
  for (const m of msgs || []) {
    if (!m || !m.id) continue
    const from = String(m.pubkey || '').toLowerCase()
    if (gateActive && !gate.has(from)) {                   // signer gate — logged once per id, never silent
      if (rlDropOnce(m.id)) err(`RETURN drop[author]: ${String(m.id).slice(0, 12)}… signer ${from.slice(0, 12)}… not in scan_authors`)
      continue
    }
    const body = String(m.content || '')
    const tags = Array.isArray(m.tags) ? m.tags : []
    const ptags = tags.filter(t => t[0] === 'p' && t[1]).map(t => String(t[1]).toLowerCase())
    // Direct parent(s) only — the `reply`-marked e-tag. NOT the `root` tag: matching root would
    // deliver every message in a thread the agent started, not the replies actually to it.
    const parents = tags.filter(t => t[0] === 'e' && t[1] && t[3] === 'reply').map(t => String(t[1]).toLowerCase())
    // No break: one message fans out to EVERY matching recipient, each deduped on its own
    // (source × recipient) key. "@a @b" reaching only one of them was finding #4.
    for (const r of PUB.returnLane) {
      const key = rlKey(m.id, r.npub_hex)
      if (rlSeen.has(key)) continue                        // this recipient already carried for this message
      // Echo: never carry the recipient's own words back. Three forms, all the agent's own:
      // direct-signer (r.npub_hex signed it), unique-bound-author (a Buzz-side key bound to only
      // THIS entry signed it — never a shared bridge key, which would drop cross-mentions), or
      // registry (the bridge posted this event FOR this recipient).
      const boundUnique = r.authors.some(a => a === from && !PUB.sharedAuthorKeys.has(a))
      if (from === r.npub_hex || boundUnique || agentAuthoredBy(m.id) === r.npub_hex) continue
      const mentioned = ptags.includes(r.npub_hex) ||
        new RegExp('@' + r.mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])', 'i').test(body)
      const repliedTo = parents.some(pid => agentAuthoredBy(pid) === r.npub_hex)
      if (!mentioned && !repliedTo) continue
      addRlSeen(key)                                       // in-memory now: no double-carry within this scan/overlap
      const accepted = await returnLaneSend(r.npub_hex, {
        template: 'return_carry',
        slots: { mention: r.mention, why: repliedTo && !mentioned ? 'reply' : 'mention', body },
      }, { src: m.id, why: repliedTo && !mentioned ? 'reply' : 'mention' }, opts.publish)
      // Persist-on-landed: durable dedup only once the seal reached a relay. A silent 0/N is rolled
      // back so the overlap re-read (and a restart) re-carry it — a rare re-carry beats a lost mention.
      if (accepted >= 1) {
        markRlSeen(key)
        rlPending.remove(key)                              // landed: no longer owed
      } else {
        dropRlSeen(key)
        // Owed, durably. The overlap re-read may still catch it first; enqueue is idempotent and
        // does not reset the attempt count, so the two paths cannot inflate each other.
        rlPending.enqueue(key, { to: r.npub_hex, mention: r.mention, why: repliedTo && !mentioned ? 'reply' : 'mention', body, src: m.id })
      }
    }
  }
}

// #117: retry what is still owed, INDEPENDENT of the scan cursor. This is the half that makes
// the pending queue worth having — the cursor has long since moved past these messages, so
// nothing else will ever look at them again.
//
// Bounded, then dead-lettered. An unbounded retry against a permanently-dead recipient is the
// same failure as the rejected cursor-hold, just quieter: work that never completes and never
// stops. The bound converts it into a loud, dated, per-recipient report — and a dead-letter that
// is logged and dropped, never a queue that grows forever.
async function retryPendingCarries(opts = {}) {
  if (!PUB || !PUB.returnLane.length || !hasBridgeKey()) return
  const owed = rlPending.entries()
  if (!owed.length) return
  let landed = 0, dead = 0
  for (const { key, item, attempts } of owed) {
    if (!item || !item.to) { rlPending.remove(key); continue }   // unparseable record: drop, do not loop
    if (attempts >= RLPENDING_MAX_ATTEMPTS) {
      // DEAD LETTER. Loud, and it names the recipient and the source, because a carry the
      // community believes was delivered and never was is exactly the silence this lane exists
      // to prevent. Dropped from the queue so one dead key cannot pin the lane.
      err(`RETURN dead-letter: gave up carrying ${String(item.src).slice(0, 12)}… to ${String(item.to).slice(0, 12)}… after ${attempts} attempt(s) — the recipient has been unreachable throughout. This carry is LOST and will not be retried.`)
      rlPending.remove(key)
      dead++
      continue
    }
    const n = rlPending.attempt(key)                            // recorded BEFORE the send
    const accepted = await returnLaneSend(item.to, {
      template: 'return_carry',
      slots: { mention: item.mention, why: item.why, body: item.body },
    }, { src: item.src, why: item.why, retry: n }, opts.publish)
    if (accepted >= 1) {
      markRlSeen(key)
      rlPending.remove(key)
      landed++
      log(`RETURN retry ok: carried ${String(item.src).slice(0, 12)}… to ${String(item.to).slice(0, 12)}… on attempt ${n}`)
    }
  }
  if (landed || dead) log(`return lane pending: ${landed} landed, ${dead} dead-lettered, ${rlPending.size()} still owed`)
  else if (owed.length) log(`return lane pending: ${owed.length} still owed, none landed this pass`)
}

let cmdCursor = 0
function pollCommands() {
  query('messages_get', { channel: PUB.staging, limit: 30 }).then((so) => {
    let msgs
    try { msgs = JSON.parse(String(so).slice(String(so).indexOf('['))) } catch { return err('commands: unparseable staging read') }
    for (const m of msgs) { if ((m.created_at || 0) >= cmdCursor - 300) handleCommand(m).catch(er => err(`commands: ${er.message}`)) }
    scanReturnLane(msgs)
      .then(() => retryPendingCarries())                  // #117: owed carries, independent of the cursor
      .catch(er => err(`return lane: staging carry failed: ${er.message}`))
    cmdCursor = Math.floor(Date.now() / 1000)
  })
}

// A5-scan: NO-MISS ACROSS DOWNTIME (#5). A blind newest-page read (`--limit N`, no since) drops
// any mention buried past the N newest during an outage, and dedup can never recover a message that
// was never scanned — durable rlSeen closes the re-SEND half, not the MISS half. So the scan is
// anchored to a PERSISTED per-channel cursor (same A3 shape as pub-watermark): each poll reads from
// (cursor - overlap) forward and PAGINATES with --before until the backlog is drained, so --limit
// can never truncate it. The cursor advances only after a full, clean drain — a read/parse failure
// leaves it untouched so the next poll re-reads (a failed carry is never a silent skip). The overlap
// re-read is a no-op under durable rlSeen (per source × recipient), never a re-carry. On first boot
// (no cursor) it floors to a bounded lookback, matching the DM lane's 48h + id-dedup philosophy.
const SCAN_WATERMARK_PATH = process.env.SCAN_WATERMARK_PATH || resolve(ROOT, 'data', 'scan-watermark.json')
const SCAN_WATERMARK_OVERLAP = Number(process.env.SCAN_WATERMARK_OVERLAP || 120)
const SCAN_BOOTSTRAP_SECS = Number(process.env.SCAN_BOOTSTRAP_SECS || 172800) // 48h, matches DM lane
const SCAN_PAGE_LIMIT = Number(process.env.SCAN_PAGE_LIMIT || 200)
function loadScanCursors() {
  try { const o = JSON.parse(readFileSync(SCAN_WATERMARK_PATH, 'utf8')); return (o && typeof o === 'object') ? o : {} }
  catch { return {} }
}
let scanCursors = loadScanCursors()
function scanSince(ch) {
  const c = Number(scanCursors[ch] || 0)
  return c > 0 ? c - SCAN_WATERMARK_OVERLAP : Math.floor(Date.now() / 1000) - SCAN_BOOTSTRAP_SECS
}
function bumpScanCursor(ch, ts) {
  if (!Number.isFinite(ts) || ts <= 0 || ts <= Number(scanCursors[ch] || 0)) return
  scanCursors[ch] = ts
  try { mkdirSync(dirname(SCAN_WATERMARK_PATH), { recursive: true }); writeFileSync(SCAN_WATERMARK_PATH, JSON.stringify(scanCursors)) }
  catch (e) { err(`scan watermark: write failed: ${e.message}`) }
}

// Default page fetch: shell out to `buzz messages get`. Injectable (fetchPage) so the paging /
// no-miss logic is drivable by a test with synthetic pages — the scan test drives scanReturnLane
// directly; this lets #5 drive the window and pagination the same way, no socket.
function scanFetchPage(ch, floor, before, cb) {
  query('messages_get', { channel: ch, limit: SCAN_PAGE_LIMIT, since: floor, before: before || undefined }).then((so) => {
    let msgs
    try { msgs = JSON.parse(String(so).slice(String(so).indexOf('['))) } catch { return cb(new Error('unparseable read')) }
    cb(null, msgs)
  }).catch(e => cb(e))
}

// Drain one scan channel: page back from newest to the cursor floor, then route the whole set once
// and advance the cursor to the newest created_at seen. Pages are unioned by id (not appended) so a
// --before boundary that re-includes a same-timestamp message never double-counts, and a page that
// adds zero new ids terminates the walk (guards against a same-created_at cluster larger than the
// page). Nothing routes and the cursor does not move if a page read fails.
function scanChannel(ch, fetchPage = scanFetchPage) {
  const floor = scanSince(ch)
  const acc = []
  const seenIds = new Set()
  // Returns a Promise that settles once the whole drain — including the async carry-out — completes,
  // so a caller (and a test) can await the sends actually landing. Resolves (never rejects) on a read
  // failure too, leaving the cursor unmoved.
  return new Promise((resolve) => {
    const page = (before) => {
      fetchPage(ch, floor, before, async (e, msgs) => {
        if (e) { err(`scan: read failed for ${String(ch).slice(0, 8)}…: ${e.message}`); return resolve() } // no cursor advance — next poll retries
        let added = 0
        for (const m of (msgs || [])) { if (m && m.id && !seenIds.has(m.id)) { seenIds.add(m.id); acc.push(m); added++ } }
        const oldest = (msgs || []).reduce((mn, x) => Math.min(mn, Number(x && x.created_at) || Infinity), Infinity)
        // A full page still above the floor may be truncating the backlog — walk back. Stop once a
        // page yields nothing new, so a same-timestamp cluster can never spin forever.
        if (added > 0 && (msgs || []).length >= SCAN_PAGE_LIMIT && Number.isFinite(oldest) && oldest > floor) return page(oldest)
        try { await scanReturnLane(acc, { authors: PUB.scanAuthors }) }
        catch (er) { err(`scan: return-lane carry failed for ${String(ch).slice(0, 8)}…: ${er.message}`) }
        // The cursor advances regardless of any 0/N carry above (a dropped rlSeen key re-carries only
        // while it stays inside the overlap window, and each such attempt is itself a loud 0/N). So the
        // return-lane guarantee is: NO SILENT LOSS — loud, bounded retries within the overlap window;
        // a carry is lost only after an outage sustained long enough to age it past the window. That
        // send-side no-miss (retry independent of the cursor) is the pending-set follow-up, #117 — NOT
        // a cursor-hold, which would pin the lane on one dead recipient and stall it for everyone.
        bumpScanCursor(ch, acc.reduce((mx, x) => Math.max(mx, Number(x && x.created_at) || 0), 0))
        resolve()
      })
    }
    page(null)
  })
}

// The WORKING-channel scan, deliberately separate from pollCommands. It carries out return-lane
// mentions/replies from the configured scan channel(s) under the scan_authors signer gate — and it
// NEVER calls handleCommand: a #connector post is not a signed console command, and only staging
// is parsed for those. Keeping the two polls distinct is what stops working-channel chatter from
// being interpreted as approval verbs. Dedup is rlSeen (shared with the staging path), keyed per
// (source × recipient), so a message carried to a recipient once is never carried to them again —
// regardless of which poll saw it first, and durable across a restart.
async function pollScanChannels() {
  if (!PUB.scanChannels.length) return
  for (const ch of PUB.scanChannels) {
    try { await scanChannel(ch) } catch (e) { err(`scan: poll failed for ${String(ch).slice(0, 8)}…: ${e.message}`) }
  }
}

// --- relay connections ------------------------------------------------------
function connect(url) {
  let ws, alive = false
  const open = () => {
    ws = new WebSocket(url)
    ws.on('open', () => {
      alive = true
      log(`[${url}] open, subscribing`)
      // DM lane: 1059 wraps p-tagged to our agents.
      ws.send(JSON.stringify(['REQ', 'wb', { kinds: [1059], '#p': TARGETS, since: SINCE }]))
      // Channel lane: 1059 wraps authored BY a configured plane pubkey. Separate REQ so a
      // relay that can't serve one filter still serves the other.
      if (PLANE_AUTHORS.length) {
        ws.send(JSON.stringify(['REQ', 'wc', { kinds: [1059], authors: PLANE_AUTHORS, since: CHANNEL_SINCE }]))
      }
      // Relay lane: 1059 wraps p-tagged to waggle's OWN key — requests it opens itself. Separate REQ
      // so a relay serving one filter still serves the others. Only when relay_channels is set.
      if (BRIDGE_PK && PUB && PUB.relayChannels && PUB.relayChannels.length) {
        ws.send(JSON.stringify(['REQ', 'wr', { kinds: [1059], '#p': [BRIDGE_PK], since: SINCE }]))
      }
    })
    ws.on('message', d => {
      let m
      try { m = JSON.parse(d.toString()) } catch { return }
      if (m[0] === 'EVENT') route(m[2])
      else if (m[0] === 'EOSE') log(`[${url}] EOSE — now live-streaming`)
    })
    ws.on('close', () => { if (alive) log(`[${url}] closed, reconnecting in 5s`); alive = false; setTimeout(open, 5000) })
    ws.on('error', e => { err(`[${url}] err ${e?.message || '?'}`); try { ws.close() } catch {} })
  }
  open()
}

// Public kind:1 read lane. Separate connection set (public relays) and dispatch
// (routePublic), so the sealed lanes and the plaintext lane never share a socket or
// a filter. Two REQs like the sealed side: 'pa' watches chosen AUTHORS, 'pe' watches
// #e REPLIES to our own notes — a relay serving one still serves the other.
function connectPublic(url) {
  let ws, alive = false
  // #206 stage 1: the current open-cycle's watched-author re-subscribe. Registered ONCE per
  // connection (not per reconnect); reassigned each open() to the fresh closure. refreshWatched
  // fans a watchlist change out through this so the relay filter updates without a restart.
  let watchedRefresher = null
  WATCH_REFRESHERS.add(() => { if (watchedRefresher) watchedRefresher() })
  // #204: p-tag filtering finds participant-issued 440 consents but not necessarily their 441
  // withdrawals. The latter are subscribed by the consent-record ids they must e-tag.
  let consentRevocationRefresher = null
  CONSENT_REFRESHERS.add(() => { if (consentRevocationRefresher) consentRevocationRefresher() })
  const open = () => {
    ws = new WebSocket(url)
    // A5: buffer the pre-EOSE backfill and deliver it in CLAMPED-created_at order, so a batch
    // that arrives out of order (or with spoofed stamps) still lands chronologically. Live
    // events after EOSE deliver immediately in receipt order.
    let buf = [], eosed = false, flushTimer = null
    const expect = new Set()
    // Tracks what the granted-author subscription currently covers, so a reconnect or an
    // unchanged grant set does not churn the relay with an identical REQ.
    let grantedSubKey = null
    const subscribeGranted = () => {
      const authors = [...grantSet.keys()].sort()
      const key = authors.join(',')
      if (!authors.length || key === grantedSubKey) return
      grantedSubKey = key
      try {
        // Same sub id each time — a relay replaces a subscription reusing its id, so this
        // updates the filter in place rather than accumulating stale ones.
        ws.send(JSON.stringify(['REQ', 'pga', { kinds: [1], authors, since: PUB.since, limit: PUB.backfillLimit }]))
        log(`[pub ${url}] granted-author subscription -> ${authors.length} admitted identity(ies)`)
      } catch (e) { err(`[pub ${url}] could not subscribe to granted authors: ${e?.message || '?'}`) }
    }
    // #206 stage 1: watched-author subscription, hot-reloadable. Same two sub ids as the initial
    // pa/pd REQs, so re-issuing REPLACES the filter in place at the relay (as subscribeGranted does
    // for pga). An empty set CLOSEs the subs, so a removed author actually stops streaming rather
    // than lingering behind a stale filter. watchedSubKey guards against churning an unchanged set.
    let watchedSubKey = null
    const subscribeWatched = () => {
      const authors = PUB.authors.slice().sort()
      const key = authors.join(',')
      if (key === watchedSubKey) return
      const hadAuthors = !!(watchedSubKey && watchedSubKey.length)
      watchedSubKey = key
      try {
        if (authors.length) {
          ws.send(JSON.stringify(['REQ', 'pa', { kinds: [1], authors, since: PUB.since, limit: PUB.backfillLimit }]))
          ws.send(JSON.stringify(['REQ', 'pd', { kinds: [5], authors, since: Math.floor(Date.now() / 1000) - DEL_SINCE_SECS, limit: PUB.backfillLimit }]))
          log(`[pub ${url}] watched-author subscription -> ${authors.length} author(s)`)
        } else if (hadAuthors) {
          ws.send(JSON.stringify(['CLOSE', 'pa'])); ws.send(JSON.stringify(['CLOSE', 'pd']))
          log(`[pub ${url}] watched-author subscription -> 0 authors (closed)`)
        }
      } catch (e) { err(`[pub ${url}] could not update watched-author subscription: ${e?.message || '?'}`) }
    }
    watchedRefresher = subscribeWatched
    let consentRevocationKeys = []
    const subscribeConsentRevocations = () => {
      const batches = []
      const ids = consentRecordIds()
      for (let i = 0; i < ids.length; i += CONSENT_REVOCATION_BATCH) batches.push(ids.slice(i, i + CONSENT_REVOCATION_BATCH))
      const nextKeys = batches.map(ids => ids.join(','))
      try {
        for (let i = 0; i < batches.length; i++) {
          if (nextKeys[i] === consentRevocationKeys[i]) continue
          ws.send(JSON.stringify(['REQ', `pmr-${i}`, { kinds: [NIPDA.revocation], '#e': batches[i], limit: 500 }]))
        }
        for (let i = batches.length; i < consentRevocationKeys.length; i++) ws.send(JSON.stringify(['CLOSE', `pmr-${i}`]))
        consentRevocationKeys = nextKeys
        if (batches.length) log(`[pub ${url}] consent-revocation subscription -> ${ids.length} active consent record(s)`)
      } catch (e) { err(`[pub ${url}] could not subscribe to consent revocations: ${e?.message || '?'}`) }
    }
    consentRevocationRefresher = subscribeConsentRevocations
    const flush = (reason) => {
      if (eosed) return
      eosed = true
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      const now = Math.floor(Date.now() / 1000)
      // A7 backfill interplay: a valid buffered delete suppresses its buffered target
      // outright — never post a note its author had already deleted by the time we booted.
      // Deletes are processed AFTER the notes flush so a delete for a note posted in an
      // earlier run still finds its posted-map entry.
      const dels = buf.filter(e => e && e.kind === 5)
      const notes = buf.filter(e => e && e.kind !== 5)
      const suppressed = new Set()
      for (const d of dels) {
        let ok = false
        try { ok = verifyEvent(d) } catch { ok = false }
        if (!ok) continue
        for (const t of (d.tags || [])) {
          if (t[0] !== 'e' || !t[1]) continue
          const target = notes.find(n => n.id === String(t[1]).toLowerCase())
          if (target && target.pubkey === d.pubkey) suppressed.add(target.id)
        }
      }
      notes.sort((a, b) => clampCreated(a.created_at, now).clamped - clampCreated(b.created_at, now).clamped)
      buf = []
      log(`[pub ${url}] ${reason} — flushing ${notes.length - suppressed.size} backfilled (sorted${suppressed.size ? `, ${suppressed.size} suppressed[deleted]` : ''}), now live`)
      for (const ev of notes) {
        if (suppressed.has(ev.id)) {
          err(`PUBLIC suppress[deleted]: ${ev.id.slice(0, 12)}… deleted by author before delivery`)
          if (FORWARD_MODE === 'buzz') markSeen(ev.id)
          continue
        }
        routePublic(ev)
      }
      for (const d of dels) routeDelete(d)
    }
    ws.on('open', () => {
      alive = true
      log(`[pub ${url}] open, subscribing (since=${PUB.since}, backfill<=${PUB.backfillLimit})`)
      // A4: relay-side `limit` bounds the first-connect backfill so a watched author's whole
      // history can't be pulled into a channel. The app-side buf cap below is defense in depth.
      if (PUB.authors.length) { expect.add('pa'); ws.send(JSON.stringify(['REQ', 'pa', { kinds: [1], authors: PUB.authors, since: PUB.since, limit: PUB.backfillLimit }])) }
      if (PUB.events.length) { expect.add('pe'); ws.send(JSON.stringify(['REQ', 'pe', { kinds: [1], '#e': PUB.events, since: PUB.since, limit: PUB.backfillLimit }])) }
      // A7: kind:5 deletes from watched authors. Longer lookback than the kind:1 watermark
      // (deletes are rare + idempotent; one issued during downtime must not be missed).
      if (PUB.authors.length) { expect.add('pd'); ws.send(JSON.stringify(['REQ', 'pd', { kinds: [5], authors: PUB.authors, since: Math.floor(Date.now() / 1000) - DEL_SINCE_SECS, limit: PUB.backfillLimit }])) }
      watchedSubKey = PUB.authors.slice().sort().join(',')   // #206: initial pa/pd already cover this set; a later watchlist change re-fires subscribeWatched
      // NIP-DA: grants + revocations from the grantor set. Wide lookback — a standing
      // grant issued weeks ago must survive any restart (stateless consumption).
      if (PUB.grantors.length) { expect.add('pg'); ws.send(JSON.stringify(['REQ', 'pg', { kinds: [NIPDA.grant, NIPDA.revocation], authors: PUB.grantors, limit: 200 }])) }
      // In-door consent (#131/#132, docs/CONSENT.md §8): consent 440s/441s p-tagging the bridge, from
      // ANY author (the inverted grantor) — a SEPARATE lane from `pg` (grantor-authored). Always
      // opened for observability; enforcement is gated in routePublic. Wide lookback like `pg` — a
      // standing consent must survive any restart (stateless consumption). Dispatched to
      // processConsentEvent alongside processGrantEvent below.
      if (BRIDGE_PK) { ws.send(JSON.stringify(['REQ', 'pmc', { kinds: [NIPDA.grant, NIPDA.revocation], '#p': [BRIDGE_PK], limit: 500 }])) }
      // Re-open the record-id subscriptions on reconnect. New 440s refresh this live after
      // verification; these existing ids cover a revocation that arrives without a bridge p-tag.
      subscribeConsentRevocations()
      // Relay lane (DESIGN_RELAY_INGRESS): wraps p-tagged to waggle's OWN key. This REQ lives HERE,
      // not in the sealed connect block, because the handler needs PUB state that only this
      // instance has: `grantSet` (populated by the `pg` subscription above), `relayChannels`, and
      // the Buzz posting path. The sealed instance runs the sealed block but carries no `public`
      // section at all, so a request arriving there would fail `not admitted` against an empty
      // grant set — grants on one instance, subscription on the other, and the lane inert on both.
      //
      // NOT gated on `expect`/EOSE: these are requests to act on, not backfill to sort and flush.
      // `since: SINCE` (not PUB.since) because NIP-59 randomises `created_at` backwards by up to
      // two days — a watermark-tight window would silently drop a legitimately backdated wrap.
      // Re-serving is safe: `relaySeen` dedups durably, before decryption.
      if (BRIDGE_PK && PUB.relayChannels.length) {
        ws.send(JSON.stringify(['REQ', 'pr', { kinds: [1059], '#p': [BRIDGE_PK], since: SINCE }]))
      }
      // Safety: flush even if a relay never sends EOSE for a subscription.
      flushTimer = setTimeout(() => flush('EOSE timeout'), 10000)
      // If grants were already loaded on a previous connection, re-open the granted-author
      // subscription immediately on reconnect rather than waiting for a grant event to replay.
      subscribeGranted()
    })
    ws.on('message', d => {
      let m
      try { m = JSON.parse(d.toString()) } catch { return }
      if (m[0] === 'EVENT') {
        const ev = m[2]
        if (ev && (ev.kind === NIPDA.grant || ev.kind === NIPDA.revocation)) {
          const before = grantSet.size
          processGrantEvent(ev)
          // Same event, second consumer: a mirror-consent 440 (participant-authored, p-tagging the
          // bridge) is dropped by processGrantEvent's grantor gate, so processConsentEvent reads it
          // here. The two are mutually exclusive by construction — grantor-admit vs subject-mirror —
          // so each ignores what isn't its own (docs/CONSENT.md §8).
          processConsentEvent(ev)
          // A grant ADMITS, but nothing was FETCHING. The four subscriptions above pull kind:1
          // by watched author and by reply-to-our-note; none pulls a granted participant's own
          // posts, so an admitted identity could be answered but never heard from unless it also
          // happened to sit in watch_authors. That overlap is what hid this: two mechanisms,
          // one load-bearing, and the wrong one got the credit.
          //
          // The granted set is not known until this subscription has been read, so the
          // subscription for it cannot be opened at connect time with the others. It is opened
          // here instead, and re-opened whenever the set changes — so a new grant starts pulling
          // that author's posts without a restart, mirroring revocation, which already stops
          // honouring them without one.
          if (grantSet.size !== before) subscribeGranted()
          return
        }
        // Relay-lane requests are handled immediately, BEFORE the eosed/backfill branch: a wrap is
        // an instruction to relay, not a note to sort into a flush window. Buffering one would
        // delay it behind backfill and — worse — subject it to the `backfillLimit` overflow drop,
        // where a legitimate request would be discarded as if it were surplus history.
        if (ev && ev.kind === 1059 && BRIDGE_PK && PUB.relayChannels.length) { handleRelayIngress(ev); return }
        if (eosed) { if (ev && ev.kind === 5) routeDelete(ev); else routePublic(ev); return }
        // A4: bound the pre-EOSE buffer app-side too — overflow dropped WITH a log, never silent.
        if (buf.length >= PUB.backfillLimit) { err(`[pub ${url}] backfill buffer cap ${PUB.backfillLimit} — dropping ${ev?.id ? ev.id.slice(0, 12) : '?'}…`); return }
        buf.push(ev)
      } else if (m[0] === 'EOSE') {
        expect.delete(m[1])
        if (expect.size === 0) flush('EOSE')
      }
    })
    ws.on('close', () => { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null } if (alive) log(`[pub ${url}] closed, reconnecting in 5s`); alive = false; setTimeout(open, 5000) })
    ws.on('error', e => { err(`[pub ${url}] err ${e?.message || '?'}`); try { ws.close() } catch {} })
  }
  open()
}

// --- test hook --------------------------------------------------------------
// Exported so a harness can drive the REAL routing functions (not a copy) with synthetic
// events in dryrun, without opening any relay socket. Set WB_NO_BOOT=1 to import without
// booting the live subscriber. No effect on normal `node src/bridge.mjs` runs.
export { recordUndelivered, UNDELIVERED_PATH, durableSet, durableQueue, rlPending, retryPendingCarries, RLPENDING_MAX_ATTEMPTS, fanout, defuseRefs, defuseMarkup, quoted, renderQuarantined, renderReleased, fetchEventById, returnLaneSend, publishWrapToRelays, scanReturnLane, pollScanChannels, scanChannel, scanSince, bumpScanCursor, loadScanCursors, agentAuthoredBy, rlSeen, rlKey, loadRlSeen, markRlSeen, addRlSeen, dropRlSeen, route, routePublic, routeDelete, processGrantEvent, grantSet, processConsentEvent, mirrorConsent, consentRecordIds, refreshConsentRevocations, CONSENT_REFRESHERS, maybeAskConsent, sendConsentRequest, buildConsentPrefill, mirrorAsked, addWatchAuthor, removeWatchAuthor, refreshWatched, WATCH_REFRESHERS, watchlistTarget, handleWatchlistCommand, handleCommand, forwardPublic, clampCreated, rateOk, bumpPubWatermark, loadPubWatermark, markSeen, seen, PUB, postedMap, recordPosted, parseBuzzEventId, resolveChannels, handleRelayIngress, relaySeen, markRelaySeen, addRelaySeen, dropRelaySeen, loadRelaySeen, relayRateOk, resolveRelayDest, relayDropTotalPreAuth, relayDropCounts }

// --- boot -------------------------------------------------------------------
if (!process.env.WB_NO_BOOT) {
  loadSeen()
  loadPostedMap()
  loadRlSeen()
  mirrorAskedStore.load()   // §6: who we've already sent a consent-request DM (once per target)
  rlPending.load()
  loadRelaySeen()
  // #171 — say it on every boot. A record of lost messages that nobody reads is the same silence
  // it exists to end, one level further out. Non-fatal: these are past losses, not a reason to
  // refuse to start now.
  try {
    if (existsSync(UNDELIVERED_PATH)) {
      const n = readFileSync(UNDELIVERED_PATH, 'utf8').split('\n').filter(Boolean).length
      if (n) err(`⚠ ${n} previously undelivered message(s) recorded in ${UNDELIVERED_PATH} — these were accepted, marked seen, and never landed. Nothing will retry them.`)
    }
  } catch { /* a boot log must never be the thing that stops a boot */ }
  // Every config-sourced typed slot is rendered ONCE here, before a single event is accepted. A
  // value that cannot render would otherwise throw inside a delivery path — and both delivery
  // paths markSeen before emit resolves, so that throw drops the message permanently for one ERR
  // line. Failing at boot turns an invisible, per-message, unrecoverable loss into a loud refusal
  // to start, which is the trade this repo always makes.
  {
    // TARGETS is a list of pubkey STRINGS (keys of RECIPIENTS), not records — reading `.name` off
    // it yields undefined, and an undefined name fails `handle`, so a first draft of this check
    // refused to boot on a perfectly good config. The boot suite caught it. Worth the comment:
    // a fail-closed startup gate that is itself wrong turns a dropped message into a total
    // outage, which is strictly worse than the bug it guards against.
    const problems = checkConfigRenderable({
      recipientNames: Object.values(RECIPIENTS).map(r => r.name),
      approverMention: PUB && PUB.approverMention,
    })
    for (const p of problems) err(`FATAL: config value ${p.what} = ${JSON.stringify(p.value)} cannot be rendered — ${p.error}`)
    if (problems.length) { err('FATAL: refusing to start — a value that cannot render would silently drop every message on that path.'); process.exit(1) }
  }
  log(`waggle — mode=${FORWARD_MODE}, ${TARGETS.length} recipients, ${RELAYS.length} relays, ${PLANE_AUTHORS.length} channel plane(s), dm-since=${SINCE} (${SINCE_SECS}s), chan-since=${CHANNEL_SINCE} (${CHANNEL_SINCE_SECS}s)`)
  if (!SEALED_LANES) {
    log('sealed lanes: DISABLED (SEALED_LANES=off) — DM + Concord channel routing OFF; running PUBLIC read lane only')
    if (!PUB) { err('FATAL: SEALED_LANES=off but no public read lane configured (cfg.public.inbox) — nothing to do.'); process.exit(1) }
  } else {
    if (PLANE_AUTHORS.length) for (const pk of PLANE_AUTHORS) log(`  channel '${PLANES[pk].name}' <- plane ${pk.slice(0, 12)}… -> ${PLANES[pk].recipients.map(r => r.name).join(', ')}`)
    if (!TARGETS.length) { err('FATAL: no recipients configured.'); process.exit(1) }
    if (!RELAYS.length) { err('FATAL: no relays configured.'); process.exit(1) }
    log(`  lane-2 caps: ${L2.perPlane.postsPerMinute}/plane/min ${L2.perPlane.postsPerHour}/plane/h · ${L2.perPlane.perRecipientPerMinute}/recipient/min (+${L2.burst.recipientBurst} burst) · ${L2.global.totalPostsPerHour}/global/h · max ${L2.perPlane.maxEventBytes}B · boot allowance ${L2.burst.bootBackfillMax}`)
    RELAYS.forEach(connect)
  }
  if (PUB) {
    if (!PUB.relays.length) err('WARN: public read lane configured but cfg.public.relays is empty — nothing to listen on')
    resolveChannels(() => {
    log(`public read lane -> inbox ${PUB.inbox}: ${PUB.relays.length} relay(s), ${PUB.authors.length} watched author(s), ${PUB.events.length} watched note(s), pub-since=${PUB.since} (${PUB_SINCE_SECS}s), watermark=${pubWatermark || 'none'}`)
    log(`  gates: staging=${PUB.staging || 'HOLD (none)'} · backfill<=${PUB.backfillLimit} · maxContent=${PUB.maxContentBytes}B · rate ${PUB.replierPerMin}/replier/min ${PUB.channelPerMin}/chan/min ${PUB.lanePerHour}/lane/h · deletes ${PUB.deletesPerHour}/h (A7)`)
    if (PUB.grantors.length) log(`  admission: ${PUB.grantors.length} grantor key(s); NIP-DA kinds ${NIPDA.grant}/${NIPDA.revocation}/${NIPDA.index}`)
    if (PUB.mirrorRequireConsent) {
      log(`  in-door consent: ENFORCING (§8) — mirror/reply gated on consent; ${PUB.mirrorGrandfathered.length} grandfathered; version-binding ${PUB.mirrorExpectedTosHash ? 'ON (tos ' + PUB.mirrorExpectedTosHash.slice(0, 8) + '…)' : 'OFF'}`)
      log(`  in-door consent ask (§5/§6): ${PUB.mirrorConsentTermsUrl ? 'ON — disclosure DM once per target, ' + PUB.mirrorAskPerHour + '/h cap, ' + mirrorAsked.size + ' already asked' : 'OFF (no mirror_consent_terms_url — enforcement gates, nobody is messaged)'}`)
      if (!PUB.mirrorExpectedTosHash) err(`  in-door consent: version-binding UNENFORCED — set public.mirror_expected_tos_hash to the current ToS block hash, or a v1 consent rides v2 terms (§7)`)
    }
    if (PUB.relayChannels.length && hasBridgeKey()) log(`  relay lane: ${PUB.relayChannels.length} allowlisted channel(s); decrypt budget ${PUB.relayDecryptBudget}/min, wrap cap ${PUB.relayMaxWrapBytes}B — a channel waggle has not joined fails as RELAY[buzz] ERR, never a silent §7 drop`)
    else if (PUB.relayChannels.length && !hasBridgeKey()) err('WARN: relay_channels configured but no BRIDGE key to open sealed requests — relay lane INERT.')
    PUB.relays.forEach(connectPublic)
    if (PUB.staging && PUB.approvers.length && FORWARD_MODE === 'buzz') {
      log(`approval console: watching staging for commands from ${PUB.approvers.length} approver(s)`)
      pollCommands(); setInterval(pollCommands, 15000)
    }
    if (PUB.scanChannels.length && PUB.returnLane.length && hasBridgeKey() && FORWARD_MODE === 'buzz') {
      log(`return-lane scan: ${PUB.scanChannels.length} channel(s) · ${PUB.returnLane.length} recipient(s) · signer gate ${PUB.scanAuthors.length} key(s)`)
      // Silence-is-not-calm: a configured scan with an empty gate routes NOTHING, so say so loudly
      // rather than let it look like "no mentions." Set scan_authors (or declare approvers/grantors).
      if (!PUB.scanAuthors.length) err('WARN: scan_channels configured but scan_authors gate is EMPTY — default-closed, NO mentions will route until the crew roster is set.')
      pollScanChannels().catch(e => err(`scan: initial poll failed: ${e.message}`))
      setInterval(() => pollScanChannels().catch(e => err(`scan: poll failed: ${e.message}`)), 15000)
    }
    })
  } else {
    log('public read lane: inactive (no cfg.public.inbox)')
  }

  process.on('SIGINT', () => { log('SIGINT — shutting down'); process.exit(0) })
  process.on('SIGTERM', () => { log('SIGTERM — shutting down'); process.exit(0) })
}
