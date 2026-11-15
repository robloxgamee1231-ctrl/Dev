// Subdomains HUD Module
// Primary: https://api.subdomain.app/v1/query?domain=
// Automatic CORS-native browser fallback for GitHub Pages:
//   - https://api.domainee.dev/v1/tools/subdomain-finder?domain= (CORS *)
//   - Certificate Transparency (crt.sh) & HackerTarget via CORS relays
//   - Live DNS verification via Google DoH (https://dns.google/resolve — CORS *)

import { classifyHost } from '../engine/domains.js';
import { getApexDomain } from '../engine/tlds.js';
import { triggerDownload } from './export.js';

const SUBDOMAIN_API_BASE = 'https://api.subdomain.app/v1/query';
const DOMAINEE_API_BASE = 'https://api.domainee.dev/v1/tools/subdomain-finder';
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
  const deduped = new Set();
  for (const rawHost of subdomains || []) {
    const clean = String(rawHost || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.+$/, '');
    if (clean && (clean === apex || clean.endsWith('.' + apex)) && DOMAIN_RE.test(clean)) {
      deduped.add(clean);
    }
  }

  const rows = [...deduped].map((host) => {
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
    search: '',
    pageLimit: 150,
    result: null, // { domain, count, total, rows, counts, durationSec, sourceLabel }
    dnsStatus: new Map(), // host -> { state: 'loading'|'alive'|'dead', detail }
    verifyingDns: false
  };

  let elapsedTimer = null;

  function stopElapsedTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  function updateStage(label) {
    state.statusLabel = label;
    const el = container.querySelector('#subElapsedText');
    if (el) {
      el.textContent = `${String(state.elapsedSec).padStart(2, '0')}s / ~15s · ${label}`;
    }
  }

  async function fetchViaSubdomainApp(domain) {
    const ctx = getContext();
    const targetUrl = `${SUBDOMAIN_API_BASE}?domain=${encodeURIComponent(domain)}`;
    const attempts = [];

    if (ctx.workerUrl && /^https?:\/\//i.test(ctx.workerUrl)) {
      attempts.push(async () => {
        const base = ctx.workerUrl.replace(/\/+$/, '');
        const res = await fetch(`${base}?url=${encodeURIComponent(targetUrl)}`, { signal: AbortSignal.timeout(45_000) });
        const wrapper = await res.json();
        if (wrapper.error || wrapper.status >= 400) throw new Error(wrapper.error || `HTTP ${wrapper.status}`);
        const data = JSON.parse(wrapper.body || '{}');
        if (!Array.isArray(data.subdomains)) throw new Error('Invalid payload');
        return { domain: data.domain || domain, total: data.total ?? data.subdomains.length, subdomains: data.subdomains, sourceLabel: 'api.subdomain.app (Worker)' };
      });
    }

    if (ctx.serverAvailable) {
      attempts.push(async () => {
        const res = await fetch(`./api/subdomains?domain=${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(45_000) });
        const data = await res.json().catch(() => null);
        if (!res.ok || !Array.isArray(data?.subdomains)) throw new Error(data?.error || `HTTP ${res.status}`);
        return { domain: data.domain || domain, total: data.total ?? data.subdomains.length, subdomains: data.subdomains, sourceLabel: 'api.subdomain.app (Server)' };
      });
    }

    // Direct browser fetch to api.subdomain.app
    attempts.push(async () => {
      const res = await fetch(targetUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(35_000) });
      const data = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(data?.subdomains)) throw new Error(data?.error || `HTTP ${res.status}`);
      return { domain: data.domain || domain, total: data.total ?? data.subdomains.length, subdomains: data.subdomains, sourceLabel: 'api.subdomain.app (Direct)' };
    });

    // CORS proxy relays for api.subdomain.app
    attempts.push(async () => {
      const res = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`, { signal: AbortSignal.timeout(35_000) });
      const data = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(data?.subdomains)) throw new Error('corsproxy failed');
      return { domain: data.domain || domain, total: data.total ?? data.subdomains.length, subdomains: data.subdomains, sourceLabel: 'api.subdomain.app (Relay)' };
    });

    attempts.push(async () => {
      const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`, { signal: AbortSignal.timeout(35_000) });
      const wrap = await res.json().catch(() => null);
      const data = wrap?.contents ? JSON.parse(wrap.contents) : null;
      if (!Array.isArray(data?.subdomains)) throw new Error('allorigins failed');
      return { domain: data.domain || domain, total: data.total ?? data.subdomains.length, subdomains: data.subdomains, sourceLabel: 'api.subdomain.app (Relay)' };
    });

    for (const run of attempts) {
      try {
        return await run();
      } catch {
        // Move to next transport cleanly
      }
    }
    return null;
  }

  // CORS-native public Subdomain Finder (works directly on GitHub Pages!)
  async function fetchViaDomainee(domain) {
    const res = await fetch(`${DOMAINEE_API_BASE}?domain=${encodeURIComponent(domain)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(35_000)
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok || !Array.isArray(json?.data?.subdomains)) {
      throw new Error(json?.error?.message || `Domainee HTTP ${res.status}`);
    }
    return {
      domain: json.data.domain || domain,
      total: json.data.count ?? json.data.subdomains.length,
      subdomains: json.data.subdomains,
      sourceLabel: 'Certificate Transparency + DNS (CORS Direct)'
    };
  }

  // Fallback OSINT: HackerTarget + crt.sh via relays
  async function fetchViaOsintRelays(domain) {
    const found = new Set();

    // 1. HackerTarget hostsearch (fast CSV: host,ip)
    const htUrl = `https://api.hackertarget.com/hostsearch/?q=${encodeURIComponent(domain)}`;
    const relayUrls = [
      `https://corsproxy.io/?url=${encodeURIComponent(htUrl)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(htUrl)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(htUrl)}`
    ];
    for (const u of relayUrls) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(12_000) });
        if (!r.ok) continue;
        const text = await r.text();
        if (!text || /error|API count exceeded/i.test(text.slice(0, 60))) continue;
        for (const line of text.split(/\r?\n/)) {
          const host = line.split(',')[0]?.trim().toLowerCase();
          if (host && (host === domain || host.endsWith('.' + domain))) found.add(host);
        }
        if (found.size > 0) break;
      } catch {}
    }

    // 2. crt.sh JSON via corsproxy / allorigins
    if (found.size < 5) {
      const crtUrl = `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`;
      for (const u of [
        `https://corsproxy.io/?url=${encodeURIComponent(crtUrl)}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(crtUrl)}`
      ]) {
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(18_000) });
          if (!r.ok) continue;
          const entries = await r.json();
          if (!Array.isArray(entries)) continue;
          for (const item of entries.slice(0, 3000)) {
            const names = String(item?.name_value || '').split(/\r?\n/);
            for (const n of names) {
              const clean = n.trim().toLowerCase().replace(/^\*\./, '');
              if (clean && (clean === domain || clean.endsWith('.' + domain))) found.add(clean);
            }
          }
          if (found.size > 0) break;
        } catch {}
      }
    }

    if (found.size === 0) throw new Error('OSINT relays returned no records.');
    return {
      domain,
      total: found.size,
      subdomains: [...found],
      sourceLabel: 'HackerTarget / crt.sh CT Logs'
    };
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
        timerEl.textContent = `${String(state.elapsedSec).padStart(2, '0')}s / ~15s · ${state.statusLabel}`;
      }
      if (fillEl) {
        const pct = Math.min(94, Math.round((1 - Math.exp(-state.elapsedSec / 8)) * 100));
        fillEl.style.width = `${Math.max(10, pct)}%`;
      }
    }, 500);

    try {
      // Race / cascade cleanly: try api.subdomain.app + CORS-native domainee.dev!
      updateStage(`Querying api.subdomain.app & CT logs for ${domain}…`);
      const [subAppRes, domaineeRes] = await Promise.allSettled([
        fetchViaSubdomainApp(domain),
        fetchViaDomainee(domain)
      ]);

      let primary = subAppRes.status === 'fulfilled' && subAppRes.value ? subAppRes.value : null;
      const secondary = domaineeRes.status === 'fulfilled' && domaineeRes.value ? domaineeRes.value : null;

      let mergedHosts = [];
      let sourceParts = [];
      let totalKnown = 0;

      if (primary) {
        mergedHosts.push(...primary.subdomains);
        sourceParts.push(primary.sourceLabel);
        totalKnown = Math.max(totalKnown, primary.total || primary.subdomains.length);
      }
      if (secondary) {
        mergedHosts.push(...secondary.subdomains);
        sourceParts.push(secondary.sourceLabel);
        totalKnown = Math.max(totalKnown, secondary.total || secondary.subdomains.length);
      }

      if (mergedHosts.length === 0) {
        updateStage(`Fallback to HackerTarget & crt.sh for ${domain}…`);
        const osint = await fetchViaOsintRelays(domain);
        mergedHosts.push(...osint.subdomains);
        sourceParts.push(osint.sourceLabel);
        totalKnown = osint.total;
      }

      const classified = classifySubdomainList(domain, mergedHosts);
      const durationSec = ((Date.now() - started) / 1000).toFixed(1);

      state.result = {
        domain,
        count: classified.rows.length,
        total: Math.max(totalKnown, classified.rows.length),
        rows: classified.rows,
        counts: classified.counts,
        durationSec,
        sourceLabel: sourceParts.join(' + ')
      };
      showToast(`Found ${state.result.count.toLocaleString()} subdomains for ${domain}`);
    } catch (err) {
      state.error = err?.message || 'Subdomain discovery failed across all sources.';
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
      state.dnsStatus.set(host, { state: 'dead', detail: 'DNS lookup failed' });
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
        <h1 class="zai-title">Subdomain &amp; Domain Discovery</h1>
        <p class="zai-subtitle">Combines <code>api.subdomain.app</code> (~15s deep index) with CORS-native Certificate Transparency + live DNS verification so every lookup works straight on GitHub Pages.</p>
      </div>

      <!-- Liquid Glass Composer Bar -->
      <form class="zai-composer glass-surface" id="subForm">
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
            <span class="muted-text mono">api.subdomain.app + CT Logs · ~15s deep scan · up to 10,000 hosts</span>
          </div>
          <div class="composer-meta-right">
            <a href="https://api.subdomain.app/" target="_blank" rel="noopener noreferrer" class="btn btn-glass btn-xs">API Docs ↗</a>
          </div>
        </div>
      </form>

      <div class="preset-strip centered">
        <span class="preset-label">Quick Domains:</span>
        <button type="button" class="preset-chip" data-sub-preset="github.com">github.com</button>
        <button type="button" class="preset-chip" data-sub-preset="vercel.com">vercel.com</button>
        <button type="button" class="preset-chip" data-sub-preset="cloudflare.com">cloudflare.com</button>
        <button type="button" class="preset-chip" data-sub-preset="stripe.com">stripe.com</button>
      </div>

      ${state.loading ? `
        <div class="sub-progress-card glass-surface">
          <div class="sub-progress-top">
            <span class="spinner" aria-hidden="true"></span>
            <span class="mono" id="subElapsedText">${String(state.elapsedSec).padStart(2, '0')}s / ~15s · ${esc(state.statusLabel)}</span>
          </div>
          <div class="progress-track"><div class="progress-fill" id="subProgressFill" style="width:12%"></div></div>
        </div>
      ` : ''}

      ${state.error ? `<div class="status-banner error glass-surface">${esc(state.error)}</div>` : ''}

      ${r ? `
        <div class="kpi-strip">
          <div class="kpi-card glass-surface">
            <div class="kpi-label">Unique Subdomains</div>
            <div class="kpi-value">${r.count.toLocaleString()}</div>
            <div class="kpi-sub">${r.total.toLocaleString()} known · ${esc(r.durationSec)}s</div>
          </div>
          <button type="button" class="kpi-card glass-surface spotlight" data-sub-filter="dev">
            <div class="kpi-label">Dev / Staging / QA</div>
            <div class="kpi-value amber">${r.counts.dev.toLocaleString()}</div>
            <div class="kpi-sub">Flagged non-prod hosts</div>
          </button>
          <button type="button" class="kpi-card glass-surface" data-sub-filter="api">
            <div class="kpi-label">API &amp; Auth</div>
            <div class="kpi-value">${r.counts.api.toLocaleString()}</div>
            <div class="kpi-sub">Service &amp; gateway hosts</div>
          </button>
          <button type="button" class="kpi-card glass-surface" data-sub-filter="cdn">
            <div class="kpi-label">CDN &amp; Assets</div>
            <div class="kpi-value">${r.counts.cdn.toLocaleString()}</div>
            <div class="kpi-sub">Static &amp; media hosts</div>
          </button>
        </div>

        <div class="panel glass-surface" style="margin-top:16px;">
          <div class="panel-header">
            <div class="row-gap" style="flex-wrap:wrap;">
              <h3 class="panel-title mono">${esc(r.domain)} <span class="tab-badge">${filtered.length.toLocaleString()}</span></h3>
              <span class="badge badge-neutral">${esc(r.sourceLabel)}</span>
            </div>
            <div class="row-gap" style="flex-wrap:wrap;">
              <input type="text" id="subSearchInput" class="code-input compact" style="max-width:200px;" placeholder="Filter subdomains…" value="${esc(state.search)}" />
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
              ? '<div class="empty-box">No subdomains match this filter.</div>'
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
                                : `<span class="muted-text">${esc(row.reasons?.[0] || 'Subdomain record')}</span>`
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
            <div class="intro-icon">15S</div>
            <h3>Multi-Source Subdomain Scan</h3>
            <p>Queries <code>api.subdomain.app</code> alongside CORS-native Certificate Transparency logs so lookups work reliably right inside GitHub Pages.</p>
          </article>
          <article class="intro-card glass-surface">
            <div class="intro-icon amber">DEV</div>
            <h3>Dev &amp; Staging Triage + Live DNS</h3>
            <p>Separates <code>dev.*</code>, <code>staging.*</code>, <code>qa.*</code>, <code>beta.*</code>, and <code>api.*</code> hosts and verifies live A/CNAME records over DNS-over-HTTPS.</p>
          </article>
          <article class="intro-card glass-surface">
            <div class="intro-icon">CODE</div>
            <h3>One-Click Site Inspector Jump</h3>
            <p>Hit <strong>Inspect →</strong> on any subdomain to jump straight into Site Inspector and extract its bundles, hidden domains, and build stack.</p>
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
        JSON.stringify({ domain: r.domain, count: r.count, total: r.total, subdomains: filtered.map((x) => x.host) }, null, 2),
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
    render();
  }

  return { init, render, runLookup };
}
