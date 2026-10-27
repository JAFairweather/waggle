# Hive manager — spec

Issue: #613. Status: **read by the owner on 2026-10-26. Decisions D1–D6 are accepted, and the
one-list rule is added. On 2026-10-27 the owner added criteria 9 and 10 (how each agent works, and
live proof that it does); decision D7 is proposed and D8 is open.**

## The outcome

The owner manages the hive from one page and never from a shell. #613 lists ten criteria, and the
work is done only when each one has been checked against the live system:

1. He signs into the waggle console with his Bunker and sees **one list** of every identity in the
   hive, grouped by channel. Every identity is an agent, or could become one.
2. Each agent shows four answers: who can give it work, what it may do without asking, where it can
   post, and what it holds.
3. Adding an agent, changing who can give it work, and revoking are signed by his Bunker in the
   browser. There are no zsh blocks and no `grant.mjs`.
4. Every live grant is a recognised role or is flagged custom, and none are duplicates.
5. A "what happens if" check runs nvoy's own admission code, so it cannot disagree with the broker.
6. The beeswarm grant links, nact's agent pages and the hand-run grant commands are gone.
7. Someone cold can answer "who can give Pi Dog work?" in under 30 seconds.
8. A new agent is onboarded from the page. Its tools sit in its own isolated container on nave, the
   agent keeps running on its own box, and it is briefed on the tools.
9. Each agent also shows **how it works** on its own box: its harness mode, its reviewer, its tools,
   its model, its working folders and its instructions. Each comes from one named recipe, so the
   agents work alike unless a row says otherwise.
10. Each agent shows **live proof**: when it last took an admitted task, used its tools on it and
    replied. An agent that stops doing that lands in **Needs you**. A correct setting never counts as
    proof.

## Why it is hard today

Measured on 2026-10-25/26 against origin/main of waggle, nvoy and nact:

- **The hive is simple; the machinery is not.** There is one owner (every live grant is signed by
  4010ac43). Every manifest names exactly one Buzz channel. Not one of 204 outbound replies has ever
  taken the approval path. The complexity serves cases that do not occur.
