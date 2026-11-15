# DevTrace

Z.ai-inspired monochrome developer HUD combining three single-tab workspaces in one zero-build site (ready for GitHub Pages and local Node.js self-hosting):

1. **Temp Mail** (`https://throwawaymail.app/api/docs`) — Instant 10-minute disposable inbox (`POST /api/mailboxes`), live countdown timer, 5-second auto-refresh, mailbox UUID restore, automatic verification/OTP code extraction, and sandboxed HTML email preview.
2. **Subdomains** (`https://api.subdomain.app/v1/query`) — Enumerates up to 10,000 known subdomains (~15s lookup with live elapsed timer), automatically separates dev/staging/QA/API/CDN hosts, exports TXT/JSON, and jumps straight into Site Inspector with one click.
3. **Site Inspector** — Crawls live website HTML, JS bundles, CSS, HTTP headers, manifests, GitHub repositories, and dropped raw code / `.har` captures to find dev/staging/preview domains and fingerprint 95+ build stack technologies with exact `file:line` evidence.

## Quick Start

### Local Node.js Server (Zero Dependencies)

```bash
npm start
# Open http://localhost:3000
```

Run tests:

```bash
npm test
```

### GitHub Pages Deployment

Push or merge to `main` — `.github/workflows/pages.yml` deploys the static site automatically. For CORS-free live headers, Temp Mail, and Subdomains queries from GitHub Pages, deploy `worker/cloudflare-worker.js` to Cloudflare Workers (free tier) and set its URL in **Site Inspector → Options → Custom Worker Proxy URL**.
