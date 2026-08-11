// capability-vocabulary.mjs — what a NIP-DA capability MEANS to the person deciding about it.
//
// This is one table, in one place, on purpose. `admit` and `task` are meaningful inside the
// protocol and meaningless to an owner deciding whether to approve or revoke, so every surface
// that shows a capability to a human has to translate it — and until now the translation lived
// inline in `console/index.html` where exactly one screen could reach it.
//
// The join card (docs/DESIGN_JOIN.md) is the SECOND reader. Two hand-maintained copies of "what
// this capability lets someone do" is the drift that ends with an approval screen describing a
// grant it does not issue: the owner reads one sentence, signs another. So the vocabulary moves
// here before the second reader exists, not after it disagrees.
//
// tests/capability_vocabulary.mjs asserts the tables stay complete and consistent with each
// other. Nothing here is policy — no gate consults it. It decides only what a person is told.
//
// ── DIRECTION IS THE WHOLE PROBLEM ──────────────────────────────────────────────────────────
//
// A grant has two parties and they are not interchangeable. In every kind-440 this project
// issues:
//
//     ["p", <grantee>]                 the party who GAINS the capability
//     ["da-scope", <hash>, <salt>]     a salted hash of the SUBJECT the capability is over
//
// For the task family the subject is the agent BEING INSTRUCTED and the grantee is the party who
// MAY INSTRUCT IT. nvoy's `mcp/tools/attention.mjs` — not a file in this repo — is the
// enforcement site, and settles it:
//
//     if (scope[1] !== scopeHash(ME, scope[2] || '')) continue  // authorises tasking some other agent
//     putGrant(String(grantee).toLowerCase(), { grantId: ev.id, grantor: ev.pubkey, cap })
//
// ME is the agent running that runtime — the subject. The grantee goes into the permitted-senders
// map. `tools/grant.mjs` says the same in prose: "--agent <npub> cap task — this grantee may TASK
// that agent."
//
// This file used to label `task` as "Take tasks from you", which describes the GRANTEE as the
// task-taker — the exact inverse. Rendered through the confirmation sentence in the console it
// read "This grants Take tasks from you to <grantee> over <subject>", and an operator signed a
// grant that authorised the opposite of their intent: well-formed, verifying, live, and backwards.
// It was found by recomputing salted scope hashes by hand, because no surface could show it.
//
// The lesson is stronger than "that label was wrong". A capability label with NO DIRECTION IN IT
// cannot be checked by the person reading it, because direction is the thing they get wrong. So
// the unit of description here is a SENTENCE naming both parties, not an adjective phrase, and
// `describeGrant()` is the only supported way to render one. The short `CAP_LABEL` survives for
// dropdowns, where there is no grantee to name yet — and it is written in the ACTIVE voice from
// the grantee's side so it cannot contradict the sentence.

// ── Sentences. Both parties, always, in a fixed order: grantee first, subject second. ─────────
// Placeholders are substituted by describeGrant(); they are not optional and the suite asserts
// every template carries both, because a template that mentions one party has silently picked a
// direction the reader cannot verify.
export const CAP_SENTENCE = {
  'admit': '{grantee} may post into {subject}',
  'admit+read': '{grantee} may post into {subject}, and read it',
  'task': '{grantee} may send instructions to {subject}',
  'task+act': '{grantee} may send instructions to {subject}, and {subject} may act on them',
  'task-relay': '{grantee} may carry instructions addressed to {subject}',
  'mirror': "{subject} may mirror {grantee}'s public posts",
}

// Render a capability as a sentence about two named parties. `grantee` and `subject` are already
// display-ready (a name, a short npub) — this does no escaping and no lookup, so a caller that
// forgets to escape has an XSS defect in its own template rather than a hidden one in here.
//
// An unknown capability does NOT fall through to prose. It renders as a sentence that admits it
// does not know, because inventing a direction for an unrecognised cap is the original defect
// with extra steps.
export function describeGrant({ cap, grantee, subject } = {}) {
  const who = String(grantee ?? '').trim() || 'someone'
  const what = String(subject ?? '').trim() || 'something'
  const template = CAP_SENTENCE[cap]
  if (!template) return `${who} holds "${cap}" over ${what} — this surface does not recognise that capability`
  return template.replaceAll('{grantee}', who).replaceAll('{subject}', what)
}

// ── Short labels, for a dropdown where no grantee has been chosen yet. ───────────────────────
// Active voice, grantee's side, always. "Take tasks from you" was passive about the wrong party
// and that is how the inversion hid for so long. Read each of these as "«the grantee» may …".
export const CAP_LABEL = {
  'admit': 'Post into the channel',
  'admit+read': 'Post into the channel, and read it',
  'task': 'Send instructions to the agent',
  'task+act': 'Send instructions the agent may act on',
  'task-relay': 'Carry instructions addressed to the agent',
  'mirror': 'Have their public posts mirrored',
}
// An unknown capability falls back to its raw protocol name rather than to a friendly phrase.
// A cap this console has never heard of must LOOK unfamiliar — inventing readable prose for it
// would be the surface asserting it understands something it does not.
export const capLabel = (c) => CAP_LABEL[c] || c

