# Deploy runbook

The box was originally built by hand-typed interactive ssh steps whose scrollback is gone.
This directory is the reproducible replacement — the spec's "reference implementation"
claim depends on it. Read this whole file before touching the box.

## Topology — two units, two trees, two users

| | sealed lanes (existing) | public read lane (new) |
|---|---|---|
| Unit | `west-bridge.service` | `west-bridge-read.service` |
| User | root *(Phase 1: unchanged — migrating sealed off root is explicitly out of scope)* | `bridge:bridge` |
| Tree | `/opt/west-bridge` | `/opt/west-bridge-read` (0750) |
| Config | **no** `public` block — boot log must read `public read lane: inactive` | **only** the `public` block |
| Env | `/opt/west-bridge/.env` | `/opt/west-bridge-read/.env` with `SEALED_LANES=off` |
| Data | own `data/` | own `data/` (disjoint dedup by construction — the lanes are event-disjoint) |

Why split: the read lane is the only lane terminating **untrusted network input**; it must
not share root with the sealed lanes (D1). `SEALED_LANES=off` exists because dedup is
per-process — two instances both routing sealed lanes deliver every wrap twice.

## Fresh-box / migration order

Double-delivery risks are exactly two: (a) two instances running sealed lanes — never
happens here, the read tree always has `SEALED_LANES=off`; (b) local box + droplet both
running the public lane in buzz mode — prevented by the cutover order below and by
**seeding the droplet's data dir from the local instance's** (the load-bearing trick: the
A3 watermark resumes where local stopped, and A2's seen-set makes the overlap a no-op).

1. **(box, as root — gated on the D1 pubkey decision)**
   `BRIDGE_PUB='ssh-ed25519 …' sh bridge-user.sh`
   Then create the admin user for later root-SSH disable (see the warning below) and
   **verify both logins from the Mac before proceeding.**
2. **(box)** Create `/opt/west-bridge-read/.env` (bridge:bridge, 0600) with
   `SEALED_LANES=off`, `FORWARD_MODE=dryrun`, and the `BUZZ_*` trio; create
   `/opt/west-bridge-read/config.json` with only the `public` block.
3. **(Mac)** `sh deploy/deploy.sh read bridge@<host>` — dryrun posts nothing, so the
   local read lane can keep running. Watch the journal for `[pub …] open, subscribing`
   and clean `PUBLIC[dryrun]` routing lines.
4. **Cutover (the only ordered part):**
   a. Stop the local read-lane process.
   b. Copy the local `data/seen-ids.log`, `data/pub-watermark`, and `data/posted-map.log`
      into `/opt/west-bridge-read/data/` (chown bridge:bridge).
   c. Flip `.env` to `FORWARD_MODE=buzz`; `sudo systemctl restart west-bridge-read`;
      `sudo systemctl enable west-bridge-read`.
   d. Watch for `PUBLIC[buzz] ok` lines; eyeball the Buzz channel — there must be no
      duplicate posts.
5. **(box, as root — independent)** Refresh the sealed tree to the current build:
   `sh deploy/deploy.sh sealed <admin>@<host>`. Confirm its `config.json` has **no**
   `public` block; its boot log must read `public read lane: inactive`.
6. **Harden LAST:** apply `nft -f deploy/nave-fw.nft` and persist it; re-verify the admin
   login; only then `PermitRootLogin no` + `sshd -t` + reload; finally the reboot test —
   both units return, the watermark resumes, the journal is clean.

## Post-deploy verification (required)

`deploy.sh` ships code but does not confirm afterwards that what is running is what was
shipped. Trees drift — a lane can sit several commits behind `main`, or the two units can
drift apart, with no visible signal while every status surface still reads healthy. That
is not cosmetic: a build predating the send-journal instrumentation gives the tripwire
nothing to diff against, so **detection silently degrades to nothing.**

After **every** `deploy.sh`, run the drift check for that tree and treat any mismatch as a
failed deploy — roll forward, do not leave it:

```
sh deploy/verify-deployed.sh sealed <admin>@<host>   [git-ref]   # /opt/west-bridge
sh deploy/verify-deployed.sh read   bridge@<host>    [git-ref]   # /opt/west-bridge-read
```

It hashes each shipped file on the box and compares it to the git blob it should match at
`git-ref` (default `HEAD` — pass the tag/commit you deployed). It checks exactly
`deploy.sh`'s ship list; `config.json`, `.env` and `data/` are never shipped and are
excluded on purpose. Exit `0` = the deployed build matches the ref; `1` = drift, with the
offending paths named loudly; `2` = usage / bad ref / tree unreachable. Running both trees
against the same ref also catches the two units drifting apart from each other.

This is the automated form of the manual "sealed tree md5 vs the repo baseline" note under
*Pre-cutover box checks* — prefer this. The regression test `tests/deploy_verify.mjs`
proves it reports drift on a deliberately stale tree.

## ⚠ Root-SSH disable is lockout-sensitive

Today the management key lands on root and the sealed unit is administered as root.
`PermitRootLogin no` before a sudo-capable admin user is **created and login-verified**
orphans the sealed unit. Order is always: admin user → verify login from the Mac →
firewall → root-SSH off → reboot test. (Same verify-before-lock philosophy as
`nave.pub/deploy/ops/rekey.sh --lock`.)

## Pre-cutover box checks (read-only)

- `node --version` ≥ 20 (deploy.sh preflights this too)
- the `buzz` CLI is on `/usr/local/bin:/usr/bin:/bin` **and executable by `bridge`**
  (the bridge shells out to bare `buzz`; the units pin that PATH)
- which time-sync daemon runs (the firewall allows NTP on udp/123 — verify sync resumes)
- current `nft list ruleset` before replacing `nave_fw`
- sealed tree md5 vs the repo baseline commit, so drift is known before overwrite

## Env quick-reference (read-lane .env)

```
SEALED_LANES=off
FORWARD_MODE=dryrun            # buzz only at cutover step 4c
BUZZ_RELAY_URL=...
BUZZ_PRIVATE_KEY=...           # the BRIDGE posting identity — never an agent key
BUZZ_AUTH_TAG=...
```


## Admission grants (§4.1 S3) — who may admit a participant

The bridge admits a granted participant when it sees a signed NIP-DA 440 from a key in
`config.public.grantors`. Keep the signing key OFF the box — use a remote signer:

```
# 1. Read the pubkey your signer holds (key stays in Amber / nsec.app / Alby):
GRANTOR_BUNKER='bunker://<pubkey>?relay=wss://…&secret=…' node tools/grant.mjs whoami
# 2. Put that pubkey in the read-lane config.public.grantors, redeploy.
# 3. Issue / revoke — every signature happens in your signer, never here:
GRANTOR_BUNKER='bunker://…' node tools/grant.mjs issue  --to <npub> --channel <uuid>
GRANTOR_BUNKER='bunker://…' node tools/grant.mjs revoke --grant <440 id>
```

`GRANTOR_NSEC` (a local key) also works for demos/CI, but the bunker path is the
zero-custody default: the maintainer authors admissions without any key touching the host.
