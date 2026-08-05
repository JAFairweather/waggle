# Working on waggle

Auto-loaded by Claude Code sessions in this repo. Read it before touching anything.

Host-specific operations — deployment paths, channel ids, how to reach the boxes, how to message
the crew — are **not** here, because this repo is public. They live in the operator's private
brief, **`~/.buzz/GUIDES/WAGGLE_BRIEF.md`** on the maintainer's machine (which supersedes the older
`CLAUDE_OPERATING_RUNBOOK.md`).

**If you cannot reach that brief, you are in a limited environment** — e.g. a cloud container with
only this repo cloned, no `~/.buzz`, no `~/Projects`, no `buzz`/`gh` CLI. That is expected, not
broken. When it happens:

- **First, confirm the GitHub MCP is connected — it is your only lever.** It replaces `gh`
  (`list_pull_requests` / `list_issues`), and opening a PR is how you land *everything*. Verify with
  a read; opening a PR also needs push/create access. If it is not up, that is a **setup blocker to
  raise, not to work around** — without it you can neither see the backlog nor deliver work. Say when
  you are using the MCP in place of `gh`.
- You do **not** need, and cannot use, the **nvoy/Buzz MCP** here — it is key-gated and lives on the
  maintainer's node. Do not reach for it or wait on it.
- Work the **repo surface** — code, tests, design, and spec/research issues — and land every change
  as a **PR for the maintainer to merge**. Never push to a live host or restore host privilege.
- **Do not guess operational procedures** (relay-lane sends, crew contact, deploy). Being unable to
  check is not permission (`docs/AGENT_BRIEF.md`). Ask the maintainer to paste the brief section you
  need, or scope your work to what the repo alone supports.

**How work is delegated and reviewed here** (so a limited session knows where its reach ends): the
maintainer runs an agent crew — see `docs/SPEC_EXTERNAL.md` for the roles (writing lead, read-lane
engineer, outbox engineer, research & verification). Substantive PRs get adversarial review from the
crew before merge. **You cannot reach the crew from a limited environment** — that needs the private
brief's tools. So: open your PR, note who should review it and why, and **hand it up** — routing to
the crew and merging happen through the maintainer or a Buzz-capable session. Do **not** block
waiting to reach the crew yourself; deliver the PR and continue.

---

## What this is

**waggle** — a non-custodial, quarantine-gated two-way bridge between a walled Buzz community and
public Nostr. A private community is valuable *because* it is walled, and the wall is exactly what
stops its members reaching anyone outside it. waggle treats that as **routing**, not permissions:
the wall stays up, and the door is per-message and consensual in both directions.

**Four lanes, one process:**

| Lane | Direction | What crosses | What waggle sees |
|---|---|---|---|
| Out door | community → open | a member's note, signed by **their own** key | it routes, it does not author |
| In door | open → community | replies, into a **default-closed quarantine** | everything — it is public |
| Sealed lanes | both | direct + group traffic | **nothing** — envelope and derived address only |
| Return lane | community → guest | a mention, to someone the community relay will not serve | the envelope |

Gates A1–A7 sit across those: quarantine, dedup, watermark, backfill cap, timestamp clamp, rate
caps, deletion propagation. Every refusal is logged with its reason.

---

## Claims that must never drift

These have each been wrong in a shipped artifact at least once. Check them in **rendered output**,
not in the source you edited.

- **waggle holds exactly one private key — its own — and no other member's.** Never "holds no
  private key", never "never holds a key", never "nothing on the box worth taking". waggle *is* a
  member. That key is the thing worth taking, which is *why* the identity is lean and re-mintable,
  why the tripwire exists, and why rotation is the remedy. **A bounded loss, not no loss.**
- **A granted participant *posts in* as a first-class member.** The write half is exact. The read
  half is not: the community relay will not serve an external key, so what reaches an outside
  agent is the return lane — **mentions only**. Do not claim read.
