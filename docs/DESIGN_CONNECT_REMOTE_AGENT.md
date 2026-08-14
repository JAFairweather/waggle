# Connect Remote Agent — gaps, provenance, and design

**Status: partly built, none of it deployed.** Issue #309 asks for an agent deployment wizard. This
document is the evidence and the design behind it, written immediately after onboarding one agent
entirely by hand — and then the first slice of the build.

| | |
|---|---|
| `console/capability-vocabulary.mjs` | **built** — directional sentences; the inverted task label is gone |
| `console/connect-plan.mjs` | **built** — intent → correctly-directed grants; the operator never picks a grantee |
| `console/connect.html` | **built** — the owner's flow, with direction drawn as an arrow |
| `src/agent_install_state.mjs` | **built** — four-state reporting: present / unverified / missing / unknown |
| `tools/connect-agent.mjs` | **built** — the machine-side half, idempotent, never overwrites |
| NIP-05 registration | **not built** — the directory is not this repo's to write |
| kind 0 publication | **built (#459), never run** — still the critical path; see below |

**The `kind:0` row is the whole remaining gap (#344), and its owner changed.** Buzz resolves an
at-word against a `users` row's `display_name`, which only `handle_kind0_profile` writes, keyed on
`event.pubkey` — and `event.rs` rejects any event whose pubkey differs from the authenticated
identity, so **waggle cannot publish it on the agent's behalf**. The agent's own key must, on that
relay, and the community relay refuses to authenticate an outside key at NIP-42 time
(`enforce_relay_membership`, ahead of channel membership, on both the websocket and HTTP paths).
Proven with a live 2×2, not read off the source. None of that has changed.

What changed is that there is now a tool. Until #459 every publisher here took `--key <path>` and
signed locally, so a Bunker-held identity — which is the design (#141) — had no route to the one
event that names it. `tools/publish_profile.mjs` signs through the Bunker and pushes to both sides
of the wall.

So this row is **no longer a build task and not yet an infrastructure ask**: it is a deploy and a
single operator run, needing `BUZZ_RELAY_URL`, an auth tag, and the *path* to a seated pairing.
State it that way. Reading this row as "not built" invites someone to build it a second time, which
has happened here before.

Three suites cover the new code — `capability_vocabulary`, `connect_plan`, `agent_install_state` —
each with a negative control that fires. **None of it has run in production**, and a green suite is
not a live proof.

The short version: **an agent is not one artifact, it is sixteen**, spread across two machines,
three checkouts and a public relay network. Four of the sixteen still have no tool, and all four are
meant not to. Every omission fails the same way — silently, with the agent appearing to work. That
is the problem to solve, and convenience is not the reason to solve it.

---

## Part I — What an agent actually is

Onboarding one agent produced this inventory. "Creates it" means *a tool exists whose job is to
produce this artifact*; a documented instruction to type something by hand is not a tool.

| # | Artifact | Where it lives | What creates it today |
|---|---|---|---|
| 1 | Identity keypair | the Bunker | `tools/mint-identity.mjs` ✅ (added #325) |
| 2 | `bunker://` pairing URI | `credentials/bunker-uri` | operator copies from the Bunker UI by hand |
| 3 | NIP-46 client transport key | `credentials/bunker-client` | **nothing** — hand-minted, undocumented until #326 |
| 4 | Per-method Bunker permissions | the Bunker | operator clicks four toggles; denials are silent |
| 5 | NIP-05 name | `nave.pub/.well-known/nostr.json` | **nothing** in this repo |
| 6 | kind 0 profile | public relays **and** the community relay | `tools/publish_profile.mjs` ✅ (added #459) — **built, never run**; see below |
| 7 | Join request → approval | kinds 27493 / 27492 | `tools/` ✅, but see §II.4 |
| 8 | `admit` grant (kind 440) | public relays | `tools/grant.mjs` ✅ |
| 9 | `task` grant (kind 440) | public relays | `tools/grant.mjs` ✅, **with an inverted UI label** (§III.1) |
| 10 | Runtime manifest `instances/<id>.json` | agent root | `tools/connect-agent.mjs` ✅ — writes with `wx`, so it never overwrites one |
| 11 | Runtime state directories | agent root | `tools/connect-agent.mjs` ✅ — each with its own mode |
| 12 | MCP-channel keypair | `mcp-channel/id_ed25519` | `tools/connect-agent.mjs` ✅ — `ssh-keygen -t ed25519`, mode 600 |
| 13 | Registration as an MCP server | the host runtime's own config | `tools/connect-agent.mjs --stanza` ✅ (#464) — one stanza, rendered per runtime; the operator still types it |
| 14 | kind 10050 inbound DM relay list | public relays | `tools/publish-dm-relay-list.mjs` ✅ (Bunker path added #381) — **but no step invokes it** |
| 15 | Proof that the registered server answers as THIS agent | the running session | `tools/connect-agent.mjs --whoami` ✅ (#338) — the operator captures `nvoy_whoami` and the tool compares |
| 16 | Startup file the runtime reads at session start | `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` | `tools/connect-agent.mjs --startup` — in review (#467) |

Sixteen. It was eleven when this document was started: the count grew twice while it was being
written and three times afterwards, which is itself the finding.

Row 13 said "Claude Code user config" until #464. That was an assumption, not a requirement, and it
is the reason the goal names three runtimes: Codex reads `AGENTS.md` and registers through
`codex mcp add`, and the installed Gemini build has no `mcp` subcommand at all, so registration
there is a settings-file edit. A tool that emits one Claude Code command is not runtime-neutral, it
is Claude Code with the others unimplemented.

**Eleven of the sixteen have a merged tool, and one more is in review.** The four with none are all
deliberate, not backlog. Rows 2, 3 and 4 are the
credential and the permissions on it — the administrator seats those, and no session should be able
to. Row 5 is a directory this repo does not write. Row 14 has a tool and no step that calls it,
which is a different defect from the others and is why it is called out below.

Row 14 is the one that broke the pattern. Every other artifact here is something the agent needs in
order to **act**; that one is the only thing that lets anything **reach** it, and it was absent from
the inventory entirely until #337 — after an admitted agent spent a day posting successfully into
the channel while structurally unable to receive a single message. The tool existed. No step ran it,
and nothing asked.

Row 15 is not a thing you make; it is a thing you prove, and it is here because the other fifteen
can all be correct while the session acts as someone else. An agent was handed a session whose
attached MCP server answered `whoami` with a different agent's identity — it would have read that
identity's sealed inbox and posted under its key, and nothing would have errored. The Bunker path
(rows 1–2) has refused that class since day one, via `EXPECT_PUBKEY` in `relay-send`,
`publish-dm-relay-list` and the profile publishes. Registration had no equivalent, so the same
defect moved one layer up from Pair to Bind and found nothing waiting.

Registered is not sole — #380 closed that half. Sole is not yours; #338 closes this one.

And "sole" was answered by asking one runtime with the wrong question (#464). The check shelled out
to `claude mcp list`, so on a Codex box or a Pi it reported `could not run` forever and the
registration could never be verified at all — the runtimes this design exists to serve were the
ones it could not see. Worse, the name test matched `nvoy` and `nvoy-…` only, and the channel
registered on the maintainer's machine is spelled `nvoy_codex_jaf`. The guard reported
`nvoy-<name> is the only nvoy server registered` with a foreign signing channel beside it.

Both are fixed in `src/mcp_runtimes.mjs`: the server is described **once** — command, args, env —
and each runtime renders it, so Claude Code and Codex cannot answer the same question differently.
Every runtime installed on the host is asked, and the report keeps three outcomes apart that were
previously two: *not installed* (not this host's runtime, not a failure), *installed but
unreadable* (INCONCLUSIVE), and *answered* (a list, possibly empty). What each CLI actually does
was run, not assumed — including `gemini mcp`, which returns `Unknown argument: mcp`, which is why
Gemini is given a config stanza and no command line.

It closes it by a weaker proof than the Bunker path's, and the two should not be read as equivalent.
`publish_relay_list.mjs` compares `EXPECT_PUBKEY` against a key derived from the **live signer,
in-process, immediately before signing**. `--whoami` compares against a **file**: a capture the
operator took at some earlier point, with no freshness and no binding to the session under test. It
passes forever once taken, including after the registration changes underneath it. Row 15 reaching
PRESENT — "present and observed doing its job" — therefore rests on a `readFileSync`. That is worth
far more than nothing, and it is not the same guarantee; the freshness gap is #462. The tool must not
open the channel itself, because the channel server holds its own lock and a second connection
orphans it.

### The failure signature is always the same

Every one of the gaps above produces an agent that *looks* configured:

- A **wrong-identity pairing** signs, seals and publishes perfectly. It surfaced only because
  someone resolved the public key and compared it — and the runbook's own guard for exactly that
  was a command-line flag that never existed, so it printed nothing and exited 0.
- A **missing `nip44_encrypt` permission** is indistinguishable from an empty inbox, all the way up
  the stack. Proving the permission needed a round trip, not an absence of errors.
- A **missing kind 0** costs nothing at runtime; the agent is simply invisible in every client.
- A **missing runtime state directory** kills the channel with `ENOENT` on a path no document
  mentions.
- An **inverted grant** verifies, is live, and authorises the opposite of what was intended.

This is why the fix is a wizard and not more prose. **Prose cannot be CI-tested.** Every stall we
hit was an instruction that had drifted from the code, and every one was found by *executing* it,
not by re-reading it. The same steps as code get a test suite, and a flag that does not exist fails
on the first run.

---

## Part II — Provenance: what we copied, and what we do not know

Oliver's manifest was created by **mirroring** the one working agent on this machine. Mirroring is
not understanding, and a wizard that mirrors without knowing why will propagate whatever is wrong in
the source. Recorded here so the wizard's authors know which values are *decisions* and which are
*cargo*.

### 1. Values copied verbatim, with known provenance

| Field | Value | Why it is what it is |
|---|---|---|
| `grantors` | the maintainer's key | The bridge's `config.public.grantors`; correct and understood. |
| `task_carriers` | the bridge key + one channel | The carrier that relays signed instructions. Understood. |
| `broker_mode` | `local` | The desktop path; `remote` requires a keyless manifest. |
| `delivery_mode` | `notify_only` | Required by `claude-channel.mjs`, which refuses anything else. |
| `worker_enabled` | `false` | `true` demands a digest-pinned worker image; out of scope. |

### 2. Values copied with **no** understanding — the open register

- **`relays: ["wss://nos.lol", "wss://relay.primal.net"]`.** The community relay is *not* in this
  list. The agent runtime reads grants only from these two. Oliver's grants exist on
  `relay.primal.net` **only** — `nos.lol` refuses them for proof-of-work while advertising
  `min_pow=none` in its NIP-11 document. So the entire authorisation of this agent depends on one
  relay, and the runtime re-reads roughly every ten minutes. *We do not know why this list is these
  two, whether it was ever a decision, or what the intended redundancy is.*
- **`watcher_uid: 502`, `broker_uid: 503`, `adapter_uid: 504`.** These declare a four-account
  privilege separation between the watcher, broker, adapter and worker. **On this machine, uids
  502, 503 and 504 do not exist.** Only `worker_uid: 501` resolves, to the human operator, and the
  running channel process is owned by that account. The manifest describes a security model that is
  not in force on the desktop path; `instance-runtime-init.mjs` (which would provision it) demands
  root and has evidently never been run here. *We do not know whether the desktop path is intended
  to be single-account, or whether this is unfinished provisioning.* A wizard must not copy these
  numbers forward as though they mean something.
- **`broker_adapter_gid: 20` (`staff`), `worker_handoff_gid: 12` (`everyone`).** Two stock macOS
  groups standing in for a handoff boundary. `everyone` is not a boundary.
- **Two checkouts of the same toolchain.** The registered MCP server points at
  `…/nvoy-macos-desktop-binder/mcp/tools/`, not the other tree. They are not obviously in sync.
  Pointing a new agent at the wrong one is silent.

### 3. Things that are simply undocumented

- `NVOY_INSTANCE_ROOT` must be set, because the default root does not exist on macOS. Discoverable
  only by reading the source or by inspecting a working registration.
- Five runtime/state subdirectories must pre-exist, two with non-default modes (`710`, `755`).
  Nothing creates them and nothing lists them.
- `claude mcp list` reporting **✘ Failed to connect** for a *working* agent is **expected**: the
  health check spawns a second copy, which correctly refuses because the real one holds the lock.
  A stale lock naming a dead pid is tolerated. This looked like a fault for an hour.

### 4. One irreversible artifact

A join request was published carrying the example's placeholder text, because
`--purpose "what this agent is for"` reads as both instruction and value. It cannot be retracted:
the request is signed by an ephemeral key that is burned by design, so there is nothing left to sign
a deletion with. **A wizard must never let a template string reach a signature.**

---

## Part III — The grant plane

The maintainer's words: *"I am still confused by the grant plane."* That confusion is not a failure
of attention. It is produced by the software.

### 1. The confirmation sentence is inverted for the whole task family

`mcp/tools/attention.mjs`, **in the nvoy repo and not this one**, is the enforcement site. It builds the map of who may instruct this agent:

```js
if (scope[1] !== scopeHash(ME, scope[2] || '')) continue // authorises tasking some other agent
…
putGrant(String(grantee).toLowerCase(), { grantId: ev.id, grantor: ev.pubkey, cap })
```

The **scope subject is the agent being instructed**. The **`p` grantee is who may instruct it**.
`tools/grant.mjs` agrees: *"`--agent <npub>` cap task — this grantee may TASK that agent."*

`console/capability-vocabulary.mjs` disagreed:

```js
'task':      'Take tasks from you',
'task+act':  'Take tasks, and act on them',
```

The grantee is described as the task-*taker*. In the enforcement code the grantee is the
task-*giver*.

**Where that phrase actually reached the operator matters, and the first version of this document
got it wrong.** `capWhy()` in `console/index.html` has bespoke, *correct* paragraphs for the task
family — *"This authorises ‹who› to TASK the agent ‹subject›"*. The inverted phrase was never in
the confirmation. It was in the two places where the decision is formed:

- **the grant card** (`:462`) — `${esc(capLabel(g.cap))}`, alone, with no parties. This is what an
  operator reads when auditing what is live.
- **the issue dropdown** (`:765`) — the same phrase at the moment of choosing what to sign. The
  correct paragraph only appears *after* the choice.

So the accurate text sat in the confirmation while the inverted text sat in the decision. That is a
worse arrangement than a uniformly wrong label, and it is consistent with the misissued grant: the
operator chose from the dropdown.

**Fixed in this change.** The vocabulary now carries `CAP_SENTENCE` — a template naming both
parties — and `describeGrant()` is the only supported way to render one. Both surfaces above call
it. `tests/capability_vocabulary.mjs` asserts the exact rendered strings, that the grantee always
precedes the subject in the task family, and that the historical phrasing can never return; a
negative control renders the inverted template and proves those assertions reject it.

The fix is not a better adjective. The label must be a **sentence with a direction**, generated from
grantee and subject together rather than from the capability alone:

| cap | today | proposed |
|---|---|---|
| `admit` | Post into the channel | **‹grantee› may post into ‹channel›** |
| `admit+read` | Post into the channel, and read it | **‹grantee› may post into and read ‹channel›** — *not issuable; see below* |
| `task` | Take tasks from you | **‹grantee› may send instructions to ‹agent›** |
| `task+act` | Take tasks, and act on them | **‹grantee› may instruct ‹agent›, and ‹agent› may act on it** |
| `task-relay` | Carry signed instructions | **‹grantee› may carry instructions addressed to ‹agent›** |

A directionless label cannot be right, because the thing a human gets wrong is the direction.

### 2. Naming

`admit` and `task` are protocol vocabulary and should stay in the events. What the operator reads
should be **two planes with different verbs**, and the console should say which is which:

- **The door** (`admit`, `admit+read`) — *"who is allowed in"*. Enforced by **this bridge**.
- **The leash** (`task`, `task+act`, `task-relay`) — *"who may give this agent orders"*. Enforced by
  **the agent's own runtime**, not by the bridge.

`console/capability-vocabulary.mjs` already carries the enforcer table and already refuses to invent
prose for capabilities it does not recognise. That is the right instinct and the right home; it
needs the direction added, and every surface pointed at it.

### 3. What the operator must be able to see

There is currently no answer to *"what can each agent do right now?"* short of querying relays by
hand and recomputing salted scope hashes — which is how the missing grant in this session was found,
and how a grant that *did* exist was first reported as absent.

The console needs a **grant matrix**: agents down one axis, subjects across the other, each cell a
live capability with its enforcer, its grant id, and the relays it is currently visible on. Three
properties matter more than the layout:

- **Direction is drawn, not described.** An arrow from instructor to instructed. The inversion above
  is impossible to make in a picture and easy to make in a sentence.
- **Revocation is visible as a state**, not an absence. A revoked grant must render struck through
  with its 441, because "gone" and "never existed" are the same picture and very different facts.
- **Relay visibility is part of the capability.** A grant on one relay is a capability with a single
  point of failure. Today that is invisible; it should be a warning in the cell.

---

## Part IV — Architecture

**"Connect Remote Agent" is one workflow with one job: make the sixteen artifacts, verify each one,
and refuse to continue when it cannot.**

### Principles

1. **The wizard is the mechanism; the runbook becomes the explanation.** `docs/JOIN_RUNBOOK.md`
   stays, as the account of *why* each step exists. It stops being the thing you execute.
2. **Every step verifies the state, never the precondition.** "Key created" is not "runtime paired".
   "Settings written" is not "settings loaded". Each step ends by observing the artifact it just
   made, from a fresh read.
3. **No step may pass by silence.** A check that cannot run must fail the step, not skip it. The
   wrong-identity pairing survived precisely because its guard could not execute and the step around
   it looked fine.
4. **Default closed, and resumable.** The flow is interrupted constantly in practice — a Bunker to
   click, a name to register. It must be re-enterable and report exactly which of the sixteen are
   present, which are missing, and which are present but unverified. Three states, never two.
5. **Nothing the wizard writes is a template string.** Placeholder text must be structurally
   incapable of reaching a signature.
6. **Secrets are handled, never displayed.** Identity secrets stay in the Bunker; transport keys are
   written `0600` and referenced by path. The wizard prints paths and public keys only.

### Shape

```
┌─ Connect Remote Agent ─────────────────────────────────────────┐
│                                                                │
│  1. IDENTIFY    name · role · scope           → what it is     │
│  2. MINT        identity key                  → the Bunker     │
│  3. PAIR        bunker URI + client key       → credentials/   │
│  4. PROVE       4 NIP-46 methods, round trip  → observed       │
│  5. PUBLISH     NIP-05 name · kind 0 profile  → discoverable   │
│  6. ADMIT       join request → approval → 440 → through the door│
│  7. AUTHORISE   task grants, drawn not described → the leash   │
│  8. BIND        manifest · state dirs · channel key · MCP reg  │
│  9. CONFIRM     end-to-end message, cold read-back             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

Steps 1–4 and 8 are fully automatable. Step 5 needs a directory write the repo does not own today.
Step 6 needs a human approval by design. Step 7 needs a human decision, which is the point.

### The one change that removes the whole class of error

The console used to ask for a **grantee** and a **subject**. Those two fields look symmetrical and
are not, nothing on the form said which way round they went, and the operator had to do the
translation from intent to protocol every time, silently, with no way to check the answer.

`console/connect-plan.mjs` deletes that question. The operator picks from five **intents** —
sentences about who does what to whom — and the planner assigns the parties:

| The operator chooses | grantee | subject |
|---|---|---|
| Let this agent post into the channel | the agent | the channel |
| Let me give this agent instructions | **you** | the agent |
| Let this agent give instructions to another | **the agent** | the other |
| Let the bridge carry instructions to it | the carrier | the agent |

The middle two are the same protocol event with the parties swapped, which is exactly the pair
that was got wrong. A caller cannot pass a grantee — there is no parameter for it — and
`tests/connect_plan.mjs` asserts the assignment per intent, asserts the two task intents are exact
mirrors, and runs a negative control against an inverted table to prove those assertions would
catch it.

The review step then draws the direction as an **arrow** rather than describing it. A sentence
about who instructs whom can be read backwards. An arrow cannot.

### Where it runs

The flow spans a laptop, the bridge host, the Bunker and the public relays. It should run **where
the credentials already are** — the operator's machine — and reach the bridge over the interfaces
that exist, rather than becoming a second thing that must be deployed and kept current.

---

## Part V — What each step must verify

The repo's governing lesson is that every real bug here was invisible to a test that merely ran. The
wizard's steps are held to the same bar as its suites.

| Step | Passes only when |
|---|---|
| Mint | The secret is at a `0600` path and appears in neither stdout nor stderr; the public key is derived back from the written file. |
| Pair | `get_public_key` returns **the key just minted**, compared programmatically. A mismatch is a hard stop, never a warning. |
| Prove | All four methods exercised, `nip44_decrypt` by encrypt-then-decrypt round trip — never by an empty inbox. |
| Publish | The kind 0 is fetched back **by id from a fresh connection**, and `nip05` is omitted until the name resolves, because a failed badge is worse than none. |
| Admit | The 440 is cold-read from every configured relay, its signature verified, and its salted scope hash recomputed against the intended subject. Per-relay state is reported — `EOSE` / `ERROR` / `TIMEOUT` — because zero results and an unreachable relay are the same empty array. |
| Authorise | The operator is shown the directional sentence and the drawn arrow before signing, and the issued grant is read back and re-derived. |
| Bind | The manifest is validated by `runtime_manifest.mjs` itself, not by a copy of its rules; the MCP server is started and answers `initialize` and `tools/list`. |
| Confirm | A real message crosses and is observed in the bridge journal — not a relay `OK`. |

Each of these needs a **negative control** in the suite: a deliberately wrong pubkey, an unreachable
relay, a denied permission, a manifest with one bad field. A check that has only ever passed proves
nothing. The manifest validation above was written this way and the control did fire.

---

## Part V½ — What "landed" means, and why the threshold inverts

Raised in review of the first build. The Connect flow publishes a grant, then cold-reads it back
by id from a fresh connection, and calls it landed if **any** relay serves it. That is strictly
stronger than a relay `OK` — a relay can accept and drop — and it is worth keeping.

But it proves the wrong property. It proves **publication**. What matters is **reachability by the
consumer**: the agent's runtime reads *its own* relay list, and a grant that landed on a relay
outside that set is published and invisible to the only software that enforces it. The check
reports green for a state that does not work.

> **"Landed" must mean present on a relay the enforcer reads** — not present anywhere. That needs
> the consumer's relay list, not the publisher's, and the console does not have it today.

This is not hypothetical here: both of the live agent's grants sit on `relay.primal.net` only,
because `nos.lol` refuses them for proof-of-work while advertising `min_pow=none`. That happens to
be inside the runtime's set. Nothing checked that it was.

### The read-back's own blind spot: not every relay serves an `ids` filter

Found while publishing a kind 0 for the live agent, which is the same publish-then-read-back shape
the Connect flow uses:

```
publish        purplepag.es: accepted
read back      purplepag.es: no (CLOSED)      ← by id
query by author purplepag.es: 1 event  EOSE   ← it had it all along
```

`purplepag.es` accepts the event and stores it, and does **not** answer a `{ ids: [...] }` filter.
The by-id read-back therefore reports a perfectly good publish as `NOT PROVEN` — a false negative
on a check whose entire job is to distinguish "stored" from "accepted and dropped".

This is the other half of the same discipline. A check that can report failure for a working relay
teaches an operator to disregard it, and a disregarded verification is worse than none, because the
first real failure looks like the noise they have learned to ignore. **The read-back should fall
back to a filter the relay will answer** — kind plus author plus a `since` — and treat "no answer
to either" as inconclusive rather than as absent.

### The threshold inverts for revocation

There is no revoke surface in this flow yet, and the number must be decided before there is one,
because the two directions are not symmetric:

| | landed on 1 of 5 relays | what it means |
|---|---|---|
| **440 grant** | weakly live | one relay serves it; the enforcer may or may not read that one. Fragile, but the failure is *closed* — the capability does not apply. |
| **441 revocation** | **broken** | four relays still serve a grant every reader will treat as live. The failure is *open* — the capability keeps applying. |

So a grant needs *a relay the enforcer reads*, and a revocation needs **all of them**. A partial
revocation is not a success with a caveat; it is a failure, and it has to be shouted. A revoke
surface that reuses the grant flow's "any relay is fine" rule would report a revocation as done
while the access it was meant to remove is still being enforced.

## Part VI — Decisions needed

These are the maintainer's, not the implementer's:

1. **Relay set.** What is the intended relay list for an agent runtime, and what is the minimum
   redundancy before a grant counts as durable? Today a live agent's entire authorisation sits on
   one relay.
2. **The uid model.** Is the desktop path intended to be single-account, or is the four-account
   separation unfinished? The manifest currently asserts a model that is not in force.
3. **Who owns the NIP-05 directory?** It is not this repo, and no agent is complete without an entry.
4. **`task` vs `task+act` as a default.** The smaller grant should be the default offered.
5. **Does the wizard live in the waggle console, or in the runtime toolchain?** It needs both the
   grant surface (here) and the manifest/MCP surface (there).

---

## Appendix — the seven stalls, for the test suite

Recorded on #309 in full; listed here because each should become a regression test.

1. Mint one-liner run from a directory without the dependency → `ERR_MODULE_NOT_FOUND`.
2. The same one-liner printed the identity secret to the terminal.
3. A tool that "did not exist" was a stale checkout, not a missing tool.
4. A verification flag that never existed printed nothing and exited **0**.
5. A multi-line command with `\` continuations split silently on paste.
6. A whole step — minting the client transport key — was absent from the document.
7. Bunker permissions are per-method; pairing succeeded, then encryption was denied.

Plus the two that announced nothing: a **wrong-identity pairing** that worked perfectly, and a
**placeholder published irreversibly**.

---

Drafted with assistance from [Claude Code](https://claude.com/claude-code)

---

## What is settled, and must not be re-opened (#344)

This document proposed the vocabulary in a "today / proposed" table. **The proposed column shipped**
— `console/capability-vocabulary.mjs` carries it, and #348 extended plain verbs to the chrome around
it, so the console no longer says "admit" or "grant" to a person at all. Read the table as a record
of a decision already made, not as a plan.

One row of it never will ship as written. `admit+read` is **not issuable**, for two independent
reasons, and the first is settled by live evidence rather than by reasoning about the source:

1. The community relay refuses an outside key at NIP-42 AUTH time. `enforce_relay_membership`
   consults a **different table** from `channel_members` and fires before any channel is consulted,
   on both the websocket and the HTTP `/events` path. `add-member` will accept any 32-byte key and
   the roster will show it — and that row is **inert**, because the key still cannot authenticate.
   An owner-minted NIP-OA auth tag does not admit it either.
2. Conveying read for real would mean putting channel key material in a `30440`, which makes the
   console key-touching and makes revoke a Concord rotation rather than an event signer.

What an outside agent actually receives is the **return lane** — mentions carried back to it by
waggle. That is the design. It is not a stopgap for missing read, and no work here should assume
native read is coming.
