# Deploy runbook

The box was originally built by hand-typed interactive ssh steps whose scrollback is gone.
This directory is the reproducible replacement — the spec's "reference implementation"
claim depends on it. Read this whole file before touching the box.

## Topology — two units, two trees, two users

| | sealed lanes (existing) | public read lane (new) |
|---|---|---|
| Unit | `waggle-sealed.service` | `waggle-read.service` |
| User | root *(Phase 1: unchanged — migrating sealed off root is explicitly out of scope)* | `bridge:bridge` |
| Tree | `/opt/waggle-sealed` | `/opt/waggle-read` (0750) |
| Config | **no** `public` block — boot log must read `public read lane: inactive` | **only** the `public` block |
| Env | `/opt/waggle-sealed/.env` | `/opt/waggle-read/.env` with `SEALED_LANES=off` |
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
2. **(box)** Create `/opt/waggle-read/.env` (bridge:bridge, 0600) with
   `SEALED_LANES=off`, `FORWARD_MODE=dryrun`, the `BUZZ_*` trio, and (when
   latency tracing is enabled) a locally generated `LATENCY_TRACE_KEY` of at
   least 32 random characters. It is an HMAC key, never a Nostr or Buzz key;
   without it the bridge deliberately drops telemetry rather than writing a
   reversible public-event fingerprint. Create `config.json` with only the
   `public` block.
3. **(Mac)** `sh deploy/deploy.sh read bridge@<host>` — dryrun posts nothing, so the
   local read lane can keep running. Watch the journal for `[pub …] open, subscribing`
   and clean `PUBLIC[dryrun]` routing lines.
4. **Cutover (the only ordered part):**
   a. Stop the local read-lane process.
   b. Copy the local `data/seen-ids.log`, `data/pub-watermark`, and `data/posted-map.log`
      into `/opt/waggle-read/data/` (chown bridge:bridge).
   c. Flip `.env` to `FORWARD_MODE=buzz`; `sudo systemctl restart waggle-read`;
      `sudo systemctl enable waggle-read`.
   d. Watch for `PUBLIC[buzz] ok` lines; eyeball the Buzz channel — there must be no
      duplicate posts.
5. **(box, as root — independent)** Refresh the sealed tree to the current build:
   `sh deploy/deploy.sh sealed <admin>@<host>`. Confirm its `config.json` has **no**
   `public` block; its boot log must read `public read lane: inactive`.
6. **Prove the routing policy is complete:** `sudo deploy/verify-config.sh`. `config.json` is
   gitignored, so a host rebuilt from the example comes up structurally valid and behaviourally
   wrong — the bridge starts, reports healthy, and quietly routes nothing. Exit 3 means it could
   not read the file, which is **not** an all-clear.
7. **Harden LAST:** apply `nft -f deploy/nave-fw.nft` and persist it, then **prove it loaded**
   with `sudo deploy/verify-firewall.sh` (exit 0 = verified; **3 = inconclusive, not an
   all-clear**). Applying is not loading: the correct ruleset once sat on a box for a day
   without ever entering the kernel, while NTP egress was dropped and the clock silently
   drifted — which corrupts the `since` windows, the A3 watermark and the A5 `created_at`
   clamp, with no error anywhere. Re-verify the admin login; only then `PermitRootLogin no` +
   `sshd -t` + reload; finally the reboot test — both units return, the watermark resumes, the
   journal is clean, and `verify-firewall.sh` still exits 0.

## Post-deploy verification (required)

`deploy.sh` ships code but does not confirm afterwards that what is running is what was
shipped. Trees drift — a lane can sit several commits behind `main`, or the two units can
drift apart, with no visible signal while every status surface still reads healthy. That
is not cosmetic: a build predating the send-journal instrumentation gives the tripwire
nothing to diff against, so **detection silently degrades to nothing.**

After **every** `deploy.sh`, run the drift check for that tree and treat any mismatch as a
failed deploy — roll forward, do not leave it:

