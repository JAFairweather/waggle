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
  - more than 1 new name a day comes from the delegate (James, 12 Nov). The count is kept in the ledger.
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
2. **One policy artifact on the box: `NAME.json`.** The respond-to keys and their commit live only
   in `/etc/buzz-agents/NAME.json`. No separately installed list file exists on the box, so there
   is never a second artifact to drift from it.
   - **`buzz-agentctl deploy` (a Mac Start) keeps what `NAME.json` already holds.** When it
     writes the Mac's environment, it carries over `BUZZ_ACP_RESPOND_TO`,
     `BUZZ_ACP_RESPOND_TO_ALLOWLIST` and `BUZZ_HERD_LIST_COMMIT` from the existing file, in the
     same atomic write. A list sent by the Mac is ignored and logged. So a Mac edit can't drift
     from the reviewed list, and the policy and its commit move together.
   - **A seat's very first deploy** has no `NAME.json` yet. It takes the Mac's list once and
     marks it `BUZZ_HERD_LIST_COMMIT=mac-initial`, so inspect shows it as unreviewed until the
     first `buzz-redeploy`.
3. **A herd-deploy action, `buzz-redeploy NAME <herd-infra commit>`. It writes the file and
   nothing else.** It runs from a merged commit like every other action. It reads the list from
   that commit's checkout of `agents/NAME/buzz-respond-to` in memory, and validates it (64-hex
   each, non-empty) before any write. Then, under the per-seat lock (`flock
   /run/buzz-agents/NAME.lock`, shared with `buzz-agentctl deploy`), it:
   1. rewrites, in **one** atomic write of `/etc/buzz-agents/NAME.json` (temp file, fsync,
      rename), the two respond-to keys plus a third key, `BUZZ_HERD_LIST_COMMIT`, naming the
      commit. The nsec and everything else are kept. The harness ignores the extra key.
   2. reports the seat's state (active or not, enabled or not), installed versus live (below).

   **That rename is the only write**, so the action has no boundary to die between. If it dies
   before the rename, `NAME.json` is the old list with the old commit. After it, the file is the
   new list with the new commit. Either way, the next independently authorized start (a Mac
   Start, `codex-four start` for its own purpose, a crash restart or a reboot) runs exactly the
   pair `NAME.json` holds, and inspect reports exactly that pair as installed. Rollback is the
   same single write at an earlier commit, so it can't split the pair either.

   **It never stops, restarts or starts the unit, and never touches its enablement.** That is the
   whole point of this version. An owner `!shutdown` is handled by the harness itself, outside any
   lock we control. So any action that restarts or starts a process can race it, and earlier
   drafts of this section kept finding new orderings in which a restart outran a newer stop. An
   action that only writes a file can't revive a stopped seat, can't undo a stop, and leaves
   nothing behind if it dies: the file write is atomic, and the lock dies with the process.
   `buzz-agent-poststop` stays exactly as it is today.

   **How a new list takes effect: at the seat's next start, whenever and however that start is
   independently authorized.** The harness reads `NAME.json` only when it starts, so the new list
   applies the next time the seat starts. This design neither triggers that start nor schedules
   one. In particular, it does **not** use `herd-deploy codex-four start` as an activation step.
   That command acts on all four Codex seats at once: `enable --now` on every stopped one and
   `enable` on every running one. So using it to activate one seat's list could revive a
   different seat James had stopped, or re-enable one he had disabled. Starts stay what they are
   today:
   - Buzz Start on James's Mac through the provider. With item 2, `buzz-agentctl deploy` keeps the
     list and commit already in `NAME.json`, not the Mac's.
   - `codex-four start`, only when James or Dead Rabbit runs it *for its own purpose* (bringing
     the four up while the Mac sleeps), never as part of a list change.
   - A crash restart by systemd (`Restart=on-failure`) or a reboot of an enabled seat.

   An owner `!shutdown` at any point stands until one of those starts, exactly as today. This
   design adds no new way to start a seat. If James wants a list live sooner, he restarts that
   seat himself with Buzz Start. That is an owner act, and it can't override his own stop.

   **Reporting: installed versus live, separately.** For each seat, the action and `herd-deploy
   inspect buzz-agents` report two things:
   - **Installed:** the `BUZZ_HERD_LIST_COMMIT` and entry count in `NAME.json` now.
   - **Live:** what the running process actually loaded. `buzz-agent@.service` hands the file to the
     harness with `LoadCredential=env:/etc/buzz-agents/%i.json`, so systemd copies it at start into
     the unit's credential directory, `/run/credentials/buzz-agent@NAME.service/env`. That copy is
     what the harness read. Inspect reads the copy (as root, printing nothing but the commit, the
     mode and the entry count) and reports its `BUZZ_HERD_LIST_COMMIT` and respond-to fields. So
     the live list is observed directly, not inferred from timestamps. A file rewritten after
     systemd's copy shows correctly as installed ≠ live.
   - **Unknown, not guessed:**
     - If the unit isn't running, or the credential copy is missing or unreadable, live reads
       "unknown".
     - A copy written before this design has no commit key, so it reads "pre-design list" with its
       mode and count.

   A running seat on an older list shows as "installed <commit>, live <older commit>, applies at
   next start". The design never reports a list as live unless the loaded copy shows it.

   **Rollback** is running the action at an earlier merged commit. It is the same file write, and
   it takes effect at the next start. A bad list can't crash-loop a running seat, because nothing
   restarts it; it only matters at the next start, where the masked journal shows a failure and
   the previous commit is one action away.

   Tests cover:
   - a running seat: the file is updated, the unit is untouched (same InvocationID, same
     enablement), and the report says "old list until next start";
   - a stopped seat: the file is updated, and the seat stays stopped and disabled;
   - an owner `!shutdown` during the action: the unit ends stopped, and the action changes nothing
     about it;
   - the action killed mid-write: the file is either the old or the new version, list and commit
     together, never partial and never a new list with an old commit, and the unit is untouched;
   - a rewrite landing after systemd's credential copy but before the unit is active: inspect
     reports installed (new) ≠ live (old), read from the copy;
   - a stopped unit, or an unreadable credential copy: live reads "unknown";
   - the action killed before or after its single rename, then an independently authorized start
     and an inspect: the start runs exactly the pair `NAME.json` holds (old or new), and inspect
     reports that same pair as installed;
   - a Mac Start after a redeploy: `NAME.json` keeps the redeployed list and commit, and the Mac's
     list is ignored and logged;
   - a first deploy with no `NAME.json`: the Mac's list is written with commit `mac-initial`, and
     inspect shows it as unreviewed;
   - lock contention with `buzz-agentctl deploy`;
   - a rollback to an earlier commit;
   - a non-hex or empty list: refused before any write.

   **Murphy's case.** Today Murphy's file has `respond_to` owner-only with an empty list (Hive
   `buzz-murphy-respond-to-owner-only`). Because the action always writes
   `BUZZ_ACP_RESPOND_TO=allowlist` with the repo list, the redeploy switches Murphy's file to
   allowlist mode, and Murphy runs on it from its next Buzz Start. Its list is James's decision
   (Hive `buzz-murphy-respond-to-decision`).

   It never prints the file. It refuses when `NAME.json` doesn't exist yet: a seat's first deploy,
   which brings its nsec, stays the Mac's. Dead Rabbit runs it after the merge.
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
   - the five `buzz-respond-to` files, from the 12 Nov hex lists (read only by `buzz-redeploy`);
   - `buzz-agentctl` carrying the respond-to keys and `BUZZ_HERD_LIST_COMMIT` over from the
     existing `NAME.json` and ignoring the Mac's list (item 2). It never reads the repo files;
   - `buzz-redeploy` and `stage-channel-key` in herd-deploy;
   - executable tests for every case listed in this design. The "Tests cover" lists here are
     the required coverage for those implementation PRs; this design PR adds no tests itself.

   Each needs a different-model read and a lead final. Changing herd-deploy itself stays
   `bin/install-herd-deploy`, run by James.
2. Dead Rabbit runs `buzz-redeploy` for all five seats. That is file-only. Each seat comes up on
   its reviewed list at its next independently authorized start, and `inspect buzz-agents` shows
   installed versus live per seat until then. For Murphy, which is stopped now, that next start is
   James's Buzz Start, or the provider deploy script.
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

## James's decisions (12 Nov 2026)

Recorded in Hive `waggle-onboarding-delegate-policy-decision` and relayed by Dead Rabbit (Buzz `374079c9`):

- **Holder:** Dead Rabbit's seat holds the delegate, through the typed tool only.
- **Cap and templates:** at most **1** new agent a day from the delegate, not 3. Templates: `mc-claude` and
  `crystalclaude`.
- **Writer list:** the delegate writer list lives on nave.pub, as designed above, with James's deny list and the
  relay-ordered freeze.
- **Terms:** a standing consent in the `onboard` grant, once per terms version, as designed above.

These settle the open questions this design ended with. Part 1 can now be built. Its implementation PRs (nvoy,
nave.pub, hive admission, waggle console, the delegate MCP tool) each need a different-model read and a lead final.
