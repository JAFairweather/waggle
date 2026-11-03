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

**On the page it is laid out as the board is** (board 4, "Why can't A reach B?"). One picker names
the key that **gives the work** and the other the key that **does the work**; ⇄ swaps them, and the
swap is how the other direction is read. Two lanes sit side by side: **Work in** (the giver's way to
the doer: gates 1–3) and **Answer out** (the doer's way back to the giver by name: gates 4, 6, 7
and 8). Gate 5 is left off the lanes, because the page has no roster read; the channel line already
says that configuration is not membership. Each gate has a round mark: a filled ✓ for Proven, an
outlined ✓ for Claimed, a filled ✕ for Closed, a solid-ringed ? for Can't tell and a dashed ? for
Not read yet. The state is also written under the line, next to its source. A Not read yet gate after
a Closed one in the same lane says "Not checked: an earlier step fails". Beside the pickers there is
one verdict line per lane, such as "The answer can't come back by name.". There is one fix banner,
for the first Closed gate that has a fix. `reachView` in `console/pair-check.mjs` is this view: it
is one direction of `pairCheck`, and the suite holds that their states agree.

It is a section of `hive.html`, not a new page, in keeping with #613's move off separate pages. It
opens from a row's **Check with…** action, or as `hive.html#pair`. It reads only what the hive page
has already read. **It adds no relay queries and signs nothing.** A fix it offers goes into the
existing change bar, just as a fix on the grid does.

## The states

Every drawn line has exactly one of these states. They are written so that an observer can tell them
apart:

| State | Meaning | Example |
|---|---|---|
| **Proven** | A signed event the page verified, from a read that answered in full, shows the gate is open. | A live task grant, signed by a grantor the agent's card names, with every relay answering. |
| **Claimed** | A signed statement says so, but nothing ties it to this pair or to what is live now. | The card lists the grantor but not this grant's id; two cards configure the same channel. |
| **Closed** | A full read shows the gate is shut, or shows nothing where something is needed. | No live grant with every relay answering; a 441; a refusal on the card; a reply-only agent. |
| **Can't tell** | The source exists but did not answer in full this time. | A grant relay or withdrawal relay that did not answer; no owner view sealed to you; a card that fails its checks. |
| **Not read yet** | The page has no source for this gate today. | Presence; the relay's writer list; the Buzz channel roster. |

