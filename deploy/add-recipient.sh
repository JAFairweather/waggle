#!/usr/bin/env bash
# add-recipient.sh — add a new agent seat to the waggle sealed bridge.
#
# Creates a private inbox owned by the waggle poster key, seats the agent as a
# member, wires it into /opt/waggle-sealed/config.json (recipients[] plus the
# named channel fan lists), and restarts the sealed lane.
#
# Run this AS ROOT on the box. The scoped operator accounts (nave, neil) are
# deliberately NOT in sudoers, so `sudo -i` will not work — get a root shell with
# `su -` (enter the ROOT password, the same one polkit accepts for systemctl) and
# paste the body straight in. Do NOT prefix a paste with `su -`: it opens a silent
# password prompt that swallows every following line.
#
# Usage:
#   add-recipient.sh <Name> <pubkey-hex> [chan1,chan2,...]
#   Channels default to "#general". Pass "" for a DM-only seat (no channel fan).
#
# Idempotent: re-running updates the existing seat's inbox/pubkey in place and
# re-adds it to any missing channel lists; it never duplicates a recipient and
# never mints a second inbox when the seat already resolves to a real UUID.
set -euo pipefail

CFG=/opt/waggle-sealed/config.json
UNIT=waggle-sealed
NAME="${1:?usage: add-recipient.sh <Name> <pubkey-hex> [chan1,chan2,...]}"
PUBKEY="${2:?missing pubkey-hex}"
CHANS="${3-#general}"

[ "$(id -u)" = "0" ] || { echo "ERR: must run as root (su -) — scoped accounts cannot read the root-only .env" >&2; exit 1; }
[[ "$PUBKEY" =~ ^[0-9a-f]{64}$ ]] || { echo "ERR: pubkey must be 64 lowercase hex chars, got: $PUBKEY" >&2; exit 1; }
[ -f "$CFG" ] || { echo "ERR: $CFG not found" >&2; exit 1; }

# Load creds from the RUNNING daemon's environment, NOT by sourcing .env.
# `. /opt/waggle-sealed/.env` makes bash re-parse the file, and bash mangles the
# AUTH_TAG JSON (it expands $ and quote chars inside the value) — the CLI then
# rejects it as "BUZZ_AUTH_TAG is malformed". systemd loads the file verbatim, so
# the live process holds byte-exact good creds; we borrow them from /proc.
PID=$(systemctl show -p MainPID --value "$UNIT")
[ "${PID:-0}" -gt 0 ] 2>/dev/null || { echo "ERR: $UNIT not running (MainPID=$PID) — start it first" >&2; exit 1; }
while IFS= read -r -d '' kv; do
  case "$kv" in BUZZ_PRIVATE_KEY=*|BUZZ_AUTH_TAG=*|BUZZ_RELAY_URL=*) export "$kv" ;; esac
done < "/proc/$PID/environ"
[ -n "${BUZZ_PRIVATE_KEY:-}" ] && [ -n "${BUZZ_AUTH_TAG:-}" ] || { echo "ERR: could not load creds from /proc/$PID/environ" >&2; exit 1; }
echo "creds loaded from daemon PID $PID"

# Reuse an existing real inbox if this seat already has one; otherwise create it.
INBOX=$(CFG="$CFG" NAME="$NAME" python3 -c '
import json,os
c=json.load(open(os.environ["CFG"]))
for r in c.get("recipients",[]):
    if r.get("name")==os.environ["NAME"] and r.get("inbox"):
        print(r["inbox"]); break
')

if [ -z "$INBOX" ]; then
  SLUG=$(printf '%s' "$NAME" | tr '[:upper:] ' '[:lower:]-')
  OUT=$(buzz channels create --name "bridge-inbox-$SLUG" --type stream --visibility private)
  INBOX=$(printf '%s' "$OUT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("channel_id") or d.get("id") or "")')
  # Abort BEFORE touching config if create failed — a blank inbox writes a
  # placeholder seat that the bridge flags and drops (per-recipient, so the other
  # seats survive, but it is still a corrupt config we refuse to author).
  [ -n "$INBOX" ] || { echo "ABORT: 'buzz channels create' returned no id; config untouched. raw: $OUT" >&2; exit 1; }
  echo "created inbox $INBOX"
else
  echo "reusing existing inbox $INBOX"
fi

# `buzz channels create` returns the id under "channel_id" (not "id") — the parser
# above accepts either. Owner is the waggle poster key by birth (we authed as it).
buzz channels add-member --channel "$INBOX" --pubkey "$PUBKEY" --role member || true  # already-a-member is not an error

cp "$CFG" "$CFG.bak.$(date +%s)"
CFG="$CFG" NAME="$NAME" PUBKEY="$PUBKEY" INBOX="$INBOX" CHANS="$CHANS" python3 -c '
import json,os
p=os.environ["CFG"]; c=json.load(open(p))
name=os.environ["NAME"]; inbox=os.environ["INBOX"]; pub=os.environ["PUBKEY"]
chans=[x for x in os.environ["CHANS"].split(",") if x]
recs=c.setdefault("recipients",[])
for r in recs:
    if r.get("name")==name:
        r["inbox"]=inbox; r["npub_hex"]=pub; break
else:
    recs.append({"name":name,"npub_hex":pub,"inbox":inbox})
for ch in c.get("channels",[]):
    if ch.get("name") in chans and name not in ch.get("recipients",[]):
        ch.setdefault("recipients",[]).append(name)
json.dump(c,open(p,"w"),indent=2)
print("recipients now:",[r["name"] for r in recs])
print("channel fans:",{ch["name"]:ch.get("recipients") for ch in c.get("channels",[]) if ch.get("name") in chans})
'

systemctl restart "$UNIT"
systemctl is-active "$UNIT"
cat <<EOF

seat wired for "$NAME" -> $INBOX
VERIFY (steward): journalctl -u $UNIT since the restart should read one more
recipient and NO "placeholder inbox" WARN. Post a #general smoke test and confirm
the fan lands in $INBOX (a sealed kind:9 authored by the waggle poster key).
EOF
