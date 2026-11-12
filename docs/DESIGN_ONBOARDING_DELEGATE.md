# Design: an onboarding delegate, and Buzz agents redeployed from herd-cloud

Status: **proposal for James.** Nothing here is granted or built. Grants, the Bunker and every
policy choice below are James's decision. Author waggle-dev, 12 Nov 2026, at James's direction
through Dead Rabbit (Buzz event `d69fce0b`). Hive: `hive-james-not-diagnostics-runner`.

## Why

On 12 Nov James was the hands for two setups: HR's join (Add-an-agent) and Murphy's restart.
Most of his steps were reads and pastes. Several pastes broke, because Buzz strips underscores,
and each one waited on him. His rule since then: agents run diagnostics and reads, and James is
asked only for his Bunker, a device, money or a policy call. Two things still need his hands for
no good reason:

1. **Add-an-agent.** Every setup request, writer list, invite and bind is signed by his key, on
   the page, by him.
2. **Buzz agents** (murphy, mydude, neil, dennis, kerouac). Their respond-to lists live only in
   the Mac's `managed-agents.json`. They reach herd-cloud only through Buzz's Start button, and
   Start changes nothing while a unit is running (Hive `buzz-herdcloud-start-noop-while-active`).

## Part 1: the onboarding delegate

### What James signs today, and what each signature is

