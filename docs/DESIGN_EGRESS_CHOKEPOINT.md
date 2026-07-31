# Design: the egress chokepoint — waggle carries, it never authors

**Status:** proposed · **Tracks:** #134 A3, the structural half of the sev-1 · **Review:** @Dennis (adversarial), then build
**Verified against:** `src/bridge.mjs` @ `bc5914e`, read line by line for every egress site, 2026-07-31.
`origin/main` has since moved to `1a19c25`, which touches `CLAUDE.md` only — `src/bridge.mjs` is byte-identical, so every line citation below still resolves.

> #134: *"Today waggle **can** emit arbitrary free text — the impersonation of 2026-07-31 was exactly
> that, and the muted agent-persona is held by prompt, not structure. Make it impossible."*

---

## 1. The problem, stated exactly

waggle is infrastructure. It is not a colleague, and it has no opinions to express. But **nothing in
the code says so.** The property "waggle only ever emits carried content and machine notices" is
today held by *convention* — by every author so far having chosen to write a template — and
convention is exactly what failed on 2026-07-31.

The gap is not that a bad path exists. It is that **the good paths and a bad path are the same
call.** Seven write sites each reach `execFile('buzz', …)` directly, and the CLI signs whatever
string it is handed. There is no seam at which "is waggle allowed to say this?" could even be asked.

### 1.1 The seven egress sites, as they stand

Read off `main` at `bc5914e`. This is the surface any fix has to cover — not a sample.

| # | site | function | what composes the bytes | free-text reachable? |
|---|---|---|---|---|
| 1 | `bridge.mjs:542` | `forward()` | inline template + verbatim `1059` JSON | no — but hand-rolled |
| 2 | `bridge.mjs:785` | `forwardPublic()` | `renderQuarantined()` / `renderReleased()` | **no — the good shape** |
| 3 | `bridge.mjs:890` | `withdraw()` | inline tombstone template | no — but hand-rolled |
| 4 | `bridge.mjs:895` | `withdraw()` | fixed `--public-reason` string | no |
| 5 | `bridge.mjs:897` | `withdraw()` | inline tombstone template | no — but hand-rolled |
| 6 | `bridge.mjs:943` | `replyInStaging(parentBuzzId, **text**)` | **whatever the caller passes** | **YES** |
| 7 | `bridge.mjs:1169` | `postRelay()` | `renderReleased()` | **no — the good shape** |

Read sites (`channels list` @281, `messages get` @1307, `scanFetchPage` @1352) author nothing and
are out of scope.

**Site 6 is the shape of the hole.** `replyInStaging` takes a `text: string`. Today all seven
callers (`bridge.mjs:963, 974, 979, 987, 990, 991, 1000`) pass fixed literals with interpolated
data, so it is *currently* benign — but its signature
is an open invitation, and the next feature that wants to "just say something in the thread" will
take it. **That is the impersonation vector, still open, as a function parameter.**

Sites 1, 3 and 5 are benign-but-hand-rolled: correct today, with nothing preventing the next edit
from concatenating a caller's string into them.

### 1.2 The distinction the fix has to preserve

"waggle never authors free text" **cannot** mean "no untrusted text ever appears in waggle's
output" — carrying untrusted text is the entire product. The real line:

| | who wrote it | how it may appear |
|---|---|---|
| **carried body** | an external author, signature-verified | **only** inside a renderer that provably neutralizes it — quoted, inert, attributed to its author |
| **machine notice** | the source code | a fixed template, with **typed** data in slots |
| **free prose** | a caller at runtime | **nowhere. No path.** |

Row 1 is not a weakening. `renderReleased` is already the strongest thing here: the `render_states`
suite tests what it **refuses** — a hostile note trying to ping the approver, mint an `APPROVED BY`
heading, break its quote, open a code fence — and it must come out inert *and still readable*.
Row 3 is the one with no legitimate instance, and it is the one to delete.

---

## 2. The mechanism

### 2.1 One chokepoint, and it does not accept strings

All Buzz egress moves behind a single module — call it `egress.mjs` — exposing one signing verb:

```
emit(descriptor) → Promise<{ buzzEventId }>
```

The load-bearing choice: **`descriptor` is a tagged union, not a string.**

