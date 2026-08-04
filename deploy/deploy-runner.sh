#!/bin/sh
# deploy/deploy-runner.sh — pull-based deploy (issue #129).
#
# The inverse of deploy.sh. Instead of an operator PUSHING code to the box over ssh with a
# standing sudo grant, the BOX PULLS: a timer runs this script, it looks for a commit on
# main that CI has marked green, deploys that commit into the lane tree, records the SHA,
# and runs verify-deployed.sh — refusing LOUDLY on drift. No inbound credential to the box,
# so a GitHub compromise is not a production compromise.
#
#   sh deploy/deploy-runner.sh read     # public read lane -> /opt/waggle-read
#   sh deploy/deploy-runner.sh sealed   # sealed lanes     -> /opt/waggle-sealed
#
# Authorisation model: "merged to main + CI green" IS the authorisation. Nothing here can
# deploy a commit that is not both. To require an explicit human blessing per release,
# point WB_REF at a signed tag ref instead of origin/main (see README) — one-line swap.
#
# Gates (each enforced below, none optional):
#   - deploy ONLY a commit CI reports success for (green_state)
#   - NEVER touch config.json, .env or data/ — they are not in the ship list, and rsync has
#     no --delete. These hold the live-only values (watch_authors, return_lane, scan_channels,
#     relay_channels — see #104) a careless deploy would erase.
#   - record the deployed SHA on the box ($TREE/DEPLOYED_SHA) so drift is checkable
#   - run verify-deployed.sh after every deploy; a mismatch ALARMS (exit 1), never logs-and-passes
#
# Exit: 0 = deployed, or nothing to do (already current / not yet green).
#       1 = a deploy was attempted and post-deploy verification found DRIFT — needs eyes.
#       2 = usage / environment error (bad lane, missing hub clone).
#
# Seams for the test + for the box (default to the real thing; overridable so the unit test
# needs no network, no systemd, no npm registry):
#   WB_HUB          hub git clone the box pulls into           (default /opt/waggle-hub)
#   WB_REF          ref to track                                (default origin/$WB_BRANCH)
#   WB_BRANCH       branch to fetch                             (default main)
#   WB_SLUG         owner/repo for the CI query                 (default JAFairweather/waggle)
#   WB_CI_STATE_CMD `sh -c "<cmd> <sha>"` -> success|failure|pending  (default: GitHub check-runs API)
#   WB_NPM_CMD      dependency install run inside $TREE         (default: npm ci --omit=dev ...)
#   WB_RESTART_CMD  `sh -c "<cmd> <unit>"` to restart the lane  (default: sudo systemctl restart)
#   WB_NO_FETCH=1   skip `git fetch` (test drives the hub directly)
#   DRY_RUN=1       resolve + gate, then report what WOULD ship; change nothing
set -eu

LANE="${1:-}"
case "$LANE" in
  read)   TREE=/opt/waggle-read;   UNIT=waggle-read.service ;;
  sealed) TREE=/opt/waggle-sealed; UNIT=waggle-sealed.service ;;
  *) echo "usage: sh deploy/deploy-runner.sh read|sealed"; exit 2 ;;
esac
# test override of the destination tree (guarded: a bare `&&` here would trip `set -e` when
# WB_TREE is unset — which is every production run).
if [ -n "${WB_TREE:-}" ]; then TREE="$WB_TREE"; fi

HUB="${WB_HUB:-/opt/waggle-hub}"
BRANCH="${WB_BRANCH:-main}"
REF="${WB_REF:-origin/$BRANCH}"
SLUG="${WB_SLUG:-JAFairweather/waggle}"
NPM_CMD="${WB_NPM_CMD:-npm ci --omit=dev --no-audit --no-fund}"
RESTART_CMD="${WB_RESTART_CMD:-sudo systemctl restart}"
DRY_RUN="${DRY_RUN:-}"

# Ship list — MUST mirror deploy.sh's rsync set and verify-deployed.sh's SHIP. config.json,
# .env and data/ are absent by construction: not listed, and no --delete. That is the whole
# no-clobber guarantee, stated in one place.
SHIP='src tests tools package.json package-lock.json config.example.json'

log() { echo "deploy-runner[$LANE] $*"; }
alarm() { echo "deploy-runner[$LANE] ALARM: $*" >&2; }
# The private routing policy is a deploy gate even when the new commit changes no shipped code.
# A docs-only tick must never advance DEPLOYED_SHA past an incomplete live config.
CONFIG_VERIFY_CMD="${WB_CONFIG_VERIFY_CMD:-sh \"$HUB/deploy/verify-config.sh\" \"$TREE/config.json\"}"

