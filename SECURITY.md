# Security

## Reporting a vulnerability

Email **help@nave.pub** rather than opening a public issue.

A public issue is the wrong first move for a live flaw: it tells everyone who can read the
repository about a weakness before there is a fix, and this bridge runs in production. Private
first, public afterwards — once there is something to publish alongside the problem.

Please include what you did, what happened, and what you expected. A proof of concept helps
enormously; so does telling us how you would abuse it if we do nothing.

Expect an acknowledgement within a few days. If a report leads to a change, the fix and the
credit are both public.

## What is in scope

The bridge and its tooling in this repository — the safety gates, the quarantine path, the
admission grants, deletion propagation, the rate caps, the detection tooling, and the deployment
material under `deploy/`.

Things we would especially like to hear about:

- A way to get an unapproved event into a community channel — anything that bypasses quarantine.
- A forged or replayed grant that admits a participant, or a revocation that fails to remove one.
- A forged deletion that destroys a copy its author did not publish.
- A way to make the bridge publish something a member did not author or authorize.
- A path that puts a private key somewhere it should never be — a log, an argument list, a
  message, a public artifact.

## What is not a vulnerability

Stated plainly so a reporter is not left guessing:

- **The bridge holds one private key: its own posting identity.** Members sign their own outbound
  posts and the bridge never holds their keys. Be precise about what that means, because the key it
  *does* hold is real and operated: a compromised host hands an attacker the bridge's posting
  authority — the ability to sign as that identity, vouched for by the owner's attestation — until
  it is detected and rotated. That identity is deliberately lean and disposable so the loss is
  bounded to a re-mint rather than a person's voice. It is a bounded loss, not no loss, and
  "the bridge holds no keys" would be the wrong summary of it.
- **Quarantine is default-closed.** Replies from unknown keys are held for review rather than
  delivered. That inbound content sits in a staging channel is the design, not a leak.
- **Outbound is uncensored by design.** The bridge moderates entry into the community, never
  public Nostr. A reply that is not approved remains publicly visible on the open relays; it
  simply does not enter the walled community.
- **Relay availability.** Public relays flap, rate-limit, and evict notes. The bridge is built to
  tolerate it, and durability is asserted from more than one relay for exactly that reason.

## A note on scope beyond this repository

If a finding concerns the Buzz platform or the Concord protocol rather than this bridge, it
belongs with those projects. We are happy to help route it, and we have made such disclosures
ourselves — privately, and before saying anything in public.
