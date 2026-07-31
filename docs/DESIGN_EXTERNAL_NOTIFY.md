# Design: notifying an external agent of hive activity

**Status:** proposed — decision-ready · **Tracks:** #110 · **Origin channel:** connector (`73f80d38-3245-41a9-814c-8ad364686944`)
**Verified against:** `src/bridge.mjs` @ `718aa7c` (= `origin/main`) and the live `/opt/waggle-read` box, 2026-07-31.

> Owner ask (James, 2026-07-31 02:16Z): *"completely rethink how an agent outside the hive gets
> notified of messages and activity of a channel inside the hive — especially replies to them and
> @mentions of them, with Claude as the archetype. The current system is a disaster."*

This is the consolidated design that reconciles #110's three-layer frame with the composition
hazards Neil and Dennis verified on the wire. It is written to be read once and greenlit. Every
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
| Mentions have no path at all | `scanReturnLane` runs **only** from `pollCommands()` over `PUB.staging` (`bridge.mjs:909→914`). `staging_inbox` on the box resolves to `waggle-test` (`a8186b53`), **not** `#connector` (`73f80d38`). The scan reads the quarantine room, never the working room. |
| `return_lane` was dead until tonight | It no-ops on an empty guard (`:883`); it was unset on the live box until the read-lane restart at **02:01:21Z**. |
| No author gate on the carry-out | `scanReturnLane` (`:881–908`) filters only skip-self (`:889`) and the `@name` word-boundary match — no `grantors.includes(from)`, unlike `processGrantEvent:380`. Safe only because `staging` holds pre-gated content. |
| Detection is solved; **action is not** | The wake-watcher (durable dedup, 48h backfill, per-arrival grant check) writes to a **queue file on nave.pub**. Nothing that can *act* lives on that box. The queue accumulates; it drains nowhere. A human gets paged — and only for DMs, not the mentions this team actually uses. |

The honest one-line summary: **the room is wrong, the sender is ungated, and nothing acts.**

## 3. The unifying principle

There is one idea already latent in the codebase — make it the spine:

> **The agent's own key is the single subscribable address. Every ingress path terminates as a
> sealed `1059` delivered to that key, plus a content-free wake.**

The bridge is the **only** party that can read the gated channel, so it is the mandatory forwarder.
This is already true for DMs (`forward`) and Concord posts (plane-authored wraps). We extend the
same shape to fleet-channel mentions and replies — nothing new-in-kind, one door widened correctly.

## 4. The architecture — three layers, one job each

### Layer 1 — Ingress (bridge-side · My Dude's lane)

**Detect two trigger types in an explicitly configured channel set** (default: `#connector`):

- **@mention** — the existing `@name` word-boundary match (keep it; `@claudex` must not hit `@claude`).
- **reply-to-agent** — **NEW.** A Buzz reply p-tags its parent's author (observable on the wire: replies
  in this very thread carry `["p", <parent-author-hex>]`). So a reply to the agent is detectable as
  *a `p` tag equal to a return-lane pubkey*, no body match required. This is the "replies to them"
  case James named as first-class, and it needs no new state — the thread structure already encodes it.

**Three seams, all required together:**

1. **`scan_channels` as explicit config** (resolved at boot like `inbox`/`staging`; `scan_channels`
   key is currently **absent** on the box — the clean seam). Defaults to empty, **never** implicitly
   `staging`.
2. **A separate `pollScanChannels()`** poll, distinct from `pollCommands()`. `pollCommands` keeps
   reading *only* `staging` for signed approval commands. Working-channel traffic must **never** reach
   `handleCommand` (Neil's decoupling — otherwise every `#connector` post is parsed as a console command).
3. **An author gate** on the carry-out, reusing the `:380` grantor/approver check — defense-in-depth
   and spam control (see §5 for why it is *not* the load-bearing safety property).

### Layer 2 — Detection (unchanged — do not touch)

The wake-watcher is the one piece that works: open REQs, 48h backfill for NIP-59 backdating, durable
dedup **checked before decryption**, grant verified per arrival, default-closed when policy is
unverifiable. Keep it verbatim. For the fleet-channel path, Layer 1's scan *is* the detector; for DMs,
the existing `1059` forward is. Both converge on the same terminus: sealed delivery + content-free wake.

### Layer 3 — Action (the missing layer — **the one decision for James**)

Detection currently ends at a file. Something must **start a session**. Options, ranked:

- **(a) Run the actor on nave.pub — recommended.** The box never sleeps and already holds an agent
  runtime and an API key. The watcher, on a gated wake, spawns `claude -p` with a **fixed prompt**
  (§5 — the fixed prompt is *what makes it safe*). This is the only option that makes "event-driven"
  true: no human, no laptop, no page.
- (b) Ship the queue to wherever an actor lives (the pull pattern the tripwire already uses for
  journals). Keeps today's shape; still needs something to notice the file changed.
- (c) Keep the human in the loop — today's behaviour. Honest, and not event-driven.

**→ Decision requested: approve (a).** It is the only choice that closes the loop, and its safety
falls out of §5 rather than being bolted on.

## 5. The safety design — wake and payload are decoupled

Dennis was right that a naive compose is an exploit: *if the action layer starts a session from the
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
| 1 | `scan_channels` config + separate `pollScanChannels` + p-tag reply detection + author gate + **content-free wake split** | My Dude | ship as one PR; the split is non-negotiable |
| 2 | Layer 3(a): watcher spawns `claude -p` with a fixed prompt on nave.pub; carried body delivered as read-plane data | My Dude + Neil (owns box/read lane) | **needs James's go on §4 L3(a)** |
| 3 | Invariants as tests: durable-dedup-across-restart, silence-alarms, untrusted-body handling | Dennis (adversarial review) | before arming |

**Do not** redesign the watcher. **Do not** ship Layer 1 without §5. Arm nothing until item 3 passes.

## 8. The one call to make in the morning

Approve **§4 Layer 3 option (a)** — run the actor on nave.pub with a fixed-prompt wake. Everything else
is mechanical and safe by construction once §5 is in. That single yes turns "detected" into "acted" and
makes `@claude` in `#connector` mean something for the first time.
