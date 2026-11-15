// Domain Intelligence Module (DEVTRACER — made by ★NDX★)
// Subdomain Discovery: api.subdomain.app (primary) + CORS-native api.domainee.dev ({host, addresses})
// + crt.sh / HackerTarget relay fallback + Live Public DNS Records (A, AAAA, CNAME, MX, NS, TXT, SOA)

import { classifyHost } from '../engine/domains.js';
import { getApexDomain } from '../engine/tlds.js';
import { triggerDownload } from './export.js';

const SUBDOMAIN_API_BASE = 'https://api.subdomain.app/v1/query';
const DOMAINEE_API_BASE = 'https://api.domainee.dev/v1/tools/subdomain-finder';
const RECENT_STORAGE_KEY = 'devtracer_subdomain_recent_v1';
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

export function extractDomaineeHosts(payload) {
  const rawList = payload?.data?.subdomains;
  if (!Array.isArray(rawList)) return { hosts: [], addressMap: {} };
  const hosts = [];
  const addressMap = {};
  for (const item of rawList) {
    if (typeof item === 'string') {
      hosts.push(item);
    } else if (item && typeof item === 'object' && typeof item.host === 'string') {
      const h = item.host.trim().toLowerCase();
      hosts.push(h);
      if (Array.isArray(item.addresses) && item.addresses.length > 0) {
        addressMap[h] = item.addresses.slice(0, 3);
      }
    }
  }
  return { hosts, addressMap };
}

function mapEnvironmentBucket(host, classification) {
  if (classification.isDevSurface) {
    const label = String(host || '').split('.')[0] || '';
    const tag = String(classification.envTag || 'dev').toLowerCase();
    if (tag === 'preview' || /(^|-)(preview|pr-\d+|deploy-preview|canary-deploy|branch)($|-)/i.test(label)) return 'preview';
    if (tag === 'beta' || /(^|-)(beta|canary|alpha|rc\d*|next|experimental)($|-)/i.test(label)) return 'beta';
    if (tag === 'staging' || tag === 'qa' || tag === 'uat' || tag === 'preprod' || /(^|-)(stage|staging|stg|qa|uat|preprod|pre-prod|sit|test|testing)($|-)/i.test(label)) return 'staging';
    return 'development';
  }
  if (classification.category === 'api') return 'api';
  if (classification.category === 'cdn') return 'cdn';
  return 'production';
}

export function classifySubdomainList(domain, subdomains, { sort = 'env-first', addressMap = {} } = {}) {
  const apex = getApexDomain(domain) || domain;
  const seen = new Set();
  const rows = [];

  (subdomains || []).forEach((rawItem, idx) => {
    const rawHost = typeof rawItem === 'string' ? rawItem : rawItem?.host;
    const clean = String(rawHost || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.+$/, '');
    if (!clean || seen.has(clean)) return;
    if (!(clean === apex || clean.endsWith('.' + apex)) || !DOMAIN_RE.test(clean)) return;
    seen.add(clean);

    const c = classifyHost(clean, { targetHost: domain, targetApex: apex });
    const env = mapEnvironmentBucket(clean, c);
    const bucket = c.isDevSurface ? 'dev' : c.category === 'api' ? 'api' : c.category === 'cdn' ? 'cdn' : 'other';
    const addresses = addressMap[clean] || (typeof rawItem === 'object' && Array.isArray(rawItem?.addresses) ? rawItem.addresses : []);

    rows.push({
      host: clean,
      recentIndex: idx,
      env,
      bucket,
      envTag: c.isDevSurface ? c.envTag : env,
      isDevSurface: c.isDevSurface,
      reasons: c.reasons,
      priority: c.priority,
      addresses
    });
  });

  sortRows(rows, sort);

  return {
    domain,
    rows,
    counts: {
      dev: rows.filter((r) => r.isDevSurface).length,
      development: rows.filter((r) => r.env === 'development').length,
      staging: rows.filter((r) => r.env === 'staging').length,
      beta: rows.filter((r) => r.env === 'beta').length,
      preview: rows.filter((r) => r.env === 'preview').length,
      api: rows.filter((r) => r.env === 'api').length,
      cdn: rows.filter((r) => r.env === 'cdn').length,
      production: rows.filter((r) => r.env === 'production').length
    }
  };
}

