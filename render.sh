#!/usr/bin/env bash
# Start Shortify on $PORT (default 8000), installing what's missing.
set -e
cd "$(dirname "$0")"

python3 - <<'PY'
import importlib, subprocess, sys
need = [p for p in ("imageio_ffmpeg",) if not importlib.util.find_spec(p)]
if need:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", *need])
PY

exec python3 server.py
