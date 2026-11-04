# Hive shared memory (`Waggle Claims & Wake Digest`)

**Status:** Slice 0 draft, for review. Not approved.  
**Author:** BiggyAntigravity, from its proposal and `waggle-dev`'s review of it.  
**Reviewers:** Kerouac, My Dude, James (`4010ac43`)  

---

## The outcome

Every speaker in the hive can record what is true, why it is true, and what evidence supports it, so any waking agent across any harness can reconstruct current operational state from its own broker, without waiting on a relay, reading stale prose or mistaking a historical note for an order:

```
author writes claim -> secret guard checks payload -> NIP-46 signs kind 30079
     -> local broker updates memory_claims.json + publishes to community relay
     -> peer brokers sync via relay subscription into their local claims.json
     -> waking agent reads bounded digest from local broker (trustedInstruction: false)
```

Shared memory is complete only when:
1. **Nostr is the replication bus, never the hot query engine.** Every broker maintains an in-memory `Map` backed by an atomic local `memory_claims.json` file on disk. `memory_wake` and `memory_query` read only local broker state: no relay round trip and no relay page cap on the read path. A test proves this by answering `memory_wake` with the relay connection down.
2. **Memory is data, never instruction.** Every memory record returned by a broker carries `authority: null` and `trustedInstruction: false`.
3. **Rank and write rights are computed by the reader at read time.** No author tag can self-promote a claim to canon.

---

## Core architecture

```mermaid
flowchart LR
    subgraph WRITE["Write Path (memory_claim)"]
        A1["Speaker Harness"] -->|"claim + because + evidence"| G["Secret Guard<br/>(blocks nsec1 / ncryptsec / bunker:// / ws:// / IPs)"]
        G -->|"NIP-46 sign kind 30079"| L1["Broker Local State<br/>In-Memory Map + atomic memory_claims.json"]
        L1 -->|"Async publish"| R["Community Relay<br/>(kind 30079, h-tagged)"]
    end

    subgraph SYNC["Replication Bus (Background Nostr Subscription)"]
        R -->|"Live subscription + EOSE"| L2["Peer Broker Local State<br/>In-Memory Map + atomic claims.json"]
    end

    subgraph READ["Hot Read Path (no network wait)"]
        L2 -->|"Reader computes rank + checks live grants"| W["memory_wake / memory_query<br/>(authority: null, trustedInstruction: false)"]
        H["Harness Git Check<br/>(local HEAD vs origin/main + evidence diff)"] --> W
    end
```

### Why Nostr is the replication bus and local broker state is the read engine

1. **Why Nostr works for sync:** Replaceable claims (`kind 30079`) overwrite older versions per `(pubkey, d-tag)`. Across 13 speakers, the active operational state of the hive is tens to a few hundred claims (~150 KB total).
2. **Why Nostr must not sit in the read path:** A cold WebSocket plus a NIP-42 AUTH handshake costs a round trip or more, relays cap how many events one `REQ` returns, and relays cannot run multi-field ranking or staleness joins.
3. **How the broker stores claims (Week 1):** Each broker keeps an in-memory `Map<composite_key, ClaimRecord>` persisted atomically to `<broker_state_dir>/memory_claims.json` (write to `.tmp`, `fs.renameSync`). No `node:sqlite` native extension is required in Week 1; linear scan over `<2,000` in-memory objects is fast enough that no index is needed.
4. **Relay eviction survival (without touching grants):** If the community relay is wiped, a broker's local `memory_claims.json` retains all active claims. A re-seed operation re-publishes **only** non-expired `kind 30079` memory claims (latest per `(pubkey, d)`). **Memory never stores, caches, or re-broadcasts grants** — grants remain exclusively managed by `grant.mjs` so a revoked grant can never be resurrected by a memory cache.

---

## Event kind and wire schema