- **There are three agent registries, and none of them is the truth.**
  - waggle Access is a grantor's 440s (`console/index.html:1585-1630`).
  - waggle Agents is the bridge's 30078 roster, fed only by lifecycle commands
    (`console/agents.html:160-175`; #321).
  - nvoy keeps `nvoy_agents` in a 10440 index (`nvoy console/agents.mjs:1-7`).
  - The registry that actually decides is the **fleet manifest** (`/etc/nvoy/instances/*.json`), and
    no browser can read it (`nvoy console/main.mjs:44`: `runtimeManifests` is always null).
- **A grant is unreadable without context.** `da-scope` is
  `sha256("waggle/da-scope/v1" ‖ 0 ‖ subject ‖ salt)` (`src/scope_hash.mjs:49-66`). To say what a
  grant covers you must already know the candidate subjects: channel UUIDs for `admit`, agent pubkeys
  for `task`, `task+act` and `task-relay`, and the grantor's own key for `shadow`
  (`nvoy grant_fold.mjs:53-57`). `SPEC_EXTERNAL.md:215` still says the subject is always a channel.
  That is wrong for the task family, and this work corrects it.
- **The admission decision is spread over four functions** in nvoy:
  - `foldGrants` (`grant_fold.mjs:33`);
  - `partitionInvocations` (`invocation_policy.mjs:14`);
  - `nativeGrant` (`buzz_native.mjs:178`);
  - `admissionLimit` (`agent_limits.mjs:81`).

  The first three are pure logic, but they import `node:crypto` or sit beside `node:fs`, so a browser
  cannot load them.
- **Expiry is honoured by nvoy only.** waggle's bridge, `grant.mjs` and the console all ignore NIP-40
  `expiration`, so the console shows an expired grant as live.
- **The relay sets differ.**
  - The console reads nos.lol, primal, ditto and jskitty (`index.html:462`).
  - nvoy reads those plus dreamith (`attention.mjs:95-98`).
  - The bridge reads `cfg.public.relays`.

  Grants have already been evicted from public relays twice (memory: grants-live-only-on-ditto), and
  #457 reports a partial read as a complete one.

## The model: one list, five answers, one source each

**One list. Every identity in the hive is an agent, or could become one.** The owner ruled this on
2026-10-26. The list is keyed by pubkey, and it replaces all three registries. A row exists for every
key the hive knows about:
- the owner himself;
- every key that holds or grants a live grant;
- every member of a hive channel (the Buzz roster);
- every key that has published an agent card (C1);
- every row in the bridge's 30078 roster, nvoy's 10440 index and nact's identities.

The owner, Dead Rabbit, the waggle bridge, LukeDog, GrokDoggyDog and an identity with no tools yet
are all rows of the same kind. Each row is named from its kind:0. What differs is only what each row
**has**:

| Has | Shown as |
|---|---|
| A fleet manifest (an agent card) | **Tools on nave**, plus the box its harness runs on |
| Grants, given or held | Its role chips |
| Nothing but a key | **No tools yet**, with an **Onboard** button |
| No key at all (a name on yoga with no identity) | **No identity yet**, with an **Onboard** button that starts at step 2 |

Onboarding is therefore not a separate place. It is the same row gaining a key, then tools, then a
role. "Is this an agent?" stops being a question: every row is one, and the row says how far along it
is.

Each answer has exactly one source of truth, and the page never invents one. For a row with no tools,
the answers come from grants alone, and the page says so.

| Answer | Source of truth | How the page reads it |
|---|---|---|
| **Who can give it work** | Live `task` and `task+act` grants scoped to this agent, signed by one of the manifest's `grantors`. A DM is owner-only (`nativeGrant`). Carried work also needs the carrier's `task-relay` grant plus the author's own task grant (`invocation_policy.mjs:14-43`). | Fold the 440s and 441s, then name each grantee. |
| **What it may do without asking** | `task+act` versus `task` on the work grant. `agent_limits` (hops and rate). `may_set_profile`. The harness's own tool permissions on its box. | Grants and the agent card (below). Harness permissions are shown as "set on <box>, not visible here" until the harness reports them. |
| **Where it can post** | `may_post.channels`, `per_hour` and `mention[]` from the manifest. Channel membership is the Buzz roster. | The agent card. |
| **What it holds** | The manifest refs: `bunker_client_ref`, `worker_credential_ref`, `harness.credential_ref` and `wake_webhook`. Also nact `credential:<name>` grants (`nact grant-reader.mjs`). | The agent card, plus nact `/api/state` `credentials` and `entitlements`. Each holding is labelled **has a copy** or **can use, never sees**. |
| **How it works** | The harness config on the agent's own box, and the instructions file in its workspace (see "Autonomy profiles" below). | The harness's profile report in its agent card. Until a harness reports one, the row says "not reported", never a guess. |

One sentence in the first answer is deliberate, because the code already says it
(`invocation_policy.mjs:2-4`): **being in a channel lets you talk; it does not let you give work.**
The page prints that sentence once, beside the answer.

## Roles are recipes recognised from grants

A role is a named set of grants. The page folds the live grants for each agent and matches them
against these recipes. A match is shown by its name. Anything left over is shown as **custom**, with
its raw sentence from `capability-vocabulary.mjs`.

| Role | Grants | Meaning |
|---|---|---|
| **Teammate** | `task`, from the owner, for the agent | You can give it work. |
| **Trusted teammate** | `task+act`, from the owner, for the agent | You can give it work, and it may act on it without asking. |
| **Colleague** | `task`, from the owner to another agent, for this agent | That agent can give this one work. |
| **Carrier** | `task-relay`, to the bridge, for the agent | The bridge may carry work addressed to it. |
| **Voice** | `shadow`, from the owner to a key | That key speaks for the owner (Dead Rabbit). |
| **Channel guest** | `admit`, for a channel | Leftover from waggle carry. Shown, and flagged as a candidate for cleanup. |

The "no duplicates" criterion is computed, not promised. Two live grants with the same
(grantor, grantee, cap, subject) form a pair, the newer one is listed under **Needs you**, and one
signature revokes it.

## Autonomy profiles (criteria 9 and 10)

**Why this is in scope.** On 2026-10-27 the owner found the agents "neutered": they answered tasks
and did no work. Nothing in any grant caused it. It took six separate knobs, in six formats, on three
machines, and no page showed any of them:

| Harness | Knob that had locked it down | Where it lives |
|---|---|---|
| Claude Code (mc-claude) | `--continue` restored the old `dontAsk` mode over settings' `auto`; no working folder outside its workspace | `.claude/settings.json`, launch flags |
| Codex (dj-codex) | Approval policy `never`, no reviewer, a read-only sandbox | `<agent>-harness.json` `approvals`, and the `config.toml` the harness generates |
| pi (pi-dog) | `--tools` allowed only the channel tools; a retired model; a resumed session that dropped tools | `<agent>-harness.json`, pi `settings.json`, the session file |
| OpenClaw (LukeDog) | Nothing locked; it lacked the shared rules | `AGENTS.md` in the container |
| All injected harnesses | The turn text: "answer it once … otherwise, take no action" | `harness_session.mjs` (nvoy #265) |

**A profile is a recipe, like a role.** It names the settings each harness type maps to. The row
shows two things for each field, and never infers one from the other:
- **desired**, from the recipe the owner picked;
- **effective**, as the harness reports it, with its source named: the harness JSON, the config it
  generated, or the flags it launched with. A field the harness does not report is shown as
  **unknown**. It is never filled in from the recipe.

A mismatch between the two is listed under **Needs you**. Today they do differ: nvoy `main`'s
`codexConfigToml` (`mcp/tools/harness_session.mjs`) still writes `approval_policy = "never"` and
`sandbox_mode = "read-only"`. Only the Mac harness branch reads `approvals.policy` and
`approvals.reviewer` from the harness JSON and passes them on start and resume. That branch is
unmerged.

| Field | Claude Code | Codex | pi | OpenClaw |
|---|---|---|---|---|
| Mode | `defaultMode` plus `--permission-mode` | `approval_policy` | `--no-approve` | its own config |
| Reviewer | `autoMode` rules | `approvals.reviewer` | none | none |
| Tools | allow and deny rules, MCP servers | sandbox and MCP | `work_tools` and the `--tools` allowlist | `tools` |
| Model | `model` | `model` | `model` | `model` |
| Working folders | `additionalDirectories` | `writable_roots` | its cwd | its workspace |
| Instructions | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` | `AGENTS.md` |

There are two recipes today:
- **Autonomous worker**, the desired default. Every setting is named per harness, never as one
  word that means different things:
  - Claude Code: auto mode, with `autoMode` rules as the classifier.
  - Codex: the reviewer is **open, and the owner's decision (D8)**. `~/.codex/AGENTS.md` (2026-08-08)
    says review goes to James or the Buzz crew, never to an automated reviewer, and that
    `approvals_reviewer` stays `user`, because unattended `auto_review` runs took 10–45 hours and
    cost $16–$77 each. On 2026-10-27 the owner picked "automatic reviewer" for dj-codex without that
    history to hand. Today the reviewer sees only what reaches it: dj-codex's `prompt_commands`
    (git writes and `gh`). One guardian review ran 23 minutes on 2026-10-27.
  - pi: `--no-approve`, so its tool allowlist and deny rules are its guards.

  Each one also gets full work tools, the owner's deny rules and the shared rules
  (`HIVE_AGENT_RULES.md`): act on your own, and check in on Buzz for review, feedback and research.
  The automatic check covers single risky actions. **Review of work** stays with people and the
  crew: a PR goes to mydude, and grants, revokes, the Bunker, permanent deletes and anything
  ambiguous go to the owner.

  This is the target. It is not what every harness on `main` produces today; see the mismatch
  above.
- **Answerer.** Channel tools only. It is shown, and offered only when the owner picks it.

A row whose settings match no recipe is shown as **custom**, field by field, the same way a grant is.

**Live proof has two tiers, and the row says which one it has.**

- **Replied (measurable today).** The broker writes each admission to `admitted-tasks.jsonl` and each
  published reply as a receipt. Together they prove that a task was admitted and that a reply was
  published on its envelope. They do not prove that the agent used a tool or did the work: the reply
  path (`instance-broker-reply.mjs`) validates and publishes text, and attests nothing about the
  turn. The row says "last replied to an admitted task 12 minutes ago", and never "did work".
- **Used tools (needs instrumentation; a prerequisite of criterion 10).** The harness already knows which
  turn it injected for which envelope (`delivered.jsonl`). It adds one task-bound receipt per turn:
  the envelope, the turn, its status, and a count of the tool calls by kind, with no message content.
  - Codex reports tool items on the app-server stream.
  - pi's extension sees each tool call.
  - Claude Code can count them with a `PostToolUse` hook.

  Until a harness writes these receipts, its row shows "tools: not reported". With them, it shows
  "last used tools on an admitted turn", with the turn's status and any failed calls. A count proves
  that a tool ran during the turn. It does not prove that the work was done: a call can fail, only
  read, or be unrelated.
- **Work completed** is reserved for a task-specific check of the outcome, such as the artifact the
  task asked for, its readback, or a merged PR. The page shows it only where such a check exists.

**Needs you** is raised for:
- an admitted task with no reply within the recipe's window;
- once tier 2 exists, a reply to a task whose turn used no tool. That is flagged for a look rather
  than counted as a fault, since a question can rightly need none;
- a desired/effective mismatch.

An agent with no admitted work is shown as **no recent demand**, not as Needs you, unless a recipe
names a scheduled duty with a cadence.

On 2026-10-27, pi-dog's configuration was correct while it could not act, and dj-codex and pi-dog
replied to tasks without doing them. Tier 1 would have shown pi-dog's silence. The tools tier would
have flagged the replies that used no tool. Neither catches a shallow reply that made an irrelevant
tool call; only a completion check does.

## Layers and contracts

```
 waggle hive manager (console page)   recipes, the four answers, Needs you, onboarding
        │ reads: agent cards, grants, nact state      │ writes: 440/441 signed by the Bunker
 nvoy runtime (fleet)                 brokers, the evaluator, the provisioner
 nvoy ledger                          kind 440/441 on the grant relays; knows nothing about agents
```

There are three new contracts. Each is small.

**C1. Agent card.** Each fleet broker publishes one replaceable event, signed by **the agent's own
key** through its own Bunker client:
- kind 30078, `d` = `nvoy-agent-card`;
- content is the allowlisted projection that already exists (`nvoy console/runtime-facts.mjs`):
  `grantors`, `buzz.channels` (with names), `may_post`, `agent_limits`, `may_set_profile`, the
  holding refs as **names only**, the harness box label, and the deployed build hash.

The broker republishes the card whenever its manifest digest changes. That gives the browser the
missing manifest source with no new server to trust: the agent attests to its own configuration. It
also replaces `status.json`'s unnamed 8-hex channel prefixes.

**C2. Browser-safe admission module.** nvoy moves the pure rules into one module,
`mcp/tools/admission.mjs`:
- the grant fold (`foldGrantsWith`), `nativeGrant`, the hop tag and NIP-40 expiry;
- `foldGrantsWith` takes the scope-hash function as an argument instead of importing `node:crypto`;
- it does no fs and no network. `invocation_policy.mjs` and `channel_task_carry.mjs` build only on it
  and on `nostr-tools/pure`, and a test walks that import graph to keep it that way;
- the broker imports it through the old module names, unchanged. The console vendors it at a pinned
  commit, with the hash checked in a test.

Criterion 5 is met by construction: the page runs the exact code the broker runs. The rate and hop
counters stay on the fleet, and the page reports them as "limits apply: N/h, M hops".

**C3. One grant relay set, with a read that reports its coverage.** The set is defined once in nvoy
and exported to the bridge, the console and `grant.mjs`. Every read returns the grants found and also
**which relays answered**. The page shows "read from 3 of 5 relays". A revoke is only called done
when a cold read from every answering relay no longer returns the grant (#457). Expiry is honoured
everywhere, by moving waggle onto the same fold.

## The page

There is one board, which follows `DESIGN_CONSOLE_IA.md` (#330) and replaces the Access and Agents
tabs.

- **Sign in.** The Bunker (NIP-46) is the default, through the existing `nave-connect.mjs`. NIP-07
  stays as a fallback.
- **One list, grouped by channel.** Each section is a channel, named from the agent cards. Any
  identity in no channel goes under **Not in a channel yet**, so no key ever drops off the list. A
  **Just me** section holds DM-only facts. An identity in two channels appears in both, with the same
  card.
- **Agent row.** It shows the name, the box it runs on, and its role chips. Expanding the row shows
  the four answers as sentences ("You and DJ Codex can give it work"), never as hex.
- **Change.** Each answer that a grant controls has a Change button:
  1. The page drafts the 440 or 441.
  2. It shows the event in plain words and the exact JSON beneath.
  3. The Bunker signs it.
  4. The page publishes it to the full relay set.
  5. It does a cold read-back and only then says **done**.

  Answers controlled by the manifest show **Ask for this change** instead. That files the request in
  **Needs you** for the fleet operator, because manifest edits are not grants (see decision D3).
- **Needs you.** Holds duplicate grants, expired grants that are still listed, grants that match no
  recipe, agents with no card (unreachable or not yet upgraded), and pending onboarding steps.
- **What happens if.** Pick an author, an agent, and channel or DM. The page runs C2 and answers
  "admitted as work, through Pi Dog's task grant from James (grant 9f…)" or "not work: chat only,
  because the author holds no task grant for DJ Codex".

## Onboarding (criterion 8)

**Tools on nave, agent on its own box.** That is the owner's ruling of 2026-10-26, and it matches
`nvoy docs/HARNESS_PLACEMENT.md`. Onboarding starts from a row on the one list. A row that already
has a key skips step 2. A new agent goes through six steps:

1. **Name and box.** The owner names the agent, picks its box (yoga, the Mac, …) and its harness type
   (Claude Code, Codex, pi).
2. **Identity.** The owner creates the key **in his Bunker**; the page shows him the steps. The nsec
   never leaves the Bunker. The page records the pubkey.
3. **Tools on nave.** A fleet provisioner renders the manifest, the compose file and the restricted
   SSH principal, and starts the agent's isolated container set: Bunker client, watcher, broker and
   channel endpoint. Today a human does this by hand. The provisioner turns it into one owner-signed
   request (decision D5). The owner then pairs the new Bunker client: one approval in the Bunker app.
4. **Harness on its box.** The page produces one install line for the box's owner to run. It installs
   the channel key, the pinned `known_hosts` entry and the harness wrapper. With the fleet on the
   tailnet (decision D6), the wrapper reaches nave privately and needs no public port 22.
5. **Brief.** The installer writes the agent's briefing into its workspace (`AGENTS.md` or
   `CLAUDE.md`), generated from its agent card. It covers:
   - the tools it has;
   - who can give it work;
   - where it may post and how often;
   - the limits it works under;
   - how to read #waggle-test;
   - the shared rules, `HIVE_AGENT_RULES.md`.

   The harness is installed with the **Autonomous worker** profile unless the owner picks another.
6. **Role and proof.** The owner picks a role recipe and signs it. The step is only complete when the
   agent posts in #waggle-test **and** another agent gives it work that it is admitted to take
   (an admission receipt on the fleet).

HR, crusty and crystalclaude go first. They live on yoga, which is rabidrabbit's box, so step 4 is
run there by James or rabidrabbit. Nobody else touches yoga.

## Decisions for the owner

**D1–D6 were decided on 2026-10-26: the owner accepted every recommendation, and added the one-list
rule above. D7 is proposed.**

| # | Decision | Recommendation (accepted) |
|---|---|---|
| **D1** | Where the console is served. `serve-console.mjs:6-10` says loopback only, because a hosted page could show one event and hand the signer another. But "no command line" needs a hosted page, and one is already live at `waggle.nave.pub/console/`. | **Hosted.** The page shows its build hash, and the agent cards' build hash is the cross-check. Unverified: whether the Bunker's approval screen shows the kind of event being signed. If it does, a substituted page cannot disguise a 440 or 441 as something else. If it doesn't, this risk stands and is yours to accept. I check it before M2. |
| **D2** | How the browser learns manifests. | **C1 agent cards**, signed by each agent. Rejected alternative: an HTTP endpoint on the fleet, which would be a new server to trust and to keep alive. |
| **D3** | Whether manifest fields (`may_post`, limits) are editable from the page. | **Not in this goal.** Criterion 3 names grants only. The page shows them read-only and queues "ask for this change". Manifest edits stay a fleet change, made under the autonomy rule. |
| **D4** | Expiry. | **Honour it everywhere**, through the shared fold. |
| **D5** | Who runs the fleet provisioner. | **First, a fleet command** (`nvoy-provision <name>`) that I run under the autonomy rule when you request it from the page. Automate it from the signed request once that path has done three agents cleanly. |
| **D7** | Whether profiles are changed from the page. *Proposed 2026-10-27, not yet decided.* | **Like D3.** The page shows the profile and queues "ask for this change". The operator applies it under the autonomy rule, backs up first, restarts the harness and verifies it against the live-proof signal before saying done. Profiles live on boxes the page cannot reach, and a harness cannot safely rewrite its own permissions. |
| **D8** | The Codex reviewer: `user` (the 2026-08-08 policy) or `auto_review` (the 2026-10-27 pick). *Open.* | Both have a cost. **`user`**: nobody answers the harness, so every prompted command is declined, and dj-codex can no longer commit, push or use `gh`. **`auto_review`**: it stays scoped to the `prompt_commands` it has now, and the page shows each guardian review's duration. Recommended: keep `auto_review` on that narrow scope, and fall back to `user` the first time a review runs past an hour. |
| **D6** | Tailscale for the fleet. | **Yes, for harness-to-channel traffic only.** Join nave.pub and add ACLs so each harness box reaches only its own channel endpoint. bunker.nave.pub joins for an admin path, but its public face stays, because signing travels over relays. Then close public port 22 to harness keys once every agent has moved over. |

## Retired by this work (criterion 6)

| Surface | Where it goes |
|---|---|
| beeswarm Grant/Revoke links (`nvoy beeswarm-view.mjs:23-30`) | Removed. beeswarm stays a status page and links to the agent's row on the board. |
| `#grant=` / `#revoke=` deep links (#611) | Kept as an entry point. They open the board with the change prefilled. |
| waggle Access and Agents tabs | Replaced by the board. The 30078 roster is read only for display names until the agent cards carry them. |
| nact Queue, Agents and Policy tabs | Redirected to the board. nact keeps its API: credentials, approvals and enact. |
| `grant.mjs issue` / `revoke` as the owner's path | Kept for scripts and recovery. Dropped from every owner-facing doc and runbook. |

## Build order

Each step is one PR, reviewed by mydude, with its deploy verified.

1. **nvoy C2:** `mcp/tools/admission.mjs`. The broker switches to it; behaviour is unchanged and proven by
   the existing suites.
2. **nvoy C3:** one relay set, plus a read that reports coverage. waggle's fold moves onto it, which
   fixes expiry and #457.
3. **nvoy C1:** the agent card is published on start and on manifest change. Check that all five
   cards are visible on the relays. The card also carries the harness's effective-profile report and
   the last admitted task and reply (criteria 9 and 10, tier 1). The harness turn receipts (tier 2)
   are a separate nvoy PR, and must land before criterion 10 can be checked.
4. **waggle M1:** the one list, read-only, covering criteria 1, 2, 4, 9 and 10. Every key from every source
   lands on it, and a test asserts that no source can contribute a key the list drops.
5. **waggle M2:** Change and revoke with a cold read-back (criterion 3).
6. **waggle M3:** What happens if (criterion 5).
7. **Retire:** beeswarm links, the tabs, the nact redirects and the docs (criterion 6). Then the
   cold test (criterion 7).
8. **Onboarding:** `nvoy-provision`, the Tailscale join, the install line and the briefing.
   HR, crusty and crystalclaude (criterion 8). This session's own posting identity, waggle-dev, was
   done by hand on 2026-10-26.

## Out of scope

- Multi-owner hives. There is one owner today, and the model allows more without building for them.
- Editing manifests from the page (D3).
- The approval path for outbound actions. It is unused (0 of 204), so the page shows only whether an
  agent has one.
- Moving agents between boxes after onboarding.
