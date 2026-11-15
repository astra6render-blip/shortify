---
title: Shortify
emoji: ✂️
colorFrom: purple
colorTo: green
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# Shortify — paste a YouTube link, get editable Shorts, render up to 4K

A complete, self-contained web app: a marketing landing page, a live
"auto-cut" pass, a browser editing studio with a real timeline and effects
engine — and a **real ffmpeg renderer that exports 1080p, 1440p or 4K MP4s**.

```
shortify/
├── index.html            landing + analyzing + studio (single SPA shell)
├── server.py             static files (+Range/206) · /api/video · /api/render
├── renderer.py           real ffmpeg render: crop, looks, effects, ASS captions
├── render.sh             one-command start (installs missing deps)
├── Dockerfile            self-hosting image (ffmpeg + DejaVu, 1080p→4K)
├── requirements.txt      imageio-ffmpeg (ffmpeg fallback), yt-dlp
├── css/style.css         design system + responsive studio
├── js/data.js            demo source, moment detection, looks, effects
├── js/engine.js          live FX (canvas + transforms), captions
├── js/editor.js          studio controller: timeline, undo, render panel
├── js/app.js             routing, link parsing, analyze flow
├── assets/fonts/         DejaVu Sans Bold — burned into rendered captions
├── assets/peaks.json     timeline waveform
├── media/
│   ├── demo.mp4          120s · 720p web preview (what the editor plays)
│   ├── source1080.mp4    120s · 1920×1080 master (what the renderer encodes)
│   ├── storyboard.jpg    12-frame filmstrip
│   └── thumbs/           moment thumbnails
└── renders/              finished MP4s (auto-cleaned after 1 hour)
```

## Run it

```bash
cd shortify
pip install -r requirements.txt     # ffmpeg fallback + live metadata
python3 server.py                   # → http://0.0.0.0:8000
```

or `./render.sh` (same thing, installs what's missing first).

**Docker (recommended for hosting):**

```bash
docker build -t shortify .
docker run -d --name shortify -p 8000:8000 -v "$PWD/renders:/app/renders" shortify
```

Any host that can run a container or a Python process works: Fly.io, Railway,
Render, a VPS, or your own machine. Point the platform at `server.py`
(or the Dockerfile) and expose `$PORT`.

## Rendering: 1080p → 4K at 30 / 60 / 120 fps

Pick a resolution, a frame rate and whether to interpolate, then hit
**Render MP4**. The server runs ffmpeg, the file plays inline and downloads.

| Preset | 9:16 output | 1:1 | 4:5 | Measured (2 vCPU / 2 GB) |
| --- | --- | --- | --- | --- |
| 1080p | 1080 × 1920 | 1080×1080 | 1080×1350 | 2s clip → 1.4 s |
| 1440p | 1440 × 2560 | 1440×1440 | 1440×1800 | 2s clip → 2.1 s |
| **4K UHD** | **2160 × 3840** | 2160×2160 | 2160×2700 | 2s clip → 3.4 s |

**Frame rates: 30 / 60 / 120 fps.** At 60 and 120 you can either duplicate
frames (fast) or enable **true motion interpolation** (`minterpolate`,
`mi_mode=mci`) to generate real in-between frames — measured at ~7 s for a
2-second 1080p clip.

### What this machine can do

`GET /api/health` reports a capability matrix for the host it runs on. On this
2 vCPU / 2 GB sandbox that is **16 of 18 combinations**:

| | 30 fps | 60 fps | 120 fps | 60i | 120i |
| --- | --- | --- | --- | --- | --- |
| 1080p | ✅ | ✅ | ✅ | ✅ | ✅ |
| 1440p | ✅ | ✅ | ✅ | ✅ | ✅ |
| 4K | ✅ | ✅ | ✅ | ❌ | ❌ |

`1080p @ 120 fps interpolated` peaks at ~775 MB and renders fine. Only
**4K + interpolation** is refused here because it needs ~2.6 GB. On a 4 GB
host it is supported — the same Dockerfile, no code changes.

The server checks free RAM **before** every encode and refuses combinations it
can't finish, with a message telling the user what to pick instead. It never
serves a truncated MP4 (tmp-file → `ftyp` validation → atomic publish).

### API

```
GET  /api/health              renderer status, presets, machine profile
GET  /api/video?id=<yt-id>    live metadata (yt-dlp, demo fallback)
POST /api/render              {…cut state…} → {job}
GET  /api/render/<job>        {status: queued|rendering|done|error, …}
POST /api/render-sync         render and wait (handy for scripts/CI)
GET  /renders/<file>.mp4      finished render (Range/206 capable)
```

Example:

```bash
curl -s -X POST localhost:8000/api/render-sync -H 'Content-Type: application/json' -d '{
  "preset":"4k","aspect":"9:16","fps":30,"start":40,"end":46,
  "look":"vivid","intensity":60,"bpm":96,"zoom":12,
  "caption":"wait for the twist it changes everything",
  "card":"nobody talks about this part","cardOn":true,"capHi":"#ffe14d",
  "effects":[{"id":"punch","on":true},{"id":"pulse","on":true}]
}'
```

## Studio shortcuts

| Key | Action |
| --- | --- |
| `Space` | play / pause (loops inside the cut) |
| `I` / `O` | mark in / out |
| `←` `→` | step 1s (`Shift` = 5s) |
| `⌫` | trim the shorter side of the cut |
| `Ctrl/⌘ Z` / `Ctrl/⌘ ⇧ Z` | undo / redo |

## Notes & limits

- The editor plays the bundled 720p preview for smooth scrubbing; the renderer
  always encodes from the 1080p master. 1440p/4K are honest **Lanczos
  upscales** from that master — the UI labels them as such. Swap
  `media/source1080.mp4` for a higher-resolution clip of your own and those
  presets become true native renders with no code changes.
- Live YouTube metadata needs the host IP not to be bot-checked. If extraction
  fails the API returns demo metadata and the UI keeps working.
- Rendering arbitrary YouTube links server-side requires downloading that
  video; this build renders the bundled licensed reel. Only use content you
  own or that is licensed for reuse. Demo footage: *Big Buck Bunny* © Blender
  Foundation, CC-BY 3.0 (4K master via Wikimedia Commons).
- Not affiliated with YouTube.
