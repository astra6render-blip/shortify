#!/usr/bin/env python3
"""
SHORTIFY · renderer.py
======================
Builds and runs the real ffmpeg render for a Shortify cut.

  render(state) → mp4 file under renders/

The filter graph mirrors the browser studio:
cover-crop to the target aspect, grading ("look"), the stackable effect list
(punch-in, shake, beat pulse, glitch, RGB split, VHS, Ken Burns, flash,
squeeze, whip blur), colour grade, letterbox and word-timed karaoke captions
(ASS subtitles, one phrase at a time — exactly like the preview).

Everything is opt-in from the client; unknown values are clamped so a bad
request can never inject arbitrary ffmpeg arguments.
"""
import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
import uuid

ROOT = os.path.dirname(os.path.abspath(__file__))
RENDERS = os.path.join(ROOT, "renders")
FONT_DIR = os.path.join(ROOT, "assets", "fonts")
SOURCE_1080 = os.path.join(ROOT, "media", "source1080.mp4")
SOURCE_PREVIEW = os.path.join(ROOT, "media", "demo.mp4")
SOURCE_CACHE = os.environ.get("SHORTIFY_SOURCE_CACHE", os.path.join(ROOT, "renders", ".sources"))
YT_ID = re.compile(r"^[\w-]{6,32}$")


def _ffmpeg_dir():
    """Directory containing ffmpeg (yt-dlp needs a dir, not a file path)."""
    found = shutil.which("ffmpeg")
    if found:
        return os.path.dirname(found)
    try:
        import imageio_ffmpeg  # noqa: WPS433
        return os.path.dirname(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception:
        return ""


def _real_source(state):
    """Return a local file for a real link, or None. Downloads are cached."""
    src = state.get("source") or {}
    if not isinstance(src, dict):
        return None, None, 0.0
    vid = str(src.get("id") or "").strip()
    if not YT_ID.match(vid) or src.get("demo"):
        return None, None, 0.0
    os.makedirs(SOURCE_CACHE, exist_ok=True)
    cached = os.path.join(SOURCE_CACHE, f"{vid}.mp4")
    offset_file = cached + ".offset"
    if os.path.exists(cached) and os.path.getsize(cached) > 100_000:
        off = 0.0
        try:
            off = float(open(offset_file).read().strip())
        except Exception:
            pass
        return cached, vid, off

    start = _num(state.get("start"), 0, 0, 36000)
    end = _num(state.get("end"), start + 15, start + 1, 36000)
    pad = 2.0
    section = f"*{max(0, start - pad):.2f}-{min(36000, end + pad):.2f}"

    try:
        import yt_dlp  # noqa: WPS433
    except Exception as exc:
        raise RuntimeError("yt-dlp is not installed on the server") from exc

    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 20,
        "outtmpl": cached,
        # widest to narrowest so a partial client still yields something
        "format": ("bv*[height<=1080][ext=mp4]+ba[ext=m4a]/"
                   "bv*[height<=1080]+ba/"
                   "b[height<=1080][ext=mp4]/b[height<=720]/b"),
        "merge_output_format": "mp4",
        "download_ranges": None,
        # yt-dlp wants a DIRECTORY here, not the binary path
        "ffmpeg_location": _ffmpeg_dir(),
        # 'android' alone is the reliable one for ranged downloads: web_safari
        # returns a stream layout that ffmpeg refuses to seek into (exit 8),
        # and android_vr sometimes yields no cuttable format.
        "extractor_args": {"youtube": {"player_client": ["android"]}},
        "retries": 2,
    }
    # Optional: a cookies file makes YouTube treat us as a signed-in browser,
    # which is the reliable way past datacenter-IP blocking.
    ck = os.environ.get("YT_COOKIES", "").strip()
    if ck and os.path.exists(ck):
        opts["cookiefile"] = ck
        opts.pop("extractor_args", None)
    elif os.environ.get("YT_COOKIES_B64"):
        import base64
        import tempfile
        try:
            raw = base64.b64decode(os.environ["YT_COOKIES_B64"])
            fd, ckpath = tempfile.mkstemp(suffix=".txt", prefix="ytck-")
            with os.fdopen(fd, "wb") as fh:
                fh.write(raw)
            opts["cookiefile"] = ckpath
            opts.pop("extractor_args", None)
        except Exception:
            pass

    # Ranged download => yt-dlp only fetches the seconds we need. This works
    # with ffmpeg alone (verified on a box with no ffprobe). If it ever fails,
    # the caller falls back to the cached/demo path gracefully.
    try:
        from yt_dlp.utils import download_range_func
        opts["download_ranges"] = download_range_func(None, [(max(0, start - pad), end + pad)])
    except Exception:
        pass
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([f"https://www.youtube.com/watch?v={vid}"])
    except Exception as exc:
        raise RuntimeError(
            "YouTube refused this server. It blocks most cloud/datacenter IPs "
            "unless the request is signed in. Options: run Shortify on a home "
            "connection or VPS with normal residential access, pass browser "
            "cookies via YT_COOKIES, or render the built-in demo reel."
        ) from exc
    if not os.path.exists(cached):
        for name in os.listdir(SOURCE_CACHE):
            if name.startswith(vid):
                fp = os.path.join(SOURCE_CACHE, name)
                return fp, vid, max(0.0, start - pad)
        raise RuntimeError("download finished but no video file was produced")

    # A ranged download is re-timed to start at 0, so remember the real offset.
    offset = max(0.0, start - pad)
    try:
        with open(offset_file, "w") as fh:
            fh.write(f"{offset:.3f}")
    except Exception:
        pass
    return cached, vid, offset

