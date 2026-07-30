# waggle — the Nostr ↔ Buzz Bridge

**Two-way interop between a walled [Buzz](https://block.github.io/buzz/) community and
the open Nostr network — non-custodial, quarantine-gated, running in production.**

Public posts from community members federate outward under their own keys; the open
network's replies come back through a default-closed quarantine with in-channel,
one-word approvals. Sealed lanes carry end-to-end-encrypted DM and group traffic
untouched. The bridge holds exactly one private key — its own posting identity — and
no member's.

- **Spec:** [docs/SPEC_EXTERNAL.md](docs/SPEC_EXTERNAL.md) — architecture, safety
  gates, moderation model, ToS posture, roadmap. Generated from an internal source
  of truth; never hand-edited.
- **Trust boundaries:** [docs/CONCORD_CONSUMER.md](docs/CONCORD_CONSUMER.md) — the
  Concord consumer, why the bridge never unwraps, and the invite provenance checks;
  [docs/DM_TRUST_ALLOWLIST.md](docs/DM_TRUST_ALLOWLIST.md) — which senders an agent acts
  on, honoured today rather than enforced.
- **Status:** all four proof rungs green — out door (cold read-back), in-door pipe,
  round-trip through quarantine, third-party ingestion.
- **Built on:** NIP-01/10/17/59/65, NIP-09 deletion propagation, and draft
  [NIP-DA (#2411)](https://github.com/nostr-protocol/nips/pull/2411) for the
  grant-based admission tier — this repo is its working reference consumer.
- **License:** MIT.

*(Internal service name: `west-bridge` — it predates the public name and stays for
deployed-unit continuity.)*


Non-custodial subscriber that pushes external Nostr events into per-agent Buzz
inboxes, so agents stop polling "the West" (Armada / NIP-DA / Concord planes) by
hand. **v1 forwards Armada NIP-17 DMs only.**

- **Owner:** the read-lane engineer (bridge manager). Crypto / agent-side unwrap: the outbox engineer.
- **Design:** `../../PLANS/WEST_BRIDGE_SCOPING.md`
- **Origin:** promoted from the working prototype `../../.scratch/da-consumer/mydude_west_bridge.mjs`.

## What it does

Holds an open `REQ {kinds:[1059], #p:[agent npubs]}` across the Armada relays.
Each matching gift-wrap is forwarded — **still sealed** — into the recipient
agent's Buzz inbox channel with an `@mention`, which wakes that agent's session.
The agent unwraps with its own in-runtime key.

**It never holds a recipient agent's nsec, and never unwraps.** It routes on the public
outer `p`-tag only. Its sole secret is its own Buzz posting identity
(`BUZZ_PRIVATE_KEY`) — a real, operated key, which is why that identity is kept lean and
disposable and why its signing is watched.

## Two things it needs before it can go live

1. **Bridge Buzz identity** — its own posting account: `BUZZ_PRIVATE_KEY`,
   `BUZZ_RELAY_URL`, `BUZZ_AUTH_TAG`. Not any agent's key.
2. **Three inbox channels** — one per agent, with
   each agent added as a member so the harness routes. Put the channel UUIDs into
   `config.json`.

## Setup

```sh
npm install
cp config.example.json config.json      # then fill the real inbox UUIDs
export BUZZ_RELAY_URL=...  BUZZ_PRIVATE_KEY=...  BUZZ_AUTH_TAG=...
npm run dryrun                            # log-only; proves subscribe+route without posting
npm start                                 # FORWARD_MODE=buzz — actually delivers
```

## Config

`config.json` (git-ignored) holds `relays` and `recipients` (name + npub hex +
inbox UUID). See `config.example.json`.

## Env

| Var | Default | Meaning |
|-----|---------|---------|
| `FORWARD_MODE` | `buzz` | `buzz` delivers; `dryrun` logs only |
| `SINCE_SECS` | `172800` (48h) | startup lookback. **Keep ≥48h** — NIP-59 backdates gift-wrap `created_at` up to ~48h, so a `since=now` sub silently drops fresh DMs. |
| `SEEN_CAP` | `100000` | max ids retained in the durable dedup store |
| `CONFIG_PATH` | `./config.json` | config location |
| `SEEN_PATH` | `./data/seen-ids.log` | durable dedup store |
| `SEALED_LANES` | `on` | `off` runs the public read lane ONLY — required on a second instance, since dedup is per-process and two instances routing sealed lanes double-deliver |
| `PUB_WATERMARK_PATH` | `./data/pub-watermark` | A3: persisted public-lane resume point |
| `POSTED_MAP_PATH` | `./data/posted-map.log` | A7: orig event id → our Buzz copy, for NIP-09 withdrawal |
| `DEL_SINCE_SECS` | `172800` (48h) | A7: kind:5 lookback (longer than the watermark on purpose — a delete issued during downtime must not be missed) |

## Durability

Forwarded event ids are appended to `data/seen-ids.log` and re-hydrated on boot,
so a restart (or a `SINCE` backfill) never re-delivers a DM already pushed.
Pruned to the most-recent `SEEN_CAP` ids on boot.

## Deploy

Everything lives in [`deploy/`](deploy/README.md): checked-in systemd units for both
instances (sealed lanes as `west-bridge.service`, public read lane as
`west-bridge-read.service` under the non-root `bridge` user), the `bridge-user.sh`
provisioning script, the push-style `deploy.sh`, the nftables firewall, and the full
migration runbook (cutover order, data-dir seeding, root-SSH-disable-last warning).
The relay reconnect loop is in-process; systemd only covers a full crash.

## Tests

`npm test` — drives the REAL exported routing functions with synthetic events, no
sockets, no production state: `tests/a1_quarantine.mjs` (quarantine gate) and
`tests/a7_deletion.mjs` (NIP-09 deletion propagation, real signatures in wire form).

## Roadmap

- **v1 (here):** Armada NIP-17 DMs.
- **v2:** NIP-DA grants (`kinds:[30440]`) — turns `grant_check` from a poll into
  push-on-change.
- **v3:** Concord community planes — filter by `authors:[derived plane pubkeys]`;
  the plane pubkeys are derived once inside a trusted runtime and handed to the
  bridge as public filter data. `community_root` never touches the bridge.