| Page step | Event | Kind | Who must sign it now |
|---|---|---|---|
| 1–2 Make the agent's key | a new key in James's Bunker | — | James (Bunker) |
| 3, 5, 6 Setup request | `nvoy-onboard/NAME/add_agent` | 30078 | a grantor of the template agent (`onboard_request.mjs`) |
| 3 Relay writer list | `nave-relay-writers` | 30000 | the relay owner (nave.pub #157) |
| 3 Pairing link | approve `nostrconnect://` in the Bunker | — | James (Bunker) |
| 4 Bind its box key | `nvoy-onboard/NAME/bind_runtime` | 30078 | a grantor of the template |
| 5 Hive invite | mint (NIP-98, 27235) and NIP-44 seal | 27235 | a hive admin |
| 6 Work grants | `da-cap task` to each giver | 440 | James (a grant) |
| any Room read | relay auth | 22242 | whoever reads |

### The rule that shapes everything

The delegate **must not hold James's own key, even narrowed.** Bunker permissions are per kind
(`sign_event:30078`), not per tag. Kind 30078 is also the kind of every Hive memory claim,
`hive:canon` included. So a connection to James's key with `sign_event:30078` could write canon as
James. The delegate is therefore **its own key**, and James grants it a scoped right that he can
see and revoke. It never borrows his identity.

### Proposal

**A key named `nvoy-onboard-delegate`, held in James's Bunker.** It is made and paired exactly
like the runner key (nvoy `ONBOARD_PHASE_B.md`, "The runner key"), so its secret never leaves the
Bunker. Its connection asks for exactly:

- `get_public_key`
- `sign_event:30078`: setup requests only. The fleet ignores this key on every other 30078 (below).
- `sign_event:30000`: its relay writer list only (`nave-relay-writers-delegate`, below).
- `sign_event:27235`: NIP-98 for the invite mint, never published.
- `nip44_encrypt`: to seal the invite to the new agent.
- `nip44_decrypt`: for its own receipt copy. It opens only messages sealed to the delegate's key,
  never James's.
- `sign_event:22242`: room-read auth.

It does not get `sign_event:440/441` or any posting kind. So it can't issue or revoke a grant, or
speak in a room.

**The same-kind risk, and where it's closed.** A Bunker permission covers a whole kind, not one `d`
tag. So the delegate can sign *any* kind 30078 or 30000 event, not only the ones this design
means. That's safe only because authority comes from the signer, never from the kind. Each
consumer that trusts these kinds names who may sign for it, and only two would ever name the
delegate:

- **nvoy-onboard** accepts it for 30078 only under `d` = `nvoy-onboard/NAME/add_agent|bind_runtime`,
  within the limits below.
- **nave.pub** accepts it for 30000 only under `d` = `nave-relay-writers-delegate`. It refuses and
  doesn't store any other 30000 from that key, its own `nave-relay-writers` above all.

Everything else ignores the key, because it never names the delegate as a signer:

- Hive memory accepts 30078 only from its registered writers, and only James and his named
  writers for `hive:canon`.
- Buzz room lists and NIP-51 lists elsewhere are read only from their owners.

Other relays may store a stray delegate event, but nothing treats it as authority. The rollout's
tests include a delegate-signed `hive:canon` claim and a delegate-signed `nave-relay-writers`
list, and both must be refused. If James finds even that wider signing ability unacceptable, the
alternative is open question 3: no delegate writer list, and the writer entry stays his one
signature per agent.

**James grants it with one NIP-DA event that also carries his standing consent.** It is kind 440,
`p` = the delegate, `da-cap onboard`, scope = the hive. That is the hive's existing delegation layer
(waggle `SPEC_EXTERNAL.md`, NIP-DA), and it is revocable with one kind 441. Today's console can't
issue it yet; the rollout adds that. The same signed event carries the two statements that only James can make:

- `["policy", <terms version>]`: he accepts the hive's current terms for each agent this delegate
  adds;
- `["age", "confirmed"]`: his own age attestation.

`DESIGN_ADD_AN_AGENT.md` makes both the owner's act, and they stay his. The delegate never asserts
them. Its requests carry `["consent", <grant id>]` instead of the `policy` and `age` tags. The
fleet accepts that only while three things hold:

- the grant is live;
- the grant's `policy` equals the hive's current terms version;
- the grant was signed by a grantor of the template.

If the terms change, every delegate request is refused until James signs a new grant. That is one
signature per terms change, not per agent. If he would rather consent per agent, the page keeps
today's "I agree" step and the delegate waits for it. That is open question 4.

**Fleet changes (nvoy), at each place that today trusts only grantors:**

- **Discovery, in both fetch paths.** Today the watch tick (`onboard_watch.mjs` lines 79–85) and
  the per-name fetch in `onboard()` (`onboard_run.mjs`, `fetchEvents`) read kind 30078 from template
  grantors only. Both would also read each grantor's kind 440 `onboard` grants and their 441
  revocations from the same relays, cold. Each would add live grantees to the authors it fetches
  setup requests from. A revoked grant drops its delegate from the next tick's authors.
- **Fail closed.** A grant counts as live only if the tick's read of grants *and* revocations
  completed on a quorum of the configured relays. A partial or timed-out read counts as revoked
  for that tick. The tick then runs no delegate step, and reports "grant state unknown" rather than
  guessing.
- **Authorization, `onboard_request.mjs` `parseSetupRequest`.** It accepts a request whose
  `event.pubkey` is a grantor, as today, *or* the grantee of a live `onboard` grant from a grantor
  of the template. A delegate request is refused when:
  - `like` names a template outside `onboard_templates` in the fleet config. Today that would be
    `mc-claude` and `crystalclaude`.
  - any `giver` is set. Who may task the new agent stays a grant, so stays James's.
  - its `consent` is missing or stale (above).
  - more than 3 new names a day come from the delegate. The count is kept in the ledger.
- **Ownership and receipts, `onboard_run.mjs`.** A delegate request is recorded with
  `owner` = the grantor and `signer` = the delegate. The receipt stays sealed to the owner, so
  James can read every one on the page. The runner seals a second copy to the delegate under
  `d` = `nvoy-onboard:<request>:delegate`, *without* the `pairing` field. The pairing link is
  James's Bunker approval, so only he sees it.
- **Completion.** A request finishes only on the cold proofs it needs today: installed manifest,
  bind applied, writer listed (below), presence newer than the bind. The writer check reads the
  *effective* writer set, not only the owner's list.
- **Grant liveness at every step, not by timestamps.** The fleet never decides a delegate
  request's validity from its `created_at`. On every tick, and again just before `apply`, it
  checks that the signer's `onboard` grant is live in that tick's cold read. So a request
  backdated to before a revocation gains nothing. After a revocation:
  - **Queued requests** (seen, not yet run) are refused at the next tick with the reason
    "delegate revoked", and nothing is staged.
  - **An in-flight request** (staged, not yet started) is refused before `apply`, so no principal
    is seated. Its staged manifest is moved aside, as a superseded one is today.
  - **An already started agent** stays seated. Removing it is James's act: his deny list (below)
    and the existing offboard.
  - **The stop bound.** Today the runner parses authorization once, before its async steps.
    Instead, it re-reads grant liveness (fail closed, above) at each effect boundary: staging,
    pairing, the writer step, accepting the `bind_runtime`, `apply`, and (on the admission side)
    the invite mint and claim. Each is a fresh, complete read of grants and 441s, never the tick's
    cached answer. The guarantee is about effects, not wall-clock time: once a fresh check sees
    the 441, the delegate request causes no new effect. A runner can wait any length of time
    between steps, so no time bound is claimed. The watcher's 30 s is only a scheduling hint for
    when *queued* requests are next looked at: nvoy's `nvoy-onboard.timer` fires 30 s after the
    previous run *ends* (`OnUnitInactiveSec`), plus a small random delay, and a run may hold for
    pairing. The one exception is an effect that
    had already passed its check when the 441 arrived, such as an `apply` in progress. It
    finishes, and leaves an agent James removes with his deny list and offboard.
- **`bind_runtime` from the delegate only with a staged key.** The runner refuses a delegate bind
  unless `<request>.staged-channel.pub` exists and matches it. Today the staged file is an
  optional cross-check (Hive `nvoy-onboard-stage-request-id-source`). For the delegate it becomes
  mandatory. The staged key is read from the box by a herd-deploy action (Part 2's
  `stage-channel-key NAME`, which runs as root on herd-cloud). So the delegate can only bind the
  key that the agent's own box made. It can never bind a key of its choosing.

**nave.pub writers, durable.** The relay honours a second list, `nave-relay-writers-delegate`
(kind 30000), signed by a key that holds a live `onboard` grant from the relay owner. The relay
reads that grant cold, as the fleet does.

- **Lasting.** An entry is not tied to its request. It lasts until it is removed, so an admitted
  agent keeps writing after its request's 7 days.
- **Adding.** The delegate may add a key only when a live, unfinished delegate `add_agent` names
  it. The relay checks this against the setup request it already stores.
- **Removing.** The delegate can remove only keys it added.
- **James's override.** He keeps an owner-signed deny list, `nave-relay-writers-deny` (kind
  30000, his key). The effective set is (James's list ∪ the delegate list) − James's deny list. A
  key James denies is out even if the delegate lists it again, and only James can lift a deny. The
  signed effective set below proves the drop. Tests cover:
  - a denied key is absent from the effective set;
  - the delegate re-adding it changes nothing;
  - James lifting the deny restores it.
- **Revoking the delegate** goes by the relay's own order, never by `created_at`, because a signer
  can backdate that.
  - When the relay first stores the 441, it pins the event id of the last delegate list it had
    accepted.
  - From then on it rejects every new delegate list, whatever its `created_at`. The pinned list
    stays in force, so already admitted agents keep writing.
  - James removes an agent with his deny list, never as a side effect of revoking the delegate.
- **Cold read.** The relay publishes its effective writer set as a signed kind 30000 under its own
  key (`d` = `nave-relay-writers-effective`). The page and the runner read it cold, so "listed"
  means the relay actually enforces it.

**Invites bound to the agent.** A bearer code minted by the delegate could be claimed by any key,
so the admission API changes:

- **Mint.** It takes `for` = the new agent's pubkey and `request` = the `add_agent` id. It accepts
  the delegate only while its `onboard` grant from a hive owner is live, and refuses a `for` that
  the request doesn't name.
- **Claim.** It is accepted only when signed by that same `for` key. The `onboard` grant is checked
  again at claim time, so revoking between mint and claim makes the invite dead.
- **Lifetime.** Single use and 24 h, as today. The invite is still sealed to the agent, so the
  delegate never sees the code in clear after sealing. It holds the code only between mint and
  seal, as the page does today.

**Who holds it: Dead Rabbit's seat.** Dead Rabbit already speaks for James and runs herd-deploy.
It reaches the key only through a new MCP tool, `nvoy-onboard-driver`, never a raw signer. The
tool has four typed operations:

- `request NAME NPUB HARNESS LIKE ROOMS`
- `writers NAME`
- `invite NAME`
- `bind NAME` (reads the staged key itself)

Each operation drafts the event from that closed set, signs it through the Bunker connection and
reads it back. Then it posts one line in #waggle-test ("onboard: request hr like mc-claude, event
…"), so every use is visible. The tool is the only process given the connection's `bunker_uri_ref`
(root 0600, outside Dead Rabbit's home, like the runner's).

### The change to the Add-an-agent boundary, stated plainly

`DESIGN_ADD_AN_AGENT.md` reserves to James three things: signing setup requests, accepting terms
(with the age attestation), and grants. This design changes only the first. A key James granted
may sign `add_agent` and `bind_runtime` for agents within the limits above. Terms and age stay
his own signed statements, given once in the grant rather than per agent. Grants are unchanged.
If the design is approved, `DESIGN_ADD_AN_AGENT.md` gains a pointer to this section.

### What stays James's

- **Making the agent's key and approving its pairing link.** Both happen in his Bunker, and the
  key is his.
- **Accepting the terms and confirming his age.** He does this in the `onboard` grant he signs
  himself, and again whenever the terms change.
- **Every grant:** work (`task`), `mention`, `admit` and the `onboard` grant itself. Who may
  instruct an agent is never delegated.
- **Policy:** the template list, the daily cap and the room list.
- **Revoking.** Only a kind 441 on the `onboard` grant, signed from the console, revokes. The fleet
  honours it at its next fresh grant check before any new effect, and the relay as soon as it
  stores the 441. No wall-clock deadline is promised (see the stop bound above). From then on,
  setup requests not yet acted on, and every later change to the delegate list, are void, whatever
  their timestamps. The delegate list the relay last accepted stays in force, so already admitted
  agents keep writing, subject to James's deny list. Two other levers are partial
  and are not equivalent to revoking:
  - **Deleting the Bunker connection** stops *future* signatures at once, but requests already
    signed stay valid until the 441. Use it alongside the 441, not instead of it.
  - **Emptying `onboard_templates`** (a herd-infra PR) leaves no template the delegate may copy,
    so every new delegate request is refused. The grant itself stays live. The list holds template
    names, not the delegate's key.

So James's part per agent goes from about ten signatures and pastes to two Bunker actions (make
the key, approve its link) plus any grants he chooses to give it.

