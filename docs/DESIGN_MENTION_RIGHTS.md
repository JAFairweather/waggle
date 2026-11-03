# Mention rights: who an agent can bring in by name

Status: proposed, 2026-11-03 (#691; nvoy #295). Decision D9 in [HIVE_MANAGER_SPEC.md](HIVE_MANAGER_SPEC.md): the owner
chose **fixable from the page**, with the one-way flag **on the main chart**.

## The problem

Two lists decide whether two keys can work together, one in each direction:

- **Work in.** Who can give an agent work: live `task` grants, or the Buzz allow-list. The chart shows
  this list as its squares.
- **Bringing someone in.** Whom the agent may mention: `may_post.mention` in its fleet manifest.
  A reply to a message already reaches its sender, with no mention needed. A mention is how the
  agent starts a conversation with a key, or brings that key into any other thread. An agent that
  cannot mention a key can reach it only by replying to that key's own message.

The two lists are kept in different places, and nothing checks one against the other. On 2026-11-03
an agent was given work by a key that was not on its mention list. When it needed to raise something
with that key in a new message, it had to ask a person to pass it on. The chart could not show the
problem. The agent card publishes the mention list as a count ("up to 6 named participants"), and
the names are withheld, correctly, from the public card.

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
| `name` | the name the agent uses for that key, the manifest's rule: `[a-z0-9][a-z0-9._-]{0,31}`, case-folded when compared |

- **Who may sign it.** A grantor the agent counts, the same rule the fold applies to `task`.
- **How it ends.** A 441 against its id ends that grant only, or its expiry does (D4). It lives on
  the grant relays, read through the C3 relay set.
- **Every live grant is kept.** The fold returns every live mention grant, not one per key. A grant
  with a missing or invalid `name` contributes nothing.
- **It grants mentions only.** It never grants posting, a channel, or a higher rate. A reply-only
  agent (no `may_post`) stays reply-only, and a grant changes nothing for it (see the page, below).
- **The agent is told.** `capabilitySummary` already lists the mention names, so a new right changes
  the capability hash. The existing announce path then tells the agent once.

### The merged list: one total order, fail-safe on a clash

The broker builds the agent's mention list the same way every time, from scratch, at each policy
check. No state is kept between checks.

1. **The manifest's entries come first,** in manifest order. They always win.
2. **Then the live mention grants,** sorted by `created_at` and then by event id. Event ids are
   unique, so the order is total even when two grants share a timestamp or arrive out of order.
3. **For each grant, in that order,** checked in this order:
   - **Its name is already held by another key.** The grant is refused, logged and listed under
     `refused`. It is never counted as taken, and its id is never attached to any entry. A grant can
     never redirect `@name` to a different key. The refusal belongs to that grant alone. A key that
     holds no other entry stays unmentionable, even by hex. A key with its own valid entry keeps it.
   - **Its key is already listed.** The grant attaches its id to that entry. It never renames it:
     a key has one name, the first it was given.
   - **Otherwise** it adds `{ name, pubkey, grants: [id] }`.

Revoking the grant that gave a key its name leaves the next live grant for that key, in the same
order, to name it. A refused grant stays refused until the clash is gone, or until it is revoked and
signed again with another name.

### The owner sees the names

The C1 agent card gains `owner_view`: one sealed copy for each of the agent's grantors.

```
owner_view: [{ to: <grantor hex>, by: <one-use key hex>, sealed: nip44(by → to, json) }]
json = {
  mention: [{ name, pubkey, source: 'manifest' | 'grant', grants: [<grant id>] }],
  refused: [{ grant: <grant id>, reason }],
  channels: [{ id, name }]
}
```

- **Who seals it.** The broker seals with a fresh key that it never stores. The card's own
  signature, made by the agent's key, is what makes the view authentic, so the agent's signer
  needs no new NIP-44 permission.
- **When it republishes.** Whether a new card is due is decided from a digest of the plaintext view
  and the card's other fields, never from the ciphertext. Otherwise each hourly check would see
  fresh ciphertext and sign a card for nothing. The broker seals once for each card it actually
  publishes, and publishes whenever the merged list, its grant ids or its refusals change.
- **What the page checks before it decrypts:**
  - the card's signature;
  - that its author is the agent's key, and its `d` tag is that agent's card;
  - that the entry's `to` is the owner's own key.

  If any of these fails, the view reads as "can't tell".
- **Who sees what.** Every grantor the agent counts sees the full list and the channels, including
  entries other grantors made. Any one of them can already change the list with a grant, so none of
  them is shown less than they can change.
- **The public sees no more than before,** the counts, with the names still under `withheld`.
- **Unreadable is "can't tell".** A card with no `owner_view`, or one this owner cannot open or
  verify, reads as "can't tell who it can mention", never as "nobody". The same contract already
  applies to the hive's terms.

## The page

### The one-way flag, on the main chart

A square (giver G, agent A) carries the one-way flag when all of these hold:

- the square is on: G can give A work, through nvoy or through Buzz;
- A may post (it has `may_post`), and its mention list is readable;
- G is not on that list, and G is not A.

The other cases:

- **A reply-only agent's row** carries no flags. It says "It may only reply: it answers whoever gave
  the work, and can bring no one else in. Changing that is a fleet change." That change is D3's.
- **An agent whose list can't be read** carries no flags. Its row says "can't tell who it can
  mention".
- **Under the grid,** one line counts the flagged pairs ("1 one-way pair") and names them.

A voice gets its own flag. When a shadow voice can give A work and A can mention only the voice's
grantor, the square is still flagged. A message meant for the voice has to wake the voice.

### The named list, in the row detail

"Where it can post" keeps its counts, and a new item, "Who it can mention · shown to you only",
names each key with its source:

- **A grant entry** can be removed: the page drafts a 441 for each grant on the entry, and you sign
  them.
- **A manifest entry** says "set on the fleet host". It is read-only, as D3 already decides for
  manifest fields. Moving it to a grant is a later step.
- **A refused grant** is shown with its reason ("the name dead-rabbit is already used for another
  key"), and the page offers to revoke it and sign it again with another name.

### The fix

A flagged square, or the row's "Add <G>", drafts one mention grant.

- **The name it proposes** is G's own public profile name, put into the name rule. You can change it.
- **What it makes public.** The grant's `p` and `name` tags are public. So the grant tells anyone
  that some agent (hashed) may mention G, under that name. Defaulting to G's own public name means
  the usual grant reveals nothing about G that its profile does not already say. A name you choose
  instead is public as well, and the page says so beside the field.
- **The what-if line** reads "A will be able to mention G as @name".
- **Signing.** You sign with your Bunker. The page then says "signed, waiting for A to take it".

The flag clears only when a card from A lists the grant's own id on G's entry. Finding G already
listed is not enough: the page proves that A took this exact grant. The grant's id in a signed card
is the proof, so a card signed in the same second as the grant counts. The page never requires a
later timestamp. A card older than the grant counts as pending, never as proof.

### The pair check (later)

This is a page that takes two names and checks every gate in both directions:

- work in: the grant, admission, and a live connection;
- bringing someone in: the channel, the relay's writer list, the mention right, and whether the
  other side hears it.

Each line names its source. It is the Claude Design board "Can these two reach each other?" (4).
It is built after the flag, because it reads lists that are not on the page yet. Its design is
[DESIGN_PAIR_CHECK.md](DESIGN_PAIR_CHECK.md).

## Build order

Each step is one PR, reviewed by an agent on a different model, with its deploy verified.

1. **nvoy:** the `mention` cap in the fold, with every live grant kept; the merged list and its
   clash rule; the brokers' post and reply checks using the merged list; and `capabilitySummary`.
2. **nvoy:** `owner_view` on the agent card: sealed to each grantor, its due-check based on a
   digest of the plaintext, and the grant ids and refusals included.
3. **waggle:** verify and read `owner_view`; show the named list in the row detail; add the
   one-way flag, its legend entry and the count line.
4. **waggle:** the fix: draft, what-if, sign, then the cold read-back of the grant id from a newer
   card. Remove grant entries with 441s.
5. **waggle:** the pair check.

## Acceptance

Each check can be made by an observer, from the outside:

1. **Before the grant.** Posting agent A's `nvoy_channel_post` with `mention: [G]` is refused with
   `NVOY_POST_MENTION_REFUSED`, and square (G, A) is flagged.
2. **After you sign one mention grant for G:**
   - A's next card lists G with source `grant` and that grant's id;
   - A's capability summary names G;
   - the same post call is accepted, and the published post carries a `p` tag for G;
   - after a reload, square (G, A) is no longer flagged.
3. **After a 441 against that grant,** the refusal and the flag both come back.
4. **A clashing grant.** A second grant that gives another key an existing name is listed under
   `refused`, and `@name` still resolves to the first key.
   A key that is already listed under its own name, and then gets a later grant using another
   key's name, is the same case. That grant is listed under `refused`, and its id is on no entry. The
   key keeps its own entry.
5. **A reply-only agent with a mention grant.** A reply that adds G is still refused with
   `NVOY_REPLY_MENTION_NOT_PERMITTED`. Its row shows no flag, and the page offers no fix.
6. **An unreadable view.** A card whose `owner_view` is missing, or fails a check, shows no flags on
   its row and says "can't tell".

## Security

- **What a grant makes public.**
  - Like a task grant, a mention grant shows its `p` key in the clear and hashes the agent. Anyone
    who knows the roster can test the salted hash against it, the same exposure task grants have
    today.
  - Unlike a task grant, it also shows a `name`, which pairs that name with G's key in public. This
    is accepted, and the fix limits it by defaulting to G's own public profile name.
  - The full list of whom an agent may mention stays out of the public card.
- **The sealing key** is made for one card publication only and is never written down.
- **What the grant cannot do.** It never grants posting, a channel, a higher rate, or any authority
  to give work. On a clash it fails closed: no `@name` is ever redirected.
- **Manifest entries** stay a fleet change (D3) until they are moved to grants.
