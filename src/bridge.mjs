// West Bridge v1 — non-custodial Armada → Buzz DM forwarder
// -----------------------------------------------------------------------------
// A SUBSCRIBER, not a poller: holds open REQ subscriptions to the Armada relays
// for kind:1059 gift-wraps #p-tagged to our agents, and forwards each SEALED
// event into that agent's Buzz inbox so the buzz-acp harness wakes the agent to
// unwrap it with its own in-runtime key.
//
// NON-CUSTODIAL: this process holds NO agent nsec and NEVER unwraps. It routes on
// the public outer `p` tag only, and needs only its own Buzz posting identity
// (BUZZ_PRIVATE_KEY) to post into the inbox channels. Safe on a server that holds
// no agent keys.
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
import { verifyEvent } from 'nostr-tools/pure'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const CONFIG_PATH = process.env.CONFIG_PATH || resolve(ROOT, 'config.json')
const SEEN_PATH = process.env.SEEN_PATH || resolve(ROOT, 'data', 'seen-ids.log')
const SEEN_CAP = Number(process.env.SEEN_CAP || 100000)
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

const log = (...a) => console.log(new Date().toISOString(), ...a)
const err = (...a) => console.error(new Date().toISOString(), ...a)

// --- config -----------------------------------------------------------------
if (!existsSync(CONFIG_PATH)) {
  err(`FATAL: no config at ${CONFIG_PATH}. Copy config.example.json → config.json and fill inbox UUIDs.`)
  process.exit(1)
}
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const RELAYS = cfg.relays || []
const RECIPIENTS = {} // hex -> { name, inbox }
for (const r of cfg.recipients || []) RECIPIENTS[r.npub_hex] = { name: r.name, inbox: r.inbox }
const TARGETS = Object.keys(RECIPIENTS)

