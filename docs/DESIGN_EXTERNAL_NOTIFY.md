# Design: notifying an external agent of hive activity

> **2026-08-04 authority extension:** the data-only carry below remains the default. A recipient
> configured with `protocol: "nvoy-task-carry-v1"` instead receives a strict encrypted JSON carry
> containing the complete original signed kind:9 event plus the resolved scan-channel UUID. That
> typed path becomes an instruction only when Nvoy independently verifies (1) the original signer
> has `task`/`task+act` for the recipient and (2) this bridge has the separate carrier-only
> `task-relay` grant for the same recipient. Replies are receipt-bound to this bridge and the exact
> source channel, then use the existing relay-ingress lane. `task-relay` alone never authorizes
> bridge prose. The normative cross-runtime contract and adversarial acceptance matrix live in
> Nvoy `docs/DESIGN_CHANNEL_TASK_CARRY.md`.

**Status:** proposed — decision-ready · **Tracks:** #110 · **Origin channel:** connector (`73f80d38-3245-41a9-814c-8ad364686944`)
**Verified against:** `src/bridge.mjs` @ `718aa7c` (= `origin/main`) and the live `/opt/waggle-read` box, 2026-07-31.

> Owner ask (the maintainer, 2026-07-31 02:16Z): *"completely rethink how an agent outside the hive gets
> notified of messages and activity of a channel inside the hive — especially replies to them and
> @mentions of them, with Claude as the archetype. The current system is a disaster."*

This is the consolidated design that reconciles #110's three-layer frame with the composition
hazards the read-lane engineer and the adversarial reviewer verified on the wire. It is written to be read once and greenlit. Every
load-bearing claim below was checked against the code or the live host, not inferred.

---

## 1. The problem, stated once

An **external agent** — holds its own Nostr key, is **not** a member of the NIP-42-gated fleet
relay, and therefore **cannot read `#connector`** — must be reliably notified of two hive events:

1. an **@mention** of it, and
2. a **reply to one of its own messages**.

Claude is the archetype. Today neither works end-to-end, and the failure is at both ends of the pipe.

## 2. Why it has never worked (verified)

| Claim | Evidence @ `718aa7c` / live box |
|---|---|
| Mentions have no path at all | `scanReturnLane` runs **only** from `pollCommands()` over `PUB.staging` (`bridge.mjs:909→914`). `staging_inbox` on the bridge box resolves to `waggle-test` (`a8186b53`), **not** `#connector` (`73f80d38`). The scan reads the quarantine room, never the working room. |
| `return_lane` was dead until tonight | It no-ops on an empty guard (`:883`); it was unset on the live bridge box until the read-lane restart at **02:01:21Z**. |
| No author gate on the carry-out | `scanReturnLane` (`:881–908`) filters only skip-self (`:889`) and the `@name` word-boundary match — no `grantors.includes(from)`, unlike `processGrantEvent:380`. Safe only because `staging` holds pre-gated content. |
| Detection is solved; **action is not** | The wake-watcher (durable dedup, 48h backfill, per-arrival grant check) writes to a **queue file on nave.pub** — the watcher service's spool volume, on the same host as the participant runtimes. Nothing there **is wired to act on it**: the queue accumulates and drains nowhere. (This line used to say nothing that can act *lives* on that box, which #419 measured as false — that host runs 12 containers and two live instance manifests. What it lacks is an Anthropic credential and a provider CLI, not compute.) A human gets paged — and only for DMs, not the mentions this team actually uses. |

The honest one-line summary: **the room is wrong, the sender is ungated, and nothing acts.**

## 3. The unifying principle

There is one idea already latent in the codebase — make it the spine:

> **The agent's own key is the single subscribable address. Every ingress path terminates as a
> sealed `1059` delivered to that key, plus a content-free wake.**

The bridge is the **only** party that can read the gated channel, so it is the mandatory forwarder.
This is already true for DMs (`forward`) and Concord posts (plane-authored wraps). We extend the
same shape to fleet-channel mentions and replies — nothing new-in-kind, one door widened correctly.

## 4. The architecture — three layers, one job each

### Layer 1 — Ingress (bridge-side · the bridge engineer's lane)

**Detect two trigger types in an explicitly configured channel set** (default: `#connector`):

