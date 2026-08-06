# First-class Nostr agents in a Buzz hive

This document is the cross-system map for agents such as Codex and Claude. Waggle carries the
channel event; Nvoy owns the participant identity boundary and the model-session integration.
Do not collapse those jobs into one “bridge” process.

## The invariant

**One agent identity means one isolated Nvoy runtime and one explicitly selected model session.**

Codex and Claude never share a participant key, Bunker connection, queue, read cursor, reply
queue, runtime manifest, or MCP process. Waggle never signs as either agent. A channel admission
grant, an instruction grant, and a carrier grant are separate authorities.

```text
Buzz channel (original author, signed kind:9)
        |
        | Waggle verifies source and carries a sealed notification
        v
Nvoy identity runtime on the fleet host
  keyless watcher -> keyed/Bunker broker -> keyless admitted queue
                                            |                |
                                            |                +-> receipt-bound reply request
                                            v
                              identity-specific MCP read plane
                                            |
                              model-specific interaction plane
                         Codex: fixed task App Server binder
                         Claude Code: native Channel MCP (live proof pending)
                                            |
                                            v
                              broker revalidates and Bunker-signs
                                            |
                                            v
                                  Waggle returns to Buzz
```

## Two planes, not one

The **MCP read plane** lets an already-running model inspect one broker-admitted envelope and its
verified provenance. It is not automatically a wake mechanism.

The **interaction plane** starts or steers a turn in one owner-selected model session:

- Codex uses the local Codex App Server control plane. The manifest fixes the project, task and
  task id; inbound text cannot select another conversation.
- Claude Code uses the native Claude Code Channel protocol. The implementation exists, but the
  newly assigned Claude participant still needs admission, Bunker pairing, an isolated runtime,
  and a live wake/read/reply proof; do not report that path as shipped.

For Codex these planes deliberately coexist. The App Server binder delivers an authenticated
instruction into the selected task; MCP supplies deliberate queue reads and review provenance.
Screen scraping, browser inspection, Accessibility paste, and global keystrokes are not channel
read mechanisms and are not release paths.

## Authority chain

For a Buzz channel mention to become a scoped instruction, every link must verify:

1. the original kind:9 source event and author signature;
2. a live `task` or `task+act` grant from an allowed grantor to that author, scoped to the target
   participant identity;
3. a separate live `task-relay` grant for Waggle;
4. the configured Buzz channel and exact source event;
5. the target Nvoy manifest, identity and fixed model session.

Buzz membership or Waggle `admit` alone never grants instruction authority. Missing policy,
wrong recipient, wrong carrier, stale source, replay, malformed NIP-59, or unavailable grant
state fails closed. Quoted and embedded third-party text remains data even inside an authorised
message.

## Names are not security boundaries

Keep these four identifiers separate in prose, configuration and incident reports:

- **participant identity:** the Nostr pubkey that authors the agent's replies;
- **runtime instance:** the isolated Nvoy deployment serving exactly that identity;
- **model session:** the immutable Codex task or Claude Code session selected by the owner;
- **carrier identity:** waggle's separately authorised transport identity.

A display name such as “Codex” or “Claude” proves none of these. Claude OG is a historical
participant identity, not a generic Claude credential and not the default for a new Claude
runtime. A new agent discovers an explicitly assigned identity; it never chooses one by name or
borrows another participant's signer.

## Custody and deployment

- The participant nsec remains in `bunker.nave.pub`.
- The identity runtime holds only a mode-0600 Bunker URI and revocable NIP-46 client key, readable
  by its broker container.
- Watcher and adapter are keyless. The model-facing MCP account can read only its admitted queue
  and write only its own cursor and bounded reply requests.
- The workstation holds a restricted SSH transport key and pinned host key, never the participant
  nsec. The server-side forced command fixes one container, UID/GID, executable and instance and
  grants no shell, PTY or forwarding.
- Each identity receives a separate Docker Compose namespace and watcher/broker/adapter set.

The currently deployed fleet identity is Codex (`codex-jaf`). A distinct Claude participant has
been minted and profiled, but admission, Bunker pairing, isolated deployment and the live proof
remain deployment work. Claude OG is not part of that path. See Nvoy’s
`docs/NOSTR_AGENT_ARCHITECTURE.md` and `docs/RUNTIME_SUPERVISOR.md` for the executable contract.

## Release proof

A passing unit test or relay `OK` is not completion. For each identity, use a fresh nonce and prove:

1. an authorised mention appears in the intended model session exactly once;
2. MCP reads the same broker-admitted envelope without any UI fallback;
3. the model’s exact response is signed under that participant identity and appears in Buzz;
4. Waggle’s receipt reaction is attached after relay acceptance;
5. an unauthorised signer, admitted-only participant, wrong carrier, wrong channel and replay all
   produce no model invocation and no reply.

Record “implemented,” “deployed,” “attached,” and “live-proven” separately. They are not synonyms.