- **You act as your OWN participant key, never as the bridge.** The designed onboarding (#141) is
  that a session mints an *ephemeral* key, requests a maintainer grant, acts, and burns it — no
  persistent key held. That reinforces this repo's core rule, it does not bend it: signing as
  waggle is impersonation; signing as your own admitted key is the mechanism. (Operational
  procedure lives in the private brief; #141 is partly built — do not describe it as shipped.)
- **Shipped is never blurred with designed.** If a thing is landed-but-undeployed, say so.
- **`waggle` is always lowercase.** Including UI wordmarks; the shared Nave titlebar uppercases app
  names, so waggle surfaces override it locally.
- **Never print keys, nsecs, secrets, or host IPs** — in output, files, commits, or issues. Refer
  to hosts by role.

---

## How work happens here

- **⚠ Merging to `main` deploys.** The pull-based deploy runner (`deploy/README.md`) polls `main`
  and ships the first CI-green commit it finds to the production bridge, within minutes and with no
  human step in between: **"merged + CI green" *is* the authorisation.** The review bar and the
  merge button are therefore the same lever. Open a PR and let the maintainer merge it; do not
  merge your own work unless asked, and never merge anything you would not want running in
  production that minute. If something must land without shipping, that is what pinning `WB_REF`
  to a tag is for.
- **A substantive PR is read by someone who did not write it, before it is merged.** Not a style
  preference — the merge button ships to production (above), so the author-reads-own-work path has
  no second pair of eyes anywhere in it. Earned 2026-08-01: #168 was careful work that passed
  review-by-CI with 18 green suites, and shipped a defect that permanently dropped every sealed
  message to one recipient. The review that found it was posted 25 minutes after the merge. **CI
  green is not a review** — every fixture in that suite used a name with no space in it, and the
  bug was a name with a space. *Substantive* means: touches a delivery path, a gate, a key, or the
  deploy runner. Docs and tests are exempt.
- **Land the fix before the next thing.** Six merges went out in under an hour that day, three of
  them shipping code and restarting production, and the incident was found in the middle of it.
  When something is known broken in production, nothing else merges until it is fixed and the fix
  is observed working on the box.
- **Issues-first.** Every item becomes a GitHub issue before code.
- **Check open PRs before starting an issue.** This has been violated: two pieces of work were
  built twice because nobody looked. `gh pr list --state open` costs nothing.
- **Code lands via PR that the maintainer merges.** Doc-only may go to `main` with an issue ref —
  though today even a docs-only commit triggers a deploy tick and restarts the lane (#162), so it
  is less free than it sounds.
- **Commit trailer is exactly `Co-Authored-By: Claude <noreply@anthropic.com>`** — no model
  identifiers anywhere, trailer included. PR bodies end *"Drafted with assistance from
  [Claude Code](https://claude.com/claude-code)"*.
- **Rebase before merging an older branch, and read the result.** A branch that predates a change
  can silently revert it — that has happened here, to a deploy-verification step.

---

## Verification discipline

The governing lesson, earned repeatedly: **every real bug in this project was invisible to a test
that merely ran.** The suite was green through all of them.

- **Cold read-back, never relay acknowledgements.** Relays return OK and drop; others 503 while
  the write succeeds. A publish is proven by fetching it back, from a fresh connection, by id.
- **Run the negative control.** A check that has only ever passed proves nothing. Make it fail on
  purpose once and watch it say so. An alarm that always fires and one that never fires fail
  identically.
- **Assert the property, not the mechanism — and assert both directions.** A test that only checks
  a guard *rejects* something cannot tell "refuses the dangerous thing" from "refuses everything".
  2026-08-01: a slot validator was asserted to throw on `Dennis @everyone`; it also threw on
  `My Dude`, a real recipient, and silently dropped every message to them. Green suite, live
  outage. Pair every refusal assertion with one that a legitimate value still gets through, and
  make the fixtures resemble production — every name in that suite was `A`, `B` or `Dennis`, so
  nothing with a space was ever rendered.
- **A command that prints nothing has told you nothing.** A send once failed silently because a
  path no longer existed; the exit status looked ordinary.
- **Syntax valid ≠ works.** `node --check` has passed on code whose identifiers did not exist.
- **`$?` after a pipeline** reports the last command in the pipe, not your script.
- **Assert anchors before a scripted edit** — a replace that matches nothing prints success.
- **Put a size floor on fetched input** — a scan of an empty file once reported everything clean.
- **Being unable to check is not the same as being fine.** Tools here exit **3 = INCONCLUSIVE**
  rather than 0 when they could not see enough to judge (`tripwire.mjs`, `verify-firewall.sh`).

---

## Tests

`npm test` — 43 suites, against the real exported functions with synthetic events. No sockets,
no production state, no writes outside a temp dir.

boot · suite roster · off-box policy protocol · policy journal · policy-owned Buzz artifacts · off-box policy service · forced-command policy runner · policy-host deployment · Nostr remote signer · read resilience · egress catalogue · egress ban · durable dedup store · relay fan-out · quarantine gating · deletion propagation · sealed-lane rate caps · grant
admission · admission return-lane lifecycle · message rendering · deployed-build verification · routing-policy snapshot · latency trace · return lane · return-lane scan · typed channel task carry ·
return-lane no-miss · return-lane pending · relay ingress · tripwire union · tripwire detection drill · deploy runner · console Host check · undelivered record · console pending requests · in-door consent · consent-request template · consent gate · consent ask · recipient DM relays · DM relay-list publisher · watchlist hot-reload · signed owner control state

CI runs them on push and PR. **If a run reports fewer than 43, the branch is on a stale base.**
The count of record is the `test` script in `package.json`; a prose count that disagrees with it
is the prose being wrong.

The rendering suite is the one to read when reviewing: it tests what the bridge **refuses**. A
hostile note tries to ping the approver, mint an `APPROVED BY` heading, break out of its quote and
open a code fence — and must come out inert *and still readable*, because a guard the approver
cannot read through is a guard that stops them approving anything.

---

## Where to read next

| | |
|---|---|
| `docs/SPEC_EXTERNAL.md` | architecture, gates, moderation model. **Generated — never hand-edit**; fix the internal source and regenerate |
| `docs/AGENT_BRIEF.md` | hand this to an agent joining a bridged community |
| `docs/KEY_CUSTODY.md` | what sealing buys, and what it does not |
| `docs/DM_TRUST_ALLOWLIST.md` | why listening is not obeying |
| `docs/CONCORD_CONSUMER.md` | the group-plane trust boundary |
| `deploy/README.md` | units, firewall, and the verification steps that prove a deploy rather than assume it |
| `SECURITY.md` | reporting, and what is *not* a vulnerability |

---

## Agent tooling

`tools/mcp_call.py` calls one tool on an nvoy MCP server from a session that does not have it
attached. **MCP toolsets bind at session start**, so a session that began before a server was
configured never receives its tools and no tool search will find them — while `claude mcp list`
still reports ✔ Connected, because that spawns the server to health-check it. **Connected is not
attached.** Confusing the two cost an hour once.

`tools/retract.mjs` publishes a NIP-09 deletion for a note this key authored, then checks whether
any relay still serves it — because deletion is a request, not a guarantee.

**Never ask an agent for its own key.** The administrator seats credentials directly. Secrets never
appear in argv, chat, or shell history.
