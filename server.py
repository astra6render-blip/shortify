#!/usr/bin/env python3
"""
SHORTIFY — local dev / host server
==================================
Static studio + real YouTube metadata + real ffmpeg rendering (up to 4K).

  GET  /                        studio app
  GET  /api/health              liveness + renderer capabilities
  GET  /api/video?id=<yt-id>    live metadata via yt-dlp (demo fallback)
  POST /api/render              render a cut → returns job id
  GET  /api/render/<job>        poll a render job
  POST /api/render-sync         render and wait (used for short cuts / CLI)
  GET  /renders/<file>          finished MP4s (Range-capable for seeking)

Run:   python3 server.py            (PORT env var, default 8000)
"""
import json
import mimetypes
import os
import re
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

import renderer  # noqa: E402  (local module)

PORT = int(os.environ.get("PORT", "8000"))

DEMO_META = {
    "title": "Big Buck Bunny — Official Blender Open Movie",
    "channel": "Blender Foundation",
    "duration": 635,
    "thumb": "media/poster.jpg",
    "id": "aqz-KE-bpKQ",
    "demo": True,
    "note": "demo metadata",
}

YT_ID = re.compile(r"^[\w-]{6,32}$")


# yt-dlp is slow on small instances; a proxied host kills the request long
# before it finishes. Fetch once in the background and serve from cache.
_META_CACHE = {}          # vid -> (ts, payload)
_META_EVENTS = {}         # vid -> threading.Event
_META_LOCK = threading.Lock()
_META_TTL = 1800


def video_meta_cached(vid: str, wait: float = 18.0):
    """Return cached metadata, or kick off a background fetch and wait briefly."""
    now = time.time()
    hit = _META_CACHE.get(vid)
    if hit and now - hit[0] < _META_TTL:
        return hit[1]

    with _META_LOCK:
        ev = _META_EVENTS.get(vid)
        if ev is None:
            ev = threading.Event()
            _META_EVENTS[vid] = ev

            def _work():
                try:
                    payload = video_meta(vid)
                except Exception as exc:
                    payload = dict(DEMO_META, id=vid, demo=True,
                                   note=f"metadata failed ({type(exc).__name__})")
                with _META_LOCK:
                    _META_CACHE[vid] = (time.time(), payload)
                    _META_EVENTS.pop(vid, None)
                ev.set()

            threading.Thread(target=_work, daemon=True).start()

    ev.wait(timeout=max(1.0, wait))
    hit = _META_CACHE.get(vid)
    if hit:
        return hit[1]
    return {"pending": True, "id": vid,
            "note": "still reading the link — retry in a moment"}


def _cookie_file():
    """Path to a Netscape cookies.txt, from YT_COOKIES or base64 YT_COOKIES_B64.

    Cookies make YouTube treat us as a signed-in browser, which is the only
    reliable way past datacenter-IP bot checks (Render, Fly, most clouds).
    """
    ck = (os.environ.get("YT_COOKIES") or "").strip()
    if ck and os.path.exists(ck):
        return ck
    b64 = (os.environ.get("YT_COOKIES_B64") or "").strip()
    if b64:
        try:
            import base64
            import tempfile
            raw = base64.b64decode(b64)
            # cache it once per process
            global _COOKIE_PATH
            try:
                if _COOKIE_PATH and os.path.exists(_COOKIE_PATH):
                    return _COOKIE_PATH
            except NameError:
                pass
            fd, path = tempfile.mkstemp(suffix=".txt", prefix="ytck-")
            with os.fdopen(fd, "wb") as fh:
                fh.write(raw)
            _COOKIE_PATH = path
            return path
        except Exception:
            return ""
    return ""


_COOKIE_PATH = ""


