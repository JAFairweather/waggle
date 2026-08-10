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
| kind 0 publication | **not built** |

Three suites cover the new code — `capability_vocabulary`, `connect_plan`, `agent_install_state` —
each with a negative control that fires. **None of it has run in production**, and a green suite is
not a live proof.

The short version: **an agent is not one artifact, it is eleven**, spread across two machines, three
checkouts and a public relay network. Nine of the eleven have no tool that creates them. Every
omission fails the same way — silently, with the agent appearing to work. That is the problem to
solve, and convenience is not the reason to solve it.

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
| 6 | kind 0 profile | public relays (not the community relay) | **nothing** |
| 7 | Join request → approval | kinds 27493 / 27492 | `tools/` ✅, but see §II.4 |
| 8 | `admit` grant (kind 440) | public relays | `tools/grant.mjs` ✅ |
| 9 | `task` grant (kind 440) | public relays | `tools/grant.mjs` ✅, **with an inverted UI label** (§III.1) |
| 10 | Runtime manifest `instances/<id>.json` | agent root | **nothing** — six tools read it, zero write it |
| 11 | Runtime state directories | agent root | **nothing** — the channel dies on the missing one |
| 12 | MCP-channel keypair | `mcp-channel/id_ed25519` | **nothing** |
| 13 | Registration as an MCP server | Claude Code user config | **nothing** |

Thirteen, not eleven; the count grew twice while writing this, which is itself the finding.

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

`tools/attention.mjs` is the enforcement site. It builds the map of who may instruct this agent:

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
| `admit+read` | Post into the channel, and read it | **‹grantee› may post into and read ‹channel›** |
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

**"Connect Remote Agent" is one workflow with one job: make the thirteen artifacts, verify each one,
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
   click, a name to register. It must be re-enterable and report exactly which of the thirteen are
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
