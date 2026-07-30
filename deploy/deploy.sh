#!/bin/sh
# Push-style deploy from the Mac — the reproducible replacement for hand-typed ssh steps.
#
#   sh deploy/deploy.sh read   bridge@<host>     # public read lane -> /opt/waggle-read
#   sh deploy/deploy.sh sealed <admin>@<host>    # sealed lanes     -> /opt/waggle-sealed
#
# Ships code ONLY: config.json, .env, and data/ are never touched (rsync has no --delete,
# and none of those paths are in the ship list). Refuses to restart a tree whose config is
# missing — a first-run box gets the copy-from-example instruction instead.
set -eu

TARGET="${1:-}"
DEST="${2:-}"
case "$TARGET" in
  read)   TREE=/opt/waggle-read; UNIT=waggle-read.service ;;
  sealed) TREE=/opt/waggle-sealed;      UNIT=waggle-sealed.service ;;
  *) echo "usage: sh deploy/deploy.sh read|sealed user@host"; exit 1 ;;
esac
[ -n "$DEST" ] || { echo "usage: sh deploy/deploy.sh $TARGET user@host"; exit 1; }

DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
echo "== waggle deploy: $TARGET -> $DEST:$TREE =="

echo "-- preflight --"
ssh "$DEST" "[ -f $TREE/config.json ]" || {
  echo "  ✗ $TREE/config.json missing on $DEST."
  echo "    Copy config.example.json there, fill it ($TARGET lane block only), then re-run."
  exit 1
}
ssh "$DEST" "node --version" | grep -Eq 'v(2[0-9]|[3-9][0-9])\.' || {
  echo "  ✗ remote node is not >=20 (package.json engines)"; exit 1
}
echo "  ok"

echo "-- ship code --"
rsync -az \
  "$DIR/src" "$DIR/tests" "$DIR/tools" \
  "$DIR/package.json" "$DIR/package-lock.json" "$DIR/config.example.json" \
  "$DEST:$TREE/"

echo "-- deps --"
ssh "$DEST" "cd $TREE && npm ci --omit=dev --no-audit --no-fund"

echo "-- restart --"
ssh "$DEST" "sudo systemctl restart $UNIT"

echo "-- boot banner --"
sleep 2
ssh "$DEST" "journalctl -u $UNIT -n 12 --no-pager" || \
  ssh "$DEST" "sudo systemctl status $UNIT --no-pager" || true

echo "== deploy DONE =="
