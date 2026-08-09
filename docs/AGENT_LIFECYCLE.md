# Agent lifecycle

How an agent is admitted, narrowed, and withdrawn — and, just as importantly, what none of that
reaches.

This describes the **control-command lane** half of the lifecycle plane (#309). The console screens
that drive it are designed in `docs/DESIGN_AGENT_LIFECYCLE_PLANE.md`; the proof-of-control gate an
agent passes before any of this applies to it is `src/agent_challenge.mjs`.

**Status: the lane is built and tested; the console screens that drive it are not.** Today the only
way to send one of these commands is to sign it yourself. That is honest, not a gap being hidden.

---

## Where it rides

The lifecycle plane needs **no new transport**. It is the same approver-signed, on-relay
control-command lane that the watchlist, trust and moderation verbs already use:

| | |
|---|---|
| kind | 30078 (NIP-78) |
| `d` tag | `waggle-agent-lifecycle` |
| `p` tag | this bridge's public key, exactly |
| author | must be on `public.approvers` |
| freshness | 15 minutes, with 5 minutes of forward skew |
| replay | a monotonic `created_at` watermark, persisted |

It is deliberately **not** the off-box policy service (`src/buzz_policy_*`). That lane's defining
property is *evidence, not instructions* — a third party observes something and the bridge acts on
what was observed. Lifecycle is the opposite: the owner's intent **is** the instruction, and the
approver signature is the whole gate. Do not carry that lane's reasoning across.

---

## The catalogue

Closed. An operation not on this list is refused, never defaulted — a default branch here is a way
to invent an authority nobody granted.

| operation | reach | what it actually does |
|---|---|---|
| `agent_admit` | **widens** | admits this key as a first-class member: it may post in under its own signature |
| `agent_revoke` | narrows | withdraws bridge-side admission — the bridge stops routing for this key |
| `agent_pause` | narrows | stops routing without withdrawing admission; reversible |
| `agent_resume` | **widens** | resumes routing for a paused agent |
| `agent_return_lane` | **widens** | carries mentions of this agent out to it |
| `agent_rename` | neutral | changes the console's local display label |
| `agent_forget` | narrows, **destructive** | removes the row from the projection, after revocation |

**Reach is not symmetric and is never presented as if it were.** Narrowing an agent is always safe.
Widening one is the decision an approver is actually being asked to make, so every command carries
its reach through to the result, the log line and the receipt. A log that said only
`lifecycle: agent_return_lane accepted` would not tell an owner reading it that their agent's reach
just grew.

---

## What these commands cannot do

This section exists because the tempting lie in a lifecycle UI is a "destroy agent" button.

- **`agent_admit` grants the WRITE half only.** The community relay will not serve an external key.
  A granted participant posts in as a first-class member; what reaches it is the **return lane, which
  carries mentions only**. That is not read access and must never be labelled as such.
- **`agent_revoke` withdraws only the admission this bridge issued and can revoke.** It does not
  reach the agent's runtime, does not delete or rotate the agent's key — waggle never held it — and
  does not retract anything that key already published. **Revoked is not disarmed.**
- **`agent_forget` erases a row, not a history.** Everything the agent published is still public.
- **No command may carry a credential.** These events are published to public relays, so a body with
  a key in it is not a leak — it is a publication, and it is not undoable. Secret-bearing fields are
  refused by shape, in both the parser and the lane, rather than by a caller remembering.

---

## Ordering rules

Two orderings are load-bearing, and both are refusals rather than conveniences:

- **`agent_resume` refuses a revoked agent.** Pausing and revoking are different decisions, and only
  one of them is reversible by resume. Getting this wrong would let a resume quietly undo a
  revocation. Re-admitting is available and requires a fresh approver signature — which is the point.
- **`agent_forget` refuses a live agent.** The row is the owner's only view of what the bridge is
  routing for. Forgetting a live agent would leave the bridge routing for something the owner can no
  longer see.

A **retried** command is a no-op, not an error: re-admitting an already-admitted agent reports
success. An owner clicking twice must not see an alarm where nothing is wrong. The watermark still
advances, so the replayed event does not stay replayable.

---

## Where the code is

| | |
|---|---|
| `src/agent_lifecycle.mjs` | the catalogue, body validation and admissibility. Pure — no clock, no config, no I/O |
| `src/bridge.mjs` → `handleAgentLifecycleCommand` | the envelope only: roster, signature, addressing, freshness, watermark |
| `tests/agent_lifecycle.mjs` | 67 assertions against the pure catalogue |
| `tests/agent_lifecycle_lane.mjs` | the envelope, driven with a real signer through the real bridge |

The split is the design: policy lives in the pure module so it can be asserted in full without a
bridge, and the handler holds nothing a test cannot reach in isolation.

Both suites pair every refusal with a case that must still get through. A validator asserted only to
reject cannot be told apart from one that rejects everything — that pairing is in this repo because
the un-paired version shipped a live outage.