export function sortRows(rows, sort = 'env-first') {
  const rank = { development: 0, staging: 1, preview: 2, beta: 3, api: 4, cdn: 5, production: 6 };
  if (sort === 'recent') {
    rows.sort((a, b) => a.recentIndex - b.recentIndex);
  } else if (sort === 'alpha') {
    rows.sort((a, b) => a.host.localeCompare(b.host));
  } else {
    rows.sort((a, b) => {
      const ra = rank[a.env] ?? 9;
      const rb = rank[b.env] ?? 9;
      if (ra !== rb) return ra - rb;
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
    subdomains: raw.subdomains,
    addresses: raw.addresses || {},
    source: raw.source || 'subdomain.app'
  };
}

// Public DNS Record Inspector (Server /api/dns OR CORS-native Google DoH)
async function fetchPublicDnsRecords(domain, serverAvailable) {
  if (serverAvailable) {
    try {
      const res = await fetch(`./api/dns?domain=${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) return await res.json();
    } catch {}
  }

  const types = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA'];
  const records = { A: [], AAAA: [], CNAME: [], MX: [], NS: [], TXT: [], SOA: [] };
  await Promise.allSettled(
    types.map(async (type) => {
      const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`, {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5_000)
      });
      if (!r.ok) return;
      const data = await r.json();
      const answers = Array.isArray(data?.Answer) ? data.Answer : [];
      records[type] = answers.map((a) => String(a.data || '').replace(/^"|"$/g, '').replace(/\.$/, '').trim()).filter(Boolean);
    })
  );
  return { domain, records };
}