def video_meta(vid: str):
    """Fetch public metadata with yt-dlp (no downloads)."""
    try:
        import yt_dlp  # noqa: WPS433
    except Exception:
        return dict(DEMO_META, id=vid, note="yt-dlp not installed; demo metadata")

    # YouTube rotates which player clients still work, per IP. Try several —
    # "Failed to extract any player response" on one client does not mean the
    # IP is blocked (verified: youtube.com/generate_204 returns 204 fine).
    # With cookies, the normal web client works — no client juggling needed.
    cookie_file = _cookie_file()
    if cookie_file:
        attempts = [None]
    else:
        attempts = [
            {"player_client": ["android"]},
            {"player_client": ["tv_embedded"], "player_skip": ["webpage", "configs"]},
            {"player_client": ["android"], "player_skip": ["webpage", "configs"]},
        ]
    # a proxied host cuts the connection at ~100s, so keep the whole thing short
    deadline = time.time() + 45
    info = None
    last_exc = None
    for attempt in attempts:
        if time.time() > deadline:
            break
        opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            "socket_timeout": 10,
            "retries": 0,
        }
        if attempt is None:
            opts["cookiefile"] = cookie_file
        else:
            opts["extractor_args"] = {"youtube": attempt}
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}",
                                        download=False)
            break
        except Exception as exc:
            last_exc = exc
            info = None
    if info is None:
        raise last_exc if last_exc else RuntimeError("yt-dlp returned no metadata")
    try:
        thumbs = info.get("thumbnails") or []
        thumb = ""
        if thumbs:
            best = sorted(thumbs, key=lambda t: (t.get("width") or 0))
            pick = next((t for t in best if (t.get("width") or 0) >= 480), best[-1])
            thumb = pick.get("url", "")
        return {
            "id": vid,
            "title": info.get("title") or DEMO_META["title"],
            "channel": info.get("uploader") or info.get("channel") or DEMO_META["channel"],
            "duration": int(info.get("duration") or DEMO_META["duration"]),
            "thumb": thumb or DEMO_META["thumb"],
            "demo": False,
        }
    except Exception as exc:
        return dict(DEMO_META, id=vid, demo=True,
                    note="youtube blocked this server's network; demo reel used")


class _SlicedFile:
    """File wrapper that stops after `n` bytes (for HTTP 206 bodies)."""

    def __init__(self, fh, n):
        self.fh = fh
        self.n = n

    def read(self, size=-1):
        if self.n <= 0:
            return b""
        if size is None or size < 0 or size > self.n:
            size = self.n
        data = self.fh.read(size)
        self.n -= len(data)
        return data

    def close(self):
        self.fh.close()