- **@mention** — the existing `@name` word-boundary match (keep it; `@claudex` must not hit `@claude`).
- **reply-to-agent** — **NEW.** A Buzz reply p-tags its parent's author (observable on the wire: replies
  in this very thread carry `["p", <parent-author-hex>]`). So a reply to the agent is detectable as
  *a `p` tag equal to a return-lane pubkey*, no body match required. This is the "replies to them"
  case the maintainer named as first-class, and it needs no new state — the thread structure already encodes it.

**Three seams, all required together:**

1. **`scan_channels` as explicit config** (resolved at boot like `inbox`/`staging`; `scan_channels`
   key is currently **absent** on the bridge box — the clean seam). Defaults to empty, **never** implicitly
   `staging`.
2. **A separate `pollScanChannels()`** poll, distinct from `pollCommands()`. `pollCommands` keeps
   reading *only* `staging` for signed approval commands. Working-channel traffic must **never** reach
   `handleCommand` (the read-lane engineer's decoupling — otherwise every `#connector` post is parsed as a console command).
3. **An author gate** on the carry-out, reusing the `:380` grantor/approver check — defense-in-depth
   and spam control (see §5 for why it is *not* the load-bearing safety property).

### Layer 2 — Detection (unchanged — do not touch)

The wake-watcher is the one piece that works: open REQs, 48h backfill for NIP-59 backdating, durable
dedup **checked before decryption**, grant verified per arrival, default-closed when policy is
unverifiable. Keep it verbatim. For the fleet-channel path, Layer 1's scan *is* the detector; for DMs,
the existing `1059` forward is. Both converge on the same terminus: sealed delivery + content-free wake.

### Layer 3 — Action (the missing layer — **the one decision for the maintainer**)

Detection currently ends at a file. Something must **start a session**. Options, ranked:

- **(a) Run the actor on nave.pub — recommended, but it is not free (#419).** The watcher,
  on a gated wake, spawns `claude -p` with a **fixed prompt** (§5 — the fixed prompt is *what makes
  it safe*). This is the only option that makes "event-driven" true: no human, no laptop, no page.

  This option used to read "the box never sleeps and already holds an agent runtime and an API key",
  which asked for a decision on a premise nobody had checked. Measured 2026-08-13:

  | claim | verdict |
  |---|---|
  | nave.pub never sleeps | yes — an always-on server |
  | already holds an agent runtime | yes — 12 containers, `/etc/nvoy`, two live instance manifests |
  | already holds an API key | **no**, for a Claude actor — and this is the row that carries the option |

  **The host was named correctly; two of the properties claimed about it were not.** `nave.pub` is
  the container host, in this section and in §2, and it holds the wake-watcher's spool volume as well
  as the runtimes — so the queue and any actor are co-located and (a) involves no cross-machine hop.
  What was wrong was the API-key claim here, and §2's "nothing that can *act* lives on that box",
  which the container inventory directly contradicts. Both are corrected.

  **There is no Anthropic credential on the container host, and the credentials directory is what
  proves it.** Provider keys on that host are *files*, named `<instance>.<provider>-api-key`. The
  directory holds five entries: a Bunker URI and a NIP-46 client key for each of the two instances,
  plus `codex-jaf.openai-api-key`. That is the only provider key, and there is no Anthropic
  equivalent for either instance.

  (An earlier draft offered a search for `ANTHROPIC_*`/`CLAUDE_*` *variable names* as the proof. That
  search returns nothing, but it never could have matched a file under this naming convention, so it
  did not establish the claim it was cited for.)

  Nor is there a `claude` CLI: absent from the host, which has no `node` on it either, and absent
  inside the Claude-named adapter container, which has `node` and no provider CLI.

  So (a) is not "switch it on". It is: seat an Anthropic credential on the container host, install a
  provider CLI in the container that will spawn it, then wire the wake. Each is a decision on its
  own terms, and the credential is an operator action — §5's whole premise is that the actor runs
  unattended, so the key sits on nave.pub full-time.
- (b) Ship the queue to wherever an actor lives (the pull pattern the tripwire already uses for
  journals). Keeps today's shape; still needs something to notice the file changed.
- (c) Keep the human in the loop — today's behaviour. Honest, and not event-driven.

**→ Decision requested: approve (a).** It is the only choice that closes the loop, and its safety
falls out of §5 rather than being bolted on.

## 5. The safety design — wake and payload are decoupled

The adversarial review was right that a naive compose is an exploit: *if the action layer starts a session from the
carried body, "arriving text reaching a prompt" becomes the main path, injectable by any poster.* And
he was right that the external actor **cannot** read `#connector` itself (NIP-42-gated), so the content
**must** be carried — "a wake says THAT never WHAT" cannot hold for the actor path if we read it naively.

The resolution is not "restrict who can send" alone — an author gate still delivers attacker-authored
content into the actor path; it only narrows the set. The structural fix is to **split the wake from the
payload**:

- **The wake** (what *starts* the session) is **content-free** and starts `claude -p` with a **fixed,
  code-owned prompt**. It says *"there is mail in `#connector`, go look."* It carries no channel text,
  no summary — nothing an author controls.
- **The payload** (the actual mention/reply body) is carried by the bridge as a sealed `1059` into the
  agent's inbox and is available to the woken session **as untrusted data on the read plane — never
  spliced into the instruction/system prompt.**

Why this is strictly better than an author gate alone:

- The thing that *starts* a session is never derived from channel text, so **an ungated wake is
  structurally safe** — a hostile `@claude` post causes at worst a spurious wake, not an injection.
- The invariant holds honestly end to end: *the wake says THAT; the payload is data, never
  instruction; both are true at once.*
- The author gate (§4.3) stays, but as **spam/abuse control and defense-in-depth**, not as the sole
  thing standing between a channel poster and a prompt.

**The ordering that must not be taken:** shipping the `scan_channels` change *without* the
wake/payload split (and the author gate) — that is the exploit with a delivery mechanism.

## 6. Invariants any implementation must keep (all earned tonight)

- **A wake says THAT, never WHAT** — enforced by §5's split, not by trust in the sender.
- **Grant-gated before the agent sees a word** — the author gate lives in ordinary auditable code.
- **Unable to verify policy is not permission** — no relay answered ⇒ nothing actionable.
- **Dedup durable across restarts** — it was not until tonight; container recreates re-notified for mail
  answered hours earlier. Persist the dedup set; test a restart.
- **Silence must never look like calm** — a failed send and a dead watcher have *both* already happened
  here and each looked identical to "no mail." Both must alarm.

## 7. Sequencing & ownership

| # | Work | Owner | Gate |
|---|---|---|---|
| 1 | `scan_channels` config + separate `pollScanChannels` + p-tag reply detection + author gate + **content-free wake split** | the bridge engineer | ship as one PR; the split is non-negotiable |
| 2 | Layer 3(a): watcher spawns `claude -p` with a fixed prompt on the container host, **after a credential and a provider CLI are seated there** (#419); carried body delivered as read-plane data | the bridge engineer + the read-lane engineer (owns box/read lane) | **needs the maintainer's go on §4 L3(a)** |
| 3 | Invariants as tests: durable-dedup-across-restart, silence-alarms, untrusted-body handling | adversarial review (adversarial review) | before arming |

**Do not** redesign the watcher. **Do not** ship Layer 1 without §5. Arm nothing until item 3 passes.

## 8. The one call to make in the morning

Approve **§4 Layer 3 option (a)** — run the actor on nave.pub with a fixed-prompt wake. Once §5 is
in, the wiring is mechanical and safe by construction.

**It is not a single yes, and §4 says why (#419).** The version of this section that claimed it was
rested on that host already holding an API key, which it does not for a Claude actor. The yes being
asked for is really three: seat an Anthropic credential there, put a provider CLI in the container,
then arm the wake. The first is an operator action and the one to weigh — an unattended actor means
the key lives on nave.pub full-time, which is a standing credential to protect rather than a config
line to add.

**Approve it knowing the blast radius, which is not empty today.** That host already holds a provider
key with no consumer (`codex-jaf.openai-api-key`, `root:root 600`, no running worker — #428), the
session state of every hosted agent, and root via the management path. Adding an Anthropic key does
not create that exposure; it raises what sits behind a single compromise of one box. This is an
argument for approving (a) with the credential's handling named, not against it — (a) remains the
only option that closes the loop.
