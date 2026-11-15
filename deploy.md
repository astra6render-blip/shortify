# Deploying Shortify

The app is written. The repo is live at
**https://github.com/astra6render-blip/shortify** (public, Docker-ready).

What remains is account-side work that only you can do: adding a payment card and
buying a domain. Everything that can be automated already has been.

---

## Status right now

| Step | State |
| --- | --- |
| Code complete (1080p→4K, 30/60/120 fps, real ffmpeg) | ✅ done |
| GitHub repo pushed and public | ✅ done |
| `Dockerfile`, `render.yaml`, ENV-configurable `PORT` | ✅ done |
| Render workspace provisioned | ⛔ blocked — card required |
| Domain purchased | ⛔ blocked — needs payment |

---

## Option A — Render (needs a card on file)

Render refused every resource on the `astra6render` workspace with
`Payment information is required`, including free-tier static sites.

1. Add a card: <https://dashboard.render.com/billing>
2. Blueprints → **New Blueprint Instance** → pick `astra6render-blip/shortify`
   Render reads `render.yaml` and creates the service (Docker, healthcheck,
   `/api/health`, 1 GB disk for renders).
3. Wait for the build (~3–5 min; the image installs ffmpeg).
4. Your URL is `https://shortify.onrender.com`.

> Free plan = 512 MB RAM, spins down after 15 min idle. That is below what the
> renderer needs for 1080p/120fps (~775 MB). Use **Starter (2 GB)** or larger for
> real rendering; the app detects the RAM and disables combos it cannot finish
> instead of failing.

## Option B — Hugging Face Spaces (free, **no card**)

This repo already carries the required front-matter (`sdk: docker`,
`app_port: 7860`).

1. Create a token: <https://huggingface.co/settings/tokens> (write scope)
2. Then:
   ```bash
   HF_TOKEN=hf_xxx ./deploy-hf.sh
   ```
3. The Space builds from the Dockerfile and serves at
   `https://<user>-shortify.hf.space`.

Free Spaces give 16 GB RAM / 2 vCPU — enough for **every** combination including
4K at 120 fps with interpolation. It sleeps after 48 h idle.

## Option C — Your own VPS (best performance per dollar)

```bash
git clone https://github.com/astra6render-blip/shortify.git
cd shortify
docker build -t shortify .
docker run -d --name shortify -p 80:8000 -v "$PWD/renders:/app/renders" \
  --restart unless-stopped shortify
```

Hetzner CX22 (~€4/mo, 2 vCPU / 4 GB) handles 4K/60 and 1080p/120 interpolated.

---

## Making it findable on the web

1. Buy the domain. **`shortify.com` is already taken** — check
   `shortify.app`, `shortify.studio`, `shortify.video`, `getshortify.com`.
2. Point a `CNAME` record (or an `A` record for a VPS) at the host.
3. Add the domain in the host's dashboard so TLS is issued.
4. Replace the placeholder domain everywhere:
   ```bash
   grep -rl "shortify.com" index.html robots.txt sitemap.xml deploy.md \
     | xargs sed -i 's/shortify\.com/yourdomain.com/g'
   git commit -am "Use the real domain" && git push
   ```
5. Submit the sitemap:
   - Google: <https://search.google.com/search-console> → Sitemaps → `sitemap.xml`
   - Bing: <https://www.bing.com/webmasters> → same
6. Expect **days to weeks** before the site ranks. The structured data
   (`WebApplication` + `FAQPage` JSON-LD) makes it eligible for rich results,
   but indexing is Google's decision, not something the code can force.


---

## Reference

## 1. Buy the domain
Register `shortify.com` (or any name) at Cloudflare Registrar, Namecheap,
Porkbun or Google Domains. Nothing in the code depends on the TLD — the only
things that need editing are the canonical/OG URLs in `index.html`,
`robots.txt` and `sitemap.xml`.

```bash
# after buying, replace the placeholder domain everywhere:
grep -rl "shortify.com" index.html robots.txt sitemap.xml deploy.md \
  | xargs sed -i 's/shortify\.com/yourdomain.com/g'
```

Placeholders to update: `<title>`, meta description, canonical, Open Graph,
Twitter card, JSON-LD `url`, `robots.txt` sitemap line, `sitemap.xml` URLs.

---

## 2. Pick a host (all support custom domains + free TLS)

| Host | How | Notes |
| --- | --- | --- |
| **Railway** | New Project → Deploy from repo → it reads the `Dockerfile` | add domain in Settings → Networking |
| **Render** | New → Web Service → Docker → connect repo | free TLS, auto-deploy |
| **Fly.io** | `fly launch --dockerfile Dockerfile` then `fly deploy` | add `[http_service]` + `fly certs add yourdomain.com` |
| **VPS** (Hetzner / DO / Lightsail) | `docker run -d -p 80:8000 shortify` + Caddy/nginx in front | most ffmpeg CPU headroom |

The container already installs **ffmpeg** and DejaVu fonts, so renders work
out of the box:

