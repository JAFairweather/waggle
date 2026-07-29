# Review notes — §4.1 design review

This dir is the **design-review target** for §4.1. Two targets, two questions:

- **PR #1 (`docs/SPEC_EXTERNAL.md`)** — reviews *what ships to Derek*: the scrubbed
  external cut. Names/codenames/Claude stripped, generic capability framing.
- **`docs/internal/`** — reviews *the design*: the S1/S2/S3 substrate fork, the three
  S2 pins, the A8-is-S3-only scoping, and the head-of-dev rationale (kept intact here).
  - `SPEC_4_1_INTERNAL.md` — the extracted §4.1 (internal source, v1.9).
  - `FOLD_SOURCE.md` — the consolidated fold source, for a fidelity check: did the
    pen capture every pin the team attached?

## Open decisions to weigh explicitly (all reversible)

These four calls were made during the fold. They are flagged so the review lands on
them by choice rather than rediscovering them. No position is taken on what's correct.

1. **Genericization in the external cut.** "Claude-administered MCP identity" →
   "external MCP identity" for `SPEC_EXTERNAL.md`; the concrete Claude-as-head-of-dev
   motivation is preserved in INTERNAL spans (present in `SPEC_4_1_INTERNAL.md`, stripped
   from the cut). Question: is the generic external framing the right public posture?
2. **Version bump v1.8 → v1.9.** New section + roadmap phase treated as a minor bump.
3. **Generator OUT_REPO fix.** `PLANS/gen_external_cut.mjs` was writing to a stale
   checkout; now targets `REPOS/waggle`. (Both are the same GitHub remote.)
4. **A8 held in Phase 4, not relocated to 3.5.** The pull-forward *argument* is stated
   in §4.1 / Phase-3.5 as the hard gate on the write half + degraded mode, but A8 itself
   stays in Phase 4. Question: should A8 actually move, or is stating the gate enough?

## The three S2 pins — verify against the public source, don't take our word

The load-bearing S2 claims are Concord-crypto-dependent. They are checkable against the
**public** Concord spec — verify them there rather than echo our reading:

`github.com/concord-protocol/concord` — **CORD-01, CORD-03, CORD-06**

- **Verbatim-1059 mirror** — the bridge re-broadcasts the original signed 1059 wrap
  byte-for-byte; it never re-seals. (non-custody)
- **Private-channel `(key, epoch)`** — the read cap is a per-channel `(key, epoch)`
  pair, *not* `community_root`.
- **Revoke = 441 + CORD-06 Rekey** — de-authorization on S2 is a NIP-DA 441 *and* a
  Concord CORD-06 Rekey; the 441 alone does not rotate forward secrecy.

These are the pins where an adversarial cold read is most wanted — they are the team's
own crypto claims. Find issues against the spec; don't confirm against our summary.
