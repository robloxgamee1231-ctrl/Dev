# DevTrace

Source-code intelligence studio that inspects live websites, JavaScript bundles, HTTP headers, manifests, HAR captures, and GitHub repositories to uncover **dev/staging/preview domains**, **embedded endpoints**, and **complete build stacks** with exact file-and-line evidence.

## Capabilities

- **Dev, Staging & Preview Radar** — Hunts through HTML, linked JS chunks, CSS, `__NEXT_DATA__`, `Content-Security-Policy` headers, `robots.txt`, `sitemap.xml`, `CNAME`, and CI workflows to uncover `dev.*`, `staging.*`, `qa.*`, `uat.*`, `*.vercel.app`, `*.netlify.app`, `*.pages.dev`, `*.workers.dev`, `*.fly.dev`, `*.onrender.com`, tunnels, exposed localhost ports, and source maps.
- **Noise-Filtered Domain Extraction** — Extracts full URLs, protocol-relative assets, quoted hostnames, WebSocket endpoints, and config keys while rejecting JavaScript property chains (`window.location`, `document.body`) and file extensions. Groups by hostname and apex domain (`eTLD+1`).
- **95+ Build Stack Fingerprints** — Detects meta-frameworks, UI frameworks, bundlers (Vite, Webpack, Turbopack, Rspack, Rollup, Parcel, esbuild), styling systems, CMS/site builders, edge/hosting providers, languages, package managers, auth/DB SDKs, analytics, and versions with exact proof.
- **Interactive Topology Map & Code Search** — Visualizes discovered environments and domains in a clickable SVG graph, includes a slide-over evidence inspector, cross-file code search, local scan history, and one-click JSON / CSV / Markdown export.
- **Works Everywhere** — Zero-build ES modules at the repository root run directly on **GitHub Pages**, or via the zero-dependency Node.js server (`npm start`) for SSRF-protected server-side crawling with full HTTP headers.

## Quick Start

### 1. Run Locally (Full Node.js Deep Crawler)

Requires Node.js 20+. Zero external dependencies.

```bash
npm start
# Open http://localhost:3000
```

Run automated tests:

```bash
npm test
```

### 2. Deploy on GitHub Pages

Two zero-config options:

- **GitHub Actions (included):** Push or merge to `main`, then open **Repository Settings → Pages → Source: GitHub Actions**. The included `.github/workflows/pages.yml` publishes the static site automatically.
- **Branch Deploy:** Set **Settings → Pages → Deploy from a branch** (`main` / `/ (root)`).

### 3. Optional Cloudflare Worker Proxy (Full Headers on GitHub Pages)

On GitHub Pages, GitHub Repo scans and Raw Code / HAR scans run natively in the browser, while Website URL scans fall back to browser relays. To unlock full HTTP response headers (`Server`, `X-Vercel-Id`, `Content-Security-Policy`) and deeper JS bundle crawling on GitHub Pages:

1. Deploy `worker/cloudflare-worker.js` to Cloudflare Workers (free tier).
2. Open DevTrace → **Options** → paste your Worker URL into **Custom Worker Proxy URL**.

## Repository Layout

```text
index.html                   # SPA entry (relative paths, GitHub Pages ready)
styles/main.css              # Dark obsidian & light paper technical theme
src/engine/
  tlds.js                    # TLD validation, eTLD+1 grouping, JS noise filter
  domains.js                 # Domain/URL/dev-site extractor & classifier
  signatures.js              # 95+ technology & build-tool signatures
  stack.js                   # Multi-signal build stack fingerprinter
  analyzer.js                # Isomorphic report orchestrator
  github.js                  # GitHub REST API source & config scanner
  sample.js                  # Built-in multi-environment demo fixture
src/ui/
  scanner.js                 # Transport router (Server → Worker/Relay → GitHub → Local/HAR)
  graph.js                   # Interactive SVG domain & environment topology graph
  export.js                  # JSON, CSV & Markdown exporters
  app.js                     # UI controller, evidence drawer, code search, history
server.js                    # Zero-dep Node HTTP server + SSRF-safe /api/scan crawler
worker/cloudflare-worker.js  # Optional edge proxy for static GitHub Pages deployments
tests/engine.test.js         # Unit & end-to-end HTTP crawler tests (node:test)
.github/workflows/pages.yml  # GitHub Pages deployment workflow
```
