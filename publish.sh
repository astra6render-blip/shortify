#!/usr/bin/env bash
# One-command publish. Requires either a GitHub token (to create/push the repo)
# or an existing repo URL.
#
#   GH_TOKEN=ghp_xxx ./publish.sh
#   ./publish.sh git@github.com:you/shortify.git
set -euo pipefail
cd "$(dirname "$0")"

REPO_URL="${1:-}"
if [ -z "$REPO_URL" ]; then
  : "${GH_TOKEN:?set GH_TOKEN (a GitHub personal access token with 'repo' scope)}"
  command -v git >/dev/null || { echo "git missing"; exit 1; }
  # create the repo if it does not exist yet
  NAME="shortify"
  curl -s -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['login'])" > /tmp/ghuser
  USER=$(cat /tmp/ghuser)
  curl -s -o /dev/null -X POST -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    https://api.github.com/user/repos -d "{\"name\":\"$NAME\",\"private\":false}" || true
  REPO_URL="https://$GH_TOKEN@github.com/$USER/$NAME.git"
fi

[ -d .git ] || git init -q
git add -A
git -c user.email=publish@shortify.local -c user.name=shortify commit -qm "Shortify: studio + 1080p→4K 120fps renderer" || true
git branch -M main
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"
git push -u origin main

echo
echo "✓ pushed to GitHub."
echo
echo "Next, deploy it:"
echo "  Render  → https://dashboard.render.com/blueprints  (connect this repo, it reads render.yaml)"
echo "  Railway → https://railway.app/new  (Deploy from GitHub repo, Dockerfile is auto-detected)"
echo "  VPS     → git clone <repo> && docker build -t shortify . && docker run -d -p 80:8000 shortify"
