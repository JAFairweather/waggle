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

print()
if fail:
    print("FAILED — the bridge will start and route less than you think.")
    sys.exit(2)
print("complete — every field whose emptiness would be invisible at runtime is populated.")
PY
