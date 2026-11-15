# DEVTRACER

**DEVTRACER** — made by **★NDX★** — is a zero-dependency Liquid Glass developer HUD with two fast workspaces:

1. **Subdomains** (powered by [`subdomain.app`](https://subdomain.app/)) — Queries `https://api.subdomain.app/v1/query?domain=...` across 5.4B+ indexed subdomains (up to 10,000 hosts per domain), automatically classifies **Dev / Staging / Preview**, **API & Auth**, and **CDN** hosts, sorts by Dev-First / Most Recently Seen / A–Z, verifies live A/CNAME DNS over HTTPS, exports TXT/JSON, and jumps straight into Site Inspector in one click.
2. **Site Inspector** — Parallel-racing multi-relay & Node crawler with progressive live rendering (~1–2s initial results + background JS bundle enrichment), CORS-native DNS-over-HTTPS enrichment, GitHub repository scanning, and `.har` / raw source analysis exposing hidden dev/staging domains and **95+ build stack technologies** with exact `file:line` evidence.

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
