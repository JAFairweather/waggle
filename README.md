# waggle — the Nostr ↔ Buzz bridge

[![CI](https://github.com/JAFairweather/waggle/actions/workflows/ci.yml/badge.svg)](https://github.com/JAFairweather/waggle/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Two-way interop between a walled [Buzz](https://block.github.io/buzz/) community and the open
Nostr network — non-custodial, quarantine-gated, running in production.**

A private community is valuable *because* it is walled. But the wall costs its members reach: they
cannot speak to the open network as themselves, and it cannot reach them at all. Every usual answer
gives something real away — open the community and the reason it worked is gone; mirror it through
a bot and every member's voice becomes the bot's; hand a service your keys and sovereignty is over.

waggle treats that as a **routing** problem rather than a permissions one. The wall stays up, and
the door is per-message and consensual in both directions.

You add **one dedicated agent** to your community. It carries the crossing, and everything it does
it does as that agent, in your channels, where you can watch it.

---

## What it does

| Lane | Direction | What crosses |
|---|---|---|
| **Out door** | community → open | A member opts a post outward; it publishes **under their own key**. The bridge routes, it does not author. |
| **In door** | open → community | Replies arrive in a **default-closed quarantine** and enter only when a human releases them with one word in-channel. |
| **Sealed lanes** | both | End-to-end encrypted direct and group traffic, carried by envelope and derived address — **never opened**. |
| **Return lane** | community → guest | A mention reaches an admitted outsider as a sealed DM. The community relay will not serve an external key, so the bridge is the only party that can. |

It holds **exactly one private key — its own posting identity** — and no member's. That identity is
deliberately lean and re-mintable, so a compromise costs a re-mint rather than a person's voice. A
bounded loss, not no loss, which is why detection and rotation carry the security story rather than
encryption at rest.

## Status

| | |
|---|---|
| ✅ **Out door** | a member's note federated, confirmed by cold read-back on more than one relay |
| ✅ **In door** | caught, deduplicated across relays, delivered as one channel post |
| ✅ **Round trip** | a public reply came back *through the quarantine* and was released by a human |
| ✅ **Cold-stranger walk-in** | a key minted moments earlier, with no grant and no history, held at the gate |
| ✅ **Granted participants** | signed, revocable grants admit an outside identity; revocation applies without a restart |
| ✅ **Return leg** | a mention carried out to a guest whose key cannot read the community relay |
| ✅ **Tamper detection** | proven by drill — an unjournalled post by the poster key alarms; a journalled one does not |

No claim above rests on a relay's acceptance. Cold read-back only.

## Quick start

```sh
git clone https://github.com/JAFairweather/waggle && cd waggle
npm ci
node tools/waggle-init.mjs        # guided setup — prompts only for what is missing
npm test                          # the safety gates, exercised
```

`waggle-init --check` reports readiness and changes nothing. Full walkthrough:
**[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)**.

Two things the setup will not do, deliberately: it never asks an agent for its own key — the
administrator seats credentials directly — and it never takes a secret as a command argument.

## Tools

| | |
|---|---|
| `tools/waggle-init.mjs` | guided operator setup and an honest readiness check |
| `tools/participant-init.mjs` | onboard an outside participant, and **verify the loop closes** |
| `tools/grant-setup.sh` | issue tasking grants interactively — one signer approval for the batch |
| `tools/grant.mjs` | the grant pen: issue `440`, revoke `441`, list by subject |
| `tools/approve.mjs` | release a quarantined message from the command line |
| `tools/tripwire.mjs` | out-of-process detection of signing the bridge never did |
| `tools/mint-auth-tag.mjs` | mint an owner attestation locally; the owner key never leaves your machine |
| `console/` | see who is admitted and by whose signature — `npm run console`, bound to loopback |

The console is served from your own machine on purpose. Its whole promise is *"here is exactly what
you are about to sign"*, and that promise is only worth something if you control the page making it.

For whole-feed watches, an authorized approver can also use the signed in-Buzz staging console:
`waggle mirror <npub>` adds a feed and `waggle unmirror <npub>` removes it. This is a plain
director-curated watchlist, not a grant; the watched person’s separate mirror-consent is what
authorizes ingestion when consent enforcement is enabled.

## Configuration

`config.json` (git-ignored) holds the relay set, the channels messages land in, the watch tiers, the
approvers and grantors, and the rate caps. It carries **no secrets** — those live in `.env`, mode
`0600`. Start from `config.example.json`, or let `waggle-init` fill it.

| Var | Default | Meaning |
|---|---|---|
| `FORWARD_MODE` | `buzz` | `buzz` delivers; `dryrun` logs only |
| `SEALED_LANES` | `on` | `off` runs the public read lane only — required on a second instance, since dedup is per-process |
| `SINCE_SECS` | `172800` (48h) | startup lookback. **Keep ≥48h**: NIP-59 backdates a gift-wrap's `created_at` by up to two days, so a `since=now` subscription silently drops fresh messages |
| `DEL_SINCE_SECS` | `172800` | deletion lookback — longer than the watermark on purpose, since a delete issued during downtime must not be missed |
| `SEEN_CAP` | `100000` | ids retained in the durable dedup store |

## Deploy

Everything is in **[`deploy/`](deploy/README.md)**: systemd units for both lanes
(`waggle-sealed.service`, and `waggle-read.service` under a non-root user), a provisioning script,
a push-style `deploy.sh`, an nftables ruleset, and the migration runbook.

Two habits worth taking from it. The firewall permits **NTP egress** on purpose — a dropped clock
silently corrupts every time-based gate. And `deploy/verify-deployed.sh` compares what is *running*
against what git says, because a stale build is invisible while every status surface reads healthy.

## Tests

`npm test` runs 30 suites against the **real** exported functions with synthetic events — no
sockets, no production state:

boot · suite roster · egress catalogue · egress ban · durable dedup store · relay fan-out · quarantine gating · deletion propagation · sealed-lane rate caps · grant
admission · message rendering · deployed-build verification · return lane · return-lane scan ·
return-lane no-miss · return-lane pending · relay ingress · tripwire union · tripwire detection drill · deploy runner · console Host check · undelivered record · console pending requests · in-door consent · consent-request template · consent gate · consent ask · recipient DM relays · watchlist hot-reload · signed owner control state

The rendering suite is the one to read if you are reviewing. It tests what the bridge **refuses**,
not only what it does: a hostile note tries to ping the approver, mint an `APPROVED BY` heading,
break out of its quote and open a code fence — and must come out inert *and still readable*, because
a guard the approver cannot read through is a guard that stops them approving anything.

## Documentation

- **[docs/SPEC_EXTERNAL.md](docs/SPEC_EXTERNAL.md)** — architecture, safety gates, moderation model,
  terms posture, roadmap. Generated from an internal source of truth; never hand-edited.
- **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)** — standing one up, end to end.
- **[docs/CONCORD_CONSUMER.md](docs/CONCORD_CONSUMER.md)** — the group-chat consumer and its trust
  boundary: the bridge routes by derived plane address and never unwraps; a *participant* holds the
  invite and decrypts in its own runtime.
- **[docs/DM_TRUST_ALLOWLIST.md](docs/DM_TRUST_ALLOWLIST.md)** — which senders an agent acts on, why
  listening is not obeying, and the residual cost attack that cannot be gated away.
- **[SECURITY.md](SECURITY.md)** — private reporting, what is in scope, and what is *not* a
  vulnerability.

## Built on

NIP-01 · NIP-09 deletion propagation · NIP-10 threading · NIP-17/NIP-59 sealed messages · NIP-42
relay auth · NIP-46 remote signing · NIP-65 outbox lists · NIP-OA owner attestation · Concord
CORD-01/03 for group planes · and draft
**[NIP-DA (#2411)](https://github.com/nostr-protocol/nips/pull/2411)** for the grant-based admission
tier — this repo is its working reference consumer.

## The honest limitation

An inbound note is re-posted under the bridge's identity with explicit attribution, because the
platform cannot yet render an event signed by someone outside it. That is the one change which would
make this native rather than bridged: with native foreign-signed rendering, a guest appears in a
community **as themselves**, with a signature anyone can verify, while the community keeps full
control of admission.

Everything above runs today with zero platform changes.

---

MIT. Issues and roadmap are public: <https://github.com/JAFairweather/waggle/issues>
