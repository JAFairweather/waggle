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

Anything else in the rumor is ignored. No verbs, no commands, no fields the bridge acts on — **the
body is data to be rendered, never instruction.** This lane moves bytes to a room; it does not
evaluate them.

## 3. Authorization — deliberately no new capability

`da-cap` today is `admit` / `admit+read`. **This design does not add a third value**, and the
reason is worth stating so nobody later reads it as an oversight:

> The relay lane conveys **no power the public lane does not already convey.** An admitted agent
> can already put arbitrary text into the channel via (b). (c) removes a *cost* — publicity — it
> does not add a *capability*. Gating it behind a new cap would force every existing grant to be
> reissued to buy nothing.

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
`{ ok: false, reason }` on a drop — including gate drops, so a refusal is never silent. This uses
`returnLaneSend`'s existing machinery, which already seals to a recipient's public key and needs no
key of theirs.

Without this the lane fails the project's own rule twice over: the sender cannot verify, and a
silent drop looks exactly like a message nobody replied to.

## 6. Durability and failure

- **Dedup on the wrap id, durable across restarts** — same shape as `markSeen`/`markRlSeen`,
  its own append-only capped file. A relay re-serving a wrap must not re-post it.
- **Dedup *before* decryption.** Cheap check first; decrypting untrusted input is the expensive
  step and an unbounded one (see below).
- **Commit *after* send**, per #114's finding 3: mark the wrap carried only once the `kind:9`
  actually posted, so a transient failure retries rather than dropping silently.
- **Backdated wraps.** NIP-59 randomises `created_at`; do not use it for ordering or freshness.
  Order by arrival, and clamp as `clampCreated` already does.

## 7. New attack surface, named honestly

**Anyone can send waggle a gift wrap.** The outer wrap is signed by an ephemeral key, so
sender-based rate limiting is useless before decryption. That means waggle now performs
**decryption work on unauthenticated input** — a DoS surface the bridge did not previously have.

Mitigations, all cheap and all before the expensive step: dedup first; a hard cap on wrap size; a
global decrypt budget per minute; and treat a decrypt or verify failure as a silent drop with a
counter, never a logged echo of the payload.

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
| 1 | Adversarial review of this document — especially §3's no-new-capability argument and §7 | Dennis | before any code |
| 2 | `relay_channels` config + the unwrap/verify/render/post path + the sealed ack | My Dude | one PR; the ack is not a follow-up |
| 3 | Durability: dedup-before-decrypt, commit-after-send, decrypt budget — as tests | Dennis | arming gate |
| 4 | Retire (b) for internal coordination; keep it as a scheduled external drill | — | after 3 passes |

**Do not** ship the unwrap path without the ack (§5) or the caps (§3). **Do not** add a capability
value or a second render format without arguing against §3 and §4 first.