# Default CI-state resolver: GitHub Actions records results as CHECK-RUNS (not legacy commit
# statuses), so ask the check-runs API for this exact sha and aggregate. Unauthenticated for a
# public repo (a poll every few minutes is well under the 60/hr limit); a private repo needs a
# READ-only token in GH_TOKEN — still no write credential on the box. Echoes one word:
#   success  every check-run completed with conclusion=success (and there was at least one)
#   failure  a check-run completed non-success  |  pending  none yet, or one still running
#   error    the API could not be reached / parsed  (caller refuses to deploy on error)
ci_state_github() {
  _sha="$1"
  _url="https://api.github.com/repos/$SLUG/commits/$_sha/check-runs"
  # Build the optional auth header via positional params so the value ("Authorization: Bearer
  # <tok>") survives as ONE argument — plain word-splitting would break it at its spaces. _sha
  # is already saved above, so clobbering $@ here is safe.
  if [ -n "${GH_TOKEN:-}" ]; then set -- -H "Authorization: Bearer $GH_TOKEN"; else set --; fi
  _json=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$@" "$_url" 2>/dev/null) \
    || { echo error; return; }
  printf '%s' "$_json" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const r=(JSON.parse(s).check_runs)||[];
        if(!r.length) return console.log("pending");
        if(r.some(c=>c.status!=="completed")) return console.log("pending");
        if(r.some(c=>c.conclusion!=="success")) return console.log("failure");
        console.log("success");
      }catch(_){console.log("error");}
    });' 2>/dev/null || echo error
}

[ -d "$HUB/.git" ] || { echo "  ✗ hub clone not found at $HUB (WB_HUB) — bootstrap it first"; exit 2; }

# --- resolve the candidate commit -------------------------------------------------------
if [ -z "${WB_NO_FETCH:-}" ]; then
  git -C "$HUB" fetch --quiet origin "$BRANCH" || { echo "  ✗ git fetch failed"; exit 2; }
fi
TARGET_SHA=$(git -C "$HUB" rev-parse "$REF" 2>/dev/null) \
  || { echo "  ✗ cannot resolve ref $REF in $HUB"; exit 2; }
SHORT=$(git -C "$HUB" rev-parse --short "$TARGET_SHA")
DEPLOYED_SHA=$(cat "$TREE/DEPLOYED_SHA" 2>/dev/null || echo none)

log "target $SHORT ($REF); deployed $DEPLOYED_SHA"

if [ "$TARGET_SHA" = "$DEPLOYED_SHA" ]; then
  log "already current — nothing to do"; exit 0
fi

# --- green gate: merged is not enough, CI must have passed for THIS sha ------------------
if [ -n "${WB_CI_STATE_CMD:-}" ]; then
  STATE=$(sh -c "$WB_CI_STATE_CMD \"$TARGET_SHA\"" 2>/dev/null || echo error)
else
  STATE=$(ci_state_github "$TARGET_SHA")
fi
case "$STATE" in
  success) log "CI green for $SHORT" ;;
  failure) alarm "CI is RED for $SHORT on $BRANCH — refusing to deploy a failing commit"; exit 0 ;;
  pending) log "CI still running for $SHORT — will retry next tick"; exit 0 ;;
  *)       alarm "could not determine CI state for $SHORT (got '$STATE') — refusing to deploy blind"; exit 0 ;;
esac

if [ -n "$DRY_RUN" ]; then
  log "DRY_RUN — would deploy $SHORT into $TREE; ship list: $SHIP"
  exit 0
fi