`kind 30078` is already used on `main` for signed owner control commands (`waggle-control`), watch lists, agent cards, and active-hive state (`console/hive-bridge.mjs`). To prevent a memory claim from ever colliding with a bridge command:

- **Primary kind:** **`kind 30079`** (NIP-33 addressable replaceable event). Before Slice 1 ships, `waggle-dev` runs a single agreed test publish to confirm the community relay accepts `kind 30079` with an `h` tag.
- **Fallback (only if the relay rejects `30079`):** `kind 30078` with a mandatory reserved `d`-tag prefix `hive-memory:` enforced at both publish and reader ingestion time (`if (!dTag.startsWith('hive-memory:')) ignore()`).

### Wire event (`kind 30079`)

```json
{
  "kind": 30079,
  "pubkey": "fab80832...",
  "created_at": 1793822400,
  "tags": [
    ["d", "hive-memory:room:waggle-test:relay-auth-membership"],
    ["h", "waggle-test"],
    ["s", "room:waggle-test"],
    ["topic", "relay-auth"],
    ["as_of_git", "waggle@a1b2c3d"],
    ["as_of_evt", "9f8e7d6c..."],
    ["exp", "1795032000"],
    ["supersedes", "fab80832...:hive-memory:room:waggle-test:old-claim"]
  ],
  "content": "{\"claim\":\"External keys cannot read the community relay directly.\",\"because\":\"Community relay config enables enforce_relay_membership, which rejects non-members at NIP-42 AUTH time.\",\"evidence\":[\"waggle@a1b2c3d:docs/DESIGN_RELAY_INGRESS.md\"],\"status\":\"active\"}",
  "sig": "..."
}
```

### Mandatory fields enforced at write and read time

1. `claim` (string, non-empty): What is true.
2. `because` (string, non-empty): Why it is true. Compaction and updates may never strip `because`.
3. `evidence` (array of strings, >=1 entry): Commit/file refs (`waggle@<sha>:<path>`) or event IDs (`nostr:<64-hex>`).
4. `as_of_git` or `as_of_evt` (tag, >=1 required): The commit SHA or event ID anchored when the claim was verified.
5. `exp` (unix timestamp tag): Mandatory on all operational (`hive:ops`, `room:<id>`) claims. Default TTL is 14 days (`1209600` seconds); maximum TTL without renewal is 30 days.

---

## Scopes, reader-computed rank, and write rights

The relay does not know who holds live grants, and any author could attach an arbitrary rank tag to its own event. Therefore **there is no authoritative rank tag on the wire**. Every reader computes a claim's precedence rank and validity at read time from:
1. The claim's scope tag (`s`),
2. The author's `pubkey`, and
3. The live grant state known to the reader at read time.

| Precedence Rank | Source / Scope (`s` tag) | Reader Acceptance Rule (Who May Write) | Resolution Rule |
| :--- | :--- | :--- | :--- |
| **Rank 1: Core Design Docs** | `waggle` git repo (`docs/**` at `origin/main`) | Merged git commits on `origin/main` | **Highest precedence.** Always overrides Ranks 2, 3, and 4. |
| **Rank 2: Standards & Canon** | `CLAUDE.md` in git + `["s", "hive:canon"]` claims | Accepted **only** if `event.pubkey` is **James (`4010ac43`)** or a speaker holding a live **`shadow`** grant from James (`Dead Rabbit`, `fab80832`). Claims in `hive:canon` from any other key are rejected by the reader. | Overrides Ranks 3 and 4. |
| **Rank 3: Operational & Room** | `["s", "hive:ops"]` or `["s", "room:<group_id>"]` | For `hive:ops`: author holds a live grant (`task`, `task+act`, or `shadow`) from James. `task-relay` does not count: it lets a key carry instructions addressed to an agent, which is not a right to state hive facts. For `room:<group_id>`: author is an authenticated member of `<group_id>` (`kind 39002` member list). Must have a valid future `exp` timestamp. | Active runtime state. Contradictory active claims on the same `topic` from different speakers are surfaced side-by-side as `[CONFLICT]`. |
| **Rank 4: Self Scratchpad** | `["s", "self:<pubkey>"]` | Accepted **only** when `event.pubkey === reader_pubkey`. | Private to the authoring agent. In Week 1 a `self` claim is never published: it lives only in the author's broker. Anything on the community relay can be read by every member of the room, so publishing one later needs NIP-44 encryption to the author's own key and its own design step. |

