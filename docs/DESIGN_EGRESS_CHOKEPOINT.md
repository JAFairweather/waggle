# Design: the egress chokepoint — waggle carries, it never authors

**Status:** proposed · **Tracks:** #134 A3, the structural half of the sev-1
**Review:** adversarial review returned on #140 — **verdict: sound, build it**, with five must-fixes; **this revision folds all five in**, plus his second-transport finding (§1.0). Re-review of the folded text is welcome but not gating.
**Verified against:** `src/bridge.mjs`, read line by line for every egress site, 2026-07-31; re-verified against `main` @ `af7122f` on 2026-08-01.
The refactors of #151–#153 have since moved every line in that file without touching an egress site, so citations here are by **function name, not line number** — see §1.1.

> #134: *"Today waggle **can** emit arbitrary free text — the impersonation of 2026-07-31 was exactly
> that, and the muted agent-persona is held by prompt, not structure. Make it impossible."*

---

## 1. The problem, stated exactly

waggle is infrastructure. It is not a colleague, and it has no opinions to express. But **nothing in
the code says so.** The property "waggle only ever emits carried content and machine notices" is
today held by *convention* — by every author so far having chosen to write a template — and
convention is exactly what failed on 2026-07-31.

The gap is not that a bad path exists. It is that **the good paths and a bad path are the same
call.** On the **Buzz egress**, seven write sites each reach `execFile('buzz', …)` directly and the
CLI signs whatever string it is handed; on the **Nostr egress**, `BRIDGE_SK` signs in-process
(§1.0). Neither has a seam at which "is waggle allowed to say this?" could even be asked.

### 1.0 There are **two** egress transports, not one

The first draft enumerated the Buzz-CLI surface and treated the Nostr path as a footnote. That was
the draft's real gap, and it is corrected here before anything else, because it changes what a ban
test can even see.

| transport | how bytes leave | signs with | covered by a `buzz`-grep? |
|---|---|---|---|
| **Buzz egress** | `execFile('buzz', …)` → the CLI signs a `kind:9` | `BUZZ_PRIVATE_KEY` (via the CLI) | yes |
| **Nostr egress** | `finalizeEvent` → `publishWrapToRelays`, straight to relays | **`BRIDGE_SK`, in-process** | **no — structurally invisible to it** |

The Nostr path is real and live: the seal + wrap construction in `returnLaneSend()`, the relay-lane
acks in `relayReject()` / `postRelay()`, and the sealed return-lane rumors in `scanReturnLane()` — all
through `returnLaneSend()` and
`publishWrapToRelays()`. It never touches the CLI.

It is **prose-free by shape, not by structure** — its bodies are JSON acks and envelopes today,
with nothing preventing a future caller from putting a sentence in one.

**Consequence for every claim in this doc:** the seven-site enumeration is complete **on the Buzz
egress**, and that qualifier is load-bearing. "waggle cannot author" without naming the transport is
the same overclaim as dropping "in-process" (§3). The `BRIDGE_SK` chokepoint is a **named sibling**
— §2.5 — not a footnote.

### 1.1 The seven Buzz-egress sites, as they stand

Read off `main` at `af7122f`. Complete on this transport, not a sample: `bridge.mjs` imports **only
`execFile`** from `child_process` — no `spawn`, no `exec`, no `execSync`, no shell — and there are
exactly **10** `execFile('buzz', …)` call sites: the 7 writes below plus 3 reads. There is no 8th
Buzz site, and no runtime-assembled argv that could hide one.

Sites are named by **function and subcommand, never by line number**. This is a design document that
will outlive several moves of `bridge.mjs`: the refactors of #151–#153 shifted every line in that
file by 30–115 without touching a single egress site, and #154 will move them all again. What
matters here is the seven sites and their shapes, not their coordinates. Please keep it that way.

