// src/egress.mjs — the Buzz-egress chokepoint (#134 A3; docs/DESIGN_EGRESS_CHOKEPOINT.md).
//
// waggle is infrastructure. It carries, it never authors. Before this module, that property was
// held by CONVENTION — by every author so far having chosen to write a template — and convention
// is exactly what failed on 2026-07-31. Seven call sites each reached execFile('buzz', …) and the
// CLI signed whatever string it was handed; the good paths and the bad path were the same call.
//
// The fix is not a check that callers must remember to run. It is a VOCABULARY WITH NO WORD FOR
// THE FORBIDDEN THING: emit() takes a tagged union, never a string, so "send this sentence" is
// not expressible. There is exactly one execFile('buzz', …) write in the tree and it is below.
//
// INV-A3-1  every emitted byte is a source literal, a typed slot value, or a carried_body that
//           went through a neutralising renderer
// INV-A3-3  no caller can reach the signer with a caller-composed string — by type shape
// INV-A3-4  wrapJson is single-line by contract (§2.4), enforced at render time
// INV-A3-5  every slot of every template declares one of the closed slot types
import { execFile } from 'node:child_process'
import { renderQuarantined, renderReleased, renderChannelPlain } from './render.mjs'

// --- The closed slot-type set (§2.2, INV-A3-5) -----------------------------------------------
//
// Closing the TYPE set is what makes this structural rather than conventional. A template
// language with a {message} slot is the original hole with extra steps, so there is deliberately
// no slot type that accepts free prose: `carried_body` accepts arbitrary bytes but always renders
// through the hostile-content renderer and always lands attributed to an external author, and
// `inline_token` accepts operator text but is stripped and capped and never leaves its code span.
//
// A future `detail: string` fails by construction here — as an UNKNOWN SLOT TYPE — with no
// reviewer required to notice it. Adding a ninth type is a deliberate spec change, which is
// exactly the friction wanted.
const reject = (type, why) => { throw new Error(`egress: slot rejected (${type}): ${why}`) }

const hexOfLength = (n, type) => (v) => {
  const s = String(v == null ? '' : v).toLowerCase()
  if (!new RegExp(`^[0-9a-f]{${n}}$`).test(s)) reject(type, `expected ${n} hex chars, got ${JSON.stringify(String(v).slice(0, 24))}`)
  return s
}

