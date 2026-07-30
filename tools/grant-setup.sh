#!/bin/sh
# grant-setup.sh — issue "may task this agent" grants, interactively.
#
#   sh tools/grant-setup.sh
#
# Answer three prompts, read the plan, confirm. Nothing is signed before you say yes.
#
# Why a wrapper rather than a longer command: this grant decides who may task an agent, so
# issuing it should be a deliberate act you can read first — not a 200-character line with two
# npubs in it, pasted from a chat window and hoped correct. Names resolve from the published
# directory, so the key that gets signed is the one actually published rather than one typed
# from memory. (bech32 usually catches a mistyped npub. "Usually" is not a security property.)
#
# ONE signer approval for the whole run. Listing grants needs no signature, so it runs with
# --grantor and never touches the signer; only the issuing step connects, and it signs the
# whole batch over that single connection. A tool that asks for approval it does not need
# teaches you to approve without reading, which is the opposite of what approval is for.
#
# The bunker string is a SECRET — it carries the token that authorises signing:
#   · read with terminal echo OFF, so it never appears on screen
#   · passed through the ENVIRONMENT, never argv (argv is world-readable in `ps`)
#   · never written to disk, never echoed back
# If a bunker string has ever been pasted into a chat, treat it as burned and re-mint it.
set -eu

