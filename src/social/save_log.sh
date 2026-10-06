#!/usr/bin/env bash
# Commit data/social/posted.json after a post, even if another posting job pushed its own log a moment earlier
# (a plain "git pull --rebase" fails on that conflict, the log line is lost, and the post can repeat later).
# Used by the workflows that commit only the posting log.
set -u
cd "$(git rev-parse --show-toplevel)"
LOG=data/social/posted.json
git diff --quiet -- "$LOG" 2>/dev/null && { echo "Nothing new posted"; exit 0; }
mine=$(mktemp)
cp "$LOG" "$mine"
git config user.name "rankings-bot"
git config user.email "rankings-bot@users.noreply.github.com"
for try in 1 2 3 4; do
  git fetch -q origin main
  git checkout -q -f -B main origin/main   # our copy of the log is safe in $mine
  python src/social/posted.py --merge "$mine"
  git add "$LOG"
  git diff --cached --quiet && { echo "Log already up to date"; exit 0; }
  git commit -qm "Posting log update $(date -u +%Y-%m-%dT%H:%MZ)"
  git push -q origin main && { echo "Posting log saved"; exit 0; }
  sleep $((try * 5))
done
echo "Could not save the posting log"; exit 1
