// The pure model behind console/routing.html — signed state in, per-lane facts out.
//
// DEPENDENCY-FREE AND DOM-FREE on purpose, so `tests/lanes.mjs` can import it under Node
// and pin the two rules this view must never break:
//   · a count is null unless the signed state actually carried it
//   · the silent drop is ALWAYS null — printing 0 there would claim knowledge of an
//     event that leaves no record by design
//
// The lane vocabulary here is a display copy of `src/lanes.mjs`. `src/` is Node and the
// console is served from `console/` only, so a runtime import across that boundary is
// impossible; `tests/lanes.mjs` asserts the two agree. A view that drifted from the
// classifier would drift in the worst direction — claiming the bridge is safer than it is.

// ── the display copy for src/lanes.mjs ────────────────────────────────────────
// `id` MUST equal the lane id in src/lanes.mjs, in the same order. tests/lanes.mjs
// asserts it. Everything else here is presentation the bridge has no business carrying.
export const LANE_VIEW = [
  { id: 'mirrored feed', fill: '▓▓', dest: 'straight to the channel',
    why: 'Authors you chose to mirror. Not questioned.', from: 'the signed follow list' },
  { id: 'granted participant', fill: '▓▓', dest: 'straight to the channel · + live @mentions',
    why: 'Holds an admission you signed. Revocable by you, any time.', from: 'a 440 you signed' },
  { id: 'standing follow', fill: '▒▒', dest: 'no queue',
    why: 'Vouched to reply without review. Cannot start a thread.', from: 'trusted_repliers' },
  { id: 'reply to our note', fill: '░░', dest: 'quarantine — held for you',
    why: 'A stranger replying to something of ours. Nobody sees it until you do.', from: 'anyone replying to a watched note' },
]
export const DROP_VIEW = { id: 'no match', fill: '··', dest: 'dropped, silently',
  why: 'Not mirrored, not admitted, not vouched, not a reply to a watched note. It never reaches the channel and is not held for review. Nothing is counted here — a drop leaves no record by design.' }

// ── the model ─────────────────────────────────────────────────────────────────
// Pure: signed state in, per-lane facts out. Separated from rendering so the two rules
// this page must never break are enforced by `tests/lanes.mjs` rather than by care:
//   · a count is `null` unless the signed state actually carried it
//   · the silent drop is ALWAYS null — a zero there would claim knowledge of an
//     unrecorded event
export function laneModel(state) {
  const ops = state?.operations || null
  const trust = ops?.trust || null
  const gates = ops?.gates || null
  const num = v => (Number.isFinite(v) ? v : null)
  const watchedNotes = num(trust?.watched_notes)
  const consentOn = gates ? !!gates.consent_required : null
  const follows = Array.isArray(state?.follows) ? state.follows : []

  // A derivable fact worth surfacing: lanes 3 and 4 are only reachable when at least one
  // of our notes is watched (`else if (PUB.events.length)` in routePublic). With none
  // watched, no reply can classify at all — those lanes are inert, not merely empty.
  const repliesReachable = watchedNotes === null ? null : watchedNotes > 0

  return {
    consentOn,
    repliesReachable,
    watchedNotes,
    follows,
    lanes: [
      { id: LANE_VIEW[0].id, count: follows.length, membership: 'listed' },
      { id: LANE_VIEW[1].id, count: null, membership: 'unpublished' },
      { id: LANE_VIEW[2].id, count: num(trust?.trusted_repliers), membership: 'unpublished',
        inert: repliesReachable === false },
      { id: LANE_VIEW[3].id, count: null, membership: 'unpublished',
        inert: repliesReachable === false, muted: num(trust?.muted_authors),
        deliversOrHolds: 'unpublished' },
    ],
    drop: { id: DROP_VIEW.id, count: null },   // invariant: never a number
  }
}
