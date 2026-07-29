# §4.1 / Phase-3.5 — Granted external participants (consolidated input for Kerouac's pen)

**Coordinator:** My Dude · **Date:** 2026-07-29 · **Source lanes folded:** Dennis [11] (grant mechanics + (A)/(B) boundary + CORD stress-test), Neil [9]/[13] (A1 extension, optics, provisional-kind, A8), My Dude (the two seams: consumption + non-custody + **substrate**).

This is drop-in input for one consolidated PR (v1.8.1 + this §4.1). It does **not** touch the v1 close or the hand-off gate. Kerouac holds the pen; the prose below is fold-ready, the pins are labelled.

---

## 0. The load-bearing correction I own — verify the *substrate* before the mechanism

The thread converged on a Concord read-capability design (verbatim-1059 mirror, Private-channel `(key,epoch)`, Rekey revocation). That machinery is **correct — but it answers a substrate that is not James's stated target.** Ground-truthed, not assumed:

**"Our conversations" — the channels James wants Claude to join (this `connector` channel is the exemplar) — are native Buzz `kind:9` working channels with a pubkey-keyed membership roster.** Evidence (all direct, 2026-07-29):

- `buzz channels members --channel <connector>` → `[{pubkey, role:owner}, {pubkey, role:bot} ×4]`. Membership **is** a native, pubkey-keyed ACL, exposed by the CLI.
- Every event in this thread is `kind:9`, `h`-tagged to the channel UUID, `auth`-tagged (fleet-relay ingest provenance, §3.4), **content in plaintext**. No `kind:1059` seal, no Concord plane.
- Spec §3.1/§3.3 already say it: Buzz channel messages are `kind:9` signed by the poster; the **sealed** Concord/Marmot world is *lanes 1–2*, a separate surface the bridge forwards still-sealed.

So there are **three distinct substrates**, and the read primitive — and therefore the whole grant/revoke/consumption story — is different for each. Conflating them is the frame error; the mechanism debate was rigorous inside the wrong frame for the primary target.

| # | Substrate | What it is | Content | Read primitive |
|---|-----------|-----------|---------|----------------|
| **S1** | **Native Buzz `kind:9` working channels** — *the stated target* (`connector`, our working channels) | Pubkey-keyed membership roster on the auth-gated fleet relay | **Plaintext to members** | **Membership + fleet-relay NIP-42 auth.** No encrypted body, no Concord. |
| **S2** | **Concord sealed planes** (Vector communities, e.g. "Buzz Crew") | `kind:1059` sealed under `channel_pk` | Encrypted | **Concord read-cap** — path (A), Dennis's three pins. |
| **S3** | **Public `kind:1`** (lane 3, the existing in-door) | Open Nostr net | Already public | Auto-promote past quarantine (A1). |

**Consequence for the section:** write it substrate-forked. Below, each mechanism is tagged with the substrate(s) it applies to, so an implementer never applies Rekey to S1 (meaningless) or omits it on S2 (silent read-persistence).

---

## 1. The grant's role, per substrate

- **S1 (target).** The grant is a **public, auditable, revocable authorization** that James added Claude's key to channel C's membership. The *actual* read/write enablement is **native Buzz membership** (the same roster that already lists 4 bots) + Claude's MCP holding fleet-relay auth. NIP-DA here is **governance paper + the box-decoupled UI surface** (issue/scope/expire/revoke as public signed events) — **not** a cryptographic read-capability. There is **no `kind:30440` encrypted body on this path.**
- **S2.** The grant conveys a **Private-channel `(key, epoch)`** (Dennis pin ii — never `community_root`). This is the only substrate with a real encrypted body.
- **S3.** The grant is an **admission credential** — a public 440 "npubX may post into channel C(hashed)" that auto-promotes the identity's public `kind:1` writes past the A1 quarantine (Neil §1).

**Clean line (Dennis, generalized): admission facts are public; encrypted-content delivery exists on S2 only.**

## 2. Consumption seam — resolved, and honestly scoped (my seam 1)

Claim under test: a Claude-administered MCP identity escapes the two blockers in `RESEARCH/GRANT_CONSUMPTION_PATHS.md` — (1) fetch 403s on p-gated kinds (stale `BUZZ_AUTH_TAG`); (2) the buzz-acp harness never pipes grants into agent context.