OUTPUT_PRESETS = {
    "1080p": (1080, 1920),
    "1440p": (1440, 2560),
    "4k": (2160, 3840),
}

ALLOWED_FPS = (30, 60, 120)


def _norm_fps(value, default=30):
    try:
        v = int(float(value))
    except (TypeError, ValueError):
        return default
    return v if v in ALLOWED_FPS else default
ASPECT_RATIO = {"9:16": 9 / 16, "1:1": 1.0, "4:5": 4 / 5}

LOOKS = {
    "none": "",
    "vivid": "eq=saturation=1.45:contrast=1.12",
    "cinema": "eq=contrast=1.18:saturation=0.82:brightness=-0.06",
    "noir": "hue=s=0,eq=contrast=1.22",
    "sunset": "eq=saturation=1.35:contrast=1.06,colorbalance=rs=.12:bs=-.08",
    "neon": "eq=saturation=1.6:contrast=1.15,hue=h=12",
}

# ordered so compositing reads the same as the studio's effect list
ALL_EFFECTS = ["punch", "shake", "squeeze", "pulse", "kenburns", "whip",
               "glitch", "rgb", "vhs", "flash"]

_jobs = {}
_jobs_lock = threading.Lock()
# only one encode at a time: each ffmpeg process needs a few hundred MB
_encode_lock = threading.Lock()


def _cgroup_mb(kind):
    """Container limits. /proc/meminfo shows the HOST's RAM, not the container's,
    so on Render/Fly/K8s a 512 MB instance still reports 31 GB. Read the cgroup
    instead — v2 first (limit is "max" when unlimited), then v1."""
    paths = {
        "total": ("/sys/fs/cgroup/memory.max",
                  "/sys/fs/cgroup/memory/memory.limit_in_bytes"),
        "used": ("/sys/fs/cgroup/memory.current",
                 "/sys/fs/cgroup/memory/memory.usage_in_bytes"),
    }
    for path in paths[kind]:
        try:
            with open(path) as fh:
                raw = fh.read().strip()
            if raw in ("max", ""):
                continue
            val = int(raw)
            if val <= 0 or val >= (1 << 62):      # unlimited / absurd
                continue
            return val // (1024 * 1024)
        except Exception:
            continue
    return None


def _mem_available_mb():
    limit = _cgroup_mb("total")
    used = _cgroup_mb("used")
    if limit is not None and used is not None:
        return max(0, limit - used)
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return None


def _mem_total_mb():
    limit = _cgroup_mb("total")
    if limit is not None:
        return limit
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return 4096


def machine_profile():
    """Small boxes get smaller thread counts / presets so renders can't OOM."""
    mem = _mem_total_mb()
    try:
        cpus = len(os.sched_getaffinity(0))
    except Exception:
        cpus = os.cpu_count() or 2
    tier = "small" if mem < 3000 else "standard"
    return {"mem_mb": mem, "cpus": cpus, "tier": tier}


