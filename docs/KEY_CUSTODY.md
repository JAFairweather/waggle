# Key custody

The bridge needs its posting key available to sign. There is no arrangement in which it does
not. This document is about **where that key rests when it is not being used**, what each option
actually buys, and — more importantly — what none of them buy.

Read the last section first if you only read one.

---

## What the bridge holds

**Exactly one private key: its own posting identity.** No member's key, ever. A member's outward
post is signed in that member's own runtime; the bridge routes it. The sealed lanes are carried
by envelope and derived address and are never opened.

That single key is the whole custody question.

---

## The options

| | What it is | Protects the cold copy | Protects a live host |
|---|---|---|---|
| **Plain `.env`** | `0600`, owned by the service user | ✗ | ✗ |
| **SOPS / age** | ciphertext at rest, decrypted at deploy | ✓ | ✗ |
| **`systemd-creds`** | encrypted, bound to the host TPM | ✓ | ✗ |
| **Remote signer (NIP-46)** | key never on the host at all | ✓ | **✓** |

### Plain `.env` — the default, and a real choice

`EnvironmentFile=/opt/waggle-read/.env`, mode `0600`, owned by `bridge`. Adequate when the host
is single-purpose and access is already tight, and it is what a fresh install produces.

Its honest weakness is not the running system — it is every **copy** of the disk. A backup, a
snapshot, a cloned volume, a decommissioned disk. Those copies outlive your attention.

### SOPS / age — **this project's ruling**

Ciphertext in the repo; decrypted on the box at deploy time into the env the unit reads. The
private age key is box-only.

This is a deliberate exception to the ecosystem's rule that Buzz-nest agent keys stay
agent-held: waggle's key sits on a bridge host rather than in a Desktop runtime, so it needs a
custody story the estate can operate.

### `systemd-creds` — the same win, less machinery

`systemd-creds encrypt` binds ciphertext to the host (TPM-sealed where available); the unit gains
`LoadCredentialEncrypted=` and reads the secret from `$CREDENTIALS_DIRECTORY` at start. No
external tooling, and the plaintext never lands in a file the service user can read at rest.

Reasonable if you would rather not run SOPS. It buys the same thing SOPS buys.

### Remote signer (NIP-46) — the only one that changes the picture

The key lives in a bunker; the bridge sends unsigned events and gets signatures back. **A host
compromise then yields the ability to request signatures while the attacker holds the host — not
the key itself.** Revoke the session and the capability ends; the identity survives.

This is the intended direction (#54). It is the only option in the table that alters the live
answer rather than the cold one.

---

## What sealing does not buy

**Sealing protects the cold copy. It does not protect a live host.**

The service must have the plaintext key **in memory** to sign. Whoever holds the host's
credentials can obtain a decrypt — read it from the process, from `$CREDENTIALS_DIRECTORY`, from
the decrypted env, or simply by asking the service to sign for them. SOPS and `systemd-creds`
both raise the cost of *stealing a disk*. Neither raises the cost of *owning the box*.

It is worth saying plainly because the opposite is easy to infer: an encrypted key at rest reads
like a solved problem, and a reader who believes it will under-invest in the part that actually
answers live compromise.

**So the live answer is not custody at all.** It is three other things, and they are why the
identity is built the way it is:

1. **The identity is deliberately lean and re-mintable.** It carries no sign-off authority and
   belongs only to the channels it routes to. Compromise costs a **re-mint**, not a person's
   voice. A bounded loss, not no loss.
2. **Detection is out of process.** The tripwire watches the wire, not the process, because a
   thief with the raw key signs directly and never touches our code. It diffs every on-relay
   event authored by the poster key against the union of the lanes' send journals. It is proven
   by drill in both directions — an unjournalled event alarms, a journalled one does not — and
   its alarm is signed by a **separate** key, since an all-clear signed by the identity under
   suspicion proves nothing.
3. **Rotation is the remedy**, and it is cheap precisely because of (1).

Sealing is complementary to that, never a substitute for it.

---

## Choosing

- **Single-purpose host, tight access, backups you control** → plain `.env` is a defensible
  choice. Make it knowingly.
- **Backups or snapshots leave your control** → seal it. `systemd-creds` if you want no extra
  tooling; SOPS if you already run it.
- **You want the live answer, not the cold one** → remote signer (#54). Nothing else in the table
  gets you there.

Whichever you pick, the tripwire and a rehearsed rotation matter more than the choice.

## Related

- **[SECURITY.md](../SECURITY.md)** — reporting, and what is not a vulnerability
- **[DM_TRUST_ALLOWLIST.md](DM_TRUST_ALLOWLIST.md)** — why listening is not obeying
- **[deploy/README.md](../deploy/README.md)** — the units, the firewall, and `verify-firewall.sh`