// --- Concord channel planes (additive; empty => pure DM bridge, no behavior change) --------
// A public Concord channel's chat is a stream of kind:1059 wraps authored BY the channel's
// derived plane pubkey (Concord inverts NIP-59: the outer p-tag is random, routing is by
// `authors`). We forward each sealed wrap to every configured member's inbox; the agent
// derives the plane key from ITS OWN community_root (held in-runtime) and decrypts.
// NON-CUSTODIAL: we hold the plane PUBKEY only — a public address, never community_root.
// config.channels[]: { name, plane_pubkey, channel_id?, epoch?, recipients: [<recipient name>...] }
const PLANES = {} // plane_pubkey_hex -> { name, recipients: [ {name, inbox} ] }
const NAME_TO_REC = {}
for (const hex of TARGETS) NAME_TO_REC[RECIPIENTS[hex].name] = RECIPIENTS[hex]
for (const c of cfg.channels || []) {
  if (!c.plane_pubkey) { err(`WARN: channel '${c.name}' has no plane_pubkey — skipping`); continue }
  const recips = (c.recipients || []).map(n => NAME_TO_REC[n]).filter(Boolean)
  const missing = (c.recipients || []).filter(n => !NAME_TO_REC[n])
  if (missing.length) err(`WARN: channel '${c.name}' names unknown recipient(s): ${missing.join(', ')}`)
  if (!recips.length) { err(`WARN: channel '${c.name}' has no resolvable recipients — skipping`); continue }
  PLANES[c.plane_pubkey.toLowerCase()] = { name: c.name, recipients: recips }
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
const POSTED_CAP = Number(process.env.POSTED_CAP || 100000)
const DEL_SINCE_SECS = Number(process.env.DEL_SINCE_SECS || 172800) // 48h
function bumpPubWatermark(ts) {
  if (!Number.isFinite(ts) || ts <= 0 || (pubWatermark && ts <= pubWatermark)) return
  pubWatermark = ts
  try { mkdirSync(dirname(PUB_WATERMARK_PATH), { recursive: true }); writeFileSync(PUB_WATERMARK_PATH, String(ts)) }
  catch (e) { err(`pub watermark: write failed: ${e.message}`) }
}
const PUB = cfg.public && cfg.public.inbox ? {
  relays: cfg.public.relays || [],
  inbox: cfg.public.inbox,
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
} : null

const unresolved = (cfg.recipients || []).filter(r => !r.inbox || r.inbox.startsWith('INBOX_UUID_'))
if (unresolved.length) {
  err(`WARN: ${unresolved.length} recipient(s) have placeholder inbox UUIDs — their DMs will fail to route:`,
    unresolved.map(r => r.name).join(', '))
}
if (FORWARD_MODE === 'buzz' && !process.env.BUZZ_PRIVATE_KEY) {
  err('WARN: FORWARD_MODE=buzz but BUZZ_PRIVATE_KEY is unset — buzz sends will fail auth. Set the bridge identity.')
}

// --- durable dedup ----------------------------------------------------------
// Append-only log of forwarded event ids, loaded into memory on boot. On restart
// we re-hydrate so a bounce (or SINCE backfill) never re-delivers a DM already
// pushed. Pruned to SEEN_CAP most-recent on boot to bound the file.
const seen = new Set()
function loadSeen() {
  if (!existsSync(SEEN_PATH)) { mkdirSync(dirname(SEEN_PATH), { recursive: true }); return }
  const lines = readFileSync(SEEN_PATH, 'utf8').split('\n').filter(Boolean)
  const kept = lines.slice(-SEEN_CAP)
  for (const id of kept) seen.add(id)
  log(`dedup: loaded ${seen.size} seen ids from ${SEEN_PATH}${lines.length > kept.length ? ` (pruned ${lines.length - kept.length})` : ''}`)
}
function markSeen(id) {
  seen.add(id)
  try { appendFileSync(SEEN_PATH, id + '\n') } catch (e) { err(`dedup: append failed for ${id}: ${e.message}`) }
}

// A7 posted-map: append-only JSONL, same lifecycle as seen-ids. One {id, author, buzz,
// dest, ts} record per reposted public note, plus {id, deleted:true} once withdrawn — the
// deleted marker makes a second, different kind:5 for the same target a no-op (the seen
// set only dedups the SAME delete id re-served by another relay).
const postedMap = new Map() // orig event id -> { author, buzz, dest, deleted }
function loadPostedMap() {
  if (!existsSync(POSTED_MAP_PATH)) return
  const lines = readFileSync(POSTED_MAP_PATH, 'utf8').split('\n').filter(Boolean).slice(-POSTED_CAP)
  for (const line of lines) {
    try {
      const r = JSON.parse(line)
      if (!r || !r.id) continue
      if (r.deleted) { const e = postedMap.get(r.id); if (e) e.deleted = true; continue }
      postedMap.set(r.id, { author: r.author, buzz: r.buzz || null, dest: r.dest, deleted: false })
    } catch { err(`A7: skipping corrupt posted-map line`) }
  }
  if (postedMap.size) log(`A7: loaded ${postedMap.size} posted-map entries from ${POSTED_MAP_PATH}`)
}
function recordPosted(rec) {
  postedMap.set(rec.id, { author: rec.author, buzz: rec.buzz || null, dest: rec.dest, deleted: false })
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
  const label = src && src.channel
    ? `New Concord channel post on **${src.channel}** — its outer \`p\` tag is a random decoy, not a recipient. ` +
      `Decrypt with the plane key you derive from the **${src.channel} community_root** ` +
      `(publicChannel(root, channel_id, epoch).conv); do NOT re-seal. If your runtime holds no Concord grant for ` +
      `this channel, you cannot open it yet — that's a provisioning gap, flag it and hold:`
    : `New Armada DM — sealed, unwrap with your key:`
  if (FORWARD_MODE !== 'buzz') {
    log(`FORWARD[dryrun] -> ${rec.name} inbox ${rec.inbox}: ${src && src.channel ? `channel ${src.channel}` : 'DM'} 1059 ${ev.id.slice(0, 12)}… (${JSON.stringify(ev).length} B)`)
    return
  }
  const content = `@${rec.name}\n\n${label}\n\n\`\`\`json\n${JSON.stringify(ev)}\n\`\`\`\n`
  execFile('buzz', ['messages', 'send', '--channel', rec.inbox, '--content', content], (e, so, se) => {
    if (e) return err(`FORWARD[buzz] ERR -> ${rec.name}: ${se || e.message}`)
    log(`FORWARD[buzz] ok -> ${rec.name} inbox: ${src && src.channel ? `${src.channel} ` : 'DM '}1059 ${ev.id.slice(0, 12)}…`)
  })
}

function route(ev) {
  if (!ev || !ev.id || seen.has(ev.id)) return

  // Channel-plane traffic: routed by AUTHOR (the derived plane pubkey), not by p-tag.
  // Every configured member of that channel gets a copy; each decrypts with the plane key.
  const plane = PLANES[ev.pubkey]
  if (plane) {
    const recips = plane.recipients
    // Same dedup discipline as DMs: only commit seen on a real buzz-mode delivery into a
    // provisioned inbox, so a dryrun or a placeholder inbox never suppresses later backfill.
    const willDeliver = FORWARD_MODE === 'buzz' && recips.some(r => !r.inbox.startsWith('INBOX_UUID_'))
    if (willDeliver) markSeen(ev.id)
    for (const r of recips) forward(r, ev, { channel: plane.name })
    return
  }

  const ps = (ev.tags || []).filter(t => t[0] === 'p').map(t => t[1])
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
const rlReplier = new Map() // pubkey -> [tsMs...]
const rlChannel = new Map() // inbox  -> [tsMs...]
const rlLane = []           // [tsMs...] across the whole lane (hourly)
const slide = (arr, nowMs, win) => { while (arr.length && arr[0] <= nowMs - win) arr.shift(); return arr }
function rateOk(ev, dest, nowMs) {
  const lane = slide(rlLane, nowMs, 3600_000)
  if (lane.length >= PUB.lanePerHour) { err(`PUBLIC drop[rate]: lane cap ${PUB.lanePerHour}/h — ${ev.id.slice(0, 12)}…`); return false }
  const perCh = slide(rlChannel.get(dest) || [], nowMs, 60_000)
  if (perCh.length >= PUB.channelPerMin) { err(`PUBLIC drop[rate]: channel cap ${PUB.channelPerMin}/min for ${dest} — ${ev.id.slice(0, 12)}…`); return false }
  const perR = slide(rlReplier.get(ev.pubkey) || [], nowMs, 60_000)
  if (perR.length >= PUB.replierPerMin) { err(`PUBLIC drop[rate]: replier cap ${PUB.replierPerMin}/min for ${ev.pubkey.slice(0, 12)}… — ${ev.id.slice(0, 12)}…`); return false }
  lane.push(nowMs); perCh.push(nowMs); rlChannel.set(dest, perCh); perR.push(nowMs); rlReplier.set(ev.pubkey, perR)
  return true
}

// Repost a PLAINTEXT public note into a Buzz channel. `dest` is the community inbox for a
// trusted (allowlisted) note, or the STAGING inbox for a quarantined external reply (A1).
// No unwrap label, no key — already-public content.
function forwardPublic(ev, why, dest, quarantine) {
  const author = ev.pubkey ? ev.pubkey.slice(0, 16) : '?'
  const nowSec = Math.floor(Date.now() / 1000)
  const { clamped, outOfRange } = clampCreated(ev.created_at, nowSec)
  const when = new Date(clamped * 1000).toISOString()
  const claim = outOfRange && ev.created_at
    ? `  ·  ⚠︎ author-claimed \`${new Date((Number(ev.created_at) || 0) * 1000).toISOString()}\` (clamped)` : ''
  if (FORWARD_MODE !== 'buzz') {
    log(`PUBLIC[dryrun] -> ${quarantine ? 'STAGING' : 'inbox'} ${dest}: kind1 ${ev.id.slice(0, 12)}… by ${author}… (${why})${outOfRange ? ' [clamped]' : ''} :: ${JSON.stringify((ev.content || '').slice(0, 80))}`)
    return
  }
  // Reposted content is untrusted public text. It is delivered as a fenced block so a note
  // that happens to contain "@Name" or markdown can't inject a Buzz mention/format.
  const body = String(ev.content || '')
  const mention = quarantine && PUB.approverMention ? `@${PUB.approverMention} ` : ''
  const header = quarantine
    ? `${mention}⏳ **QUARANTINED external Nostr reply** — _${why}_\n` +
      `**Unverified · NOT in any community channel.** A human must approve before this is republished.\n` +
      `Approve: \`node tools/approve.mjs --event ${ev.id}\` (add \`--watch\` to trust the author)\n`
    : `📡 **Public Nostr note** — _${why}_\n`
  const content =
    header +
    `author \`${ev.pubkey}\`\n` +
    `event \`${ev.id}\`  ·  ${when}${claim}\n\n` +
    '```\n' + body.replace(/```/g, '`​``') + '\n```\n'
  // Test seam: exercise the full buzz-mode path (markSeen/watermark/posted-map) without a
  // network send. The synthetic buzz id (orig id reversed — still 64 hex, still unique)
  // exercises the same capture shape the live path records.
  if (process.env.WB_STUB_SEND) {
    log(`PUBLIC[stub] -> ${quarantine ? 'STAGING' : 'inbox'} ${dest}: kind1 ${ev.id.slice(0, 12)}… by ${author}… (${why})`)
    recordPosted({ id: ev.id, author: ev.pubkey, buzz: ev.id.split('').reverse().join(''), dest, ts: nowSec })
    return
  }
  execFile('buzz', ['messages', 'send', '--channel', dest, '--content', content], (e, so, se) => {
    if (e) return err(`PUBLIC[buzz] ERR -> ${dest}: ${se || e.message}`)
    log(`PUBLIC[buzz] ok -> ${quarantine ? 'STAGING' : 'inbox'} ${dest}: kind1 ${ev.id.slice(0, 12)}… by ${author}… (${why})`)
    // A7: record the repost so the author's later kind:5 can withdraw it. A null buzz id
    // (stdout didn't carry one) degrades to the follow-up-tombstone tier — logged, safe.
    const buzzId = parseBuzzEventId(so)
    if (!buzzId) err(`A7 warn[no-id]: could not capture buzz event id for ${ev.id.slice(0, 12)}… — withdrawal will use follow-up tier`)
    recordPosted({ id: ev.id, author: ev.pubkey, buzz: buzzId, dest, ts: nowSec })
  })
}

function routePublic(ev) {
  if (!ev || !ev.id || ev.kind !== 1 || seen.has(ev.id)) return
  // A1: classify by TRUST, not just by match. An allowlisted watched author is trusted; a
  // reply from anyone else is an untrusted stranger and is quarantined.
  const trusted = PUB.authors.includes(ev.pubkey)
  let why = null, quarantine = false
  if (trusted) why = 'watched author'
  else if (PUB.events.length) {
    const es = (ev.tags || []).filter(t => t[0] === 'e').map(t => t[1])
    if (es.some(id => PUB.events.includes(id))) { why = 'reply to our note'; quarantine = true }
  }
  if (!why) return

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
  const tombstone =
    `🗑 **Withdrawn by author** — NIP-09 deletion\n` +
    `author \`${entry.author}\` · original \`${origId}\` · delete \`${delEv.id}\`\n` +
    `_Content removed at the author's request._\n`
  if (process.env.WB_STUB_SEND) { done(entry.buzz ? 'stub-delete' : 'stub-post'); return }
  const followUp = () => execFile('buzz', ['messages', 'send', '--channel', entry.dest, '--content', tombstone], (e3) => {
    if (e3) return err(`A7 ERR[all-tiers]: could not withdraw ${origId.slice(0, 12)}…: ${e3.message}`)
    done('follow-up')
  })
  if (!entry.buzz) return followUp()
  execFile('buzz', ['messages', 'delete', '--event', entry.buzz, '--reason-code', 'nip09', '--public-reason', 'withdrawn by author (NIP-09)'], (e1) => {
    if (!e1) return done('delete')
    execFile('buzz', ['messages', 'edit', '--event', entry.buzz, '--content', tombstone], (e2) => {
      if (!e2) return done('edit')
      followUp()
    })
  })
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
  const open = () => {
    ws = new WebSocket(url)
    // A5: buffer the pre-EOSE backfill and deliver it in CLAMPED-created_at order, so a batch
    // that arrives out of order (or with spoofed stamps) still lands chronologically. Live
    // events after EOSE deliver immediately in receipt order.
    let buf = [], eosed = false, flushTimer = null
    const expect = new Set()
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
      // Safety: flush even if a relay never sends EOSE for a subscription.
      flushTimer = setTimeout(() => flush('EOSE timeout'), 10000)
    })
    ws.on('message', d => {
      let m
      try { m = JSON.parse(d.toString()) } catch { return }
      if (m[0] === 'EVENT') {
        const ev = m[2]
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
export { routePublic, routeDelete, forwardPublic, clampCreated, rateOk, bumpPubWatermark, loadPubWatermark, markSeen, seen, PUB, postedMap, recordPosted, parseBuzzEventId }

// --- boot -------------------------------------------------------------------
if (!process.env.WB_NO_BOOT) {
  loadSeen()
  loadPostedMap()
  log(`West Bridge v1 — mode=${FORWARD_MODE}, ${TARGETS.length} recipients, ${RELAYS.length} relays, ${PLANE_AUTHORS.length} channel plane(s), dm-since=${SINCE} (${SINCE_SECS}s), chan-since=${CHANNEL_SINCE} (${CHANNEL_SINCE_SECS}s)`)
  if (!SEALED_LANES) {
    log('sealed lanes: DISABLED (SEALED_LANES=off) — DM + Concord channel routing OFF; running PUBLIC read lane only')
    if (!PUB) { err('FATAL: SEALED_LANES=off but no public read lane configured (cfg.public.inbox) — nothing to do.'); process.exit(1) }
  } else {
    if (PLANE_AUTHORS.length) for (const pk of PLANE_AUTHORS) log(`  channel '${PLANES[pk].name}' <- plane ${pk.slice(0, 12)}… -> ${PLANES[pk].recipients.map(r => r.name).join(', ')}`)
    if (!TARGETS.length) { err('FATAL: no recipients configured.'); process.exit(1) }
    if (!RELAYS.length) { err('FATAL: no relays configured.'); process.exit(1) }
    RELAYS.forEach(connect)
  }
  if (PUB) {
    if (!PUB.relays.length) err('WARN: public read lane configured but cfg.public.relays is empty — nothing to listen on')
    log(`public read lane -> inbox ${PUB.inbox}: ${PUB.relays.length} relay(s), ${PUB.authors.length} watched author(s), ${PUB.events.length} watched note(s), pub-since=${PUB.since} (${PUB_SINCE_SECS}s), watermark=${pubWatermark || 'none'}`)
    log(`  gates: staging=${PUB.staging || 'HOLD (none)'} · backfill<=${PUB.backfillLimit} · maxContent=${PUB.maxContentBytes}B · rate ${PUB.replierPerMin}/replier/min ${PUB.channelPerMin}/chan/min ${PUB.lanePerHour}/lane/h · deletes ${PUB.deletesPerHour}/h (A7)`)
    PUB.relays.forEach(connectPublic)
  } else {
    log('public read lane: inactive (no cfg.public.inbox)')
  }

  process.on('SIGINT', () => { log('SIGINT — shutting down'); process.exit(0) })
  process.on('SIGTERM', () => { log('SIGTERM — shutting down'); process.exit(0) })
}
