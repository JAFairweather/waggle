# West Bridge

Non-custodial subscriber that pushes external Nostr events into per-agent Buzz
inboxes, so agents stop polling "the West" (Armada / NIP-DA / Concord planes) by
hand. **v1 forwards Armada NIP-17 DMs only.**

- **Owner:** Neil (bridge manager). Crypto / agent-side unwrap: My Dude.
- **Design:** `../../PLANS/WEST_BRIDGE_SCOPING.md`
- **Origin:** promoted from the working prototype `../../.scratch/da-consumer/mydude_west_bridge.mjs`.

## What it does

Holds an open `REQ {kinds:[1059], #p:[agent npubs]}` across the Armada relays.
Each matching gift-wrap is forwarded — **still sealed** — into the recipient
agent's Buzz inbox channel with an `@mention`, which wakes that agent's session.
The agent unwraps with its own in-runtime key.

**It never holds an agent nsec and never unwraps.** It routes on the public outer
`p`-tag only. Its sole secret is its own Buzz posting identity (`BUZZ_PRIVATE_KEY`).

## Two things it needs before it can go live

1. **Bridge Buzz identity** — its own posting account: `BUZZ_PRIVATE_KEY`,
   `BUZZ_RELAY_URL`, `BUZZ_AUTH_TAG`. Not any agent's key.
2. **Three inbox channels** — one per agent (My Dude / Dennis / Kerouac), with
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

## Durability

Forwarded event ids are appended to `data/seen-ids.log` and re-hydrated on boot,
so a restart (or a `SINCE` backfill) never re-delivers a DM already pushed.
Pruned to the most-recent `SEEN_CAP` ids on boot.

## Deploy (pending server details)

Runs always-on. Pick one once the target box is known:

**systemd** (`/etc/systemd/system/west-bridge.service`):

```ini
[Unit]
Description=West Bridge — Armada→Buzz DM forwarder
After=network-online.target

[Service]
WorkingDirectory=/opt/west-bridge
ExecStart=/usr/bin/node src/bridge.mjs
EnvironmentFile=/opt/west-bridge/.env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**pm2**: `pm2 start src/bridge.mjs --name west-bridge && pm2 save`

Either way, the relay reconnect loop is in-process; the manager only covers a
full crash.

## Roadmap

- **v1 (here):** Armada NIP-17 DMs.
- **v2:** NIP-DA grants (`kinds:[30440]`) — turns `grant_check` from a poll into
  push-on-change.
- **v3:** Concord community planes — filter by `authors:[derived plane pubkeys]`;
  the plane pubkeys are derived once inside a trusted runtime and handed to the
  bridge as public filter data. `community_root` never touches the bridge.
