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

// Protocol vocabulary -> what the person actually gets.
export const CAP_LABEL = {
  'admit': 'Post into the channel',
  'admit+read': 'Post into the channel, and read it',
  'task': 'Take tasks from you',
  'task+act': 'Take tasks, and act on them',
  'task-relay': 'Carry signed instructions',
  'mirror': 'Mirror their public posts',
}
// An unknown capability falls back to its raw protocol name rather than to a friendly phrase.
// A cap this console has never heard of must LOOK unfamiliar — inventing readable prose for it
// would be the surface asserting it understands something it does not.
export const capLabel = (c) => CAP_LABEL[c] || c

// WHO ENFORCES WHAT. The operator signs every one of these, but this bridge only consumes two
// (see processGrantEvent: `cap !== 'admit' && cap !== 'admit+read'`). The task family is enforced
// on the AGENT side, by the runtime's own invocation policy. A surface that let you sign a grant
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

// The caps a console surface may ISSUE, per subject shape. Two deliberate exclusions:
//   admit+read — conveying the read cap means putting Concord channel key material in a 30440,
//     which makes the page key-touching and makes REVOKE a Concord rotation client rather than
//     an event signer (SPEC_EXTERNAL §4.1.1). Offered, disabled, with the reason: a greyed
//     option with a reason teaches; a missing one confuses.
//   mirror — authored by the participant about themselves, never by the operator. It is not the
//     operator's to grant, so it is not in this list at all.
export const ISSUABLE = {
  channel: [
    { cap: 'admit', ok: true },
    { cap: 'admit+read', ok: false,
      reason: 'not issuable here — it conveys channel key material, which would make this page hold a key and make revoke a Concord rotation, not just a 441' },
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
