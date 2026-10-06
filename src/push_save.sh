#!/usr/bin/env bash
# Commit data/push/sent.json after alerts go out, even if another job pushed to main a moment earlier
# (same idea as src/social/save_log.sh: start from main, merge our log into it, retry).
set -u
cd "$(git rev-parse --show-toplevel)"
LOG=data/push/sent.json
[ -f "$LOG" ] || { echo "No alerts sent"; exit 0; }
git ls-files --error-unmatch "$LOG" >/dev/null 2>&1 && git diff --quiet -- "$LOG" && { echo "No alerts sent"; exit 0; }
mine=$(mktemp)
cp "$LOG" "$mine"
git config user.name "rankings-bot"
git config user.email "rankings-bot@users.noreply.github.com"
for try in 1 2 3 4; do
  git fetch -q origin main
  git checkout -q -f -B main origin/main   # our copy of the log is safe in $mine
  cp "$mine" "$LOG.ours"
  [ -f "$LOG" ] || echo "[]" > "$LOG"
  python src/push.py merge --file "$LOG.ours" && rm -f "$LOG.ours"
  git add "$LOG"
  git diff --cached --quiet && { echo "Alert log already up to date"; exit 0; }
  git commit -qm "Alert log update $(date -u +%Y-%m-%dT%H:%MZ)"
  git push -q origin main && { echo "Alert log saved"; exit 0; }
  sleep $((try * 5))
done
echo "Could not save the alert log"; exit 1
