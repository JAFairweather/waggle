// relay_send_intent.mjs — the decision half of an agent speaking into a walled community (#507).
//
// waggle receives on this lane already (`handleRelayIngress`): an admitted member seals a request to
// waggle's own key, the bridge verifies the signature against the live grant, and posts it into the
// channel AS that member. Nothing in this repo composed one, so an agent onboarded from the waggle
// checkout could hear (#505) and not speak.
//
// This module holds the parts that can be wrong without any socket being involved, and one of them
// has been wrong twice in production:
//
//   A BODY WITH NO @NAME IS ACCEPTED, CARRIED, AND QUEUED TO NOBODY.
//
// The relay says OK, the bridge says carried, the journal shows a delivery, and no agent ever reads
// it. That is not a transport failure and no error is raised anywhere along the path — the message
// is simply addressed to no one. Once it cost an admitted agent that reached nobody (#118); once it
// cost four review requests that had to be re-routed by hand. So the mention check lives here, in
// front of the send, and refuses by default.
//
// The other half is what a send can honestly claim afterwards, which is less than it looks — see
// `sendVerdict`.

const HEX64 = /^[0-9a-f]{64}$/
// A channel id is a UUID in this deployment. Kept as a shape check, not a lookup: the bridge owns
// which channels exist, and a client that guessed would be asserting the mechanism, not the property.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const refuse = reason => Object.freeze({ ok: false, reason })

/**
 * Does this body actually address anybody?
 *
 * An at-word is `@` followed by a name, and names here contain spaces — `@My Dude` is one recipient,
 * not a mention of `@My` — so this deliberately does NOT try to resolve which agent is named. The
 * bridge owns resolution (`task_route_mention.mjs`, with longest-name arbitration). All this decides
 * is the question that failed twice: is there an at-word at all?
 *
 * What comes back is therefore a CANDIDATE SPAN, not a resolved name. Without the roster there is no
 * way to tell where `@Dennis please take a look` stops being a name, so the span is bounded at four
 * words and may over-capture into the prose after a mention. That is deliberate in this direction:
 * over-capturing cannot turn an addressed message into an unaddressed one, and the bound is what
 * stops a mention swallowing the whole body and reporting a recipient that is plainly nonsense.
 *
 * `broadcast` is the deliberate override for a message meant for the humans in the channel. It is a
 * flag rather than a default because the failure it guards is silent, and a guard you have to
 * remember to switch on is one that is off at the moment it matters.
 */
export function mentionVerdict(body, { broadcast = false } = {}) {
  const text = typeof body === 'string' ? body : ''
  if (!text.trim()) return refuse('empty body — nothing to send')
  // The delimiter is a LOOKBEHIND, not a consumed character. Consuming it swallows the space in
  // `@My Dude @Dennis`, and the second name then cannot match at all — one message reaching one of
  // two named recipients, which is finding #4 all over again.
  //
  // Names contain spaces, so a name continues across a space only into another word; ` @` and ` —`
  // both end it. The email case (`a@b.com`) is excluded by the lookbehind rather than by a special
  // case, because `@` preceded by a letter or digit is never an at-word.
  //
  // The lookbehind is `\p{L}\p{N}`, not `\w`: `\w` is ASCII-only even under /u, so `наташа@mail.ru`
  // is not an email to it. That body carries no mention at all, passes the guard, routes to nobody
  // — and the report tells the sender `Addressed to: @mail.ru`, which is #118 with a reason not to
  // go looking. The character class in the capture is already Unicode; the exclusion has to match it.
  const found = [...text.matchAll(/(?<![\p{L}\p{N}_@])@([\p{L}\p{N}][\p{L}\p{N}._-]*(?: [\p{L}\p{N}][\p{L}\p{N}._-]*){0,3})/gu)]
    .map(m => m[1].trim()).filter(Boolean)
  // Deduplicated for the report only — naming the same recipient twice reads as two recipients, and
  // the report is the thing the sender checks before deciding the message went where they meant.
  // It does NOT change routing: the bridge resolves the body, not this list, so a name quoted as an
  // example in the prose is still a name the bridge routes to. Found live — a review request that
  // quoted `@My Dude @Dennis` as an illustration of a bug reached Dennis.
  const mentions = [...new Set(found)]
  if (mentions.length) {
    return Object.freeze({ ok: true, broadcast: false, mentions })
  }
  if (broadcast) {
    return Object.freeze({ ok: true, broadcast: true, mentions: [],
      reason: 'no at-word, sent as a broadcast on purpose — the channel sees it and no agent is routed it' })
  }
  return refuse('no @name in the body, so the bridge would carry this and route it to nobody. ' +
    'A relay OK and a carried message both still happen; the agent simply never reads it. ' +
    'Add an @mention, or pass --broadcast if this is meant for the humans in the channel.')
}

/**
 * The rumor waggle expects, or a refusal. No crypto here — the caller seals it.
 *
 * The `relay` tag naming the destination channel is what the bridge reads; the rumor's `pubkey` must
 * be the sending identity, because the bridge verifies the seal's signature against the live grant
 * and attributes the post to that key. Getting it wrong does not fail loudly — it produces a message
 * the bridge refuses, which from the agent's side looks exactly like a message nobody replied to.
 */
