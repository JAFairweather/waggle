#!/bin/sh
# D1: stand up the dedicated non-root 'bridge' user for the public read lane.
# Run as root ON THE BOX, from a checkout/rsync of this repo's deploy/ directory:
#
#   BRIDGE_PUB='ssh-ed25519 AAAA... bridge-deploy' sh bridge-user.sh
#
# Idempotent — safe to re-run. Follows the nave.pub/deploy/ops house pattern
# (env-passed pubkey, append-never-overwrite, verify-before-lock). This script
# deliberately does NOT touch root SSH — disabling root login is a separate, LAST,
# verify-first step (see deploy/README.md: an admin user must be login-verified first,
# or the sealed unit becomes unmanageable).
set -eu
echo "== waggle: bridge user bring-up on $(hostname) =="

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# 1) Deploy pubkey (required up front so a partial run can't lock the tree shape in) ----
PUB="${BRIDGE_PUB:-}"
case "$PUB" in
  ssh-ed25519*|ecdsa-*) : ;;
  *) echo "  ✗ set BRIDGE_PUB to the deploy public key line, e.g.:"
     echo "      BRIDGE_PUB='ssh-ed25519 AAAA... bridge-deploy' sh bridge-user.sh"; exit 1 ;;
esac

# 2) User + tree -------------------------------------------------------------------------
echo "-- user + tree --"
id bridge >/dev/null 2>&1 || useradd -r -m -s /bin/bash bridge
mkdir -p /opt/waggle-read/data
chown -R bridge:bridge /opt/waggle-read
chmod 750 /opt/waggle-read
echo "  bridge user + /opt/waggle-read ready"

# 3) restrict-prefixed authorized_keys ---------------------------------------------------
# 'restrict' kills pty/agent/port/X11 forwarding; command execution still works, which is
# all rsync + 'npm ci' + scoped sudo need.
echo "-- authorized_keys (restrict) --"
BHOME=$(getent passwd bridge | cut -d: -f6)
install -d -m 700 -o bridge -g bridge "$BHOME/.ssh"
touch "$BHOME/.ssh/authorized_keys"
grep -qF "$PUB" "$BHOME/.ssh/authorized_keys" || printf 'restrict %s\n' "$PUB" >> "$BHOME/.ssh/authorized_keys"
chown bridge:bridge "$BHOME/.ssh/authorized_keys"
chmod 600 "$BHOME/.ssh/authorized_keys"
echo "  installed (append; nothing overwritten)"

# 4) Scoped sudo — exact unit commands only, validated before install --------------------
echo "-- sudoers (scoped to waggle-read.service) --"
visudo -cf "$DIR/sudoers-bridge"
install -m 440 "$DIR/sudoers-bridge" /etc/sudoers.d/bridge
echo "  /etc/sudoers.d/bridge installed"

# 5) Journal read via group, not sudo ----------------------------------------------------
usermod -aG systemd-journal bridge
echo "  bridge added to systemd-journal group"

# 6) Unit install ------------------------------------------------------------------------
echo "-- systemd unit --"
install -m 644 "$DIR/waggle-read.service" /etc/systemd/system/waggle-read.service
systemctl daemon-reload
echo "  waggle-read.service installed (not started — config/.env first)"

echo
echo "== bridge-user DONE =="
echo "NEXT (see deploy/README.md for the full cutover order):"
echo "  1) Create /opt/waggle-read/.env (bridge:bridge, 0600):"
echo "       SEALED_LANES=off  FORWARD_MODE=dryrun  BUZZ_RELAY_URL=...  BUZZ_PRIVATE_KEY=...  BUZZ_AUTH_TAG=..."
echo "  2) Create /opt/waggle-read/config.json — ONLY the \"public\" block."
echo "  3) From the Mac:  sh deploy/deploy.sh read bridge@<host>"
echo "  4) Verify dryrun in the journal, then flip FORWARD_MODE=buzz at cutover."
