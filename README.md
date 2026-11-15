# DevTrace

**DevTrace** is a zero-dependency Liquid Glass developer HUD with two focused workspaces:

1. **Subdomains** (powered by [`subdomain.app`](https://subdomain.app/)) — Queries `https://api.subdomain.app/v1/query?domain=...` across 5.4B+ indexed subdomains (up to 10,000 hosts per domain), automatically classifies **Dev / Staging / Preview**, **API & Auth**, and **CDN** hosts, sorts by Dev-First / Most Recently Seen / A–Z, verifies live A/CNAME DNS over HTTPS, exports TXT/JSON, and jumps straight into Site Inspector in one click.
2. **Site Inspector** — Crawls live websites (HTML, linked JS bundles, CSS, DNS-over-HTTPS, HTTP headers), GitHub repositories, and pasted raw source / `.har` captures to expose hidden dev/staging/preview domains and fingerprint **95+ build stack technologies** with exact `file:line` evidence and an interactive topology graph.

## Live Site (GitHub Pages)

- **Production HUD**: `https://robloxgamee1231-ctrl.github.io/Dev/`

## Run Locally (Node >= 20, zero npm dependencies)

```bash
npm start
# Listening on http://0.0.0.0:3000
```

Run automated tests:

```bash
npm test
```

## Optional Cloudflare Worker Proxy

Both tabs work directly on static GitHub Pages. For dedicated zero-rate-limit `api.subdomain.app` lookups and raw HTTP response headers in Site Inspector on GitHub Pages, deploy `worker/cloudflare-worker.js` to Cloudflare Workers and paste its URL under **Site Inspector → Options → Custom Worker Proxy URL**.
