#!/bin/sh
# Pull a merged, CI-green Waggle release onto the dedicated policy host.
# Bootstrap establishes ingress public keys, owner policy, and Bunker credentials once.
set -eu

HUB=${WP_HUB:-/opt/waggle-policy-hub}
TREE=${WP_TREE:-/opt/waggle-policy}
RELEASE_ROOT=${WP_RELEASE_ROOT:-/opt/waggle-policy-releases}
BRANCH=${WP_BRANCH:-main}
REF=${WP_REF:-origin/$BRANCH}
SLUG=${WP_SLUG:-JAFairweather/waggle}
SHA_FILE=${WP_SHA_FILE:-/etc/waggle-policy/DEPLOYED_SHA}
NPM_CMD=${WP_NPM_CMD:-npm ci --omit=dev --ignore-scripts --no-audit --no-fund}
INSTALL_CMD=${WP_INSTALL_CMD:-sh deploy/policy-host-install.sh}
RESTART_CMD=${WP_RESTART_CMD:-systemctl restart waggle-policy.socket waggle-policy-shadow.socket}
VERIFY_CMD=${WP_VERIFY_CMD:-sh deploy/verify-policy-host.sh}

log() { echo "policy-deploy $*"; }
alarm() { echo "policy-deploy ALARM: $*" >&2; }

if [ -z "${WP_ALLOW_NON_ROOT:-}" ] && [ "$(id -u)" -ne 0 ]; then
  alarm 'runner must execute as root on the dedicated policy host'; exit 2
fi
[ -d "$HUB/.git" ] || { alarm "hub clone not found at $HUB"; exit 2; }
mkdir -p "$RELEASE_ROOT"

ci_state_github() {
  sha=$1
  url="https://api.github.com/repos/$SLUG/commits/$sha/check-runs"
  if [ -n "${GH_TOKEN:-}" ]; then set -- -H "Authorization: Bearer $GH_TOKEN"; else set --; fi
  json=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$@" "$url" 2>/dev/null) || { echo error; return; }
  printf '%s' "$json" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const r=JSON.parse(s).check_runs||[];
        if(!r.length||r.some(x=>x.status!=="completed")) return console.log("pending");
        console.log(r.every(x=>x.conclusion==="success")?"success":"failure");
      } catch (_) { console.log("error") }
    })' 2>/dev/null || echo error
}

if [ -z "${WP_NO_FETCH:-}" ]; then
  git -C "$HUB" fetch --quiet origin "$BRANCH" || { alarm 'git fetch failed'; exit 2; }
fi
TARGET_SHA=$(git -C "$HUB" rev-parse "$REF" 2>/dev/null) || { alarm "cannot resolve $REF"; exit 2; }
case "$TARGET_SHA" in *[!0-9a-f]*|'') alarm 'resolved ref is not a commit SHA'; exit 2 ;; esac
[ "${#TARGET_SHA}" -eq 40 ] || { alarm 'resolved ref is not a full commit SHA'; exit 2; }
SHORT=$(printf '%.12s' "$TARGET_SHA")
DEPLOYED_SHA=$(cat "$SHA_FILE" 2>/dev/null || echo none)

if [ "$TARGET_SHA" = "$DEPLOYED_SHA" ]; then
  (cd "$TREE" && sh -c "$VERIFY_CMD") || { alarm "deployed $SHORT failed verification"; exit 1; }
  log "already current and verified at $SHORT"; exit 0
fi

if [ -n "${WP_CI_STATE_CMD:-}" ]; then
  STATE=$(sh -c "$WP_CI_STATE_CMD \"$TARGET_SHA\"" 2>/dev/null || echo error)
else
  STATE=$(ci_state_github "$TARGET_SHA")
fi
case "$STATE" in
  success) log "CI green for $SHORT" ;;
  failure) alarm "CI is red for $SHORT; refusing deployment"; exit 0 ;;
  pending) log "CI pending for $SHORT; retrying next tick"; exit 0 ;;
  *) alarm "CI state unavailable for $SHORT; refusing deployment"; exit 0 ;;
esac

