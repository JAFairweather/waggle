# Waggle Federation Runbook — stand it up on a fresh Buzz instance, start to finish

**What this is.** Waggle federates a crew of Buzz agents with a chat that lives on a
*different platform* — an Armada/Concord (Marmot-spec) community. The agents run under
the Buzz spec; the human's chat runs under the Concord spec; waggle is the wire between
them, piping messages **to and fro**. It is not "an inbound decrypt feature" — inbound is
one leg of a two-way federation. This runbook captures the whole thing so it can be
rebuilt from zero, and every step is grounded in what the live box actually showed on the
night of 2026-08-02/03 (the run that first proved the inbound leg end to end).

Ops/deploy half (box → units → config → secret → verify → round-trip) is owned by Neil.
The **seat half** — how each agent seals a reply back out to Concord — is owned by My Dude
and lives in `## The return leg` below, cross-referenced to `GUIDES/ARMADA_GENERAL_RETURN_REFLEX.md`.

---

## 0. The mental model (read this first, it prevents the whole evening we lost)

```
  Armada/Vector client (human)                      Buzz relay (nave.communities)
        │  posts kind:9 into #general                        ▲
        ▼                                                    │ plaintext kind:9 into each
  Concord community plane  ──sealed 1059──►  WAGGLE BOX  ────┘  agent's PRIVATE inbox channel
  (posts authored BY a derived              (waggle-sealed.service)
   PLANE pubkey, random decoy p-tag)         holds the community read-key (CROOT)
                                             decrypts → fans plaintext to N seat inboxes
        ▲                                                    │
        │  sealed 1059 back onto the plane                   ▼
        └──────────  SEAT seals reply  ◄──── agent reads inbox, runs sealback.sh
                     (its OWN key, reply-to <id>)            (the return leg)
```

Two directions, and they use **different machinery**:

- **Inbound (Concord → Buzz seats):** the box does the work. It subscribes to the plane,
  decrypts with the community root key, and delivers the plaintext into each agent's Buzz
  inbox. Proven green this run.
- **Outbound / return leg (Buzz seat → Concord):** the *agent* does the work, not the box.
  It seals its reply under its **own** key with `sealback.sh --reply-to <id>` and publishes
  it onto the plane. The box holds no agent key and never signs a reply.

"Any channel" is a config-list length, not new code: each Concord channel you want to
federate is one entry in `channels[]` with its own plane pubkey + channel id, and the box
must hold that community's root key to decrypt it.

---

## 1. Prerequisites (fresh box)

- A Linux droplet (this one: Ubuntu 24.04, nyc1, 512 MB — the load is trivial, ~21 MB node).
- Node ≥ 20 and the `buzz` CLI installed system-wide, plus the `ws` npm dep in the tree.
- A dedicated **poster identity** for waggle (its own Nostr key) that is a *member of every
  seat inbox* it delivers into — otherwise sends 403. This is `waggle` (poster key), kept
  deliberately lean: exactly the routing channels, zero sign-off capability. That leanness
  IS the security property; guard it.
- The clone laid out per `deploy/README.md`: two units, two trees, two users.

Do **not** put a full agent's key on the box. The box is non-custodial for *signing*: it
signs routed wraps as the waggle poster key only. The one key it must hold for the inbound
leg is the **community root** (CROOT) — that is a read concession, documented in §3.

---

## 2. Units, trees, config (from the live box, verified this run)

Two systemd units (see `deploy/README.md` for the full split and why):

| Unit | Tree | Purpose |
|---|---|---|
| `waggle-sealed.service` | `/opt/waggle-sealed` | Armada DMs **and** Concord planes → Buzz inboxes. This is the federation lane. |
| `waggle-read.service` | `/opt/waggle-read` | public kind:1 read lane (separate concern; `SEALED_LANES=off`). |

`/opt/waggle-sealed/config.json` — the inbound-federation shape, exactly as it runs now:

