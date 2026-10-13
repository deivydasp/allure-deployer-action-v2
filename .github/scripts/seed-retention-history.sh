#!/usr/bin/env bash
# Replaces the gh-pages commit history with a small chain of known dates, so the commit retention test
# takes the prune path on every run. Every tree builds on the current tip, so no published file is lost:
# only the history of this repo's own test reports is rewritten.
#
#   old 07:00 (30 days ago) <- old 13:00 (30 days ago) <- recent <- skewed (60 days ago) <- recent after skewed
#
# A retention of 7 days must drop both old commits and keep the rest, including the skewed one: a commit
# with an out-of-order date must never cut off the newer commits beneath it.
set -euo pipefail
: "${GH_REPO:?GH_REPO must be set}"
BRANCH="${BRANCH:-gh-pages}"

api() { gh api "repos/$GH_REPO/$1" "${@:2}"; }

# tree <base tree> <path> <content>: the base tree plus one file
tree() {
    jq -n --arg b "$1" --arg p "$2" --arg c "$3" \
        '{base_tree: $b, tree: [{path: $p, mode: "100644", type: "blob", content: $c}]}' |
        api git/trees --input - -q .sha
}

# commit <message> <tree> <date> [parent]: author and committer both carry the date
commit() {
    jq -n --arg m "$1" --arg t "$2" --arg d "$3" --arg p "${4:-}" '
        {name: "retention-test", email: "retention-test@users.noreply.github.com", date: $d} as $who |
        {message: $m, tree: $t, parents: (if $p == "" then [] else [$p] end), author: $who, committer: $who}' |
        api git/commits --input - -q .sha
}

tip=$(api "git/ref/heads/$BRANCH" -q .object.sha)
base_tree=$(api "git/commits/$tip" -q .tree.sha)

old_day=$(date -u -d '30 days ago' +%F)
skewed_date="$(date -u -d '60 days ago' +%F)T12:00:00Z"

t1=$(tree "$base_tree" retention-seed/old-0700.txt "seeded $old_day 07:00")
t2=$(tree "$t1" retention-seed/old-1300.txt "seeded $old_day 13:00")
t3=$(tree "$t2" retention-seed/skewed.txt "seeded with date $skewed_date")

c1=$(commit "retention-test: old 07:00" "$t1" "${old_day}T07:00:00Z")
c2=$(commit "retention-test: old 13:00" "$t2" "${old_day}T13:00:00Z" "$c1")
c3=$(commit "retention-test: recent" "$t2" "$(date -u -d '2 hours ago' +%FT%TZ)" "$c2")
c4=$(commit "retention-test: skewed" "$t3" "$skewed_date" "$c3")
c5=$(commit "retention-test: recent after skewed" "$t3" "$(date -u -d '1 hour ago' +%FT%TZ)" "$c4")

api "git/refs/heads/$BRANCH" -X PATCH -f sha="$c5" -F force=true >/dev/null
echo "Seeded $BRANCH: $c1 <- $c2 <- $c3 <- $c4 <- $c5 (was $tip)"
if [ -n "${GITHUB_ENV:-}" ]; then
    echo "SKEWED_DATE=$skewed_date" >> "$GITHUB_ENV"
fi