class Handler(SimpleHTTPRequestHandler):
    """Static files + Range/206 support (needed for <video> seeking) + render API."""

    protocol_version = "HTTP/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---------------- routing ----------------
    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            ff = renderer._ffmpeg()
            prof = renderer.machine_profile()
            caps = {}
            for p in renderer.OUTPUT_PRESETS:
                for f in renderer.ALLOWED_FPS:
                    for smooth in (False, True):
                        key = f"{p}:{f}:{'i' if smooth else 'd'}"
                        caps[key] = renderer.capability({"preset": p, "fps": f, "smooth": smooth})["ok"]
            self._json({
                "ok": True,
                "service": "shortify",
                "version": "2.0.0",
                "renderer": bool(ff),
                "ffmpeg": ff or None,
                "presets": list(renderer.OUTPUT_PRESETS.keys()),
                "max": "2160x3840 (4K vertical)",
                "machine": prof,
                "memory": {"available_mb": renderer._mem_available_mb(), "total_mb": prof["mem_mb"]},
                "fps": list(renderer.ALLOWED_FPS),
                "capabilities": caps,
            })
            return

        if path == "/api/yt-status":
            # Diagnostic: does the server see cookies, and what does YouTube say?
            out = {"cookies_configured": False, "cookies_count": 0}
            try:
                ck = _cookie_file()
                if ck and os.path.exists(ck):
                    out["cookies_configured"] = True
                    with open(ck, "r", errors="replace") as fh:
                        body = fh.read()
                    out["cookies_count"] = sum(
                        1 for ln in body.splitlines()
                        if "youtube" in ln and not ln.startswith("#"))
                    names = []
                    for ln in body.splitlines():
                        if ln.startswith("#") or not ln.strip():
                            continue
                        parts = ln.split("	")
                        if len(parts) >= 6 and "youtube" in parts[0]:
                            names.append(parts[5])
                    out["cookie_names"] = sorted(set(names))[:20]
            except Exception as exc:
                out["cookie_error"] = f"{type(exc).__name__}: {exc}"[:200]
            out["env_keys"] = sorted(
                k for k in os.environ if "YT_" in k or "COOKIE" in k.upper())
            # why is parsing failing? report the shape without leaking secrets
            b64 = (os.environ.get("YT_COOKIES_B64") or "").strip()
            raw = (os.environ.get("YT_COOKIES") or "").strip()
            if b64:
                import base64 as _b
                out["b64_length"] = len(b64)
                out["b64_has_newlines"] = "\n" in b64
                out["b64_has_spaces"] = " " in b64
                out["b64_prefix"] = b64[:16]
                try:
                    dec = _b.b64decode(b64 + "=" * (-len(b64) % 4))
                    out["decoded_bytes"] = len(dec)
                    txt = dec.decode("utf-8", "replace")
                    out["decoded_head"] = txt[:80].replace("\n", "⏎")
                    out["decoded_has_netscape"] = "Netscape HTTP Cookie" in txt
                    out["decoded_youtube_lines"] = sum(
                        1 for ln in txt.splitlines() if "youtube" in ln.lower())
                except Exception as exc:
                    out["decoded_error"] = f"{type(exc).__name__}: {exc}"[:150]
            if raw:
                out["raw_length"] = len(raw)
                out["raw_youtube_lines"] = sum(
                    1 for ln in raw.splitlines() if "youtube" in ln.lower())
            self._json(out)
            return

        if path == "/api/video":
            vid = (parse_qs(parsed.query).get("id") or [""])[0]
            if not YT_ID.match(vid):
                self._json({"error": "invalid id"}, status=400)
                return
            self._json(video_meta_cached(vid, wait=18.0))
            return

        m = re.match(r"^/api/render/([0-9a-f]{6,32})$", path)
        if m:
            data = renderer.job(m.group(1))
            if not data:
                self._json({"error": "unknown job"}, status=404)
                return
            self._json(data)
            return

        if path.startswith("/renders/"):
            return self._serve_render(path)

        if path in ("/robots.txt", "/sitemap.xml"):
            self._serve_seo(path)
            return

        super().do_GET()

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path not in ("/api/render", "/api/render-sync"):
            self._json({"error": "not found"}, status=404)
            return
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 64 * 1024)
            raw = self.rfile.read(length) if length else b"{}"
            state = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(state, dict):
                raise ValueError("payload must be an object")
        except Exception as exc:
            self._json({"error": f"bad JSON payload: {exc}"}, status=400)
            return

        renderer.cleanup()
        if parsed.path == "/api/render-sync":
            try:
                self._json(renderer.render(state))
            except Exception as exc:
                self._json({"error": str(exc)[:600]}, status=500)
            return

        job_id = renderer.render_async(state)
        self._json({"job": job_id, "status": "queued"}, status=202)

    # ---------------- helpers ----------------
    def _serve_seo(self, path):
        full = os.path.join(ROOT, os.path.basename(path))
        if not os.path.isfile(full):
            self.send_error(404)
            return
        ctype = "text/plain; charset=utf-8" if path.endswith(".txt") else "application/xml; charset=utf-8"
        with open(full, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=3600")
        self.end_headers()
        self.wfile.write(body)

    def _serve_render(self, path):
        name = os.path.basename(path)
        full = os.path.join(ROOT, "renders", name)
        if not re.fullmatch(r"[\w.-]+\.mp4", name) or not os.path.isfile(full):
            self._json({"error": "no such render"}, status=404)
            return
        try:
            size = os.path.getsize(full)
            ctype = "video/mp4"
            rng = self.headers.get("Range")
            if rng:
                self._range_response(full, size, ctype, rng)
            else:
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(size))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with open(full, "rb") as fh:
                    while True:
                        chunk = fh.read(256 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _range_response(self, full, size, ctype, rng):
        m = re.match(r"bytes=(\d*)-(\d*)\s*$", rng.strip())
        if not m:
            self.send_error(416)
            return
        first, last = m.group(1), m.group(2)
        start = int(first) if first else 0
        end = int(last) if last else size - 1
        end = min(end, size - 1)
        if start >= size or start > end:
            self.send_response(416, "Range Not Satisfiable")
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return
        length = end - start + 1
        self.send_response(206, "Partial Content")
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(full, "rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def send_head(self):
        """Static files, with Range/206 support so <video> can seek."""
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        rng = self.headers.get("Range")
        if not rng:
            return super().send_head()

        m = re.match(r"bytes=(\d*)-(\d*)\s*$", rng.strip())
        try:
            fh = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        if not m:
            fh.close()
            return super().send_head()

        size = os.fstat(fh.fileno()).st_size
        first, last = m.group(1), m.group(2)
        start = int(first) if first else 0
        end = int(last) if last else size - 1
        end = min(end, size - 1)
        if start >= size or start > end:
            fh.close()
            self.send_response(416, "Range Not Satisfiable")
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None

        length = end - start + 1
        self.send_response(206, "Partial Content")
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.send_header("Last-Modified", self.date_time_string(os.fstat(fh.fileno()).st_mtime))
        self.end_headers()
        fh.seek(start)
        return _SlicedFile(fh, length)

    def end_headers(self):
        if "accept-ranges" not in self._header_names():
            self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def _header_names(self):
        try:
            return b"".join(self._headers_buffer).decode("latin-1").lower()
        except Exception:
            return ""

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def _janitor():
    while True:
        time.sleep(600)
        try:
            renderer.cleanup()
        except Exception:
            pass


def main():
    os.chdir(ROOT)
    threading.Thread(target=_janitor, daemon=True).start()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    ff = renderer._ffmpeg()
    print(f"Shortify v2 running → http://0.0.0.0:{PORT}")
    print(f"  renderer: {'ffmpeg OK · 1080p → 4K' if ff else 'ffmpeg MISSING'}")
    print("  POST /api/render          → job id (async, real MP4)")
    print("  GET  /api/video?id=…      → live YouTube metadata")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
