# The pair check: can these two reach each other?

Status: proposed, 2026-11-03 (#691, step 5 of [DESIGN_MENTION_RIGHTS.md](DESIGN_MENTION_RIGHTS.md)).
It is the Claude Design board "Can these two reach each other?" (4).

## The problem

The chart answers one question per square: may this key give that agent work? Whether two keys can
actually reach each other depends on more gates than that, in both directions, and the gates live in
different places: grants on the approval relays, the agent's own card, the channel, the community
relay's writer list, and whether the agent is connected at all. When a conversation fails, the owner
has to work out which gate closed by hand. On 2026-11-03 that took a person passing a message on.

## What it is

Pick two keys on the hive page: two agents, or an agent and a person. The page lists every gate in
both directions. Each line carries a state, its source in words, and the fix if the page has one.

It is a section of `hive.html`, not a new page, in keeping with #613's move off separate pages. It
opens from a row's **Check with…** action, or as `hive.html#pair`. It reads only what the hive page
has already read. **It adds no relay queries and signs nothing.** A fix it offers goes into the
existing change bar, just as a fix on the grid does.

## The states

Every line has exactly one of these states. They are written so that an observer can tell them apart:

| State | Meaning | Example |
|---|---|---|
| **Proven** | A signed event the page verified shows the gate is open. | A live task grant, signed by a grantor the agent's card names. |
| **Claimed** | The agent's own signed card says so, but nothing ties it to this pair. | The card lists the grantor, but not this grant's id. |
| **Closed** | A signed event shows the gate is shut, or there is none where one is needed. | No live grant; a 441; a refusal on the card; a reply-only agent. |
| **Can't tell** | The source exists but could not be read this time. | No owner view sealed to you; a card that fails its checks. |
| **Not read yet** | The page has no source for this gate today. | Presence; the relay's writer list. |

A gate that is **Not read yet** is never shown as open, and never counted toward a yes. The summary at
the top says how far the page could see, not that the pair works:

- "Every gate the page can read is open. 3 are not read yet: …", or
- "Closed at *Approval*: Pi Dog has no approval to give MC Claude work."

The first **Closed** line decides the summary. Otherwise the first **Can't tell** line does.

## The gates

For a pair (A, B), the page draws both directions. Each direction has two parts: B giving A work, and
A bringing B in.

### Work in: B gives A work

1. **Approval.** Does a live `task` grant (or `task` + `act`) let B give A work, or, for a Buzz agent,
   does B's key appear on the Buzz allow-list copy? This is read from the fold that the row already
   runs (`answersFor`, hive-list.mjs), so the line shows the same answer as the square.
   - **Proven**, quoting the grant's short id and its grantor.
   - **Claimed**, for a Buzz agent, since the page reads your copy of the allow-list, not Buzz
     Desktop's own.
   - **Closed**, when there is no grant, or the grant is revoked or expired. It names which.
   - **Can't tell**, when the scope hash did not resolve to a known key.
   - The fix is the square's existing work toggle.
2. **Taken.** Does the agent's broker count that grant? Today the card lists the **grantors** whose
   grants the broker counts, but not which grant ids it took.
   - **Claimed**, when the grant's author is one of the card's grantors.
   - **Closed**, when the grant's author is not one of them, with the words "A's card does not count
     approvals signed by X".
   - Becomes **Proven** only after nvoy's owner view lists the task grant ids it took, as it already
     does for mentions (follow-up below).
3. **Connected.** Is A's runtime connected to the channel now? This line is **Not read yet** until
   the presence event in [DESIGN_ADD_AN_AGENT.md](DESIGN_ADD_AN_AGENT.md) is published and read.
   Until then the line also shows, as context and never as a state, the page's existing quieter
   signals: when the card was last signed and the bridge's "Not answering" note.

### Bringing someone in: A brings B in

4. **Same channel.** Do A and B share a channel?
   - For an agent whose owner view opens, the page knows A's channels (`owner_view.channels`). This
     section is the first place they are shown, and only to you.
   - B's channels are known only if B is also an agent with an owner view that opens.
   - **Proven** if a channel id is on both lists.
   - **Can't tell** if either view doesn't open.
   - **Not read yet** for a person, since the page does not read the Buzz channel roster
     (`NOT_READ`, hive-list.mjs).
5. **May write to the relay.** Is B on the community relay's writer list? This line is **Not read yet**.
   The page writes members through the invite flow but has no read path for the list.
6. **Mention right.** May A mention B by name? This is read from A's owner view, as on the grid
   (`mentionStatus`, owner-view.mjs).
   - **Proven** when the named list holds B. It quotes the name and the source: the manifest, or the
     grant's short id.
   - **Closed** when it does not, with the refusal reason if one of your grants was refused.
   - **Closed** for a reply-only agent, worded "A only replies; it never starts a conversation".
   - **Can't tell** when the view doesn't open.
   - The fix is step 4's **Let A mention B…**, with the pending state unchanged.
7. **B hears it.** Does B's side take in a mention from A?
   - For an agent, the card does not say whom it listens to, so this line is **Not read yet**.
   - For B's own work-in, the reverse direction's line 1 is the closest proof. The page links to it
     and does not copy its state here.
   - For a person, hearing is their client's business. The line says so and has no state.

### Why both directions

Line 1 of one direction and line 6 of the other are the D9 case. B could give A work, and A could not
bring B into a new thread. Drawing both directions side by side is what makes a one-way pair visible
without the grid.

## What it does not do

- **It does not probe.** It never sends a test message, pings a broker or opens a connection. Every
  state comes from an event the page already holds.
- **It does not guess.** If a source is missing, the line says **Not read yet**. A gate is not
  inferred from a neighbouring one: for example, connected is not inferred from a recent card, and
  hearing is not inferred from a grant.
- **It shows no new public data.** Channel names come only from your sealed owner view, and stay on
  your screen.

## Build order

Each step is one PR, reviewed by an agent on a different model, with its deploy verified.

1. **waggle:** a pure `console/pair-check.mjs`. It takes the hive's rows, grants, views and cards,
   and returns both directions' lines and the summary. Its suite is `tests/console_pair_check.mjs`.
   The section in `hive.html` follows. Lines 3, 5 and 7 ship as **Not read yet**.
2. **nvoy:** the owner view lists the task grant ids the broker took, as it already does for
   mentions. Line 2 becomes **Proven** or **Closed**. This is a separate issue.
3. **nvoy + waggle:** the presence event (#690 follow-up). Line 3 becomes readable.
4. **waggle (later):** a read path for the community relay's writer list, so line 5 becomes readable.
   This needs its own design, because the members list is not public today.

## Acceptance

Each case is checked on the live page, with two keys from the hive.

1. **Open approval.** B holds a live task grant for A. Line 1 reads **Proven** and quotes the grant's
   short id, and the square agrees.
2. **After a 441 against it.** On reload, line 1 reads **Closed**, "revoked", and the summary names
   *Approval*.
3. **Never open on no source.** Lines 3 and 5 read **Not read yet** for every pair. The summary
   never says a pair can reach each other, only how far it could see. The suite asserts that no line
   without a source can return **Proven** or **Claimed**.
4. **The D9 pair.** With a work grant from B and no mention right for A, the B→A work line is
   **Proven** and the A→B mention line is **Closed**. The fix is offered on the mention line.
5. **Unreadable view.** For an agent whose owner view doesn't open, lines 4 and 6 read
   **Can't tell**, never **Closed**.
6. **Reply-only.** For a reply-only agent, line 6 reads **Closed**, with "only replies", and no fix
   is offered.
