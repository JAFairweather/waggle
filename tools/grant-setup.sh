#!/bin/sh
# grant-setup.sh — issue "may task this agent" grants, interactively.
#
#   sh tools/grant-setup.sh
#
# Prompts for your bunker connection, shows you exactly what it is about to sign, waits for a
# yes, then issues one grant per recipient. Nothing is signed before you confirm.
#
# Why a wrapper rather than a longer command: the grant is the thing that decides who may task
# an agent, so issuing it should be a deliberate act you can read before it happens — not a
# 200-character line with two npubs in it that you paste from a chat window and hope is right.
# (It also removes the transcription risk. An npub typed by hand is one flipped character from
# a stranger's key; bech32 will usually catch it, but "usually" is not a security property.)
#
# The bunker string is a SECRET — it carries the token that authorises signing. So it is:
#   · read with the terminal echo OFF, so it never appears on screen
#   · passed to the signer through the ENVIRONMENT, never argv (argv is world-readable in `ps`)
#   · never written to a file, and never printed back
# If you have ever pasted a bunker string into a chat, treat it as burned and re-mint it.
set -eu

TOOLS=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NAMES_URL=${NAMES_URL:-https://nave.pub/.well-known/nostr.json}

say() { printf '%s\n' "$*"; }
die() { printf 'grant-setup: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node not found on PATH"

say ""
say "  Grant the right to task an agent"
say "  ────────────────────────────────"
say "  Each grant says: <recipient> may give <agent> instructions."
say "  It is a signed, public, revocable event. Revoke later with:"
say "     node tools/grant.mjs revoke --grant <id>"
say ""

# --- 1. Who is being tasked -------------------------------------------------------------------
printf '  Agent to be tasked (npub, or a name from nave.pub) [claude]: '
read -r AGENT_IN ||:
AGENT_IN=${AGENT_IN:-claude}

# --- 2. Who may task them ---------------------------------------------------------------------
say ""
say "  Who may task this agent? Names are resolved from ${NAMES_URL}"
say "  so nothing is transcribed by hand. Space-separated; npubs also accepted."
printf '  Recipients [jaf mydude dennis kerouac neil]: '
read -r RECIPS_IN ||:
RECIPS_IN=${RECIPS_IN:-"jaf mydude dennis kerouac neil"}

# Resolve names -> npubs in one node pass. `jaf` maps to the workspace owner, who is not
# published under that name, so it is special-cased here rather than silently dropped.
RESOLVED=$(AGENT_IN="$AGENT_IN" RECIPS_IN="$RECIPS_IN" NAMES_URL="$NAMES_URL" node --input-type=module -e '
import { npubEncode, decode } from "nostr-tools/nip19"
const JAF = "4010ac438206dc10018b814be3ea01ca6c92bcc22e9719e841d2413b287ea84d"
const res = await fetch(process.env.NAMES_URL).catch(() => null)
const names = res && res.ok ? (await res.json()).names || {} : {}
const toNpub = (tok) => {
  if (tok.startsWith("npub1")) { decode(tok); return tok }              // validates the checksum
  if (/^[0-9a-f]{64}$/i.test(tok)) return npubEncode(tok.toLowerCase())
  const k = tok.toLowerCase()
  if (k === "jaf" || k === "james" || k === "owner") return npubEncode(JAF)
  if (names[k]) return npubEncode(names[k])
  throw new Error(`cannot resolve "${tok}" — not an npub, not 64-hex, and not a published name`)
}
try {
  const agent = toNpub(process.env.AGENT_IN.trim())
  const recips = process.env.RECIPS_IN.trim().split(/\s+/).filter(Boolean).map(t => `${t}\t${toNpub(t)}`)
  console.log("AGENT\t" + agent)
  for (const r of recips) console.log("TO\t" + r)
} catch (e) { console.log("ERR\t" + e.message) }
' 2>&1) || die "resolution failed"

case "$RESOLVED" in *"ERR	"*) die "$(printf '%s' "$RESOLVED" | sed -n 's/^ERR\t//p')";; esac

AGENT=$(printf '%s\n' "$RESOLVED" | sed -n 's/^AGENT\t//p')
[ -n "$AGENT" ] || die "could not resolve the agent"

# --- 3. What already exists — do not mint duplicates ------------------------------------------
say ""
say "  Agent: $AGENT"
say ""
printf '  Bunker connection (bunker://… — input hidden): '
if [ -t 0 ]; then stty -echo 2>/dev/null ||:; fi
read -r BUNKER ||:
if [ -t 0 ]; then stty echo 2>/dev/null ||:; printf '\n'; fi
[ -n "$BUNKER" ] || die "no bunker string given"
case "$BUNKER" in bunker://*) ;; *) die "that does not look like a bunker:// URI" ;; esac
export GRANTOR_BUNKER="$BUNKER"

say ""
say "  Checking what is already granted (this connects to your signer once)…"
EXISTING=$(node "$TOOLS/grant.mjs" list --agent "$AGENT" 2>/dev/null || true)
printf '%s\n' "$EXISTING" | sed 's/^/    /'

# --- 4. Plan, confirm, execute ----------------------------------------------------------------
PLAN=""
SKIP=""
printf '%s\n' "$RESOLVED" | sed -n 's/^TO\t//p' | while IFS="$(printf '\t')" read -r NAME NPUB; do
  printf '%s\t%s\n' "$NAME" "$NPUB"
done > /tmp/gs_recips.$$
trap 'rm -f /tmp/gs_recips.$$' EXIT INT TERM

while IFS="$(printf '\t')" read -r NAME NPUB; do
  HEX=$(NPUB="$NPUB" node --input-type=module -e 'import{decode}from"nostr-tools/nip19";console.log(decode(process.env.NPUB).data)')
  if printf '%s' "$EXISTING" | grep -q "ACTIVE.*$HEX"; then
    SKIP="$SKIP  already granted: $NAME
"
  else
    PLAN="$PLAN  $NAME	$NPUB
"
  fi
done < /tmp/gs_recips.$$

[ -n "$SKIP" ] && { say ""; printf '%s' "$SKIP"; }

if [ -z "$PLAN" ]; then
  say ""
  say "  Nothing to do — everyone listed already holds a live grant for this agent."
  exit 0
fi

say ""
say "  About to sign and publish these grants:"
printf '%s' "$PLAN" | sed 's/^/    /'
say ""
printf '  Proceed? [y/N]: '
read -r YN ||:
case "$YN" in y|Y|yes|YES) ;; *) say "  Nothing signed."; exit 0 ;; esac

say ""
FAILED=0
printf '%s' "$PLAN" | while IFS="$(printf '\t')" read -r NAME NPUB; do
  [ -n "$NPUB" ] || continue
  say "  → $NAME"
  if node "$TOOLS/grant.mjs" issue --to "$NPUB" --agent "$AGENT" 2>&1 | sed 's/^/      /'; then :; else
    say "      FAILED — $NAME was not granted"
  fi
done

say ""
say "  Done. Verify what the agent now sees:"
say "     node tools/grant.mjs list --agent $AGENT"
say ""
say "  Revoke any one of them later with:"
say "     node tools/grant.mjs revoke --grant <440 id>"
