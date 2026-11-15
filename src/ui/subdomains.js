// Subdomains HUD Module — powered by https://api.subdomain.app/v1/query?domain=
import { classifyHost } from '../engine/domains.js';
import { getApexDomain } from '../engine/tlds.js';
import { triggerDownload } from './export.js';

const SUBDOMAIN_API_BASE = 'https://api.subdomain.app/v1/query';
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

export function classifySubdomainList(domain, subdomains) {
  const apex = getApexDomain(domain) || domain;
  const rows = (subdomains || []).map((rawHost) => {
    const host = String(rawHost || '').trim().toLowerCase();
    const c = classifyHost(host, { targetHost: domain, targetApex: apex });
    let bucket = 'other';
    if (c.isDevSurface) bucket = 'dev';
    else if (c.category === 'api') bucket = 'api';
    else if (c.category === 'cdn') bucket = 'cdn';
    return {
      host,
      bucket,
      envTag: c.isDevSurface ? c.envTag : c.category,
      isDevSurface: c.isDevSurface,
      reasons: c.reasons,
      priority: c.priority
    };
  });

  // Sort dev/staging hits first, then API, then CDN, then alphabetical
  const bucketRank = { dev: 0, api: 1, cdn: 2, other: 3 };
  rows.sort((a, b) => {
    if (bucketRank[a.bucket] !== bucketRank[b.bucket]) return bucketRank[a.bucket] - bucketRank[b.bucket];
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.host.localeCompare(b.host);
  });

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

function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createSubdomainsController({ container, getContext, copyText, showToast, onInspectHost }) {
  const state = {
    input: '',
    loading: false,
    elapsedSec: 0,
    error: '',
    filter: 'all', // all | dev | api | cdn | other
    search: '',
    pageLimit: 150,
    result: null // { domain, count, total, rows, counts, durationSec, transport }
  };

  let elapsedTimer = null;

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  async function querySubdomainApi(domain) {
    const ctx = getContext();
    const targetUrl = `${SUBDOMAIN_API_BASE}?domain=${encodeURIComponent(domain)}`;
    const attempts = [];

    // 1. Direct browser call to api.subdomain.app (45s timeout for ~15s scans)
    attempts.push(async () => {
      const res = await fetch(targetUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(45_000)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(
          res.status === 429
            ? 'Rate limit hit on api.subdomain.app (HTTP 429). Wait a moment and retry.'
            : res.status === 503
              ? 'api.subdomain.app is temporarily unavailable (HTTP 503).'
              : data?.error || data?.detail || `Subdomain API HTTP ${res.status}`
        );
        err.httpStatus = res.status;
        throw err;
      }
      return { data, via: 'direct' };
    });

    // 2. Custom Cloudflare Worker
    if (ctx.workerUrl && /^https?:\/\//i.test(ctx.workerUrl)) {
      attempts.push(async () => {
        const base = ctx.workerUrl.replace(/\/+$/, '');
        const res = await fetch(`${base}?url=${encodeURIComponent(targetUrl)}`, {
          signal: AbortSignal.timeout(45_000)
        });
        const wrapper = await res.json();
        if (wrapper.error) throw new Error(wrapper.error);
        const data = JSON.parse(wrapper.body || '{}');
        if (wrapper.status >= 400) {
          const err = new Error(data?.error || `Subdomain API HTTP ${wrapper.status}`);
          err.httpStatus = wrapper.status;
          throw err;
        }
        return { data, via: 'worker' };
      });
    }

    // 3. Local DevTrace Node server proxy
    if (ctx.serverAvailable) {
      attempts.push(async () => {
        const res = await fetch(`./api/subdomains?domain=${encodeURIComponent(domain)}`, {
          signal: AbortSignal.timeout(45_000)
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          const err = new Error(data?.error || `Server subdomain proxy HTTP ${res.status}`);
          err.httpStatus = res.status;
          throw err;
        }
        return { data, via: 'server' };
      });
    }

    // 4. Browser CORS relay fallback for GitHub Pages
    attempts.push(async () => {
      const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`, {
        signal: AbortSignal.timeout(45_000)
      });
      if (!res.ok) throw new Error(`CORS relay HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data?.subdomains)) throw new Error('Invalid relay response');
      return { data, via: 'relay' };
    });

    let lastErr;
    for (const run of attempts) {
      try {
        return await run();
      } catch (err) {
        if (err?.httpStatus === 400 || err?.httpStatus === 429) throw err;
        lastErr = err;
      }
    }
    throw lastErr || new Error('Unable to reach api.subdomain.app.');
  }

  async function runLookup(rawInput) {
    if (state.loading) return;
    const domain = normalizeRootDomain(rawInput);
    if (!domain) {
      state.error = 'Enter a valid root domain like github.com, vercel.com, or example.com.';
      render();
      return;
    }

    state.input = domain;
    state.loading = true;
    state.elapsedSec = 0;
    state.error = '';
    state.filter = 'all';
    state.search = '';
    state.pageLimit = 150;
    const started = Date.now();
    render();

    stopElapsedTimer();
    elapsedTimer = setInterval(() => {
      state.elapsedSec = Math.floor((Date.now() - started) / 1000);
      const timerEl = container.querySelector('#subElapsedText');
      const fillEl = container.querySelector('#subProgressFill');
      if (timerEl) {
        timerEl.textContent = `${String(state.elapsedSec).padStart(2, '0')}s / ~15s · Querying api.subdomain.app for ${domain}…`;
      }
      if (fillEl) {
        // Asymptotic smooth fill up to 94% around 15–20s
        const pct = Math.min(94, Math.round((1 - Math.exp(-state.elapsedSec / 9)) * 100));
        fillEl.style.width = `${Math.max(8, pct)}%`;
      }
    }, 500);

    try {
      const { data, via } = await querySubdomainApi(domain);
      const list = Array.isArray(data?.subdomains) ? data.subdomains : [];
      const classified = classifySubdomainList(data?.domain || domain, list);
      const durationSec = ((Date.now() - started) / 1000).toFixed(1);
      state.result = {
        domain: data?.domain || domain,
        count: typeof data?.count === 'number' ? data.count : list.length,
        total: typeof data?.total === 'number' ? data.total : list.length,
        rows: classified.rows,
        counts: classified.counts,
        durationSec,
        transport: via
      };
      showToast(`Found ${state.result.count.toLocaleString()} subdomains for ${state.result.domain}`);
    } catch (err) {
      state.error = err?.message || 'Subdomain lookup failed.';
    } finally {
      stopElapsedTimer();
      state.loading = false;
      render();
    }
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
        <h1 class="zai-title">Subdomain &amp; Domain Discovery</h1>
        <p class="zai-subtitle">Enumerates up to 10,000 known subdomains via <code>api.subdomain.app</code> (~15s lookup) and flags dev, staging, QA, and API hosts automatically.</p>
      </div>

      <!-- Z.ai Composer Bar -->
      <form class="zai-composer" id="subForm">
        <div class="composer-main-row">
          <input
            type="text"
            id="subInput"
            class="composer-input mono"
            placeholder="Enter root domain (e.g. github.com, vercel.com, stripe.com)…"
            value="${esc(state.input)}"
            autocomplete="off"
            spellcheck="false"
            ${state.loading ? 'disabled' : ''}
          />
          <button type="submit" class="btn btn-primary btn-sm" id="subSubmitBtn" ${state.loading ? 'disabled' : ''}>
            ${state.loading ? 'Scanning…' : 'Find Subdomains'}
          </button>
        </div>

        <div class="composer-footer-row">
          <div class="composer-meta-left">
            <span class="muted-text mono">GET api.subdomain.app/v1/query · ~15s scan · up to 10,000 hosts</span>
          </div>
          <div class="composer-meta-right">
            <a href="https://api.subdomain.app/" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-xs">API Docs ↗</a>
          </div>
        </div>
      </form>

      <!-- Outcome / Preset Pills -->
      <div class="preset-strip centered">
        <span class="preset-label">Quick Domains:</span>
        <button type="button" class="preset-chip" data-sub-preset="github.com">github.com</button>
        <button type="button" class="preset-chip" data-sub-preset="vercel.com">vercel.com</button>
        <button type="button" class="preset-chip" data-sub-preset="cloudflare.com">cloudflare.com</button>
        <button type="button" class="preset-chip" data-sub-preset="stripe.com">stripe.com</button>
      </div>

      ${state.loading ? `
        <div class="sub-progress-card">
          <div class="sub-progress-top">
            <span class="spinner" aria-hidden="true"></span>
            <span class="mono" id="subElapsedText">${String(state.elapsedSec).padStart(2, '0')}s / ~15s · Querying api.subdomain.app for ${esc(state.input)}…</span>
          </div>
          <div class="progress-track"><div class="progress-fill" id="subProgressFill" style="width:10%"></div></div>
        </div>
      ` : ''}

      ${state.error ? `<div class="status-banner error">${esc(state.error)}</div>` : ''}

      ${r ? `
        <div class="kpi-strip">
          <div class="kpi-card">
            <div class="kpi-label">Total Known</div>
            <div class="kpi-value">${r.total.toLocaleString()}</div>
            <div class="kpi-sub">${r.count.toLocaleString()} returned in ${esc(r.durationSec)}s</div>
          </div>
          <button type="button" class="kpi-card spotlight" data-sub-filter="dev">
            <div class="kpi-label">Dev / Staging / QA</div>
            <div class="kpi-value amber">${r.counts.dev.toLocaleString()}</div>
            <div class="kpi-sub">Flagged non-prod hosts</div>
          </button>
          <button type="button" class="kpi-card" data-sub-filter="api">
            <div class="kpi-label">API &amp; Auth</div>
            <div class="kpi-value">${r.counts.api.toLocaleString()}</div>
            <div class="kpi-sub">Service &amp; gateway hosts</div>
          </button>
          <button type="button" class="kpi-card" data-sub-filter="cdn">
            <div class="kpi-label">CDN &amp; Assets</div>
            <div class="kpi-value">${r.counts.cdn.toLocaleString()}</div>
            <div class="kpi-sub">Static &amp; media hosts</div>
          </button>
        </div>

        <div class="panel" style="margin-top:16px;">
          <div class="panel-header">
            <h3 class="panel-title mono">${esc(r.domain)} <span class="tab-badge">${filtered.length.toLocaleString()}</span></h3>
            <div class="row-gap" style="flex-wrap:wrap;">
              <input type="text" id="subSearchInput" class="code-input compact" style="max-width:220px;" placeholder="Filter subdomains…" value="${esc(state.search)}" />
              <button type="button" class="btn btn-ghost btn-xs" id="subCopyDevBtn">Copy Dev (${r.counts.dev})</button>
              <button type="button" class="btn btn-ghost btn-xs" id="subCopyAllBtn">Copy Filtered</button>
              <button type="button" class="btn btn-ghost btn-xs" id="subExportTxtBtn">TXT</button>
              <button type="button" class="btn btn-ghost btn-xs" id="subExportJsonBtn">JSON</button>
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
              ? '<div class="empty-box">No subdomains match this filter.</div>'
              : `
                <div class="table-wrap">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th>Subdomain</th>
                        <th>Role / Env</th>
                        <th>Signal</th>
                        <th style="text-align:right;">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${visible.map((row) => `
                        <tr>
                          <td class="mono" style="font-weight:600;">
                            <a href="https://${esc(row.host)}" target="_blank" rel="noopener noreferrer" class="host-link">${esc(row.host)}</a>
                          </td>
                          <td><span class="badge badge-${esc(row.isDevSurface ? row.envTag : row.bucket === 'other' ? 'neutral' : row.bucket)}">${esc(row.isDevSurface ? row.envTag : row.bucket === 'other' ? 'prod' : row.bucket)}</span></td>
                          <td class="muted-text">${esc(row.reasons?.[0] || 'Subdomain record')}</td>
                          <td style="text-align:right;white-space:nowrap;">
                            <button type="button" class="btn btn-ghost btn-xs" data-copy-sub="${esc(row.host)}">Copy</button>
                            <button type="button" class="btn btn-ghost btn-xs" data-inspect-sub="${esc(row.host)}">Inspect Code →</button>
                          </td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
                ${filtered.length > visible.length ? `
                  <div style="text-align:center;margin-top:14px;">
                    <button type="button" class="btn btn-ghost btn-sm" id="subLoadMoreBtn">
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
          <article class="intro-card">
            <div class="intro-icon">15S</div>
            <h3>Deep Subdomain Enumeration</h3>
            <p>Queries <code>api.subdomain.app/v1/query</code> for up to 10,000 most-recently-seen subdomains on any root domain.</p>
          </article>
          <article class="intro-card">
            <div class="intro-icon amber">DEV</div>
            <h3>Instant Non-Prod Highlighting</h3>
            <p>Separates <code>dev.*</code>, <code>staging.*</code>, <code>qa.*</code>, <code>beta.*</code>, <code>sandbox.*</code>, and <code>api.*</code> hosts from production noise automatically.</p>
          </article>
          <article class="intro-card">
            <div class="intro-icon">CODE</div>
            <h3>One-Click Site Code Crawl</h3>
            <p>Click <strong>Inspect Code →</strong> on any discovered subdomain to jump straight into Site Inspector and fingerprint its bundles and build stack.</p>
          </article>
        </div>
      ` : ''}
    `;

    // Bind events
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
        JSON.stringify({ domain: r.domain, count: r.count, total: r.total, subdomains: filtered.map((x) => x.host) }, null, 2),
        'application/json;charset=utf-8'
      );
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
    render();
  }

  return { init, render, runLookup };
}
