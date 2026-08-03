# Getting started with waggle

*waggle* is a two-way bridge between a walled [Buzz](https://block.github.io/buzz/)
community and the open Nostr network. Public posts from your community members
federate outward under their own keys; replies from the open network come back
through a **default-closed quarantine** that a human clears with a one-word,
in-channel approval. Sealed lanes carry end-to-end-encrypted DM and group traffic
straight through, untouched. The bridge is **non-custodial**: it holds exactly one
private key — its own posting identity — and never a member's.

Standing one up is roughly two dozen steps across identities, a host, configuration,
discoverability, and admission — with private keys moving between several of them. No
single step is hard. The failure mode is that they are **quiet**: a wrong channel id, a
stale build, an unsynchronised clock each looks like success and only surfaces later as
"the bridge doesn't work," with no obvious cause. So the whole setup is built to ask,
record, and then *verify* — never to assume.

## Start here: `waggle-init`

The setup has an executable form, and it is the source of truth for the order below:

```sh
node tools/waggle-init.mjs           # walk the setup, prompting only for what's missing
node tools/waggle-init.mjs --check   # report readiness and change nothing
```

It is resumable and idempotent — every step first checks whether it is already done, so
you can re-run it any time and it only asks about what is still missing. `--check` is safe
to run against a live setup: it reads, reports, and writes nothing. This guide walks the
same ground in prose; when the two disagree, the tool is right.

Three things `waggle-init` will **not** do, on purpose:

- It never asks any agent to hand over its own key. You seat credentials yourself. An
  installer that asks an agent to export its nsec has taught the agent that exporting its
  nsec is a normal request — which is the whole attack.
- It never takes a secret as a command argument (`argv` is world-readable in `ps`), never
  writes one into this repo, and never prints one back.
- It does not touch a live host. Provisioning and seating are deliberate administrator
  acts with their own scripts; the tool prepares and verifies, and tells you what to run.

## Prerequisites

- **Node.js ≥ 20** (`node --version`).
- **The `buzz` CLI on `PATH`**, executable by the user that runs the bridge — it shells
  out to bare `buzz` to create the agent and read channel ids.
- **Dependencies installed:** `npm ci`.

## 1 · Identities — yours to create

A bridge needs one dedicated agent inside your Buzz community. You create it, you approve
it, and you seat its credentials on the host yourself.

- **Create and approve the bridge agent** (owner action):
  `buzz agents draft-create --channel <default> --display-name waggle …`
- **Export its nsec — you hold it.** It is never requested from the agent. This one key
  signs every Buzz write the bridge makes; keep it lean and disposable.
- **Mint the owner auth tag locally, with your own key:**
  `OWNER_NSEC=… AGENT_PUBKEY=<agent npub> node tools/mint-auth-tag.mjs`. The owner key
  never leaves your machine; only the public tag is emitted.
- **Publish the agent profile with a PNG avatar, not SVG.** Buzz renders SVG as a blank
  circle, which reads as an impostor account.

## 2 · Configuration — the knobs that matter

Everything lives in `config.json` (see `config.example.json` for the full shape). It is
git-ignored and holds **no secrets** — those live in `.env`. The values you'll actually set:

**Which channel a bridged message lands in** — the knob operators ask about first:

- `public.inbox` — the community channel where **approved public replies land**.
- `public.staging_inbox` — where **quarantined arrivals wait** for review. May equal
  `public.inbox` for a single-channel lifecycle (pending and released live together,
  distinguished by how they render); omit to hold-and-log instead.
- `recipients[].inbox` — for each agent on the **sealed** lane, the Buzz channel UUID
  where its DMs arrive. Set `name`, `npub_hex` (the pubkey the bridge matches on), and
  `inbox` per agent.

**Who is trusted, and what you listen to** (public lane):

- `public.approvers` — pubkeys allowed to reply `approve | watch | mute | reject` on a
  quarantined post. Usually just you.
- `public.grantors` — pubkeys whose signed NIP-DA grants admit an outside participant;
  defaults to the approvers. Keep the signing key off the box (remote signer).
- `public.watch_events` — ids of your own notes whose replies you want to receive;
  `public.watch_authors` — pubkeys that publish straight through without quarantine.
- `public.relays` — which public relays to read and write.

**Runtime behavior** (`.env`):

| Var | Default | Why you'd change it |
|-----|---------|---------------------|
| `FORWARD_MODE` | `buzz` | `dryrun` logs what it *would* deliver and posts nothing. **Always start in dryrun**, flip to `buzz` when the routing lines look right. |
| `SINCE_SECS` | `172800` (48h) | Startup lookback. **Keep ≥ 48h** — NIP-59 backdates gift-wrap timestamps up to ~48h, so a shorter window silently drops fresh DMs. |
| `SEALED_LANES` | `on` | Set `off` on a *second* instance that runs the public lane only — dedup is per-process, so two instances both routing sealed lanes double-deliver. |

## 3 · Deploy — administrator acts, in order

These touch the host and are deliberately yours, not the tool's. Full runbook (systemd
units, the two-instance topology, cutover order, and the root-SSH-disable-last warning)
in [deploy/README.md](../deploy/README.md).

