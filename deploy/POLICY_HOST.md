# Off-box Buzz policy host

This installs the first production boundary for #54. The Waggle box receives one SSH capability:
send a bounded evidence packet to a fixed Unix socket. It receives a signed receipt or a bounded
hold, never a shell, signer, signed Buzz event, NIP-98 event, credential, URL, or destination choice.

The identities are deliberately split:

- `waggle-policy-ingress` owns no files or credentials. `sshd` forces every accepted key into
  `buzz-policy-forward.mjs`, which can reach only `/run/waggle-policy/request.sock`.
- `waggle-policy` has no login shell. A sandboxed socket-activated process reads the fixed policy
  and NIP-46 pairing, writes only `/var/lib/waggle-policy/journal`, signs through Bunker, and submits
  directly to the fixed Buzz `/events` endpoint.
- `waggle-policy-shadow-ingress` uses a different SSH key and is forced only into the derive-only
  socket. `waggle-policy-shadow` receives one projection policy, has only `AF_UNIX`, no writable
  path, signer, journal, recovery authority, or endpoint, and returns only a comparison digest.
- `root` owns the release, policy, SSH key file, service environment, and credential files. Neither
  runtime identity can replace code or widen policy.

This is a policy-host installation guide, not permission to cut production over. Shadow comparison,
all operation families, and the migration gates in `docs/DESIGN_OFFBOX_BUZZ_POLICY.md` still apply.

## 1. Dedicated ingress keys

On the Waggle host, mint a key used for this forced command only:

```sh
install -d -m 0700 /etc/waggle/policy-client
ssh-keygen -t ed25519 -N '' -f /etc/waggle/policy-client/id_ed25519 -C waggle-policy-ingress
ssh-keygen -t ed25519 -N '' -f /etc/waggle/policy-client/shadow_ed25519 -C waggle-policy-shadow-ingress
chmod 0600 /etc/waggle/policy-client/id_ed25519
chmod 0600 /etc/waggle/policy-client/shadow_ed25519
```

Create `/etc/waggle/policy-client/known_hosts` from the policy host's independently verified SSH
host-key fingerprint; do not trust an unauthenticated first connection. Keep both source files
`root:root` mode `0600`, then install the optional read-lane credential drop-in only after they
exist:

```sh
install -m 0600 -o root -g root /secure-transfer/verified_known_hosts /etc/waggle/policy-client/known_hosts
install -d -m 0755 /etc/systemd/system/waggle-read.service.d
install -m 0644 deploy/waggle-policy-shadow-client.conf \
  /etc/systemd/system/waggle-read.service.d/policy-shadow.conf
systemctl daemon-reload
```

The service receives read-only systemd credential copies. Neither source path is exposed in the
process environment, and the bridge refuses loose, missing, symlinked, or ambient SSH files.

Copy only the two `.pub` files to the policy-host operator. The live and shadow keys must differ;
do not reuse either as a management or deploy key.

## 2. Root-owned reviewed release

On the policy host, place the exact CI-green release at `/opt/waggle-policy`. The resulting tree
must be `root:root`, directories `0755`, and files non-writable by group/other. Install dependencies
as root with `npm ci --omit=dev --ignore-scripts`, remove `node_modules/.bin`, and do not include
`.git` or any symlink. The installer records a root-only digest manifest for the complete runtime
closure; runtime identities must not own or modify any part of `node_modules`.

From that release tree, as root:

```sh
WAGGLE_POLICY_CLIENT_PUB="$(cat /secure-transfer/id_ed25519.pub)" \
WAGGLE_POLICY_SHADOW_CLIENT_PUB="$(cat /secure-transfer/shadow_ed25519.pub)" \
  sh deploy/policy-host-install.sh
```

The installer validates `sshd` before reload, records the complete release manifest, and
installs—but does not enable—the request socket. The socket admits at most four concurrent
connections (two per source), and every transaction joins `waggle-policy.slice`, whose memory,
task, and CPU ceilings apply to the aggregate rather than multiplying without bound.

## 3. Fixed policy and Bunker pairing

