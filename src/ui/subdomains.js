// Subdomains HUD Module — 100% powered by https://subdomain.app
// Endpoint: GET https://api.subdomain.app/v1/query?domain=<root-domain>
// Up to 10,000 subdomains per domain, most recently seen first, from 5.4B+ indexed hosts.

import { classifyHost } from '../engine/domains.js';
import { getApexDomain } from '../engine/tlds.js';
import { triggerDownload } from './export.js';

const SUBDOMAIN_API_BASE = 'https://api.subdomain.app/v1/query';
const RECENT_STORAGE_KEY = 'devtrace_subdomain_recent_v1';
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeRootDomain(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '');
  s = s.split(/[/?#]/)[0];
  s = s.split(':')[0];
  s = s.replace(/^www\./i, '').replace(/\.+$/, '');
  if (!DOMAIN_RE.test(s)) return '';
  return getApexDomain(s) || s;
}

export function classifySubdomainList(domain, subdomains, { sort = 'dev-first' } = {}) {
  const apex = getApexDomain(domain) || domain;
  const seen = new Set();
  const rows = [];

  (subdomains || []).forEach((rawHost, idx) => {
    const clean = String(rawHost || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.+$/, '');
    if (!clean || seen.has(clean)) return;
    if (!(clean === apex || clean.endsWith('.' + apex)) || !DOMAIN_RE.test(clean)) return;
    seen.add(clean);

    const c = classifyHost(clean, { targetHost: domain, targetApex: apex });
    let bucket = 'other';
    if (c.isDevSurface) bucket = 'dev';
    else if (c.category === 'api') bucket = 'api';
    else if (c.category === 'cdn') bucket = 'cdn';

    rows.push({
      host: clean,
      recentIndex: idx,
      bucket,
      envTag: c.isDevSurface ? c.envTag : c.category,
      isDevSurface: c.isDevSurface,
      reasons: c.reasons,
      priority: c.priority
    });
  });

  sortRows(rows, sort);

  return {
    domain,
    rows,
    counts: {
      dev: rows.filter((r) => r.bucket === 'dev').length,
      api: rows.filter((r) => r.bucket === 'api').length,
      cdn: rows.filter((r) => r.bucket === 'cdn').length,
      other: rows.filter((r) => r.bucket === 'other').length
    }
  };
}

export function sortRows(rows, sort = 'dev-first') {
  const bucketRank = { dev: 0, api: 1, cdn: 2, other: 3 };
  if (sort === 'recent') {
    rows.sort((a, b) => a.recentIndex - b.recentIndex);
  } else if (sort === 'alpha') {
    rows.sort((a, b) => a.host.localeCompare(b.host));
  } else {
    rows.sort((a, b) => {
      if (bucketRank[a.bucket] !== bucketRank[b.bucket]) return bucketRank[a.bucket] - bucketRank[b.bucket];
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.recentIndex - b.recentIndex;
    });
  }
  return rows;
}

function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseSubdomainAppPayload(raw, fallbackDomain) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.subdomains)) {
    throw new Error('Invalid subdomain.app JSON response.');
  }
  return {
    domain: raw.domain || fallbackDomain,
    count: typeof raw.count === 'number' ? raw.count : raw.subdomains.length,
    total: typeof raw.total === 'number' ? raw.total : raw.subdomains.length,
    subdomains: raw.subdomains
  };
}

async function resolveDnsDoH(host) {
  const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, {
    headers: { Accept: 'application/dns-json' },
    signal: AbortSignal.timeout(7_000)
  });
  if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
  const data = await res.json();
  const answers = Array.isArray(data?.Answer) ? data.Answer : [];
  const ips = answers.filter((a) => a.type === 1).map((a) => a.data);
  const cnames = answers.filter((a) => a.type === 5).map((a) => String(a.data).replace(/\.$/, ''));
  return {
    alive: data.Status === 0 && (ips.length > 0 || cnames.length > 0),
    ips: ips.slice(0, 3),
    cname: cnames[0] || ''
  };
}

