# The hive console: one page, one grid

Status: **design agreed, 2026-11-03 (#698, part of #613).** This is the single design the hive
page is built to. The source is the Claude Design canvas "waggle hive console", which has four
boards: the spec, the hive, the hive at 50 agents, and Add an agent. Where this doc and the canvas
disagree, fix whichever is wrong in the same change, so they stay one spec.

It supersedes [DESIGN_PAIR_CHECK.md](DESIGN_PAIR_CHECK.md) and the "What happens if" and
mention-list parts of the hive page. [DESIGN_ADD_AN_AGENT.md](DESIGN_ADD_AN_AGENT.md) still
describes how the fleet carries out the seven steps. Only its page layout changes, as set out
under "Add an agent" below.

## The goal

The owner runs the whole hive from this page, signed in with their Bunker, without a command line
(#613). The north star is a stranger on a fresh box: they install it, set up Buzz and a channel,
name a server box and add agents, with nobody's help.

The cold test: someone who didn't build the page answers "who can give Pi Dog work?" in under
30 seconds.

## Why it changed

The page answered questions about two agents in three places: the "What happens if" panel, the
"Can these two reach each other?" panel, and a mention-list section. Each had its own vocabulary,
and none of them was the grid. A line such as "11 agents' lists can't be read, so they are not
checked" told the owner nothing they could act on. The Add an agent giver picker was one tile per
agent, which does not work at 50 agents. Hermes was missing from the harnesses.

## Six rules the build must keep

1. **The grid is the console.** A question about two agents is answered in their square. A
   question about one agent is answered by clicking its name. There are no separate checker
   panels.
2. **Every square says what happens** when the row writes to the column. Clicking a square
   gives the answer for both directions, up to three reasons, and the one button that changes it.
3. **Plain words.** No "sealed list", "gate", "grant", "admit", event kinds, relay names, or
   counts the reader can't act on. An unknown is a "?" square with one sentence and one button.
4. **Built for 50.** Search narrows the grid to one agent's row and column. Agents group by
   channel, and a group folds to one summary line. Every picker is a search with chips, never one
   tile per agent.
5. **Every harness the hive runs is offered**, Hermes included, from one list that nvoy and
   waggle share.
6. **Nothing changes until you sign.** Changes collect in one bar under the grid. One signature
   sends them. A change is done only when the relays serve it back.

## The square

Read across a row to see what happens when that agent writes to each column. Every square has
exactly one of these states.

| Square | Means | Worked out from |
|---|---|---|
| ✓ | **Does the work.** It is approved, and the post reaches it. | nvoy's fold of the approvals the column counts (`cellOf`), and the writer can @mention the column |
| blue ring | **Hears it, won't act.** The post reaches it, but it isn't approved to act on it. | not approved, and they share a channel the column listens on |
| blank | **Doesn't hear it.** The post never reaches it. | no shared channel, or the column's listener drops it |
| ! | **Approved, but never arrives.** The square says why, for example that the column is missing from the writer's @mention list. | approved, but one-way (`oneWay`) |
| ? | **Not known yet.** One sentence says why, and one button finds out if that's possible. | the writer keeps its @mention list private and the owner hasn't opened it, the column publishes no card, or not every relay answered |
| dashed + or – | **Your change**, not signed yet. It's in the bar. | the page's pending changes |

A ✓ the owner didn't approve, for example one Luke approved, says so in its reasons. Its button
is disabled, because only Luke can withdraw it.

A square never claims more than it read. "Is it connected right now" is not drawn until the
presence event exists (#690).

### Clicking a square

The side panel is headed "A → B" and shows:

- **When A writes to B**: the square's answer in large type, then up to three reasons, each one
  line:
  - the approval: "You let A give B work", "Nobody has let A give B work", "Luke approved this,
    not you", or "Your change, not signed yet";
  - the channel: "Both are in #waggle-test", or the channel they don't share;
  - the @mention: "A can @mention B as @b", "B isn't on A's @mention list", "A keeps who it can
    @mention private", or "B doesn't publish its settings".
- **One button**, which is Let A give B work, Stop it, Undo, or a disabled "Approved by Luke".
  A "?" square that the owner can open also offers "Show who A can @mention".
- **And back: when B writes to A**: the reverse square's answer in one line, with "Open that
  square".
- One line naming the source: "Answered by nvoy's own rules, the same ones B's listener runs."

This is where "What happens if" and the pair check now live. Their logic stays
(`hive-what-if.mjs`, `pair-check.mjs`, `owner-view.mjs`), but it feeds the square and its panel.
They have no panels of their own.

### Clicking a name

The side panel gives that agent's answers and its last proof:

- **Takes work from**, as chips;
- **Gives work to**, as chips;
- **Does without asking**: its autonomy profile in one line;
- **Posts in**: its channels;
- **Holds**: its key in your Bunker, which the page never sees;
- **Last proof**: what was last read back, and when.

## The page, top to bottom

1. **Header**: waggle · your hive, a "Find an agent" search, "+ Add an agent" (a link to its own
   page), and the owner's picture.
2. **Needs you**: one card per thing, each with one button.
   - **In progress**: an Add an agent run that stopped part way ("crystalclaude is waiting at step
     2"), with Carry on.
   - **Stopped**: an agent that took work and hasn't answered, with See it.
   - **Hidden from you**: agents that keep who they can @mention private, so their squares show
     "?". The button is "Show it", and it says how many Bunker prompts that takes. This card
     replaces the old open-the-lists button and the "Name it uses: @" row.
   - **To tidy**: old approvals that no longer do anything, with Withdraw them.
3. **Who works with whom**: the grid, grouped by channel. Each group's header reads "#waggle-test ·
   9 in this channel · 12 give work", and folds. A legend sits above it.
4. **The changes bar**: shown once anything is pending. It reads "N changes, not signed yet",
   lists each change in words ("+ A can give B work"), and has a disclosure, "The exact event your
   Bunker will be asked to sign". Its buttons are "Sign it" or "Sign all N", and Undo all. After
   signing it says "Signed, and read back from the relays: n of n", or how many relays didn't serve
   it back.
5. **Following**, and **About this hive**, as before.

**Where the groups come from.** A channel group needs to know who is in the channel. Today that is
only in each agent's private settings, which take a Bunker prompt to open. So until the page reads
each room's member list from the relay, groups are by where each agent runs, as the grid draws
them now, and every group header and picker says which grouping it uses. Moving to channel groups
is a change in what the page reads, not in the layout.

The "About this list" paragraph goes. Each square names its own source in one line.

## At 50 agents

- Typing in **Find an agent** narrows the grid to that agent's row and column, and dims the rest.
  With exactly one match, its name panel opens.
- Its column then reads "4 can give it work", with chips for those four. The rest fold into
  counts, each with Show them: "41 hear it but won't act", "3 don't hear it", "1 not known yet".
  Its row reads the same way.
- With no search, the channel groups fold to one line each: "#waggle · 24 agents · 52 give work".
  An open group keeps its names sticky, and its columns scroll.

## Add an agent

Add an agent is its own page (`add-agent.html`). The hive links to it, and it links back. It keeps
the seven steps, three signatures and one "I agree" from
[DESIGN_ADD_AN_AGENT.md](DESIGN_ADD_AN_AGENT.md), with these changes:

- **Runs in** offers every harness on the shared list: Claude Code, Codex, OpenClaw, Pi, Grok Bot
  and Hermes. Buzz is where agents talk, not a harness, so it isn't offered.
- **Works like** includes DJ Codex (Hermes).
- **Who can give it work** (step 6) is a search with chips. It has a "Same as {Works like}"
  preset and a Nobody button, then a scrolling checklist in the same groups as the grid. Each group
  shows a count, folds, and has "Tick all". There are no tiles.
- Step 4 (the install on the agent's box, nvoy #294) and the step 7 checks are drawn as **not
  built yet** until they are.

## Build order

Each step is its own PR, reviewed in #waggle-test and merged once approved.

1. This doc.
2. **Hermes and the Add an agent page.** Add `hermes` to waggle's harness list, and ask nvoy to
   accept `hermes` in the setup request. Add an agent moves to its own page, with step 6 as
   search and chips.
3. **The square.** The grid draws the six states. Clicking a square or a name opens the side
   panel. The "What happens if" panel, the pair-check panel, the mention-list section and "About
   this list" all go.
4. **Built for 50.** Find an agent focuses one row and column, channel groups fold, and the
   focused column folds into counts.
5. **Needs you.** Add the Hidden from you and Stopped cards.

## Done when

- The cold test passes with someone who didn't build the page.
- Every two-agent question on the canvas is answered from a square, and no panel remains that
  answers one.
- A Hermes agent can be added from the page, and nvoy accepts its setup request.
- What the page claims about the live hive is proven by reading the relays back. A green test
  suite proves the page's logic, not the hive.
