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
- `sign_event:22242`: room-read auth.

It does not get `nip44_decrypt`, `sign_event:440/441` or any posting kind. So it can't read
receipts sealed to James, issue or revoke a grant, or speak in a room.

**James grants it with one NIP-DA event:** kind 440, `p` = the delegate, `da-cap onboard`, scope =
the hive. That is the hive's existing delegation layer (waggle `SPEC_EXTERNAL.md`, NIP-DA), so the
console already shows it, and it is revocable with one kind 441. Three changes would honour it:

- **nvoy `onboard_request.mjs`.** Accept an `add_agent` signed by a key that holds a live
  `onboard` grant from a grantor of the template, as well as from the grantor itself. The request
  is then treated as the grantor's (`owner` = the grantor), so receipts stay sealed to James.
  Delegate requests are refused when:
  - `like` names a template outside `onboard_templates` in the fleet config. Today that would be
    `mc-claude` and `crystalclaude`.
  - any `giver` is set. Who may task the new agent stays a grant, so stays James's.
  - more than 3 new names a day come from the delegate.
- **`bind_runtime` from the delegate only with a staged key.** The runner refuses a delegate bind
  unless `<request>.staged-channel.pub` exists and matches it. Today the staged file is an
  optional cross-check (Hive `nvoy-onboard-stage-request-id-source`). For the delegate it becomes
  mandatory. The staged key is read from the box by a herd-deploy action (Part 2's
  `stage-channel-key NAME`, which runs as root on herd-cloud). So the delegate can only bind the
  key that the agent's own box made. It can never bind a key of its choosing.
- **nave.pub writers.** Let the relay read a second list, `nave-relay-writers-delegate` (kind
  30000), signed by a key in the relay's `delegates`. It may only *add* agent keys that also appear
  in a live `add_agent`. James's own list stays authoritative, and a key on the delegate list only
  is dropped when its request expires (7 days).
- **Invites.** The hive admission API accepts a mint from the delegate when it holds the
  `onboard` grant, single-use, 24 h, max 1 use. That is the same as the page mints today.

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

### What stays James's

- **Making the agent's key and approving its pairing link.** Both happen in his Bunker, and the
  key is his.
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
   - the `onboard` grant check in `onboard_request.mjs`;
   - the template allowlist, daily cap, no-giver rule and mandatory staged key;
   - tests for each refusal.
4. nave.pub: the delegate writer list. hive admission: the delegate mint.
5. James:
   - makes the `nvoy-onboard-delegate` key in his Bunker;
   - pairs it with the listed permissions;
   - signs one `onboard` grant.

   That's the first use of his Bunker for this. The next agent is then onboarded by Dead Rabbit
   end to end, with James approving only its pairing link and its grants.

## Open questions for James

- Should the holder be Dead Rabbit, or a dedicated seat with no other duties? A dedicated seat is
  cleaner but adds another agent to keep alive.
- Is a daily cap of 3, with a template list of `mc-claude` and `crystalclaude`, right?
- Should the delegate's writer list live on nave.pub? The alternative keeps the writer list
  James's, which costs him one signature per agent.
