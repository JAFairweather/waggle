# Off-box policy service operator runbook

This is the policy-host side of the remote Buzz writer. It does **not** belong on the
waggle bridge host. The bridge receives a forced-command SSH key whose credential-free
ingress can reach only the policy host's fixed Unix socket. A separate socket-activated,
sandboxed identity runs `tools/buzz-policy-service.mjs`; the policy host alone holds the
Bunker pairing, private policy configuration, journal, and recovery secret.

The service is not yet a replacement for every Buzz write family. Follow the migration
gates in [DESIGN_OFFBOX_BUZZ_POLICY.md](DESIGN_OFFBOX_BUZZ_POLICY.md#10--migration-gates)
before removing the bridge's existing local poster path.

## Private files

Create the policy and three credential source files as `root:root` mode `0600`, outside
the checkout. They must be real regular files; their parent directory and journal must
not be writable by the bridge or SSH-ingress account. The socket-activated transaction
receives private mode-0400 copies of only `policy.json`, `poster.bunker-uri`, and
`poster.client-nsec` through systemd credentials. It never receives `recovery.secret`.

`policy.json` has exactly this shape:

```json
{
  "version": 1,
  "policy_instance": "jaf-hive",
  "catalogue_version": "<64-hex reviewed catalogue digest>",
  "staging_channel": "<fixed Buzz channel UUID>",
  "inbox_channel": "<fixed Buzz hive inbox UUID>",
  "watched_event_ids": ["<64-hex Nostr event id>"],
  "trusted_repliers": ["<64-hex Nostr author allowed to reply directly>"],
  "approver_mention": "James",
  "poster_pubkey": "<64-hex Buzz poster pubkey>",
  "auth_tag": ["auth", "<owner pubkey>", "<NIP-OA conditions>", "<owner signature>"],
  "endpoint": "https://<fixed Buzz host>/events",
  "journal_path": "/var/lib/waggle-policy/journal"
}
```

`recovery.secret` contains one 32–128 character URL-safe random value. It is never an
argument, environment value, receipt field, log field, bridge credential, or Bunker
credential. The ordinary request path neither receives nor loads it. Only the explicit
local operator command in “Resolving a pre-prepare orphan” names and loads that file.

The installed socket unit fixes exactly three systemd credential paths: policy plus the
two Bunker pairing files. Configure the Bunker URI and revocable NIP-46 client credential
there, and verify the signer's reported pubkey equals `poster_pubkey`. Recovery remains
root-only outside that unit. See [the packaged host procedure](../deploy/POLICY_HOST.md).

## Forced command

The bridge's SSH public key is restricted server-side to the credential-free forwarder.
Shell, PTY, forwarding, agent forwarding, X11, and user-selected commands are disabled.
The ingress account owns no policy, signer, credential, or journal file; it can write only
to the fixed Unix socket. The separate transaction accepts one bounded canonical JSON
request and emits only canonical status plus a signed receipt. It never returns a signed
Buzz event, NIP-98 authorization, auth tag, recovery secret, or Bunker credential.

Exercise the negative controls before enabling the key: arbitrary remote commands must
still hit the fixed forwarder (or fail), arguments to either Node adapter must exit 2,
and the ingress user must be unable to read `/etc/waggle-policy` or the journal.

## Resolving a pre-prepare orphan

Do this only after proving the old policy worker is dead. Inspect the journal record and
record its exact `claimed_at`, then provide the **same canonical request bytes** locally:

```sh
WAGGLE_POLICY_CONFIG_FILE=/etc/waggle-policy/policy.json \
WAGGLE_POLICY_RECOVERY_SECRET_FILE=/etc/waggle-policy/credentials/recovery.secret \
WAGGLE_BUNKER_URI_FILE=/etc/waggle-policy/credentials/poster.bunker-uri \
WAGGLE_NIP46_CLIENT_NSEC_FILE=/etc/waggle-policy/credentials/poster.client-nsec \
  node tools/buzz-policy-resolve-orphan.mjs --claimed-at 1234567890 \
  < canonical-request.json
```

This command is deliberately not the SSH forced command. It requires the private recovery
file, exact request digest, policy-derived idempotency key, and exact observed `claimed_at`.
It signs and commits only an `ambiguous` receipt with no Buzz event id. It cannot claim
that Buzz accepted or refused a post, and a prepared event is recoverable instead of
eligible for orphan resolution.

Archive the signed receipt and retain the original request alongside the journal backup.
Never delete or manually rewrite an in-flight, prepared, or terminal journal record.