```
sh deploy/verify-deployed.sh sealed <admin>@<host>   [git-ref]   # /opt/waggle-sealed
sh deploy/verify-deployed.sh read   bridge@<host>    [git-ref]   # /opt/waggle-read
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

## Adding an agent seat (a new sealed-lane recipient)

`add-recipient.sh` wires a new agent into the sealed lanes: it creates a private inbox
owned by the waggle poster key, seats the agent as a member, adds it to `recipients[]`
and the named channel fan lists in `/opt/waggle-sealed/config.json`, and restarts the
sealed lane. Run it **as root on the box** (the scoped operator accounts are not in
sudoers by design — get a root shell with `su -`, not `sudo -i`):

```
sh deploy/add-recipient.sh <Name> <pubkey-hex> [chan1,chan2,...]   # chans default to "#general"
```

It is idempotent — re-running updates the existing seat in place and never mints a
second inbox. Three traps it handles so you don't relearn them: it loads creds from the
running daemon's `/proc/<pid>/environ` rather than sourcing `.env` (bash mangles the
`AUTH_TAG` JSON; systemd does not), it reads the new id from `channel_id` (not `id`),
and it **aborts before touching config** if `channels create` returns empty — a blank
inbox writes a placeholder seat the bridge flags and drops.

This provisions a **delivery seat**; it is not the designed participant onboarding
(#141), where an agent mints its **own** ephemeral key and requests a grant. Here the
operator uses the bridge's own key to own the inbox it delivers into.

**Verify after (required):** the boot log must show one more recipient and **no**
`placeholder inbox` WARN; then post a smoke test into the channel and confirm the fan
lands in the new inbox as a sealed kind:9 **authored by the waggle poster key** — a
non-waggle routed copy is a leftover-key red flag.

## Pull-based deploy runner (#129)

`deploy.sh` is a **push** from the Mac, and a push needs a standing grant on the box that
can restart the unit as `bridge` — which is also arbitrary execution as `bridge`, i.e. the
ability to sign as waggle. The deploy path is the last place standing write to production
hides. `deploy/deploy-runner.sh` inverts it: the **box pulls**. A timer runs the runner;
it looks for a commit on `main` that CI has marked green, ships that commit into the lane
tree, records the SHA, and runs `verify-deployed.sh` — refusing loudly on drift. There is
no inbound credential to the box, so a GitHub compromise is not a production compromise.

```
sh deploy/deploy-runner.sh read      # /opt/waggle-read
sh deploy/deploy-runner.sh sealed    # /opt/waggle-sealed
```

**Authorisation = merged + green.** Nothing here deploys a commit that is not both on
`main` and passing CI for *that exact SHA* (GitHub check-runs, not the legacy status API).
To require an explicit human blessing per release, point `WB_REF` at a signed tag instead
of `origin/main` — a one-line swap, no rebuild.

**Gates the runner keeps** (all covered by `tests/deploy_runner.mjs`, negative controls
included — a `pending` build waits, a `red` build is refused, an injected post-ship change
alarms):

- deploys only a CI-green commit; `pending` retries next tick, `failure` refuses and says so
- never touches `config.json`, `.env` or `data/` — not in the ship list, and no `--delete`.
  These hold the live-only values (`watch_authors`, `return_lane`, `scan_channels`,
  `relay_channels` — see #104) a careless deploy would erase.
- records the deployed SHA to `<tree>/DEPLOYED_SHA` so drift is checkable without a checkout
- runs `verify-deployed.sh` after every deploy; a mismatch **alarms** (exit 1 / FAILED unit),
  it never logs-and-passes

### One-time bootstrap (the only privileged step)

The runner removes *standing* write; installing it is a *bounded, one-time* privileged act.

**One hub clone per lane** (`/opt/waggle-hub-read`, `/opt/waggle-hub-sealed`) — not one
shared hub. The two instances run as different users and a git worktree cannot be fetched
and `checkout --detach`ed by both; they also tick on the same cadence, so a shared worktree
could be rsynced by one instance while the other had just moved it to a different commit
(#158). Each hub is owned by exactly the user its instance runs as.

0. **Verify before installing** — the grant the runner depends on, which predates the repo
   rename (#112): `sudo -l -U bridge` must show `systemctl restart waggle-read.service`
   *under that exact unit name*. If it still names `west-bridge-read.service`, reinstall
   `deploy/sudoers-bridge` (`visudo -cf` it first) or the runner's restart step is denied.
1. **Hub clone** the lane pulls into (never a lane tree):
   `git clone <repo> /opt/waggle-hub-read && chown -R bridge:bridge /opt/waggle-hub-read`.
   The runner only `fetch`es and `checkout --detach`s here.
2. **Units:** `sudo cp deploy/deploy-runner@.{service,timer} /etc/systemd/system/` then
   `sudo systemctl daemon-reload`.
3. **Rehearse one tick by hand, before any timer is enabled.** `DRY_RUN=1` resolves the
   target commit and runs the CI-green gate while changing nothing:
   `sudo -u bridge env DRY_RUN=1 WB_HUB=/opt/waggle-hub-read /bin/sh
   /opt/waggle-hub-read/deploy/deploy-runner.sh read`. Then run it for real, once, and read
   the output — a first deploy is the wrong thing to discover from a timer's journal.
4. **read lane:** `sudo systemctl enable --now deploy-runner@read.timer`. It runs as
   `bridge`, which already owns `/opt/waggle-read` and holds the scoped `sudo systemctl
   restart waggle-read.service` grant (`deploy/sudoers-bridge`). No new authority.
5. **sealed lane — see "Sealed lane: off root, and its deploy runner" below.** It is a
   separate pass with its own ordering (create the user, hand it the tree, restart the lane
   as that user, *then* arm its runner), because moving a running lane off root is the part
   that can leave it down if the steps are taken out of order.
6. Confirm — by reading the result, not the exit code: `systemctl list-timers
   'deploy-runner@*'`, `cat /opt/waggle-<lane>/DEPLOYED_SHA`, and a green
   `verify-deployed.sh <lane> /opt/waggle-<lane> <sha>`.

For a **private** repo, drop a read-only token in `/opt/waggle-hub-<lane>/deploy-runner.env`
(`GH_TOKEN=…`, `0600`, never committed) — a read cap, still no write authority on the box.

Nothing arms until it passes a review and a green `verify-deployed.sh` against the box.

## Sealed lane: off root, and its deploy runner

The read lane has run as `bridge` since the Phase-1 migration. The sealed lane did not: it had no
`User=` at all, so it ran as **root** — the last principal holding that privilege on production,
and the reason "no principal holds a general shell here" was not yet true.

Order matters. Each step leaves the lane in a working state, so a stop anywhere is safe.

1. **Create the user** (no login, no home of its own beyond the tree):
   `sudo useradd --system --home-dir /opt/waggle-sealed --shell /usr/sbin/nologin sealed`
2. **Hand it the tree**, and re-assert the key's mode under its new owner:
   `sudo chown -R sealed:sealed /opt/waggle-sealed` then `sudo chmod 0600 /opt/waggle-sealed/.env`.
   **Do NOT make the tree group-writable** to let anything else ship into it — directory write
   grants *rename* of entries whatever their own modes are, which is exactly the privesc closed on
   the read tree on 2026-08-01. Own it, do not share it.
3. **Scoped sudo**, validated before install:
   `sudo visudo -cf deploy/sudoers-sealed && sudo install -m 0440 -o root -g root deploy/sudoers-sealed /etc/sudoers.d/sealed`
4. **Install the unit and restart the lane as its new user:**
   `sudo cp deploy/waggle-sealed.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart waggle-sealed.service`.
   Confirm by reading, not by exit code: `systemctl show waggle-sealed.service -p User --value`
   must print `sealed`, and the journal must show the lane resubscribing.
5. **Only then, its deploy runner.** Hub clone owned by the same user:
   `sudo git clone <repo> /opt/waggle-hub-sealed && sudo chown -R sealed:sealed /opt/waggle-hub-sealed`,
   the drop-in from the unit header (`User=sealed`, `Group=sealed`), a hand-run
   `DRY_RUN=1` tick, one real tick read by eye, and then
   `sudo systemctl enable --now deploy-runner@sealed.timer`.

**The tripwire is unaffected.** It merges both lanes' send-journals in an `ExecStartPre` that runs
as root, so it keeps reading `/opt/waggle-sealed/data/send-journal.log` whoever owns it.

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

## Tripwire — out-of-process signing detection (#34)

Process rate-limits cannot catch key theft: a thief with the raw poster nsec signs
**direct**, bypassing our code entirely. `tools/tripwire.mjs` watches the **wire** instead
of the process — it fetches the poster key's recent on-relay events and diffs them against
the bridge's own send-journal (`data/send-journal.log`). Any post authored by our key that
the journal does not contain was signed by something other than our process: theft, a
second signer, an impersonation. That is the alarm.

`deploy/tripwire.service` (oneshot) + `deploy/tripwire.timer` (30-min cadence) make
detection a property of the **install**, not of anyone remembering to run a script.

### Two rules the unit exists to enforce

1. **The alarm is signed by a SEPARATE key, never the poster key.** An alarm signed by the
   identity under suspicion is worthless — a thief holding the poster nsec could forge the
   all-clear too. Set `ALARM_NSEC` to a **dedicated** key with zero authority (its only
   power is sending a DM), so it is safe to hold on the watcher and disposable if the
   watcher is lost. Never set it to `BUZZ_PRIVATE_KEY`.
2. **Off-host is stronger.** A compromised box can silence an on-box watcher before it
   fires. The recommended posture runs the tripwire on a **separate host** (your Mac, a
   second droplet) against a synced copy of the journal — a box compromise then cannot kill
   its own detector. On-box is the fallback, not the target.

### Dependency ordering (#33)

The diff is only meaningful against a **current** journal. The install must be running a
build that writes `data/send-journal.log` on every send (both lanes) — that is exactly what
#33's deployed-build verification confirms. Until then the journal may be stale or absent,
and the script will (correctly) warn that **every** post looks unauthorized. **Do not arm
the alarm DM until #33 confirms the running build is journaling.** The `since-min 60` window
being wider than the 30-min cadence means every post is covered by ≥2 runs — one missed run
never opens a gap.

### Off-host install (recommended)

On a **watcher host** that is not the box — clone this repo, `npm ci`, then:

```
# tripwire.env (0600, owner-only, NEVER committed):
POSTER=<npub of the bridge poster key>          # PUBLIC key only — the watcher never signs as poster
SEND_JOURNAL_PATH=/opt/waggle/data/journal-sealed.log:/opt/waggle/data/journal-read.log  # BOTH lanes, :-separated (below)
ALARM_NSEC=<dedicated alarm key nsec>           # rule 1 — a fresh, zero-authority key
ALARM_TO=<npub to DM on alarm>
BUZZ_RELAY_URL=<relay>                          # extra public relays come from config.json
```

The watcher **pulls** the journals (so the box needs no credentials to the watcher — a journal
is only public event ids, nothing sensitive), on its own timer just ahead of the tripwire tick.

**Pull every lane's journal, not just one.** The poster key signs on both lanes, but each bridge
instance journals to its own tree, so the tripwire diffs against their UNION — a legitimate send
on the lane you did not sync otherwise reads as theft. Two lanes today; pull each as a user that
can read that tree, since the sealed tree is not readable by the read-lane account:

```
rsync -az <sealed-reader>@<box>:/opt/waggle-sealed/data/send-journal.log /opt/waggle/data/journal-sealed.log
rsync -az bridge@<box>:/opt/waggle-read/data/send-journal.log            /opt/waggle/data/journal-read.log
```

`SEND_JOURNAL_PATH` lists both (`:`-separated above; `--journal` may also be repeated, and commas
work too). Any journal the tripwire cannot find is named in a warning, and if nothing else is
unaccounted for it exits **3 — INCONCLUSIVE**, never 0. A half-completed sync therefore fails
loud rather than quietly narrowing what was checked: "no anomalies" across part of the evidence
is not an all-clear.

Then install the units (edit `WorkingDirectory`/`User`/paths in the unit files to match this
host first):

```
sudo cp deploy/tripwire.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tripwire.timer
systemctl list-timers tripwire.timer
```

On macOS (no systemd) run the same script from a `launchd` job or `cron` on the same
30-min cadence — the units are a convenience, `tools/tripwire.mjs` is the whole detector.

### On-box fallback

Weaker (dies with the box it polices), but better than nothing while an off-host watcher is
being stood up. Point `WorkingDirectory` at the sealed tree's checkout and
`SEND_JOURNAL_PATH` at `/opt/waggle-sealed/data/send-journal.log` directly (grant the runtime
user group-read on it), and update `ReadWritePaths` to that same tree's `data/` so the
alarm log stays writable. Everything else is identical. Note the weakness is not just that
the watcher dies with the box — the box also writes the journal it is judged against, so a
thief who owns the box can forge journal entries to match a stolen-key post. On-box catches
mistakes and crude theft; only off-host catches an adversary who owns the host.

### Verify (positive + negative control)

- **Negative control (must stay quiet):** run a tick with a healthy journal — a journaled,
  bridge-emitted post must yield exit 0 and `OK — every on-relay post … was emitted by our
  process.`
- **Positive control (must fire):** temporarily point `--journal` at an empty file (or sign
  one test event off-process) so a real on-relay post is unaccounted — the run must print
  `🚨 TRIPWIRE`, append `data/tripwire-alarms.log`, exit 2, and (if `ALARM_*` are set) DM the
  alarm. Restore the real journal path after.

Alert on **exit 2 / unit failure** (`systemctl --failed`, or an `OnFailure=` handler) as the
local backstop to the out-of-band alarm DM.