### Not proposed

- An MCP signer for the console page. The page stays James's own tool, and the delegate replaces
  the hands, not the page.
- Using the runner key as the delegate. The runner key seals and reports. Letting it also ask
  would make the fleet both requester and executor.

## Part 2: Buzz agents redeployed from herd-cloud

### Today

- Each seat's harness environment, including its nsec, reaches herd-cloud only via the Mac
  provider. The provider pipes it to `buzz-agentctl deploy` (forced command), which writes
  `/etc/buzz-agents/NAME.json` (root 0600).
- That deploy is a no-op while the unit is active. So a list change needs Shutdown, a wait until
  the unit is inactive, then Start. James did that on 12 Nov, and Buzz then showed no Start
  button.
- `herd-deploy codex-four start` restarts four seats from their files on the box. It cannot change
  a list, and it doesn't cover Murphy.

### Proposal

1. **Lists in herd-infra.** Each Buzz seat gets `agents/NAME/buzz-respond-to`: one 64-hex pubkey
   per line, with a comment naming who it is. It is reviewed like any herd-infra change, and it is
   **high-risk**, because it decides who may instruct the agent. That needs a different-model read
   plus a lead final.
2. **`buzz-agentctl` reads the repo list.** On every deploy, from the Mac or from the box,
   `BUZZ_ACP_RESPOND_TO=allowlist` and `BUZZ_ACP_RESPOND_TO_ALLOWLIST` come from the installed copy
   of that file. A list sent by the Mac is ignored and logged. So the two paths cannot disagree,
   and a Mac edit can no longer drift from the reviewed list.
