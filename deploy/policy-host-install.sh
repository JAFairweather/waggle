#!/bin/sh
# One-time root bootstrap for the separate #54 policy host.  It does not install
# credentials or invent policy: those owner-controlled files are explicit gates.
set -eu

PUB=${WAGGLE_POLICY_CLIENT_PUB:-}
case "$PUB" in ssh-ed25519\ *|ecdsa-*\ *) : ;; *)
  echo "set WAGGLE_POLICY_CLIENT_PUB to the Waggle host's dedicated SSH public key" >&2; exit 2 ;;
esac
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test "$(id -u)" -eq 0 || { echo "run as root on the policy host" >&2; exit 2; }
test -f "$ROOT/tools/buzz-policy-service.mjs" && test -f "$ROOT/tools/buzz-policy-forward.mjs" || {
  echo "run from a complete, reviewed Waggle release tree" >&2; exit 2; }
test "$ROOT" = /opt/waggle-policy || { echo "the reviewed release must be installed at /opt/waggle-policy" >&2; exit 2; }
test ! -e "$ROOT/.git" || { echo "deploy an exported release, not a mutable git worktree" >&2; exit 2; }
if find "$ROOT" -xdev -type l -print -quit | grep -q .; then
  echo "the runtime release must contain no symlinks (remove node_modules/.bin)" >&2; exit 2
fi
if find "$ROOT" -xdev \( ! -user root -o ! -group root -o -perm /022 \) -print -quit | grep -q .; then
  echo "every runtime path must be root:root and not group/world writable" >&2; exit 2
fi

getent group waggle-policy >/dev/null 2>&1 || groupadd --system waggle-policy
getent group waggle-policy-ingress >/dev/null 2>&1 || groupadd --system waggle-policy-ingress
id waggle-policy >/dev/null 2>&1 || useradd --system --gid waggle-policy --home-dir /nonexistent --shell /usr/sbin/nologin waggle-policy
id waggle-policy-ingress >/dev/null 2>&1 || useradd --system --gid waggle-policy-ingress --home-dir /nonexistent --shell /bin/sh waggle-policy-ingress

install -d -m 0755 -o root -g root /opt/waggle-policy
install -d -m 0700 -o root -g root /etc/waggle-policy /etc/waggle-policy/credentials
install -d -m 0700 -o waggle-policy -g waggle-policy /var/lib/waggle-policy/journal
install -d -m 0755 -o root -g root /etc/ssh/authorized_keys /etc/ssh/sshd_config.d
(cd "$ROOT" && find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > /etc/waggle-policy/release.sha256
chown root:root /etc/waggle-policy/release.sha256
chmod 0600 /etc/waggle-policy/release.sha256
printf 'restrict %s\n' "$PUB" > /etc/ssh/authorized_keys/waggle-policy-ingress
chown root:root /etc/ssh/authorized_keys/waggle-policy-ingress
chmod 0600 /etc/ssh/authorized_keys/waggle-policy-ingress

install -m 0644 -o root -g root "$ROOT/deploy/sshd-waggle-policy.conf" /etc/ssh/sshd_config.d/60-waggle-policy.conf
SSHD=$(command -v sshd)
"$SSHD" -t
systemctl reload ssh.service 2>/dev/null || systemctl reload sshd.service

install -m 0644 -o root -g root "$ROOT/deploy/waggle-policy.socket" /etc/systemd/system/waggle-policy.socket
install -m 0644 -o root -g root "$ROOT/deploy/waggle-policy@.service" /etc/systemd/system/waggle-policy@.service
install -m 0644 -o root -g root "$ROOT/deploy/waggle-policy.slice" /etc/systemd/system/waggle-policy.slice
systemctl daemon-reload

echo "policy-host identities, forced SSH capability, socket, and state tree installed"
echo "NEXT: install a root-owned release at /opt/waggle-policy; create the four 0600 root:root files documented in deploy/POLICY_HOST.md; run the verifier; only then enable waggle-policy.socket"
