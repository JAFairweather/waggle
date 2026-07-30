# The Concord consumer and its trust boundary

> **Scope:** what the Concord capability is, where the trust boundary sits, and — the
> sentence a reader would otherwise fill in with the worst case — **the bridge still
> never unwraps.** Lane 2 (see [`SPEC_EXTERNAL.md`](SPEC_EXTERNAL.md) §2) routes sealed
> Concord group traffic; a *participant* holds the community invite and decrypts it in
> its own runtime. Non-custody is intact end to end.

Concord is the sealed-group protocol behind Vector 0.4.0 (it replaced MLS/Marmot). A
Concord community's channel chat is a stream of `kind:1059` gift-wraps, and — unlike a
NIP-17 DM — Concord **inverts NIP-59**: the outer `p` tag is a random decoy, the wrap is
authored by the channel's *derived plane pubkey*, and routing is by `authors`, not by
recipient. The content is encrypted to a key derived from the community's secret root.

That last fact is why this document exists. "We added something that decrypts group
chat" is exactly the sentence that would undermine the whole trust story if left to
inference. It is not what happened. The capability is split across two parties with a
hard line between them, and only one of them can read anything.

---

## 1. Two parties, one line

| | **The bridge** (`src/bridge.mjs`, lane 2) | **The participant** (the *consumer*) |
|---|---|---|
| Runs as | the long-lived router, on the droplet | an agent session, holding its own key in-runtime |
| Holds | the channel's **plane pubkey** — a public address | the **invite**: `community_root`, `community_id`, `owner`, `owner_salt`, `root_epoch` |
| Does | matches `{kinds:[1059], authors:[<plane pubkey>]}` and forwards each wrap **still sealed** into the member's Buzz inbox | derives the plane key from `community_root`, decrypts the wrap, verifies the inner rumor |
| Cannot | derive any plane key, decrypt anything, or reconstruct `community_root` from the pubkey | — |

The bridge is a dumb router. It holds a **public** value (the plane pubkey), forwards on
**public envelope data only** (the `authors` filter), and never possesses the community
secret. This is the same non-custody property lane 1 (sealed DMs) has — the sealed wrap
is forwarded untouched and the recipient's own runtime does the unwrap
(`src/bridge.mjs` §"Concord channel planes", lines 77–82, and the delivery label at
lines 396–405 that tells the member *how* to derive rather than doing it for them).

**The consumer is the half that reads.** It is an agent that holds a Concord invite and,
inside its own session, derives the channel plane key and decrypts. The bridge is never
in that path — cleaner still, a participant that holds the channel key also holds the
plane pubkey and can `REQ {kinds:[1059], authors:[<plane_pk>]}` the relays directly, with
no mirror and no bridge involvement at all.

### What the derivation actually is

The derivation primitive is the one piece of the consumer that lives **in this repo**:
[`src/concord_lib.mjs`](../src/concord_lib.mjs). A public channel plane is

```
publicChannel(community_root, channel_id, root_epoch)
  = group_key("concord/channel", community_root, channel_id, root_epoch)
```

and `group_key` is HKDF-SHA256 over the secret with the CORD-02 Appendix A `info`
encoding (`label ‖ 0x00 ‖ id[32] ‖ epoch_be64?`), then a schnorr keypair, then the
NIP-44 conversation key. `community_root` is the sole secret input and it **never leaves
the participant's runtime**. The bridge only ever sees the resulting `.pub`.

---

## 2. Invite provenance — the checks that decide whose community this is

A gift-wrap being decryptable proves exactly one thing: it was encrypted **to you**.
Anyone can gift-wrap you a `kind:3313` community invite. `nip59.unwrapEvent` returning a
clean rumor is therefore **not** evidence of who sent it or which community it belongs
to — a hostile invite with internally-consistent fields passes every length, content, and
decoder guard the derivation library has. Shape is not provenance.

So before the consumer points its whole toolchain at an invite, it adjudicates that
invite by hand (unwrapping the wrap manually so the **seal** is inspected, not discarded —
a helper that hands back only the rumor has thrown away the evidence of who sent it). Four
checks, each cheap, each load-bearing:

1. **The seal signature verifies.** The seal (`kind:13`) is a real signed event, not
   forged ciphertext.
2. **The seal signer is the expected sender.** NIP-59 puts the sender's **real** key in
   the seal, and it is checked against a configured expected sender (`INVITE_FROM`,
   default: the community owner). This is the check that answers "is this from who I think
   it is?" — the one an attacker cannot satisfy by handing you a well-formed invite.
3. **The rumor's claimed author matches the seal signer.** The inner `kind:3313` cannot
   claim one author while being sealed by another.
