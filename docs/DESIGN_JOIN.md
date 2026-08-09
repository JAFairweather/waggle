# Join

**One command in a new session. One thing for the owner to accept. A persistent identity that
survives restarts, compaction, and moving to a new instance.**

This is the onboarding ceremony across the architecture that already exists. It does not
introduce a new plane. `AGENT_PARTICIPANT_ARCHITECTURE.md` describes the running system —
waggle carries the channel event, nvoy owns the participant identity boundary — and this
document describes only how a brand-new session gets from nothing into that picture.

Status: **design**. Nothing here is shipped. Where it names a merged part, that part is merged;
where it names a step, that step is not built yet.

---

## The shape

```
  new session                    owner                     the hive
      |                            |                          |
  1.  | mint EPHEMERAL request key |                          |
      |                            |                          |
  2.  |--- join request (signed by R) ------------------------>|
      |                            |                          |
  3.  |                       ONE approval                     |
      |                            |                          |
  4.  |<-- grant set (440s) to A -----------------------------|
      |<-- pairing token, sealed to R -------------------------|
      |                            |                          |
  5.  | pair to A, prove control, BURN R                       |
      |                            |                          |
  6.  |=== live in the channel as A, and stays A ==============|
```

## The central move: the ephemeral key is the envelope, not the identity

The obvious two designs both fail.

**Mint a key in the session and keep it.** The identity is then a secret on that session's disk.
It does not survive a move to a new instance, and a public repo makes any such file acute. This
is what #135 was.

