// The trust gradient, in one place.
//
// Every public note that reaches this bridge lands in exactly one lane, and the lane is
// decided by trust rather than by content. Those lane names were literals in
// `routePublic` AND a duplicated enum in `egress.mjs` — two copies of a vocabulary that
// a third surface (the console's routing view) now needs to render.
//
// A visualization must import the thing it visualizes. `lib/tiers.mjs` in the nact repo
// is the estate's precedent: its ceremony spec is shared between the runtime, the review
// console and the signing page *so a signing surface can never show a softer picture
// than the review console*. The same reasoning applies here — a routing view that
// restated these strings would drift the moment a lane was renamed, and it would drift
// silently, in the direction of claiming the bridge is safer than it is.
//
// DEPENDENCY-FREE ON PURPOSE. `src/` is Node and the console is a browser page served
// from `console/` only, so the console cannot import across that boundary at runtime.
// It therefore declares its own display copy, and `test/lanes.mjs` asserts the two agree
// — the drift is caught in CI rather than trusted to discipline.

/** The `why` label a routed note carries. Verbatim: these strings go on the wire and into logs. */
export const LANES = [
  {
    id: 'mirrored feed',
    // Highest trust: an author the operator chose to mirror. Not questioned.
    from: 'watch_authors',
    dest: 'community channel',
    mentions: false,
    consentGated: true,       // §8 in-door gate applies (default-off)
    requiresWatchedNotes: false,
    membershipInSignedState: true,   // `follows[]` IS PUB.authors, with per-author consent
  },
  {
    id: 'granted participant',
    // Holds an admission the operator signed (§4.1 S3), revocable by a 441. Earns live
    // @mentions, which is why an unverified forgery here could have summoned the room —
    // hence the signature check that now precedes classification.
    from: 'a signed 440',
    dest: 'community channel',
    mentions: true,
    consentGated: false,      // already consensual: they hold a key
    requiresWatchedNotes: false,
    membershipInSignedState: false,
  },
  {
    id: 'standing follow',
    // Vouched to reply without review. Cannot start a thread — it is reply-trust only,
    // and it never mirrors a feed.
    from: 'trusted_repliers',
    dest: 'community channel',
    mentions: false,
    consentGated: false,      // already consensual: vouched by the maintainer
    requiresWatchedNotes: true,
    membershipInSignedState: false,  // only a count is published
  },
  {
    id: 'reply to our note',
    // A stranger replying to something of ours. Quarantined: nobody sees it until a human
    // releases it. With no staging channel configured this HOLDS rather than delivers.
    from: 'anyone replying to a watched note',
    dest: 'quarantine',
    mentions: false,
    consentGated: true,       // §132: an un-trusted reply is gated too
    requiresWatchedNotes: true,
    membershipInSignedState: false,
  },
]

/**
 * The outcome of a human release in the staging channel. Not produced by classification —
 * `routePublic` never assigns it — but it is a valid `why` on an egress record, so any
 * validator over `why` must accept it.
 */
export const RELEASED = 'released from quarantine'

/** Every valid `why` value on the wire, classification lanes plus the release outcome. */
export const WHY_VALUES = [...LANES.map(l => l.id), RELEASED]

/** Lane ids in gradient order, highest trust first. */
export const LANE_IDS = LANES.map(l => l.id)

export const laneById = (id) => LANES.find(l => l.id === id) || null

/**
 * Reasons a note is dropped or held BEFORE or DURING classification. These leave a log
 * line and no delivery. Named so a surface can enumerate them instead of implying that
 * "not delivered" means "not seen".
 *
 * `no match` is the only one that leaves NO record at all — it is a silent drop by
 * design, which is why a count of it can never be reported. A surface must render it as
 * unknown, never as zero: a zero would claim knowledge of an unrecorded event.
 */
export const DROPS = [
  { id: 'bad-signature', when: 'the note does not verify under the key it claims', recorded: true },
  { id: 'no match',      when: 'not mirrored, not admitted, not vouched, not a reply to a watched note', recorded: false },
  { id: 'no-consent',    when: 'the in-door consent gate is on and the author has not consented (or consented to superseded terms)', recorded: true },
  { id: 'muted',         when: 'the author was explicitly rejected by an approver', recorded: true },
  { id: 'no-staging',    when: 'a reply was quarantined but no staging channel is configured, so it is held undelivered', recorded: true },
]
