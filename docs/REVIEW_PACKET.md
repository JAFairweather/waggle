# waggle external review packet

waggle is a non-custodial, quarantine-gated bridge between a private Buzz community and
the open Nostr network. It gives a community doors it can operate, rather than turning the
community into a public room or asking one bridge account to impersonate everyone in it.

This page is the handoff. It is intentionally public, short, and free of deployment paths,
private channel names, credentials, or internal review history.

## What to review

Start with the [project overview](../README.md), then use these three documents for the
load-bearing details:

- [Getting started](GETTING_STARTED.md) — the guided owner path, readiness check, and
  production topology.
- [External specification](SPEC_EXTERNAL.md) — the protocol model, proof record, safety
  gates, and known platform gaps. It is a dated design record; the README's “true today”
  table is the current status surface.
- [Key custody](KEY_CUSTODY.md) — the exact split between the local Buzz poster and the
  Bunker-backed Nostr transport identity.

The public home and owner console are at [waggle.nave.pub](https://waggle.nave.pub/).
The implementation is [JAFairweather/waggle](https://github.com/JAFairweather/waggle).

## What exists now

- Member-signed public federation with relay read-back.
- A default-closed inbound quarantine with human release.
- Signed, scoped, revocable participant admission and task authority.
- Consent-gated public-feed following.
- Sealed return delivery to admitted external participants.
- NIP-46 support for the bridge's Nostr transport identity, so that identity's nsec need
  not live on the bridge host.
- A guided setup flow and a separate, browser-based owner console.

The automated suite exercises both the accepted paths and the default-closed failures.
Where a claim depends on a relay, acceptance alone is not treated as proof; the operational
standard is cold read-back.

## The boundaries we want challenged

1. **Authorship.** Outbound public notes retain their member's signature. Buzz cannot yet
   render a verified foreign-signed event natively, so inbound public notes use an honest
   bridge-authored carrier with source provenance. That limitation is tracked upstream.
2. **Custody.** Sealed forwarding does not decrypt. Relay ingress opens only envelopes
   addressed to the bridge. The return lane seals outbound traffic; it does not open an
   inbound message. Buzz channel posting still uses a dedicated local CLI key.
3. **Authority.** Network reachability is not permission. Participant admission, consent,
   task authority, and carrier-only task relay are distinct signed capabilities. A task
   relay can carry an original signed instruction but cannot become its author.
4. **Failure direction.** Missing grants, stale policy, unreadable relay state, malformed
   events, and unresolved routing all fail closed.
5. **Operator experience.** The owner should be able to install, inspect, follow, inspect
   consent state, request consent, grant, revoke, and diagnose without learning the
   bridge's internal storage layout. Consent itself remains the participant's decision.

## Useful review questions

- Is any carrier presented as the original speaker when it is not?
- Can a relay, bridge host, or model turn transport access into instruction authority?
- Does revocation stop the relevant capability without leaving a quiet cached permission?
- Does any setup step move a private key across a boundary unnecessarily?
- Can an owner tell what is live, what is held, and what failed from the supported surfaces?
- Which remaining platform capability would remove the most bridge-specific machinery?

Please report security-sensitive findings privately as described in
[SECURITY.md](../SECURITY.md). Ordinary design and implementation findings can use the
repository's issue tracker. A useful review names the exact document, source location, or
event shape and distinguishes a demonstrated defect from a design preference.