```bash
docker build -t shortify .
docker run -d --name shortify -p 8000:8000 \
  -v "$PWD/renders:/app/renders" \
  --restart unless-stopped shortify
```

---

## 3. Point DNS at it

| Host | DNS record |
| --- | --- |
| Railway | `CNAME @ → <service>.up.railway.app` |
| Render | `CNAME @ → <service>.onrender.com` |
| Fly.io | `A` / `AAAA` from `fly ips list`, then `fly certs add yourdomain.com` |
| VPS | `A @ → <server ip>`, `A www → <server ip>` |

Then in your host panel add the custom domain and let it issue the TLS
certificate (Let's Encrypt). Verify:

```bash
curl -sI https://yourdomain.com | head -3        # 200 + text/html
curl -s  https://yourdomain.com/api/health        # {"ok":true,...}
```

---

## 4. Make it findable (SEO)

Already included:

- descriptive `<title>` + meta description + keywords
- canonical URL, Open Graph and Twitter card tags (rich link previews)
- **JSON-LD structured data** (`WebApplication` + `FAQPage`) → eligible for
  rich results in Google
- `robots.txt` (allows the site, blocks `/api/` and `/renders/`)
- `sitemap.xml`

After going live:

1. Add the domain to **Google Search Console** → submit
   `https://yourdomain.com/sitemap.xml`.
2. Do the same in **Bing Webmaster Tools**.
3. Check `https://search.google.com/test/rich-results` with your URL — the
   FAQ block should be detected.
4. Share the URL once on each platform so Open Graph previews get cached.

> Search engines can take days to weeks to index a new domain. Submitting the
> sitemap is the fastest legitimate way in; there is no instant "rank #1".

---

## 5. Hardware for 4K / 120 fps

Renders are CPU-bound (libx264). Measured here on a 2 vCPU / 2 GB sandbox:

| Combo | Peak RAM | 4s cut @ 2 vCPU |
| --- | --- | --- |
| 1080p · 30/60/120 fps | ~170 MB | 1.5–2 s |
| 1080p · 120 fps interpolated | ~775 MB | ~14 s |
| 1440p · 30/60/120 fps | ~260 MB | 2–3 s |
| 4K · 30/60 fps | ~775 MB | 4–6 s |
| 4K · 120 fps interpolated | ~2.6 GB | ~45 s |

**Recommended host for the full matrix** (4K + 120 fps + interpolation):
**4 vCPU / 4 GB RAM** minimum, 8 GB comfortable. On Render/Railway that's the
"Standard" tier; on Hetzner a CX22/CPX21 is plenty.

The server **checks free RAM before every encode** and refuses combinations
that would be OOM-killed, with a message telling the user what to pick instead.
It never serves a truncated MP4.

## 6. Render limits to know

- A **2 GB RAM** box can do 1080p/60 comfortably; **4K/120 with interpolation**
  wants **4 GB+** and several cores. The renderer already lowers thread counts
  and presets on small machines, and refuses to publish truncated files.
- Renders are stored in `renders/` and swept after one hour.
- Rendering a **real YouTube link** requires the host to download that video.
  Datacenter IPs are often bot-checked by YouTube — if so, the API returns a
  clear error and the bundled 1080p master still renders. Use only content you
  own or that is licensed for reuse.

---

## 7. Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | HTTP port |
| `SHORTIFY_SOURCE_CACHE` | `renders/.sources` | where downloaded link sources are cached |

---

## Why real YouTube links fail on some hosts

`yt-dlp` downloads the video server-side. YouTube increasingly refuses cloud
IP ranges, so a link that works on your laptop can fail on a hosting provider.

**Measured on 2026-11-15:**

| Where | YouTube metadata | Download |
| --- | --- | --- |
| Google Cloud (this dev sandbox) | ✅ works | ✅ works |
| Render, **Singapore** region | ❌ blocked | ❌ blocked |
| Home connection / normal VPS | ✅ works | ✅ works |

It is not "all datacenters" — it is per-provider and per-region IP reputation.

### Three ways to fix it

1. **Move the service to another region.** Render → Settings → Region. Try
   Frankfurt or Oregon before assuming it's hopeless; Singapore egress is
   heavily used by scrapers.
2. **Supply cookies** (works even on blocked IPs). On your machine:
   ```bash
   yt-dlp --cookies-from-browser chrome --cookies yt.txt \
          "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --skip-download
   base64 -w0 yt.txt
   ```
   Then in Render → Environment → add `YT_COOKIES_B64` with that base64 string
   (or mount the file and set `YT_COOKIES=/path/yt.txt`). Rebuild.
   Cookies expire after a few weeks — refresh them when uploads start failing.
3. **Self-host** on a home connection or a VPS with residential-grade egress.
   Everything works with no extra configuration.

The UI never lies about it: if the server cannot read the link, you get a warning
toast, the analyzing badge reads **"LINK BLOCKED · DEMO"**, and the export source
row says so too.