export function buildIntent({ body, channel, self, at = null, broadcast = false } = {}) {
  const mention = mentionVerdict(body, { broadcast })
  if (mention.ok !== true) return mention
  const me = String(self || '').toLowerCase()
  if (!HEX64.test(me)) return refuse('no sending identity — a rumor with the wrong pubkey is refused by the bridge, not by this tool')
  const dest = String(channel || '').trim()
  if (!UUID.test(dest)) return refuse('destination channel must be a UUID — nothing was sent')
  const created = Number.isSafeInteger(at) ? at : Math.floor(Date.now() / 1000)
  return Object.freeze({
    ok: true,
    mentions: mention.mentions,
    broadcast: !!mention.broadcast,
    rumor: Object.freeze({ kind: 14, pubkey: me, created_at: created, tags: [['relay', dest]], content: String(body) }),
  })
}

// NIP-59 BACKDATING — how far into the past the seal and the wrap are dated.
//
// It lives here, and not as a literal in `tools/agent-send.mjs`, for the reason #506 moved its
// tracker into src/: the tool has no suite, so a decision made there is a decision nothing can
// assert. This one was made wrong first — both events carried the exact send time, which publishes
// to a public relay precisely the correlation `src/nostr_egress.mjs:496` fuzzes away, and which
// `src/return_lane_inbox.mjs:64` documents from the reading end as the reason a seal is not
// freshness-checked. The reviewer found it by reading; nothing in 107 suites could have.
//
// AN HOUR, DELIBERATELY, where the bridge uses two days — and the difference is a coupling, not a
// preference. The bridge's ingress subscribes `{ kinds: [1059], '#p': [BRIDGE_PK], since: SINCE }`
// with `SINCE = bootTime − SINCE_SECS` (`src/bridge.mjs:113`, `:3892`). A wrap dated before that is
// never served and the send looks like a message nobody answered — a silent drop, which is this
// project's characteristic failure. Two days of fuzz is safe only while `SINCE_SECS` keeps its
// default; an hour is safe for any lookback above an hour, and an hour already destroys the exact
// correlation. Widening this without reading that `since` filter reintroduces the silent drop.
export const FUZZ_SECS = 3600

/**
 * The seal and wrap templates, minus their encrypted content — the shape and the timestamps only.
 *
 * `rnd` is injectable so the backdating can be asserted at its bounds rather than sampled. Both
 * events are dated INDEPENDENTLY: two events stamped with the same backdated second are themselves
 * a correlator, which is the thing being removed.
 *
 * The shape is what `handleRelayIngress` requires, and it is asserted against that reader: kind 13
 * seal, kind 1059 wrap, and the `p` tag naming the bridge, which is the only addressing a relay can
 * filter on.
 */
export function envelopeTemplates({ rumorCreatedAt, bridge, rnd = Math.random } = {}) {
  const at = Number.isSafeInteger(rumorCreatedAt) ? rumorCreatedAt : Math.floor(Date.now() / 1000)
  const to = String(bridge || '').toLowerCase()
  if (!HEX64.test(to)) throw new Error('envelopeTemplates needs the bridge pubkey — a wrap with no p tag reaches no one')
  // Floor, never round: rounding can carry a value to `at + 0.5 → at`, and the one thing this must
  // never produce is a timestamp in the future, which a relay may refuse outright.
  const back = () => at - Math.floor(Math.min(Math.max(rnd(), 0), 0.999999) * FUZZ_SECS)
  return Object.freeze({
    seal: Object.freeze({ kind: 13, created_at: back(), tags: [] }),
    wrap: Object.freeze({ kind: 1059, created_at: back(), tags: [['p', to]] }),
  })
}

/**
 * What the agent may honestly say after publishing, which is less than "sent".
 *
 * Three separate facts, and collapsing them is how a send reports success it did not have:
 *
 *   accepted   — relays returned OK. Relays return OK and drop. This proves almost nothing.
 *   readBack   — the wrap was fetched again, by id, on a FRESH connection. This proves the relay
 *                actually stored it, which is the only part of delivery an agent can verify itself.
 *   carried    — waggle opened it and posted it into the channel. THE AGENT CANNOT SEE THIS. The
 *                community relay will not serve an external key, so there is no read-back of the
 *                channel available here. It is visible in the bridge journal, or as a reply arriving
 *                on the return lane — and nowhere else.
 *
 * So the verdict is deliberately incapable of saying "delivered". Saying it would be a claim about a
 * surface this process cannot see, which is the exact error `docs/` calls out: a live route is not a
 * resolvable name, and a stored event is not a carried message.
 */
export function sendVerdict({ accepted = 0, relays = 0, readBack = 0, mentions = [], broadcast = false } = {}) {
  const lines = []
  const published = accepted > 0
  const proven = readBack > 0

  if (!published) lines.push(`NOT SENT — no relay accepted it (0/${relays}).`)
  else if (!proven) {
    lines.push(`${accepted}/${relays} relay(s) returned OK, but the event could not be read back — INCONCLUSIVE.` +
      ' Relays return OK and drop, so an unverified OK is not a publish.')
  } else {
    lines.push(`${accepted}/${relays} relay(s) accepted it, and ${readBack} served it back by id on a fresh connection — the publish is proven.`)
  }

  if (published) {
    lines.push('That is where this agent\'s evidence stops. Whether waggle opened it and posted it into the channel' +
      ' is not visible from here — the community relay will not serve this key, so there is no read-back of the channel.' +
      ' It shows up in the bridge journal, or as a reply arriving on the return lane.')
    if (broadcast) lines.push('Sent as a broadcast: no at-word, so no agent is routed it. The humans in the channel see it.')
    else if (mentions.length) lines.push(`Addressed to: ${mentions.map(m => `@${m}`).join(', ')} — the bridge resolves these, and an unresolvable name reaches nobody.`)
  }

  return Object.freeze({ published, proven, inconclusive: published && !proven, text: lines.join('\n') })
}
