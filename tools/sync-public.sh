#!/usr/bin/env bash
# Sync the private development tree to the PUBLIC repo.
#
# The two repos deliberately do NOT share history: reference/subnautica/ holds
# copyrighted Subnautica frames and node_modules/ was committed before the
# gitignore existed, and both are in the private repo's history for good. This
# copies the current tree instead, so nothing from that history can leak.
#
#   ./tools/sync-public.sh "commit message"
set -euo pipefail
PUB="${CN_PUBLIC_DIR:-/c/Users/bekaz/AppData/Local/Temp/claude/claudenautica-public}"
MSG="${1:-Sync from private development repo}"

[ -d "$PUB/.git" ] || { echo "public checkout not found at $PUB — clone sepivip/ClaudeNautica there first"; exit 1; }
node tools/verify.mjs >/dev/null || { echo "REFUSING TO SYNC — the build does not render."; exit 1; }

for p in src tools progress index.html package.json package-lock.json AGENT_BRIEF.md; do
  rm -rf "${PUB:?}/$p"; cp -r "$p" "$PUB/"
done
mkdir -p "$PUB/reference"; cp reference/*.md "$PUB/reference/"
mkdir -p "$PUB/.githooks"; cp .githooks/pre-commit "$PUB/.githooks/"

# Regenerate the development log from the private history (text only).
{ echo "# Development log"; echo
  echo "Every commit from the private development repo, newest first — the real messages,"
  echo "unedited. They are included because the story they tell is the interesting part of"
  echo "this project: roughly half of all rounds were spent discovering that the measuring"
  echo "apparatus was wrong, not the game."; echo; echo "---"; echo
  git log --pretty=format:"## %s%n%n%b%n---%n"
} > "$PUB/HISTORY.md"

cd "$PUB"
# Belt and braces: never let a reference plate or a dependency reach the public repo.
git add -A
if git diff --cached --name-only | grep -qE '(^|/)node_modules/|^reference/subnautica/'; then
  echo "ABORT — excluded content is staged. Check .gitignore."; git reset -q; exit 1
fi
git diff --cached --quiet && { echo "nothing to sync"; exit 0; }
git commit -q -m "$MSG"
git push -q origin main
echo "synced -> https://github.com/sepivip/ClaudeNautica"
