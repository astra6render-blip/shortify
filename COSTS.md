# What it costs to put Shortify on a .com

Checked against the live registry (RDAP) and public price pages on **2026-11-15**.

---

## 1. The domain

### `shortify.com` is not for sale

| Field | Value |
| --- | --- |
| Registered | **2005-05-17** |
| Expires | **2029-03-04** |
| Registrar | Namecheap |
| Nameservers | Cloudflare |
| Current content | Cloudflare "Just a moment…" 403 — parked / protected |

The owner has **2 years and 4 months** of registration left. Domains like this
trade for **$2,000–$15,000+** when the owner will sell at all, and there is no
way to force it. Assume **no**.

### .com names that ARE free right now

Verified against Verisign's registry (HTTP 404 = unregistered):

| Domain | Status |
| --- | --- |
| **shortifyvideo.com** | ✅ available |
| **shortifycut.com** | ✅ available |
| **useshortify.com** | ✅ available |
| **tryshortify.com** | ✅ available |
| **clipshortify.com** | ✅ available |

Already taken: `shortify.com`, `getshortify.com`, `shortifyapp.com`,
`shortifyai.com`, `shortifystudio.com`, `shortify.net`, `shortify.app`,
`shortify.pro`, `shortify.xyz`, `shortify.online`.

### Other endings (not .com, but short and free)

| Domain | Note |
| --- | --- |
| **shortify.io** | ✅ available — best premium-feeling alternative |
| **shortify.co** | ✅ available |
| **shortify.video** | ✅ available — describes the product exactly |
| **shortify.studio** | ✅ available |
| shortify.tools / shortify.gg / getshortify.net | ✅ available |

`.io` and `.co` run roughly **$30–60/year** — more than a `.com`, so verify at
checkout.

### What a .com actually costs per year

Verisign raised the wholesale `.com` fee to **$10.97** on 2026-11-01, so expect
~$11 now.

| Registrar | First year | Renewal | 5-year total |
| --- | --- | --- | --- |
| **Cloudflare Registrar** | ~$10.44 | ~$10.44 (at cost) | **~$52** |
| **Porkbun** | $11.08 | $11.08 (flat) | **~$55** |
| Namecheap | $6.79 + $0.20 | **$18.48** + $0.20 | ~$82 |

> **Pick Porkbun** for simplicity (flat price, free WHOIS privacy, free SSL) or
> **Cloudflare** for the lowest cost — but Cloudflare requires you to move DNS
> there too, which you may want anyway.
>
> **Avoid GoDaddy.** $1–2 first year, then ~$22 renewal plus a paid WHOIS
> privacy upsell — roughly $120 over five years for the same domain.

**Verdict: ~$11 for year one, ~$11 every year after.**

---

## 2. The hosting

The renderer needs **~775 MB RAM** for 1080p at 120fps, and **4K needs 2.6 GB+**
with interpolation. That rules out the cheap tiers.

### Render (what you connected)

| Plan | RAM | vCPU | Price/mo | What actually works |
| --- | --- | --- | --- | --- |
| Free | 512 MB | 0.1 | $0 | ❌ nothing — under the RAM floor, sleeps after 15 min |
| Starter | 512 MB | 0.5 | $7 | ❌ nothing |
| **Standard** | **2 GB** | 1 | **$25** | ✅ 1080p & 1440p all fps · 4K up to 60fps · ❌ 4K+interpolation |
| **Pro** | **4 GB** | 2 | **$85** | ✅ **everything including 4K@120 interpolated** |

Bandwidth: 100 GB/mo included on paid plans, then $0.15/GB. A workspace plan
(Hobby $0) is fine for one person.

### The alternatives, same job

| Host | RAM | Price | 4K@120? |
| --- | --- | --- | --- |
| **Hugging Face Spaces** | **16 GB / 2 vCPU** | **$0** | ✅ yes — free, no card |
| Hetzner CX22 VPS | 4 GB / 2 vCPU | ~€4/mo (~$4.30) | ✅ yes |
| Railway Hobby | usage-based | ~$5/mo + usage | ✅ |

---

## 3. Real yearly totals

| Setup | Year 1 | Year 2+ | Works? |
| --- | --- | --- | --- |
| **HF Spaces (free) + .com** | **~$11** | ~$11 | ✅ full 18/18 incl. 4K@120 |
| **Hetzner VPS + .com** | ~$63 | ~$63 | ✅ full, fastest, own domain |
| Render Standard + .com | ~$311 | ~$311 | ⚠️ no 4K interpolation |
| Render Pro + .com | ~$1,031 | ~$1,031 | ✅ full — expensive |

### Recommendation

**HF Spaces + `shortifyvideo.com` ≈ $11/year total.** Zero hosting cost, 16 GB
RAM handles every combination, and the domain is the only real expense.

If you want a proper production setup, **Hetzner CX22 + the .com ≈ $63/year** —
roughly 1/5 the price of Render Pro for the same capability and better
performance.

Render Pro at **$85/mo ($1,020/yr)** only makes sense if you want managed
infrastructure and no server maintenance. For a single app, it's the most
expensive way to run this.

---

## 4. Order of operations

1. Buy the domain at Porkbun or Cloudflare — **~$11**. (Needs your card.)
2. Deploy to HF Spaces — **free**, one command: `HF_TOKEN=hf_xxx ./deploy-hf.sh`
3. Point the domain's `CNAME` at the host, add it in the host's dashboard so TLS
   is issued automatically.
4. Swap the placeholder domain in the repo:
   ```bash
   grep -rl "shortify.com" index.html robots.txt sitemap.xml \
     | xargs sed -i 's/shortify\.com/yourdomain.com/g'
   ```
5. Submit `sitemap.xml` to Google Search Console and Bing Webmaster Tools.
6. Ranking takes days to weeks — nothing in the code can force it faster.