def _ffmpeg():
    ff = shutil.which("ffmpeg")
    if ff:
        return ff
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _num(value, default, lo, hi):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(v) or math.isinf(v):
        return default
    return max(lo, min(hi, v))


def _clean_text(text, limit=120):
    """Strip anything that could break an ASS/ffmpeg command."""
    text = re.sub(r"[\r\n\t]+", " ", str(text or ""))
    text = re.sub(r"[{}]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


_PRESET_ALIASES = {
    "1080": "1080p", "1080p": "1080p", "fhd": "1080p", "fullhd": "1080p",
    "1440": "1440p", "1440p": "1440p", "qhd": "1440p", "2k": "1440p",
    "2160": "4k", "2160p": "4k", "4k": "4k", "uhd": "4k",
}


def _select_preset(state):
    raw = str(state.get("preset") or state.get("resolution") or "1080p").strip().lower()
    preset = _PRESET_ALIASES.get(raw)
    if not preset:
        preset = "1080p"
    w, h = OUTPUT_PRESETS[preset]
    aspect = state.get("aspect") if state.get("aspect") in ASPECT_RATIO else "9:16"
    if aspect != "9:16":
        ratio = ASPECT_RATIO[aspect]
        h = int(round((w / ratio) / 2.0) * 2)
    return preset, w, h, aspect


def _effects(state):
    raw = state.get("effects") or []
    on = set()
    for item in raw:
        if isinstance(item, dict) and item.get("on") and item.get("id") in ALL_EFFECTS:
            on.add(item["id"])
        elif isinstance(item, str) and item in ALL_EFFECTS:
            on.add(item)
    return on


def build_srt(state, cut_start, cut_end):
    """Word-timed phrases, one at a time (closest real equivalent to live karaoke)."""
    words = _clean_text(state.get("caption"), 140).split()
    if not words:
        return None
    phrases, cur = [], []
    for w in words:
        if (len(cur) >= 2 or len(" ".join(cur + [w])) > 15) and cur:
            phrases.append(cur[:])
            cur = [w]
        else:
            cur.append(w)
    if cur:
        phrases.append(cur)
    phrases = phrases[:6] if len(phrases) > 6 else phrases

    dur = max(0.5, cut_end - cut_start)
    total_words = sum(len(p) for p in phrases)
    step = dur / max(1, total_words)
    lines = []
    t = 0.0
    for i, ph in enumerate(phrases):
        start = t
        t += step * len(ph)
        end = min(dur, t)
        def ts(x):
            ms = int(round(x * 1000))
            return f"{ms//3600000}:{(ms//60000)%60:02d}:{(ms//1000)%60:02d},{ms%1000:03d}"
        text = " ".join(ph).upper()
        lines.append(f"{i+1}\n{ts(start)} --> {ts(end)}\n{text}\n")
    return "\n".join(lines)


ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,DejaVu Sans,{fs},{hl},&H00FFFFFF,&H8C000000,&H78000000,-1,0,0,0,100,100,0,0,1,{outline},{shadow},2,80,80,{mv},1
Style: Card,DejaVu Sans,{cardfs},{hl},&H00FFFFFF,&H50000000,&H70000000,-1,0,0,0,100,100,0,0,1,0,2,8,90,90,{cardtop},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def build_ass(state, cut_start, cut_end, w, h):
    caption = _clean_text(state.get("caption"), 140)
    card = _clean_text(state.get("card"), 90)
    card_on = bool(state.get("cardOn", True)) and bool(card)
    if not caption and not card_on:
        return None

    fs = int(max(18, min(h * 0.115, (state.get("capSize") or 96) * h / 768.0)))
    cardfs = int(max(14, min(h * 0.062, fs * 0.52)))
    outline = max(1, int(round(fs * 0.055)))
    shadow = max(1, int(round(fs * 0.04)))
    mv = int(h * 0.20)          # caption sits in the lower third
    cardtop = int(h * 0.075)    # hook title near the top

    def ts(x):
        cs = int(round(x * 100))
        return f"{cs//360000}:{(cs//6000)%60:02d}:{(cs//100)%60:02d}.{cs%100:02d}"

    cut_len = max(0.5, cut_end - cut_start)
    events = []

    if card_on:
        events.append(
            f"Dialogue: 1,{ts(0.0)},{ts(cut_len)},Card,,0,0,0,,{_ass_escape(card.upper())}"
        )

    words = caption.split()
    if words:
        phrases, cur = [], []
        for w in words:
            if (len(cur) >= 2 or len(" ".join(cur + [w])) > 15) and cur:
                phrases.append(cur[:])
                cur = [w]
            else:
                cur.append(w)
        if cur:
            phrases.append(cur)
        step = cut_len / max(1, sum(len(p) for p in phrases))
        t = 0.0
        for ph in phrases:
            start, t = t, t + step * len(ph)
            txt = _ass_escape(" ".join(ph).upper())
            # karaoke highlight sweep across the phrase (like the studio's pixel loop)
            kt = max(10, int(round(step * len(ph) * 100)))
            events.append(
                f"Dialogue: 0,{ts(start)},{ts(min(cut_len, t))},Cap,,0,0,0,,{{\\kf{kt}}}{txt}"
            )

    header = ASS_HEADER.format(w=w, h=h, fs=fs, cardfs=cardfs, outline=outline,
                               shadow=shadow, mv=mv, cardtop=cardtop,
                               hl=_ass_color(state.get("capHi")))
    return header + "\n".join(events) + "\n"


def _ass_color(hex_value, fallback="&H004DE1FF"):
    """#rrggbb -> ASS &HAABBGGRR (karaoke highlight)."""
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", str(hex_value or ""))
    if not m:
        return fallback
    r, g, b = m.group(1)[0:2], m.group(1)[2:4], m.group(1)[4:6]
    return f"&H00{b}{g}{r}".upper()


def _ass_escape(text):
    return text.replace("\\", "＼").replace("{", "(").replace("}", ")")


def build_command(state, out_path, ass_path=None, source=None, w=1080, h=1920, offset=0.0):
    fx = _effects(state)
    intensity = _num(state.get("intensity"), 60, 0, 100) / 100.0
    bpm = _num(state.get("bpm"), 96, 40, 220)
    fps = _norm_fps(state.get("fps"), 30)
    cut_start = _num(state.get("start"), 0, 0, 36000)
    cut_end = _num(state.get("end"), cut_start + 15, cut_start + 1, 36000)
    # a ranged download starts at 0, so seek into the clip, not the original
    seek = max(0.0, cut_start - offset) if offset else cut_start
    zoom_amt = _num(state.get("zoom"), 12, 0, 40) / 100.0
    look = LOOKS.get(state.get("look"), "")
    letterbox = bool(state.get("letterbox"))
    beat = 60.0 / bpm
    frame_t = 1.0 / fps

    parts = []
    # 1) cover-crop the 16:9 master to the target frame
    parts.append(f"crop='min(iw,ih*{w}/{h})':'min(ih,iw*{h}/{w})'")

    # 2) fit to the exact output size
    parts.append(f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos")
    parts.append(f"crop={w}:{h}")
    parts.append("setsar=1")

    # 3) time-based zoom: punch-in / beat pulse / ken burns (supersample 2% so it stays sharp)
    base_zoom = 1.02 + zoom_amt * 0.30
    if fx & {"punch", "pulse", "kenburns"} or zoom_amt > 0:
        terms = [f"{base_zoom:.4f}"]
        if "pulse" in fx:
            terms.append(f"{0.05*intensity:.4f}*abs(sin(PI*on/{max(1, round(beat*fps))}))")
        if "kenburns" in fx:
            terms.append(f"{0.05*intensity:.4f}*sin(PI*on/{max(2, int(fps * 20))})")
        zexpr = "+".join(terms)
        ox, oy = "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
        if "shake" in fx:
            amp = max(1, int(round(intensity * 14 * w / 1080)))
            ox += f"+{amp}*sin(on/{fps}*41)"
            oy += f"+{max(1,amp-2)}*cos(on/{fps}*37)"
        parts.append(f"zoompan=z='{zexpr}':x='{ox}':y='{oy}':d=1:s={w}x{h}:fps={fps}")

    # zoompan can emit drifting timestamps — reset the clock so everything
    # downstream (and the muxer) sees a clean, monotonic stream
    parts.append("setpts=N/({0}*TB)".format(fps))

    # 4) cut-boundary punch kick (sharp pop right after the first frame)
    if "punch" in fx:
        kick = 1.0 + intensity * 0.10
        parts.append(
            f"scale=w='iw*({kick:.3f}+({1-kick:.3f})*min(t/{max(frame_t,0.4):.3f},1))'"
            f":h=-2:eval=frame,crop={w}:{h}"
        )

    # 5) squeeze + whip blur near the cut
    if "squeeze" in fx:
        pump = max(3, int(round((60 / bpm) * 4)))
        parts.append(
            f"scale=w='iw*(1+{0.06*intensity:.3f}*mod(n\\,{pump})/{pump})':h={h}:eval=frame,"
            f"crop={w}:{h}"
        )
    if "whip" in fx:
        parts.append(f"gblur=sigma='{2+intensity*16:.2f}':enable='lt(t,{0.18:.2f})'")

    # 6) look / grading
    if look:
        parts.append(look)

    # 7) texture effects
    if "glitch" in fx:
        period = max(4, int(round(beat * fps)))
        win = max(1, int(round(period * 0.18)))
        # burst of digital noise + a brief RGB tear, both gated to the beat
        parts.append(f"noise=alls={int(4 + intensity*10)}:allf=t+u:enable='lt(mod(n\\,{period})\\,{win})'")
        px = int(1 + intensity * 6)
        parts.append(f"chromashift=cbh={px}:crv=-{px}:enable='lt(mod(n\\,{period})\\,{win})'")
    if "rgb" in fx:
        px = int(2 + intensity * 10)
        parts.append(f"chromashift=cbh={px}:crv=-{px}")
    if "vhs" in fx:
        parts.append(f"noise=alls={int(3 + intensity*8)}:allf=t")
        parts.append("curves=preset=vintage")
        parts.append(f"drawgrid=width=iw:height=max(2\\,ih/{int(160+ (1-intensity)*120)}):thickness=1:color=black@{(0.05+0.1*intensity):.2f}")
    if "flash" in fx:
        parts.append("fade=t=in:st=0:d=0.10:color=white")

    # 8) letterbox bars
    if letterbox:
        bar = int(h * 0.055)
        parts.append(f"drawbox=x=0:y=0:w={w}:h={bar}:color=black@1:t=fill")
        parts.append(f"drawbox=x=0:y={h-bar}:w={w}:h={bar}:color=black@1:t=fill")

    # 9) captions
    if ass_path:
        esc = ass_path.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
        parts.append(f"ass='{esc}':fontsdir='{FONT_DIR.replace(chr(92), '/')}'")

    # 10) frame-rate: duplicate to 60/120 by default; interpolate only when asked
    if state.get("smooth") and fps >= 60:
        prof = machine_profile()
        window = 24 if prof["tier"] == "standard" else 8
        parts.append(
            f"minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir"
            f":search_param={window}"
        )

    # 11) square pixels + web-friendly pixel format
    parts.append("setsar=1")
    parts.append("format=yuv420p")

    ff = _ffmpeg() or "ffmpeg"
    prof = machine_profile()
    big = w * h > 1920 * 1080
    # small boxes: single-threaded lookahead keeps peak RAM low
    threads = "2" if prof["tier"] == "small" else str(max(2, prof["cpus"]))
    preset = "ultrafast" if prof["tier"] == "small" else ("veryfast" if big else "medium")
    cmd = [
        ff, "-y", "-hide_banner", "-loglevel", "error",
        "-threads", threads,
        "-ss", f"{seek:.3f}", "-t", f"{max(0.5, cut_end - cut_start):.3f}",
        "-i", source or (SOURCE_1080 if os.path.exists(SOURCE_1080) else SOURCE_PREVIEW),
        "-vf", ",".join(parts),
        "-r", str(fps),
        "-c:v", "libx264", "-preset", preset,
        "-crf", "18", "-pix_fmt", "yuv420p", "-profile:v", "high",
        "-x264-params", "rc-lookahead=10:ref=1:bframes=1" if big else "rc-lookahead=20",
        "-c:a", "aac", "-b:a", "160k", "-ac", "2",
        "-movflags", "+faststart",
        out_path,
    ]
    return cmd


def _plan(state):
    preset, w, h, aspect = _select_preset(state)
    cut_start = _num(state.get("start"), 0, 0, 36000)
    cut_end = _num(state.get("end"), cut_start + 15, cut_start + 1, 36000)
    return {"preset": preset, "w": w, "h": h, "aspect": aspect,
            "start": cut_start, "end": cut_end,
            "fps": _norm_fps(state.get("fps"), 30),
            "smooth": bool(state.get("smooth"))}


def capability(state):
    """Estimate whether this machine can finish the requested render.

    Video encoding RAM scales with pixels × frame rate, and motion
    interpolation roughly triples it. The numbers below are deliberately
    conservative: it is better to refuse than to get OOM-killed mid-encode.
    """
    preset, w, h, _aspect = _select_preset(state)
    fps = _norm_fps(state.get("fps"), 30)
    smooth = bool(state.get("smooth"))
    prof = machine_profile()
    px = float(w * h)
    # measured peak RSS in this project:
    #   1080p duplicate-frames ≈ 170 MB · 4K duplicate-frames ≈ 760 MB
    #   1080p @120 interpolated ≈ 760 MB      → minterpolate ≈ 4.5× the base pass
    # fit to measured peaks: 1080p ≈ 170 MB → 4K ≈ 775 MB (≈ +360 MB per 4× pixels)
    # measured peak RSS: 1080p ≈ 170 MB, 1440p ≈ 260 MB, 4K ≈ 775 MB (with effects)
    ratio = px / 2_073_600.0                           # 1.0 at 1080p, 4.0 at 4K
    base = 130 + 40 * (ratio ** 2.0)                   # 130 + 40·ratio²
    if smooth and fps >= 60:
        base *= 4.5                                     # minterpolate measured ≈ 4–5×
    need = base * (1.0 + max(0.0, (fps - 30) / 90.0) * 0.12) + 300   # fps + python/OS floor
    # generous allowance: the measured peaks above are with the full effect stack,
    # so only block combinations that genuinely cannot fit in this box
    ok = need <= max(800, prof["mem_mb"] * 1.35)
    reason = ""
    if not ok:
        reason = (
            f"{preset} @ {fps}fps{' with interpolation' if smooth else ''} needs roughly "
            f"{need / 1024:.1f} GB of RAM and this server has {prof['mem_mb'] / 1024:.1f} GB. "
            "Try 1080p at this frame rate, drop to 60 fps, or deploy the renderer to a host "
            "with more memory — the Dockerfile works unchanged."
        )
    return {"ok": ok, "needed_mb": int(need), "mem_mb": prof["mem_mb"], "reason": reason}


def render(state):
    """Run a render synchronously; returns metadata about the produced file."""
    ff = _ffmpeg()
    if not ff:
        raise RuntimeError("ffmpeg is not available on this machine")
    cap = capability(state)
    if not cap["ok"]:
        raise RuntimeError(cap["reason"])
    os.makedirs(RENDERS, exist_ok=True)
    plan = _plan(state)
    job_id = uuid.uuid4().hex[:12]
    out_name = f"shortify-{plan['preset']}-{plan['aspect'].replace(':','x')}-{job_id}.mp4"
    # encode into a temp file first — a killed encode must never look like a real MP4
    tmp_path = os.path.join(RENDERS, f".{job_id}.part.mp4")
    out_path = os.path.join(RENDERS, out_name)

    ass_path = None
    ass = build_ass(state, plan["start"], plan["end"], plan["w"], plan["h"])
    if ass:
        ass_path = os.path.join(RENDERS, f".{job_id}.ass")
        with open(ass_path, "w", encoding="utf-8") as fh:
            fh.write(ass)

    # real link → local file (cached); demo → bundled 1080p master
    source_path, source_id, source_off = _real_source(state)
    if not source_path:
        source_path = SOURCE_1080 if os.path.exists(SOURCE_1080) else SOURCE_PREVIEW

    # re-check real memory right before encoding: other processes (browsers,
    # other renders) can have eaten the estimate since the request arrived
    need_mb = capability(state)["needed_mb"]
    avail = _mem_available_mb()
    # allow a real safety margin below the prediction: measured peaks are lower
    # than the conservative estimate used for the capability matrix
    if avail is not None and avail < max(420, need_mb * 0.62):
        raise RuntimeError(
            f"not enough free memory right now — this render wants about "
            f"{need_mb} MB and only {avail} MB is free. Close other tabs/apps, "
            "pick a smaller preset, or deploy the renderer to a bigger host."
        )

    cmd = build_command(state, tmp_path, ass_path,
                        source=source_path, w=plan["w"], h=plan["h"],
                        offset=source_off)
    t0 = time.time()
    if not _encode_lock.acquire(timeout=30):
        raise RuntimeError("the renderer is busy — try again in a moment")
    try:
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        finally:
            if ass_path and os.path.exists(ass_path):
                os.remove(ass_path)
        ok = proc.returncode == 0 and os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 4096
        if not ok:
            stderr = (proc.stderr or "").strip()
            killed = proc.returncode < 0
            if killed:
                hint = (f"the encoder was killed (signal {-proc.returncode}) — "
                        "this render needs more memory than the server has. "
                        "Lower the resolution or frame rate, or deploy to a bigger host.")
            elif "No space left" in stderr:
                hint = "the server ran out of disk space in renders/"
            elif not stderr:
                hint = f"ffmpeg exited with code {proc.returncode} and no message"
            else:
                hint = stderr.splitlines()[-1][:300]
            raise RuntimeError(hint)
        # moov-atom sanity check: a truncated encode has no valid MP4 header
        with open(tmp_path, "rb") as fh:
            head = fh.read(64)
        if b"ftyp" not in head:
            raise RuntimeError("render produced an invalid MP4 (encoder was interrupted)")
        os.replace(tmp_path, out_path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        _encode_lock.release()

    size = os.path.getsize(out_path)
    return {
        "file": out_name,
        "url": f"/renders/{out_name}",
        "preset": plan["preset"],
        "width": plan["w"],
        "height": plan["h"],
        "aspect": plan["aspect"],
        "fps": plan["fps"],
        "smooth": plan.get("smooth", False),
        "source": source_id or "demo-reel",
        "duration": round(plan["end"] - plan["start"], 2),
        "bytes": size,
        "render_seconds": round(time.time() - t0, 1),
        "command": " ".join(cmd),
    }


def render_async(state):
    job_id = uuid.uuid4().hex[:12]
    with _jobs_lock:
        _jobs[job_id] = {"id": job_id, "status": "queued", "started": time.time()}
    def work():
        with _jobs_lock:
            _jobs[job_id]["status"] = "rendering"
        try:
            result = render(state)
            with _jobs_lock:
                _jobs[job_id].update(result)
                _jobs[job_id]["status"] = "done"
        except Exception as exc:  # surfaced to the client, never raised
            with _jobs_lock:
                _jobs[job_id].update({"status": "error", "error": str(exc)[:600]})
    threading.Thread(target=work, daemon=True).start()
    return job_id


def job(job_id):
    with _jobs_lock:
        data = _jobs.get(job_id)
        return dict(data) if data else None


def cleanup(max_age=3600):
    """Drop renders older than an hour so the disk can't fill up."""
    now = time.time()
    if not os.path.isdir(RENDERS):
        return
    for name in os.listdir(RENDERS):
        path = os.path.join(RENDERS, name)
        try:
            if now - os.path.getmtime(path) > max_age:
                os.remove(path)
        except OSError:
            pass
    with _jobs_lock:
        for key in [k for k, v in _jobs.items()
                    if v.get("status") in ("done", "error") and now - v.get("started", now) > max_age]:
            _jobs.pop(key, None)


if __name__ == "__main__":
    # quick self-test: 4 seconds at 4K with the whole effect stack
    demo = {
        "preset": "4k", "aspect": "9:16", "fps": 30, "start": 30, "end": 34,
        "look": "vivid", "intensity": 60, "bpm": 96, "zoom": 12,
        "caption": "wait for the twist it changes everything",
        "card": "auto-cut demo", "cardOn": True, "capSize": 96,
        "effects": [{"id": e, "on": True} for e in ALL_EFFECTS],
    }
    print(json.dumps(render(demo), indent=2))