Create `/etc/waggle-policy/policy.json` as `root:root` mode `0600`:

```json
{
  "version": 1,
  "policy_instance": "jaf-hive",
  "catalogue_version": "<64-hex reviewed release/catalogue digest>",
  "staging_channel": "<Buzz channel UUID>",
  "inbox_channel": "<Buzz hive inbox UUID>",
  "watched_event_ids": ["<64-hex signed Nostr event id>"],
  "trusted_repliers": ["<64-hex Nostr author allowed to reply directly>"],
  "recipient_routes": {
    "<64-hex direct-DM recipient>": { "name": "Codex - 231952cb", "inbox": "<fixed Buzz inbox UUID>" }
  },
  "approver_mention": "",
  "poster_pubkey": "<64-hex Buzz poster pubkey controlled by Bunker>",
  "auth_tag": ["auth", "<owner pubkey>", "<conditions>", "<owner Schnorr signature>"],
  "endpoint": "https://<fixed Buzz host>/events",
  "journal_path": "/var/lib/waggle-policy/journal"
}
```

Create `/etc/waggle-policy/shadow-policy.json` as `root:root` mode `0600`. It repeats only the
projection fields—`version`, `policy_instance`, `catalogue_version`, `staging_channel`,
`inbox_channel`, `watched_event_ids`, `trusted_repliers`, `recipient_routes`, `approver_mention`, `poster_pubkey`, and `auth_tag`. It must not contain
`endpoint`, `journal_path`, Bunker information, recovery state, or any credential path.

Install the Bunker pairing as two separate `root:root` mode `0600` regular files—never
symlinks:

```text
/etc/waggle-policy/credentials/poster.bunker-uri
/etc/waggle-policy/credentials/poster.client-nsec
/etc/waggle-policy/credentials/recovery.secret
```

The second file is the revocable NIP-46 transport client, not the poster identity nsec. The recovery
file is a fresh 32–128 character URL-safe secret used only for the operator's explicit orphan
transition. It is deliberately **not** loaded into the socket-activated service. The policy and two
Bunker source files remain unreadable to both runtime accounts; `LoadCredential=` gives each
transaction its own mode-0400 copies under systemd's private credential directory, and the existing
strict file loader validates those copies before use. The recovery source remains root-only and is
named explicitly only by the local operator command in `docs/OFFBOX_POLICY_RUNBOOK.md`.

## 4. Network boundary

Allow the policy identity/host only what the configured operation needs:

- DNS;
- TCP 443 to the fixed Buzz host and the Bunker URI's relay hosts;
- NTP for signature/freshness correctness.

The Waggle host must not reach Bunker directly. Its live key may SSH only as
`waggle-policy-ingress`; its separate comparison key may SSH only as
`waggle-policy-shadow-ingress`. Neither identity is a management principal.

## 5. Arm and prove

```sh
systemctl enable --now waggle-policy.socket
systemctl enable --now waggle-policy-shadow.socket
sh /opt/waggle-policy/deploy/verify-policy-host.sh
```

From the Waggle host, send a canonical fixture through the forced identity. Verify all of these:

1. valid evidence returns one canonical signed kind:30078 receipt;
2. replay returns byte-identical receipt and does not sign or submit again;
3. a destination, URL, command argument, malformed signature, stale source, or foreign policy
   instance is refused;
4. killing the transaction after durable prepare and retrying submits the same Buzz event id;
5. a proxy/WAF 4xx remains ambiguous; only matching HTTP 200 `accepted:true|false` is terminal;
6. `ssh -T`, PTY, forwarding, agent forwarding, and an arbitrary remote command all reach the same
   forced adapter or fail;
7. `waggle-policy-ingress` cannot read `/etc/waggle-policy`, the journal, or Bunker files;
8. `waggle-policy` cannot modify `/opt/waggle-policy`, `/etc/waggle-policy`, or SSH configuration.

Do not enable a bridge remote-only route until shadow output matches the local path and its operation
family has every positive, hostile, replay, restart, ambiguity, and withdrawal test required by §10.
For shadow comparison, use the shadow response's `evaluation_time` for the local projection and
compare its `decision` and `unsigned_event_sha256`; never compare or request signature bytes.

