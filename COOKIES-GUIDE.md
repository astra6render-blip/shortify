# Make real YouTube links work on Render

Render's IPs are bot-flagged by YouTube. A signed-in cookie jar fixes it —
YouTube then treats the download as a normal logged-in viewer.

Takes about 3 minutes.

---

## Step 1 — Get the cookies (on your own computer)

You need a browser where you're **signed in to YouTube**, and `yt-dlp`.

```bash
pip install -U yt-dlp
```

Then, with the browser **fully closed**, run:

```bash
yt-dlp --cookies-from-browser chrome --cookies yt.txt \
       "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --skip-download
```

Swap `chrome` for `firefox`, `edge`, `brave`, `safari` or `opera` to match yours.

> **"could not read cookies"** — the browser is still running. Quit it completely
> (check the system tray / Activity Monitor) and retry.

Now that file `yt.txt` holds your session. **Treat it like a password** — anyone
with it can act as your YouTube account. Use a throwaway Google account if you'd
rather not use your main one.

---

## Step 2 — Base64 it

```bash
base64 -w0 yt.txt
```

- macOS: `base64 -i yt.txt` (no line wrapping)
- Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("yt.txt"))`

You'll get one long line. Copy **all** of it.

---

## Step 3 — Add it in Render

1. Render dashboard → **shortify** service → **Environment**
2. **Add Environment Variable**
3. Key: `YT_COOKIES_B64`
4. Value: paste the base64 line
5. **Save Changes** → Render rebuilds automatically (~3 min)

---

## Step 4 — Verify

Open your site, paste any YouTube link. The analyzing badge should read
**LIVE LINK** rather than **LINK BLOCKED · DEMO**.

You can also check directly:

```bash
curl "https://shortify-qspt.onrender.com/api/video?id=dQw4w9WgXcQ"
```

- Working → `"demo": false` with the real title
- Not working → `"demo": true` and a note explaining why

The first call may return `{"pending": true}` — the server fetches in the
background. Ask again after a few seconds.

---

## Maintenance

Cookies expire in roughly **2–6 weeks**, or sooner if you log out or change your
Google password. When links start falling back to the demo reel, repeat steps
1–3.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `could not read cookies` | browser running | quit it completely, retry |
| `demo: true` after adding | stale cookies | rerun step 1 |
| `pending` forever | tiny instance is slow | retry; or upgrade off Free |
| Works, then stops in a month | cookies expired | rerun step 1 |
| Works for metadata, render fails | 512 MB free tier can't encode 1080p | upgrade to Standard (2 GB) |

---

## If you'd rather not use cookies

The Free plan is also too small for real work — 512 MB cannot encode 1080p
comfortably. For the same effort you could move to a host that isn't blocked
*and* has real RAM:

- **Oracle Cloud Always Free** — 4 OCPU / 24 GB, $0, works out of the box
- **Hetzner CX22** — ~€4/mo, 4 GB
- **Any VPS or home connection** — no cookies needed

See `deploy.md` for the Docker steps; the image is already built and pushed.