TOOLS=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NAMES_URL=${NAMES_URL:-https://nave.pub/.well-known/nostr.json}
WORK=$(mktemp -d) || { echo "grant-setup: cannot create temp dir" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT INT TERM

say() { printf '%s\n' "$*"; }
die() { printf 'grant-setup: %s\n' "$*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || die "node not found on PATH"

say ""
say "  Grant the right to task an agent"
say "  ────────────────────────────────"
say "  Each grant says: <recipient> may give <agent> instructions."
say "  Signed, public, revocable. Revoke later with:"
say "     node tools/grant.mjs revoke --grant <id>"
say ""

printf '  Agent to be tasked (npub, or a name from nave.pub) [claude]: '
read -r AGENT_IN ||:; AGENT_IN=${AGENT_IN:-claude}

say ""
say "  Who may task this agent? Names resolve from ${NAMES_URL},"
say "  so nothing is transcribed by hand. Space-separated; npubs also accepted."
printf '  Recipients [jaf mydude dennis kerouac neil]: '
read -r RECIPS_IN ||:; RECIPS_IN=${RECIPS_IN:-"jaf mydude dennis kerouac neil"}

say ""
printf '  Your grantor npub (whose signature is the policy) [jaf]: '
read -r GRANTOR_IN ||:; GRANTOR_IN=${GRANTOR_IN:-jaf}

# Resolve every name to an npub in one pass, with no network write and no signer.
AGENT_IN="$AGENT_IN" RECIPS_IN="$RECIPS_IN" GRANTOR_IN="$GRANTOR_IN" NAMES_URL="$NAMES_URL" \
node --input-type=module -e '
import { npubEncode, decode } from "nostr-tools/nip19"
const JAF = "4010ac438206dc10018b814be3ea01ca6c92bcc22e9719e841d2413b287ea84d"
const res = await fetch(process.env.NAMES_URL).catch(() => null)
const names = res && res.ok ? (await res.json()).names || {} : {}
const toNpub = (tok) => {
  if (tok.startsWith("npub1")) { decode(tok); return tok }               // validates the checksum
  if (/^[0-9a-f]{64}$/i.test(tok)) return npubEncode(tok.toLowerCase())
  const k = tok.toLowerCase()
  if (k === "jaf" || k === "james" || k === "owner") return npubEncode(JAF)
  if (names[k]) return npubEncode(names[k])
  throw new Error(`cannot resolve "${tok}" — not an npub, not 64-hex, and not a published name`)
}
try {
  console.log("AGENT\t" + toNpub(process.env.AGENT_IN.trim()))
  console.log("GRANTOR\t" + toNpub(process.env.GRANTOR_IN.trim()))
  for (const t of process.env.RECIPS_IN.trim().split(/\s+/).filter(Boolean)) {
    console.log("TO\t" + t + "\t" + toNpub(t) + "\t" + decode(toNpub(t)).data)
  }
} catch (e) { console.log("ERR\t" + e.message) }
' > "$WORK/resolved" 2>&1 || die "resolution failed"

if grep -q '^ERR	' "$WORK/resolved"; then die "$(sed -n 's/^ERR\t//p' "$WORK/resolved")"; fi
AGENT=$(sed -n 's/^AGENT\t//p' "$WORK/resolved")
GRANTOR=$(sed -n 's/^GRANTOR\t//p' "$WORK/resolved")
[ -n "$AGENT" ] && [ -n "$GRANTOR" ] || die "could not resolve the agent or grantor"

# --- What already exists. No signer needed for this, so no prompt and no waiting. -------------
say ""
say "  Agent:   $AGENT"
say "  Grantor: $GRANTOR"
say ""
say "  Checking existing grants (read-only — your signer is not involved)…"
node "$TOOLS/grant.mjs" list --grantor "$GRANTOR" --agent "$AGENT" > "$WORK/existing" 2>&1 || true
sed 's/^/    /' "$WORK/existing"

# --- Plan --------------------------------------------------------------------------------------
: > "$WORK/plan"; : > "$WORK/skip"
while IFS='	' read -r _tag NAME NPUB HEX; do
  [ "$_tag" = "TO" ] || continue
  if grep -q "ACTIVE.*$HEX" "$WORK/existing" 2>/dev/null; then
    printf '%s\n' "$NAME" >> "$WORK/skip"
  else
    printf '%s\t%s\n' "$NAME" "$NPUB" >> "$WORK/plan"
  fi
done < "$WORK/resolved"

if [ -s "$WORK/skip" ]; then
  say ""
  say "  Already granted (skipping):"
  sed 's/^/    · /' "$WORK/skip"
fi

if [ ! -s "$WORK/plan" ]; then
  say ""
  say "  Nothing to do — everyone listed already holds a live grant for this agent."
  exit 0
fi

say ""
say "  About to sign and publish these grants:"
awk -F'\t' '{printf "    · %-10s %s\n", $1, $2}' "$WORK/plan"
say ""
printf '  Proceed? [y/N]: '
read -r YN ||:
case "$YN" in y|Y|yes|YES) ;; *) say "  Nothing signed."; exit 0 ;; esac

# --- Sign. One connection, one approval, the whole batch. --------------------------------------
say ""
printf '  Bunker connection (bunker://… — input hidden): '
if [ -t 0 ]; then stty -echo 2>/dev/null ||:; fi
read -r BUNKER ||:
if [ -t 0 ]; then stty echo 2>/dev/null ||:; printf '\n'; fi
[ -n "$BUNKER" ] || die "no bunker string given"
case "$BUNKER" in bunker://*) ;; *) die "that does not look like a bunker:// URI" ;; esac
export GRANTOR_BUNKER="$BUNKER"

TO_LIST=$(cut -f2 "$WORK/plan" | paste -sd, -)

say ""
say "  ┌──────────────────────────────────────────────────────────────────────┐"
say "  │ LOOK AT YOUR SIGNER APP NOW — the connection needs approving there   │"
say "  │ (Amber / nsec.app / Alby). Until you approve, this waits: that is    │"
say "  │ the signer asking, not a hang. Ctrl-C is safe.                       │"
say "  └──────────────────────────────────────────────────────────────────────┘"
say ""
# stderr is deliberately NOT swallowed — it carries the approval URL, the one-time client-key
# notice, and every connection error. Hiding it turns a normal approval pause into a mystery.
if command -v perl >/dev/null 2>&1; then
  perl -e 'alarm shift; exec @ARGV' 300 node "$TOOLS/grant.mjs" issue --to "$TO_LIST" --agent "$AGENT" 2>&1 | sed 's/^/    /'
else
  node "$TOOLS/grant.mjs" issue --to "$TO_LIST" --agent "$AGENT" 2>&1 | sed 's/^/    /'
fi

say ""
say "  Verifying what is now live (read-only again — no signer)…"
node "$TOOLS/grant.mjs" list --grantor "$GRANTOR" --agent "$AGENT" 2>&1 | sed 's/^/    /'
say ""
say "  Revoke any one of them with:  node tools/grant.mjs revoke --grant <440 id>"