export function createSubdomainsController({ container, getContext, copyText, showToast, onInspectHost }) {
  const state = {
    input: '',
    loading: false,
    statusLabel: '',
    elapsedSec: 0,
    error: '',
    filter: 'all',
    sort: 'dev-first', // 'dev-first' | 'recent' | 'alpha'
    search: '',
    pageLimit: 150,
    result: null, // { domain, count, total, rows, counts, durationSec, transportLabel }
    recentDomains: [],
    dnsStatus: new Map(),
    verifyingDns: false
  };

  let elapsedTimer = null;

  function loadRecent() {
    try {
      const saved = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || '[]');
      if (Array.isArray(saved)) state.recentDomains = saved.slice(0, 6);
    } catch {}
  }

  function pushRecent(domain) {
    state.recentDomains = [domain, ...state.recentDomains.filter((d) => d !== domain)].slice(0, 6);
    try {
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(state.recentDomains));
    } catch {}
  }

  function stopElapsedTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  function updateStage(label) {
    state.statusLabel = label;
    const el = container.querySelector('#subElapsedText');
    if (el) {
      el.textContent = `${String(state.elapsedSec).padStart(2, '0')}s · ${label}`;
    }
  }

  // Strictly queries https://api.subdomain.app/v1/query?domain=<domain>
  async function querySubdomainApp(domain) {
    const ctx = getContext();
    const targetUrl = `${SUBDOMAIN_API_BASE}?domain=${encodeURIComponent(domain)}`;
    const encoded = encodeURIComponent(targetUrl);

    // 1. Custom Cloudflare Worker (if user configured one)
    if (ctx.workerUrl && /^https?:\/\//i.test(ctx.workerUrl)) {
      try {
        updateStage(`Querying subdomain.app via Worker for ${domain}…`);
        const base = ctx.workerUrl.replace(/\/+$/, '');
        const res = await fetch(`${base}?url=${encoded}`, { signal: AbortSignal.timeout(45_000) });
        const wrapper = await res.json();
        if (!wrapper.error && wrapper.status < 400 && wrapper.body) {
          return {
            ...parseSubdomainAppPayload(JSON.parse(wrapper.body), domain),
            transportLabel: 'subdomain.app · Worker'
          };
        }
      } catch {}
    }

    // 2. Local Node server proxy (/api/subdomains -> api.subdomain.app/v1/query)
    if (ctx.serverAvailable) {
      try {
        updateStage(`Querying api.subdomain.app for ${domain}…`);
        const res = await fetch(`./api/subdomains?domain=${encodeURIComponent(domain)}`, {
          signal: AbortSignal.timeout(45_000)
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data && Array.isArray(data.subdomains)) {
          return {
            ...parseSubdomainAppPayload(data, domain),
            transportLabel: 'subdomain.app · Server'
          };
        }
      } catch {}
    }

    // 3. Direct browser fetch to api.subdomain.app (simple CORS GET, no preflight headers)
    try {
      updateStage(`Querying api.subdomain.app directly for ${domain}…`);
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(30_000) });
      const data = await res.json().catch(() => null);
      if (res.ok && data && Array.isArray(data.subdomains)) {
        return {
          ...parseSubdomainAppPayload(data, domain),
          transportLabel: 'subdomain.app · Direct'
        };
      }
    } catch {
      // Fall through to parallel CORS relay race to api.subdomain.app
    }

    // 4. Parallel race across public CORS relays — all querying https://api.subdomain.app/v1/query
    updateStage(`Querying api.subdomain.app via fast browser relays for ${domain}…`);

    const relayFetchers = [
      async () => {
        const r = await fetch(`https://corsproxy.io/?url=${encoded}`, { signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`corsproxy ${r.status}`);
        return {
          ...parseSubdomainAppPayload(await r.json(), domain),
          transportLabel: 'subdomain.app · Relay'
        };
      },
      async () => {
        const r = await fetch(`https://api.allorigins.win/raw?url=${encoded}`, { signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`allorigins-raw ${r.status}`);
        return {
          ...parseSubdomainAppPayload(await r.json(), domain),
          transportLabel: 'subdomain.app · Relay'
        };
      },
      async () => {
        const r = await fetch(`https://api.allorigins.win/get?url=${encoded}`, { signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`allorigins-get ${r.status}`);
        const wrap = await r.json();
        if (typeof wrap?.contents !== 'string') throw new Error('empty allorigins wrapper');
        return {
          ...parseSubdomainAppPayload(JSON.parse(wrap.contents), domain),
          transportLabel: 'subdomain.app · Relay'
        };
      },
      async () => {
        const r = await fetch(`https://cors.lol/?url=${encoded}`, { signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`cors.lol ${r.status}`);
        return {
          ...parseSubdomainAppPayload(await r.json(), domain),
          transportLabel: 'subdomain.app · Relay'
        };
      },
      async () => {
        const r = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encoded}`, { signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`codetabs ${r.status}`);
        return {
          ...parseSubdomainAppPayload(await r.json(), domain),
          transportLabel: 'subdomain.app · Relay'
        };
      }
    ];

    try {
      return await Promise.any(relayFetchers.map((fn) => fn()));
    } catch {
      throw new Error(
        `Could not reach api.subdomain.app from this browser right now. Retry in a moment, deploy the optional Cloudflare Worker under Proxy, or run npm start locally.`
      );
    }
  }

  async function runLookup(rawInput) {
    if (state.loading) return;
    const domain = normalizeRootDomain(rawInput);
    if (!domain) {
      state.error = 'Enter a valid root domain like github.com, vercel.com, or stripe.com.';
      render();
      return;
    }

    state.input = domain;
    state.loading = true;
    state.elapsedSec = 0;
    state.statusLabel = `Querying api.subdomain.app for ${domain}…`;
    state.error = '';
    state.filter = 'all';
    state.search = '';
    state.pageLimit = 150;
    state.dnsStatus.clear();
    const started = Date.now();
    render();

    stopElapsedTimer();
    elapsedTimer = setInterval(() => {
      state.elapsedSec = Math.floor((Date.now() - started) / 1000);
      const timerEl = container.querySelector('#subElapsedText');
      const fillEl = container.querySelector('#subProgressFill');
      if (timerEl) {
        timerEl.textContent = `${String(state.elapsedSec).padStart(2, '0')}s · ${state.statusLabel}`;
      }
      if (fillEl) {
        const pct = Math.min(94, Math.round((1 - Math.exp(-state.elapsedSec / 6)) * 100));
        fillEl.style.width = `${Math.max(12, pct)}%`;
      }
    }, 400);

    try {
      const apiData = await querySubdomainApp(domain);
      const classified = classifySubdomainList(apiData.domain, apiData.subdomains, { sort: state.sort });
      const durationSec = ((Date.now() - started) / 1000).toFixed(1);

      state.result = {
        domain: apiData.domain,
        count: classified.rows.length,
        total: Math.max(apiData.total || 0, classified.rows.length),
        rows: classified.rows,
        counts: classified.counts,
        durationSec,
        transportLabel: apiData.transportLabel
      };
      pushRecent(apiData.domain);
      showToast(`subdomain.app returned ${state.result.count.toLocaleString()} subdomains for ${apiData.domain}`);
    } catch (err) {
      state.error = err?.message || 'Subdomain lookup failed.';
    } finally {
      stopElapsedTimer();
      state.loading = false;
      render();
    }
  }

  async function verifyHostDns(host) {
    state.dnsStatus.set(host, { state: 'loading', detail: 'Checking…' });
    render();
    try {
      const res = await resolveDnsDoH(host);
      state.dnsStatus.set(
        host,
        res.alive
          ? { state: 'alive', detail: res.cname ? `CNAME → ${res.cname}` : res.ips.join(', ') }
          : { state: 'dead', detail: 'No A/CNAME record' }
      );
    } catch {
      state.dnsStatus.set(host, { state: 'dead', detail: 'DNS error' });
    }
    render();
  }

  async function verifyTopDevDns() {
    if (!state.result || state.verifyingDns) return;
    const targets = state.result.rows.filter((r) => r.bucket === 'dev').slice(0, 10);
    if (targets.length === 0) return showToast('No dev/staging hosts to verify');
    state.verifyingDns = true;
    for (const t of targets) state.dnsStatus.set(t.host, { state: 'loading', detail: 'Checking…' });
    render();
    await Promise.all(
      targets.map(async (t) => {
        try {
          const res = await resolveDnsDoH(t.host);
          state.dnsStatus.set(
            t.host,
            res.alive
              ? { state: 'alive', detail: res.cname ? `CNAME → ${res.cname}` : res.ips[0] }
              : { state: 'dead', detail: 'NXDOMAIN / Inactive' }
          );
        } catch {
          state.dnsStatus.set(t.host, { state: 'dead', detail: 'Error' });
        }
      })
    );
    state.verifyingDns = false;
    showToast(`Verified DNS for ${targets.length} dev/staging hosts`);
    render();
  }

  function getFilteredRows() {
    if (!state.result) return [];
    const q = state.search.trim().toLowerCase();
    return state.result.rows.filter((r) => {
      if (state.filter !== 'all' && r.bucket !== state.filter) return false;
      if (q && !r.host.includes(q)) return false;
      return true;
    });
  }

  function render() {
    const r = state.result;
    const filtered = getFilteredRows();
    const visible = filtered.slice(0, state.pageLimit);

    container.innerHTML = `
      <div class="zai-hero">
        <a href="https://subdomain.app/" target="_blank" rel="noopener noreferrer" class="hero-kicker glass-pill-link">
          <span class="live-dot" style="margin-right:0;"></span>
          <span class="mono">5.4B+ subdomains indexed · powered by subdomain.app ↗</span>
        </a>
        <h1 class="zai-title">Find Every Subdomain of Any Domain</h1>
        <p class="zai-subtitle">Passive lookup straight from <code>api.subdomain.app/v1/query</code> — up to 10,000 subdomains per domain, automatically classified into Dev, Staging, API, and CDN surfaces.</p>
      </div>

      <!-- Liquid Glass Composer Bar -->
      <form class="zai-composer glass-surface" id="subForm">
        <div class="composer-main-row">
          <input
            type="text"
            id="subInput"
            class="composer-input mono"
            placeholder="Enter a root domain or URL (e.g. vercel.com, github.com, stripe.com)…"
            value="${esc(state.input)}"
            autocomplete="off"
            spellcheck="false"
            ${state.loading ? 'disabled' : ''}
          />
          <button type="submit" class="btn btn-primary btn-sm" id="subSubmitBtn" ${state.loading ? 'disabled' : ''}>
            ${state.loading ? 'Looking up…' : 'Look Up'}
          </button>
        </div>

        <div class="composer-footer-row">
          <div class="composer-meta-left">
            <span class="muted-text mono">GET api.subdomain.app/v1/query · Passive index · Up to 10,000 hosts</span>
          </div>
          <div class="composer-meta-right">
            <a href="https://subdomain.app/" target="_blank" rel="noopener noreferrer" class="btn btn-glass btn-xs">subdomain.app ↗</a>
            <a href="https://api.subdomain.app/" target="_blank" rel="noopener noreferrer" class="btn btn-glass btn-xs">API Docs ↗</a>
          </div>
        </div>
      </form>

      <div class="preset-strip centered">
        <span class="preset-label">${state.recentDomains.length ? 'Recent & Quick:' : 'Quick Domains:'}</span>
        ${state.recentDomains.map((d) => `<button type="button" class="preset-chip preset-recent" data-sub-preset="${esc(d)}">${esc(d)}</button>`).join('')}
        ${['vercel.com', 'github.com', 'cloudflare.com', 'stripe.com']
          .filter((d) => !state.recentDomains.includes(d))
          .map((d) => `<button type="button" class="preset-chip" data-sub-preset="${esc(d)}">${esc(d)}</button>`)
          .join('')}
      </div>

      ${state.loading ? `
        <div class="sub-progress-card glass-surface">
          <div class="sub-progress-top">
            <span class="spinner" aria-hidden="true"></span>
            <span class="mono" id="subElapsedText">${String(state.elapsedSec).padStart(2, '0')}s · ${esc(state.statusLabel)}</span>
          </div>
          <div class="progress-track"><div class="progress-fill" id="subProgressFill" style="width:14%"></div></div>
        </div>
      ` : ''}

      ${state.error ? `<div class="status-banner error glass-surface">${esc(state.error)}</div>` : ''}

      ${r ? `
        <div class="kpi-strip">
          <button type="button" class="kpi-card glass-surface" data-sub-filter="all">
            <div class="kpi-label">Returned Hosts</div>
            <div class="kpi-value cyan">${r.count.toLocaleString()}</div>
            <div class="kpi-sub">${r.total.toLocaleString()} known in index · ${esc(r.durationSec)}s</div>
          </button>
          <button type="button" class="kpi-card glass-surface spotlight" data-sub-filter="dev">
            <div class="kpi-label">Dev / Staging / Preview</div>
            <div class="kpi-value amber">${r.counts.dev.toLocaleString()}</div>
            <div class="kpi-sub">Flagged non-prod hosts</div>
          </button>
          <button type="button" class="kpi-card glass-surface" data-sub-filter="api">
            <div class="kpi-label">API &amp; Auth</div>
            <div class="kpi-value green">${r.counts.api.toLocaleString()}</div>
            <div class="kpi-sub">Service &amp; gateway hosts</div>
          </button>
          <button type="button" class="kpi-card glass-surface" data-sub-filter="cdn">
            <div class="kpi-label">CDN &amp; Assets</div>
            <div class="kpi-value violet">${r.counts.cdn.toLocaleString()}</div>
            <div class="kpi-sub">Static &amp; media hosts</div>
          </button>
        </div>

        <div class="panel glass-surface" style="margin-top:16px;">
          <div class="panel-header">
            <div class="row-gap" style="flex-wrap:wrap;">
              <h3 class="panel-title mono">${esc(r.domain)} <span class="tab-badge">${filtered.length.toLocaleString()}</span></h3>
              <span class="badge badge-api">${esc(r.transportLabel)}</span>
            </div>
            <div class="row-gap" style="flex-wrap:wrap;">
              <input type="text" id="subSearchInput" class="code-input compact" style="max-width:190px;" placeholder="Filter subdomains…" value="${esc(state.search)}" />
              <select id="subSortSelect" class="glass-select mono" aria-label="Sort Subdomains">
                <option value="dev-first" ${state.sort === 'dev-first' ? 'selected' : ''}>Sort: Dev First</option>
                <option value="recent" ${state.sort === 'recent' ? 'selected' : ''}>Sort: Most Recent</option>
                <option value="alpha" ${state.sort === 'alpha' ? 'selected' : ''}>Sort: A → Z</option>
              </select>
              ${r.counts.dev > 0 ? `<button type="button" class="btn btn-glass btn-xs" id="subVerifyDevBtn" ${state.verifyingDns ? 'disabled' : ''}>${state.verifyingDns ? 'Checking DNS…' : 'Check Dev DNS'}</button>` : ''}
              <button type="button" class="btn btn-glass btn-xs" id="subCopyDevBtn">Copy Dev (${r.counts.dev})</button>
              <button type="button" class="btn btn-glass btn-xs" id="subCopyAllBtn">Copy All</button>
              <button type="button" class="btn btn-glass btn-xs" id="subExportTxtBtn">TXT</button>
              <button type="button" class="btn btn-glass btn-xs" id="subExportJsonBtn">JSON</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="toolbar">
              <div class="filter-pills">
                <button type="button" class="filter-pill ${state.filter === 'all' ? 'active' : ''}" data-sub-filter="all">All (${r.rows.length.toLocaleString()})</button>
                <button type="button" class="filter-pill ${state.filter === 'dev' ? 'active' : ''}" data-sub-filter="dev">Dev / Staging (${r.counts.dev.toLocaleString()})</button>
                <button type="button" class="filter-pill ${state.filter === 'api' ? 'active' : ''}" data-sub-filter="api">API / Auth (${r.counts.api.toLocaleString()})</button>
                <button type="button" class="filter-pill ${state.filter === 'cdn' ? 'active' : ''}" data-sub-filter="cdn">CDN (${r.counts.cdn.toLocaleString()})</button>
                <button type="button" class="filter-pill ${state.filter === 'other' ? 'active' : ''}" data-sub-filter="other">Other (${r.counts.other.toLocaleString()})</button>
              </div>
              <span class="muted-text mono">Showing ${visible.length.toLocaleString()} of ${filtered.length.toLocaleString()}</span>
            </div>

            ${visible.length === 0
              ? `<div class="empty-box">${r.count === 0 ? `<code>subdomain.app</code> has 0 indexed subdomains for <code>${esc(r.domain)}</code>.` : 'No subdomains match this filter.'}</div>`
              : `
                <div class="table-wrap">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th>Subdomain</th>
                        <th>Role / Env</th>
                        <th>DNS / Signal</th>
                        <th style="text-align:right;">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${visible.map((row) => {
                        const dns = state.dnsStatus.get(row.host);
                        return `
                          <tr>
                            <td class="mono" style="font-weight:600;">
                              <a href="https://${esc(row.host)}" target="_blank" rel="noopener noreferrer" class="host-link">${esc(row.host)}</a>
                            </td>
                            <td><span class="badge badge-${esc(row.isDevSurface ? row.envTag : row.bucket === 'other' ? 'neutral' : row.bucket)}">${esc(row.isDevSurface ? row.envTag : row.bucket === 'other' ? 'prod' : row.bucket)}</span></td>
                            <td class="mono" style="font-size:11.5px;">
                              ${dns
                                ? `<span class="badge ${dns.state === 'alive' ? 'badge-first-party' : dns.state === 'loading' ? 'badge-neutral' : 'badge-dev'}">${esc(dns.detail)}</span>`
                                : `<span class="muted-text">${esc(row.reasons?.[0] || 'Indexed by subdomain.app')}</span>`
                              }
                            </td>
                            <td style="text-align:right;white-space:nowrap;">
                              <button type="button" class="btn btn-glass btn-xs" data-dns-sub="${esc(row.host)}">DNS</button>
                              <button type="button" class="btn btn-glass btn-xs" data-copy-sub="${esc(row.host)}">Copy</button>
                              <button type="button" class="btn btn-glass btn-xs" data-inspect-sub="${esc(row.host)}">Inspect →</button>
                            </td>
                          </tr>
                        `;
                      }).join('')}
                    </tbody>
                  </table>
                </div>
                ${filtered.length > visible.length ? `
                  <div style="text-align:center;margin-top:14px;">
                    <button type="button" class="btn btn-glass btn-sm" id="subLoadMoreBtn">
                      Load 200 More (${(filtered.length - visible.length).toLocaleString()} remaining)
                    </button>
                  </div>
                ` : ''}
              `
            }
          </div>
        </div>
      ` : !state.loading ? `
        <div class="intro-grid">
          <article class="intro-card glass-surface">
            <div class="intro-icon">5.4B+</div>
            <h3>Powered by subdomain.app</h3>
            <p>Passive index queries <code>api.subdomain.app/v1/query</code> directly — zero target scanning, up to 10,000 subdomains returned most recently seen first.</p>
          </article>
          <article class="intro-card glass-surface">
            <div class="intro-icon amber">DEV</div>
            <h3>Dev &amp; Staging Radar + Live DNS</h3>
            <p>Automatically surfaces <code>dev.*</code>, <code>staging.*</code>, <code>preview.*</code>, <code>qa.*</code>, and <code>api.*</code> hosts and checks live A/CNAME resolution over DoH.</p>
          </article>
          <article class="intro-card glass-surface">
            <div class="intro-icon">CODE</div>
            <h3>One-Click Site Inspector Jump</h3>
            <p>Hit <strong>Inspect →</strong> on any subdomain to open it inside Site Inspector and extract its bundles, leaked environments, and build stack.</p>
          </article>
        </div>
      ` : ''}
    `;

    container.querySelector('#subForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      runLookup(container.querySelector('#subInput')?.value);
    });
    container.querySelectorAll('[data-sub-preset]').forEach((chip) => {
      chip.addEventListener('click', () => runLookup(chip.dataset.subPreset));
    });
    container.querySelectorAll('[data-sub-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filter = btn.dataset.subFilter;
        state.pageLimit = 150;
        render();
      });
    });
    container.querySelector('#subSortSelect')?.addEventListener('change', (e) => {
      state.sort = e.target.value;
      if (state.result) sortRows(state.result.rows, state.sort);
      render();
    });
    const searchEl = container.querySelector('#subSearchInput');
    searchEl?.addEventListener('input', (e) => {
      state.search = e.target.value;
      state.pageLimit = 150;
      render();
      const next = container.querySelector('#subSearchInput');
      if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
    });
    container.querySelector('#subLoadMoreBtn')?.addEventListener('click', () => {
      state.pageLimit += 200;
      render();
    });
    container.querySelector('#subVerifyDevBtn')?.addEventListener('click', verifyTopDevDns);
    container.querySelector('#subCopyDevBtn')?.addEventListener('click', () => {
      if (!r) return;
      const devs = r.rows.filter((x) => x.bucket === 'dev').map((x) => x.host);
      if (devs.length === 0) return showToast('No dev/staging subdomains found');
      copyText(devs.join('\n'), `Copied ${devs.length} dev/staging subdomains`);
    });
    container.querySelector('#subCopyAllBtn')?.addEventListener('click', () => {
      if (!filtered.length) return showToast('Nothing to copy');
      copyText(filtered.map((x) => x.host).join('\n'), `Copied ${filtered.length.toLocaleString()} subdomains`);
    });
    container.querySelector('#subExportTxtBtn')?.addEventListener('click', () => {
      if (!r) return;
      triggerDownload(`subdomains-${r.domain}.txt`, filtered.map((x) => x.host).join('\n'), 'text/plain;charset=utf-8');
    });
    container.querySelector('#subExportJsonBtn')?.addEventListener('click', () => {
      if (!r) return;
      triggerDownload(
        `subdomains-${r.domain}.json`,
        JSON.stringify({ source: 'subdomain.app', domain: r.domain, count: r.count, total: r.total, subdomains: filtered.map((x) => x.host) }, null, 2),
        'application/json;charset=utf-8'
      );
    });
    container.querySelectorAll('[data-dns-sub]').forEach((btn) => {
      btn.addEventListener('click', () => verifyHostDns(btn.dataset.dnsSub));
    });
    container.querySelectorAll('[data-copy-sub]').forEach((btn) => {
      btn.addEventListener('click', () => copyText(btn.dataset.copySub, `Copied ${btn.dataset.copySub}`));
    });
    container.querySelectorAll('[data-inspect-sub]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (onInspectHost) onInspectHost(`https://${btn.dataset.inspectSub}`);
      });
    });
  }

  function init() {
    loadRecent();
    render();
  }

  return { init, render, runLookup };
}
