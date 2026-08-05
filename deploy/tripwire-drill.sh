#!/bin/sh
# Bounded production alarm drill. Signer material remains in the unit's LoadCredential= files.
set -eu

[ "$#" -eq 1 ] || { echo "usage: sudo sh deploy/tripwire-drill.sh <wss-relay>" >&2; exit 2; }
RELAY=$1
case "$RELAY" in ws://*|wss://*) ;; *) echo "tripwire-drill: relay must be ws:// or wss://" >&2; exit 2 ;; esac

SYSTEMCTL=${TRIPWIRE_SYSTEMCTL:-systemctl}
TIMER_WAS_ACTIVE=0
"$SYSTEMCTL" is-active --quiet waggle-tripwire.timer && TIMER_WAS_ACTIVE=1 || true

cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  cleanup_rc=0
  "$SYSTEMCTL" unset-environment TRIPWIRE_DRILL BUZZ_RELAY_URL || cleanup_rc=$?
  if [ "$TIMER_WAS_ACTIVE" -eq 1 ]; then
    "$SYSTEMCTL" start waggle-tripwire.timer || cleanup_rc=$?
  fi
  [ "$rc" -ne 0 ] && exit "$rc"
  exit "$cleanup_rc"
}
trap cleanup EXIT HUP INT TERM

"$SYSTEMCTL" stop waggle-tripwire.timer
"$SYSTEMCTL" set-environment TRIPWIRE_DRILL=1 "BUZZ_RELAY_URL=$RELAY"
"$SYSTEMCTL" start waggle-tripwire.service

