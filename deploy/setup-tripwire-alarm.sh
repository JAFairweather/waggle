#!/bin/sh
# Resumable owner setup for the Bunker-backed tripwire alarm path.
# Secrets enter only on stdin and systemd LoadCredential; none enter argv or the environment.
set -eu

ROOT=${WAGGLE_ROOT:-/opt/waggle-read}
STATE=${WAGGLE_TRIPWIRE_STATE:-/etc/waggle-tripwire}
SYSTEMD=${WAGGLE_SYSTEMD_DIR:-/etc/systemd/system}
SYSTEMCTL=${WAGGLE_SYSTEMCTL:-systemctl}

usage() {
  echo "usage: $0 enroll --recipient <npub> --poster <npub-or-hex> --relay <wss-url>" >&2
  echo "       $0 check" >&2
  echo "       $0 drill" >&2
  exit 2
}

need_file() { [ -f "$1" ] || { echo "tripwire setup: missing $1 (deploy a current Waggle build)" >&2; exit 1; }; }
private_file() {
  need_file "$1"
  # GNU `stat -f` succeeds but prints filesystem statistics, so it cannot be the first
  # portability probe. GNU -c is unambiguous; BSD/macOS rejects it and falls through to -f.
  if mode=$(stat -c '%a' "$1" 2>/dev/null); then :; else mode=$(stat -f '%Lp' "$1"); fi
  [ "$mode" = 600 ] || { echo "tripwire setup: $1 must be mode 600 (found $mode)" >&2; exit 1; }
}

install_units() {
  need_file "$ROOT/deploy/tripwire-alarm-bunker.conf"
  need_file "$ROOT/deploy/waggle-tripwire-drill.service"
  install -d -m 0755 "$SYSTEMD/waggle-tripwire.service.d"
  install -m 0644 "$ROOT/deploy/tripwire-alarm-bunker.conf" "$SYSTEMD/waggle-tripwire.service.d/alarm.conf"
  install -m 0644 "$ROOT/deploy/waggle-tripwire-drill.service" "$SYSTEMD/waggle-tripwire-drill.service"
  "$SYSTEMCTL" daemon-reload
}

command=${1:-}
[ -n "$command" ] || usage
shift

case "$command" in
  enroll)
    recipient= poster= relay=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --recipient) [ "$#" -ge 2 ] || usage; recipient=$2; shift 2 ;;
        --poster) [ "$#" -ge 2 ] || usage; poster=$2; shift 2 ;;
        --relay) [ "$#" -ge 2 ] || usage; relay=$2; shift 2 ;;
        *) usage ;;
      esac
    done
    [ -n "$recipient" ] && [ -n "$poster" ] && [ -n "$relay" ] || usage
    case "$relay" in wss://*) ;; *) echo "tripwire setup: --relay must be wss://" >&2; exit 2 ;; esac
    [ ! -e "$STATE/alarm.bunker-uri" ] || {
      echo "tripwire setup: enrollment already exists; refusing to replace credentials" >&2
      echo "tripwire setup: run '$0 check' or '$0 drill'" >&2
      exit 1
    }
    need_file "$ROOT/tools/tripwire-alarm-bunker-init.mjs"
    node "$ROOT/tools/tripwire-alarm-bunker-init.mjs" \
      --directory "$STATE" --recipient "$recipient" --poster "$poster"
    umask 077
    printf 'POSTER=%s\nBUZZ_RELAY_URL=%s\n' "$poster" "$relay" > "$STATE/drill.env"
    chmod 0600 "$STATE/drill.env"
    install_units
    echo "tripwire setup: staged; approve the new pairing in Bunker, then run:"
    echo "  $0 drill"
    ;;
  check)
    private_file "$STATE/alarm.bunker-uri"
    private_file "$STATE/alarm.client-nsec"
    private_file "$STATE/alarm.to"
    private_file "$STATE/drill.env"
    need_file "$SYSTEMD/waggle-tripwire.service.d/alarm.conf"
    need_file "$SYSTEMD/waggle-tripwire-drill.service"
    "$SYSTEMCTL" cat waggle-tripwire.service >/dev/null
    "$SYSTEMCTL" cat waggle-tripwire-drill.service >/dev/null
    echo "tripwire setup: credentials private; units installed and loadable"
    ;;
  drill)
    "$0" check
    "$SYSTEMCTL" reset-failed waggle-tripwire-drill.service >/dev/null 2>&1 || true
    "$SYSTEMCTL" start waggle-tripwire-drill.service
    "$SYSTEMCTL" --no-pager --full status waggle-tripwire-drill.service
    echo "tripwire setup: relay accepted the drill; confirm the labelled DM arrived"
    ;;
  *) usage ;;
esac
