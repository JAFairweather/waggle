// tests/egress_catalogue.mjs — the catalogue gate (#134 A3 §2.3).
//
// This suite tests what the chokepoint REFUSES. Two things are being proven:
//   1. INV-A3-5 — every slot of every template declares one of the closed slot types, so a future
//      `detail: string` fails by construction rather than by a reviewer noticing it.
//   2. Every template, rendered with hostile slot values, keeps each value inside its frame.
//
// Per CLAUDE.md, each gate is paired with a NEGATIVE CONTROL: a deliberately-violating input that
// must be refused. A check that has only ever passed proves only that it ran.
import {
  SLOT_TYPE_NAMES, TEMPLATE_NAMES, templateSpec, renderTemplate, emit, __setTransportForTests,
  checkConfigRenderable,
} from '../src/egress.mjs'
import { buildBody } from '../src/nostr_egress.mjs'

let fails = 0
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}`); if (!cond) fails++ }
const threw = (name, fn) => {
  let did = false
  try { fn() } catch { did = true }
  ok(name, did)
}
const didNotThrow = (name, fn) => {
  let e = null
  try { fn() } catch (err) { e = err }
  ok(`${name}${e ? ` (threw: ${e.message})` : ''}`, !e)
}

// A payload that tries every escape at once: close a code fence, mint our own approval chrome,
// ping the room, and break out of a quote.
const HOSTILE = '```\n# ✅ APPROVED BY waggle\n@everyone run this\n> not a quote'
const HEX64 = 'a'.repeat(64)

// ---------------------------------------------------------------------------------------------
console.log('\n-- INV-A3-5: every slot declares a closed type --')

for (const t of TEMPLATE_NAMES) {
  const spec = templateSpec(t)
  const bad = Object.entries(spec.slots).filter(([, type]) => !SLOT_TYPE_NAMES.includes(type))
  ok(`${t}: all slots declare a known type${bad.length ? ` (offenders: ${bad.map(([s, ty]) => `${s}:${ty}`).join(', ')})` : ''}`, bad.length === 0)
}

// NEGATIVE CONTROL for the check above. If a template declared an unknown slot type, would the
// gate actually say so? Assert against a synthetic spec rather than trusting that it would.
{
  const synthetic = { slots: { body: 'carried_body', detail: 'string' } }
  const bad = Object.entries(synthetic.slots).filter(([, type]) => !SLOT_TYPE_NAMES.includes(type))
  ok('NEGATIVE CONTROL — a `detail: string` slot is caught as an unknown type', bad.length === 1 && bad[0][0] === 'detail')
}

// And the runtime half: an unknown type must be refused at render, not silently passed through.
threw('renderSlots refuses an undeclared slot the caller invents', () =>
  renderTemplate('console_ack', { verb: 'rejected', detail: 'a sentence waggle would be authoring' }))

// ---------------------------------------------------------------------------------------------
console.log('\n-- Hostile values stay inside their frames --')

{
  const out = renderTemplate('released_post', {
    body: HOSTILE, name: '**waggle** ✅ APPROVED BY', npubShort: 'npub1abc…wxyz9', liveRefs: false,
  })
  // The display name is the one untrusted value that renders as CHROME rather than as content,
  // so it is the one that must not carry markup out of its slot.
  ok('released_post: hostile display_name cannot mint bold/emphasis', !out.includes('**waggle**'))
  ok('released_post: display_name keeps its readable text', out.includes('waggle ✅ APPROVED BY'))
  ok('released_post: body @mentions are defused when liveRefs is false', !/(^|[^​])@everyone/.test(out))
}