| # | site | `buzz` call | what composes the bytes | free-text reachable? |
|---|---|---|---|---|
| 1 | `forward()` | `messages send` | inline template + verbatim `1059` JSON | no — but hand-rolled |
| 2 | `forwardPublic()` | `messages send` | `renderQuarantined()` / `renderReleased()` | **no — the good shape** |
| 3 | `withdraw()` — follow-up tier | `messages send` | inline tombstone template | no — but hand-rolled |
| 4 | `withdraw()` — delete tier | `messages delete` | fixed `--public-reason` string | no |
| 5 | `withdraw()` — edit tier | `messages edit` | inline tombstone template | no — but hand-rolled |
| 6 | `replyInStaging(parentBuzzId, **text**)` | `messages send` | **whatever the caller passes** | **YES** |
| 7 | `postRelay()` | `messages send` | `renderReleased()` | **no — the good shape** |

`withdraw()`'s three tiers are separate rows because they are separate egress calls with different
argv, not because they sat on different lines.

Read sites — `resolveChannels`' `channels list`, `pollCommands`' `messages get`, and
`scanFetchPage` — author nothing and are out of scope.

**Site 6 is the shape of the hole.** `replyInStaging` takes a `text: string`, and all **seven** of
its callers live in `handleCommand`. The first draft called them all "fixed literals," which was
wrong:

```js
// handleCommand, the unrecognized-verb reply — the operator's own input, echoed in waggle's voice
replyInStaging(m.id, `unrecognized command \`${raw}\` — try **approve** …`)
```

`raw` is **runtime-variable text from an approver's channel message**. It is bounded (an approver is
already trusted, and it lands inside backticks) — but it is the free-text path *already in use*, not
a hypothetical one. **The hole is not merely a signature waiting to be abused; it has a live
caller.** That is the strongest single argument for A3, and the draft undersold it.

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
{ template: 'console_ack',       dest, parentId, slots: { verb, author?, echo? } }
{ template: 'a7_tombstone',      dest, slots: { author, origId, delId } }
{ template: 'sealed_envelope',   dest, slots: { name, channel?, wrapJson } }
```

`emit` resolves `template` against a **closed catalogue** compiled into the binary, renders the
slots through per-slot typed escapers, and only then calls the signer. There is exactly one
`execFile('buzz', …)` write in the tree, inside `emit`.

**Two slot names changed from the first draft, both on review:**