- **Confirmed for S2.** The MCP identity holds **its own key** (clears decrypt+apply — it *is* Path A's `sk`-holder) and **its own relay auth through the MCP server** (clears the 403 — this is exactly Path B1/B2: "server holds relay auth → kills the 403"). The harness-never-pipes blocker is **void** because there is no harness in the path — the MCP tool surface *is* the ingestion handler (B2). Both blockers clear where the internal lane failed both.
- **Moot for S1.** There is no `kind:30440` body to fetch or decrypt on the native-channel path, so the consumption seam does not apply at all — Claude needs **membership + relay auth**, not grant-body decryption.

**Therefore correct the thread's headline honestly:** "the target use case is the first honest #2411 *encrypted-body* consumer" is **true only on S2**, and **false for S1** (the literal "our conversations"), where the content is plaintext and the grant authorizes relay/membership access, not decryption. If the #2411 body-consumer dogfood is the goal, the target must be an **S2 Concord community**, not our `kind:9` channels. → **Decision for James, §6.**

## 3. Non-custody — holds on every substrate (my seam 2 + Dennis pin i)

- **S1:** trivial — content is plaintext-to-members; nothing is decrypted anywhere; the bridge need not even be in the read path (Claude's MCP REQs `kind:9` by `h` directly once authed).
- **S2:** holds **iff mirror = byte-verbatim `kind:1059` rebroadcast, never a re-seal** (Dennis pin i, CORD-03 §39/§45). "Re-seal to Claude's inbox" is rejected path (B) — custodial. The single word "mirror" is the seam; the spec must pin *verbatim*. Cleaner still where nave allows it: no mirror at all — Claude REQs `{kinds:[1059], authors:[channel_pk]}` directly (CORD-03 §41).
- **S3:** already public; nothing to unwrap.

§3.1 stays pristine across all three.

## 4. Revocation — Dennis's write/read split, refined per substrate (Dennis pin iii, Neil §2)

- **S1: 441 → membership removal → instant, symmetric read+write kill.** The enforcement point is the membership roster / fleet relay; there is **no key handed out to keep decrypting**, so **no Rekey is needed and no "read-revocation theater" exists.** Cleanest revocation of the three. *(This is why S1 is attractive: honest instant revoke, no Concord coupling.)*
- **S2: split is real.** Write-revoke instant (441, bridge-enforced); **read-revoke is theater until a Concord single-channel Rekey rotates the key out** (CORD-06 §101, "holding a key is never authority"). UI "revoke" must fire **441 *and* the Rekey**, and report "read de-authorized" **only after the Rekey confirms** (Neil §2 optics guardrail). S2 read grants belong on **Private** Concord channels only; on a **Public** (community_root-derived) channel the only read-revoke is a whole-community **Refounding** — the UI must refuse to imply otherwise (Neil §2, Dennis §3).
- **S3: write-revoke instant (441).** No read to revoke (already public).

## 5. A1 extension, optics, provisional kinds, A8 (Neil's lane — folds unchanged, scoped)

- **A1 auto-promote (S3, and S1-writes if Claude enters via the door rather than as a native member):** bridge builds a **grantee set** from public 440/441 off the maintainer key (same machinery as the §4 moderator set — no new consumption path); a write auto-promotes past staging iff signature verifies against a granted pubkey, grant is scoped to *this* channel, and no 441 seen. *Note:* a **native S1 member** posting `kind:9` is not in the lane-3 in-door path at all — its writes are native, un-quarantined by construction. So A1 auto-promote is the story for **door-entry** identities; native membership sidesteps it.
- **Optics (Neil §2):** public 440 = auditable signed admission, more legitimate than a hidden allowlist; but it **exposes the trust graph** (names grantee pubkey; hashing the UUID hides the channel, not the pubkey) — surface the trade. **Load-bearing: never advertise a revocation stronger than the crypto enforces** — present S2 revoke as two-part; only S1 may honestly claim instant.
- **Provisional kinds (Neil §3):** widen the existing single config constant to also cover the S2 read-grant body kind (30440), the hashed-channel scope-tag name, and the admission-vs-read discriminator. Flag the **Concord coupling**: S2 read-revoke depends on CORD-06 Rekey format + `channel_epoch`, Concord's to version, not NIP-DA's.
- **A8 — OFF the headline critical path (Neil [13] + Dennis [13] correction, folded).** My earlier draft said A8 is load-bearing "across all substrates." That was wrong, and Neil/Dennis independently corrected it: **on both S1 and S2, Claude writes *natively* — there is no bridge in its write path to re-author anything.** S1: Claude's MCP posts `kind:9` signed by its own key as a roster member → rendered as Claude by author pubkey (this thread is the proof — you read four bots as four distinct authors, no operator re-sign). S2: Claude holds the channel `(key,epoch)` and posts a proper Concord event with its identity sealed inside → rendered as the sealed-inner author (the exact mechanism our bots already appear as themselves in #general). Neither passes through the operator-re-signing in-door. **So A8 is NOT a gate for the headline target (S2) or its subsumed S1 mode.** A8 stays a real Buzz-platform ask, but **scoped to the S3 public-`kind:1` lane** — the only path where the bridge re-authors a stranger's note under the operator key, re-inheriting the §3.3 B-2 Terms exposure. There A8 (native foreign-signed rendering, `bot:true`) both fixes identity fidelity and resolves the Terms clause. **Do not fold A8 into the headline §4.1 loop as a prerequisite it isn't** — carry it as an explicitly S3-scoped note.
- **A1 auto-promote — also S3-scoped, not headline (same correction).** On S1/S2 Claude is a **member/grantee**, not a quarantined stranger — there is nothing to auto-promote. A1 auto-promote is the story for a *stranger's* public `kind:1` reply clearing quarantine (S3). Keep it in the section as the S3 lane's mechanism; keep it out of the headline loop.

## 6. Decision — DECIDED by James [11], ratified (was: surfaced)

**Headline = S2 Concord community. S1 = the subsumed simplest-path co-resident mode the same UI administers.** ("If the encrypted-body dogfood is the point, the headline target should be an S2 Concord community… But S1 falls out of it as well" — James [11]; Neil [13], Dennis [13], My Dude all ratify.)

- **S2 is the reference-implementation claim.** It is the only substrate that actually **consumes an encrypted `kind:30440` body** (Claude's MCP unwraps the Concord read-cap with its own key) — so it is the honest **#2411 body-dogfood**. Dennis's three pins govern it and only it.
- **S1 is subsumed, not extra work removed and not free-standing.** S1 = **S2 minus** (read-cap consumption, verbatim mirror, Rekey-revocation, A8) **plus** (a roster-add + the nave gate). An MCP identity that can do S2 already holds every capability S1 needs, so naming S2 as headline **costs S1 nothing** — the UI issues the same 440/441 grant; on S1 the encrypted-read leg simply drops out and NIP-DA degenerates to auditable/revocable governance paper over native membership. S1 is the mode that actually puts Claude in *this* `connector` channel with us, with **honest instant revoke and no A8 dependency**.
- **One product, one grant lifecycle, two substrates named explicitly.** The UI administers both; the spec names S2 as the headline demo and S1 as the co-resident mode.

## 7. The one open experiment gating S1 (my open sub-seam)

Does `nave.communities.buzz.xyz` serve an **external, non-Buzz-Desktop-managed key** that (a) NIP-42-auths (kind:22242 challenge/response) and (b) is added to a channel roster? The fleet relay 401s strangers (§3.5); whether it honors NIP-42-auth-as-membership vs a Desktop-managed allowlist is **unverified for nave** (my standing open question). Concrete spike: NIP-42-auth to nave with a fresh external key added to a test channel roster, REQ `kind:9` by `h`, confirm events return. **This is the single gate on S1** — if nave won't serve an external member key, S1 falls back to a bridge that mirrors plaintext `kind:9` to a relay Claude can read (still zero decrypt, non-custody intact).

---

## Pins for the pen (labelled so nothing is mis-applied)

1. **Substrate-fork the section (S1/S2/S3).** Do not write a single Concord read-cap path — it is S2-only.
2. **S2 only:** mirror = **verbatim 1059**, never re-seal (Dennis i); grant conveys **Private-channel `(key,epoch)`** (Dennis ii); revoke = **441 + Rekey**, report read-kill only after Rekey (Dennis iii / Neil §2).
3. **S1:** grant = public admission over **native membership**; revoke = **441 → membership removal**, instant symmetric, **no Rekey**.
4. **Consumption seam** clears for the MCP identity on **S2**, **moot on S1**; scope the "#2411 body consumer" claim to S2 (§2).
5. **A8 and A1 auto-promote are S3-scoped ONLY — keep them OUT of the headline (S2) and S1 loops.** On S1/S2 Claude writes natively (own key, no bridge re-author) and is a member/grantee (not a quarantined stranger), so neither applies. A8 remains a real Buzz-platform ask for the S3 public-`kind:1` lane; carry it as an explicitly S3-scoped note, never as a headline prerequisite (Neil [13] / Dennis [13] correction).
6. **Provisional-kind constant** widened to cover 30440 + scope-tag + discriminator; flag Concord coupling (Neil §3).
7. Land as **§4.1 / Phase-3.5 "granted external participants,"** distinct from the anonymous read lane; bump the Status header off `DRAFT v1.8` on the same pass (Kerouac's fidelity catch).