4. **The `community_id` self-certifies.** The invite carries `owner`, `owner_salt`, and
   `community_id`; the consumer recomputes
   `sha256("concord/community" ‖ owner ‖ owner_salt)` ([`concord_lib.mjs` `communityId`](../src/concord_lib.mjs))
   and requires it to equal the stated `community_id`. This binds the community identity
   to its owner cryptographically — the id **is** its own proof.

### And it refuses to choose

Passing the four checks is necessary, not sufficient. If **more than one distinct
community** passes provenance, the consumer **exits rather than pick one**. "First match
wins" is silent selection of a credential, which is the same class of bug as silently
decoding one value wrong: it looks like an answer and is a coin-flip. Selection of a
security credential must be unambiguous or refused, never guessed.

This refusal only means something if the view is complete. A second community's invite
sitting on a relay the consumer did not query would be invisible, and the remaining one
would be reported as "unambiguous" when it was not. So provenance runs over the **union**
of all invites across every relay in the set — and a relay that refused, timed out, or
required auth is reported as **contributing no view**, never silently folded into "nothing
there." A refusal is not an absence. (Auth-gated relays serve gift-wraps only to the
authenticated key's own inbox, so the consumer NIP-42-authenticates as **its own key** to
read **its own** inbox there — the one case those relays do serve.)

The buckets are also made to close: every wrap seen lands in exactly one of
`accepted / rejected / undecryptable / not-a-3313`, and the run aborts if the tally does
not sum to what was fetched — so the census can never quietly claim coverage it does not
have. An undecryptable wrap is counted as *not-evidence*, never as a pass.

---

## 3. What a compromise would — and would not — expose

The trust boundary is only meaningful if you can say precisely what each side leaks when
it falls.

**If the bridge host is compromised.** The attacker gets the bridge's own disposable Buzz
posting identity and the set of **plane pubkeys** it routes on. Plane pubkeys are public
addresses; they let an attacker *observe that sealed traffic exists* and route it, exactly
as the bridge does. They do **not** yield `community_root`, any plane key, or any
plaintext — you cannot run the HKDF backward from a public key to the secret that seeded
it. **No community message is readable from the bridge, before or after compromise.** This
is the whole point of holding only the pubkey.

**If a participant (consumer) is compromised.** The attacker gets that participant's key
and its invite — `community_root` included — and can therefore decrypt the channels that
invite grants, **for as long as the invite is valid**. That is the real blast radius, and
it is inherent to end-to-end encryption: someone holds the key, and whoever holds the key
can read. Two bounds contain it:

- **A Direct Invite grants full read of all history**, and holding a key is never
  authority you can quietly revoke — a removed holder keeps decrypting until the key is
  rotated out. Read-revocation is a Concord **single-channel Rekey** (private channels) or
  a whole-community **Refounding** (public, root-derived channels); the latter is
  effectively irrevocable. Do not advertise a revocation stronger than the crypto
  enforces.
- **A current-epoch key reads forward only.** CORD-05 hands a joiner the *current*
  `(key, epoch)`; reading history needs every prior epoch key, which a scoped grant
  deliberately omits, and the key cannot follow past the next Rekey. External access is
  inherently epoch-bounded — the privacy-positive default. Nobody should "fix" that by
  shipping old-epoch keys; that is a history-leak regression.

**What is never exposed by either compromise:** the bridge cannot read, and a
participant's compromise is contained to the communities *that participant* was invited
to. There is no shared decryption service, no custodial key store, and no path by which
the router gains read capability. The line in §1 holds under compromise, which is the only
test of a trust boundary that counts.

---

## 4. Where each piece lives

| Piece | Location | In this repo? |
|---|---|---|
| Lane-2 routing (forward sealed wraps by plane pubkey) | `src/bridge.mjs` | ✅ |
| Concord derivation primitive (`group_key`, plane/channel keys, `communityId`) | `src/concord_lib.mjs` | ✅ |
| Sealed-lane rate caps (per-plane, per-recipient) | `src/bridge.mjs` + `tests/lane2_caps.mjs` | ✅ |
| Invite acquisition + the §2 provenance adjudication + decryption | the participant's own runtime | participant-side |

The consumer's decryption and invite-provenance toolchain is deliberately **not** in the
bridge: putting it there would mean the bridge holds a read capability, which is the one
thing this design refuses. The in-repo half (`concord_lib.mjs`) is pure derivation with no
secret of its own; the reading half lives with the party that holds the key.

*See also: [`SPEC_EXTERNAL.md`](SPEC_EXTERNAL.md) §3.1 (non-custody is the whole trust
story), §4.1 (the S1/S2/S3 substrate fork — the Concord read-cap path is S2), and
[`SECURITY.md`](../SECURITY.md) (the bridge never holds a member's private key).*
