# DEVTRACER — Advanced Site Inspector & Website Intelligence Platform

**made by ★NDX★**

A dark **Liquid Glass** website intelligence platform with a zero-dependency Node.js backend, isomorphic browser scanning engine (also deploys directly to static GitHub Pages), and server-side **AES-256-GCM encrypted API & Token Vault**.

> **Authorized Use Only:** DEVTRACER inspects only publicly accessible websites, DNS records, and endpoints or systems you are explicitly authorized to analyze.

---

## Core Modules

1. **Website Inspector**
   - Inspects publicly accessible websites (HTML, CSS, linked JS bundles, HTTP headers, `robots.txt`, `sitemap.xml`, DNS) and GitHub repositories.
   - Identifies **95+ technologies** across frameworks, bundlers, CSS systems, CMS/builders, hosting providers, CDNs, and analytics with version extraction and exact evidence.
   - Uncovers `dev.*`, `staging.*`, `beta.*`, `preview.*`, `*.vercel.app`, `*.netlify.app`, `*.pages.dev`, and non-production references with interactive SVG topology graphs.
   - Exports detailed reports in **JSON**, **CSV**, and **Markdown**.

2. **Domain Intelligence**
   - Discovers publicly indexed subdomains via `api.subdomain.app` (primary) with automatic CORS-native `api.domainee.dev` (live DNS + CT logs) and HackerTarget fallbacks so discovery works reliably both locally and on static GitHub Pages.
   - Categorizes discovered hosts across **7 environments**: `development`, `staging`, `beta`, `preview`, `api`, `cdn`, and `production`.
   - Integrated **Public DNS Records Inspector** (`A`, `AAAA`, `CNAME`, `MX`, `NS`, `TXT`, `SOA`).

3. **Source Code Analyzer**
   - Analyzes public HTML, CSS, JavaScript, and config artifacts for technology fingerprints, framework configurations, publicly referenced API endpoints (REST, GraphQL, WebSocket), and exposed configuration references.
   - **Zero Secret Collection Policy:** Sensitive secret values are automatically detected and redacted (`[REDACTED]`) — raw secrets from third-party websites are never collected or displayed.

4. **API Inspector**
   - Loads public **OpenAPI / Swagger** specifications and discovered site endpoints automatically.
   - Executes authorized HTTP requests (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`) showing live status codes, latency, response headers, and formatted JSON/raw payloads.
   - Attaches credentials stored in the server-side Vault without ever exposing secrets to the browser.

5. **API & Token Vault (Server-Side Encrypted)**
   - Dedicated credential manager supporting **Custom API Keys**, **GitHub PATs**, **Bearer Tokens**, **AI Provider API Keys**, and **Custom Integrations**.
   - Encrypted at rest with **AES-256-GCM** (`scryptSync` key derivation) in `.devtracer/vault.enc.json` (`0600`, gitignored).
   - Supports live endpoint connection testing, rotation, metadata editing, permanent deletion, and **ciphertext-wiping revocation**.
   - Masked previews only in the UI; secrets never appear in frontend code, localStorage, sessionStorage, or logs.

6. **Scan History & Dashboard**
   - Responsive dark/light Liquid Glass sidebar dashboard with global quick-scan bar, live scan progress bar, filtering, and local scan history archive.

---

## Quick Start

Requires **Node.js 20+** (zero npm dependencies).

```bash
# Optional: copy .env.example and set DEVTRACER_VAULT_KEY for custom master key derivation
cp .env.example .env

# Start DEVTRACER backend + Liquid Glass UI on http://0.0.0.0:3000
npm start
```

Run automated tests:

```bash
npm test
```

## Backend API Routes (`server.js`)

| Route | Method | Description |
|---|---|---|
| `/api/health` | `GET` | Health & Vault readiness status |
| `/api/scan` | `POST` | Deep SSRF-protected website crawl (HTML, bundles, headers, metadata) |
| `/api/github-scan` | `POST` | GitHub repository scanner (optional server-side Vault `credentialId`) |
| `/api/subdomains?domain=` | `GET` | Subdomain discovery (`api.subdomain.app` primary + `domainee.dev` fallback) |
| `/api/dns?domain=` | `GET` | Public DNS records (`A`, `AAAA`, `CNAME`, `MX`, `NS`, `TXT`, `SOA`) |
| `/api/inspect-endpoint` | `POST` | SSRF-hardened authorized API tester with server-side Vault injection |
| `/api/credentials` | `GET`, `POST` | List masked credentials / create encrypted credential |
| `/api/credentials/:id` | `PUT`, `DELETE` | Update metadata or rotate secret / permanently delete |
| `/api/credentials/:id/revoke` | `POST` | Revoke credential and wipe encrypted ciphertext |
| `/api/credentials/:id/test` | `POST` | Server-side live connection test using decrypted credential |

## Static GitHub Pages Deployment

The frontend deploys automatically via `.github/workflows/pages.yml`. On static GitHub Pages:
- Website Inspector, Domain Intelligence (`subdomain.app` + CORS-native `api.domainee.dev` + Google DoH), Source Code Analyzer, and public CORS API Inspector run directly in the browser.
- API & Token Vault strictly enforces server-only storage (no secrets are ever persisted in browser storage on static sites).
- Optionally deploy `worker/cloudflare-worker.js` to Cloudflare Workers for dedicated proxy headers and rate-limit-free `subdomain.app` lookups.
