# Agent seat authorization

Issue #167 separates an **admission** from a sealed-lane **delivery seat**. Admission is a
maintainer-signed NIP-DA grant consumed by the read lane. A seat is privileged box work: it
creates an inbox, modifies the sealed-lane recipient topology, and restarts that unit. A browser
must never acquire an RPC route to that work.

## Authorization event

The operator's existing signer produces a plain, signed addressable event:

```json
{
  "kind": 30078,
  "tags": [["d", "waggle-seat"], ["p", "<sealed bridge pubkey>"],
           ["seat", "<agent pubkey>", "<display name>", "#general"]],
  "content": "{\"v\":1,\"op\":\"add\"}"
}
```

The event is authorization, not a request to an HTTP server. The private key remains in NIP-07
or NIP-46. A remove operation uses the same coordinate with `op:"remove"`; a fresh event must
carry a strictly newer `created_at` than the durable command watermark.

## Box watcher

The sealed host subscribes only to events tagged for its own bridge key. Before doing anything it
must verify all of the following:

1. Wire signature and author in the configured approver set.
2. Exact `d=waggle-seat`, exactly one matching `p` tag, exact versioned JSON shape, valid 64-hex
   agent key, bounded display name, and an allowlisted channel name.
3. Freshness (15 minutes) and durable monotonic command timestamp. Replays are no-ops.
4. `deploy/add-recipient.sh` succeeds, then `deploy/verify-config.sh` succeeds, before recording
   the command as applied.

The watcher has only the narrowly-scoped ability to call that script. It must not accept paths,
shell fragments, arbitrary channel IDs, or an action specified by event content. It publishes a
signed result record (`waggle-seat-result`) so the console reads success/failure from relays; it
does not expose a host endpoint.

## Product shape

The Console "Add seat" form asks for an agent name, npub, and approved channel set, shows the
unsigned event, and signs it with the operator's selected signer. It reports *pending* until a
verified bridge result appears. It does not silently conflate seat creation with NIP-DA admission:
the operator can choose **seat only** or **seat + admit**, and the latter emits the existing grant
as a separate, auditable event.

## Acceptance proof

Use a disposable public key: signed add → watcher journal → `verify-config.sh` → test sealed
message reaches its newly created inbox → signed remove → no later fan-out. Test malformed,
wrong-recipient, non-approver, old, duplicate, and failed-apply events as negative controls.

This document intentionally does not arm a watcher. Neil owns the root-side apply review; My Dude
owns sealed-lane behavior; Dennis reviews the event/replay boundary.
