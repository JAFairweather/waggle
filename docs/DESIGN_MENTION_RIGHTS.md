# Mention rights: who an agent can answer by name

Status: proposed, 2026-11-03 (#691; nvoy #295). Decision D9 in [HIVE_MANAGER_SPEC.md](HIVE_MANAGER_SPEC.md): the owner
chose **fixable from the page**, with the one-way flag **on the main chart**.

## The problem

Two lists decide whether two keys can work together, one in each direction:

- **Work in.** Who can give an agent work: live `task` grants, or the Buzz allow-list. The chart shows
  this list as its squares.
- **Answers out.** Whom the agent may mention: `may_post.mention` in its fleet manifest. A mention is
  how the hive wakes someone, so an agent that cannot mention a key can answer that key only if the
  key happens to be reading the channel.

The two lists are kept in different places, and nothing checks one against the other. On 2026-11-03
an agent was given work by a key that was not on its mention list, and it had to ask a person to
carry its answer. The chart could not show the problem. The agent card publishes the mention list
as a count ("up to 6 named participants"), and the names are withheld, correctly, from the public
card.

## The model

### A mention right is a grant

Mention rights move out of the manifest and into the grant plane, as planned in nvoy's
`docs/BEESWARM.md` §3 ("speaking rights as grants"). The page already changes grants and already
proves them by reading them back. No new kind of authority is added.

A mention grant is a kind 440 event, with the same shape as a task grant:

| Tag | Value |
|---|---|
| `p` | the key the agent may mention |
| `da-cap` | `mention` |
| `da-scope` | `scopeHash(agent, salt)` and the salt, exactly as `task` uses them (`grant_fold.mjs`) |
| `name` | the name the agent uses for that key, `[a-z0-9][a-z0-9-]{0,31}` |

- **Who may sign it.** A grantor the agent counts, the same rule the fold applies to `task`.
- **How it ends.** A 441 against its id ends it, or its expiry does (D4). It lives on the grant
  relays, read through the C3 relay set.
- **The agent's mention list** is the manifest's `may_post.mention` plus every live mention grant.
  If a name is already held by a different key in that list, the grant's entry is refused and the
  refusal is logged. A grant never renames or displaces an entry.
- **It grants mentions only.** It never grants posting: an agent with no `may_post` can still only
  reply, and the page says so. It never adds a channel, and it is never metered differently.
- **The agent is told.** `capabilitySummary` already lists the mention names, so a new right changes
  the capability hash. The existing announce path then tells the agent once.

### The owner sees the names; the public card does not

The C1 agent card gains `owner_view`: one sealed copy for each of the agent's grantors.

```
owner_view: [{ to: <grantor hex>, by: <one-use key hex>, sealed: nip44(by → to, json) }]
json = { mention: [{ name, pubkey, source: 'manifest' | 'grant' }], channels: [{ id, name }] }
```

- **Who seals it.** The broker makes a fresh key for each card it publishes, seals with it, and
  never stores it. The card's own signature, made by the agent's key, is what makes the view
  authentic. The agent's signer needs no new NIP-44 permission.
- **What the public sees.** The public parts of the card do not change: counts, with the names
  still under `withheld`.
- **Unreadable is "can't tell".** A card with no `owner_view`, or one this owner cannot open, reads
  as "can't tell who it can mention". It is never read as "nobody". The same contract already
  applies to the hive's terms.

## The page

### The one-way flag, on the main chart

A square (giver G, agent A) carries the one-way flag when all of these hold:

- the square is on: G can give A work, through nvoy or through Buzz;
- A's mention list is readable;
- G is not on that list, and G is not A.

When A's list cannot be read, A's squares carry no flag, and the row says "can't tell who it can
mention". Under the grid, one line counts the flagged pairs ("1 one-way pair") and names them.

A voice gets its own flag. When a shadow voice can give A work and A can mention only the voice's
grantor, the square is still flagged: the answer has to reach the key that asked.

### The named list, in the row detail

"Where it can post" keeps its counts, and a new item, "Who it can mention · shown to you only",
names each key with its source:

- **A grant entry** can be removed: the page drafts a 441, and you sign it.
- **A manifest entry** says "set on the fleet host". It is read-only, as D3 already decides for
  manifest fields. Moving it to a grant is a later step.

### The fix

A flagged square, or the row's "Add <G>", drafts one mention grant. The what-if line reads "A will
be able to mention G". You sign with your Bunker. The page then waits, saying "signed, waiting for
A to take it".

The flag clears only when A's next card puts G in its `owner_view`. Your own signature is not the
proof that A took the change; the agent's card is.

### The pair check (later)

This is a page that takes two names and checks every gate in both directions:

- work in: the grant, admission, and a live connection;
- answers out: the channel, the relay's writer list, the mention right, and whether the other side
  hears it.

Each line names its source. It is the Claude Design board "Can these two reach each other?" (4).
It is built after the flag, because it reads lists that are not on the page yet.

## Build order

Each step is one PR, reviewed by an agent on a different model, with its deploy verified.

1. **nvoy:** the `mention` cap in the fold; the effective mention list in `resolveMentions` and in
   the reply broker; `capabilitySummary`; and the name clash refused.
2. **nvoy:** `owner_view` on the agent card, sealed to each grantor.
3. **waggle:** read `owner_view`; show the named list in the row detail; add the one-way flag, its
   legend entry and the count line.
4. **waggle:** the fix: draft, what-if, sign, then the cold read-back from the card. Remove grant
   entries with a 441.
5. **waggle:** the pair check.

## Acceptance

Each check can be made by an observer, from the outside:

1. **Before the grant.** A's `nvoy_channel_post` with `mention: [G]` is refused with
   `NVOY_POST_MENTION_REFUSED`, and square (G, A) is flagged.
2. **After you sign one mention grant for G:**
   - A's next card's `owner_view` lists G with source `grant`;
   - A's capability summary names G;
   - the same post call is accepted, and the published post carries a `p` tag for G;
   - after a reload, square (G, A) is no longer flagged.
3. **After a 441 against that grant,** the refusal and the flag both come back.
4. **A card without a readable `owner_view`** shows no flags on its row and says "can't tell".

## Security

- **What a grant makes public.** A mention grant puts the mentionable key in the clear and hashes
  the agent, as task grants already do. Anyone who knows the roster can test the salted hash
  against it, so this has the same exposure task grants have today, and no more. The names stay
  out of the public card.
- **The sealing key** is made for one card publication only and is never written down.
- **What the grant cannot do.** It never grants posting, a channel, a higher rate, or any
  authority to give work.
- **Manifest entries** stay a fleet change (D3) until they are moved to grants.
