#!/usr/bin/env bash
#
# merge-queue.sh — merge a stack of PRs in order, and refuse to guess.
#
#   ./tools/merge-queue.sh nvoy   185 187
#   ./tools/merge-queue.sh waggle 420 441 442 --go
#
# Plans by default. Nothing is mutated without --go, because merging waggle `main`
# deploys: the pull-based runner ships the first CI-green commit it finds, within
# minutes, with no human step in between.
#
# What it will NOT do, on purpose:
#   * merge a PR with a conflict (DIRTY) — a rebase can silently revert a change,
#     and that has happened in this repo, so a human reads the result
#   * merge a PR whose base is not `main` — a stacked PR merged early lands in its
#     parent branch, not in main, and looks merged either way
#   * merge with no CI, or with CI failing or still running
#   * pass --admin, --force, or otherwise bypass a branch rule
#
# Exit codes:  0 = everything asked for is merged (or planned clean)
#              1 = a real problem — read the output, nothing further was merged
#              3 = INCONCLUSIVE: could not determine a state (API/auth), no merge attempted

set -euo pipefail

# ── arguments ────────────────────────────────────────────────────────────────────
GO=0; NO_UPDATE=0; REPO=""; PRS=()
for arg in "$@"; do
  case "$arg" in
    --go)        GO=1 ;;
    --no-update) NO_UPDATE=1 ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    [0-9]*)      PRS+=("$arg") ;;
    *)           REPO="$arg" ;;
  esac
done

case "$REPO" in
  waggle) REPO="JAFairweather/waggle" ;;
  nvoy)   REPO="JAFairweather/nvoy" ;;
  "")     echo "usage: $0 <waggle|nvoy|owner/repo> <pr>... [--go] [--no-update]" >&2; exit 1 ;;