```
{ template: 'quarantine_header', dest, parentId?, slots: { … } }
{ template: 'released_post',     dest, slots: { body, name, npubShort, liveRefs } }
{ template: 'console_ack',       dest, parentId, slots: { verb, author?, detail? } }
{ template: 'a7_tombstone',      dest, slots: { author, origId, delId } }
{ template: 'sealed_envelope',   dest, slots: { name, label, wrapJson } }
```

`emit` resolves `template` against a **closed catalogue** compiled into the binary, renders the
slots through per-slot typed escapers, and only then calls the signer. There is exactly one
`execFile('buzz', …)` write in the tree, inside `emit`.

A caller **cannot express** "send this sentence." The type has no field for it. That is the whole
design: not a check that can be skipped, but a vocabulary with no word for the forbidden thing.

### 2.2 Slots are typed, and the catalogue admits no prose slot

A template language with a `{message}` slot is the original hole with extra steps. So:

| slot type | admits | escaper |
|---|---|---|
| `id` / `npub` / `hex` | `^[0-9a-f]{n}$` | reject on mismatch |
| `channel` | resolved channel handle or UUID | reject on mismatch |
| `count` / `ts` | number | format only |
| `enum` | one of a literal set (`approve`\|`follow`\|`mute`\|`reject`\|…) | reject on mismatch |
| `carried_body` | **untrusted** external content | `renderReleased` / `renderQuarantined` neutralization, unchanged |

**`carried_body` is the only slot that accepts arbitrary bytes, and it is the only slot that runs
the hostile-content renderer.** At most one per template. A template carrying two would be a way to
smuggle prose past the renderer by splitting it.

**The rule that keeps this honest over time:** *no new slot type may accept unconstrained text
without invoking a neutralizing renderer.* That is the invariant to write into `CLAUDE.md`, because
it is the one a future contributor will be tempted to bend.

### 2.3 Enforcement, so the catalogue cannot be routed around

A chokepoint nobody is forced to use is a style guide. Two mechanical gates:

1. **A ban test.** A suite greps the tree for `execFile('buzz'` / `spawn*` with a `messages send|edit|delete` argv outside `egress.mjs`, and fails on any hit. Bans the reintroduction, not just the instance.
2. **A catalogue test.** Every template is rendered with hostile slot values; assert no slot escapes its frame, and assert no template exposes an unconstrained text slot.

**Both need a negative control before they count.** Per `CLAUDE.md`: *an alarm that always fires and
one that never fires fail identically.* Land each gate with a commit that deliberately violates it,
watch it go red, then revert. A ban test that has only ever passed proves only that it ran.

### 2.4 Invariants

- **INV-A3-1** — Every byte waggle emits is a source-literal template, a typed slot value, or a `carried_body` that went through a neutralizing renderer.
- **INV-A3-2** — Exactly one function in the tree invokes the Buzz signer.
- **INV-A3-3** — No caller can reach that function with a caller-composed string. Enforced by type shape, not by review.

---

## 3. What this does **not** close

Stated plainly, because the value of #134 is being able to say *closed* rather than *mitigated* —
and that claim is only worth something if its edges are honest.