// Short operator-supplied text, rendered INSIDE backticks and never permitted to leave them.
// This type exists for exactly one reason: handleCommand's unrecognized-verb reply already
// echoes the approver's own word back at them, and deleting that affordance would change
// behaviour. It is the narrowest thing that preserves it — not a general-purpose string slot.
const INLINE_TOKEN_MAX = 24
const inlineToken = (v) => {
  const s = String(v == null ? '' : v)
    .replace(/[`\r\n]/g, '')       // cannot close its own code span, cannot reach a new line
    .replace(/[@*_]/g, '')         // cannot ping anyone, cannot mint emphasis
    .slice(0, INLINE_TOKEN_MAX)
  return s
}

const SLOT_TYPES = {
  id: hexOfLength(64, 'id'),
  hex: hexOfLength(64, 'hex'),
  // An npub is bech32, not hex — but every caller here holds either an npub string or a raw
  // pubkey, so this accepts both shapes and nothing else. Anything with whitespace or markup in
  // it is not an identity and is refused.
  npub: (v) => {
    const s = String(v == null ? '' : v)
    if (!/^(npub1[0-9a-z]{20,90}|[0-9a-f]{64})$/i.test(s)) reject('npub', `not an npub or pubkey: ${JSON.stringify(s.slice(0, 24))}`)
    return s
  },
  // A resolved channel handle or UUID. Never a caller-composed label.
  channel: (v) => {
    const s = String(v == null ? '' : v)
    if (!/^[0-9a-fA-F-]{36}$|^[\w][\w .-]{0,63}$/.test(s)) reject('channel', `not a channel handle or UUID: ${JSON.stringify(s.slice(0, 32))}`)
    return s
  },
  count: (v) => { const n = Number(v); if (!Number.isFinite(n)) reject('count', `not a number: ${JSON.stringify(v)}`); return String(n) },
  ts: (v) => { const n = Number(v); if (!Number.isFinite(n)) reject('ts', `not a number: ${JSON.stringify(v)}`); return String(n) },
  // `enum` is special-cased in renderSlots because its permitted set is per-slot, declared in the
  // catalogue. Listed here so it is a member of the closed set like everything else.
  enum: (v) => String(v),
  inline_token: inlineToken,
  // An EXTERNAL author's display name, from their public kind:0 — fully attacker-controlled, and
  // rendered OUTSIDE any code span (in bold, on the attribution line). `inline_token` is the wrong
  // type for it precisely because that type's contract is "never leaves the code span".
  //
  // The same stripping already happens at the fetch site, which is why this is not a live hole
  // today. But it lives there by CONVENTION — a future caller sourcing a name from anywhere else
  // gets no guard at all. Moving it into the type is the whole thesis of A3 applied to the one
  // untrusted slot that renders as chrome rather than as content. The fetch-site strip stays as
  // belt-and-braces.
  display_name: (v) => String(v == null ? '' : v).replace(/[`@[\]()\n\r*_~]/g, '').trim().slice(0, 32),
  // A Buzz @handle from OPERATOR CONFIG, rendered as a LIVE mention on purpose — waking the
  // approver is the point of the quarantine header, and waking the recipient is the point of a
  // sealed-envelope delivery. Distinct from display_name for exactly that reason: this one is
  // trusted-by-provenance and keeps its @, so it must never be fed an external value.
  //
  // SANITISES, IT DOES NOT REJECT — and the difference is a production incident. An earlier form
  // required /^[\w][\w.-]{0,63}$/, which refuses any name containing a SPACE. Buzz display names
  // routinely have one ("My Dude" is a crew member named in #134), and `approver_mention` is
  // documented in config.example.json as "<Buzz @name…>". A rejection here is not a caught error:
  // both call sites mark the event seen BEFORE emit resolves (bridge.mjs:558 sealed, :781 public),
  // so a throw logs one line and the message is gone — dropped from durable dedup, unrecoverable
  // across restart. On the public lane a spaced approver_mention would have failed EVERY
  // quarantined arrival.
  //
  // The prior code at both sites was a bare `@${name}` that accepted anything, so rejecting is a
  // regression, not a tightening. What A3 actually needs from this slot is that a config value
  // cannot break out of the template — not that it match an identifier grammar. So: strip what
  // could escape (backtick, newline, markup, a second @), cap the length, keep everything else
  // including spaces. A value that sanitises to nothing IS broken config and is still refused —
  // loudly at boot now, via checkConfigRenderable() below, rather than per-message hours later.
  handle: (v) => {
    const s = String(v == null ? '' : v)
      .replace(/[`\r\n]/g, '')        // cannot open a code span, cannot reach a new line
      // `_` is deliberately NOT stripped: the prior regex allowed it via \w, so `agent_1` is a
      // legitimate handle and removing it would corrupt a real name to fix nothing. (display_name
      // does strip it — that slot is attacker-controlled, this one is operator config.)
      .replace(/[@[\]()*~]/g, '')     // no second mention, no link, no emphasis
      .trim()
      .slice(0, 64)
    if (!s) reject('handle', `empty after sanitising: ${JSON.stringify(String(v).slice(0, 32))}`)
    return s
  },
  // The ONLY slot that accepts arbitrary bytes. It never renders as waggle's own words: the
  // renderer neutralises it and the surrounding template attributes it to its external author.
  // What A3 blocks is authorship reconstruction, and attribution blocks that at any N.
  carried_body: (v) => String(v == null ? '' : v),
  // Site 1's sealed envelope JSON. INV-A3-4: single-line BY CONTRACT, not by accident of
  // formatting. It is embedded in a fenced code block, and the fence's safety is load-bearing on
  // the JSON containing no newline — a planted ``` cannot reach the start of a line and so cannot
  // close the fence. A future JSON.stringify(ev, null, 2) is an entirely reasonable-looking
  // readability change that would silently reopen a fence break, so the escaper refuses it here
  // rather than trusting whoever edits the call site next.
  wrapJson: (v) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    if (/[\r\n]/.test(s)) reject('wrapJson', 'contains a newline — INV-A3-4 requires single-line JSON (never pretty-printed)')
    return s
  },
}

export const SLOT_TYPE_NAMES = Object.freeze(Object.keys(SLOT_TYPES))

// --- The catalogue (§2.1) --------------------------------------------------------------------
//
// Closed and compiled in. `slots` declares each slot's TYPE — that declaration is what the
// catalogue test asserts against SLOT_TYPE_NAMES, so an unknown type cannot reach production.
// `action` picks the argv shape; every one of them ends at the single execFile below.
const CATALOGUE = {
  // Site 1 — forward(): a sealed 1059 handed to a recipient's inbox. The prose is entirely in
  // this template; the only variables are the recipient, the channel name, and the envelope.
  sealed_envelope: {
    action: 'send',
    slots: { name: 'handle', channel: 'channel', wrapJson: 'wrapJson' },
    optional: ['channel'],
    render: ({ name, channel, wrapJson }) => {
      const label = channel
        ? `New Concord channel post on **${channel}** — its outer \`p\` tag is a random decoy, not a recipient. ` +
          `Decrypt with the plane key you derive from the **${channel} community_root** ` +
          `(publicChannel(root, channel_id, epoch).conv); do NOT re-seal. If your runtime holds no Concord grant for ` +
          `this channel, you cannot open it yet — that's a provisioning gap, flag it and hold:`
        : `New Armada DM — sealed, unwrap with your key:`
      return `@${name}\n\n${label}\n\n\`\`\`json\n${wrapJson}\n\`\`\`\n`
    },
  },

  // Site 1b — forward(), inbound Concord DECRYPT (#191, option 1). When the box holds the
  // community read-key, a channel wrap is delivered as PLAINTEXT instead of a sealed_envelope, so
  // the seat reads it without touching Concord. `body` is `carried_body` — the ONLY slot that
  // accepts arbitrary bytes, neutralised by the renderer and attributed to its channel author, so
  // a hostile #general post cannot reconstruct waggle's own words or ping a member in the inbox.
  // `sender` is the rumor author's real pubkey; `replyTo` is the inbound wrap id for seal-back.
  channel_plaintext: {
    action: 'send',
    slots: { channel: 'channel', sender: 'npub', body: 'carried_body', replyTo: 'id' },
    render: (s) => renderChannelPlain(s),
  },

  // Site 2a — forwardPublic(), quarantined. The renderer is the guard; it is unchanged.
  // `when`, `claim` and `why` were caller-composed strings before this. They are now a timestamp,
  // an optional timestamp, and an enum — the three of them were the quiet half of §1.1's hole:
  // benign today, and nothing but convention stopped the next edit concatenating into them.
  quarantine_header: {
    action: 'send',
    slots: {
      body: 'carried_body', approver: 'handle', name: 'display_name', npub: 'npub',
      ts: 'ts', claimedTs: 'ts', why: 'enum', id: 'id',
    },
    optional: ['approver', 'name', 'claimedTs'],
    enums: { why: ['mirrored feed', 'granted participant', 'standing follow', 'reply to our note', 'released from quarantine'] },
    render: ({ body, approver, name, npub, ts, claimedTs, why, id }) => renderQuarantined({
      body,
      mention: approver ? `@${approver} ` : '',
      name,
      npub,
      when: new Date(Number(ts) * 1000).toISOString(),
      // The clamp notice is prose, so it belongs here and not in a caller's string. A5 clamps an
      // attacker-controlled created_at; this is how the reader is told the claim was moved.
      claim: claimedTs ? `  ·  ⚠︎ author-claimed \`${new Date(Number(claimedTs) * 1000).toISOString()}\` (clamped)` : '',
      why,
      id,
    }),
  },

  // Sites 2b and 7 — forwardPublic() released, and postRelay(). A vouched identity's own words,
  // attributed, with liveRefs deciding whether its @mentions survive (#94).
  released_post: {
    action: 'send',
    slots: { body: 'carried_body', name: 'display_name', npubShort: 'inline_token', liveRefs: 'enum' },
    optional: ['name'],
    enums: { liveRefs: [true, false] },
    render: (s) => renderReleased(s),
  },

  // Sites 3 and 5 — withdraw()'s follow-up post and its edit tier. Same bytes, two actions.
  a7_tombstone: {
    action: 'send',
    slots: { author: 'npub', origId: 'id', delId: 'id' },
    render: ({ author, origId, delId }) =>
      `🗑 **Withdrawn by author** — NIP-09 deletion\n` +
      `author \`${author}\` · original \`${origId}\` · delete \`${delId}\`\n` +
      `_Content removed at the author's request._\n`,
  },
  a7_tombstone_edit: {
    action: 'edit',
    slots: { author: 'npub', origId: 'id', delId: 'id' },
    render: (s) => CATALOGUE.a7_tombstone.render(s),
  },

  // Site 4 — withdraw()'s delete tier. No body at all: a fixed public reason, in the argv.
  a7_delete: {
    action: 'delete',
    slots: {},
    render: () => null,
  },

  // Site 6 — the approval console's confirmations. This is the template that closes the actual
  // hole: replyInStaging used to take a `text: string`, and its unrecognized-verb caller passed
  // runtime-variable operator input. Now the caller picks a VERB and the words live here.
  console_ack: {
    action: 'reply',
    slots: { verb: 'enum', author: 'npub', echo: 'inline_token', granted: 'enum' },
    optional: ['author', 'echo', 'granted'],
    enums: {
      verb: ['unrecognized', 'rejected', 'muted', 'no_original', 'bad_signature', 'rate_capped', 'released'],
      granted: [true, false],
    },
    render: ({ verb, author, echo, granted }) => {
      switch (verb) {
        case 'unrecognized':
          return `unrecognized command \`${echo}\` — try **approve** (or release), **follow**, **mute**, or **reject**.`
        case 'rejected':
          return `🚫 rejected — no action taken; the author remains quarantined.`
        case 'muted':
          return `🔇 muted \`${String(author).slice(0, 12)}…\` — their replies will no longer reach staging.`
        case 'no_original':
          return `⚠️ could not fetch the original from any relay — nothing released.`
        case 'bad_signature':
          return `⚠️ signature verification FAILED — refusing to release.`
        case 'rate_capped':
          return `⚠️ rate cap would be exceeded — try again later.`
        case 'released':
          return `✅ released to the community channel${granted ? ` · standing follow granted (their replies now skip the queue)` : ''}`
        // No default: renderSlots has already refused any verb outside the enum, so an
        // unreachable branch here would only hide a catalogue/enum mismatch.
      }
      reject('enum', `console_ack verb fell through: ${JSON.stringify(verb)}`)
    },
  },

  // The `released` ack has one more shape: the note was already out. Kept as its own verb rather
  // than a boolean on `released`, so the catalogue reads as the set of things waggle can say.
  console_ack_already: {
    action: 'reply',
    slots: { granted: 'enum' },
    optional: ['granted'],
    enums: { granted: [true, false] },
    render: ({ granted }) =>
      `✅ already released earlier${granted ? ` · standing follow granted (their replies now skip the queue)` : ''}`,
  },
}

export const TEMPLATE_NAMES = Object.freeze(Object.keys(CATALOGUE))
export const templateSpec = (name) => CATALOGUE[name]

// --- Rendering: every slot through its declared type ------------------------------------------
function renderSlots(templateName, slots = {}) {
  const spec = CATALOGUE[templateName]
  if (!spec) reject('template', `unknown template ${JSON.stringify(templateName)}`)
  const optional = new Set(spec.optional || [])
  const out = {}
  for (const [slot, type] of Object.entries(spec.slots)) {
    const raw = slots[slot]
    const absent = raw === undefined || raw === null || raw === ''
    if (absent) {
      if (!optional.has(slot)) reject(type, `template ${templateName} requires slot ${slot}`)
      out[slot] = type === 'enum' ? undefined : ''
      continue
    }
    if (type === 'enum') {
      const permitted = (spec.enums || {})[slot]
      if (!permitted || !permitted.includes(raw)) reject('enum', `${templateName}.${slot} not in {${(permitted || []).join('|')}}: ${JSON.stringify(raw)}`)
      out[slot] = raw
      continue
    }
    const escape = SLOT_TYPES[type]
    if (!escape) reject('slot-type', `${templateName}.${slot} declares unknown slot type ${JSON.stringify(type)} (INV-A3-5)`)
    out[slot] = escape(raw)
  }
  // A caller passing a slot the template does not declare is a caller trying to say something
  // the catalogue has no word for. Refuse rather than silently ignore it.
  for (const given of Object.keys(slots)) {
    if (!(given in spec.slots)) reject('slot', `template ${templateName} has no slot ${JSON.stringify(given)}`)
  }
  return { spec, values: out }
}

// --- Boot-time config check (the general fix behind the `handle` incident) --------------------
//
// The `handle` regression was one instance of a class: a config value that fails its slot type
// throws INSIDE a delivery path, and both delivery paths mark the event seen before emit resolves.
// The message is then gone, and the operator learns about it from one ERR line, per message,
// hours after the deploy.
//
// So the escapers are run against config ONCE at boot, where a failure is loud and costs nothing:
// a bad value refuses to start rather than silently eating traffic. This repo's posture is
// default-closed and LOUD, and "being unable to check is not the same as being fine" — a bridge
// that cannot render its own configured names should say so before it starts accepting events.
//
// Returns a list of {what, value, error}; empty means every config-sourced typed slot renders.
export function checkConfigRenderable({ recipientNames = [], approverMention = null } = {}) {
  const problems = []
  const probe = (what, value, type) => {
    try { SLOT_TYPES[type](value) } catch (e) { problems.push({ what, value: String(value).slice(0, 40), error: e.message }) }
  }
  for (const [i, n] of recipientNames.entries()) probe(`recipients[${i}].name`, n, 'handle')
  // Absent is fine — the slot is optional and the caller passes undefined.
  if (approverMention) probe('public.approver_mention', approverMention, 'handle')
  return problems
}

// Exported so the catalogue test can drive rendering with hostile values without shelling out.
export function renderTemplate(templateName, slots) {
  const { spec, values } = renderSlots(templateName, slots)
  return spec.render(values)
}

// --- The one signing call ---------------------------------------------------------------------
//
// Everything above is about what may be SAID. This is the only place anything is signed on the
// Buzz transport. If a second execFile appears anywhere in src/, the ban test (§2.3) fails.
let runBuzz = (args) => new Promise((resolve, rejectP) => {
  execFile('buzz', args, (e, so, se) => {
    if (e) { const wrapped = new Error(String(se || e.message).trim()); wrapped.cause = e; return rejectP(wrapped) }
    resolve(String(so || ''))
  })
})

// Test seam ONLY — lets the catalogue test assert on argv without a `buzz` binary present. Not a
// bypass: it replaces the transport, never the catalogue or the escapers above.
export function __setTransportForTests(fn) { const prev = runBuzz; runBuzz = fn; return () => { runBuzz = prev } }

// --- Reads --------------------------------------------------------------------------------
//
// Read verbs author nothing and are out of A3's scope for what waggle can SAY — but they live
// here anyway, because the enforcement axis is the IMPORT, not the verb (§2.3). If bridge.mjs
// kept its own `child_process` import for three reads, the ban test would have to permit that
// import and would then be blind to a write sneaking in beside it. One module owns the transport;
// the ban stays absolute and therefore meaningful.
const READS = {
  channels_list: () => ['channels', 'list'],
  messages_get: ({ channel, limit, since, before }) => {
    const a = ['messages', 'get', '--channel', SLOT_TYPES.channel(channel), '--limit', SLOT_TYPES.count(limit)]
    if (since !== undefined && since !== null) a.push('--since', SLOT_TYPES.ts(since))
    if (before !== undefined && before !== null) a.push('--before', SLOT_TYPES.ts(before))
    return a
  },
}

export const READ_NAMES = Object.freeze(Object.keys(READS))

// query(name, params) -> Promise<stdout>. A closed set, argv built from typed values.
export function query(name, params = {}) {
  const build = READS[name]
  if (!build) reject('read', `unknown read verb ${JSON.stringify(name)}`)
  return runBuzz(build(params))
}

function argvFor(spec, descriptor, content) {
  switch (spec.action) {
    case 'send': {
      const a = ['messages', 'send', '--channel', SLOT_TYPES.channel(descriptor.dest), '--content', content]
      // A recipient p-tag (the seat wake trigger) is a TYPED descriptor field, never a rendered
      // slot: it must reach argv as --mention, not the body. Opt-in — only forward() sets it, to
      // wake a seat on a #general post that p-tagged it. Validated as a pubkey; the body stays
      // de-fanged so the wake rides this explicit p-tag, not the display text.
      if (descriptor.mention != null) a.push('--mention', SLOT_TYPES.npub(descriptor.mention))
      return a
    }
    case 'reply':  return ['messages', 'send', '--channel', SLOT_TYPES.channel(descriptor.dest), '--reply-to', SLOT_TYPES.id(descriptor.parentId), '--content', content]
    case 'edit':   return ['messages', 'edit', '--event', SLOT_TYPES.id(descriptor.targetId), '--content', content]
    case 'delete': return ['messages', 'delete', '--event', SLOT_TYPES.id(descriptor.targetId), '--reason-code', 'nip09', '--public-reason', 'withdrawn by author (NIP-09)']
    default:       return reject('action', `unknown action ${JSON.stringify(spec.action)}`)
  }
}

// emit(descriptor) -> Promise<{ stdout }>
//
// `descriptor` is a tagged union: { template, dest?, parentId?, targetId?, slots }. There is no
// field for a caller-composed string, which is the entire design (INV-A3-3).
export async function emit(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') reject('descriptor', 'emit requires a descriptor object')
  if (typeof descriptor === 'string') reject('descriptor', 'emit does not accept strings')
  const { spec, values } = renderSlots(descriptor.template, descriptor.slots)
  const content = spec.render(values)
  const stdout = await runBuzz(argvFor(spec, descriptor, content))
  return { stdout }
}
