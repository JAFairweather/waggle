# Off-box Buzz policy service

Status: design contract for the remaining half of #54. The Bunker-backed Nostr transport is
shipped; Buzz channel writes still use the local `BUZZ_PRIVATE_KEY` and are not covered by this
design until the migration gates in §10 pass.

## 1 · The security property

Moving a key into a generic NIP-46 bunker is not enough. A root attacker on the waggle host could
still ask that bunker to sign an arbitrary kind:9 while its session is valid. The remote boundary
must therefore answer a narrower question than “may this client sign?”:

> Can this exact Buzz write be derived, without trusting the requester, from a closed waggle
> operation and the complete signed evidence required by that operation?

The service constructs, signs, and submits the event itself. It returns a signed receipt, never a
signed event, NIP-98 authorization event, raw signature, or general signing method. The waggle host
has no Bunker credential and no network path that can invoke the Bunker directly.

This changes the live-host compromise outcome. A compromised bridge can replay or withhold
requests and can feed the policy service hostile evidence, but it cannot make the poster identity
say bytes that the independent policy function cannot derive from valid evidence and its own
policy state.

## 2 · Physical boundary

```text
untrusted bridge host                    separate policy host

relay/Buzz reads ── evidence packet ──► forced-command ingress
bridge retry queue       SSH stdin       (no shell/PTY/forwarding)
                                         │
                                         ├─ canonical decoder + size caps
                                         ├─ signature/provenance verifier
                                         ├─ policy-owned roster, channels,
                                         │  approvers, grants and rate state
                                         ├─ closed catalogue renderer
                                         ├─ durable idempotency journal
                                         ├─ NIP-46 client ──► Bunker
                                         └─ POST /events + response verifier
                                                    │
bridge journal ◄── signed receipt only ─────────────┘
```

Production placement may be `nave.pub`, but co-location is not the property. The service account,
credential files, state, network policy, and deploy authority must form a trust boundary the
waggle host cannot modify. The forced command fixes executable, service identity, policy instance,
and operation protocol version. It permits no caller-selected command, URL, relay, signer, auth
tag, timestamp, event kind, raw tags, or request headers.

The Bunker pairing authorizes only the policy-service client key. Revoking that pairing ends the
live signing capability without rotating the poster identity.

## 3 · Logical flow

```text
observe source
    │
    ▼
build bounded proof packet (no decision booleans, no pre-rendered body)
    │
    ▼
policy service canonicalizes ── invalid/unknown/oversize ──► signed refusal receipt
    │
    ▼
verify source signatures, authorship, links, grants and policy-owned destination
    │
    ▼
derive operation + render from the compiled catalogue
    │
    ▼
derive idempotency key; return prior receipt if terminal
    │
    ▼
construct kind:9 (or the closed edit/delete kind) + fixed NIP-OA tag
    │
    ▼
Bunker sign exact event ──► construct exact NIP-98 kind:27235 ──► Bunker sign
    │
    ▼
policy service POSTs itself, evaluates authoritative response, commits receipt
    │
    ▼
return signed receipt only
```

The requester never sends `approved: true`, `authorised: true`, rendered prose, a destination URL,
or a proposed event. Those are conclusions, not evidence.

## 4 · Common request envelope

The wire input is canonical JSON with a hard byte cap and exactly these common fields:

```json
{
  "version": 1,
  "policy_instance": "<fixed deployment id>",
  "operation": "<closed operation enum>",
  "catalogue_version": "<immutable release digest>",
  "observed_at": 0,
  "evidence": {}
}
```

`policy_instance` and `catalogue_version` must equal the forced command's fixed deployment. The
service supplies current time and every output address. `observed_at` is only bounded source
metadata; it cannot select an event timestamp or extend a freshness window.

Every event in `evidence` is the complete wire event, not selected fields. The service recomputes
ids, verifies signatures where the protocol provides them, rejects duplicate or ambiguous tags,
and verifies every cross-event reference itself. Unknown fields, operations, schema versions, or
catalogue digests fail closed.

## 5 · Evidence by operation family

### 5.1 Sealed forwarding

`sealed_envelope` carries the original signed outer wrap bytes and id, the source plane/channel
identifier, and the recipient identity that caused the bridge to observe it. The service verifies
the wrap and resolves both Buzz destination and recipient from its own roster and channel policy.
It renders the envelope bytes itself; host-rendered explanatory prose is never accepted.

`channel_plaintext` additionally carries the outer channel wrap and the encrypted inner chain plus
the channel epoch/derivation reference. Because a body/author pair is forgeable, the service must
possess or obtain the same channel-plane capability and independently open and validate every
signature, hash, author binding, and plane-author condition the protocol supplies. It must not
invent a signature requirement for a CORD/NIP rumor shape that is unsigned by design. Until that
capability is safely available off-box, this operation stays on the local poster path and the
migration remains incomplete.

### 5.2 Public ingress

`quarantine_header` and ordinary `released_post` carry the complete original signed public event,
source observation, and any signed grant/consent/revocation evidence needed by the selected route.
The service resolves the fixed staging or hive destination from policy, recomputes quarantine vs
direct admission, fetches/verifies profile attribution when used, applies freshness and rate rules,
and renders from the original event. A requested route or body is not accepted.

### 5.3 Console commands and watchlist changes

