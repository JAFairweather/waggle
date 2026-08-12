# Design — the remote-agent lifecycle plane

> **Status: design only. Nothing described here is built.** It stacks on PR #307 (open, unmerged).
> Step 3 of the build order — the challenge gate — is in PR #311 (open). Everything else is a
> proposal, and the section below on the actuator is an untested one.

waggle/console **should be** where a remote agent is created, granted, tuned, audited and retired.
This document argues that is possible without inventing a transport, a vocabulary or a CLI role.

Scope note: #305 installs **an owner, once**. This installs **an agent, repeatedly**, and keeps
managing it for the rest of its life. They share machinery; they are not the same journey.

---

## The outcome

An owner opens the console, adds a remote agent, and — without pasting JSON, editing a unit file,
or being told to go read a runbook — ends with an agent that is admitted, wakeable, scoped, and
visibly proven so. Later, the same surface is where they tune what that agent is allowed to see,
watch what it actually did, and take its authority away.

The agent's private key **must never be** in the browser, on the waggle host, or in this
repository.

---

## Two planes are already designed. Lifecycle is a catalogue on them, not a third plane.

**The projection plane (read).** #307 *proposes* it — open and unmerged: mode-0600 private state holding no
credentials → a validated, secret-free public receipt → the browser renders the receipt and
nothing else. The browser has no access to private installer state and no write access to
`config.json`.

**The actuator plane (write).** Two distinct mechanisms exist, and an earlier draft of this
document merged them. They are not the same lane, and the difference decides where lifecycle goes:

- **The approver-signed control-command lane** (`handleWatchlistControlCommand` in `src/bridge.mjs`,
  kind `CONTROL_COMMAND_KIND` filtered on `authors: PUB.approvers` and a `d` tag). This is what
  moves a watchlist entry today. Its input is the **owner's intent**, signed.
- **The off-box policy service** (`src/buzz_policy_*`) — a forced-command runner over stdin whose
  input is **canonical third-party evidence**, decided by a credential-free core.

The policy service has the stronger properties, and they were hard-won rather than incidental:

- a **closed catalogue** — `BUZZ_POLICY_OPERATIONS` is frozen; a caller *names* an operation, and
  cannot supply rendered prose or choose a destination;
- **evidence, not instructions** — the untrusted side contributes canonical signed evidence, and a
  credential-free core decides independently;
- a **forced-command runner** — deployment fixes the executable and config path; stdin is the only
  caller-controlled input;
- **journal idempotency** — `O_EXCL` claim, atomic rename completion, terminal across processes;
- **hold, never fall back** — an unavailable policy service is a queue that waits. There is
  deliberately no dead-letter limit, because "the service was down" must never become permission to
  sign with a lesser key.

But the property that makes the policy service strong is the one that does **not** transfer.
`agent_pause` has no third-party signed evidence behind it; the owner's intent *is* the input. That
is instructions, which is precisely what the policy core exists to refuse — and its catalogue is
frozen at two operations (`quarantine_header`, `standing_trusted_reply`), both of which are Buzz
*rendering* rather than configuration.

So the proposal is: agent lifecycle **could be** one more closed catalogue, and the
**control-command lane is the likelier home**, with per-agent rows in the projection. The console
signs; the bridge verifies against `public.approvers`, dedups by id, applies one allowed change, and
acknowledges in signed state — the shape that already moves a watchlist entry. Whether the off-box
policy actuator has any role here is **open**, and is the first thing a reviewer should attack.

PR #307 states the governing constraint plainly — *no second setup vocabulary is introduced* — and
this design is bound by it either way.

That is the answer to "do we need a CLI role": for the **operations**, no.

---

## Where the CLI genuinely survives

The CLI is not retained for symmetry or preference. It survives at exactly two boundaries, and
both are forced:

