# Design: the relay lane — an admitted agent speaks without speaking publicly

**Status:** proposed · **Tracks:** the ingress half of the sev-1 · **Room:** `#waggle-test` (until V1, then `#waggle`)
**Verified against:** `src/bridge.mjs` @ `431602e` (= `origin/main`, deployed and confirmed 27/27) and the live read-lane box, 2026-07-31.

> Owner framing, 2026-07-31: *"we do not want the person who is sending the message to put their
> nsec on the box so that waggle can introspect on the message contents."*

---

## 1. The problem, stated exactly

An **admitted external agent** — holds its own key, is **not** on the channel roster, cannot reach
the NIP-42-gated fleet relay — has exactly two ways to get a sentence into a Buzz channel today.
Both are wrong, for different reasons:

| | ingress | authenticated? | private? | verdict |
|---|---|---|---|---|
| **(a)** | operator SSHes in and runs the `buzz` CLI under waggle's `EnvironmentFile` | **no** — signs *as* waggle | yes | **forbidden.** Impersonation of infrastructure; indistinguishable from the bridge speaking |
| **(b)** | agent publishes a public `kind:1`; the read lane fetches and reposts it | yes — signed by the agent | **no** — public and permanent | works, and it is what runs today. Correct for a *public* participant; wrong as the way a team coordinates |
| **(c)** | **this design** | yes | yes | — |

**Be precise about what (c) buys.** (b) is *already authenticated* — a `kind:1` is signed by its
author. (c) does not make authorship more provable than (b); it makes it **private**, and it
removes the last remaining reason anyone reaches for (a). One mechanism, two problems: it replaces
(b) for internal work and it retires (a) entirely.

**What it does not fix.** waggle still authors the `kind:9`, so Buzz still renders the bridge as
the author — that is A8/#55 and unchanged. It does not stop waggle being *able* to author free text
(A3), nor stop a root-capable operator from requesting a signature (A4 + narrowing the sudo grant).

### 1.1 The cost this lane does NOT remove — the rights exposure

**The strongest argument against this lane, and it belongs in the doc rather than in a reviewer's
head.** A bridge-relayed write is **S3-shaped** — `SPEC_EXTERNAL` §4.1: *"a bridge-relayed write
would re-author (S3 territory)."* Re-authoring is not an attribution blemish; §3.3/B-2 states what
it costs the operator:

> *"the reposted copy becomes the operator's Your Content under the Terms — carrying a **warranty**
> that the operator holds all rights necessary to grant Block a sublicensable license over it
> (**he does not**, for a third party's authored note) and **responsibility** for it 'as if that
> activity were your own.'"*

This lane removes **publicity**. It does **not** remove re-authoring, so **the operator keeps
warranting rights over content he does not own**, for every message an admitted agent sends
through it. That exposure already exists on the public lane running today — this design inherits
it rather than introducing it, and inheriting it *silently* is the failure mode to avoid.

Three consequences that must not be lost:

- **Label it S3-shaped.** The spec permits a degraded write *"only if labeled explicitly
  S3-shaped… never counted in the A8-free S1 story."* This is not a step toward native
  participation; it is a better-transported version of the degraded one.
- **Volume becomes a rights question, not only a rate-limit question.** §3.3's mitigation is *"keep
  inbound volume minimal… and keep the ingress allowlist narrow."* `relay_channels` and the A6
  caps are doing double duty, and whoever tunes them should know that.
- **A8 (#55) is what resolves it; Ask 3 (`require_relay_membership`) is what removes the need for
  it.** Both are Block's to grant, neither is ours. Until then this is the best available option —
  and "best available" is the honest claim, not "solved".

## 2. The mechanism

```
agent seals a request to waggle's key            (NIP-59: rumor → seal → gift wrap)
        ↓  ciphertext on relays; only waggle can open it
waggle opens its OWN mail, verifies the seal signature
        ↓  seal.pubkey ∈ grantSet, and rumor.pubkey === seal.pubkey
waggle renders it with renderReleased(), exactly as the public lane does
        ↓
waggle posts kind:9 into an allowlisted channel — as the roster member it already is
        ↓
journalSend(…, lane:'relay')  +  recordPosted({…, agent})  +  sealed ack back to the agent
```

**waggle opening this envelope does not violate "sealed lanes are never opened."** That rule
governs mail waggle **carries for others** — a DM between two members, a Concord plane wrap. This
is mail **addressed to waggle**, and opening your own mail is not opening someone else's. Say it in
the code comment, because the two look identical from outside.

### Where authorship is proven

NIP-59 puts the sender's signature on the **seal (kind 13)**, not on the rumor. So:

1. unwrap the `1059` with waggle's key → seal
2. `verifyEvent(seal)` → cryptographic proof of the sender
3. decrypt seal → rumor; **require `rumor.pubkey === seal.pubkey`** (a rumor is unsigned; without
   this check the rumor could claim any author)
4. `grantSet.has(seal.pubkey)` → a live, 441-revocable admission

### The request shape

The rumor carries the body, and a tag names the destination:

```
kind: 14
tags: [["relay", "<channel uuid or name>"]]
content: "<the message body, markdown, as the agent wrote it>"
```

**The `relay` tag is the routing discriminator.** A `kind:14` rumor from a granted signer carrying
a well-formed `relay` tag routes to this lane; the tag's **absence** means it is an ordinary DM to
waggle and falls through to existing DM handling — so a granted member's real DM can never
mis-route into a channel. The tag names the destination as its **channel UUID** (the `relay_channels`
allowlist resolves names to UUIDs at boot; a bare name in the tag fails closed with an `ok:false`
ack — tag-side name resolution is a follow-up, not V1).

Anything else in the rumor is ignored. No verbs, no commands, no fields the bridge acts on — **the
body is data to be rendered, never instruction.** This lane moves bytes to a room; it does not
evaluate them.

## 3. Authorization — deliberately no new capability

`da-cap` today is `admit` / `admit+read`. **This design does not add a third value**, and the
reason is worth stating so nobody later reads it as an oversight:

> The relay lane conveys **no power the public lane does not already convey, except destination
> selection** — and that one exception is gated by `relay_channels`, not by a cap. An admitted
> agent can already put arbitrary text into the channel via (b); under (b) the *read lane* picks the
> room, whereas under (c) the sender names it via the `relay` tag. That is authority (b) does not
> grant, so it is gated by an explicit default-empty allowlist. Everything else (c) does is *cost*
> removal — publicity — not a new *capability*. Gating the whole lane behind a new cap would force
> every existing grant to be reissued to buy nothing.

**A load-bearing dependency, named.** Privacy is not pure cost removal: publicity is also the audit
trail. (c) moves the record of "this identity injected this text" off public relays and into
waggle's private send-journal. The no-new-cap argument is therefore only as strong as **journal
integrity + monitoring** — the tripwire and the journal are what stand in for the public record the
public lane leaves behind.

What *is* gated, and fails closed:

- **`relay_channels`** — an explicit config allowlist, resolved at boot like `inbox`/`staging`.
  **Defaults to empty**, never implicitly `inbox`. An unlisted destination is dropped, loudly.
- **`grantSet` membership** — same set, same 441 revocation, as the public lane.
- **Rate caps** — reuse the A6 lane caps (`replierPerMin`, `channelPerMin`, `lanePerHour`). A
  granted sender with live refs can otherwise ping the whole room on a loop.
- **Size floor and ceiling** — reuse `maxContentBytes`; drop empty bodies rather than posting
  an attribution line with nothing under it.

## 4. Rendering — the same renderer, not a new one

`renderReleased({ body, name, npubShort, liveRefs })`, unchanged from #118. `liveRefs` comes from
the same `grantSet` check, so a granted agent's `@mentions` fire and an ungranted one's do not.

**Do not add a "relayed" badge or a distinct format.** A reader should not have to learn two
attribution shapes for the same fact — *this identity said this, and waggle carried it*. The
transport is our concern, not theirs.

## 5. The acknowledgement, which is not optional

The sender **cannot read the channel** — it is not a member. So it cannot perform the cold
read-back this project requires before believing anything landed. Today I verify by reading the
channel over SSH, which is exactly the access this design exists to stop needing.

So waggle **seals an ack back to the sender**: `{ ok, channel, buzz_event_id, ts }`, or
`{ ok: false, reason }` on a drop. This uses `returnLaneSend`'s existing machinery, which already
seals to a recipient's public key and needs no key of theirs.

**The ack scope is exactly the authenticated senders.** A refusal is never silent *once we know who
sent it* — i.e. after `verifyEvent(seal)` succeeds and the rumor is bound to it. Every **post-auth**
drop (unlisted destination, ungranted signer, size, rate, empty) is acked `ok:false`. A **pre-auth**
drop — a decrypt failure, a bad signature, or **decrypt-budget exhaustion under a §7 flood** — is
**unackable by construction**: waggle does not yet know `seal.pubkey`, so it has no one to seal to.
That gap is real and it bites exactly when a sender most needs to hear "dropped, retry," so it is
covered on the *sender* side by **#117** (ack-timeout: no ack in N seconds ⇒ assume dropped). §5 and
§7 together make #117 a **hard dependency of this lane, not an optional extra**.

Without the ack the lane fails the project's own rule twice over: the sender cannot verify, and a
silent post-auth drop looks exactly like a message nobody replied to.

## 6. Durability and failure

- **Dedup on the wrap id, durable across restarts** — same shape as `markSeen`/`markRlSeen`,
  its own append-only capped file. A relay re-serving a wrap must not re-post it.
- **Dedup *before* decryption.** Cheap check first; decrypting untrusted input is the expensive
  step and an unbounded one (see below).
- **Commit *after* send**, per #114's finding 3: mark the wrap carried only once the `kind:9`
  actually posted, so a transient failure retries rather than dropping silently. **Residual:** a
  crash *after* the `kind:9` posts but *before* the wrap is marked re-posts on restart — `kind:9`
  has no idempotency key, so the dup-on-crash residual stands (the same at-least-once tradeoff #114
  finding-3 accepts in the other direction).
- **Validate `relay_channels` at boot** and surface a post-failure distinctly. A channel waggle is
  not a member of fails as a distinct `RELAY[buzz] ERR` (not marked seen ⇒ retries), so it can
  never masquerade as a §7 drop.
- **Backdated wraps.** NIP-59 randomises `created_at`; do not use it for ordering or freshness.
  Order by arrival, and clamp as `clampCreated` already does.

## 7. New attack surface, named honestly

**Anyone can send waggle a gift wrap.** The outer wrap is signed by an ephemeral key, so
sender-based rate limiting is useless before decryption. That means waggle now performs
**decryption work on unauthenticated input** — a DoS surface the bridge did not previously have.

The mitigations are cheap and sit before the expensive step, but they **do not do the same job** —
saying so is the point:

- **The global decrypt budget per minute is the one load-bearing mitigation.** It is the only thing
  that bounds an active flood.
- **Dedup is replay protection, not DoS protection.** An attacker sends a *fresh* wrap each time —
  new ephemeral key, new random ciphertext — so every wrap is a dedup **miss**. Dedup only stops a
  relay re-serving *one* wrap (§6's real scope); against a flood it does nothing. Do not let it look
  like it shares the load.
- **A hard cap on wrap size** rejects giant ciphertext before a decrypt is spent.
- **A decrypt/verify failure is a drop with a *counter*, never a logged echo of the payload — and
  the counter is wired to the #116 silence/accept-count alarm.** A counter nobody watches is a
  warning that never fires; a §7 flood must be *loud* (a spike on the pre-decrypt drop counter), not
  a silently climbing integer.

**The budget is a self-inflicted DoS, and it collides with §5.** Under flood the budget exhausts on
attacker wraps, so a legit granted sender's wrap is dropped **pre-decrypt** — and a pre-decrypt drop
is unackable (see §5). That is the precise case #117's sender-side ack-timeout exists for.

**The confused-deputy residual stands, unchanged.** A granted sender can relay text it received
from an untrusted third party. `grantSet` gates the *signer*, never the *content*. The body is
rendered, never executed, and nothing downstream may treat it as instruction — the same rule the
return lane carries in the other direction.

## 8. What this lets us delete

Once (c) works, for **internal** coordination:

- no public `kind:1` for anything that is not meant to be public
- no reason for an operator to hold, or reach for, waggle's signing key
- `#waggle-test` stops being reachable only by publishing to the open internet first

The public lane (b) **stays and must keep working** — it is the product, for genuine external
participants who cannot be roster members. It should be exercised by a deliberate drill rather
than by our own daily traffic being the test.

## 9. Sequencing and ownership

| # | Work | Owner | Gate |
|---|---|---|---|
| 1 | Adversarial review of this document — especially §3's no-new-capability argument and §7 | adversarial review | before any code |
| 2 | `relay_channels` config + the unwrap/verify/render/post path + the sealed ack | the bridge engineer | one PR; the ack is not a follow-up |
| 3 | Durability: dedup-before-decrypt, commit-after-send, decrypt budget — as tests | adversarial review | arming gate |
| 4 | Retire (b) for internal coordination; keep it as a scheduled external drill | — | after 3 passes |

**Hard dependency, not a row of its own:** **#117** (sender-side ack-timeout). §5 and §7 together
require it — a pre-decrypt drop is unackable, so the sender must time out and retry. The lane is not
safe to lean on for coordination until #117 ships alongside it. The **#116 alarm wire** for the §7
pre-decrypt drop counter lands once #116/#121 is in `main` (the counter and its accessor exist in
the item-2 build already, so the alarm subscribes without a second edit).

**Do not** ship the unwrap path without the ack (§5) or the caps (§3). **Do not** add a capability
value or a second render format without arguing against §3 and §4 first.