esac
[ ${#PRS[@]} -gt 0 ] || { echo "no PR numbers given" >&2; exit 1; }

command -v gh >/dev/null || { echo "gh is not on PATH" >&2; exit 3; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated — run: gh auth login" >&2; exit 3; }

BOLD=$(tput bold 2>/dev/null || true); DIM=$(tput dim 2>/dev/null || true)
RED=$(tput setaf 1 2>/dev/null || true); GRN=$(tput setaf 2 2>/dev/null || true)
YEL=$(tput setaf 3 2>/dev/null || true); OFF=$(tput sgr0 2>/dev/null || true)

say()  { printf '%s\n' "$*"; }
warn() { printf '%s%s%s\n' "$YEL" "$*" "$OFF"; }
bad()  { printf '%s%s%s\n' "$RED" "$*" "$OFF"; }
good() { printf '%s%s%s\n' "$GRN" "$*" "$OFF"; }

# The GitHub API flakes. A flake must never read as an answer, and it must not end a
# run either: three attempts, then INCONCLUSIVE. The first version of this script hit
# exactly this — a burst of calls returned nothing and it exited 3 on a queue that was
# in fact clean. Exiting 3 was right; giving up on the first hiccup was not.
retry() {
  local attempt=1 out
  while [ $attempt -le 3 ]; do
    if out=$("$@" 2>/dev/null) && [ -n "$out" ]; then printf '%s' "$out"; return 0; fi
    attempt=$((attempt + 1)); [ $attempt -le 3 ] && sleep $((attempt * 2))
  done
  return 1
}

DEFAULT_BRANCH=$(retry gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name) || {
  bad "could not read $REPO after 3 tries — check access. INCONCLUSIVE."; exit 3; }
[ -n "$DEFAULT_BRANCH" ] || { bad "could not resolve the default branch of $REPO"; exit 3; }

# ── helpers ──────────────────────────────────────────────────────────────────────



# Everything about one PR, in one API call. Printed as TAB-separated fields so a
# single fetch drives every decision below and the state cannot change between checks.
#
# Every empty field is emitted as "-". TAB is IFS whitespace, so bash `read` COLLAPSES
# a run of them: one empty field silently shifts every field after it by one, and the
# first version of this script printed a PR title where the review decision goes. A
# placeholder is the fix; the fields are positional and must stay aligned.
pr_facts() { retry _pr_facts_once "$1"; }
_pr_facts_once() {
  gh pr view "$1" --repo "$REPO" \
    --json state,isDraft,baseRefName,headRefName,mergeStateStatus,mergeable,title,reviewDecision \
    --jq '[.state,(.isDraft|tostring),.baseRefName,.headRefName,.mergeStateStatus,.mergeable,.reviewDecision,.title]
          | map(if . == null or . == "" then "-" else tostring end) | @tsv' 2>/dev/null
}

_ci_rollup_once() {
  gh pr view "$1" --repo "$REPO" --json statusCheckRollup \
    --jq 'if (.statusCheckRollup | length) == 0 then "__NONE__"
          else [.statusCheckRollup[] | (.conclusion // .state // "PENDING") | ascii_upcase] | join(" ") end' 2>/dev/null
}

# CI verdict for a PR: prints pass | fail | pending | none.
#
# Reads the rollup rather than `gh pr checks`, whose exit codes have moved between
# gh versions. A check run reports `conclusion`; a legacy status context reports
# `state`; a run that has not finished reports neither, which is why the `// empty`
# fallback below is a PENDING and never a pass.
ci_verdict() {
  local rollup
  # `retry` treats empty as a failure, and an empty rollup is a REAL answer here ("no
  # checks"), so the sentinel keeps the two apart rather than retrying a true negative.
  rollup=$(retry _ci_rollup_once "$1") || return 1
  [ "$rollup" = "__NONE__" ] && { echo none; return 0; }
  rollup=$(printf '%s' "$rollup" | tr -s ' ')
  if [ -z "$rollup" ]; then echo none; return 0; fi
  case " $rollup " in
    *" FAILURE "*|*" ERROR "*|*" CANCELLED "*|*" TIMED_OUT "*|*" ACTION_REQUIRED "*|*" STARTUP_FAILURE "*)
      echo fail; return 0 ;;
  esac
  case " $rollup " in
    *" PENDING "*|*" QUEUED "*|*" IN_PROGRESS "*|*" WAITING "*|*" EXPECTED "*|*" REQUESTED "*)
      echo pending; return 0 ;;
  esac
  echo pass
}

# Wait for a predicate, bounded. A poll that never gives up looks identical to a
# hung script, so this always terminates and always says which it was.
wait_for() {          # wait_for <label> <seconds> <command...>
  local label="$1" limit="$2"; shift 2
  local waited=0
  until "$@"; do
    if [ "$waited" -ge "$limit" ]; then
      warn "    timed out after ${limit}s waiting for: $label"
      return 1
    fi
    sleep 10; waited=$((waited + 10))
    printf '%s\r' "    ${DIM}waiting for $label — ${waited}s${OFF}"
  done
  printf '\033[2K\r'
  return 0
}

ci_is_settled() { local v; v=$(ci_verdict "$1") || return 1; [ "$v" != pending ]; }
base_is_default() { local b; b=$(pr_facts "$1" | cut -f3) || return 1; [ "$b" = "$DEFAULT_BRANCH" ]; }
state_is_known() { local m; m=$(pr_facts "$1" | cut -f5) || return 1; [ -n "$m" ] && [ "$m" != UNKNOWN ]; }

# ── the queue ────────────────────────────────────────────────────────────────────
say
say "${BOLD}$REPO${OFF} — ${#PRS[@]} PR(s), in the order given, into ${BOLD}$DEFAULT_BRANCH${OFF}"
if [ "$REPO" = "JAFairweather/waggle" ]; then
  warn "  merging $DEFAULT_BRANCH here DEPLOYS: the runner ships the first CI-green commit it finds."
fi
[ "$GO" = 1 ] && warn "  --go given: this run WILL merge." || say "  ${DIM}plan only — pass --go to actually merge${OFF}"
say

# Head branches of everything in this queue, so a stacked PR whose parent is ALSO
# queued is a plan, not a problem. Without this the plan stops at the first stacked
# PR and never shows the rest of the queue — which is the half you most want to read.
QUEUED_HEADS=""
for _n in "${PRS[@]}"; do
  _h=$(gh pr view "$_n" --repo "$REPO" --json headRefName --jq .headRefName 2>/dev/null || true)
  [ -n "$_h" ] && QUEUED_HEADS="$QUEUED_HEADS $_h"
done
parent_is_queued() { case " $QUEUED_HEADS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

MERGED=(); SKIPPED=(); PROBLEM=0

for n in "${PRS[@]}"; do
  say "${BOLD}── PR #$n${OFF}"

  facts=$(pr_facts "$n") || { bad "  cannot read PR #$n"; PROBLEM=1; break; }
  IFS=$'\t' read -r state draft base head mergestate mergeable review title <<<"$facts"
  say "  $title"
  say "  ${DIM}state=$state base=$base merge=$mergestate mergeable=$mergeable review=$review${OFF}"

  if [ "$state" != OPEN ]; then
    if [ "$state" = MERGED ]; then good "  already merged — nothing to do"; SKIPPED+=("#$n already merged"); continue; fi
    bad "  not open (state=$state) — refusing"; PROBLEM=1; break
  fi
  if [ "$draft" = true ]; then bad "  draft — refusing"; PROBLEM=1; break; fi

  # A stacked PR retargets to the default branch only once its parent is merged, and
  # GitHub takes a moment to do it. Merging before that lands the work in the parent
  # BRANCH, which reports as merged and ships nothing.
  if [ "$base" != "$DEFAULT_BRANCH" ]; then
    warn "  base is '$base', not '$DEFAULT_BRANCH' — this is a stacked PR"
    if [ "$GO" = 1 ] && [ ${#MERGED[@]} -gt 0 ]; then
      say "    waiting for GitHub to retarget it after the parent merge"
      if ! wait_for "retarget to $DEFAULT_BRANCH" 120 base_is_default "$n"; then
        bad "  still based on '$base'. Retarget it by hand and re-run:"
        say "      gh pr edit $n --repo $REPO --base $DEFAULT_BRANCH"
        PROBLEM=1; break
      fi
      facts=$(pr_facts "$n"); IFS=$'\t' read -r state draft base head mergestate mergeable review title <<<"$facts"
      good "    retargeted to $base"
    elif parent_is_queued "$base"; then
      say "    its parent is earlier in this queue — GitHub retargets it on that merge"
      say "    ${DIM}the --go run waits for the retarget and verifies it before merging${OFF}"
    else
      bad "  its parent is NOT in this queue. Merge the parent first, or retarget:"
      say "      gh pr edit $n --repo $REPO --base $DEFAULT_BRANCH"
      PROBLEM=1; break
    fi
  fi

  # GitHub computes mergeability lazily. UNKNOWN is not "fine".
  if [ "$mergestate" = UNKNOWN ] || [ -z "$mergestate" ] || [ "$mergeable" = UNKNOWN ]; then
    say "    mergeability not computed yet — asking again"
    if ! wait_for "a computed merge state" 90 state_is_known "$n"; then
      bad "  GitHub never reported a merge state for #$n. INCONCLUSIVE — not merging."
      PROBLEM=1; break
    fi
    facts=$(pr_facts "$n"); IFS=$'\t' read -r state draft base head mergestate mergeable review title <<<"$facts"
    say "  ${DIM}merge=$mergestate mergeable=$mergeable${OFF}"
  fi

  case "$mergestate" in
    DIRTY)
      bad "  CONFLICT — needs a rebase, and a human reads the result."
      say "    A branch that predates a change can silently revert it; that has happened here."
      say "    In waggle the usual cause is the suite count: several open PRs each bump"
      say "    package.json / CLAUDE.md / README.md / docs/GETTING_STARTED.md to the same"
      say "    number, so the first one merges clean and every other one conflicts on all four."
      say
      say "      git fetch origin && git checkout $head"
      say "      git rebase origin/$DEFAULT_BRANCH        # resolve, then READ the diff:"
      say "      git diff origin/$DEFAULT_BRANCH...HEAD"
      say "      npm test && git push --force-with-lease"
      say
      say "    Then re-run this script from #$n onward."
      PROBLEM=1; break ;;
    BEHIND)
      if [ "$NO_UPDATE" = 1 ]; then
        warn "  behind $DEFAULT_BRANCH, and --no-update was given — skipping"
        SKIPPED+=("#$n behind, not updated"); continue
      fi
      warn "  behind $DEFAULT_BRANCH — updating the branch (no conflict; a fast-forward merge of the base in)"
      if [ "$GO" = 1 ]; then
        if ! gh pr update-branch "$n" --repo "$REPO" 2>&1 | sed 's/^/    /'; then
          bad "  update-branch failed — rebase by hand and read the result"; PROBLEM=1; break
        fi
        say "    branch updated; CI will re-run against the new base"
        say "    ${DIM}read what changed:  gh pr diff $n --repo $REPO${OFF}"
      else
        say "    ${DIM}would run: gh pr update-branch $n --repo $REPO${OFF}"
      fi ;;
    BLOCKED)
      bad "  BLOCKED by a branch rule (review required, or a required check not reported)."
      say "    review decision: $review"
      say "    ${DIM}gh pr view $n --repo $REPO --json statusCheckRollup,reviewDecision${OFF}"
      PROBLEM=1; break ;;
    CLEAN|HAS_HOOKS|UNSTABLE) : ;;
    *) bad "  unhandled merge state '$mergestate' — refusing to guess"; PROBLEM=1; break ;;
  esac

  # CI. "Merged + CI green" is the deploy authorisation, so green is a precondition
  # of the merge, never something checked afterwards.
  verdict=$(ci_verdict "$n") || { bad "  could not read CI for #$n"; PROBLEM=1; break; }
  if [ "$verdict" = pending ]; then
    say "    CI still running"
    if ! wait_for "CI on #$n" 1800 ci_is_settled "$n"; then
      bad "  CI on #$n never settled. INCONCLUSIVE — not merging."; PROBLEM=1; break
    fi
    verdict=$(ci_verdict "$n")
  fi
  case "$verdict" in
    pass) good "  CI green" ;;
    fail) bad "  CI FAILING — refusing"; gh pr checks "$n" --repo "$REPO" 2>&1 | sed 's/^/    /' || true; PROBLEM=1; break ;;
    none) bad "  no CI checks reported at all. That is not a pass — refusing."
          say "    ${DIM}a suite that never ran and a suite that passed look identical from here${OFF}"
          PROBLEM=1; break ;;
  esac

  if [ "$GO" != 1 ]; then
    good "  WOULD MERGE (squash, delete branch)"
    SKIPPED+=("#$n ready — plan only")
    continue
  fi

  # --subject/--body explicitly: without them `gh pr merge --squash` opens an editor,
  # and whether that blocks depends on GIT_EDITOR, which differs between shells.
  say "  merging…"
  if gh pr merge "$n" --repo "$REPO" --squash --delete-branch \
       --subject "$title (#$n)" --body "" 2>&1 | sed 's/^/    /'; then
    good "  merged #$n"
    MERGED+=("#$n $title")
  else
    bad "  merge of #$n failed — stopping so nothing after it lands out of order"
    PROBLEM=1; break
  fi
done

# ── report ───────────────────────────────────────────────────────────────────────
say
say "${BOLD}── result${OFF}"
if [ ${#MERGED[@]} -gt 0 ]; then
  good "merged ${#MERGED[@]}:"; for m in "${MERGED[@]}"; do say "  $m"; done
  head_sha=$(gh api "repos/$REPO/commits/$DEFAULT_BRANCH" --jq '.sha[0:12]' 2>/dev/null || echo '?')
  say "$DEFAULT_BRANCH is now at $head_sha"
  if [ "$REPO" = "JAFairweather/waggle" ]; then
    warn "waggle main moved — the deploy runner will pick up the first CI-green commit."
    say "  ${DIM}Prove the deploy rather than assume it: deploy/README.md${OFF}"
  fi
fi
if [ ${#SKIPPED[@]} -gt 0 ]; then
  say "not merged:"; for s in "${SKIPPED[@]}"; do say "  $s"; done
fi
[ "$PROBLEM" = 1 ] && { bad "stopped early — the queue is ordered, so nothing after the failure was attempted"; exit 1; }
[ ${#MERGED[@]} -eq 0 ] && [ "$GO" = 1 ] && { warn "nothing was merged"; exit 0; }
exit 0
