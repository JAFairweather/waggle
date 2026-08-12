# Console IA — one board of ins and outs

Status: **design agreed, nothing built.** Parent issue #330.

| Tab | Is | Issue |
|---|---|---|
| 1 | **The board** — what needs you, what is coming in, who is here | #330 |
| 2 | **Sources** — ask outside authors to be carried | #331 |
| 3 | **Connect an agent** — step 5 rework | #333, under #309 |
| 4 | **Config** — settings with teeth | #332 |
| — | Return lane: carry the parent with a reply | #334 |

---

## The organising idea

The console is organised by **mechanism** — grants on one page, follows on another, agents on a
third. Five pages accreted one wave at a time and nobody went back to ask what the whole thing
looks like.

The evidence that this is presentation and not data: **four of the five pages read the same event.**
`following.html`, `agents.html`, `routing.mjs` and `config.html` all fetch kind 30078, each
re-deriving the hive and rendering one slice of it. That one document already carries `follows[]`
(with per-author consent on each entry), `agents[]`, `operations` and `observed_at`. The board is
roughly **one fetch**, plus the 440/441 grants for permissions.

So: organise by **direction of travel**. waggle is four lanes; the console should be too.

### What happens to the existing pages

- **Following** and **Agents** dissolve into the board.
- **Access** keeps the *act* of granting. The board shows state, the flow does the signing — the
  same split `connect.html` already uses.
- **Routing splits.** Moderating a quarantined note is *work* and goes to Tab 1. The lanes and
  moving someone up a lane are *policy* and go to Tab 4.
- **Setup** stays outside the tabs, as it already is by design.

---

## Tab 1 — the board

Order: **Needs you now** → **Coming in** → **Who is here**.

Leading with pending decisions is the one addition to the original sketch. Standing state is
reference material you scan. Quarantined notes, unanswered consent requests and pending joins are
*work*, and they are the only time-sensitive thing in the console. The concept already exists as
"Waiting for you" on the Access page.

### Blocked by #321

The agents half renders **empty today**. `processGrantEvent` never writes agent rows —
`saveAgentRows` has exactly one caller and it is not the grant path — so `agents[]` is genuinely
`[]` while the grants are live.

This redesign does not *hit* that bug, it **forces** it. You cannot build a board whose right half
is agents while the roster is disconnected from the thing that admits agents. #321 is the
precondition, not a follow-up.

The rule #321 lands on is the one this board depends on: **nothing in the roster may contradict the
grants, because only the grants are enforced.**

### The two planes must not share a column

`admit` and `task` are not peers:

| Cap | Enforced by | What it is |
|---|---|---|
| `admit`, `admit+read` | **this bridge** — `src/bridge.mjs:832` is the entire enforcement | a lock |
| `task`, `task+act`, `task-relay` | **the agent's own runtime**. waggle never reads them | a signed letter of authority |

A single permissions column listing both as values of one field re-creates exactly the confusion
`connect.html` was built to prevent, on the page the owner looks at most. Whatever the visual
treatment, those must read as different *categories of claim*.

---

## Tab 2 — Sources

See #331. Name decided: **Sources**, action **"Ask to carry"**.

Not "add remote content" — that frames it as the operator taking, and the operator cannot add
anyone's content. From `src/consent.mjs`: *"Every other grant in the estate is authored by the
AUTHORITY. A consent record is authored by the DATA SUBJECT."*

Most of the machinery exists; the surface does not. **Enforcement is ON in production** — read from
the box, not inferred from the code default, which is off when the key is unset.