The bridge enables this per operation family through `public.policy_shadow`. Start with `mode:
"observe"`: unavailable or mismatching shadow output is loud and earns no burn-in credit, but the
existing local quarantine delivery continues. After a sustained exact-match burn-in, switch to
`mode: "enforce-shadow"`: unavailable or mismatching output remains owed and never reaches the
local signer. `off` is the default. The SSH client pins a dedicated identity and known-hosts file,
uses the forced account with no remote command, disables ambient identities, TTY and forwarding,
and sends only the canonical evidence packet on stdin. Do not use a management key or a mutable
user `known_hosts` file for either path.

After the enforced-shadow rehearsal is clean, configure `public.policy_writer.mode` as
`"remote-only"` for `quarantine_header`, `standing_trusted_reply`, `sealed_direct_envelope`, and
`withdraw_repost`, using the distinct `waggle-policy-ingress` key and forced
account. The bridge durably stores the exact canonical request under `data/policy-requests/` before
opening SSH. Held, ambiguous, malformed, unavailable, or unverifiable responses stay there and are
retried byte-for-byte every fifteen seconds and after restart. Only a poster-signed terminal receipt
bound to the exact request, staging channel, and endpoint can retire that debt. There is no attempt
limit and no local signer fallback.

The bridge's writer configuration is intentionally separate from `policy_shadow`:

```json
{
  "mode": "remote-only",
  "operations": ["quarantine_header", "standing_trusted_reply", "sealed_direct_envelope", "withdraw_repost"],
  "policy_instance": "jaf-hive",
  "catalogue_version": "<64 hex>",
  "poster_pubkey": "<64 hex>",
  "endpoint_authority": "nave.communities.buzz.xyz",
  "ssh_host": "<policy host>",
  "ssh_user": "waggle-policy-ingress",
  "ssh_identity_file": "/etc/waggle/policy-client/writer_ed25519",
  "ssh_known_hosts_file": "/etc/waggle/policy-client/known_hosts"
}
```

`operations` is the migration switch. Existing configurations that omit it retain only the first
two public families; direct sealed DMs and withdrawals remain on the local path until the policy-host
`recipient_routes` roster is installed and `sealed_direct_envelope` is explicitly added to both
the shadow and writer operation lists. Add `withdraw_repost` only after accepted off-box public
posts persist the complete signed source and poster-signed receipt in `posted-map`; older rows
hold closed because they lack evidence from which the policy host can derive a Buzz target.

Do not remove the local poster credential yet: this cutover covers quarantine headers, standing
trusted replies, direct sealed DMs, and receipt-bound withdrawals only. Channel-plane delivery,
mirrored feeds, live-grant participants, and other operation families remain
separate policy decisions and must not be admitted through the standing-reply rule. The
remaining operation families must move before the bridge host can lose all Buzz write authority.

## 6. Automatic releases after bootstrap

The trust bootstrap above is the only manual deployment. Do **not** give GitHub Actions a root SSH
key. Instead, clone this repository as `/opt/waggle-policy-hub`, install the committed
`policy-host-deploy-runner.service` and `.timer` into `/etc/systemd/system`, and enable the timer.
The policy host polls `main`, accepts only an exact commit whose CI checks are green, exports a
closed runtime file set, installs dependencies without lifecycle scripts, and promotes it only
after installation and verification pass. A failed install, restart, or verification restores the
prior release and leaves the old deployment watermark in place.

```sh
install -m 0644 deploy/policy-host-deploy-runner.service /etc/systemd/system/
install -m 0644 deploy/policy-host-deploy-runner.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now policy-host-deploy-runner.timer
systemctl start policy-host-deploy-runner.service
journalctl -u policy-host-deploy-runner.service -n 50 --no-pager
```

For a private repository, `/etc/waggle-policy/deploy-runner.env` may contain a **read-only** GitHub
token at mode `0600`. It is never loaded into either policy worker. Production signing credentials,
policy JSON, ingress private keys, and recovery authority remain host-local and outside every
release archive.
