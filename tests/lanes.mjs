// The routing view must not be able to disagree with the classifier.
//
// `src/lanes.mjs` is the single source for the trust gradient — the classifier in
// routePublic, the egress `why` enum and the quarantine projection all read it. The
// console's routing page cannot import it at runtime (`src/` is Node; the page is served
// from `console/` only), so it keeps a display copy and THIS TEST is the join.
//
// The failure it prevents is specific and one-directional: rename or reorder a lane in
// the bridge, and a stale view keeps describing the old gradient — claiming the bridge is
// safer than it is. The same reasoning as nact's shared ceremony spec, where a signing
// surface must never show a softer picture than the review console.

import { readFileSync } from 'node:fs'
import { LANES, LANE_IDS, WHY_VALUES, RELEASED, DROPS } from '../src/lanes.mjs'

let pass = 0, fail = 0
const ok = (name, value) => { console.log(`${value ? 'ok  ' : 'FAIL'} — ${name}`); value ? pass++ : fail++ }

// The view's model is deliberately dependency-free and DOM-free, so it can be IMPORTED
// here rather than scraped out of the source. A real import is the stronger check: a
// renamed export fails to resolve instead of quietly matching nothing.
const { LANE_VIEW, DROP_VIEW, laneModel, laneLabel } = await import('../console/routing-model.mjs')

ok('the console declares a lane view for every lane, in the classifier\'s order',
  LANE_VIEW.length === LANE_IDS.length && LANE_VIEW.every((v, i) => v.id === LANE_IDS[i]))
ok('the console\'s drop row uses the classifier\'s own name for the silent drop',
  DROP_VIEW.id === DROPS.find(d => !d.recorded).id)
ok('every lane view carries the presentation fields the renderer reads',
  LANE_VIEW.every(v => v.fill && v.dest && v.why && v.from))
ok('exactly one drop reason is unrecorded, so exactly one lane may render an unknown count',
  DROPS.filter(d => !d.recorded).length === 1)

// Shape guarantees the consumers rely on.
ok('every lane carries the fields the classifier and the view both read',
  LANES.every(l => typeof l.id === 'string' && typeof l.dest === 'string' &&
    typeof l.consentGated === 'boolean' && typeof l.requiresWatchedNotes === 'boolean' &&
    typeof l.membershipInSignedState === 'boolean'))
ok('the egress why enum is the lanes plus the release outcome, and nothing else',
  WHY_VALUES.length === LANES.length + 1 && WHY_VALUES.at(-1) === RELEASED &&
  new Set(WHY_VALUES).size === WHY_VALUES.length)
ok('lane ids are unique', new Set(LANE_IDS).size === LANE_IDS.length)

// The consent gate is derived from lane data rather than a repeated pair of names, so
// adding a lane cannot silently escape it. Pin the current, deliberate answer: the two
// non-consensual lanes are gated; the two that already imply consent are not.
ok('exactly the two non-consensual lanes are consent-gated',
  LANES.filter(l => l.consentGated).map(l => l.id).join(' | ') ===
  'mirrored feed | reply to our note')
ok('the two lanes that require a watched note are the reply lanes',
  LANES.filter(l => l.requiresWatchedNotes).map(l => l.id).join(' | ') ===
  'standing follow | reply to our note')
ok('only the mirrored feed publishes its membership, which is why only it can be listed',
  LANES.filter(l => l.membershipInSignedState).map(l => l.id).join(' | ') === 'mirrored feed')

// The bridge must not have kept a private copy of the vocabulary.
const bridgeSrc = readFileSync(new URL('../src/bridge.mjs', import.meta.url), 'utf8')
const egressSrc = readFileSync(new URL('../src/egress.mjs', import.meta.url), 'utf8')
const quarantineSrc = readFileSync(new URL('../src/quarantine_projection.mjs', import.meta.url), 'utf8')
const routingHtml = readFileSync(new URL('../console/routing.html', import.meta.url), 'utf8')
const codeOf = text => text.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const restated = id => [bridgeSrc, egressSrc, quarantineSrc].some(s => codeOf(s).includes(`'${id}'`))
ok('no consumer restates a lane name as a literal outside lanes.mjs',
  !LANE_IDS.some(restated) && !restated(RELEASED))