if [ -n "${DRY_RUN:-}" ]; then log "DRY_RUN would deploy $SHORT to $TREE"; exit 0; fi

# Public identity is bootstrap state, not release state. Private keys never enter this process.
LIVE_AUTH=${WP_LIVE_AUTHORIZED_KEY:-/etc/ssh/authorized_keys/waggle-policy-ingress}
SHADOW_AUTH=${WP_SHADOW_AUTHORIZED_KEY:-/etc/ssh/authorized_keys/waggle-policy-shadow-ingress}
LIVE_PUB=$(sed -n 's/^restrict //p' "$LIVE_AUTH" | head -n 1)
SHADOW_PUB=$(sed -n 's/^restrict //p' "$SHADOW_AUTH" | head -n 1)
[ -n "$LIVE_PUB" ] && [ -n "$SHADOW_PUB" ] || { alarm 'bootstrap ingress public keys are missing'; exit 2; }

STAGE="$RELEASE_ROOT/.stage-$TARGET_SHA"
FAILED="$RELEASE_ROOT/failed-$TARGET_SHA"
PREVIOUS="$RELEASE_ROOT/previous"
ARCHIVE="$RELEASE_ROOT/.archive-$TARGET_SHA.tar"
rm -rf -- "$STAGE"
rm -f -- "$ARCHIVE"
mkdir -p "$STAGE"
git -C "$HUB" archive --output="$ARCHIVE" "$TARGET_SHA" src tools deploy package.json package-lock.json || {
  alarm 'could not export the exact candidate commit'; exit 1;
}
tar -x -f "$ARCHIVE" -C "$STAGE" || { alarm 'could not extract candidate release'; exit 1; }
rm -f -- "$ARCHIVE"
(cd "$STAGE" && sh -c "$NPM_CMD") || { alarm 'dependency installation failed before promotion'; exit 1; }
rm -rf -- "$STAGE/node_modules/.bin"
if find "$STAGE" -xdev -type l -print -quit | grep -q .; then alarm 'staged release contains a symlink'; exit 1; fi
if [ -n "${WP_TEST_SKIP_OWNERSHIP:-}" ] && [ -n "${WP_ALLOW_NON_ROOT:-}" ]; then
  : # Test seam: production has neither variable and always seals the complete release below.
else
  chown -R root:root "$STAGE"
  find "$STAGE" -xdev -type d -exec chmod 0755 {} +
  find "$STAGE" -xdev -type f -exec chmod a-w,go+r {} +
fi

rollback() {
  alarm "deployment of $SHORT failed; restoring previous verified release"
  rm -rf -- "$FAILED"
  [ ! -e "$TREE" ] || mv "$TREE" "$FAILED"
  if [ -d "$PREVIOUS" ]; then
    mv "$PREVIOUS" "$TREE"
    (cd "$TREE" && WAGGLE_POLICY_CLIENT_PUB="$LIVE_PUB" WAGGLE_POLICY_SHADOW_CLIENT_PUB="$SHADOW_PUB" sh -c "$INSTALL_CMD") || true
    sh -c "$RESTART_CMD" || true
    (cd "$TREE" && sh -c "$VERIFY_CMD") || alarm 'ROLLBACK VERIFICATION FAILED — operator action required'
  else
    alarm 'no previous release exists; sockets require operator recovery'
  fi
  exit 1
}

rm -rf -- "$PREVIOUS"
[ ! -d "$TREE" ] || mv "$TREE" "$PREVIOUS"
mv "$STAGE" "$TREE" || rollback
(cd "$TREE" && WAGGLE_POLICY_CLIENT_PUB="$LIVE_PUB" WAGGLE_POLICY_SHADOW_CLIENT_PUB="$SHADOW_PUB" sh -c "$INSTALL_CMD") || rollback
sh -c "$RESTART_CMD" || rollback
(cd "$TREE" && sh -c "$VERIFY_CMD") || rollback
printf '%s\n' "$TARGET_SHA" > "$SHA_FILE.tmp"
mv "$SHA_FILE.tmp" "$SHA_FILE"
log "deploy verified at $SHORT; previous release retained at $PREVIOUS"