3. **A herd-deploy action, `buzz-redeploy NAME <herd-infra commit>`.** It runs from a merged
   commit like every other action, and does four things:
   1. installs that commit's list for NAME;
   2. rewrites only the two respond-to keys in `/etc/buzz-agents/NAME.json`, atomically, keeping
      the nsec and everything else;
   3. restarts the unit, keeping its desired state (below);
   4. waits `STEADY` seconds as `buzz-agentctl` does and reports active or the masked journal tail.

   **It's a policy-only update, not a resume.** It changes who the agent answers and nothing else.
   It keeps the unit's state as it found it:
   - **How an owner stop is told apart, grounded in the harness.** `buzz-acp` logs "shutdown
     command from owner" when it handles a `!shutdown` (the string is in the installed binary).
     The exit status is not used: the current hook already treats exit 0 and TERM alike as a
     clean stop, and the harness drains gracefully either way. Instead, the hook reads the
     stopping invocation's own journal (`journalctl _SYSTEMD_INVOCATION_ID=<id>`) for that line.
     The rollout adds an acceptance check on a test seat before anything relies on it: a `!shutdown`
     must produce the line, and a `systemctl restart` must not. If a future harness changes the
     line, that check fails and the action refuses to run.
   - **The protocol.** Under the per-seat lock, the action:
     1. reads the unit's current `InvocationID`, I0;
     2. writes `/run/buzz-agents/NAME.restarting` naming I0, its own PID, and its own process start
        time (from `/proc/PID/stat`);
     3. calls `systemctl try-restart`, which restarts the unit only if it is running at that
        moment, so a seat the owner has already stopped is never revived.
   - **What the hook does.** It skips its disable only when *all* of these hold:
     - the file names the stopping invocation;
     - the process it names is alive with the same start time, so the action is still running;
     - the stopping invocation's journal has no "shutdown command from owner" line.

     Anything else disables as today. So a killed action can't leave a suppression behind: its
     PID is dead or reused with a different start time, and the hook ignores the file and
     disables. Nothing is left that a later TERM stop of I0 could match. The action deletes the
     file when it exits.
   - **A newer stop wins.**
     - A `!shutdown` that reaches I0 before or during the restart puts the line in I0's journal,
       so the hook disables.
     - A `!shutdown` that reaches the new invocation, I1, is an ordinary stop with no file naming
       I1, so the hook disables.
     - After `STEADY`, the action checks I0's journal once more. If the owner line is there but I1
       is running (the shutdown reached I0 too late to stop it), the action runs `systemctl stop`
       on I1, and the hook disables. The action itself never enables or starts anything, so there
       is no window in which it could undo a stop. Boot enablement is exactly what it was.
   - **Verify, then roll back on failure.** The action keeps a root-only copy of the previous
     `NAME.json`. Success means I1 is active for `STEADY` seconds and `is-enabled` is unchanged. If
     the new list fails (the unit's last result is not `success`), the action restores the
     previous file and calls `try-restart` once more under the same protocol. It never uses a plain
     `start`. A unit that has failed outright isn't running, so `try-restart` does nothing. The seat
     stays down with the old list restored until an authorized start, and nothing in the rollback
     can cross a newer owner stop. The action then reports the failure with the masked journal
     tail.
   - **A stopped seat** (inactive, as after a Buzz Shutdown) gets its file updated and stays
     stopped. The action has no start option and grants no new resume authority. A stopped seat
     is started only through a path that is already authorized: Buzz Start on James's Mac through
     the provider, or `herd-deploy codex-four start` for the four Codex seats. Either picks up the
     updated list. So a redeploy never revives a seat James stopped on purpose.
   - **One at a time.** `buzz-redeploy` and `buzz-agentctl deploy` take the same per-seat lock
     (`flock /run/buzz-agents/NAME.lock`). So a Mac Start and a herd-cloud redeploy can't
     interleave. A deploy that finds the lock held waits up to 60 s, then refuses with "redeploy in
     progress".
   - **Rollback** is running the action at an earlier merged commit. The list is just a file in
     git history, and the action records the commit it applied in `/etc/buzz-agents/NAME.list-commit`.

   Tests cover:
   - a running, enabled seat: restarted, still enabled;
   - a running, disabled seat: restarted, still disabled;
   - a stopped seat: file updated, not started;
   - an owner `!shutdown` before `try-restart`: no restart, and the unit stays stopped and
     disabled;
   - an owner `!shutdown` reaching I0 during the restart: the owner line is in I0's journal, so
     the hook disables;
   - an owner `!shutdown` reaching I1: the hook disables, and the action does nothing more;
   - the owner line found in I0 after I1 is up: the action stops I1, and the unit ends stopped
     and disabled;
   - a restart of the named invocation by a live action: enablement unchanged;
   - the action killed right after writing the file, then a later TERM stop of I0: the hook sees
     a dead or mismatched PID, ignores the file, and disables;
   - a failed start under the new list: the file is restored, `try-restart` is a no-op on the
     failed unit, and the seat stays down;
   - acceptance on a test seat: a `!shutdown` logs "shutdown command from owner" and a restart
     does not;
   - lock contention;
   - a rollback.

   **Murphy's case.** Today Murphy's file has `respond_to` owner-only with an empty list (Hive
   `buzz-murphy-respond-to-owner-only`). Because the action always writes
   `BUZZ_ACP_RESPOND_TO=allowlist` with the repo list, Murphy's first redeploy switches it to
   allowlist mode. Its list is James's decision (Hive `buzz-murphy-respond-to-decision`).

   It never prints the file. It refuses when `NAME.json` doesn't exist yet: a seat's first deploy,
   which brings its nsec, stays the Mac's. Dead Rabbit runs it after the merge. James's hands
   aren't needed.
4. **Part 1's staging lives here too.** `herd-deploy stage-channel-key NAME REQUEST` reads only
   `~/.nvoy-box/NAME/channel.pub` and writes the staged file to the fleet, as the operator helper
   does today.

**What stays James's:** a new Buzz seat's first deploy (its nsec comes from his Mac), every list
change (as a reviewed PR, which James or a lead approves), and the provider key itself.

**A known wart, not fixed here.** Buzz's UI will still show a remote seat green after a Shutdown,
with no Start. Buzz tracks its own deploy record and the seat's presence, never the unit. After
this change Start isn't needed for list changes, so the wart only matters for a seat's first
deploy.

## Rollout, if James approves

1. herd-infra:
   - the five `buzz-respond-to` files, from the 12 Nov hex lists;
   - `buzz-agentctl` reading them;
   - `buzz-redeploy` and `stage-channel-key` in herd-deploy.

   Each needs a different-model read and a lead final. Changing herd-deploy itself stays
   `bin/install-herd-deploy`, run by James.
2. Dead Rabbit runs `buzz-redeploy` for the four running seats, so each gets the reviewed list
   without the Mac. Murphy is stopped, so its file is updated but it stays down. It comes up on the
   reviewed list at its next authorized start: James's Buzz Start, or the provider deploy script.
3. nvoy:
   - delegate discovery (`onboard_watch.mjs`);
   - authorization and consent (`onboard_request.mjs`);
   - owner and signer recording, plus the delegate receipt copy (`onboard_run.mjs`);
   - the effective writer check;
   - the template allowlist, daily cap, no-giver rule and mandatory staged key;
   - tests for each refusal, and for revocation: a queued request is refused, an in-flight one is
     refused before `apply`, and a backdated request is still refused.
4. nave.pub:
   - the durable delegate writer list;
   - the freeze on the relay-observed 441, by pinned event id;
   - James's deny list;
   - the signed effective writer set, with tests for the deny precedence.
5. hive admission: mint and claim bound to the target key, with the grant checked at both.
6. waggle console: today `draftGrant` refuses the `onboard` cap. Add issuing, showing and revoking
   it on the grant grid, with the `policy` and `age` consent tags drafted from the terms James is
   shown. Nothing on the page ticks either one for him. Acceptance checks:
   - the page refuses to draft an `onboard` grant whose `policy` isn't the hive's current terms
     version, or without his own age tick;
   - the issued grant reads back cold with both tags;
   - a 441 from the grid reads back, and the fleet's next tick reports the delegate as revoked.
7. James:
   - makes the `nvoy-onboard-delegate` key in his Bunker;
   - pairs it with the listed permissions;
   - signs one `onboard` grant, which carries his terms acceptance and age attestation.

   That's the first use of his Bunker for this. The next agent is then onboarded by Dead Rabbit
   end to end, with James approving only its pairing link and its grants.

## Open questions for James

- Should the holder be Dead Rabbit, or a dedicated seat with no other duties? A dedicated seat is
  cleaner but adds another agent to keep alive.
- Is a daily cap of 3, with a template list of `mc-claude` and `crystalclaude`, right?
- Should the delegate's writer list live on nave.pub? The alternative keeps the writer list
  James's, which costs him one signature per agent.
- Should terms acceptance be a standing consent in the grant, once per terms version, or James's
  own "I agree" for each agent? Per agent keeps one tap per agent; standing consent removes it.
