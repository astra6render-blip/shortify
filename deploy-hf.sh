#!/usr/bin/env bash
# Deploy Shortify to Hugging Face Spaces (free, no credit card).
#   HF_TOKEN=hf_xxx ./deploy-hf.sh [space-name]
set -euo pipefail
: "${HF_TOKEN:?set HF_TOKEN — create one at https://huggingface.co/settings/tokens (write scope)}"
SPACE="${1:-shortify}"
API="https://huggingface.co/api"

USER=$(curl -s -H "Authorization: Bearer $HF_TOKEN" "$API/whoami-v2" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get("name") or "")")
echo "user: $USER"

echo "→ creating space $USER/$SPACE (docker)"
curl -s -X POST "$API/repos/create" \
  -H "Authorization: Bearer $HF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"$SPACE\",\"type\":\"space\",\"sdk\":\"docker\",\"private\":false}" \
  | head -c 300; echo

echo "→ pushing the repo as the space"
cd "$(dirname "$0")"
git remote remove hf 2>/dev/null || true
git remote add hf "https://user:$HF_TOKEN@huggingface.co/spaces/$USER/$SPACE"
git push hf main --force
git remote remove hf 2>/dev/null || true

echo
echo "✓ live in a few minutes at: https://$USER-$SPACE.hf.space"
echo "  build logs: https://huggingface.co/spaces/$USER/$SPACE"