- **A4 — host-root.** An operator with root can invoke the `buzz` CLI directly under waggle's `EnvironmentFile` and sign anything. The chokepoint is *in-process*; it governs waggle's own code, not the host. The OS-level narrowing landed 2026-07-31; the structural answer is **#54** — the signer becomes a policy point that refuses to sign anything that is not a verified envelope or a catalogue template. **A3 without A4 means an in-process guarantee with an out-of-process bypass** — worth having, not sufficient alone.
- **A6 — the key is not a persona.** Below, §4. A3 stops waggle *composing* prose; it does not stop the key being *read* as a colleague.
- **A8 — native foreign-signed rendering.** Buzz still shows the bridge as author of a carried post (#55). Untouched, and unchanged by this.
- **The out-of-process signer for Nostr.** `BRIDGE_SK` seals the return lane and relay acks (`bridge.mjs:1098–1102`). Those are already fixed-shape (`kind:13`/`1059` envelopes, JSON ack bodies) with no prose path, so they are **in scope for INV-A3-2's spirit but not urgent** — a second chokepoint for the Nostr signer is the natural follow-on. Flagging rather than folding in: bundling it would make one reviewable change into two.

---

## 4. A6 — the bridge key is not a persona

#134 files A3 and A6 together on purpose, and they should stay together: *"splitting them risks one
landing without the other, leaving the bypass structurally reachable."* A3 is necessary and not
sufficient — a key that cannot compose prose can still be *treated* as a colleague, and #134 records
that this has recurred twice in two days, which makes it structural rather than incidental.

The design position, for Dennis to attack:

- The bridge-process identity **must not** double as an agent persona. If something should answer questions *about* the bridge, that is a **separate colleague with its own key and its own name** — a steward, not the gate.
- Consequence worth naming: once A3 lands, a human addressing waggle in-channel gets **no reply**, because no template answers a question. That is correct — infrastructure does not converse — but it will read as broken to anyone expecting an answer. **The steward identity is what makes the silence legible**, which is an argument for building it *with* A3 rather than after it.
- **`waggle-sealed` still runs as root.** Its code is root-owned as of the 07-31 privesc fix, but the process privilege remains. It should get a dedicated non-root user matching `waggle-read` — the same treatment, for the same reason. This is a deploy change, needs host access, and is **outside what a repo-surface PR can land**: it needs the maintainer or the private brief. Named here so it is not lost, not attempted here.

---

## 5. New attack surface, named honestly

| surface | risk | mitigation |
|---|---|---|
| the catalogue itself | a template added later with a loose slot silently reopens the hole | §2.3 catalogue test asserts no unconstrained slot; review rule in `CLAUDE.md` |
| slot injection | attacker-controlled channel name / profile name rendered into a template frame | typed escapers; profile names are attacker-controlled today and already flow into `renderReleased` — same neutralization, now mandatory rather than incidental |
| `carried_body` remains the wide door | unchanged from today — it must carry hostile bytes by design | `render_states` suite; no change in posture, no regression |
| chokepoint as a single point of failure | a bug in `emit` breaks every lane at once | the flip side of the benefit: it is also the single place to fix, test, and audit. Net positive, but it raises the bar on `emit`'s own coverage |
| false confidence | "waggle structurally cannot author" is only true in-process (§3, A4) | say *in-process* every time the claim is made, including in `README`/`SPEC` |

---

## 6. Sequencing and ownership

Design → adversarial review → build, the way the relay lane was done.

| step | what | owner |
|---|---|---|
| 1 | **this doc**, adversarially reviewed — especially §2.2 (does a typed catalogue actually hold?) and §3 (is A3-without-A4 worth landing alone?) | @Dennis |
| 2 | `egress.mjs` + catalogue + `emit`, no call sites moved yet | My Dude |
| 3 | convert sites 1–7; **delete `replyInStaging`'s `text` parameter** — its seven literal call sites become named `console_ack` templates | My Dude |
| 4 | ban test + catalogue test, **each with its negative control** (§2.3) | My Dude |
| 5 | `waggle-sealed` non-root user (host change — needs the maintainer) | Neil |
| 6 | the steward-identity question (§4) — separate issue, not this PR | maintainer's call |

**Not arming-relevant.** Nothing here changes what crosses; it changes what waggle can say.

---

## 7. Open questions for review

1. **Does the typed catalogue actually hold, or does it just relocate the hole?** The honest worry: a contributor who needs to say something new adds a template, and template #40 has a `{detail}` slot that is prose in all but name. Is the catalogue test enough, or does the slot vocabulary need to be closed too — a fixed set of slot *types*, no new ones without a spec change?
2. **Is A3 worth landing without A4?** It converts "waggle can author" from *anyone with the codebase* to *anyone with host root*. That is a real reduction. But §3's caveat has to be said every time the claim is made, and #134 asks for *closed*. Does A3-alone let us say closed, or only "closed in-process"? **My read: only the latter, and we should say so** — but this is exactly the sort of claim this repo has got wrong before, so it should be Dennis's call, not mine.
3. **Should the `BRIDGE_SK` Nostr egress get the same chokepoint now or next?** (§3, last bullet.)
4. **Does the steward identity ship with A3 or after?** §4 argues *with*, on the grounds that silence needs to be legible. Weak conviction; happy to be wrong.

---

*Written in a limited environment — repo surface only, no host access, no private brief. Every
claim about current behaviour is grounded in `src/bridge.mjs` @ `bc5914e` and cited by line. Nothing
here was verified against a running box, and §4's `waggle-sealed` privilege claim is taken from #134
rather than observed.*