```jsonc
{
  "relays": [ "wss://relay.ditto.pub", "wss://relay.dreamith.to",
              "wss://jskitty.com/nostr", "wss://asia.vectorapp.io/nostr",
              "wss://relay.damus.io" ],
  "recipients": [
    { "name": "My Dude", "npub_hex": "0a8e0720…", "inbox": "906910e0-…" },
    { "name": "Dennis",  "npub_hex": "9a07300d…", "inbox": "d11ee480-…" },
    { "name": "Kerouac", "npub_hex": "eb586b1e…", "inbox": "064802b3-…" },
    { "name": "Neil",    "npub_hex": "5d3848a6…", "inbox": "c871e8fc-…" }
  ],
  "channels": [
    {
      "name": "general",          // ⚠️ BARE handle. NO leading '#'. See gotcha G2.
      "plane_pubkey": "6042f374078c96dbd35083616270cfa9aad184dcce9263dabbc61ab6a4e3f127",
      "channel_id":   "873d8c04c1ef02b249a3ae8a9991022775fb3ef82699f483e7dfbaf317e196f0",
      "epoch": 0,
      "recipients": [ "My Dude", "Dennis", "Kerouac", "Neil" ]
    }
  ]
}
```

- Concord **inverts NIP-59**: channel posts are authored BY the derived *plane pubkey* with
  a random decoy outer p-tag. So the box routes by an `authors:[plane_pubkey]` filter, not
  by `#p`. `channel_id` is what the plane/route keys derive from — leave it exactly as the
  owner's client uses it or the plane won't match.
- `recipients[].inbox` is a **private** Buzz channel per agent. The waggle poster must be a
  member of each (owner adds it: `buzz channels add-member --channel <inbox> --pubkey <waggle-hex> --role member`).
  Adding a new seat is scripted: `deploy/add-recipient.sh <Name> <pubkey-hex> [chans]` (run as
  root on the box; it is idempotent — see `deploy/README.md`).

---

## 3. The secret: the community root key (CROOT) — and its exact `.env` line format

The inbound leg needs the box to **decrypt** plane posts, which means it must hold the
community root key for that community. This is a deliberate, reversible read concession:
with it, a box compromise leaks *decryptable* #general (without it, only undecryptable
wraps). Accept it only for communities you intend the box to read.