**Seven states, taken from the bridge's own vocabulary** — published per author in the signed
control record and defined once in `src/consent_state.mjs` (#389):

| wire | reads as | carried? |
|---|---|---|
| `active` | Carrying | yes |
| `grandfathered` | Grandfathered — carried, no consent | **yes** |
| `pending` | No consent — carried, gate off | yes |
| `asked` | Asked — waiting on them | no |
| `muted` | Rejected by you — never asked | no |
| `revoked` | Withdrawn | no |
| `held` | Held, no consent | no |

- **Held, not dropped.** The bridge logs `PUBLIC hold[no-consent]: … participant has not consented
  (default-closed, §8)` and seals a consent ask the same second. Use its word.
- **Grandfathered** — carried, no consent record, permanently exempt. A tab that hides this lies in
  the worst direction: it implies consent underpins a carry that is running on an exemption. Until
  #389 the record published `pending` for it, the same word as an author whose every post was held.
- **`held` and `pending` are the same consent situation under different gates.** One word for both
  made the meaning depend on `operations.gates.consent_required`, which the schema treats as
  optional — so an omitted field silently flipped it.

> **"Declined" was wrong and is retired.** #331 listed it as a first-class state. The bridge cannot
> observe it: `docs/CONSENT.md` §6 is that **silence is a no**, there is no decline event, and asking
> twice is harassment — so nothing ever distinguishes "said no" from "has not answered". The state
> that does exist is `muted`, which is the **approver's** rejection, not the author's. Opposite
> parties; labelling one as the other tells an owner the author refused when in fact they did.

---

## Tab 3 — Connect an agent

See #333, under #309.

**The agent never touches the deployed box, and must not.** The box runs the bridge and holds
waggle's one private key — the thing worth taking, and the reason the identity is lean,
re-mintable and tripwired. **The relays are the interface.** An agent needs its own key in its own
signer and a client that can read and write sealed events. There is no box permission to grant
because there is no connection to make; the real gap is packaging.

Step 5 becomes three blocks, and **only the third is safe to paste into an agent**:

1. **Pair the signer** — scoped, burnable, delivered to the installer on stdin or as a one-time code
2. **Install and register** — a tool-neutral MCP stanza plus per-tool one-liners
3. **The paste prompt** — public keys, channel, what it may do, where to read the brief

### On Bunker URIs

A NIP-46 connection is revocable, per-method scoped, and **cannot be used to extract the nsec**.
Handing an app a `bunker://` string instead of a private key is the trade the design exists to
make. The objection is not that it is a secret — it is that **the model is not the software being
authorized**. The MCP channel server is the client; the model has no role in the pairing and
should not see the credential on its way past into transcripts and provider logs.

The failure revocability does not cover: an unconsumed connection secret is a **live** credential.
Whoever pairs first becomes the authorized client, and the real agent's pairing then fails —
reading as a setup glitch rather than a theft.

---

## Tab 4 — Config

See #332.

Every other tab shows **state**. This one changes **behaviour**, and here a wrong value almost
always fails **silently**. There is no red state for a consent flag left off, a relay that accepts
and drops, or a backfill cap set wrong.

So it is not a settings form. **Every row says what it is now, what happens when it is wrong, and
whether anyone has proved it is working.**

**Build the relay panel first.** A list of URLs is not information about a relay. Per relay: do we
read from it, do we write to it, did a write land, and when was that last proven? Three relays in
use today produce three different silent failures — PoW rejection behind `min_pow=none`, an author
allow-list, and a relay that stores events but will not answer `ids` filters — and none of them are
visible in a URL list.

---

## Return lane — the parent message

See #334. **Measure before building**: reply-to-agent already exists (`agentAuthoredBy`,
`why:'reply'`) and nobody has checked whether it fires in production.

Decided: **carry the parent only as far back as the agent's own authorship.** Self-limiting — the
only thing it can ever include is something the agent wrote, so it cannot cross the wall. Depth cap
of 1, and the parent rides **inside the payload as quoted context, never as its own carry**, or it
bypasses the echo-skip it must respect.

Not curation. **The mention *is* the consent event**; a heuristic relevance rule would have waggle
deciding on a member's behalf that their words should cross.

---

## Provenance

Read from source: the four-pages-one-event finding, `src/bridge.mjs:832`, the consent inventory,
the `claude mcp list` hardcoding in `tools/connect-agent.mjs:165`, the return-lane reply tests.

Read from the live box: consent enforcement state, the grandfather list, and the hold trace for a
watched author — with a control proving the search could see an active author.

**Not verified:** whether `why:'reply'` carries fire in production, and whether `agents[]` is still
empty since the last control-state publish. Both are measurable; neither has been measured.

One error corrected during drafting: `mirror_require_consent` was first reported as off, from the
code default rather than the deployment. Being unable to check is not the same as being fine, and
neither is a default the same as a deployment.
