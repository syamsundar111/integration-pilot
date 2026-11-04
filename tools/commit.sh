# usage: bash tools/commit.sh <message file> <file> [file...]: commits exactly these files after the checks, then tests
# the commit in its own worktree. Stops at the first failure; never amends or resets.
set -euo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$R"
L=$(mktemp -d "${TMPDIR:-/tmp}/ip-commit.XXXX")
MSG="$1"; shift
ALLOWED=("$@")
# every changed or new path must be on the task's list
changed=$(git status --porcelain --untracked-files=all | sed -E 's/^.. //')
for f in $changed; do
  ok=0; for a in "${ALLOWED[@]}"; do [ "$f" = "$a" ] && ok=1; done
  [ $ok = 1 ] || { echo "STOP: $f changed but is not on the task's list"; exit 1; }
done
echo '--- git diff --stat'; git diff --stat; git status --porcelain --untracked-files=all | grep '^??' || true
# main tree, by exit code
npx jest > "$L/main.log" 2>&1 || { grep -E "●.*›|^Tests:" "$L/main.log"; echo "STOP: main-tree tests failed (log $L/main.log)"; exit 1; }
echo "main tree: $(grep -E '^Tests:' "$L/main.log")"
npx jest test/no-client-data > "$L/cd.log" 2>&1 || { echo "STOP: client-data scan failed (log $L/cd.log)"; exit 1; }
echo "client-data scan: $(grep -E '^Tests:' "$L/cd.log")"
npx --yes eslint srv app/integration-pilot/webapp test tools --ext .js > "$L/eslint.log" 2>&1 || { grep -E " error " "$L/eslint.log"; echo "STOP: ESLint errors"; exit 1; }
echo "eslint: $(grep -E 'problems' "$L/eslint.log" || echo 'no problems')"
# commit exactly the listed files
git add -- "${ALLOWED[@]}"
git commit -q -F "$MSG"
echo "commit: $(git log --oneline -1)"
bash "$R/tools/worktree-check.sh" HEAD
