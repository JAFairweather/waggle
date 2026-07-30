#!/bin/sh
# migrate-rename.sh — retire the old service name on a running host, in one deliberate pass.
#
#   sudo sh deploy/migrate-rename.sh
#
# A half-finished rename is worse than none: it leaves two names for one thing AND a deploy that
# no longer works. So this does the whole move or stops, and verifies at each step rather than
# assuming. It is idempotent — running it twice is a no-op.
#
# Order matters. The units are stopped before the trees move, because a running process holding
# a working directory that vanishes underneath it fails in ways that are tedious to read.
set -eu

OLD_S=west-bridge.service;      NEW_S=waggle-sealed.service
OLD_R=west-bridge-read.service; NEW_R=waggle-read.service
OLD_ST=/opt/west-bridge;        NEW_ST=/opt/waggle-sealed
OLD_RT=/opt/west-bridge-read;   NEW_RT=/opt/waggle-read
UD=/etc/systemd/system

say() { printf '  %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

if [ ! -d "$OLD_ST" ] && [ ! -d "$OLD_RT" ]; then say "already migrated — nothing to do"; exit 0; fi

say "stopping both lanes"
systemctl stop "$OLD_S" "$OLD_R" 2>/dev/null || true

say "moving trees (config, .env and data move with them — they are not re-created)"
[ -d "$OLD_ST" ] && [ ! -d "$NEW_ST" ] && mv "$OLD_ST" "$NEW_ST" && say "  $OLD_ST -> $NEW_ST"
[ -d "$OLD_RT" ] && [ ! -d "$NEW_RT" ] && mv "$OLD_RT" "$NEW_RT" && say "  $OLD_RT -> $NEW_RT"

say "installing the renamed units"
install -m 0644 -o root -g root "$(dirname "$0")/waggle-sealed.service" "$UD/$NEW_S"
install -m 0644 -o root -g root "$(dirname "$0")/waggle-read.service"   "$UD/$NEW_R"

say "retiring the old units"
systemctl disable "$OLD_S" "$OLD_R" 2>/dev/null || true
rm -f "$UD/$OLD_S" "$UD/$OLD_R"

# The bridge user's sudo rule names the units explicitly — a rename that misses it silently
# removes that user's ability to restart its own service, which only surfaces on the next deploy.
if [ -f /etc/sudoers.d/bridge ]; then
  say "updating the scoped sudo rule to the new unit names"
  sed -i "s/$OLD_R/$NEW_R/g; s/$OLD_S/$NEW_S/g" /etc/sudoers.d/bridge
  visudo -cf /etc/sudoers.d/bridge >/dev/null || { echo "  sudoers check FAILED — restoring nothing, fix by hand"; exit 1; }
fi

systemctl daemon-reload
say "starting the renamed lanes"
systemctl enable --now "$NEW_S" "$NEW_R" >/dev/null 2>&1 || true
sleep 3

FAIL=0
for u in "$NEW_S" "$NEW_R"; do
  st=$(systemctl is-active "$u" || true)
  say "$u: $st"
  [ "$st" = active ] || FAIL=1
done
[ "$FAIL" -eq 0 ] || { echo "  ✗ a lane did not come back — check: journalctl -u $NEW_S -u $NEW_R -n 50"; exit 1; }
say "done. Old names are gone; both lanes are running under the new ones."
