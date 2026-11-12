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
- `sign_event:27235`: NIP-98 for the invite mint, never published.
- `nip44_encrypt`: to seal the invite to the new agent.
- `nip44_decrypt`: for its own receipt copy. It opens only messages sealed to the delegate's key,
  never James's.
- `sign_event:22242`: room-read auth.

It does not get `sign_event:440/441` or any posting kind. So it can't issue or revoke a grant, or
speak in a room.

**James grants it with one NIP-DA event that also carries his standing consent.** It is kind 440,
`p` = the delegate, `da-cap onboard`, scope = the hive. That is the hive's existing delegation layer
(waggle `SPEC_EXTERNAL.md`, NIP-DA), so the console already shows it, and it is revocable with one
kind 441. The same signed event carries the two statements that only James can make:

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

- **Discovery, `onboard_watch.mjs`.** Today it fetches kind 30078 from template grantors only
  (lines 79–85). It would also read each grantor's kind 440 `onboard` grants and their 441
  revocations from the same relays, cold. Every tick it would add each live grantee to the authors
  it fetches setup requests from. A revoked grant drops its delegate from the next tick's authors.
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
- **Removing.** The delegate can remove only keys it added. James's own list can remove any key.
- **Revoking the delegate** freezes its list at the last version signed before the 441's
  `created_at`. New additions stop at once, and already admitted agents keep writing. James
  removes an agent explicitly, never as a side effect of revoking the delegate.
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
- **Revoking.** Any one of these stops the delegate:
  - a kind 441 on the `onboard` grant, from the console, which takes effect at the next 30 s tick;
  - deleting the Bunker connection, which stops signing at once;
  - removing the key from `onboard_templates` or the relay's `delegates`, as a herd-infra PR.

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
   3. runs `systemctl restart buzz-agent@NAME`;
   4. waits `STEADY` seconds as `buzz-agentctl` does and reports active or the masked journal tail.

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
2. Dead Rabbit runs `buzz-redeploy murphy` first, then the other four. Murphy gets its list today
   without the Mac.
3. nvoy:
   - delegate discovery (`onboard_watch.mjs`);
   - authorization and consent (`onboard_request.mjs`);
   - owner and signer recording, plus the delegate receipt copy (`onboard_run.mjs`);
   - the effective writer check;
   - the template allowlist, daily cap, no-giver rule and mandatory staged key;
   - tests for each refusal, and for a revocation that drops the delegate on the next tick.
4. nave.pub:
   - the durable delegate writer list;
   - the freeze when the delegate is revoked;
   - the signed effective writer set.
5. hive admission: mint and claim bound to the target key, with the grant checked at both.
6. James:
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
