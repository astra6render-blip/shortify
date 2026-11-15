#!/usr/bin/env bash
# Export YouTube cookies from your browser and print the value for Render.
#
#   ./get-cookies.sh              # tries Chrome, then Firefox, then Edge
#   ./get-cookies.sh firefox
#
# Requires yt-dlp locally:  pip install -U yt-dlp
set -euo pipefail
cd "$(dirname "$0")"

BROWSER="${1:-chrome}"
OUT="yt-cookies.txt"
TEST_ID="${2:-dQw4w9WgXcQ}"

command -v yt-dlp >/dev/null || { echo "yt-dlp not found. Run: pip install -U yt-dlp"; exit 1; }

echo "› reading cookies from $BROWSER"
# --cookies-from-browser writes a Netscape file when --cookies is also given
if ! yt-dlp --cookies-from-browser "$BROWSER" --cookies "$OUT" \
      "https://www.youtube.com/watch?v=$TEST_ID" --skip-download >/dev/null 2>&1; then
  echo "  could not read $BROWSER. Close the browser completely and retry,"
  echo "  or try another one:  ./get-cookies.sh firefox"
  exit 1
fi

COUNT=$(grep -c "youtube.com" "$OUT" 2>/dev/null || echo 0)
echo "  wrote $OUT with $COUNT YouTube cookies"

if [ "$COUNT" -lt 2 ]; then
  echo "  ⚠ very few cookies — sign in to youtube.com in that browser first,"
  echo "    then run this again."
  exit 1
fi

echo
echo "› verifying the cookies actually work"
if yt-dlp --cookies "$OUT" "https://www.youtube.com/watch?v=$TEST_ID" \
     --skip-download --print "%(title)s" >/tmp/_ck_test 2>/dev/null; then
  echo "  ✓ works — resolved: $(cat /tmp/_ck_test)"
else
  echo "  ✗ cookies did not resolve the video. They may be stale; sign in again."
  exit 1
fi

echo
echo "════════════════════════════════════════════════════════════════"
echo " Paste this into Render → your service → Environment →"
echo " Add Environment Variable →  key: YT_COOKIES_B64"
echo "════════════════════════════════════════════════════════════════"
echo
if base64 --help 2>&1 | grep -q -- "-w"; then
  base64 -w0 "$OUT"
else
  base64 "$OUT" | tr -d '\n'
fi
echo
echo
echo "════════════════════════════════════════════════════════════════"
echo " Then click Save. Render rebuilds and real links will work."
echo " Cookies last roughly 2–6 weeks; rerun this script when they expire."
echo "════════════════════════════════════════════════════════════════"
