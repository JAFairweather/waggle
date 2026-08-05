#!/bin/sh
set -eu
fail=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fail=$((fail + 1)); }

test "$(stat -c '%U:%G %a' /etc/ssh/authorized_keys/waggle-policy-ingress 2>/dev/null)" = 'root:root 600' && ok 'root-owned ingress key' || bad 'ingress key ownership/mode'
grep -q '^Match User waggle-policy-ingress$' /etc/ssh/sshd_config.d/60-waggle-policy.conf 2>/dev/null &&
  grep -q '^    ForceCommand /usr/bin/node /opt/waggle-policy/tools/buzz-policy-forward.mjs$' /etc/ssh/sshd_config.d/60-waggle-policy.conf && ok 'fixed SSH command' || bad 'fixed SSH command'
sshd -t && ok 'sshd configuration parses' || bad 'sshd configuration'
test "$(stat -c '%U:%G %a' /etc/waggle-policy/policy.json 2>/dev/null)" = 'root:root 600' && ok 'fixed policy config' || bad 'policy config ownership/mode'
for file in poster.bunker-uri poster.client-nsec recovery.secret; do
  test "$(stat -c '%U:%G %a' "/etc/waggle-policy/credentials/$file" 2>/dev/null)" = 'root:root 600' && ok "$file" || bad "$file ownership/mode"
done
test "$(stat -c '%U:%G %a' /var/lib/waggle-policy/journal 2>/dev/null)" = 'waggle-policy:waggle-policy 700' && ok 'private durable journal' || bad 'journal ownership/mode'
for file in tools/buzz-policy-service.mjs tools/buzz-policy-forward.mjs src/buzz_policy_runner.mjs; do
  owner_mode=$(stat -c '%U:%G %a' "/opt/waggle-policy/$file" 2>/dev/null || true)
  case "$owner_mode" in root:root\ 644|root:root\ 444) ok "root-owned release $file" ;; *) bad "$file ownership/mode" ;; esac
done
systemd-analyze verify /etc/systemd/system/waggle-policy.socket /etc/systemd/system/waggle-policy@.service >/dev/null && ok 'systemd units verify' || bad 'systemd units'
systemctl is-enabled --quiet waggle-policy.socket && ok 'request socket enabled' || bad 'request socket not enabled'
systemctl is-active --quiet waggle-policy.socket && ok 'request socket active' || bad 'request socket not active'
test "$fail" -eq 0 || exit 1
echo 'policy host: all gates passed'