**An incomplete read is never Proven or Closed.** The page already records which reads came back
partial (`partial.approvals` in hive.html, and the grid's footnote). A grant seen during a partial
read may have a 441 the page missed, and an absence may be a 440 it missed. Either way the line reads
**Can't tell** and names the read that came back short.

A gate that is **Not read yet** is never shown as open, and never counted toward a yes. The summary at
the top says how far the page could see, not that the pair works:

- "Closed at *Approval*: Pi Dog has no approval to give MC Claude work.", or
- "Can't tell at *Approval*: one withdrawal relay did not answer.", or
- "No gate the page could read is closed. 2 proven, 3 claimed, 6 not read yet."

The first **Closed** line decides the summary. Otherwise the first **Can't tell** line does.
Otherwise the summary counts each state and never says the pair, or any gate, is open: a
**Claimed** gate is a statement, not an observation, so it is counted on its own and never folded
into **Proven**.

**Not drawn is not a state.** A gate that does not exist for a kind of key is left out, and one
sentence in its place says why, for example "A person takes no work through the page". It never
counts toward the summary either way.

## The gates

For a pair (A, B), the page draws both directions. Each direction has two parts: B giving A work, and
A bringing B in. The reverse direction swaps the two keys, so B's own ability to write and to reply
is read there, under B's name, not here.

### Work in: B gives A work

1. **Approval.** Does a live `task` grant (or `task` + `act`) let B give A work, or, for a Buzz agent,
   does B's key appear on the Buzz allow-list copy? This is read from the fold that the row already
   runs (`answersFor`, hive-list.mjs), so the line shows the same answer as the square.
   - **Proven**, quoting the grant's short id and its grantor, when every grant and withdrawal relay
     answered.
   - **Claimed**, for a Buzz agent whose allow-list copy lists B, since the page reads your copy
     of the list, not Buzz Desktop's own.
   - **Closed**, when a full read finds no grant, or finds the grant revoked or expired. It names which.
   - **Can't tell**, when the read was partial, when the allow-list copy is missing or partial, or
     when the scope hash did not resolve to a known key.
   - **Can't tell**, too, for a Buzz agent whose full allow-list copy does not list B. The copy is
     not Buzz Desktop's live list, so the absence is never **Closed**.
   - The fix is the square's existing work toggle.
2. **Taken.** Does the agent's broker count that grant? Today the card lists the **grantors** whose
   grants the broker counts, but not which grant ids it took.
   - **Claimed**, when the grant's author is one of the card's grantors.
   - **Closed**, when the grant's author is not one of them, with the words "A's card does not count
     approvals signed by X".
   - **Can't tell**, when A's card is missing or fails its checks.
   - **Not read yet**, for a Buzz agent, which has no broker card.
   - Becomes **Proven** only after nvoy's owner view lists the task grant ids it took, as it already
     does for mentions (follow-up below).
3. **Connected.** Is A's runtime connected to the channel now? This line is **Not read yet** until
   the presence event in [DESIGN_ADD_AN_AGENT.md](DESIGN_ADD_AN_AGENT.md) is published and read.
   Until then the line also shows, as context and never as a state, the page's existing quieter
   signals: when the card was last signed and the bridge's "Not answering" note.

### Bringing someone in: A brings B in

4. **Same channel, as configured.** Are A and B configured for a common channel?
   - For an agent whose owner view opens, the page knows A's configured channels
     (`owner_view.channels`, built from the manifest's `may_post.channels`). This section is the
     first place they are shown, and only to you.
   - B's channels are known only if B is also an agent with an owner view that opens.
   - **Claimed** if a channel id is on both lists. It is configuration, not membership, so it is
     never **Proven**.
   - **Closed** if both lists were read and share no channel.
   - **Can't tell** if either view doesn't open.
   - **Not read yet** when either key is a person or a Buzz agent, since neither has an owner view.
5. **In the channel now.** Are both keys members of that channel today? This line is
   **Not read yet**, because the page does not read the Buzz channel roster (`NOT_READ`,
   hive-list.mjs).
6. **A may write to the relay.** Is A, the sender, on the community relay's writer list? This line is
   **Not read yet**. The page writes members through the invite flow but has no read path for the list.
7. **Mention right.** May A mention B by name? This is read from A's owner view, as on the grid
   (`mentionStatus`, owner-view.mjs).
   - **Proven** when the named list holds B. It quotes the name and the source: the manifest, or the
     grant's short id.
   - **Closed** when it does not, with the refusal reason if one of your grants was refused.
   - **Closed** for a reply-only agent, worded "A only replies; it never starts a conversation".
   - **Can't tell** when the view doesn't open.
   - **Not read yet** for a Buzz agent, whose mention list is not on the page.
   - The fix is step 4's **Let A mention B…**, with the pending state unchanged.
8. **B hears it.** Does B's side take in a mention from A? This line is **Not read yet** for every B.
   An agent's card does not say whom it listens to, and a person's client settings are not on the
   page. The reverse direction's line 1 is the closest related proof: the page links to it and does
   not copy its state here.

### Which gates are drawn

| A is | Work in (1–3) | Bringing someone in (4–8) |
|---|---|---|
| An nvoy agent | all drawn | all drawn |
| A Buzz agent | all drawn. 1 is **Claimed** or **Can't tell**; 2 and 3 are **Not read yet**. | all drawn. 4–8 are **Not read yet**. |
| A person | not drawn: "A person takes no work through the page" | 4–6 and 8 drawn, all **Not read yet**. 7 is not drawn: "The page sets no mention right for a person." |

B's kind changes only which states a line can reach, as listed under each gate. It never removes a
line.

### Why both directions

Line 1 of one direction and line 7 of the other are the D9 case. B could give A work, and A could not
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

1. **waggle:** a pure `console/pair-check.mjs`. It takes the hive's rows, grants, views, cards and
   partial-read record, and returns both directions' lines and the summary. Its suite is
   `tests/console_pair_check.mjs`. The section in `hive.html` follows. Lines 3, 5, 6 and 8 ship as
   **Not read yet**.
2. **nvoy:** the owner view lists the task grant ids the broker took, as it already does for
   mentions. Line 2 becomes **Proven** or **Closed**. This is a separate issue.
3. **nvoy + waggle:** the presence event (#690 follow-up). Line 3 becomes readable.
4. **waggle (later):** read paths for the Buzz channel roster and the community relay's writer
   list, so lines 5 and 6 become readable. Each needs its own design, because neither list is public
   today.

## Acceptance

Each case is checked on the live page, with two keys from the hive. The cases marked *(suite)* are
also asserted in `tests/console_pair_check.mjs` with synthetic keys.

1. **Open approval.** B holds a live task grant for A, and every relay answered. Line 1 reads
   **Proven** and quotes the grant's short id, and the square agrees.
2. **After a 441 against it.** On reload, line 1 reads **Closed**, "revoked", and the summary names
   *Approval*.
3. **A partial read** *(suite)*. With a grant or withdrawal relay not answering, line 1 reads
   **Can't tell** whether or not a grant was seen, and names the read that came back short. The
   same holds for a missing or partial Buzz allow-list copy.
4. **Never open on no source** *(suite)*. Lines 3, 5, 6 and 8 read **Not read yet** for every pair.
   The summary never says a pair can reach each other, only how far it could see. The suite asserts
   that no line without a source can return **Proven** or **Claimed**.
5. **The D9 pair.** With a work grant from B and no mention right for A, the B→A work line is
   **Proven** and the A→B mention line is **Closed**. The fix is offered on the mention line.
6. **Configured, not proven** *(suite)*. Two agents whose owner views list a common channel read
   **Claimed** on line 4, never **Proven**.
7. **Unreadable view.** For an agent whose owner view doesn't open, lines 4 and 7 read
   **Can't tell**, never **Closed**.
8. **Reply-only.** For a reply-only agent, line 7 reads **Closed**, with "only replies", and no fix
   is offered.
9. **An agent and a person** *(suite)*. With A an agent and B a person, the A→B direction draws every
   line. The B→A direction draws no work-in lines and no mention-right line, each replaced by its
   sentence. Every drawn line has a state.
10. **A Buzz agent** *(suite)*. Line 1 reads **Claimed** when the allow-list copy lists B, and
    **Can't tell** when a full copy does not; never **Proven** or **Closed**. Every other line for it
    reads **Not read yet**.
11. **Claimed is not open** *(suite)*. With Claimed and Not read yet lines and no Closed or Can't tell,
    the summary counts each state ("No gate the page could read is closed. 0 proven, 2 claimed, …")
    and nowhere says the pair or a gate is open.