Release/follow/mute/reject and watchlist operations carry the complete signed approver command,
its `e`-anchored pending/source event where applicable, and source observation. The service owns
the approver set and current transition state. It re-fetches and verifies the original event for a
release and derives the acknowledgement only from the committed transition. A bridge assertion
that a command was approved or persisted has no authority.

### 5.4 Relay ingress and acknowledgement

The request carries the outer wrap, signed seal, hash-verified rumor author-bound to that seal,
grant/revocation evidence, and the logical channel requested by the rumor. The service verifies
the complete chain, resolves the fixed Buzz channel mapping, submits the derived post, and derives
an acknowledgement only from that authoritative outcome. No successful ack can be requested
independently of a successful post receipt.

### 5.5 NIP-09 withdrawal

Delete, edit, or tombstone carries the signed original, the same-author signed kind:5 deletion,
and the policy service's own receipt that maps that exact source event to the prior Buzz event.
The requester cannot supply or redirect the Buzz target id. The service chooses the strongest
supported withdrawal tier and records its result under the same source mapping.

## 6 · Construction and submission

The service owns these bytes and choices:

- Buzz base URL and `/events` endpoint;
- poster pubkey and fixed NIP-OA tag JSON;
- event kind, `created_at`, content, tag order, channel `h` tag, thread `e` tags, explicit `p`
  tags, and any broadcast/media tags permitted by the operation;
- deterministic serialization of the signed event body;
- NIP-98 method, exact URL, random nonce, and SHA-256 payload tag;
- retry classification, timeout budget, and authoritative response parsing.

It asks Bunker to sign the exact constructed Buzz event and verifies the returned id, author,
signature, kind, timestamp, content, and tags byte-for-byte against its template. It then constructs
and signs a fresh kind:27235 for the exact POST body. Both signatures stay inside the policy host.

Stored-event retries reuse the same signed Buzz event and create a fresh NIP-98 nonce per attempt.
Ambiguous moderation outcomes never trigger a newly authored mutation.

## 7 · Idempotency and receipts

The idempotency key is derived inside the service from:

```text
protocol version || policy instance || catalogue digest || operation ||
ordered signed source ids || policy-resolved destination
```

The durable policy journal claims this key before signing. Concurrent and restarted requests
either receive the same terminal receipt or the current in-flight status; they never author a
second Buzz event.

A terminal receipt is a signed, canonical record binding:

- request digest and idempotency key;
- policy instance, operation, and catalogue digest;
- ordered source ids;
- policy-resolved Buzz channel and submission endpoint authority;
- constructed Buzz event id;
- accepted or refused result plus bounded reason code;
- authoritative relay response digest and completion timestamp.

The receipt contains no credential, Bunker URI, auth event, raw signature oracle, or reusable
Authorization header. Bridge-side journals are operational caches only; they are never evidence
to the policy service.

## 8 · Policy state

The following state is independently deployed or derived on the policy host, never accepted as a
bridge request field:

- channel and recipient mappings;
- approver identities and watch/mute/follow state;
- NIP-OA tag bytes and Buzz endpoint;
- grantors, grants, revocations, consent terms, and freshness rules;
- per-operation and per-source rate limits;
- source-to-Buzz mappings and idempotency records;
- catalogue and verifier release digest.

State updates require their own signed control event or reviewed deployment. A host-root attacker
cannot widen policy by changing waggle's local `config.json`.

## 9 · Failure behavior

- Unavailable policy, Bunker, Buzz endpoint, or source evidence is a retryable hold, never local
  signing fallback.
- Invalid evidence or a denied transition produces a terminal signed refusal receipt.
- A timeout after submission remains ambiguous until the service queries or safely retries the
  same event id; the bridge cannot choose to author another event.
- Receipt verification failure is loud and leaves the request owed.
- Metrics and logs use request/source digests and bounded reason codes, never plaintext bodies or
  credentials.

## 10 · Migration gates

Migration is operation-family by operation-family, but completion is all-or-nothing for the claim
that the Buzz poster key is off the bridge host:

1. Implement canonical packet, verifier, policy store, Bunker signer, direct Buzz submitter,
   signed receipts, and forced-command transport.
2. For each family in §5, add positive, hostile-evidence, replay, concurrent, restart, stale-policy,
   Bunker-mismatch, ambiguous-submit, and compromised-requester tests.
3. Run local and remote paths in shadow mode; require identical derived event bytes and decisions.
4. Enable remote-only for one family. Failure must hold; it must never fall back to the local key.
5. Prove a live post and withdrawal, verify the signed receipts, then repeat for every family.
6. Remove `BUZZ_PRIVATE_KEY` and the Buzz CLI write capability from both waggle lanes.
7. Prove the bridge host cannot reach Bunker, cannot invoke any signing method, and cannot submit a
   valid Buzz write directly.
8. Drill policy-client revocation, service restart/idempotency, poster rotation, and tripwire alarm.

Until gate 6, #54 remains open and documentation must continue to say that the Buzz poster is a
local-key boundary.

## 11 · Non-goals

- A generic NIP-46 client on the waggle host.
- Returning signed events for the bridge to submit.
- Trusting the bridge's catalogue render, policy decision, timestamp, destination, or journal.
- Treating forced SSH alone as semantic authorization.
- Moving the same mutable process to another box without independent policy state and deploy
  authority.
