#!/usr/bin/env bash
# verify-firewall.sh — prove the egress rules the bridge's correctness depends on are LIVE,
# and that the clock they protect is actually synchronised.
#
# Why this exists rather than a line in the runbook: the correct ruleset once sat at
# /etc/nave-fw.nft for a full day without ever being loaded into the kernel. Everything looked
# applied. Meanwhile NTP egress was dropped, so the time daemon ran and its packets did not
# leave, and `timedatectl` quietly reported the clock as unsynchronised.
#
# That is not hygiene. The bridge decides `since` windows, the A3 watermark and the A5
# `created_at` clamp against wall-clock time. A drifting clock corrupts all three silently — no
# error, no gap in a log, just wrong answers.
#
# Exit codes follow the tripwire's idiom, because the same rule applies:
#   0  verified          both rules live, clock synchronised
#   2  FAILED            a rule is missing or the clock is not synchronised
#   3  INCONCLUSIVE      could not read the ruleset (not root? nft absent?) — NOT an all-clear
#
# Being unable to check is not the same as being fine.
set -uo pipefail

fail=0
inconclusive=0

say()  { printf '%s\n' "$*"; }
bad()  { printf '  ✗ %s\n' "$*"; fail=1; }
good() { printf '  ✓ %s\n' "$*"; }
skip() { printf '  ? %s\n' "$*"; inconclusive=1; }

say "firewall + clock verification"

# --- the ruleset actually loaded in the kernel, not the file on disk -------------------------
if ! command -v nft >/dev/null 2>&1; then
  skip "nft not found — cannot read the live ruleset (this check targets the Linux bridge host)"
else
  ruleset=$(nft list ruleset 2>/dev/null)
  if [ -z "$ruleset" ]; then
    skip "nft returned nothing — need root to read the ruleset. Re-run with sudo."
  else
    # NTP first: it is the one whose absence is silent.
    if printf '%s' "$ruleset" | grep -qE 'udp dport (123|\{[^}]*123[^}]*\}) *accept'; then
      good "NTP egress (udp/123) is permitted"
    else
      bad "NTP egress (udp/123) is NOT permitted — the clock will drift and every time-based gate degrades silently"
    fi

    if printf '%s' "$ruleset" | grep -qE 'tcp dport (80|\{[^}]*80[^}]*\}) *accept'; then
      good "apt egress (tcp/80) is permitted"
    else
      bad "apt egress (tcp/80) is NOT permitted — plain-http mirrors will hang rather than fail fast"
    fi

    if printf '%s' "$ruleset" | grep -q 'policy drop'; then
      good "a default-drop policy is in force"
    else
      bad "no default-drop policy found — the ruleset may not be the shipped one"
    fi
  fi
fi

# --- the thing the NTP rule exists to protect -----------------------------------------------
if ! command -v timedatectl >/dev/null 2>&1; then
  skip "timedatectl not found — cannot confirm clock sync"
else
  synced=$(timedatectl show -p NTPSynchronized --value 2>/dev/null)
  case "$synced" in
    yes) good "system clock is synchronised" ;;
    no)  bad  "system clock is NOT synchronised — check that udp/123 egress is permitted, then wait for the next poll" ;;
    *)   skip "could not read NTPSynchronized (got '${synced:-empty}')" ;;
  esac
fi

say ""
if [ "$fail" -eq 1 ]; then
  say "FAILED — the bridge's time-based gates cannot be trusted until this is fixed."
  exit 2
fi
if [ "$inconclusive" -eq 1 ]; then
  say "INCONCLUSIVE — one or more checks could not run. This is NOT an all-clear; re-run on the"
  say "bridge host with sudo before treating the firewall or the clock as verified."
  exit 3
fi
say "verified — egress rules live, clock synchronised."
