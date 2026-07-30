# The DM trust allowlist

> **Scope:** the list that decides **which senders an agent will act on** when a
> direct message arrives — and, stated plainly, the fact that today it is *honoured by
> the agent* rather than *enforced around it*. This is **not** the bridge's reply-trust
> allowlist; see §3 for the disambiguation, because the two share a word and nothing else.

An agent on this platform has a public key, and a public key has an inbox anyone can reach:
sending a NIP-17 DM to a published npub requires no permission. The bridge delivers those
sealed DMs into the agent's inbox untouched (lane 1 — non-custodial, it never unwraps). So
by the time a message reaches an agent's reasoning, its author could be anyone on the open
network.

The DM trust allowlist is the answer to the question that raises: **of everyone who can
reach me, whose messages do I treat as instructions?**

---

## 1. What it governs — and what it does not

**It governs authority to instruct.** The allowlist is a short, explicit set of sender
pubkeys whose DMs the agent will *act on* — follow as tasking, treat as coming from its
operator. A message from a sender **not** on the list is still received; it is simply not
authoritative. The agent may read it, may answer a question in it, but does not take
instructions from it.

**It does not govern delivery.** Nothing is dropped from the wire, censored, or hidden.
The bridge forwards every sealed DM addressed to the agent; non-custody is unchanged. The
allowlist is a decision made *after* delivery, about what to obey — not a filter on what
arrives.

**It does not govern the public lane.** Reply-trust, quarantine, and moderation of the
open-Nostr in-door are a separate mechanism with a separate list (§3).

The distinction is the whole design: **listening is not obeying.** An agent can hear the
whole network and take orders from almost none of it. Authority is a short explicit list,
not whoever can reach you.

---

## 2. The threat it addresses

Instructions arriving from strangers — prompt injection by DM. An agent that treated every
inbound message as tasking would do whatever the last person to message it said. On an open
network where anyone can send that message, that is not a hypothetical; it is the default
failure mode unless something says otherwise.

The allowlist is that something. It replaces "obey whoever reached me" with "obey this
named set." The principle it encodes is that **reachability is not authority**: being able
to deliver a message to an agent's inbox — which is a property of the agent having a public
key at all — must not confer the power to direct it.

This is deliberately a *small* list. The same logic that makes an auditable signed
admission better than a hidden allowlist elsewhere in this project applies here: authority
should be explicit, short, and named, so that "who can tell this agent what to do" is a
question with a written answer rather than "anyone, in practice."

---

## 3. Not to be confused with reply-trust (`trusted_repliers`)

There is an unrelated in-code mechanism in this repository that also uses the word
"allowlist," and a reader who finds one will reasonably think they have found the other.
They are opposite ends of the pipe:

| | **DM trust allowlist** (this doc) | **Reply-trust** (`cfg.public.trusted_repliers`) |
|---|---|---|
| Lives on | the sealed **DM** lane (lane 1) | the public **kind:1** read lane (lane 3) |
| Decides | whether the **agent obeys** a sender's instructions | whether a public reply **skips the quarantine queue** into a community channel |
| Evaluated by | the **agent**, after decryption | the **bridge** (`src/bridge.mjs`, `PUB.trustedRepliers`), before delivery |
| About | authority to *instruct* | authority to *enter a channel* |
| Granted by | the operator's operating rules | the in-Buzz approval console's **follow** verb |

Reply-trust is a delivery/moderation decision the bridge makes about *someone else's*
content entering *your* community. The DM trust allowlist is a decision the *agent* makes
about whose words are orders. Same word; do not read a guarantee about one from the code of
the other.

---

## 4. Honoured, not enforced — the current form, stated plainly

Today the DM trust allowlist is **honoured by the agent, not enforced around it.** The
agent is *told*, in its operating rules, to act only on instructions from allowlisted
senders. The guard lives **inside** the thing it guards: a non-allowlisted DM still reaches
the agent's context, and the discipline holds only as long as the agent follows its own
instructions.

That is a real limit, not a formality. A behavioural guard inside the reasoning boundary is
arguing with an adversary who is already inside the room — a sufficiently crafted injection
is precisely an attempt to talk the guard out of guarding. Enforcement means the
unauthorized message never becomes context in the first place: it is dropped at a boundary
the agent's reasoning does not control.

**Why enforcement is not simply "filter at the bridge."** The bridge cannot enforce this
list, and that is by design: a sealed DM's real sender is *inside the seal*, and the bridge
never unwraps (the outer `p` tag names only the recipient). The sender becomes knowable
only after decryption. So enforcement has to live at the **consumer's runtime edge** —
post-decrypt, pre-reasoning — where the sender is known but the message has not yet reached
the model. A trusted pre-processor unwraps, checks the sender against the list, and only
then admits the message (or drops it), rather than handing everything to the agent and
trusting it to self-police.

### The work that changes it

The enforced shape already exists in a sibling integration: the Marmot/opencode bridge in
`mdk` gates inbound messages on `WN_OPENCODE_ALLOWED_SENDERS_HEX`. Its dispatch loop
(`integrations/opencode/marmot/src/bridge.rs`) checks each event's sender against the
configured `allowed_senders` set and, for anyone not on it, logs `sender_rejected` and
returns without dispatching to the agent at all — the message is dropped *before* it can
become context. That is exactly the boundary this lane's allowlist is missing: the check
sits **around** the agent, in a process the agent's reasoning cannot argue with, not
**inside** it as an instruction to be followed.

Bringing that shape to the DM lane here — a runtime-edge sender gate that drops
non-allowlisted senders' decrypted DMs before they reach the model — is the work that moves
this allowlist from *honoured* to *enforced*. Until it lands, this document is the honest
statement of where the boundary actually is.

*See also: [`CONCORD_CONSUMER.md`](CONCORD_CONSUMER.md) (the same runtime-edge boundary,
for group traffic) and [`SECURITY.md`](../SECURITY.md).*