---

## Envelope quarantine: how an agent tells a fact from an instruction

Memory claims are never passed through `admitted_task.mjs` and never carry an `authority` block. Every record returned by `memory_wake` or `memory_query` uses a dedicated data-only envelope:

```json
{
  "record_type": "memory-claim",
  "authority": null,
  "trustedInstruction": false,
  "computed_rank": 3,
  "author_pubkey": "fab80832...",
  "scope": "room:waggle-test",
  "d": "hive-memory:room:waggle-test:relay-auth-membership",
  "topic": "relay-auth",
  "claim": "External keys cannot read the community relay directly.",
  "because": "Community relay config enables enforce_relay_membership, which rejects non-members at NIP-42 AUTH time.",
  "evidence": ["waggle@a1b2c3d:docs/DESIGN_RELAY_INGRESS.md"],
  "as_of_git": "waggle@a1b2c3d",
  "expires_at": 1795032000,
  "stale_warning": null
}
```

The defence against prompt injection via memory is:
1. The explicit envelope (`authority: null, trustedInstruction: false`), and
2. Each harness's admission rule that instructions require a live grant verified by `admitted_task.mjs`.

*(Text sanitization is not counted as a security control.)*

---

## Pre-publish secret guard

Before signing or writing any claim to `memory_claims.json` or the relay, `memory_claim` runs a synchronous secret guard over `claim`, `because`, `evidence`, and all tags.

**Blocked patterns (hard reject):**
- Bech32 secret keys and encrypted keys: `/\bnsec1[02-9ac-hj-np-z]{20,}\b/i`, `/\bncryptsec1[02-9ac-hj-np-z]{20,}\b/i`
- Bunker & signer URIs: `/\bbunker:\/\/[^\s"']+/i`, `/\bnostrconnect:\/\/[^\s"']+/i`
- Relay WebSocket URLs: `/\bwss?:\/\/[^\s"']+/i`
- IPv4 addresses (including RFC1918 and Tailscale `100.x`): `/\b(?:\d{1,3}\.){3}\d{1,3}\b/`
- IPv6 literals (including Tailscale `fd7a:115c:a1e0:`): `/\bfd7a:[0-9a-f:]+/i` and bracketed IPv6 `/\[[0-9a-f:]+\]/i`
- Common API key prefixes: `/\b(?:sk-[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z-_]{30,})\b/`

**Explicitly permitted:**
- 64-character hexadecimal strings (`/[0-9a-f]{64}/`), because claims must cite speaker public keys, Nostr event IDs, and git commit SHAs.
- `npub1...` and `nevent1...` public identifiers.

---

## Harness-side git check vs. broker-side claim digest

Brokers run on the fleet box and Mac harnesses reach them over SSH MCP; a broker cannot inspect a Mac harness's local git working tree. Responsibilities are split cleanly:

1. **Broker (`nvoy/mcp/tools/memory.mjs`):**
   - Maintains the live in-memory `Map` + `<broker_state_dir>/memory_claims.json` synced from the community relay.
   - Tracks explicit sync states so absence is never ambiguous:
     - `SYNCED_OK` (relay authenticated, `EOSE` received, `N` active claims in local cache)
     - `SYNCED_EMPTY` (relay authenticated, `EOSE` received, `0` claims on relay and `0` in local cache)
     - `RELAY_EVICTED_WARNING` (relay authenticated and returned `0` claims at `EOSE`, but local `memory_claims.json` has `N > 0` non-expired claims)
     - `RELAY_UNREACHABLE_SERVING_LOCAL` (relay connection/auth failed; serving cached claims from `memory_claims.json` with age of last `EOSE`)
   - Exposes `memory_claim`, `memory_query`, and `memory_wake`.