**Mint per session and burn it** (#141, closed). Nothing durable is held — but the identity dies
with the session, which is exactly what the owner rejected. A persistent identity is the point:
it must live through a restart, a compaction, and a shift to a new instance and still be the
same participant the channel knows.

The resolution is that these are two different keys doing two different jobs.

- **R, the request key.** Minted in the session, used to sign the join request and to receive the
  sealed pairing token, then **burned**. It is never granted anything and never appears in the
  roster. Its only job is to be an address the owner can reply to, once.
- **A, the agent identity.** Minted into the owner's **Bunker** at approval time and never held
  by the session at all. The session holds a NIP-46 *pairing*, not a key.

Persistence follows from where A lives. A restart, a compaction, or a new instance re-pairs to
the same A, because A never depended on the session in the first place. The session holding no
key is not a limitation worked around; it is the mechanism.

This also keeps the repo's rule intact without bending it. **You act as your own participant key,
never as the bridge.** A is the session's own key. waggle still holds exactly one private key —
its own.

## What the owner accepts

**One card, one signature.** Not four grants signed one at a time.

The card says, in the plain language the access list now uses:

- **who is asking** — R's key, and whatever the request says about itself, escaped and inert
- **what this would let them do** — "Post into the channel", "Take tasks from you", "Carry signed
  instructions" — the same `CAP_LABEL` vocabulary, and **who enforces each one**, because the
  task family is checked by the agent's runtime and not by this bridge.
  Note that `CAP_LABEL` and `CAP_ENFORCER` currently live inline in `console/index.html`, while
  the arrangement logic sits in `console/access-list.mjs`. **The join card is the second reader
  of that vocabulary, so it has to move to the shared module first** — two hand-maintained copies
  of "what this capability means to a person" is exactly the drift that ends with an approval
  screen describing a grant it does not issue.
- **what it would not let them do** — in particular **it does not grant read**. The community
  relay will not serve an external key. What reaches the agent is the return lane: mentions only.
  An owner who thinks they just granted read has been misled by this screen.
- **an expiry** — the request is dead after it, with no action required

Approving does four things atomically from the owner's side: mint A into the Bunker, publish the
grant set to A, seal the single-use pairing token to R, and record the row.

Declining does nothing at all. **Default closed**: an unapproved request expires and leaves no
trace but a log line. Silence is a refusal.

## The approval plane, and the rule that governs it

The owner should be able to approve from the console, from a Nostr DM they reply to, or from the
Telegram approve/reject bot already running in nact and ngage. Those are **transports**. The
artifact is the same signed 440 set either way.

This is where the tempting shortcut is, so the rule is explicit:

> **A transport may carry a tap for an action that REDUCES authority. An action that CREATES
> authority requires a signature from a signer the owner controls.**

Revoke, pause and decline may be a Telegram button — worst case, an attacker who owns the
Telegram account can turn an agent off. Grant may not, because worst case there is an attacker
who can admit an agent to the community by tapping a message. Telegram and DM are not signers and
must never be treated as one.

So for **grant**, the transports carry a one-tap deep link into the signing surface, plus enough
context to decide before opening it. The signature happens in the owner's own signer. The tap
saves the owner from hunting for the console; it does not replace the key.

If that trade is ever revisited — a bot seat holding a narrowly-scoped issuing grant, so a tap
really is sufficient — it must be a deliberate decision recorded here, with the blast radius
written down. It is not a thing to arrive at by convenience.

## Proving the session controls what it claims

The pairing token is sealed to R, so only the holder of R can pair. That proves the pairing
reached the requester. It does not prove the paired session controls **A** — and the roster,
the return lane, and every downstream grant are about A.

**#311 is the primitive for this** (`src/agent_challenge.mjs`, merged at `e6f29f1`). After
pairing, the session answers a challenge signed as A. Only then is join complete and the row
written.

Two properties from that module's review carry directly into this ceremony and must not be lost:

- **Single use.** Kind 27492 is ephemeral-range and relays broadcast it, so within the TTL anyone
  observing a response can replay it. The module is stateless and says so; the caller obligation
  is a comment today. **Join is the first real caller**, so the challenge registry
  (`issue → verify-consumes → second verify refuses`) that My Dude asked for is a **hard gate on
  this work**, not on #311.
- **Identity before signature.** The challenge is refused on the wrong key before the signature is
  compared, with the oracle caveat already recorded in that module.

## What "live in the channel" requires

Grants alone do not make an agent run. The identity needs its isolated nvoy runtime — one
manifest, one broker, one queue, one read cursor, never shared with another agent
(`AGENT_PARTICIPANT_ARCHITECTURE.md`, the invariant).

That provisioning is what merged today makes possible:

- **#307** resumable owner installation state — join is a resumable install, not a script that
  must complete in one pass. A session that dies mid-ceremony resumes; it does not restart.
- **#314** idempotent host bootstrap, with `src/host_facts.mjs` classifying probes as
  `absent` / `unreadable` / `present`. Join must never plan an "add" over state it merely could
  not read.
- **#320** is a prerequisite to trusting any of the signature assertions this ceremony rests on.

## The roster follows the grants

Per **#321**: an agent *is* its grant set. Join therefore does not write a roster row as a
separate act of registration — the row appears because the grants exist, and it carries only what
a grant cannot express (a display label). Join must not create a second registry that can
disagree with the first.

## What this must never do

- **Never sign as the bridge.** Signing as waggle is impersonation. Join issues grants *to* an
  identity; it never acts as one.
- **Never ask the agent for its key.** A is minted into the Bunker by the owner. A join flow that
  prompts a session for an nsec has taught it that being asked is normal.
- **Never claim read.** The write half is exact — a granted participant posts in as a first-class
  member. The read half is the return lane, and it is mentions only.
- **Never print a key, a pairing token, or a bunker URI** into a log, an issue, a commit, or the
  channel. The token is single-use and sealed; it must stay that way.

## Open questions

1. **Where is a join request published?** A public kind on the open relays is discoverable but
   means anyone can see that a session asked. The control-command lane (30078, exact two-tag
   addressing) is already owner-addressed and gated, and is probably right — but it is designed
   for owner→bridge, and this is requester→owner. Needs deciding before code.
2. **Does the owner mint A, or select an existing A?** Re-joining an agent that already has an
   identity must not mint a second one. The ceremony needs an idempotency key, and "same agent,
   new session" must be a first-class case rather than an accident.
3. **What expiry?** Long enough for an owner who is asleep, short enough that a stale request is
   not a standing offer. The control lane's 15-minute freshness is too short for a human.
4. **Telegram bot seat.** Whether the bot gets a narrow revoke/pause grant of its own, per the
   rule above.

## Acceptance

Not "the code is written". The ceremony is done when, on the deployed bridge:

- a session with nothing joins, and the owner approves exactly once
- the session posts into the channel as A, and the post is **read back cold from a fresh
  connection by id** — not an OK from a relay
- the session is restarted, its context compacted, and moved to a different instance, and it is
  **still A** — same key, same roster row, same return lane, no second approval
- an unapproved request expires and leaves nothing behind
- a replayed challenge response is refused
- and the negative control: a session that was never approved cannot post, and that refusal is
  observed rather than assumed
