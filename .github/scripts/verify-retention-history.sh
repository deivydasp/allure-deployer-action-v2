#!/usr/bin/env bash
# Checks gh-pages after a deploy with commit_retention_days on top of seed-retention-history.sh.
#   verify-retention-history.sh <expected commit count> <expected deploys of this run>
# Writes the tip SHA to retention-tip.txt for a follow-up check.
set -euo pipefail
: "${GH_REPO:?GH_REPO must be set}" "${GITHUB_RUN_ID:?}" "${SKEWED_DATE:?run seed-retention-history.sh first}"
expected_count="$1"
expected_deploys="$2"
shift 2

fail() { echo "::error::$1"; exit 1; }

# One line per commit, newest first: <sha> <parent count> <committer date> <subject>
gh api "repos/$GH_REPO/commits?sha=gh-pages&per_page=100" \
    -q '.[] | "\(.sha) \(.parents | length) \(.commit.committer.date) \(.commit.message | split("\n")[0])"' > retention-history.txt
echo "=== gh-pages history ==="
cat retention-history.txt

count=$(wc -l < retention-history.txt)
[ "$count" -eq "$expected_count" ] || fail "Expected $expected_count commits, got $count"
! grep -q "retention-test: old" retention-history.txt || fail "Commits older than the cutoff were not dropped"
tail -1 retention-history.txt | grep -Eq '^[0-9a-f]+ 0 .* retention-test: recent$' ||
    fail "The root commit should be the oldest commit inside the retention window"
grep -q "$SKEWED_DATE retention-test: skewed$" retention-history.txt ||
    fail "The commit with an out-of-order date was dropped or lost its original date"
deploys=$(grep -c "Allure report for GitHub run: $GITHUB_RUN_ID$" retention-history.txt || true)
[ "$deploys" -eq "$expected_deploys" ] || fail "Expected $expected_deploys deploys of this run, got $deploys"

echo "=== Files of dropped commits are still published ==="
for f in retention-seed/old-0700.txt retention-seed/old-1300.txt retention-seed/skewed.txt "$@"; do
    gh api "repos/$GH_REPO/contents/$f?ref=gh-pages" --silent || fail "$f missing on gh-pages"
    echo "OK: $f"
done

head -1 retention-history.txt | cut -d' ' -f1 > retention-tip.txt
echo "=== All checks passed ==="
