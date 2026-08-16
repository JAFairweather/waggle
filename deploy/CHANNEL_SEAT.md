# Seating an agent's channel key on the broker

`channel-authorized` is the row that had no answer. An agent's MCP channel is an ssh invocation to
the broker under a forced command; for it to work, the agent's channel **public** key has to be in
the broker's `authorized_keys` under that command. Nothing wrote it, so `connect-agent --check`
reported UNKNOWN forever and a fresh agent finished install with a correct stanza, a correct
keypair, and a channel that could not connect (#488).

This is the actuator that writes it, and the receipt that lets the agent's own machine prove it
happened.

## What is deployed, and where

| Piece | Host | What it is |
|---|---|---|
| `tools/channel-seat.mjs` | broker | the sshd forced command. Takes no argv, reads stdin, writes a receipt to stdout |
| `WAGGLE_SEAT_CONFIG_FILE` | broker | a 0600 root-owned JSON file. Owns every byte the requester does not |
| `journal_path` | broker | one `<event-id>.json` per intent, written `O_EXCL`. The replay guard |
| the receipt | agent | passed to `connect-agent --check --seat-receipt <path>` |

The config:

```json
{
  "version": 1,
  "instance": "pi-oliver",
  "forced_command": "/opt/waggle-broker/bin/channel",
  "authorized_keys_path": "/etc/ssh/authorized_keys/nvoy-channel",
  "journal_path": "/var/lib/waggle-seat/journal",
  "approvers": ["<64-hex approver public key>"]
}
```

`authorized_keys_path` must already exist. The runner will not create it: a runner that creates the
file it seats into will happily seat into one sshd never reads, and report success.

## What the requester may choose

The key. Nothing else.

Every byte of the options field — `restrict`, the forced command, the instance it serves — comes
from the config above. An authorized_keys line is a grant of execution and its options field is
where that grant is bounded, so an intent carrying its own options is **refused**, not sanitised:

```
restrict,command="/opt/waggle-broker/bin/channel pi-oliver" ssh-ed25519 AAAA… <agent-64-hex>
```

The comment is the agent's own public key, so a seat is attributable to an identity rather than to
whoever pasted it.

## The intent

A kind:30078 event signed by a key on `approvers`, `d` tag `waggle-channel-seat`, content the
canonical JSON of:

```json
{"agent":"<64-hex>","key":"ssh-ed25519 AAAA… comment","op":"channel_seat","v":1}
```

It is delivered over ssh to the forced command — not published to a relay. Four things gate it:
the approver signature, a 15-minute freshness window, the `d` tag, and the journal. Freshness and
the journal are both about the same hazard: **a signed intent is a bearer artifact**. Whoever holds
the bytes can present them again, and re-presenting one after the owner removed a key would re-seat
it, with nothing about the resulting file looking wrong.

## Four outcomes, and why the middle two are not one

| Result | Meaning | Promotes the row |
|---|---|---|
| `seated` | not present; the line was appended | yes |
| `already-seated` | the exact line was already there | yes |
| `conflict` | something for this agent, or this key, is present and **different** | no |
| `refused` | the intent is not admissible | no |

`conflict` exists because the tempting implementation is "append if the exact line is absent", which
silently double-seats a rotated key: the old line still authenticates, so a key the owner believes
they replaced still opens the channel. Removing the old line is a deliberate act, not a side effect
of asking for a new one.

## The agent side

```
node tools/connect-agent.mjs --name <agent> --check --seat-receipt /path/to/receipt.json
```

The receipt carries a fingerprint — the one `ssh-keygen -lf` prints — never the key line, and no
path, host or command. A receipt for **this** agent's channel key promotes `channel-authorized`. A
receipt for a different key is a real negative and reads MISSING. No receipt at all leaves the row
UNKNOWN, which is what it was before and is never a pass.

Like `--whoami` (#462), a receipt is a saved capture: no freshness, no binding to the broker's
current file. It proves the seat happened, not that it still stands. The row says so.

## Verifying it, rather than assuming it

Neither of these is proven by the seat returning `seated`.

1. **The channel answers.** From the agent, run its registered channel and complete an
   `initialize` + `tools/list` handshake. A broker answering `NVOY_NOT_DELIVERED` proves the broker
   is reachable and proves nothing about attachment.
2. **The negative control fires.** Present an intent for a key that is *not* seated and confirm the
   broker refuses the connection. A gate that has only ever admitted is a gate nobody has tested;
   an alarm that always fires and one that never fires fail identically.
