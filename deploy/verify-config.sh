#!/usr/bin/env bash
# verify-config.sh — assert the LIVE routing policy is complete, without committing it.
#
# config.json is gitignored, and rightly: it names channels, approvers and grantors, and this
# repo is public. But that means the repo has no record of it, and a host rebuilt from
# config.example.json comes up structurally valid and behaviourally wrong — the bridge starts,
# reports healthy, and quietly routes nothing.
#
# That is not hypothetical. A key was added to watch_authors on a live box so that replies to a
# maintainer's public notes would reach the in door. Nothing in the repo records it. If it is
# lost, an external reader who was invited to "reply to any note of mine" gets no error and no
# arrival — the invitation simply stops working, silently.
#
# So: check the SHAPE against config.example.json, and check the fields whose emptiness is
# invisible at runtime. Report counts, never values.
#
#   sudo deploy/verify-config.sh [path-to-config.json]
#
#   0  complete
#   2  a required field is missing or empty
#   3  INCONCLUSIVE — could not read it (not root? wrong path?). NOT an all-clear.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${1:-/opt/waggle-read/config.json}"
EXAMPLE="$HERE/../config.example.json"

if [ ! -r "$CFG" ]; then
  echo "verify-config: cannot read $CFG — re-run with sudo, or pass the path."
  echo "INCONCLUSIVE — this is not an all-clear."
  exit 3
fi
[ -r "$EXAMPLE" ] || { echo "verify-config: missing $EXAMPLE"; exit 3; }

python3 - "$CFG" "$EXAMPLE" <<'PY'
import json, sys

live = json.load(open(sys.argv[1])).get("public", {})
example = json.load(open(sys.argv[2])).get("public", {})

# Fields whose absence the bridge cannot complain about at runtime: it starts fine and simply
# never routes the thing they enable. These are the ones a rebuild loses quietly.
REQUIRED = {
    "relays":        "no relays — the lane connects to nothing",
    "inbox":         "no destination channel — messages have nowhere to land",
    "watch_authors": "nobody is watched — replies to your members' notes are never fetched",
    "approvers":     "nobody can release a quarantined message — the in door never opens",
}

fail = 0
print("live routing policy: %s" % sys.argv[1])
for k, why in REQUIRED.items():
    v = live.get(k)
    n = len(v) if isinstance(v, list) else (1 if v else 0)
    if not n:
        print("  MISSING  %-14s %s" % (k, why)); fail = 1
    else:
        print("  ok       %-14s %d entr%s" % (k, n, "y" if n == 1 else "ies"))

missing_keys = [k for k in example if k not in live]
if missing_keys:
    print("  note     keys in config.example.json but not live: %s" % ", ".join(sorted(missing_keys)))
    print("           (not necessarily wrong — but confirm each is deliberate)")

# ── return lane (mentions out to admitted guests): scan_authors + return_lane[].authors ──
# These are the same failure class as watch_authors, but they never fail this check: each has a
# valid empty state — scan_authors absent FLOORS to approvers+grantors+trusted_repliers, and a
# return_lane entry with no authors shares the bridge key and defers echo-skip to the per-event
# registry. What the repo cannot hold is a box-side WIDENING: set an explicit scan_authors or bind
# an agent's own key on the box, and a rebuild from the example drops it silently — the gate
# narrows to the floor, or echo-skip regresses, with no error and nothing at runtime to notice.
# The generic shape-diff above cannot see return_lane[].authors at all (it is nested). So surface
# both here — counts, never values — so a human confirms the live gate is the one they intend.
scan_channels = live.get("scan_channels") or []
return_lane   = live.get("return_lane") or []
if scan_channels or return_lane:
    print()
    print("return lane (out to admitted guests) — live policy the repo cannot hold:")

    sa = live.get("scan_authors")
    if isinstance(sa, list) and sa:
        print("  ok       scan_authors   %d explicit signer(s) — box-side policy a rebuild would drop" % len(sa))
    else:
        low = lambda xs: {str(x).lower() for x in (xs or [])}
        floor = low(live.get("approvers")) | low(live.get("grantors") or live.get("approvers")) | low(live.get("trusted_repliers"))
        armed = " — scan is ARMED" if scan_channels else ""
        print("  ok       scan_authors   absent%s; trigger gate FLOORS to approvers+grantors+trusted_repliers (%d)" % (armed, len(floor)))
        print("           (an explicit box-side widening would be lost here silently; confirm the floor is the intent)")

    if return_lane:
        bound = sum(1 for r in return_lane if isinstance(r, dict) and r.get("authors"))
        print("  ok       return_lane    %d delivery target(s), %d with a bound echo-skip author" % (len(return_lane), bound))
        if bound:
            print("           (%d author-binding(s) are live policy off-repo — a rebuild drops them and" % bound)
            print("            echo-skip falls back to the per-event registry; confirm each is deliberate)")

# ── relay lane (admitted agents inject sealed kind:14 requests): relay_channels ──
# Same failure class as watch_authors and scan_channels, and it has a valid empty state: the relay
# lane is fully inert while relay_channels is empty (default-closed), so a box that does not run it
# is correct with the key absent — which is why this cannot join the hard REQUIRED set above. But
# config.example.json carries a PLACEHOLDER here (an angle-bracketed string, never a real channel).
# A rebuild that fills in relays/inbox/watch_authors/approvers and leaves this untouched comes up
# healthy and drops every relay-ingress request silently: an admitted agent's sealed post is acked
# ok:false or never routed, with nothing at runtime to notice. So surface it — count when real,
# and flag loudly when the only thing present is the example placeholder.
relay_channels = live.get("relay_channels")
if relay_channels:
    real = [c for c in relay_channels if isinstance(c, str) and c and "<" not in c]
    print()
    print("relay lane (admitted agents inject sealed requests) — live policy the repo cannot hold:")
    if real:
        print("  ok       relay_channels %d allowlisted channel(s) — box-side policy a rebuild would drop" % len(real))
    else:
        print("  MISSING  relay_channels present but unfilled (example placeholder only) — the relay lane is INERT")
        print("           (this is what a rebuild from config.example.json lands on; fill in the live")
        print("            channel(s) or drop the key entirely, but do not ship the placeholder)")
        fail = 1

print()
if fail:
    print("FAILED — the bridge will start and route less than you think.")
    sys.exit(2)
print("complete — every field whose emptiness would be invisible at runtime is populated.")
PY
