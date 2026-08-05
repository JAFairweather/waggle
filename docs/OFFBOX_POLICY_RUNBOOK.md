# Off-box policy service operator runbook

This is the policy-host side of the remote Buzz writer. It does **not** belong on the
Waggle bridge host. The bridge receives a forced-command SSH key that can invoke only
`tools/buzz-policy-service.mjs`; the policy host alone holds the Bunker pairing, private
policy configuration, journal, and recovery secret.

The service is not yet a replacement for every Buzz write family. Follow the migration
gates in [DESIGN_OFFBOX_BUZZ_POLICY.md](DESIGN_OFFBOX_BUZZ_POLICY.md#10--migration-gates)
before removing the bridge's existing local poster path.

## Private files

Create both files as the dedicated policy-service Unix user, outside the checkout. They
must be real regular files, owned privately, and mode `0600`; their parent directory and
the journal directory must not be writable by the bridge account.

`policy.json` has exactly this shape:

```json
{
  "version": 1,
  "policy_instance": "jaf-hive",
  "catalogue_version": "<64-hex reviewed catalogue digest>",
  "staging_channel": "<fixed Buzz channel UUID>",
  "watched_event_ids": ["<64-hex Nostr event id>"],
  "approver_mention": "James",
  "poster_pubkey": "<64-hex Buzz poster pubkey>",
  "auth_tag": ["auth", "<owner pubkey>", "<NIP-OA conditions>", "<owner signature>"],
  "endpoint": "https://<fixed Buzz host>/events",
  "journal_path": "/var/lib/waggle-policy/journal",
  "recovery_secret_file": "/etc/waggle-policy/recovery.secret"
}
```

`recovery.secret` contains one 32–128 character URL-safe random value. It is never an
argument, environment value, receipt field, log field, bridge credential, or Bunker
credential. The ordinary request path loads it only so the same journal can enforce the
operator-only orphan transition; untrusted requests cannot select that transition.

Set `WAGGLE_POLICY_CONFIG_FILE` to the absolute `policy.json` path in the policy-host
service environment. Configure `src/nostr_signer.mjs` there with the policy service's
NIP-46/Bunker pairing, and verify its reported pubkey equals `poster_pubkey`.

## Forced command

The bridge's SSH public key must be restricted server-side to the zero-argument runner.
Disable shell, PTY, forwarding, agent forwarding, X11, and user-selected commands. The
runner accepts one bounded canonical JSON request on stdin and emits only canonical
status plus a signed receipt. It never returns a signed Buzz event, NIP-98 authorization,
auth tag, recovery secret, or Bunker credential.

Exercise the negative control before enabling the key: adding any argument must exit 2
with `arguments are not accepted`.

## Resolving a pre-prepare orphan

Do this only after proving the old policy worker is dead. Inspect the journal record and
record its exact `claimed_at`, then provide the **same canonical request bytes** locally:

```sh
WAGGLE_POLICY_CONFIG_FILE=/etc/waggle-policy/policy.json \
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