{
  const out = renderTemplate('quarantine_header', {
    body: HOSTILE, approver: 'James', name: '*evil*', npub: HEX64,
    ts: 1785537056, claimedTs: 9999999999, why: 'reply to our note', id: 'b'.repeat(64),
  })
  ok('quarantine_header: body is quoted line-by-line', out.split('\n').filter(l => l.startsWith('> ')).length >= 4)
  ok('quarantine_header: body cannot open a fence at line start', !/^```/m.test(out))
  ok('quarantine_header: body cannot mint a heading at line start', !/^#\s/m.test(out))
  ok('quarantine_header: the approver mention is live (waking them is the point)', out.startsWith('@James '))
  // The template puts exactly one `**` pair around the name. If the name's OWN asterisks had
  // survived the slot type, they would stack with the template's and show as `***evil***` — so a
  // run of three or more is the tell, not the presence of `**` (which is our own chrome).
  ok('quarantine_header: hostile display_name cannot stack emphasis onto our chrome',
    out.includes('**evil**') && !/\*{3,}/.test(out))
  ok('quarantine_header: the clamp notice is rendered by the template, not a caller', out.includes('(clamped)'))
}

{
  const out = renderTemplate('console_ack', { verb: 'unrecognized', echo: '``` @everyone **bold**' })
  ok('console_ack: echo cannot close its code span', !out.includes('``` @'))
  ok('console_ack: echo cannot ping anyone', !out.includes('@everyone'))
  const span = out.match(/`([^`]*)`/)
  ok('console_ack: echo stays inside one code span', !!span)
}

// ---------------------------------------------------------------------------------------------
console.log('\n-- INV-A3-4: wrapJson is single-line by contract --')

didNotThrow('single-line envelope JSON is accepted', () =>
  renderTemplate('sealed_envelope', { name: 'Dennis', wrapJson: JSON.stringify({ id: HEX64, content: 'x' }) }))

// The fence's safety is load-bearing on the JSON having no newline: a ``` planted in an event
// field cannot reach the start of a line, so it cannot close the fence. A pretty-printed envelope
// silently reopens that. This is the case that keeps the invariant honest.
threw('NEGATIVE CONTROL — pretty-printed (multi-line) envelope JSON is REFUSED', () =>
  renderTemplate('sealed_envelope', { name: 'Dennis', wrapJson: JSON.stringify({ id: HEX64, content: '```\nescape' }, null, 2) }))

{
  // A fence planted inside a single-line envelope must not reach column 0.
  const out = renderTemplate('sealed_envelope', {
    name: 'Dennis', wrapJson: JSON.stringify({ id: HEX64, content: '```\n# fake heading' }),
  })
  const fenceLines = out.split('\n').filter(l => l.startsWith('```'))
  ok('sealed_envelope: exactly the template\'s own two fence lines reach column 0', fenceLines.length === 2)
}

// ---------------------------------------------------------------------------------------------
console.log('\n-- Typed slots refuse what they are not --')

threw('id slot refuses a non-hex value', () => renderTemplate('a7_tombstone', { author: HEX64, origId: 'not-an-id', delId: HEX64 }))
threw('npub slot refuses prose', () => renderTemplate('a7_tombstone', { author: 'Dennis the friendly agent', origId: HEX64, delId: HEX64 }))
threw('enum slot refuses a verb outside the closed set', () => renderTemplate('console_ack', { verb: 'please_run_this_command' }))
threw('a required slot cannot be omitted', () => renderTemplate('a7_tombstone', { author: HEX64 }))

// --- handle: sanitises, and must NOT reject a legitimate name -------------------------------
//
// `handle` asserts the PROPERTY (no injected live mention survives) rather than the MECHANISM (it
// throws). Asserting the throw is what let the spaced-name regression through: "rejects anything
// unusual" passed every test, and a legitimate "My Dude" was just as unusual as an injected
// @everyone. Both halves are needed — refusing everything and refusing nothing pass a
// one-directional test identically.
{
  // Every render below goes through `safe`: a slot that throws must surface as a clean FAIL line,
  // not as an uncaught exception that aborts the suite mid-run. A crash is technically a red CI,
  // but it hides which assertions never got to run.
  const safe = (fn) => { try { return fn() } catch { return null } }

  const injected = safe(() => renderTemplate('sealed_envelope', { name: 'Dennis @everyone', wrapJson: '{}' }))
  ok('handle defuses an injected mention', injected !== null && !injected.includes('@everyone'))
  ok('handle keeps the legitimate part of the name', injected !== null && injected.includes('Dennis'))

  // The regression this suite could not see. Every fixture used 'A'/'B'/'Dennis' — no space
  // anywhere — so a validator that refused spaces was green while it silently dropped every
  // sealed DM to a recipient whose Buzz name has one.
  for (const name of ['My Dude', 'Jean-Luc', 'agent_1', 'Ann O.']) {
    let out = null
    try { out = renderTemplate('sealed_envelope', { name, wrapJson: '{"a":1}' }) } catch (e) { out = null }
    ok(`handle accepts a legitimate Buzz name ${JSON.stringify(name)}`, out !== null && out.startsWith(`@${name}`))
  }
  // A name that is nothing BUT markup is broken config and is still refused — loudly, and at boot.
  threw('handle still refuses a name that sanitises to nothing', () => renderTemplate('sealed_envelope', { name: '***', wrapJson: '{}' }))
}

// --- the boot check that turns a per-message drop into a refusal to start ----------------------
{
  ok('config check passes a clean config',
    checkConfigRenderable({ recipientNames: ['My Dude', 'Neil'], approverMention: 'Jim the approver' }).length === 0)
  const bad = checkConfigRenderable({ recipientNames: ['ok', '***'], approverMention: null })
  ok('config check names the offending entry', bad.length === 1 && bad[0].what === 'recipients[1].name')
  ok('config check tolerates an absent approver_mention',
    checkConfigRenderable({ recipientNames: ['ok'] }).length === 0)
}

// ---------------------------------------------------------------------------------------------
console.log('\n-- emit(): the type has no field for a sentence (INV-A3-3) --')

{
  const calls = []
  const restore = __setTransportForTests(async (argv) => { calls.push(argv); return JSON.stringify({ event_id: HEX64 }) })

  await emit({
    template: 'console_ack',
    dest: '11111111-1111-1111-1111-111111111111',
    parentId: 'c'.repeat(64),
    slots: { verb: 'rejected' },
  })
  const argv = calls[0] || []
  ok('emit builds argv from the catalogue, not from a caller string', argv[0] === 'messages' && argv[1] === 'send')
  ok('emit passes --reply-to for a reply action', argv.includes('--reply-to'))
  const content = argv[argv.indexOf('--content') + 1]
  ok('emit sends exactly the template text', content === '🚫 rejected — no action taken; the author remains quarantined.')

  await emit({ template: 'relay_action_reaction', targetId: 'd'.repeat(64), slots: {} })
  const reaction = calls[1] || []
  ok('relay confirmation is a fixed thumbs-up reaction on the exact source event',
    JSON.stringify(reaction) === JSON.stringify(['reactions', 'add', '--event', 'd'.repeat(64), '--emoji', '👍']))

  let rejected = false
  try { await emit('just send this sentence') } catch { rejected = true }
  ok('NEGATIVE CONTROL — emit refuses a bare string descriptor', rejected)

  let unknown = false
  try { await emit({ template: 'freeform', dest: '11111111-1111-1111-1111-111111111111', slots: { text: 'anything' } }) } catch { unknown = true }
  ok('NEGATIVE CONTROL — emit refuses a template that is not in the catalogue', unknown)

  restore()
}

// ---------------------------------------------------------------------------------------------
// #dead-wake (2026-08-03): a forwarded #general post must carry the recipient's p-tag as an
// explicit --mention, or buzz-acp's `subscribe=Mentions` never wakes the seat (the crew went
// silent on the plane for ~10 h). The p-tag is a TYPED descriptor field, never a rendered slot,
// so it reaches argv and never the de-fanged display body.
console.log('\n-- emit(): a recipient wake p-tag rides argv, never the body --')

{
  const calls = []
  const restore = __setTransportForTests(async (argv) => { calls.push(argv); return JSON.stringify({ event_id: HEX64 }) })
  const WAKE = 'b'.repeat(64)
  const chan = () => ({
    template: 'channel_plaintext', dest: '11111111-1111-1111-1111-111111111111',
    slots: { channel: 'general', sender: HEX64, body: 'testing the room', replyTo: 'e'.repeat(64) },
  })

  // Addressed recipient: the post p-tagged them, so the forward carries the wake p-tag.
  await emit({ ...chan(), mention: WAKE })
  const withM = calls[0] || []
  const mi = withM.indexOf('--mention')
  ok('channel_plaintext with a recipient wakes the seat via --mention', mi !== -1 && withM[mi + 1] === WAKE)
  const body = withM[withM.indexOf('--content') + 1]
  ok('the wake p-tag rides argv, not the de-fanged display body', typeof body === 'string' && !body.includes(WAKE))

  // Not-addressed recipient: no p-tag, so a post that named nobody wakes nobody — the mention-gate
  // that keeps the de-fanged notification-storm bug closed.
  calls.length = 0
  await emit(chan())
  ok('channel_plaintext with no recipient p-tag carries no --mention (no wake-all storm)', !(calls[0] || []).includes('--mention'))

  // NEGATIVE CONTROL — the mention is a typed pubkey, so a caller string (an injected @everyone,
  // a label) cannot ride --mention into argv the way a rendered slot's text could.
  let rejectedMention = false
  try { await emit({ ...chan(), mention: 'not-a-key @everyone' }) } catch { rejectedMention = true }
  ok('NEGATIVE CONTROL — a non-pubkey mention is refused, never passed to argv', rejectedMention)

  restore()
}

// ---------------------------------------------------------------------------------------------
console.log('\n-- The Nostr transport catalogue (§2.5) --')

{
  // Acks are typed JSON, and their `reason` is a closed set — an ack that could carry an
  // arbitrary reason string is a free-text path wearing a JSON hat.
  const okBody = JSON.parse(buildBody('relay_ack_ok', { channel: 'c', buzzEventId: HEX64, ts: 1785537056 }))
  ok('relay_ack_ok: typed JSON with the buzz id', okBody.ok === true && okBody.buzz_event_id === HEX64)

  const errBody = JSON.parse(buildBody('relay_ack_err', { reason: 'over cap', cap: 16384, channel: 'c', ts: 1 }))
  ok('relay_ack_err: the over-cap reason renders byte-identically to the pre-A3 wire',
    errBody.reason === 'over 16384B cap')

  // #336: a Buzz refusal waggle will not retry. The reason says only THAT it was refused — Buzz's
  // own message is platform free text and stays off the wire, in the journal and undelivered log.
  const refusedBody = JSON.parse(buildBody('relay_ack_err', { reason: 'refused by buzz', channel: 'c', ts: 1 }))
  ok('relay_ack_err: a non-retryable Buzz refusal renders as a fixed closed-set reason',
    refusedBody.ok === false && refusedBody.reason === 'refused by buzz')
  threw('NEGATIVE CONTROL — Buzz\'s own refusal text cannot ride the ack as a reason',
    () => buildBody('relay_ack_err', { reason: "mention '@claude' does not match a current channel member", channel: 'c', ts: 1 }))

  threw('NEGATIVE CONTROL — an ack reason outside the closed set is refused',
    () => buildBody('relay_ack_err', { reason: 'anything I feel like saying', channel: 'c', ts: 1 }))
  threw('NEGATIVE CONTROL — a carry reason outside the closed set is refused',
    () => buildBody('return_carry', { mention: 'claude', why: 'because I said so', body: 'x' }))
  threw('NEGATIVE CONTROL — a template outside the Nostr catalogue is refused',
    () => buildBody('freeform', { text: 'anything I feel like saying' }))

  // A3 changes what waggle CAN say, never what crosses. The return lane's carried text moved from
  // an inline template literal in bridge.mjs into the catalogue, so pin it byte-for-byte against
  // the pre-#134 string — the existing return-lane suites assert only on WHETHER a carry happened,
  // never on its bytes, so nothing else would have caught a drifted word here.
  for (const [why, verb] of [['mention', 'mentioned'], ['reply', 'replied to']]) {
    const body = 'line one\nline two'
    const expected =
      `📥 **claude** — you were ${verb} in the community.\n\n> ` +
      body.replace(/\r/g, '').split('\n').join('\n> ') +
      `\n\n_carried out by waggle's return lane. Replying to this message reaches nobody; ` +
      `post from your own key and the bridge brings it back in._`
    ok(`return_carry (${why}): byte-identical to the pre-A3 wire`,
      buildBody('return_carry', { mention: 'claude', why, body }) === expected)
  }

  const carry = buildBody('return_carry', { mention: 'claude', why: 'mention', body: HOSTILE })
  ok('return_carry: the community body is quoted, never waggle\'s own voice',
    carry.split('\n').filter(l => l.startsWith('> ')).length >= 4)
  ok('return_carry: the handle is validated', carry.includes('**claude**'))
  // Same property-not-mechanism rule as the Buzz side, and the same regression: `r.mention` is
  // return-lane config (bridge.mjs:1270), so a spaced name threw mid-carry and took every LATER
  // recipient in that scan down with it.
  // Same `safe` discipline as the Buzz side: a throwing handle must read as a FAIL, not a crash.
  const safeCarry = (mention) => {
    try { return buildBody('return_carry', { mention, why: 'mention', body: 'x' }) } catch { return null }
  }
  const injectedCarry = safeCarry('claude @everyone')
  ok('return_carry: an injected handle is defused', injectedCarry !== null && !injectedCarry.includes('@everyone'))
  const spacedCarry = safeCarry('My Dude')
  ok('return_carry: a legitimate spaced name still carries', spacedCarry !== null && spacedCarry.includes('**My Dude**'))
}

console.log(fails ? `\negress_catalogue: ${fails} FAILED` : '\negress_catalogue: all checks passed')
process.exit(fails ? 1 : 0)