async function resolveSingleHostDoH(host) {
  const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, {
    headers: { Accept: 'application/dns-json' },
    signal: AbortSignal.timeout(6_000)
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

export function createSubdomainsController({ container, getContext, copyText, showToast, onInspectHost, onResultChange }) {
  const state = {
    input: '',
    loading: false,
    statusLabel: '',
    elapsedSec: 0,
    error: '',
    filter: 'all', // 'all' | 'nonprod' | 'development' | 'staging' | 'beta' | 'preview' | 'api' | 'cdn' | 'production'
    sort: 'env-first',
    search: '',
    pageLimit: 150,
    activeView: 'subdomains', // 'subdomains' | 'dns'
    result: null, // { domain, count, total, rows, counts, durationSec, transportLabel, dnsRecords }
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
    try { localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(state.recentDomains)); } catch {}
  }

  function stopElapsedTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  function updateStage(label) {
    state.statusLabel = label;
    const el = container.querySelector('#subElapsedText');
    if (el) el.textContent = `${String(state.elapsedSec).padStart(2, '0')}s · ${label}`;
  }

  async function querySubdomainAppViaRelays(domain) {
    const targetUrl = `${SUBDOMAIN_API_BASE}?domain=${encodeURIComponent(domain)}`;
    const encoded = encodeURIComponent(targetUrl);

    const defs = [
      async (signal) => {
        const r = await fetch(targetUrl, { signal });
        if (!r.ok) throw new Error(`direct ${r.status}`);
        return { ...parseSubdomainAppPayload(await r.json(), domain), transportLabel: 'subdomain.app · Direct' };
      },
      async (signal) => {
        const r = await fetch(`https://corsproxy.io/?url=${encoded}`, { signal });
        if (!r.ok) throw new Error(`corsproxy ${r.status}`);
        return { ...parseSubdomainAppPayload(await r.json(), domain), transportLabel: 'subdomain.app · Relay' };
      },
      async (signal) => {
        const r = await fetch(`https://api.allorigins.win/raw?url=${encoded}`, { signal });
        if (!r.ok) throw new Error(`allorigins-raw ${r.status}`);
        return { ...parseSubdomainAppPayload(await r.json(), domain), transportLabel: 'subdomain.app · Relay' };
      },
      async (signal) => {
        const r = await fetch(`https://api.allorigins.win/get?url=${encoded}`, { signal });
        if (!r.ok) throw new Error(`allorigins-get ${r.status}`);
        const wrap = await r.json();
        return { ...parseSubdomainAppPayload(JSON.parse(wrap?.contents || '{}'), domain), transportLabel: 'subdomain.app · Relay' };
      },
      async (signal) => {
        const r = await fetch(`https://cors.lol/?url=${encoded}`, { signal });
        if (!r.ok) throw new Error(`cors.lol ${r.status}`);
        return { ...parseSubdomainAppPayload(await r.json(), domain), transportLabel: 'subdomain.app · Relay' };
      },
      async (signal) => {
        const r = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encoded}`, { signal });
        if (!r.ok) throw new Error(`codetabs ${r.status}`);
        return { ...parseSubdomainAppPayload(await r.json(), domain), transportLabel: 'subdomain.app · Relay' };
      }
    ];

    const controllers = defs.map(() => new AbortController());
    const tasks = defs.map((fn, i) => {
      const t = setTimeout(() => controllers[i].abort(), 16_000);
      return fn(controllers[i].signal).finally(() => clearTimeout(t));
    });

    try {
      const winner = await Promise.any(tasks);
      controllers.forEach((c) => c.abort());
      return winner;
    } catch {
      controllers.forEach((c) => c.abort());
      return null;
    }
  }

  // CORS-native fallback that works 100% directly in browsers on GitHub Pages!
  async function queryDomaineeDirect(domain) {
    const r = await fetch(`${DOMAINEE_API_BASE}?domain=${encodeURIComponent(domain)}`, {
      signal: AbortSignal.timeout(16_000)
    });
    if (!r.ok) throw new Error(`domainee ${r.status}`);
    const json = await r.json();
    const { hosts, addressMap } = extractDomaineeHosts(json);
    if (hosts.length === 0) throw new Error('domainee returned 0 hosts');
    return {
      domain: json?.data?.domain || domain,
      count: hosts.length,
      total: json?.data?.counts?.total ?? hosts.length,
      subdomains: hosts,
      addresses: addressMap,
      transportLabel: 'domainee.dev · Live DNS + CT (CORS Direct)'
    };
  }

  async function queryHackerTargetRelay(domain) {
    const htUrl = `https://api.hackertarget.com/hostsearch/?q=${encodeURIComponent(domain)}`;
    const enc = encodeURIComponent(htUrl);
    const urls = [
      `https://api.allorigins.win/raw?url=${enc}`,
      `https://corsproxy.io/?url=${enc}`,
      `https://api.codetabs.com/v1/proxy?quest=${enc}`
    ];
    for (const u of urls) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(8_000) });
        if (!r.ok) continue;
        const txt = await r.text();
        if (!txt || /error|API count exceeded/i.test(txt.slice(0, 60))) continue;
        const hosts = [];
        const addresses = {};
        for (const line of txt.split(/\r?\n/)) {
          const [h, ip] = line.split(',');
          const clean = (h || '').trim().toLowerCase();
          if (clean && (clean === domain || clean.endsWith('.' + domain))) {
            hosts.push(clean);
            if (ip && ip.trim()) addresses[clean] = [ip.trim()];
          }
        }
        if (hosts.length > 0) {
          return { domain, count: hosts.length, total: hosts.length, subdomains: hosts, addresses, transportLabel: 'HackerTarget · Relay' };
        }
      } catch {}
    }
    return null;
  }

  async function querySubdomains(domain) {
    const ctx = getContext();

    // 1. Custom Worker -> api.subdomain.app
    if (ctx.workerUrl && /^https?:\/\//i.test(ctx.workerUrl)) {
      try {
        updateStage(`Querying subdomain.app via Worker for ${domain}…`);
        const base = ctx.workerUrl.replace(/\/+$/, '');
        const res = await fetch(`${base}?url=${encodeURIComponent(`${SUBDOMAIN_API_BASE}?domain=${encodeURIComponent(domain)}`)}`, {
          signal: AbortSignal.timeout(25_000)
        });
        const wrapper = await res.json();
        if (!wrapper.error && wrapper.status < 400 && wrapper.body) {
          return { ...parseSubdomainAppPayload(JSON.parse(wrapper.body), domain), transportLabel: 'subdomain.app · Worker' };
        }
      } catch {}
    }

    // 2. Local Node server proxy (/api/subdomains -> api.subdomain.app with server fallback)
    if (ctx.serverAvailable) {
      try {
        updateStage(`Querying subdomain.app via DEVTRACER backend for ${domain}…`);
        const res = await fetch(`./api/subdomains?domain=${encodeURIComponent(domain)}`, {
          signal: AbortSignal.timeout(35_000)
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data && Array.isArray(data.subdomains)) {
          return {
            ...parseSubdomainAppPayload(data, domain),
            transportLabel: `${data.source || 'subdomain.app'} · Server`
          };
        }
      } catch {}
    }

    // 3. Static GitHub Pages browser mode: Run subdomain.app relays AND CORS-native domainee.dev in parallel!
    // Merge both if both succeed (giving subdomain.app breadth + live resolved IPs from domainee.dev),
    // and guarantee instant results even if public relays are rate-limited!
    updateStage(`Querying subdomain.app + live DNS index for ${domain}…`);
    const [subAppSettled, domaineeSettled] = await Promise.allSettled([
      querySubdomainAppViaRelays(domain),
      queryDomaineeDirect(domain)
    ]);

    const subApp = subAppSettled.status === 'fulfilled' ? subAppSettled.value : null;
    const dom = domaineeSettled.status === 'fulfilled' ? domaineeSettled.value : null;

    if (subApp && dom) {
      return {
        domain: subApp.domain || domain,
        count: subApp.subdomains.length + dom.subdomains.length,
        total: Math.max(subApp.total || 0, subApp.subdomains.length, dom.total || 0),
        subdomains: [...subApp.subdomains, ...dom.subdomains],
        addresses: { ...(subApp.addresses || {}), ...(dom.addresses || {}) },
        transportLabel: `${subApp.transportLabel} + Live DNS`
      };
    }
    if (subApp) return subApp;
    if (dom) return dom;

    // 4. Last-resort OSINT relay
    updateStage(`Trying secondary OSINT relay for ${domain}…`);
    const ht = await queryHackerTargetRelay(domain);
    if (ht) return ht;

    throw new Error(`Could not retrieve subdomains for ${domain} from public APIs right now. Retry or run npm start locally.`);
  }

  async function runLookup(rawInput) {
    if (state.loading) return;
    const domain = normalizeRootDomain(rawInput);
    if (!domain) {
      state.error = 'Enter a valid root domain like vercel.com, github.com, or stripe.com.';
      render();
      return;
    }

    const ctx = getContext();
    state.input = domain;
    state.loading = true;
    state.elapsedSec = 0;
    state.statusLabel = `Discovering subdomains & public DNS records for ${domain}…`;
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
      if (timerEl) timerEl.textContent = `${String(state.elapsedSec).padStart(2, '0')}s · ${state.statusLabel}`;
      if (fillEl) {
        const pct = Math.min(94, Math.round((1 - Math.exp(-state.elapsedSec / 5)) * 100));
        fillEl.style.width = `${Math.max(14, pct)}%`;
      }
    }, 350);

    try {
      const [subSettled, dnsSettled] = await Promise.allSettled([
        querySubdomains(domain),
        fetchPublicDnsRecords(domain, ctx.serverAvailable)
      ]);

      const dnsRecords = dnsSettled.status === 'fulfilled' ? dnsSettled.value?.records || {} : {};
      if (subSettled.status !== 'fulfilled') throw subSettled.reason;

      const apiData = subSettled.value;
      const classified = classifySubdomainList(apiData.domain, apiData.subdomains, {
        sort: state.sort,
        addressMap: apiData.addresses || {}
      });

      // Pre-populate live DNS badges for any hosts that already have resolved IPs
      for (const row of classified.rows) {
        if (row.addresses && row.addresses.length > 0) {
          state.dnsStatus.set(row.host, { state: 'alive', detail: row.addresses.slice(0, 2).join(', ') });
        }
      }

      const durationSec = ((Date.now() - started) / 1000).toFixed(1);
      state.result = {
        domain: apiData.domain,
        count: classified.rows.length,
        total: Math.max(apiData.total || 0, classified.rows.length),
        rows: classified.rows,
        counts: classified.counts,
        durationSec,
        transportLabel: apiData.transportLabel,
        dnsRecords
      };
      pushRecent(apiData.domain);
      if (onResultChange) onResultChange(state.result);
      showToast(`Found ${state.result.count.toLocaleString()} subdomains for ${apiData.domain} in ${durationSec}s`);
    } catch (err) {
      state.error = err?.message || 'Domain Intelligence lookup failed.';
    } finally {
      stopElapsedTimer();
      state.loading = false;
      render();
    }
  }

  async function verifyHostDns(host) {
    state.dnsStatus.set(host, { state: 'loading', detail: 'Resolving…' });
    render();
    try {
      const res = await resolveSingleHostDoH(host);
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
    const targets = state.result.rows.filter((r) => r.isDevSurface && !state.dnsStatus.has(r.host)).slice(0, 12);
    const pool = targets.length > 0 ? targets : state.result.rows.filter((r) => r.isDevSurface).slice(0, 12);
    if (pool.length === 0) return showToast('No non-production subdomains to verify');
    state.verifyingDns = true;
    for (const t of pool) state.dnsStatus.set(t.host, { state: 'loading', detail: 'Checking…' });
    render();
    await Promise.all(
      pool.map(async (t) => {
        try {
          const res = await resolveSingleHostDoH(t.host);
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
    showToast(`Verified DNS for ${pool.length} non-prod hosts`);
    render();
  }

  function getFilteredRows() {
    if (!state.result) return [];
    const q = state.search.trim().toLowerCase();
    return state.result.rows.filter((r) => {
      if (state.filter === 'nonprod' && !r.isDevSurface) return false;
      else if (state.filter !== 'all' && state.filter !== 'nonprod' && r.env !== state.filter) return false;
      if (q && !r.host.includes(q)) return false;
      return true;
    });
  }

  function renderDnsPanel(r) {
    const recs = r.dnsRecords || {};
    const types = ['A', 'AAAA', 'CNAME', 'NS', 'MX', 'TXT', 'SOA'];
    const totalCount = types.reduce((acc, t) => acc + (recs[t]?.length || 0), 0);

    if (totalCount === 0) {
      return '<div class="empty-box">No public DNS records returned for this domain.</div>';
    }

    return `
      <div class="dns-grid">
        ${types
          .filter((t) => (recs[t] || []).length > 0)
          .map(
            (type) => `
          <div class="dns-card">
            <div class="dns-card-top">
              <span class="badge ${type === 'TXT' ? 'badge-dev' : type === 'CNAME' || type === 'NS' ? 'badge-api' : 'badge-first-party'}">${type}</span>
              <span class="muted-text mono">${recs[type].length} record${recs[type].length === 1 ? '' : 's'}</span>
            </div>
            <div class="dns-records-list">
              ${recs[type]
                .map((val) => `<div class="dns-record-row mono">${esc(val)}</div>`)
                .join('')}
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    `;
  }

  function render() {
    const r = state.result;
    const filtered = getFilteredRows();
    const visible = filtered.slice(0, state.pageLimit);
    const totalDnsCount = r
      ? Object.values(r.dnsRecords || {}).reduce((acc, list) => acc + (Array.isArray(list) ? list.length : 0), 0)
      : 0;

    container.innerHTML = `
      <div class="view-header">
        <div>
          <span class="section-eyebrow">DOMAIN INTELLIGENCE</span>
          <h1 class="view-title">Subdomain Discovery &amp; Public DNS</h1>
          <p class="view-subtitle">Discovers publicly indexed subdomains via <code>subdomain.app</code> &amp; live DNS intelligence, categorizes development/staging/beta/preview/production environments, and inspects public DNS records.</p>
        </div>
        <a href="https://subdomain.app/" target="_blank" rel="noopener noreferrer" class="btn btn-glass btn-xs">subdomain.app ↗</a>
      </div>

      <!-- Liquid Glass Composer -->
      <form class="zai-composer glass-surface full-width" id="subForm">
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
            ${state.loading ? 'Discovering…' : 'Discover Domain'}
          </button>
        </div>

        <div class="composer-footer-row">
          <div class="composer-meta-left">
            <span class="muted-text mono">subdomain.app index + CORS-native live DNS · A / AAAA / CNAME / MX / NS / TXT / SOA</span>
          </div>
          <div class="composer-meta-right">
            ${state.recentDomains.slice(0, 4).map((d) => `<button type="button" class="preset-chip preset-recent" data-sub-preset="${esc(d)}">${esc(d)}</button>`).join('')}
            ${['vercel.com', 'github.com', 'cloudflare.com', 'stripe.com']
              .filter((d) => !state.recentDomains.includes(d))
              .slice(0, 4)
              .map((d) => `<button type="button" class="preset-chip" data-sub-preset="${esc(d)}">${esc(d)}</button>`)
              .join('')}
          </div>
        </div>
      </form>

      ${state.loading ? `
        <div class="sub-progress-card glass-surface full-width">
          <div class="sub-progress-top">
            <span class="spinner" aria-hidden="true"></span>
            <span class="mono" id="subElapsedText">${String(state.elapsedSec).padStart(2, '0')}s · ${esc(state.statusLabel)}</span>
          </div>
          <div class="progress-track"><div class="progress-fill" id="subProgressFill" style="width:16%"></div></div>
        </div>
      ` : ''}

      ${state.error ? `<div class="status-banner error glass-surface full-width">${esc(state.error)}</div>` : ''}

      ${r ? `
        <div class="kpi-strip">
          <button type="button" class="kpi-card glass-surface" data-sub-filter="all">
            <div class="kpi-label">Subdomains Found</div>
            <div class="kpi-value cyan">${r.count.toLocaleString()}</div>
            <div class="kpi-sub">${r.total.toLocaleString()} indexed · ${esc(r.durationSec)}s</div>
          </button>
          <button type="button" class="kpi-card glass-surface spotlight" data-sub-filter="nonprod">
            <div class="kpi-label">Dev / Staging / Beta / Preview</div>
            <div class="kpi-value amber">${r.counts.dev.toLocaleString()}</div>
            <div class="kpi-sub">${r.counts.development} dev · ${r.counts.staging} stg · ${r.counts.beta + r.counts.preview} beta/prev</div>
          </button>
          <button type="button" class="kpi-card glass-surface" data-sub-filter="api">
            <div class="kpi-label">API &amp; Auth</div>
            <div class="kpi-value green">${r.counts.api.toLocaleString()}</div>
            <div class="kpi-sub">${r.counts.cdn.toLocaleString()} CDN · ${r.counts.production.toLocaleString()} prod</div>
          </button>
          <button type="button" class="kpi-card glass-surface" data-sub-view="dns">
            <div class="kpi-label">Public DNS Records</div>
            <div class="kpi-value violet">${totalDnsCount}</div>
            <div class="kpi-sub">A · AAAA · CNAME · NS · MX · TXT</div>
          </button>
        </div>

        <div class="panel glass-surface" style="margin-top:14px;">
          <div class="panel-header">
            <div class="row-gap" style="flex-wrap:wrap;">
              <div class="composer-mode-pills">
                <button type="button" class="mode-tab ${state.activeView === 'subdomains' ? 'active' : ''}" data-sub-view="subdomains">Subdomains (${r.count.toLocaleString()})</button>
                <button type="button" class="mode-tab ${state.activeView === 'dns' ? 'active' : ''}" data-sub-view="dns">DNS Records (${totalDnsCount})</button>
              </div>
              <span class="badge badge-api">${esc(r.transportLabel)}</span>
            </div>
            <div class="row-gap" style="flex-wrap:wrap;">
              ${state.activeView === 'subdomains' ? `
                <input type="text" id="subSearchInput" class="code-input compact" style="max-width:185px;" placeholder="Filter subdomains…" value="${esc(state.search)}" />
                <select id="subSortSelect" class="glass-select mono" aria-label="Sort Subdomains">
                  <option value="env-first" ${state.sort === 'env-first' ? 'selected' : ''}>Sort: Env Priority</option>
                  <option value="recent" ${state.sort === 'recent' ? 'selected' : ''}>Sort: Index Order</option>
                  <option value="alpha" ${state.sort === 'alpha' ? 'selected' : ''}>Sort: A → Z</option>
                </select>
                ${r.counts.dev > 0 ? `<button type="button" class="btn btn-glass btn-xs" id="subVerifyDevBtn" ${state.verifyingDns ? 'disabled' : ''}>${state.verifyingDns ? 'Checking DNS…' : 'Check Dev DNS'}</button>` : ''}
                <button type="button" class="btn btn-glass btn-xs" id="subCopyDevBtn">Copy Non-Prod (${r.counts.dev})</button>
                <button type="button" class="btn btn-glass btn-xs" id="subExportTxtBtn">TXT</button>
                <button type="button" class="btn btn-glass btn-xs" id="subExportJsonBtn">JSON</button>
              ` : `
                <button type="button" class="btn btn-glass btn-xs" id="subCopyDnsBtn">Copy DNS JSON</button>
              `}
            </div>
          </div>

          <div class="panel-body">
            ${state.activeView === 'dns'
              ? renderDnsPanel(r)
              : `
                <div class="toolbar">
                  <div class="filter-pills">
                    <button type="button" class="filter-pill ${state.filter === 'all' ? 'active' : ''}" data-sub-filter="all">All (${r.rows.length.toLocaleString()})</button>
                    <button type="button" class="filter-pill ${state.filter === 'nonprod' ? 'active' : ''}" data-sub-filter="nonprod">Non-Prod (${r.counts.dev})</button>
                    ${r.counts.development ? `<button type="button" class="filter-pill ${state.filter === 'development' ? 'active' : ''}" data-sub-filter="development">Development (${r.counts.development})</button>` : ''}
                    ${r.counts.staging ? `<button type="button" class="filter-pill ${state.filter === 'staging' ? 'active' : ''}" data-sub-filter="staging">Staging (${r.counts.staging})</button>` : ''}
                    ${r.counts.beta ? `<button type="button" class="filter-pill ${state.filter === 'beta' ? 'active' : ''}" data-sub-filter="beta">Beta (${r.counts.beta})</button>` : ''}
                    ${r.counts.preview ? `<button type="button" class="filter-pill ${state.filter === 'preview' ? 'active' : ''}" data-sub-filter="preview">Preview (${r.counts.preview})</button>` : ''}
                    <button type="button" class="filter-pill ${state.filter === 'api' ? 'active' : ''}" data-sub-filter="api">API (${r.counts.api})</button>
                    <button type="button" class="filter-pill ${state.filter === 'cdn' ? 'active' : ''}" data-sub-filter="cdn">CDN (${r.counts.cdn})</button>
                    <button type="button" class="filter-pill ${state.filter === 'production' ? 'active' : ''}" data-sub-filter="production">Production (${r.counts.production})</button>
                  </div>
                  <span class="muted-text mono">Showing ${visible.length.toLocaleString()} of ${filtered.length.toLocaleString()}</span>
                </div>

                ${visible.length === 0
                  ? '<div class="empty-box">No subdomains match this environment filter.</div>'
                  : `
                    <div class="table-wrap">
                      <table class="data-table">
                        <thead>
                          <tr>
                            <th>Subdomain</th>
                            <th>Environment</th>
                            <th>DNS / Signal</th>
                            <th style="text-align:right;">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${visible.map((row) => {
                            const dns = state.dnsStatus.get(row.host);
                            const badgeClass = row.isDevSurface
                              ? 'badge-dev'
                              : row.env === 'api'
                                ? 'badge-api'
                                : row.env === 'cdn'
                                  ? 'badge-cdn'
                                  : 'badge-first-party';
                            return `
                              <tr>
                                <td class="mono" style="font-weight:600;">
                                  <a href="https://${esc(row.host)}" target="_blank" rel="noopener noreferrer" class="host-link">${esc(row.host)}</a>
                                </td>
                                <td><span class="badge ${badgeClass}">${esc(row.env)}</span></td>
                                <td class="mono" style="font-size:11.5px;">
                                  ${dns
                                    ? `<span class="badge ${dns.state === 'alive' ? 'badge-first-party' : dns.state === 'loading' ? 'badge-neutral' : 'badge-dev'}">${esc(dns.detail)}</span>`
                                    : `<span class="muted-text">${esc(row.reasons?.[0] || 'Publicly indexed')}</span>`
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
              `
            }
          </div>
        </div>
      ` : !state.loading ? `
        <div class="intro-grid">
          <article class="intro-card glass-surface">
            <div class="intro-icon">SUB</div>
            <h3>Multi-Source Subdomain Discovery</h3>
            <p>Queries <code>subdomain.app</code> alongside CORS-native live DNS discovery so every lookup works cleanly both locally and on GitHub Pages.</p>
          </article>
          <article class="intro-card glass-surface">
            <div class="intro-icon amber">ENV</div>
            <h3>Environment Categorization</h3>
            <p>Automatically buckets discovered hosts into <strong>development</strong>, <strong>staging</strong>, <strong>beta</strong>, <strong>preview</strong>, <strong>api</strong>, <strong>cdn</strong>, and <strong>production</strong>.</p>
          </article>
          <article class="intro-card glass-surface">
            <div class="intro-icon">DNS</div>
            <h3>Full Public DNS Records</h3>
            <p>Inspects live <code>A</code>, <code>AAAA</code>, <code>CNAME</code>, <code>MX</code>, <code>NS</code>, <code>TXT</code>, and <code>SOA</code> records with one-click handoff into Website Inspector.</p>
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
    container.querySelectorAll('[data-sub-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeView = btn.dataset.subView;
        render();
      });
    });
    container.querySelectorAll('[data-sub-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeView = 'subdomains';
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
      const devs = r.rows.filter((x) => x.isDevSurface).map((x) => x.host);
      if (devs.length === 0) return showToast('No non-production subdomains found');
      copyText(devs.join('\n'), `Copied ${devs.length} non-production subdomains`);
    });
    container.querySelector('#subCopyDnsBtn')?.addEventListener('click', () => {
      if (!r) return;
      copyText(JSON.stringify(r.dnsRecords, null, 2), 'Copied DNS records JSON');
    });
    container.querySelector('#subExportTxtBtn')?.addEventListener('click', () => {
      if (!r) return;
      triggerDownload(`devtracer-subdomains-${r.domain}.txt`, filtered.map((x) => x.host).join('\n'), 'text/plain;charset=utf-8');
    });
    container.querySelector('#subExportJsonBtn')?.addEventListener('click', () => {
      if (!r) return;
      triggerDownload(
        `devtracer-domain-intel-${r.domain}.json`,
        JSON.stringify({ domain: r.domain, source: r.transportLabel, count: r.count, total: r.total, counts: r.counts, dnsRecords: r.dnsRecords, subdomains: filtered }, null, 2),
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

  function setSearchFilter(q) {
    state.search = q;
    if (state.result) render();
  }

  function init() {
    loadRecent();
    render();
  }

  return { init, render, runLookup, setSearchFilter, getResult: () => state.result };
}
