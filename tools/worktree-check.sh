# usage: bash tools/worktree-check.sh <commit>: runs all tests on exactly that commit in its own git worktree
# (no git-ignored files there: the test/local suites are missing and the client-data tests skip)
set -euo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
WANT=$(git -C "$R" rev-parse --verify "$1^{commit}")
WT=$(mktemp -d "${TMPDIR:-/tmp}/ip-wt.XXXX")
LOG="$WT.log"
trap 'git -C "$R" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$WT"' EXIT
git -C "$R" worktree add --detach "$WT" "$WANT" >/dev/null 2>&1
HEAD_WT=$(git -C "$WT" rev-parse HEAD)
[ "$HEAD_WT" = "$WANT" ] || { echo "STOP: worktree HEAD $HEAD_WT is not $WANT"; exit 1; }
echo "worktree HEAD = $(git -C "$WT" rev-parse --short HEAD)"
ln -s "$R/node_modules" "$WT/node_modules"
(cd "$WT" && npx jest > "$LOG" 2>&1) || { grep -E "●.*›|^Tests:" "$LOG"; echo "STOP: worktree tests failed (log $LOG)"; exit 1; }
grep -E "^Tests:" "$LOG"
