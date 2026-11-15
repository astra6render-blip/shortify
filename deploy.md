# Deploy Shortify to your own domain (e.g. `shortify.com`)

This app is a **single Python process** (`server.py`) that serves the static
site, the metadata API and the ffmpeg renderer. Any host that can run a
container or a Python process works.

---

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