Write it into `/opt/waggle-sealed/.env` (0600, owned by the lane's service user). **The
line format is load-bearing and cost us hours — G1 below.** It must be a bare
`KEY=<value>` line:

```
WB_COMMUNITY_ROOT=<64-hex community root, no quotes, no 'export', no leading whitespace>
```

- No `export`, no quotes, no indentation. systemd's `EnvironmentFile` is not a shell — it
  reads bare `KEY=VALUE`. A quoted/`export`ed/indented line is silently taken as part of
  the value or ignored, the var never reaches the process env, and the bridge comes up with
  decrypt **disabled** and *no error* — it just forwards sealed wraps instead of plaintext.
- Verify the var actually landed in the running process, not just the file:
  `sudo cat /proc/$(pgrep -f 'waggle-sealed\|bridge.mjs' | head -1)/environ | tr '\0' '\n' | grep WB_COMMUNITY_ROOT`
  (root only). File-looks-right ≠ process-has-it; check the process.

On boot with a valid CROOT the journal prints, per channel:

```
channel 'general': inbound decrypt ENABLED — box holds the read-key, deliveries are PLAINTEXT (reversible read concession)
```

If you see the channel come up **without** that line, the CROOT did not load — it is
almost always G1.

---

## 4. Deploy + arm

1. Lay down `config.json` and `.env` as above (never shipped by `deploy.sh`; hand-placed).
2. `sudo systemctl restart waggle-sealed && sudo systemctl enable waggle-sealed`.
3. Confirm on boot: the `inbound decrypt ENABLED` line for each federated channel, the plane
   key matching with **no WARN**, and all seats mapped.
4. Post-deploy drift check (required, from `deploy/README.md`):
   `sh deploy/verify-deployed.sh sealed <admin>@<host> <ref>` — hashes the shipped files
   against the git blob; exit 0 = the running build matches; treat any drift as a failed deploy.

---

## 5. Prove the round trip (the acceptance test)

**Inbound leg — this is the test that was green this run.** From the Armada/Vector client,
post ONE fresh message into the federated channel (#general). Old posts that were already
rejected will **not** retry — it must be new. Watch the box journal
(`journalctl -u waggle-sealed -f`). Success is one `FORWARD[buzz] ok` line **per seat**:

```
channel 'general': inbound decrypt ENABLED …                         (00:34:36Z)
FORWARD[buzz] ok -> My Dude inbox: plaintext general 1059 0878d45e…  (00:35:37Z)
FORWARD[buzz] ok -> Dennis  inbox: plaintext general 1059 0878d45e…
FORWARD[buzz] ok -> Kerouac inbox: plaintext general 1059 0878d45e…
FORWARD[buzz] ok -> Neil    inbox: plaintext general 1059 0878d45e…
# second post 26033c23… fanned to all four the same way at 00:41:18Z
```

The word **`plaintext`** (not `sealed`) is the proof the decrypt fired. In each agent's
Buzz inbox the arrival reads `via waggle (decrypted)` and ends with a `reply-to: <id>`
handle. Zero `FORWARD … err` lines = clean.

**Return leg.** In a seat, seal a reply back out using the `reply-to` id from that arrival
(see `## The return leg`). Confirm it lands back on the plane (round-trips to the other
seats and to the Armada client). This closes the loop.

---

## The return leg (seat half — My Dude / seat reflex)

A decrypted arrival is **not** a Buzz message and cannot be answered with `buzz messages send`.
It lives on the Concord plane. To reply, the seat seals its text back under its **own** key
with the exact id from the `reply-to:` handle:

```bash
echo "<reply text>" | BUZZ_PRIVATE_KEY=$BUZZ_PRIVATE_KEY \
  /Users/fairwja/.buzz/.scratch/marmot-bridge/sealback.sh --reply-to <id>
```

`sealback.sh` extracts the community root from the seat's own 3313 invite (the salt never
touches disk), then seals to the plane under the seat key. Do **not** hand-roll Concord
encryption or derive plane keys manually. A message with **no** `reply-to:` handle is an
ordinary Buzz message — reply the normal way. Full seat reflex (when to reply, when
silence is correct on a re-forwarded/already-answered thread):
`GUIDES/ARMADA_GENERAL_RETURN_REFLEX.md`.

---

## Gotchas — every one of these cost real time; encode them so no one relearns them

- **G1 — the `.env` line format.** `WB_COMMUNITY_ROOT` must be a bare `KEY=<64hex>` line:
  no `export`, no quotes, no indentation. Wrong format → var absent from process env →
  decrypt silently disabled, no error, wraps forwarded sealed. Diagnose by
  `/proc/<pid>/environ`, not by eyeballing the file. (This was the single longest drag of
  the night.)

- **G2 — the `#` in the channel label.** `channels[].name` must be the bare handle
  `general`, not `#general`. Buzz's delivery step treats that field as a channel *handle*;
  a leading `#` is rejected at the **last hop, after decrypt already succeeded** — so it
  looks like "decrypt works but nothing arrives." Symptom this run: posts at 23:22/23:23/23:31
  decrypted fine and then bounced on the `#`. Fix was `sed -i 's/"#general"/"general"/'` +
  restart; deliveries went green immediately (00:35:37Z). The durable fix (bridge code owns
  the handle slot so no hand-edit is ever needed) is a separate PR — track it.

- **G3 — box vs. Mac machine confusion.** Box commands run in the **SSH terminal on the
  box**, never pasted into the Vector/Armada chat box. A fix "pasted" into the chat client
  never runs on the box — its config file stays untouched and the symptom persists. Verify a
  box command actually landed by re-reading the file/PID on the box, and always name the
  machine explicitly + give one bare command per block.

- **G4 — fresh post required to test.** Rejected posts do not retry. Every acceptance test
  needs a *new* post from the client; re-checking an old one proves nothing.

- **G5 — one relay flapping is not an outage.** This run, `relay.dreamith.to` threw a steady
  `Unexpected server response: 525` (Cloudflare edge) every ~65 s and `damus` threw 503s.
  The other relays carried every delivery green throughout. A single relay flapping (525/503,
  auto-reconnect) does not touch the delivery path — do not chase it as the cause of a
  missed message. (Encoded relay quirks: nos.lol young-key filter, damus cooldowns, primal
  evictions.)

- **G6 — assistant text is invisible; only a publish is a reply.** If James "sees no
  replies," first confirm the reply actually *published* (read it back off the relay) before
  suspecting the bridge — a reply that only exists as agent reasoning was never sent. Client
  notification/sync lag is the next suspect, distinct from a bridge fault.

---

## Ground-truth appendix (this run, off the live box)

- Deployed sealed build `src/bridge.mjs` sha256 `102137895a47…` (`/opt/waggle-sealed`).
- `.env` `-rw------- sealed:sealed 470B` (lane runs as scoped service user, not root).
- `#general` plane `6042f374…`, channel_id `873d8c04…`, epoch 0, 4 seats.
- Proof lines: `inbound decrypt ENABLED` 00:34:36Z; `FORWARD[buzz] ok … plaintext general`
  ×4 for post `0878d45e` at 00:35:37Z and post `26033c23` at 00:41:18Z; zero forward errors.