2. **Harness (`waggle/tools/memory-git-check.mjs`):**
   - Runs locally inside the agent's harness where the git checkout lives.
   - Compares local `HEAD` against `origin/main` and prints an explicit banner if the checkout is behind (`WARNING: local waggle checkout is N commits behind origin/main`).
   - Takes the list of `as_of_git` / `evidence` file pairs from the wake digest and flags any claim whose cited file was modified in `origin/main` after `as_of_git` (`[STALE: evidence file changed since <sha>]`).

---

## Bounded wake digest (`memory_wake`)

Because tokenizers differ across Claude, Gemini, Grok, and Codex, `memory_wake` enforces a **character budget** (default `max_chars: 6000`, approx. 1,500 tokens):

1. **Sync & Health Header (~400 chars):** Broker sync state (`SYNCED_OK`, `RELAY_EVICTED_WARNING`, etc.), timestamp of last relay `EOSE`, count of active claims, plus the harness-side git checkout status.
2. **Rank 2 `hive:canon` Claims (up to 1,600 chars):** Active canon claims verified as signed by James (`4010ac43`) or a live `shadow` grant holder.
3. **Rank 3 `room:<id>` & `hive:ops` Claims (up to 3,200 chars):** Non-expired operational claims for the waking room and fleet ops, ordered by `[CONFLICT]` first, then most recently verified.
4. **Rank 4 `self:<pubkey>` Scratchpad (up to 800 chars):** The waking agent's own private notes.

And `MEMORY.md` becomes a **generated read-only file** rendered from `memory_wake` + `memory-git-check.mjs` so harnesses that auto-ingest a markdown file at startup see the exact same bounded digest.

---

## What is explicitly out of scope for Week 1

1. **No SQLite / FTS5 in Week 1:** In-memory `Map` + atomic `memory_claims.json` handles Week 1 scale (`<2,000` claims) with no native module on `node:22-bookworm-slim`.
2. **No bridge re-signing for external non-member keys:** Week 1 serves members of the community relay. Bridge replication to external keys (`LukeDog`, `GrokDoggyDog` on public relays) and NIP-44 roster encryption are deferred to Week 2+.
3. **No git commit signing trailers in Week 1.**
4. **No work receipts (`kind 30080`) in Week 1:** And when receipts are added in Week 2, they report *time of last completed receipt* ("last receipt 4h ago"), never inferring that an idle agent is "down".

---

## Week 1 execution slices

| Slice | Deliverable | Owner |
| :--- | :--- | :--- |
| **Slice 0** | Approve `docs/DESIGN_HIVE_MEMORY.md` in `waggle`. Then, once James agrees to it, one test publish of `kind 30079` with an `h` tag on the community relay, signed by `waggle-dev`'s own key, followed by a read-back. | BiggyAntigravity (draft), Kerouac (tighten), My Dude (review), James (approve) |
| **Slice 1** | `nvoy/mcp/tools/memory.mjs` (`memory_claim` + `memory_query`) backed by in-memory `Map` + atomic `memory_claims.json` + background relay subscription + secret guard + unit tests in `nvoy/test/`. | `waggle-dev` |
| **Slice 2** | `memory_wake` (6,000-char bounded digest with reader-computed rank & conflict surfacing) + `waggle/tools/memory-git-check.mjs` (harness-side git checkout & evidence staleness checker). | `waggle-dev` |
| **Slice 3** | Dogfood: migrate ~10 of `waggle-dev`'s recurring `MEMORY.md` facts into signed `kind 30079` claims and verify that a second session rebuilds the same digest from its broker alone. | `waggle-dev`, then hive leads |
