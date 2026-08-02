# In-door consent — the participant must agree to be brought in

**Status:** DESIGN, for crew review (#131 + #132 as one story; #133 framed and recommended-against).
Nothing here is built. The build is a separate PR after this design is reviewed and accepted.

> Leads named on the issues: **@Dennis** — prior art + the consent-record primitive (the inverted
> grant). **@Kerouac** — the participant-facing request + the ToS language. **@My Dude** — spec
> synthesis + the `bridge.mjs` enforcement point. **@Neil** — the config/enforcement surface.

---

## 1. The principle, in one line

**waggle must not ingest a person's content into the hive without that person's consent** — and the
door has two sides, so the gate must too.

The spec already holds the out-door half:

> **§3.9 — Out-door consent.** *"The out door is per-note, explicit, member-initiated opt-in. The
> bridge never federates a member's content automatically, in bulk, or by default."*

That governs the person whose content **leaves**. There is no matching invariant for the person
whose content is pulled **in**. This document defines it, for both in-paths, as one story.

**It is not about privacy.** Their notes are already public; reading them is not a violation. What
they never agreed to is **association and re-publication** — having their content piped into a
private, walled, commercial community and re-authored under the bridge's own key, so they appear to
be *in* a space they never joined, under terms they never saw. *"You may read my public posts"* is
not *"you may mirror me into your community as your own `kind:9`, under its ToS."*

And it dissolves a live unease: **§3.3 / B-2**, where re-authoring a third party's content makes the
operator warrant rights he does not hold. **Consent at the source removes that exposure** — the
content is now published into the community *with the author's agreement*, not despite its absence.

---

## 2. The consent gradient (the map of where we stand)

Ingest is not one thing. It arrives on three ramps, and they already differ in how consensual they
are — the estate half-built this gradient without ever naming it as *consent*.

| ramp | who chose | consent today | gated today by | this doc |
|---|---|---|---|---|
| **granted participant** (§4.1) | the participant — holds a key, chose to join | **explicit** | a signed 440 admission | fine as is |
| **reply to our note** (`watch_events`) | the replier — chose to address a member | **implied, thin** | §4 quarantine (community side only) | **#132** — add the author gate |
| **feed-mirror** (`watch_authors`) | *nobody asked them* — we take the whole feed | **none** | author-allowlist (our choice, not theirs) | **#131** — add the author gate |

The wall has a door each way, and an in-door should open only when **both** sides agree:

| direction | community gate | external-party gate |
|---|---|---|
| out (member → Nostr) | — (member's own content) | §3.9 ✅ |
| in — feed-mirror (`watch_authors`) | — | **#131 — missing** |
| in — reply (`watch_events`) | §4 quarantine ✅ | **#132 — missing** |

The community can already say *"let this in."* **The participant has never been asked *"do you
consent to be brought in, under these terms?"*** Both in-paths are missing that gate. #131 and #132
add it; they are one mechanism applied at two capture points, and ship as one spec.

---

## 3. What is genuinely new — and why it may be a primitive, not a config field

This **inverts the grant direction.** Every grant in the estate flows *authority → subject*
(maintainer admits a participant; maintainer delegates data to an agent). Consent flows the other
way: *subject → bridge*. **The grantor is the data subject, not the authority.**

Nostr has no native "accept." A `kind:3` follow is **unilateral** — I can follow you, aggregate you,
mirror you, and you are never asked and cannot refuse in-protocol. So *consent to be aggregated* is
a handshake the protocol **lacks**. That is the deep reason this is not a checkbox: we are defining
a missing primitive, and it may be worth a NIP.

The closest proven prior art is **ActivityPub's Follow / Accept**: a locked account *must* accept a
follow before the follower receives anything. The shape we need is the same — *request → the subject
decides → only then does content flow* — adapted to Nostr, where there is no server holding the
subject's account to enforce it, so the acceptance must be **a signed event the bridge verifies.**

---

## 4. The consent record — the mechanism, weighed

The issue is emphatic: *do not treat "scoped data grant" as the answer; weigh it.* Here is the weigh.

### Candidate A — a participant-issued NIP-DA `440` (recommended)

The participant signs a `440` granting waggle a **`da-cap: mirror`** capability, scoped to the
community (salted-hash of the channel id, exactly as an admission scopes). Same wire format as a
channel admit — **but authored by the participant, granting *to* waggle**, rather than by the
maintainer granting *to* a participant.

```
kind 440                              (signed by the PARTICIPANT — the inverted grantor)
  ['p', <waggle bridge pubkey>]       the grantee is the bridge
  ['da-scope', sha256(community ‖ salt), salt]   which community they consent to be mirrored into
  ['da-cap', 'mirror']                the capability granted: mirror my public content into it
  ['tos', <sha256 of the exact ToS text shown>]  binds the consent to the terms presented (§7)
  content: ""
```

- **Revocation is a plain `441`** e-tagging it — same shape as every revoke in the estate, and the
  participant holds the revoke key because they are the grantor. Revoke → the mirror stops.
- **It reuses everything.** The bridge already verifies `440`s (`grantSet`, `src/bridge.mjs:565`);
  the same verify-sig-author-scope-cap path applies. `tools/grant.mjs`-style issuance applies.
- **It is visible on the grant plane we just built.** Nvoy's universal reader
  (`console/capgrants.mjs`) surfaces *every public `440` a key signed* — so a participant's consent
  grant shows on **their** plane (they see and revoke their own consent) and inbound consents are
  legible to the maintainer. The consent record is a first-class citizen of the plane, for free.
- **It is not a semantic stretch.** A `da-cap` grant is already **bodyless** — a channel admit
  carries no data set either. `mirror` is another capability alongside `admit`/`task`. The *only*
  novelty is the inverted grantor, which is exactly the novelty we want to name.

### Candidate B — a purpose-built consent event (a new kind)

A dedicated `kind` meaning *"I, this key, consent to <bridge> aggregating my content into
<community> under <ToS>, until revoked."*

- **For:** semantically precise; a clean, standalone, NIP-shaped primitive that says what it means;
  no risk of "why is a data-delegation kind being used for consent?"
- **Against:** new wire format, new verification, new tooling, a new provisional kind to version; it
  does **not** appear on the grant plane; more surface to build and maintain, for a semantic
  cleanliness that A already achieves via the bodyless-capability pattern.

### Recommendation

**Candidate A**, and document the `da-cap: mirror` participant-issued grant *as* the consent
primitive. It gives us the missing handshake **and** reuses issuance, verification, revocation, and
the grant plane — while the inverted grantor is stated plainly as the novel thing. If the crew wants
harder semantic separation between "delegating data" and "consenting to aggregation," B is the
fallback and this section is where that call is made. **Dennis leads this decision.**

*(One honest wrinkle either way: the consent record is a public event that names the participant's
key and the community hash. That is the same optics trade §4.1 already accepted for admissions — an
auditable signed consent beats a hidden allowlist — but it means "X consented to be mirrored into
community-hash-Y" is publicly legible. Acceptable, and stated.)*

---

## 5. The handshake

Both in-paths run the same four beats. They differ only in what **triggers** beat 1.

```
1. TRIGGER
     #131 feed-mirror:  the maintainer wants to mirror author X (a watch_authors add).
     #132 reply lane:   an external author replies to a member's federated note (watch_events catch).
2. REQUEST + DISCLOSURE  — a NIP-17 DM to X's npub that IS the disclosure (many won't know the
     bridge exists): "a bridge caught/would mirror your content into a private community; here is
     exactly what that means [§7 ToS]; reply with a consent grant to allow it, or ignore to decline."
3. CONSENT               — X signs the §4 record (a 440 to waggle, cap mirror, scope this community,
     tos = hash of the exact terms shown). The bridge verifies it.
4. FLOW                  — only now does X's content proceed: for #131 the mirror begins; for #132
     the held reply is released into the §4 community quarantine for the *community* gate.
```

**Who sends the beat-2 DM — and does it violate "waggle carries, it never authors"?** A real design
question, flagged for the crew. The request is not *content authored into the community*; it is an
**operational disclosure to an external party about the bridge's own operation** — closer to a
service ToS notice than to speech. Two options:
- **(a) the bridge sends it**, as a strictly templated, non-conversational disclosure (no free
  text — it rides the `src/egress.mjs` closed-slot machinery, so it can carry only the fixed ToS
  template + the target npub). This keeps "never authors" intact because there is no authored
  content, only a fixed form.
- **(b) the maintainer sends it** as themselves. Cleanest against the immutable, but it re-couples
  the flow to a human per target and loses the automation the intention asks for.

Recommendation: **(a)**, precisely because the closed-slot egress (`#134` A3) already exists to make
"the bridge emits only fixed forms, never free text" enforceable — a consent-request template is a
natural new slot type. **My Dude / Neil to confirm against the egress catalogue.**

---

## 6. The edge cases that decide whether this is safe or harmful

These are not footnotes — get them wrong and the consent mechanism *becomes* the harm.

- **The consent DM is itself an unsolicited message (#132 Q3).** DMing everyone who replies is the
  bridge spamming strangers. Non-negotiable rules: **DM once per target, ever**; **respect silence**
  (no re-ask — silence is a *no*); **respect an explicit no permanently** (never re-ask a decliner);
  rate-limit the request lane globally. A per-target "asked / declined / consented" record, durable,
  gates the DM. If we cannot send the ask without spamming, we do not mirror — full stop.
- **Default-closed (#131 Q2, #132 Q4).** No response = no ingestion. Their content stays on public
  Nostr and never enters the community. Being unable to obtain consent is not permission — it is a
  decline. This mirrors the repo's standing rule (`docs/AGENT_BRIEF.md`: "being unable to check is
  not permission").
- **Ordering — hold invisibly, not in quarantine (#132 Q1).** A reply must **not** appear in the
  community quarantine before the author has consented. Quarantine is inside the walled space;
  showing un-consented content there is the very association the person hasn't agreed to, and the
  community seeing it pre-consent can't be undone. So: capture → **hold invisibly (config/log only,
  never rendered)** → send the ask → on consent, *then* it enters the §4 quarantine for the
  community gate. **Consent gate first, community gate second.** Both required, order fixed.
- **Standing, not per-message (#132 Q2).** Consent once, revocable, covers future content — matching
  the grant model. Per-message consent would re-spam and is rejected.
- **Migration / grandfathering (#131 Q6).** Today `watch_authors` holds only consenting crew (James,
  My Dude) — no live violation, the *capability* is the gap. Crew are **members**, not mirrored
  strangers; they are grandfathered by participation (their key is in the roster, they built this).
  The invariant binds every **non-member** entry: no consent record, no mirror. New `watch_authors`
  or `watch_events` entries outside the roster require a verified consent record before the lane
  will forward them, logged on refusal.

---

## 7. The terms the participant actually sees (Kerouac's lane)

The ToS in the beat-2 DM must be short, plain, and complete enough that consent is *informed*. It
must say, at minimum:

1. **What the mirror does** — your public Nostr content will be reposted into a private, walled Buzz
   community you are not a member of.
2. **Where it lands and who sees it** — members of that community, inside their space, under that
   community's terms.
3. **The re-authoring, honestly** — today your content is reposted **under the bridge's key with an
   attribution to you**, not as your own signed event (a platform limitation, A8; until it lands,
   moderation and the platform's content license attach to the *operator's* copy, not to you).
4. **That it is separate from your public presence** — your notes remain yours on the open network;
   this governs only the mirrored copy inside the community.
5. **That you can revoke anytime** — a `441` (or the console's revoke) stops the mirror; already-seen
   content cannot be un-seen (physics), but no new content crosses.

The `tos` tag on the consent record (§4) is the **sha256 of the exact text shown**, so a consent is
provably bound to the terms it was given under — if the ToS changes materially, prior consents do
not silently cover the new terms.

---

## 8. The enforcement point

Grounded in the live code (`src/bridge.mjs`):

- `routePublic(ev)` (`:877`) classifies each caught public note; `forwardPublic(ev, …)` (`:810`)
  does the repost. `grantSet` (`:565`) is the admitted-participant set (from `440`s), already
  consulted at `:902` and for live `@mention` refs at `:838`.
- **#131 feed-mirror:** add a **consent set** alongside `grantSet` — `mirrorConsent: participantPub
  → {recordId, tosHash}`, built from verified participant-issued `mirror` `440`s exactly as
  `grantSet` is built from admission `440`s (`:590`). In `routePublic`, a `watch_authors` match
  forwards **only if** `mirrorConsent.has(ev.pubkey)`; else it is dropped and logged
  (`no consent — held`, never a silent drop, per §7's firehose discipline).
- **#132 reply lane:** the `watch_events` catch is held in the new **invisible** pre-consent state
  (§6 ordering) until `mirrorConsent.has(ev.pubkey)`; on consent it is handed to the existing §4
  quarantine (A1) for the community gate. Two independent gates, both must pass, participant first.
- **Revocation** rides the existing `441` path (`:575` already removes a grantee from `grantSet` on
  a matching `441`) — the same handler drops the consent record, and the mirror stops on the next
  read. No restart.
- **Config coupling (Neil):** `watch_authors` / `watch_events` entries outside the roster are inert
  until a consent record exists — so an operator *adding* an author is no longer the moment content
  flows; the participant's *consent* is. Findable and flowing stay two switches, as §3.5 already
  insists for the `#p` watch.

---

## 9. Relationship to the DM trust allowlist — adjacent, not the same

`docs/DM_TRUST_ALLOWLIST.md` governs authority to **instruct** an agent (evaluated at the agent's
runtime edge, post-decrypt). This governs authority to **ingest** a person's content (evaluated at
the bridge, before mirroring). Different actor, different question, different enforcement point.
They touch only in that both involve external parties and NIP-17 DMs. Keep them distinct: a sender
being allowed to *instruct* says nothing about a subject consenting to be *mirrored*, and vice versa.

---

## 10. #133 — community-to-community: framed, and recommended against (for now)

The third family member is the deepest, and it sits on a prior question the other two don't touch.

**The layer beneath consent: Buzz is deliberately non-federated.** §3.4, verified against Block's
source: *"no outbound-federation code exists anywhere in `buzz-relay` — non-federation is a
deliberate product property."* So Buzz-to-Buzz federation via waggle would **add a capability Block
deliberately omitted, between two walls each designed to stay walled.** That is categorically
different from our public-Nostr and MCP-agent work, which extends *Nostr's* native openness. It is a
§3.4 / B-1 "are we honoring the platform's intent?" question, not an interop question.

**Recommendation: decline actual channel-to-channel federation; use UC-2's neutral space.** §5 UC-2
already gives two communities a way to collaborate — a neutral sealed Concord channel *beside* both
walls, each side running its own waggle, neither wall opened, no membership shared. That meets the
real need (inter-community collaboration) **without** manufacturing the federation Block chose not to
build. Actual federation should not be built on the strength of this document.

**If it is ever pursued, the consent structure nests and both levels are required:**

| level | who consents | to what |
|---|---|---|
| community | the two maintainer keys | to federate at all (a signed agreement between them) |
| individual | each member whose content crosses | to appear in the *other* community under *its* terms — **this is #131/#132 at the boundary** |

A maintainer agreeing to federate **does not** consent on behalf of members; the individual gate
still applies to everyone whose content actually crosses. And a new problem the individual cases
don't have — **ToS reconciliation**: when a member's content crosses A→B, whose terms govern it, A's
or B's? The §3.3/B-2 exposure multiplies to community scale. Revocation is two-level and independent
(a community ends the link; a member stops their own content crossing). **Research/design only —
possibly no build ever.** Its own epic if it ever moves.

---

## 11. Deliverable status and the build that follows

This document is the **design** the issues asked for: intention, handshake, consent record, ToS,
enforcement point, and revocation, with the mechanism weighed. It is **not built.**

The build, in order, after this is reviewed and accepted:
1. the consent record + verification (a `consent.mjs` primitive, pure and tested, mirroring
   `capgrants.mjs` — verify a participant `mirror` `440`, resolve its `441`);
2. the request/disclosure DM as a closed-slot egress template (§5a), rate-limited and once-per-target;
3. the `mirrorConsent` set and the two enforcement gates in `bridge.mjs` (§8) — **security-relevant
   lane logic; lands as its own PR with adversarial review, never a tack-on**;
4. the ToS text (§7), Kerouac.

Default-closed until it lands: **do not point `watch_authors` or a `#p`/`watch_events` widen at
anyone outside the consenting crew in the meantime.**