1. **A secret generated locally.** A key minted in a browser tab exists in a JS heap the console
   cannot prove it discarded, in a page whose origin already needed a `Host`-header defence against
   DNS rebinding (#145). Generation happens in the CLI; only the npub and a Bunker URI cross over.
2. **Anything that must touch the host** — filesystem, systemd, firewall. Already #305's territory.

Everything else — grant, bind, tune, pause, audit, revoke — is console-signed. `agent_destroy_unit`
straddles the line and is called out in the catalogue below: the *intent* is console-signed, the
*execution* removes a runtime and its namespace and so belongs to boundary 2.

---

## Three doors, one gate

The three key-provenance flows differ *only* in where the secret is born. They converge on a single
acceptance test.

| Flow | Where the nsec is born | What waggle receives |
|---|---|---|
| **Mint** (the simple option) | in `bunker.nave.pub`, in custody | a Bunker URI + revocable NIP-46 client key |
| **BYOK** | already yours, already in a signer | a Bunker URI + revocable client key |
| **Make your own** (guided CLI prompts) | on the owner's own machine, in the CLI | an npub, then a Bunker URI once paired |

**Where the connection credential lives — and why it does not dent the one-key claim.** A NIP-46
client key *is* a private key, and a Bunker URI embeds a pairing secret. So "waggle receives a
Bunker URI + revocable client key" has to say *which* waggle. It is not the bridge and not the
console: those credentials seat directly into the **agent's own runtime unit**, across the CLI /
#305 boundary, and never transit console or bridge state. An agent row in the projection holds a
**reference** to that unit's credential, never the credential. The bridge still holds exactly one
private key — its own — and each agent runtime holds only its own revocable connection.

**Mint must mint into the signer, never onto the box.** waggle holds exactly one private key — its
own. An agent nsec written to the waggle host would give it a second, and would break the single
claim this project protects hardest. Minting into custody keeps the invariant intact, which is why
"mint for simplicity" remains available rather than being traded away.

**The one gate: challenge-sign a fresh nonce.** The console never accepts a pasted npub as proof of
control, and never accepts possession of a Bunker URI as proof either — a URI can be stale,
revoked, or already spent. The agent proves control by signing a nonce the console generated this
session. Same test for all three doors; provenance changes the setup, never the standard.

---

## Traps this plane must treat as first-class

Each of these has produced a wrong green somewhere in this project's history.

- **Possessing a Bunker URI ≠ control.** Only a fresh challenge-sign shows it.
- **The NIP-46 pairing secret is effectively single-use.** A spent one presents as
  `Unknown client` — which reads like a misconfiguration and is actually a *used* credential. Name
  it in the UI, or the owner will re-paste and re-fail.
- **Empty ≠ absent.** A grant list that renders empty because the query failed looks identical to
  one that is genuinely empty. Run the negative control *inside* the wizard: query a subject known
  to have nothing, confirm it says so, and only then trust the real query. If state cannot be
  verified, render `unavailable` — never a plausible empty list.
- **Reachable ≠ attached.** A broker answering `NVOY_NOT_DELIVERED` proves the broker is reachable
  and proves nothing about attachment.
- **Admitted ≠ wakeable.** `admit`, `task` and `task-relay` are separate authorities on purpose. An
  `admit` grant alone cannot wake an agent, and an agent that looks admitted but never answers is
  the predictable result of showing one and implying the others.
- **Write ≠ read.** A granted participant posts in as a first-class member. What comes back is the
  return lane — **mentions only** — because the community relay will not serve an external key. The
  console must not draw a symmetrical arrow.

### Resumable state vs. re-derived truth

These are not in tension, but the boundary has to be explicit or the wizard will lie after a
reboot. #307 stores *evidence-bound* transitions, which is the right primitive. The rule:

> Saved state may record **that** a proof passed and **what evidence** proved it. It may never be
> the authority for a **live** property.

Grant active, bunker responsive, unit running, relay serving — all re-derived on view, every time.
A saved `passed` renders as *"passed at T, on this evidence"*, never as *"is currently true"*. #308
is the live instance and is still **open**: it exists because "implemented", "deployed", "attached"
and "live-proven" had been collapsed into a single saved "pending" more than once.

---

## The lifecycle catalogue

Closed, named, signed by an approver, executed by the bridge, acknowledged in signed state:

| Operation | Effect | Reversible |
|---|---|---|
| `agent_register` | bind an npub + Bunker reference to an agent row | yes |
| `agent_bind_runtime` | associate one isolated runtime/MCP namespace | yes |
| `agent_set_visibility` | tune what the return lane carries out to this agent | yes |
| `agent_set_relay_policy` | per-agent relay/rebroadcast configuration | yes |
| `agent_pause` / `agent_resume` | stop delivery without touching custody | yes |
| `agent_revoke` | withdraw **bridge-side admission**, which the bridge issued and can revoke | yes — re-grant |
| `agent_destroy_unit` | destroy the deployed unit — **host-touching: console-signed intent, CLI/#305 execution** | **no** |

**`agent_revoke` withdraws only what the bridge itself granted.** A grantor-signed data grant is
not the bridge's to withdraw — only its issuer can relinquish or revoke it. The console must
therefore show admission and data grants as separate rows with separate remedies, or an owner will
press revoke, watch the admission drop, and reasonably conclude the agent has lost an access it
still holds.

**Retire is two operations, not one, because they have opposite reversibility.** Revoking authority
is instant, safe, and console-signed: the agent stops being able to act, and nothing is lost.
Destroying the unit is irreversible — `broker_credentials` is `reRenderable: false` (nvoy #160, and
the re-pair cost rests on the spent pairing secret), so it forces a
Bunker re-pair — and must carry an explicit confirmation token in the signed command rather than
being a button next to `pause`. The console should make revoke the obvious action and destroy the
deliberate one.

---

## What the console must never gain

- write access to `config.json` (the actuator exists precisely so it does not need it);
- any private key, of any agent, at any point, including transiently;
- the ability to name a destination or supply rendered prose to the bridge;
- a signed-state summary containing channel UUIDs, host addresses, credentials, message content,
  consent-record ids, or grant detail. Publication stays off by default
  (`public.control_state_publish: false`).

---

## Build order

This stacks on PR #307 and must not be built before it lands — a stacked branch whose base is
squash-merged gets orphaned, and today one was auto-**closed** that way.

1. Extend the projection with per-agent rows and their re-derived live checks (read-only; ships
   value alone, since an owner can then *see* agents before managing any).
2. Add the lifecycle catalogue to the actuator, verify-and-journal path first, with negative
   controls asserting **both** directions — that a non-approver signature is refused *and* that a
   legitimate approver still gets through. A guard asserted only to reject cannot be told apart
   from one that rejects everything; that exact gap shipped a silent outage on 2026-08-01.
3. Challenge-sign verification, shared by all three provenance doors — **in PR #311 (open)**.
4. The three doors in the console, with the CLI hand-off for make-your-own.
5. Revoke, then destroy behind its confirmation token.

Steps 1 and 2 are independently useful and independently reviewable, which is the point of the
split.

---

## Close condition

An owner adds a remote agent through the console, using any of the three key flows, and reaches a
state where every claim on screen is backed by a live re-derived check or is explicitly marked
unproven. They can later change what that agent sees, and revoke it, without a terminal. The one
manual step that remains is the Bunker approval, because a person must approve custody — and the
guided CLI prompts for make-your-own, because a locally generated secret must not pass through a
browser.
