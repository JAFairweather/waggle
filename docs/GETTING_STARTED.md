# Getting started with waggle

*waggle* is a two-way bridge between a walled [Buzz](https://block.github.io/buzz/)
community and the open Nostr network. Public posts from your community members
federate outward under their own keys; replies from the open network come back
through a **default-closed quarantine** that a human clears with a one-word,
in-channel approval. Sealed lanes carry end-to-end-encrypted DM and group traffic
straight through, untouched. The bridge is **non-custodial with respect to members**:
it never holds a member's key. Its dedicated Buzz poster still needs a local CLI key;
its Nostr transport identity can instead sign and decrypt through a NIP-46 bunker.

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
node tools/waggle-init.mjs --state ~/.waggle/my-hive.json  # select one of several hive installations
node tools/waggle-init.mjs --state ~/.waggle/my-hive.json --receipt  # machine-readable, secret-free proof receipt
node tools/waggle-init.mjs --enable-mirror-consent  # bind watched feeds to this hive's consent
node tools/waggle-init.mjs --agent-launch            # print the safe coding-agent hand-off
```

Every normal run creates or resumes one mode-0600, secret-free state file at
`~/.waggle/install-state.json` (override with `--state`). The CLI, host bootstrap, and Console
use this same closed eight-step vocabulary. To publish only its validated public receipt to the
separately hosted Console:

```sh
node tools/install-receipt-publish.mjs \
  --state ~/.waggle/install-state.json \
  --out /path/to/console/install-receipt.json
```

Never copy the private state file into the web root. The publisher rebuilds the public projection,
rejects credential-shaped data and symlink outputs, and atomically writes a mode-0644 receipt.

It is resumable and idempotent — every step first checks whether it is already done, so
you can re-run it any time and it only asks about what is still missing. `--check` is safe
to run against a live setup: it reads, reports, and writes nothing. This guide walks the
same ground in prose; when the two disagree, the tool is right.

The first successful local pass creates a mode-0600, non-secret installation state at
`~/.waggle/install-state.json` (or the explicit `--state` path). Its stable installation id,
closed step catalogue, evidence, and safe resume actions are the shared contract for the CLI,
Console Setup, and the host bootstrap. A pass cannot turn green without evidence. Existing state
is resumed rather than regenerated; channel or owner drift becomes a visible failure instead of
silently rewriting the installation. Use one state path per hive when an owner operates several.
The owner pubkey is collected explicitly rather than inferred from the first approver: moderation
can be delegated, while hive ownership, bridge identity, and agent identities remain distinct.

Three things `waggle-init` will **not** do, on purpose:

- It never asks any agent to hand over its own key. You seat credentials yourself. An
  installer that asks an agent to export its nsec has taught the agent that exporting its
  nsec is a normal request — which is the whole attack.
- It never takes a secret as a command argument (`argv` is world-readable in `ps`), never
  writes one into this repo, and never prints one back.
- This local phase does not touch a live host. The host bootstrap consumes this same manifest
  through one authenticated, idempotent operation; identity import, Bunker pairing, and grant
  approval remain explicit human checkpoints rather than hidden automation.

### Hives, consent, and coding agents

Run `--enable-mirror-consent` when this hive is ready to invite public authors. The wizard
records the stable Concord `community_id`, human-readable hive name and handle, terms URL,
and consent signing page. Those fields—not a chat-channel UUID and not the owner's key—define
the scope an author consents to. Existing watched authors must be explicitly grandfathered or
they will be held until they consent.

Run `--agent-launch` to print the burner hand-off for a short-lived coding agent. It mints its own
ephemeral key, publishes kind:0 + kind:10002 + kind:10050, asks for scoped admission, verifies a
sealed receipt, and burns its key on exit. That is different from a persistent first-class agent:
Codex or Claude needs one isolated Nvoy identity runtime, an identity-specific MCP attachment, a
model-specific session binder, and Bunker-backed reply signing. See
[First-class agent architecture](AGENT_PARTICIPANT_ARCHITECTURE.md). Nvoy is optional only for
the public mirror-and-consent burner path; it is part of the persistent agent channel design.

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

For the Nostr transport identity, prefer a remote signer: seat a mode-0600
`WAGGLE_BUNKER_URI_FILE` and its mode-0600 `WAGGLE_NIP46_CLIENT_NSEC_FILE`. The second file is
only the revocable NIP-46 connection key, not the identity nsec. Both must be regular files,
never symlinks. Local-key mode remains available for development and migration; do not confuse
it with the still-local `BUZZ_PRIVATE_KEY` used by the Buzz CLI.

## 2 · Configuration — the knobs that matter

Everything lives in `config.json` (see `config.example.json` for the full shape). It is
git-ignored and holds **no secrets** — those live in `.env`. Keep a reviewed, mode-0600 routing
snapshot in an **owner-controlled private Git repository**; the public waggle repo deliberately
does not contain your channels or roster. On the host, export it after a known-good change:

```
node deploy/routing-policy.mjs export --config /opt/waggle-read/config.json --out ~/waggle-policy/read.json
node deploy/routing-policy.mjs check  --config /opt/waggle-read/config.json --policy ~/waggle-policy/read.json
```

The check reports a signed console change as drift rather than overwriting it. Review that change,
export a new snapshot, commit it privately, and use `apply --confirm` only while deliberately
restoring a host. Never put `.env`, a bunker URI, or any private key in that policy repository.
The values you'll actually set:

**Which channel a bridged message lands in** — the knob operators ask about first:

- `public.inbox` — the community channel where **approved public replies land**.
- `public.staging_inbox` — where **quarantined arrivals wait** for review. May equal
  `public.inbox` for a single-channel lifecycle (pending and released live together,
  distinguished by how they render); omit to hold-and-log instead.
- `recipients[].inbox` — for each agent on the **sealed** lane, the Buzz channel UUID
  where its DMs arrive. Set `name`, `npub_hex` (the pubkey the bridge matches on), and
  `inbox` per agent.

**Who is trusted, and what you listen to** (public lane):

- `public.approvers` — pubkeys allowed to reply `approve | follow | watch | mute | reject` on a
  quarantined post. Usually just you.
- `public.grantors` — pubkeys whose signed NIP-DA grants admit an outside participant;
  defaults to the approvers. Keep the signing key off the box (remote signer).
- `public.watch_events` — ids of your own notes whose replies you want to receive;
  `public.watch_authors` — pubkeys that publish straight through without quarantine.
- `public.relays` — which public relays to read and write.

**Managing whole-feed watches without SSH.** In the signed staging console, an approver can post
`waggle mirror <npub>` to add a public feed, or `waggle unmirror <npub>` to remove it. This is
deliberately not `watch`: that existing reply command means a narrower *follow* (trust replies to
our own note), while `mirror` subscribes to an author's whole feed. A watch only chooses what the
community wants to hear; with consent enforcement enabled, the author still has to issue their own
mirror-consent before anything crosses.

**Moderating quarantine without SSH.** Load the bridge on the Console's **Routing** tab, paste the
public source event id from a quarantined card, and choose **Approve once**, **Follow author**, or
**Mute author**. The browser uses the persisted Access-tab signer to publish one exact
bridge-addressed command; the bridge verifies the approver, freshness, signature, target and replay
watermark before changing policy. The equivalent in-channel verbs use the same mutation path.
Reject remains private and in-channel because it creates no standing policy worth publishing.

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
- **Run the safety gates before you ship:** `npm test` — 78 suites driving the real
  routing functions with synthetic events (no sockets, no production state), all green.

`waggle-init.mjs --check` rolls the config half of this into one readiness verdict; the
host half is yours to confirm on the box.

### Participant and agent authority

Admission and instruction authority are separate grants. An `admit` grant lets an outside
identity use the bridge lane. A `task` or `task+act` grant lets that identity's own authenticated
message instruct a particular agent runtime. A working-channel carrier additionally needs its
own `task-relay` grant; that makes it transport, never the original author. Missing, stale,
revoked, or unverifiable authority fails closed to data-only delivery. Quoted or forwarded
third-party text stays data even when the surrounding message is authorised.

Do not hand-edit `scan_channels`, `scan_authors`, or `return_lane` to connect a desktop agent.
After admitting the participant, open **Console → Config → Agent channel route**. Enter the Buzz
channel UUID, the agent npub, the authorized sender, and its mention handle. The browser signs and
NIP-44 encrypts a closed `waggle-task-route` command to the bridge inside an ephemeral NIP-59 gift
wrap; relays never see that private route tuple. The bridge verifies the owner and admission,
persists it under `public.task_routes`, and starts the scanner without a restart. Removing the same
exact route is also owner-signed and encrypted. One identity may hold several routes, while every
route remains bound to its own source channel and original signer.

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