- `console_ack.detail?` → **`echo?`, typed `inline_token`** (§2.2), never a free string. `detail?` was the §1.1 hole re-entering through the catalogue's own front door — the one slot that would have had to carry `raw` from the unrecognized-verb reply. Naming it `echo` and typing it says what it is: a bounded echo of operator input, not a place to put a sentence.
- `sealed_envelope.label` → **`channel?`, typed `channel`**. `label` was prose baked into the descriptor; the only variable in it is the channel name (`**${src.channel}**`, in `forward()`'s Concord label). The surrounding words belong in the template, where they cannot be reached.

A caller **cannot express** "send this sentence." The type has no field for it. That is the whole
design: not a check that can be skipped, but a vocabulary with no word for the forbidden thing.

### 2.2 Slots are typed, and the catalogue admits no prose slot

A template language with a `{message}` slot is the original hole with extra steps. So:

**The slot-type set is CLOSED.** These eight are the whole vocabulary:

| slot type | admits | escaper |
|---|---|---|
| `id` / `npub` / `hex` | `^[0-9a-f]{n}$` | reject on mismatch |
| `channel` | resolved channel handle or UUID | reject on mismatch |
| `count` / `ts` | number | format only |
| `enum` | one of a literal set (`approve`\|`follow`\|`mute`\|`reject`\|…) | reject on mismatch |
| `inline_token` | short operator-supplied text, rendered **inside backticks** | strip backticks, newlines, `@`, and `*`/`_`; hard length cap; never leaves the code span |
| `carried_body` | **untrusted** external content | `renderReleased` / `renderQuarantined` neutralization, unchanged |

**Closing the *type* set is what makes this structural rather than conventional.** The first draft
said "no template may have a prose slot" and left it to reviewers to notice one. Instead, the
catalogue test asserts **every slot of every template declares one of the eight types above** — so a
future `detail: string` fails by construction, as an *unknown slot type*, with no reviewer required.
Adding a ninth type is then a deliberate spec change, which is exactly the friction wanted.

`inline_token` exists **only** because `handleCommand`'s unrecognized-verb reply already echoes
operator input, and deleting
that affordance would change behaviour. It is the narrowest thing that preserves it.

**`carried_body` is the only slot that accepts arbitrary bytes**, and it runs the hostile-content
renderer. The first draft capped it at one per template to stop prose being smuggled in by
splitting. **On review, that cap is not the real guard and should not be leaned on:** the guard is
the renderer plus external-author attribution. N carried bodies render as N *quoted-from-someone-
else* blocks — never as waggle's own words. What A3 blocks is **authorship reconstruction**, and
attribution blocks it at any N. Keep the cap as belt-and-braces; do not cite it as the reason.

### 2.3 Enforcement, so the catalogue cannot be routed around

A chokepoint nobody is forced to use is a style guide.

**Ban the capability, not the spelling.** The first draft proposed grepping for `execFile('buzz'`.
That is the wrong axis and was rejected on review: it is evaded by aliasing the function, by a
variable verb, by `spawn('sh', ['-c', …])` — and it is **structurally blind to the Nostr transport**
(§1.0), which never spells `buzz` at all. Ban the *imports and signer symbols* instead:

1. **An import/symbol ban test.** Only `egress.mjs` may import `child_process`; only the Nostr chokepoint (§2.5) may call `finalizeEvent` or reference `BRIDGE_SK`. Any other module touching those fails the suite. No argv reshaping evades this, and it covers **both** transports rather than one.
2. **A catalogue test.** Every template rendered with hostile slot values: assert no slot escapes its frame, and assert **every slot declares one of the eight closed types** (§2.2).

**Honest residual, stated rather than papered over:** `require('child_' + 'process')` still slips a
static check, and a determined author with commit access can always route around a lint rule. An
import ban raises the cost and reliably stops the **accident** — the next contributor who reaches
for the convenient thing — which is the actual threat model. **It is not airtight, and no claim
here should say it is.**

**Both need a negative control before they count.** Per `CLAUDE.md`: *an alarm that always fires and
one that never fires fail identically.* Land each gate with a commit that deliberately violates it,
watch it go red, then revert. A ban test that has only ever passed proves only that it ran.

### 2.4 The `wrapJson` single-line invariant

Site 1 (`forward()`) embeds `JSON.stringify(ev)` inside a fenced code block. **Its safety is
load-bearing on that JSON being single-line:** a ` ``` ` planted in an event field cannot reach the
start of a line, so it cannot close the fence and escape into prose.

That is currently true **by accident of formatting, not by rule.** A future
`JSON.stringify(ev, null, 2)` — an entirely reasonable-looking readability change — silently reopens
a fence-break. So:

> **INV-A3-4 — the `wrapJson` slot is single-line by contract.** Never pretty-printed. The escaper
> asserts the rendered value contains no newline and rejects it if it does, so the invariant is
> enforced at render time rather than trusted to whoever edits the call site next.

A catalogue test case plants a fence-and-newline payload in an event field and asserts the fence
holds.

### 2.5 The sibling: a Nostr-egress chokepoint

Same shape, second transport (§1.0). All `BRIDGE_SK` signing moves behind one module exposing a
single verb over a **closed set of envelope kinds** (`kind:13` seal, `kind:1059` wrap) and typed
JSON ack bodies. No caller may hand it a free string either.

Its bodies are machine JSON today, so this is **lower urgency than the Buzz chokepoint but not
optional** — INV-A3-2 is false while a second signer path exists. §2.3's import ban covers both from
day one, which is what stops the Nostr path drifting toward prose while the Buzz path is being
fixed.

### 2.6 Invariants

- **INV-A3-1** — Every byte waggle emits is a source-literal template, a typed slot value, or a `carried_body` that went through a neutralizing renderer.
- **INV-A3-2** — Exactly one function per transport invokes a signer: one for Buzz, one for Nostr. No third.
- **INV-A3-3** — No caller can reach either with a caller-composed string. Enforced by type shape, not by review.
- **INV-A3-4** — `wrapJson` is single-line by contract (§2.4).
- **INV-A3-5** — Every slot of every template declares one of the eight closed types (§2.2). A ninth requires a spec change.

---

## 3. What this does **not** close

Stated plainly, because the value of #134 is being able to say *closed* rather than *mitigated* —
and that claim is only worth something if its edges are honest.

- **A4 — host-root.** An operator with root can invoke the `buzz` CLI directly under waggle's `EnvironmentFile` and sign anything. The chokepoint is *in-process*; it governs waggle's own code, not the host. The OS-level narrowing landed 2026-07-31; the structural answer is **#54** — the signer becomes a policy point that refuses to sign anything that is not a verified envelope or a catalogue template. **A3 without A4 means an in-process guarantee with an out-of-process bypass** — worth having, not sufficient alone.
- **A6 — the key is not a persona.** Below, §4. A3 stops waggle *composing* prose; it does not stop the key being *read* as a colleague.
- **A8 — native foreign-signed rendering.** Buzz still shows the bridge as author of a carried post (#55). Untouched, and unchanged by this.
- **The Nostr transport** — no longer deferred. The first draft called it "in scope for INV-A3-2's spirit but not urgent"; review corrected that to a **named sibling chokepoint** (§1.0, §2.5), because a ban test scoped to the Buzz surface cannot see it at all.

### 3.1 The wording rule: "closed **in-process**", never bare "closed"

The qualifier is not throat-clearing — it is the difference between a true claim and a false one,
and it must appear **at every site that restates the claim**: `README`, `SPEC_EXTERNAL`, #134's
closing comment, and any release note. A half-qualified claim is worse than an unqualified one,
because three clean copies of "waggle structurally cannot author" read as *corroboration* — the
repo's own `CLAUDE.md` warns that these claims have each been wrong in a shipped artifact at least
once, and this is exactly how that happens.

**A3 earns: "waggle structurally cannot author free text *in-process*, on both egress transports."**
**A4 (#54) earns the unqualified sentence.** Until then, anyone tempted to drop the qualifier should
treat that impulse as the bug.

---

## 4. A6 — the bridge key is not a persona

#134 files A3 and A6 together on purpose, and they should stay together: *"splitting them risks one
landing without the other, leaving the bypass structurally reachable."* A3 is necessary and not
sufficient — a key that cannot compose prose can still be *treated* as a colleague, and #134 records
that this has recurred twice in two days, which makes it structural rather than incidental.

The design position (reviewed; §7-Q4 is the part left open):

- The bridge-process identity **must not** double as an agent persona. If something should answer questions *about* the bridge, that is a **separate colleague with its own key and its own name** — a steward, not the gate.
- Consequence worth naming: once A3 lands, a human addressing waggle in-channel gets **no reply**, because no template answers a question. That is correct — infrastructure does not converse — but it will read as broken to anyone expecting an answer. **The steward identity is what makes the silence legible**, which is an argument for building it *with* A3 rather than after it.
- **`waggle-sealed` still runs as root.** Its code is root-owned as of the 07-31 privesc fix, but the process privilege remains. It should get a dedicated non-root user matching `waggle-read` — the same treatment, for the same reason. This is a deploy change, needs host access, and is **outside what a repo-surface PR can land**: it needs the maintainer or the private brief. Named here so it is not lost, not attempted here.

---

## 5. New attack surface, named honestly

| surface | risk | mitigation |
|---|---|---|
| the catalogue itself | a template added later with a loose slot silently reopens the hole | **closed slot-*type* set** (§2.2) — an unknown type fails by construction, no reviewer required |
| slot injection | attacker-controlled channel name / profile name rendered into a template frame | typed escapers; profile names are attacker-controlled today and already flow into `renderReleased` — same neutralization, now mandatory rather than incidental |
| **fence break via `wrapJson`** | a pretty-printed envelope lets a planted ` ``` ` reach line-start and escape the code block | **INV-A3-4** (§2.4) — single-line by contract, asserted at render time, with a planted-payload test case |
| **the second transport** | a Buzz-scoped ban test is blind to `BRIDGE_SK` → relays | §1.0 / §2.5 sibling chokepoint; the **import ban** (§2.3) covers both transports from day one |
| `carried_body` remains the wide door | unchanged from today — it must carry hostile bytes by design | `render_states` suite + external-author attribution; no change in posture, no regression |
| chokepoint as a single point of failure | a bug in `emit` breaks every lane at once | the flip side of the benefit: it is also the single place to fix, test, and audit. Net positive, but it raises the bar on `emit`'s own coverage |
| **static checks are evadable** | `require('child_' + 'process')` slips an import ban | **not airtight, and never claimed to be** (§2.3) — it stops the accident, which is the threat model |
| false confidence | "waggle structurally cannot author" is only true in-process (§3.1, A4) | say *in-process* at **every** restatement site — a half-qualified claim reads as corroborated |

---

## 6. Sequencing and ownership

Design → adversarial review → build, the way the relay lane was done. **Step 1 is done** — the adversarial reviewer
reviewed against `src/bridge.mjs` and returned *sound, build it* with five must-fixes, all folded
into this revision.

| step | what | owner | state |
|---|---|---|---|
| 1 | adversarial review of this doc | the adversarial reviewer | ✅ **done** — verdict *build it*; five must-fixes folded in |
| 2 | `egress.mjs` + catalogue + `emit`, no call sites moved yet | the bridge engineer | build scope |
| 3 | convert Buzz sites 1–7; **delete `replyInStaging`'s `text` parameter** — its seven call sites become `console_ack`, with the unrecognized-verb reply's `raw` becoming an `inline_token` (§2.2) | the bridge engineer | build scope |
| 4 | import/symbol ban test + catalogue test (closed type set, fence-break case), **each with its negative control** (§2.3) | the bridge engineer | build scope |
| 5 | the Nostr sibling chokepoint (§2.5) — INV-A3-2 is false until it lands | the bridge engineer | build scope |
| 6 | `waggle-sealed` non-root user (host change — needs the maintainer) | the read-lane engineer | blocked on host access |
| 7 | the steward-identity question (§4) — separate issue | maintainer's call | open |

**Not arming-relevant.** Nothing here changes what crosses; it changes what waggle can say.

---

## 7. Questions, and how review answered them

The first draft's four open questions, with the answers now folded into the design:

1. **Does the typed catalogue hold, or just relocate the hole?** *It relocates it unless the slot **type** set is closed.* Draft-me proposed "assert no template has an unconstrained slot," which still needs a reviewer to judge *unconstrained*. **Answered by §2.2:** eight types, closed; an unknown type fails by construction. This was the sharpest correction — it converts §7-Q1 from convention back into structure.
2. **Is A3 worth landing without A4?** *Yes — and it earns only the qualified sentence.* **Answered by §3.1:** the qualifier must appear at every restatement site, because three unqualified copies read as corroboration. A4 (#54) earns the bare word.
3. **Nostr chokepoint now or next?** *Neither — it was mis-scoped as a footnote.* **Answered by §1.0 / §2.5:** it is a second transport, and §2.3's import ban covers it from day one. INV-A3-2 is false until it lands.
4. **Steward identity with A3 or after?** Still open (§6 step 7) — the one question review left to the maintainer.

**Remaining for the maintainer, not the reviewer:** step 6 (`waggle-sealed` non-root) needs host
access, and step 7 is a naming/identity call.

---

*Written in a limited environment — repo surface only, no host access, no private brief. Every claim
about current behaviour is grounded in `src/bridge.mjs` and was re-verified against `main` @
`af7122f`; the adversarial reviewer independently re-derived the enumeration against the same file
and it agreed (10 `execFile('buzz'…)` = 7 writes + 3 reads, `execFile` the only `child_process`
import). That enumeration was re-run after #151–#153 landed and is unchanged — those refactors moved
lines, never egress sites. Nothing here was verified against
a running box, and §4's `waggle-sealed` privilege claim is taken from #134 rather than observed.*