// ── What the subject of each capability IS. ──────────────────────────────────────────────────
// A surface that asks "who may do this, and to what?" has to know whether the second field is a
// channel or an agent before it can label the field, and getting that wrong is the same class of
// error as getting the direction wrong.
export const CAP_SUBJECT = {
  'admit': 'channel',
  'admit+read': 'channel',
  'task': 'agent',
  'task+act': 'agent',
  'task-relay': 'agent',
  'mirror': 'channel',
}
export const capSubject = (c) => CAP_SUBJECT[c] || 'unknown'

// ── WHO ENFORCES WHAT. ───────────────────────────────────────────────────────────────────────
// The operator signs every one of these, but this bridge only consumes two (see
// processGrantEvent: `cap !== 'admit' && cap !== 'admit+read'`). The task family is enforced on
// the AGENT side, by the runtime's own invocation policy. A surface that let you sign a grant
// without saying who checks it would be recording intent and implying enforcement — the same
// defect as a routing board rendering a lane nothing delivers to.
export const CAP_ENFORCER = {
  'admit': 'this bridge',
  'admit+read': 'this bridge',
  'task': "the agent's runtime",
  'task+act': "the agent's runtime",
  'task-relay': "the agent's runtime",
  'mirror': 'this bridge (authored by the participant, not by you)',
}
// Unknown caps get the cautious answer, not a confident one. Claiming "this bridge" for something
// unrecognised would tell an owner their bridge is checking a thing it has never heard of.
export const capEnforcer = (c) => CAP_ENFORCER[c] || 'an unknown consumer'

// ── The two planes, named for a human. ───────────────────────────────────────────────────────
// "admit" and "task" are protocol words that sound like they belong to the same system and do
// not. One decides who is allowed in and is enforced HERE; the other decides who may give an
// agent orders and is enforced on the far side, by software this bridge does not run. An owner
// who does not hold those apart cannot reason about either. Surfaces group by this.
export const PLANE = {
  'admit': 'door',
  'admit+read': 'door',
  'task': 'orders',
  'task+act': 'orders',
  'task-relay': 'orders',
  'mirror': 'door',
}
export const PLANE_COPY = {
  door: {
    title: 'The door',
    question: 'Who is allowed in?',
    enforcedBy: 'this bridge',
    caution: 'Removing them stops them posting, on the next re-read of what you have signed.',
  },
  orders: {
    title: 'Orders',
    question: 'Who may tell this agent what to do?',
    enforcedBy: "the agent's own runtime",
    caution: 'This bridge does not check it. If that runtime is not reading what you signed, nothing here is enforced.',
  },
}
export const capPlane = (c) => PLANE[c] || 'unknown'

// The caps a console surface may ISSUE, per subject shape. Two deliberate exclusions:
//   admit+read — two independent reasons, and the FIRST one is now settled by live evidence.
//     (1) The community relay refuses an external key at NIP-42 time — `enforce_relay_membership`
//         gates read AND write, on both the websocket and HTTP paths, ahead of channel
//         membership. Proven with a live 2x2 in #344: an external key with a real channel_members
//         row is still refused. So issuing this would promise a read that does not happen.
//     (2) Conveying it for real would mean putting Concord channel key material in a 30440, which
//         makes this page key-touching and makes REVOKE a Concord rotation client rather than an
//         event signer (SPEC_EXTERNAL §4.1.1).
//     Offered, disabled, with the reason: a greyed option with a reason teaches; a missing one
//     confuses. What an outside agent actually receives is the return lane — mentions carried back
//     to it by waggle. That is the design, not a shortfall.
//   mirror — authored by the participant about themselves, never by the operator. It is not the
//     operator's to issue, so it is not in this list at all.
export const ISSUABLE = {
  channel: [
    { cap: 'admit', ok: true },
    { cap: 'admit+read', ok: false,
      reason: 'not available — the community relay will not serve an outside key, so this would promise a read that never happens. waggle carries mentions back to them instead' },
  ],
  agent: [
    { cap: 'task', ok: true },
    { cap: 'task+act', ok: true },
    { cap: 'task-relay', ok: true },
  ],
}

// The task family is the set this bridge does NOT enforce. Exported so a surface can say so
// without re-deriving the membership test from a string comparison it might get backwards.
export const BRIDGE_ENFORCED = ['admit', 'admit+read']
export const isBridgeEnforced = (cap) => BRIDGE_ENFORCED.includes(cap)