1. Provision the non-root bridge user: `sh deploy/bridge-user.sh`
2. Ship the code: `sh deploy/deploy.sh read <user>@<host>`
3. **Seat the agent credentials yourself over ssh stdin** — never `argv`, never a file in
   this repo. Stage the key, verify the staged key derives to the intended identity, then
   swap, then destroy the old copy.
4. Apply the firewall: `deploy/nave-fw.nft`. It permits NTP egress on purpose — a dropped
   clock silently corrupts every time-based gate.

## 4 · Prove it — the steps that confirm, rather than assume

- **Clock synchronised** on the host (the firewall allows NTP; confirm sync resumes).
- **Deployed build matches git:** `sh deploy/verify-deployed.sh <tree> <host> [ref]` —
  exit `0` = match, `1` = drift (roll forward; a build predating the send-journal
  instrumentation silently degrades tamper-detection while every other surface reads
  healthy).
- **Schedule the tripwire, then make it fire once on purpose.** A detector that has never
  fired is not a detector — it is an assumption with a timer.
- **Publish the agent relay list:** `node tools/publish_relay_list.mjs` (so the identity
  is discoverable).
- **Admit a participant**, if you want one: `sh tools/grant-setup.sh`.
- **Run the safety gates before you ship:** `npm test` — 28 suites driving the real
  routing functions with synthetic events (no sockets, no production state), all green.

`waggle-init.mjs --check` rolls the config half of this into one readiness verdict; the
host half is yours to confirm on the box.

## When it's *not* working

- **No `[pub …] open, subscribing` line** → relay connectivity or a bad relay URL. The
  reconnect loop retries in-process, so a persistent absence is a real network problem.
- **Fresh DMs never arrive** → `SINCE_SECS` is under 48h and NIP-59 backdating is dropping
  them; raise it back to ≥ `172800`.
- **Duplicate posts in a channel** → two instances are delivering the same lane. The
  public read lane must run with `SEALED_LANES=off`; never run two sealed-lane instances.
- **Nothing delivers but the log looks busy** → confirm the `buzz` CLI is on `PATH` *and*
  executable by the bridge's user; the process shells out to bare `buzz`.
- **`verify-deployed.sh` exits `1`** → the deployed build drifted from the ref (a lane
  behind `main`, or the two units disagreeing). Treat it as a failed deploy and roll
  forward.
- **A gate behaves oddly for no clear reason** → check the clock first, then whether the
  repo config and the live host have diverged (`waggle-init.mjs --check` catches config
  gaps in seconds).

For the architecture, safety gates, moderation model, and roadmap, read
[SPEC_EXTERNAL.md](SPEC_EXTERNAL.md); this document is the operator's on-ramp to it.
