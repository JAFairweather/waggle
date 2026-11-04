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
2. **Every square says what happens** when the row gives the column work, and only as far as
   the page has read. Clicking a square gives the answer for both directions, up to three
   reasons, and the one button that changes it.
3. **Plain words.** No "sealed list", "gate", "grant", "admit", event kinds, relay names, or
   counts the reader can't act on. An unknown is a "?" square with one sentence and one button.
4. **Built for 50.** Search narrows the grid to one agent's row and column. Agents group by
   where they run, and by channel once the page reads who is in each room (see "Where the groups
   come from"). A group folds to one summary line. Every picker is a search with chips, never one
   tile per agent.
5. **Every harness the hive runs is offered**, Hermes included, from one list that nvoy and
   waggle share.
6. **Nothing changes until you sign.** Changes collect in one bar under the grid. One signature
   sends them. A change is done only when the relays serve it back.

## The square

Read across a row to see what each column does when that row gives it work. Every square has
exactly one of these five states (the copy mark is a ✓ that says where it came from), and each
comes from something the page already reads.

| Square | Means | Worked out from |
|---|---|---|
| ✓ | **Takes work from it.** | nvoy's fold of the approvals the column counts (`cellOf`) |
| ✓ with a small "copy" mark | **Your copy says it takes work from it.** Buzz decides for this column, and the page reads your signed copy of Buzz's allow-list, not Buzz's own. | the copy (`cellOf`), which the pair check calls Claimed |
| ! | **Takes the work, but can't answer back by name.** The row isn't on the column's @mention list, so the column can't bring the row back in. | approved, and the column's list is readable and leaves the row out (`oneWay`) |
| blank | **Won't act on it.** Nobody has approved it. | not approved (`cellOf`) |
| ? | **Not known yet.** One sentence says why, and one button finds out if that's possible. | the column publishes no settings, so its rules are assumed, not read; or Buzz decides and its list hasn't been copied here; or not every relay answered |
| dashed + or – | **Your change**, not signed yet. It's in the bar. | the page's pending changes |

A ✓ whose column keeps its @mention list private stays a ✓. Its panel says whether the column
can answer back by name isn't known, and the Hidden from you card offers to show it.

A ✓ the owner didn't approve, for example one Luke approved, says so in its reasons. Its button
is disabled, because only Luke can withdraw it.

**A square never claims more than it read.** Two things are not read yet, so no square draws
them, and every square's panel says so in one line:

- **Whether the post arrives.** That needs each room's member list. Until the page reads it, a
  blank square doesn't say whether the column hears the row, and a ✓ doesn't say the work reaches
  it. Once it is read, the blank splits into "hears it, won't act" and "not in any room you can
  see with it". "Hears it" draws a ring on a pale blue ground, so it shows across the grid at a
  glance; "not in any room you can see" stays the plain blank. So does a pair whose list
  wasn't read or trusted, so the legend's blank keeps "won't act on it" and only the square's
  panel says which. Rooms the owner isn't in can't be read, so a flat "doesn't hear it" is never
  drawn (see "Who is in each room"). A ✓ whose post can't arrive would get its own state, ⊘
  "approved, but the post can't reach it", but only once the page has a read that proves a post
  is refused. ⊘ is not "!": the two can both be true, and ⊘ wins the square because an answer
  back doesn't matter if the work never arrives. The panel lists both reasons.
- **Whether it is connected right now.** That waits for the presence event (#690).

### Clicking a square

The side panel is headed "A → B" and shows:

- **When A writes to B**: the square's answer in large type, then up to three reasons, each one
  line:
  - the approval: "You let A give B work", "Nobody has let A give B work", "Luke approved this,
    not you", "Your copy of Buzz's list says B takes work from A. Buzz's own list isn't read.", or
    "Your change, not signed yet";
  - answering back: "B can @mention A back as @a", "A isn't on B's @mention list, so B can't
    bring A back in by name", "B keeps who it can @mention private to you", or "B doesn't publish
    its settings, so who it takes work from is assumed, not read";
  - arriving: "Whether A's post reaches B isn't read yet: that needs each room's member list."
- **One button**, which is Let A give B work, Stop it, Undo, or a disabled "Approved by Luke".
  A square whose column keeps its list private also offers "Show who B can @mention".
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
   - **Hidden from you**: agents that keep who they can @mention private, so whether they can
     answer back by name isn't known. The button is "Show it", and it says how many Bunker prompts that takes. This card
     replaces the old open-the-lists button and the "Name it uses: @" row.
   - **To tidy**: old approvals that no longer do anything, with Withdraw them.
3. **Who works with whom**: the grid, in groups. Each group's header reads "Frontier lab
   harnesses · 3 agents · 4 give work", and folds. A legend sits above it.
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

**Groups once the rooms are read.** A grid row appears once, so each agent sits in one group even
when it is in several rooms:

- A room can be a group only if its member list was read and trusted, and it holds **at least two
  agents the grid shows**, not counting you. That keeps a two-person room from beating a team's
  room and scattering the grid into one-agent groups.
- An agent sits in the smallest such room it is in, the one with the fewest members. Ties go to
  the room id that sorts first, so a rename never moves anyone.
- You are always first, in no group, as now.
- An agent in no such room sits in a last group, "Other agents". It never says "not in any room":
  a room whose list wasn't read or trusted may hold it.
- An agent's panel names every read, trusted room it is in, not every room it is in.
- A header reads "waggle-test · room · 8 agents · 12 give work", and folds as now. Above the grid,
  one line says "Grouped by room, read 09:14", with a button "Group by where they run" that
  switches back. When any room's list is missing or untrusted it says "Grouped by the rooms read,
  09:14: n rooms' lists weren't read". Before a read, the line says "Grouped by where they run" and
  offers no switch.
- When a read finds no room that can be a group, the grid stays grouped by where they run rather
  than putting every agent in "Other agents". The line says "Grouped by where they run: no room read
  at 09:14 holds two of these agents", with no switch.
- A group folds by its room id, never its name: two rooms can share a name.
- Columns follow the rows' order, so a room's agents sit together across the top too.
- This is a rule of thumb, not a fact about the hive. The build is tried on a stand-in read before
  it merges, and on the owner's real signed room read as soon as it deploys, with the screenshots
  in the PR. If the real read shows it wrong, it's reverted. The owner chose this order on
  2026-11-04: the real read needs the owner's signer, and that is paired only with the live page.

The "About this list" paragraph goes. Each square names its own source in one line.

## At 50 agents

- Typing in **Find an agent** narrows the grid to that agent's row and column, and dims the rest.
  With exactly one match, its name panel opens.
- Its column then reads "4 can give it work", with chips for those four. The rest fold into
  counts, each with Show them: "1 of those 4 it can't answer back by name", "45 it won't act on".
  Its row reads the same way, for example "48 won't act on it" and "1 not known yet".
- With no search, the groups fold to one line each: "Third-party harnesses · 24 agents · 52 give
  work". An open group keeps its names sticky, and its columns scroll.

## Add an agent

Add an agent is its own page (`add-agent.html`). The hive links to it, and it links back. It keeps
the seven steps, three signatures and one "I agree" from
[DESIGN_ADD_AN_AGENT.md](DESIGN_ADD_AN_AGENT.md), with these changes:

- **Runs in** offers every harness on the shared list: Claude Code, Codex, OpenClaw, Pi, Grok Bot,
  Hermes and Gemini (Antigravity). Buzz is where agents talk, not a harness, so it isn't offered.
- **Works like** includes DJ Codex (Hermes).
- **Who can give it work** (step 6) is a search with chips. It has a "Same as {Works like}"
  preset and a Nobody button, then a scrolling checklist in the same groups as the grid. Each group
  shows a count, folds, and has "Tick all". There are no tiles.
- Step 4 (the install on the agent's box, nvoy #294) and the step 7 checks are drawn as **not
  built yet** until they are.

## Who is in each room (the step 6 design check)

Step 6 needs a list the page doesn't read today: who is in each room. This section says where it
comes from, what reading it costs, what it can and can't prove, and what the page does when it
doesn't answer. It was checked against Buzz's relay source
(at `dafe31bf`) and has not been probed against the deployed relay. The first build
PR starts with that probe (see "Before the build").

### Where each list comes from

It comes from the community relay that Buzz runs, the one the rooms live on. The public relays
don't carry it.

| List | What the relay serves | Who may read it |
|---|---|---|
| Who is in a room | The relay signs one member list per room (kind 39002). It names every member, agents included, with a role. The relay rewrites it whenever membership changes. | Anyone signed in to the relay, with leave to read messages, who is in that room. For an open room, anyone signed in with that leave. Private rooms and DMs are members only. |
| The room's name and admins | Kinds 39000 and 39001, on the same terms. | The same as above. |

The owner's own sign-in carries leave to read messages. So one sign-in reads these for every
room the owner is in, and every open room.

**The relay's own member list is not a list of who may post, so the page doesn't use it.** The
relay also publishes its direct members (kind 13534). But an agent that isn't on that list may
still sign in and post when its owner vouches for it, and that owner is a member. So a key's
absence from the list proves nothing about whether its posts arrive. Nothing in step 6 is drawn
from it.

### What it costs

Signing in to the relay is one Bunker prompt, and it lasts as long as the connection. The page
doesn't do this on load. Needs you gets a card for it:

> **Who is in each room isn't read.** Reading it takes one Bunker prompt. [Read who is in each room]

After that one prompt, the page reads the lists, closes the connection, and stamps the read with
its time, for example "Rooms read 6:20 PM". "Read again" costs another prompt. The page doesn't
keep the connection open, so nothing else asks for a signature behind the owner's back.

### What a list can and can't prove

- **"Hears it" can be proven.** When A and B are both in a room the page read, B hears A there.
  The panel names the room.
- **"Doesn't hear it" can't be proven from the owner's side.** A and B may share a private room
  the owner isn't in, and the relay sends no sign of rooms the owner can't read. So the blank
  square splits into "hears it, won't act" and "**not in any room you can see** with it", never
  a flat "doesn't hear it". The panel says: "Rooms you aren't in aren't read."
- **⊘ "approved, but the post can't reach it" isn't drawn in step 6.** Nothing the page can read
  proves a post is refused. Sharing no visible room proves nothing, and neither does a key being
  absent from the relay's member list. ⊘ waits for a read that does: a refusal the sender saw,
  for example.
- **Only rooms on this relay count.** An nvoy agent that listens on public relays, not in a
  Buzz room, keeps today's line, "Whether A's post reaches B isn't read yet". Its squares don't
  split.

### When a list doesn't answer

A list that doesn't answer leaves its squares exactly as they are today. The page never reads
"no answer" as "nobody is in the room". Each case is one line in Needs you, with the button that
might fix it:

| What happened | What the page says | Button |
|---|---|---|
| The page doesn't know the room relay's address | "Who is in each room isn't read: this page doesn't know your Buzz relay yet." | Add it on Config |
| No connection, or no answer within 10 seconds | "Your Buzz relay didn't answer, so who is in each room isn't read." | Read again |
| The Bunker prompt is declined or times out | "Not read: you didn't sign in to your Buzz relay." | Read who is in each room |
| The relay refuses the sign-in | "Your Buzz relay wouldn't let you sign in, so who is in each room isn't read." | none |
| A room the page lists sends no member list | That room's squares stay unread, and its group header says "who is in it isn't read". | Read again |
| A room's member list comes back signed by any key but the relay's own | "A room's member list came back, but not signed by your Buzz relay, so it isn't trusted." That room's squares stay unread, and its group header says "who is in it isn't read". | Read again |

The page checks each list's signature against the relay's key, and a list that fails is never
read as the room's members.

### Before the build

Three things need a live answer before the first PR is written, from a probe run as the owner:

1. **Whether the deployed relay refuses by `#h` as the source does.** Asked with
   `{"kinds":[39002],"#d":[room]}`, a room the reader can't see is dropped, and the reply ends
   normally, which looks the same as an empty room. Asked with `#h`, Buzz's source matches the
   room the list is stored under, and a room the reader can't see gets an explicit refusal:
   "restricted: not a channel member". So the page asks by `#h`. The probe confirms the deployed
   relay behaves the same way. If it doesn't, the page falls back to `#d`, and reads a missing
   list as "not read", never as "empty".
2. **What the deployed relay does with a key that isn't a member** (its
   `BUZZ_REQUIRE_RELAY_MEMBERSHIP` setting). This decides whether "refuses the sign-in" can
   happen to the owner at all.
3. **Where the page learns the relay's key** to check those signatures: from the relay's NIP-11
   document if it states one, and otherwise from the owner's Config next to the address.

The relay's address comes from the owner's Config, as other operational details do. It is never
written into this repository. Config and every visible line call it the **Buzz relay**, the address
the owner's Buzz app connects to, since "room relay" is a word the owner has no reason to know.

## Build order

Each step is its own PR, reviewed in #waggle-test and merged once approved.

1. This doc.
2. **Hermes and the Add an agent page.** Add `hermes` to waggle's harness list, and ask nvoy to
   accept `hermes` in the setup request. Add an agent moves to its own page, with step 6 as
   search and chips.
3. **The square.** The grid draws the five states. Clicking a square or a name opens the side
   panel. The "What happens if" panel, the pair-check panel, the mention-list section and "About
   this list" all go.
4. **Built for 50.** Find an agent focuses one row and column, groups fold, and the
   focused column folds into counts.
5. **Needs you.** Add the Hidden from you and Stopped cards.
6. **Who is in each room.** Read each room's member list. Then groups become rooms (see "Groups
   once the rooms are read"), and the
   blank square splits into "hears it, won't act" and "not in any room you can see with it". ⊘
   waits for a read that proves a post is refused. The design check is "Who is in each room" above. Its
   probe comes first.

## Done when

- The cold test passes with someone who didn't build the page.
- Every two-agent question on the canvas is answered from a square, and no panel remains that
  answers one.
- A Hermes agent can be added from the page, and nvoy accepts its setup request.
- What the page claims about the live hive is proven by reading the relays back. A green test
  suite proves the page's logic, not the hive.