# --- no-op gate: did anything we actually SHIP change? (#162) ----------------------------
# The SHA comparison above answers "is there a new commit", not "is there new CODE". Docs,
# CI config and deploy/ are not in the ship list, so a docs-only merge would otherwise rsync
# byte-identical content, run npm ci, and RESTART THE LANE — dropping every relay
# subscription and re-running backfill to change nothing. Most merges on this repo are docs.
#
# Skipping the restart is only safe if the tree really is already correct for the new commit,
# so this does not merely assume it: the SHA is recorded and verify-deployed.sh is still run.
# A drift alarms exactly as it would after a full deploy.
#
# Falls through to a full deploy whenever the question cannot be answered — no DEPLOYED_SHA
# (first run), or a recorded SHA the hub does not have (force-push, rebase, restored tree).
# Being unable to check is not a reason to skip work.
if [ "$DEPLOYED_SHA" != "none" ] && git -C "$HUB" cat-file -e "${DEPLOYED_SHA}^{commit}" 2>/dev/null; then
  # shellcheck disable=SC2086  # SHIP is an intentional word list
  CHANGED=$(git -C "$HUB" diff --name-only "$DEPLOYED_SHA" "$TARGET_SHA" -- $SHIP 2>/dev/null || echo '?')
  if [ -z "$CHANGED" ]; then
    log "no shipped files changed between $(git -C "$HUB" rev-parse --short "$DEPLOYED_SHA") and $SHORT — recording without restarting"
    if ! sh -c "$CONFIG_VERIFY_CMD"; then
      alarm "live routing policy is incomplete or unreadable — DEPLOYED_SHA left unchanged"
      exit 1
    fi
    if sh "$HUB/deploy/verify-deployed.sh" "$LANE" "$TREE" "$TARGET_SHA"; then
      printf '%s\n' "$TARGET_SHA" > "$TREE/DEPLOYED_SHA.tmp" && mv "$TREE/DEPLOYED_SHA.tmp" "$TREE/DEPLOYED_SHA"
      log "no-op deploy OK — $TREE already matches $SHORT, verified, lane untouched"
      exit 0
    else
      alarm "no-op deploy: tree does NOT match $SHORT despite no shipped file changing — investigate now"
      exit 1
    fi
  fi
fi

# --- deploy: check out the exact sha in the hub, ship code-only into the tree ------------
git -C "$HUB" checkout --quiet --detach "$TARGET_SHA" \
  || { alarm "could not check out $SHORT in hub"; exit 2; }

log "shipping code into $TREE"
# From the hub checked out at TARGET_SHA, ship exactly deploy.sh's set (no --delete, so
# config.json/.env/data on the tree are untouched). Source has no trailing slash, so each
# dir lands as $TREE/<name>, matching what verify-deployed.sh resolves.
# shellcheck disable=SC2086  # SHIP is an intentional word list
( cd "$HUB" && rsync -a $SHIP "$TREE/" ) || { alarm "rsync into $TREE failed — tree may be half-shipped"; exit 1; }

log "installing deps in $TREE"
( cd "$TREE" && sh -c "$NPM_CMD" ) || { alarm "dependency install failed in $TREE"; exit 1; }

log "restarting $UNIT"
sh -c "$RESTART_CMD \"$UNIT\"" || { alarm "restart of $UNIT failed"; exit 1; }

# --- post-deploy: what is on disk MUST equal git at the sha we shipped -------------------
log "verifying deployed tree against $SHORT"
if sh "$HUB/deploy/verify-deployed.sh" "$LANE" "$TREE" "$TARGET_SHA"; then
  # Code provenance alone is not a healthy bridge. config.json is deliberately never shipped,
  # so verify its live routing policy separately and fail closed if it is absent or incomplete.
  if ! sh -c "$CONFIG_VERIFY_CMD"; then
    alarm "live routing policy is incomplete or unreadable — DEPLOYED_SHA left unchanged"
    exit 1
  fi
  # DEPLOYED_SHA is written ONLY here — after verify passes (#136).
  #
  # It used to be written before the restart, reasoning that a crash mid-restart should still
  # leave the tree's provenance truthful. That ordering costs more than it buys: if verify FAILS,
  # the file already claims success, so the next tick reads "already current", skips, and a
  # PERSISTENT DRIFT ALARMS EXACTLY ONCE. An alarm that fires once for an ongoing fault reads as
  # handled — the same shape this repo keeps re-learning.
  #
  # Writing it only on a verified deploy self-heals instead. A crash anywhere before this line
  # leaves the old SHA, so the next tick re-deploys: rsync is idempotent, the dep install is
  # idempotent, and a redundant restart costs seconds. The tree is re-verified and the alarm
  # repeats every tick until someone fixes it, which is what a standing fault should do.
  #
  # The trade, stated: provenance becomes "last VERIFIED sha" rather than "last shipped sha".
  # That is the more useful of the two — it is the question verify-deployed.sh asks anyway.
  printf '%s\n' "$TARGET_SHA" > "$TREE/DEPLOYED_SHA.tmp" && mv "$TREE/DEPLOYED_SHA.tmp" "$TREE/DEPLOYED_SHA"
  log "deploy OK — $TREE now at $SHORT, code and live policy verified"
  exit 0
else
  alarm "post-deploy drift at $SHORT — deployed tree does NOT match git; investigate now"
  # Deliberately does not quote the skip-path wording: a log line that contains the phrase a
  # grep looks for is a log line that defeats the grep.
  alarm "DEPLOYED_SHA left unchanged, so the next tick re-deploys and re-alarms rather than skipping this tree as up to date"
  exit 1
fi