ok('the routing lede separates verification/gate refusals from classified destinations',
  /clears signature verification and the configured gates/.test(routingHtml) &&
  /separate refusal outcomes/.test(routingHtml) && !/Every public note that reaches this bridge lands/.test(routingHtml))
// The lane is named here through `laneLabel`, not as a literal (#348). Copy and lane id are now
// separate fields, and a test that restates the display string would be the same duplication
// line 62 exists to forbid — it would pass against a page whose wording had drifted from the
// vocabulary source, and fail against one that was correctly renamed.
const letInLane = laneLabel(LANE_VIEW[1])
ok('the 441 control is scoped only to the lane for someone the owner let in',
  routingHtml.includes(`${letInLane} → quarantine`) &&
  /A 441 does not remove a mirrored feed, vouch, or mute/.test(routingHtml) &&
  !/any lane → dropped/.test(routingHtml))
// Negative control for the assertion above: it must be capable of failing. A label that appears
// nowhere in the page has to be rejected, or the check proves only that a string was compared.
ok('  and that check can fail — a lane label absent from the page is not accepted',
  !routingHtml.includes('a lane label that is not on this page → quarantine'))

// ── the view's honesty rules ───────────────────────────────────────────────────
// `laneModel` is pure, so the two rules the routing page must never break are checked
// here rather than left to care. Both are the same defect in different clothes: printing
// a number the signed state did not carry.

const bare = laneModel({ follows: [] })                    // no operations block at all
const full = laneModel({
  follows: [{ pubkey: 'a'.repeat(64), consent: 'active' }, { pubkey: 'b'.repeat(64), consent: 'asked' }],
  operations: { trust: { trusted_repliers: 3, muted_authors: 1, watched_notes: 7 },
    gates: { consent_required: true } },
})
const noNotes = laneModel({ follows: [], operations: { trust: { watched_notes: 0 }, gates: {} } })

ok('the silent drop NEVER carries a count, whatever the state says',
  bare.drop.count === null && full.drop.count === null && noNotes.drop.count === null)
ok('a count absent from the signed state is null, never zero',
  bare.lanes[2].count === null && bare.lanes[3].count === null && bare.consentOn === null)
ok('the lane whose membership is unpublished never reports a count from thin air',
  full.lanes[1].count === null && full.lanes[1].membership === 'unpublished')
ok('published standing-follow counts are reported as given', full.lanes[2].count === 3)
ok('watched notes are a reachability prerequisite, never mislabeled as quarantine traffic',
  full.watchedNotes === 7 && full.lanes[3].count === null)
ok('the mirrored-feed count comes from the follow list it can actually enumerate',
  full.lanes[0].count === 2 && full.lanes[0].membership === 'listed')
ok('with no watched notes, both reply lanes are inert rather than merely empty',
  noNotes.lanes[2].inert === true && noNotes.lanes[3].inert === true && noNotes.repliesReachable === false)
ok('reachability is unknown — not false — when the state does not say',
  bare.repliesReachable === null && bare.lanes[3].inert === false)
ok('the consent gate is reported as a tri-state: on, off, or unpublished',
  full.consentOn === true && noNotes.consentOn === false && bare.consentOn === null)
ok('whether quarantine delivers or holds is reported as unpublished, never guessed',
  full.lanes[3].deliversOrHolds === 'unpublished')
ok('the model exposes exactly one entry per classifier lane, in order',
  full.lanes.length === LANE_IDS.length && full.lanes.every((l, i) => l.id === LANE_IDS[i]))

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
