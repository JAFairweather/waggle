#!/bin/sh
# deploy/verify-deployed.sh — post-deploy drift check (issue #33).
#
#   sh deploy/verify-deployed.sh read   bridge@<host>  [git-ref]   # /opt/waggle-read
#   sh deploy/verify-deployed.sh sealed <admin>@<host> [git-ref]   # /opt/waggle-sealed
#   sh deploy/verify-deployed.sh read   /local/tree     [git-ref]  # a local tree (used by the test)
#
# deploy.sh SHIPS code but nothing confirms afterwards that what is running is what was
# shipped. This compares each shipped file on the deployed tree against the git blob it
# should match at <git-ref> (default HEAD) and FAILS LOUDLY on any mismatch. Run it after
# every deploy: a build that predates the send-journal instrumentation gives the tripwire
# nothing to diff against, so silent drift = detection degraded to nothing.
#
# What is checked: exactly deploy.sh's rsync ship list. config.json, .env and data/ are
# NEVER shipped (deploy.sh has no --delete and does not list them), so they are excluded
# here on purpose — checking them would report guaranteed false drift.
#
# Exit: 0 = deployed tree matches the ref; 1 = drift found; 2 = usage / bad ref / no tree.
set -eu

TARGET="${1:-}"; DEST="${2:-}"; REF="${3:-HEAD}"
usage() { echo "usage: sh deploy/verify-deployed.sh read|sealed <user@host | /local/tree> [git-ref]"; }
case "$TARGET" in
  read)   TREE=/opt/waggle-read ;;
  sealed) TREE=/opt/waggle-sealed ;;
  *) usage; exit 2 ;;
esac
[ -n "$DEST" ] || { usage; exit 2; }

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO"

# Canonical ship list — MUST mirror deploy.sh's rsync set. Dirs expand to the tracked
# files at REF, so the "should match" set is defined by git, not by whatever is on disk.
SHIP='src tests tools package.json package-lock.json config.example.json'
PATHS=$(git ls-tree -r --name-only "$REF" -- $SHIP) \
  || { echo "  ✗ not a valid git ref: $REF"; exit 2; }
[ -n "$PATHS" ] || { echo "  ✗ ship list resolved to nothing at $REF"; exit 2; }
REFSHA=$(git rev-parse --short "$REF")

# sha256 of stdin, first field only — sha256sum (Linux) or shasum -a 256 (macOS).
if command -v sha256sum >/dev/null 2>&1; then
  SHA() { sha256sum | cut -d' ' -f1; }
else
  SHA() { shasum -a 256 | cut -d' ' -f1; }
fi

echo "== verify $TARGET @ $DEST:$TREE  against $REF ($REFSHA) =="

EXP=$(mktemp); ACT=$(mktemp)
trap 'rm -f "$EXP" "$ACT"' EXIT INT TERM

# expected: "<sha>  <path>" from the git blobs at REF
for p in $PATHS; do
  printf '%s  %s\n' "$(git cat-file blob "$REF:$p" | SHA)" "$p"
done > "$EXP"

# The scan the deployed tree runs: for each shipped path, print "<sha>  <path>" or
# "MISSING  <path>". Repo paths contain no spaces (asserted by the test), so the list can
# be interpolated into a `for` word-split safely. Identical logic local and remote.
PLIST=$(printf '%s ' $PATHS)
REMOTE_SCAN='cd "'"$TREE"'" 2>/dev/null || { echo TREE-MISSING; exit 3; }
for p in '"$PLIST"'; do if [ -f "$p" ]; then sha256sum "$p"; else echo "MISSING  $p"; fi; done'

# Is DEST a local directory or an ssh destination? Matching on "@" or ":" alone gets this
# wrong for an ssh CONFIG ALIAS — `waggle-box` has neither, so it was being treated as a local
# path, `cd` failed inside a subshell, and the script died on that subshell's exit code before
# reaching the code that explains what happened. A silent exit 3 from a drift checker is worse
# than no checker: it looks like a finding and carries none.
#
# An existing local directory is a local tree; anything else is an ssh destination. That also
# fixes the reverse error — a directory named like a host is now read as the directory it is.
if [ -d "$DEST" ]; then DEST_KIND=local; else DEST_KIND=remote; fi

case "$DEST_KIND" in
  remote)
    # stderr is NOT swallowed: it carries the ssh failure, the host-key prompt, and the remote
    # shell's own complaint. Hiding it is how "cannot reach the box" becomes "exited 3".
    # `RC=$?` inside `if ! ssh …; then` reads the status of the NEGATION, which is 0 whenever the
    # branch is taken — so every failure reported "exit 0" and the two diagnoses below (tree
    # missing, host unreachable) could never fire. Capture the real status with `|| RC=$?`, which
    # also keeps `set -e` from killing the script before we can explain what went wrong. Same
    # family as the pipeline `$?` trap in CLAUDE.md's verification discipline.
    RC=0
    ssh "$DEST" "$REMOTE_SCAN" > "$ACT" || RC=$?
    if [ "$RC" -ne 0 ]; then
      case "$RC" in
        3) echo "  ✗ deployed tree $TREE does not exist on $DEST" ;;
        255) echo "  ✗ could not reach $DEST over ssh — check the host, the alias, or your key" ;;
        *) echo "  ✗ remote scan on $DEST failed (exit $RC) — see the ssh output above" ;;
      esac
      exit 2
    fi ;;
  local)
    # local tree: DEST is the tree root; hash with whichever tool exists.
    ( cd "$DEST" || { echo TREE-MISSING; exit 3; }
      for p in $PATHS; do
        if [ -f "$p" ]; then printf '%s  %s\n' "$(SHA < "$p")" "$p"; else echo "MISSING  $p"; fi
      done ) > "$ACT" ;;
esac
if [ ! -s "$ACT" ] || grep -q '^TREE-MISSING' "$ACT"; then
  echo "  ✗ deployed tree $TREE not found on $DEST"; exit 2
fi

# Compare EXP vs ACT by path.
DRIFT=0; OK=0
while IFS= read -r line; do
  esha=${line%%  *}; p=${line#*  }
  asha=$(awk -v k="$p" '$2==k {print $1; exit}' "$ACT")
  if [ -z "$asha" ] || [ "$asha" = "MISSING" ]; then
    echo "  ✗ DRIFT  missing on box : $p"; DRIFT=$((DRIFT+1))
  elif [ "$asha" != "$esha" ]; then
    echo "  ✗ DRIFT  content differs: $p"
    echo "           ref=$esha  box=$asha"; DRIFT=$((DRIFT+1))
  else
    OK=$((OK+1))
  fi
done < "$EXP"

TOTAL=$(wc -l <"$EXP" | tr -d ' ')
if [ "$DRIFT" -ne 0 ]; then
  echo "== FAIL: $DRIFT/$TOTAL file(s) drifted from $REF ($REFSHA) — deployed build is NOT what git says =="
  exit 1
fi
echo "== OK: all $OK/$TOTAL shipped files match $REF ($REFSHA) =="
exit 0
