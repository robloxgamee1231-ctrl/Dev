import { buildSampleScan } from '../engine/sample.js';
import { checkServerAvailability, scanGitHub, scanRawArtifacts, scanWebsiteUrl } from './scanner.js';
import { renderTopologySvg } from './graph.js';
import { exportDomainsCsv, exportReportJson, exportReportMarkdown } from './export.js';
import { createSubdomainsController } from './subdomains.js';

const STORAGE_KEYS = {
  HISTORY: 'devtrace_history_v1',
  SETTINGS: 'devtrace_settings_v1',
  THEME: 'devtrace_theme_v1',
  GH_TOKEN: 'devtrace_gh_token_session'
};

const VALID_HUD_TABS = new Set(['subdomains', 'inspector']);

const state = {
  hudTab: 'subdomains',
  mode: 'website',
  serverAvailable: false,
  scanning: false,
  report: null,
  activeTab: 'overview',
  devFilter: 'all',
  devSearch: '',
  domainFilter: 'all',
  domainSearch: '',
  domainGroupByApex: false,
  selectedArtifactId: null,
  codeSearch: '',
  attachedFiles: [],
  history: []
};

// ===================== SAFETY & FORMATTERS =====================

function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch {}
  return '';
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function highlightHostInSnippet(snippet, host) {
  const safeSnippet = esc(snippet || '');
  if (!host) return safeSnippet;
  const escapedHost = esc(host).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safeSnippet.replace(new RegExp(escapedHost, 'gi'), (m) => `<mark>${m}</mark>`);
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function copyText(text, label = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast(label);
  }
}

// ===================== SETTINGS & HISTORY =====================

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS) || '{}');
    if (saved.maxBundles != null) document.getElementById('optMaxBundles').value = saved.maxBundles;
    if (saved.transport) document.getElementById('optTransport').value = saved.transport;
    if (saved.workerUrl) document.getElementById('optWorkerUrl').value = saved.workerUrl;
    if (typeof saved.probeMeta === 'boolean') document.getElementById('optProbeMeta').checked = saved.probeMeta;
  } catch {}
  try {
    const tok = sessionStorage.getItem(STORAGE_KEYS.GH_TOKEN) || '';
    if (tok) document.getElementById('optGithubToken').value = tok;
  } catch {}
}

function saveSettings() {
  const settings = {
    maxBundles: Number(document.getElementById('optMaxBundles').value) || 8,
    transport: document.getElementById('optTransport').value || 'auto',
    workerUrl: document.getElementById('optWorkerUrl').value.trim(),
    probeMeta: document.getElementById('optProbeMeta').checked
  };
  try {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    const tok = document.getElementById('optGithubToken').value.trim();
    if (tok) sessionStorage.setItem(STORAGE_KEYS.GH_TOKEN, tok);
    else sessionStorage.removeItem(STORAGE_KEYS.GH_TOKEN);
  } catch {}
  return { ...settings, githubToken: document.getElementById('optGithubToken').value.trim() };
}

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY) || '[]');
    if (Array.isArray(list)) state.history = list;
  } catch {
    state.history = [];
  }
  updateHistoryBadge();
}

function pushHistory(report) {
  // Store lightweight report snapshot (trim huge artifact contents to keep localStorage fast)
  const compact = {
    ...report,
    artifacts: (report.artifacts || []).map((a) => ({
      ...a,
      content: (a.content || '').slice(0, 12000)
    }))
  };
  state.history = [compact, ...state.history.filter((h) => h.target !== report.target || h.mode !== report.mode)].slice(0, 12);
  try {
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(state.history));
  } catch {
    // If quota exceeded, keep only latest 4
    state.history = state.history.slice(0, 4);
    try { localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(state.history)); } catch {}
  }
  updateHistoryBadge();
}

function updateHistoryBadge() {
  document.getElementById('historyCount').textContent = String(state.history.length);
}

// ===================== STATUS & MODE =====================

function setStatus(type, message) {
  const banner = document.getElementById('statusBanner');
  if (!type) {
    banner.className = 'status-banner hidden';
    banner.innerHTML = '';
    return;
  }
  banner.className = `status-banner ${type}`;
  if (type === 'loading') {
    banner.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(message)}</span>`;
  } else {
    banner.innerHTML = `<span>${esc(message)}</span>`;
  }
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-tab').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-mode-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.modePanel !== mode);
  });
}

function setScanningUI(busy) {
  state.scanning = busy;
  document.getElementById('websiteSubmitBtn').disabled = busy;
  document.getElementById('githubSubmitBtn').disabled = busy;
}

// ===================== SCAN EXECUTION =====================

async function runScan(fn) {
  if (state.scanning) return;
  setScanningUI(true);
  setStatus('loading', 'Initializing scan…');
  try {
    const report = await fn();
    state.report = report;
    state.activeTab = 'overview';
    state.devFilter = 'all';
    state.devSearch = '';
    state.domainFilter = 'all';
    state.domainSearch = '';
    state.codeSearch = '';
    state.selectedArtifactId = report.artifacts?.[0]?.id || null;
    pushHistory(report);
    setStatus(null, '');
    renderWorkspace();
  } catch (err) {
    setStatus('error', err?.message || 'Scan failed.');
  } finally {
    setScanningUI(false);
  }
}

async function handleWebsiteScan(rawUrl) {
  const opts = saveSettings();
  await runScan(() =>
    scanWebsiteUrl(rawUrl, {
      transport: opts.transport,
      serverAvailable: state.serverAvailable,
      maxBundles: opts.maxBundles,
      probeMeta: opts.probeMeta,
      customWorkerUrl: opts.workerUrl,
      onProgress: (p) => setStatus('loading', p.label)
    })
  );
}

async function handleGitHubScan(rawRepo) {
  const opts = saveSettings();
  await runScan(() =>
    scanGitHub(rawRepo, {
      token: opts.githubToken,
      maxFiles: 12,
      onProgress: (p) => setStatus('loading', p.label)
    })
  );
}

function handleSampleScan() {
  const report = buildSampleScan();
  state.report = report;
  state.activeTab = 'overview';
  state.selectedArtifactId = report.artifacts?.[0]?.id || null;
  pushHistory(report);
  setStatus(null, '');
  renderWorkspace();
  showToast('Loaded multi-environment demo site');
}

// ===================== WORKSPACE RENDERING =====================

function renderWorkspace() {
  const report = state.report;
  const empty = document.getElementById('emptyState');
  const ws = document.getElementById('resultsWorkspace');

  if (!report) {
    empty.classList.remove('hidden');
    ws.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  ws.classList.remove('hidden');

  renderReportBanner(report);
  renderKpiStrip(report);

  document.getElementById('tabBadgeDev').textContent = String(report.counts.devSites);
  document.getElementById('tabBadgeDomains').textContent = String(report.counts.totalDomains);
  document.getElementById('tabBadgeStack').textContent = String(report.counts.technologies);
  document.getElementById('tabBadgeCode').textContent = String(report.counts.artifacts);

  document.querySelectorAll('#resultTabs .subtab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
  });

  renderActiveTab();
}

function renderReportBanner(report) {
  const transportLabels = {
    server: 'Server Deep Crawler',
    'custom-worker': 'Custom Worker Proxy',
    'browser-relay': 'Browser Multi-Relay',
    'browser-direct': 'Browser Direct',
    'browser-dns': 'DNS-over-HTTPS',
    'github-api': 'GitHub REST API',
    local: 'Client-Side Local'
  };

  const targetHref = safeHref(report.targetUrl || (report.meta?.repoUrl || ''));
  const targetTitleHtml = targetHref
    ? `<a href="${esc(targetHref)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none;"><h2>${esc(report.target)}</h2></a>`
    : `<h2>${esc(report.target)}</h2>`;

  const metaBits = [
    report.meta?.status ? `HTTP ${report.meta.status}` : null,
    report.meta?.stars != null ? `★ ${Number(report.meta.stars).toLocaleString()}` : null,
    report.meta?.totalRepoFiles ? `${report.meta.totalRepoFiles.toLocaleString()} repo files` : null,
    `${formatBytes(report.counts.totalBytes)} inspected`,
    `${report.durationMs}ms parse`
  ].filter(Boolean);

  document.getElementById('reportBanner').innerHTML = `
    <div class="report-banner-top">
      <div class="report-target">
        ${targetTitleHtml}
        <span class="badge badge-api">${esc(transportLabels[report.transport] || report.transport)}</span>
        ${report.title && report.title !== report.target ? `<span class="muted-text">${esc(report.title)}</span>` : ''}
      </div>
      <div class="report-meta">
        ${metaBits.map((b) => `<span>${esc(b)}</span>`).join('<span>·</span>')}
      </div>
    </div>
    <div class="arch-line">
      <strong>BUILD STACK</strong>${esc(report.architectureSummary)}
    </div>
  `;
}

function renderKpiStrip(report) {
  const c = report.counts;
  const topFrameworks = report.stack.technologies
    .filter((t) => ['Meta-Framework', 'UI Framework', 'CMS & Site Builder'].includes(t.category))
    .slice(0, 2)
    .map((t) => t.name)
    .join(', ') || 'No framework matched';

  document.getElementById('kpiStrip').innerHTML = `
    <button type="button" class="kpi-card glass-surface spotlight" data-jump-tab="dev">
      <div class="kpi-label">Dev / Staging / Preview</div>
      <div class="kpi-value amber">${c.devSites}</div>
      <div class="kpi-sub">${c.devSites > 0 ? 'Non-prod hosts found in code' : 'No non-prod hosts exposed'}</div>
    </button>
    <button type="button" class="kpi-card glass-surface" data-jump-tab="domains">
      <div class="kpi-label">Unique Domains</div>
      <div class="kpi-value cyan">${c.totalDomains}</div>
      <div class="kpi-sub">${c.apexDomains} apex · ${c.firstParty} first-party</div>
    </button>
    <button type="button" class="kpi-card glass-surface" data-jump-tab="domains" data-jump-filter="api">
      <div class="kpi-label">API &amp; Service Hosts</div>
      <div class="kpi-value green">${c.apiDomains}</div>
      <div class="kpi-sub">${c.cdnDomains} CDN · ${c.thirdParty} SaaS</div>
    </button>
    <button type="button" class="kpi-card glass-surface" data-jump-tab="stack">
      <div class="kpi-label">Build Stack</div>
      <div class="kpi-value violet">${c.technologies}</div>
      <div class="kpi-sub">${esc(topFrameworks)}</div>
    </button>
    <button type="button" class="kpi-card glass-surface" data-jump-tab="code">
      <div class="kpi-label">Artifacts Scanned</div>
      <div class="kpi-value">${c.artifacts}</div>
      <div class="kpi-sub">${c.sourceMaps} sourcemaps · ${c.envHints} env refs</div>
    </button>
  `;

  document.querySelectorAll('[data-jump-tab]').forEach((card) => {
    card.addEventListener('click', () => {
      state.activeTab = card.dataset.jumpTab;
      if (card.dataset.jumpFilter) state.domainFilter = card.dataset.jumpFilter;
      renderWorkspace();
    });
  });
}

function renderActiveTab() {
  const stage = document.getElementById('tabStage');
  const r = state.report;
  if (!r) return;

  if (state.activeTab === 'overview') renderOverviewTab(stage, r);
  else if (state.activeTab === 'dev') renderDevTab(stage, r);
  else if (state.activeTab === 'domains') renderDomainsTab(stage, r);
  else if (state.activeTab === 'stack') renderStackTab(stage, r);
  else if (state.activeTab === 'code') renderCodeTab(stage, r);
}

// --------------------- TAB 1: OVERVIEW ---------------------

function renderDevItemCard(d) {
  const firstEv = d.evidence?.[0];
  const envBadgeClass = `badge-${d.envTag || 'dev'}`;
  return `
    <div class="dev-item">
      <div class="dev-item-top">
        <button type="button" class="dev-host-btn" data-inspect-host="${esc(d.host)}">${esc(d.host)}${d.ports?.length ? `:${esc(d.ports[0])}` : ''}</button>
        <div class="row-gap">
          <span class="badge ${envBadgeClass}">${esc(d.envTag || d.category)}</span>
          ${d.isFirstParty ? '<span class="badge badge-first-party">1st-party</span>' : ''}
          ${d.vendor ? `<span class="badge badge-neutral">${esc(d.vendor)}</span>` : ''}
          <span class="muted-text mono">${d.occurrences}×</span>
        </div>
      </div>
      <div class="dev-reasons">${esc((d.reasons || []).join(' · '))}</div>
      ${firstEv ? `
        <div class="snippet-box">
          <span class="snippet-loc">${esc(firstEv.artifact)}:${firstEv.line}</span>${highlightHostInSnippet(firstEv.snippet, d.host)}
        </div>
      ` : ''}
    </div>
  `;
}

function renderOverviewTab(stage, r) {
  const topDev = r.devSites.slice(0, 6);
  const topStack = r.stack.technologies.slice(0, 18);

  stage.innerHTML = `
    <div class="overview-grid">
      <div class="panel">
        <div class="panel-header">
          <h3 class="panel-title">
            <span class="chip-dot amber"></span>
            Dev, Staging &amp; Preview Sites (${r.devSites.length})
          </h3>
          ${r.devSites.length > 0 ? `<button type="button" class="btn btn-ghost btn-sm" id="ovViewAllDev">View All →</button>` : ''}
        </div>
        <div class="panel-body">
          ${topDev.length === 0
            ? '<div class="empty-box">No dev, staging, preview, or localhost domains detected in the scanned code.</div>'
            : `<div class="dev-list">${topDev.map(renderDevItemCard).join('')}</div>`
          }
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h3 class="panel-title">
            <span class="chip-dot violet"></span>
            Detected Build Stack (${r.stack.technologies.length})
          </h3>
          <button type="button" class="btn btn-ghost btn-sm" id="ovViewAllStack">Full Breakdown →</button>
        </div>
        <div class="panel-body">
          ${topStack.length === 0
            ? '<div class="empty-box">No known framework or build tool signatures matched.</div>'
            : `<div class="compact-stack-chips">
                ${topStack.map((t) => `
                  <span class="stack-chip" title="${esc(t.category)} · ${esc(t.evidence?.[0]?.detail || '')}">
                    <span class="tech-swatch" style="background:${esc(t.color || '#94a3b8')}"></span>
                    <span>${esc(t.name)}</span>
                    ${t.version ? `<span class="ver">v${esc(t.version)}</span>` : ''}
                  </span>
                `).join('')}
              </div>`
          }

          ${r.envHints.length > 0 ? `
            <div style="margin-top:18px;">
              <div class="drawer-section">
                <h4>Environment Config Variables Found (${r.envHints.length})</h4>
              </div>
              <div class="url-list">
                ${r.envHints.slice(0, 6).map((e) => `
                  <div class="url-row">
                    <span style="color:var(--accent-amber);font-weight:700;">${esc(e.name)}</span>
                    <span style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(e.value)}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          ${r.sourceMaps.length > 0 ? `
            <div style="margin-top:16px;">
              <div class="drawer-section">
                <h4>Source Map References (${r.sourceMaps.length})</h4>
              </div>
              <div class="url-list">
                ${r.sourceMaps.slice(0, 4).map((sm) => `
                  <div class="url-row">
                    <span>${esc(sm.ref)}</span>
                    <span class="muted-text">${esc(sm.artifact)}:${sm.line}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">
        <h3 class="panel-title">
          <span class="chip-dot cyan"></span>
          Domain &amp; Environment Topology Map
        </h3>
        <span class="muted-text">Click any host node to inspect code evidence</span>
      </div>
      <div class="panel-body">
        <div class="topology-wrap">${renderTopologySvg(r)}</div>
      </div>
    </div>
  `;

  document.getElementById('ovViewAllDev')?.addEventListener('click', () => {
    state.activeTab = 'dev';
    renderWorkspace();
  });
  document.getElementById('ovViewAllStack')?.addEventListener('click', () => {
    state.activeTab = 'stack';
    renderWorkspace();
  });

  bindInspectTriggers(stage);
}

// --------------------- TAB 2: DEV & PREVIEW SITES ---------------------

function renderDevTab(stage, r) {
  const filters = [
    { id: 'all', label: `All (${r.devSites.length})` },
    { id: 'dev', label: `Dev (${r.devSites.filter((d) => d.envTag === 'dev').length})` },
    { id: 'staging', label: `Staging / QA (${r.devSites.filter((d) => d.envTag === 'staging').length})` },
    { id: 'preview', label: `Preview Deploys (${r.devSites.filter((d) => d.envTag === 'preview').length})` },
    { id: 'local', label: `Local / Internal (${r.devSites.filter((d) => d.envTag === 'local').length})` }
  ];

  const q = state.devSearch.trim().toLowerCase();
  const filtered = r.devSites.filter((d) => {
    if (state.devFilter !== 'all' && d.envTag !== state.devFilter) return false;
    if (q && !d.host.toLowerCase().includes(q) && !(d.reasons || []).join(' ').toLowerCase().includes(q)) return false;
    return true;
  });

  stage.innerHTML = `
    <div class="panel">
      <div class="panel-header">
        <h3 class="panel-title"><span class="chip-dot amber"></span>Discovered Dev, Staging, QA &amp; Preview Surfaces</h3>
        <input type="text" id="devSearchInput" class="code-input compact" style="max-width:260px;" placeholder="Filter dev hosts…" value="${esc(state.devSearch)}" />
      </div>
      <div class="panel-body">
        <div class="toolbar">
          <div class="filter-pills">
            ${filters.map((f) => `
              <button type="button" class="filter-pill ${state.devFilter === f.id ? 'active' : ''}" data-dev-filter="${f.id}">${esc(f.label)}</button>
            `).join('')}
          </div>
          <span class="muted-text mono">${filtered.length} shown</span>
        </div>

        ${filtered.length === 0
          ? '<div class="empty-box">No dev/staging/preview domains match this filter.</div>'
          : `<div class="dev-list">${filtered.map(renderDevItemCard).join('')}</div>`
        }
      </div>
    </div>

    ${r.sourceMaps.length > 0 ? `
      <div class="panel">
        <div class="panel-header">
          <h3 class="panel-title">Exposed Source Map Directives (${r.sourceMaps.length})</h3>
        </div>
        <div class="panel-body">
          <div class="url-list">
            ${r.sourceMaps.map((sm) => `
              <div class="url-row">
                <span>${esc(sm.ref)}</span>
                <span class="muted-text">${esc(sm.artifact)} · line ${sm.line}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    ` : ''}
  `;

  stage.querySelectorAll('[data-dev-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.devFilter = btn.dataset.devFilter;
      renderDevTab(stage, r);
    });
  });

  const searchInput = document.getElementById('devSearchInput');
  searchInput?.addEventListener('input', (e) => {
    state.devSearch = e.target.value;
    renderDevTab(stage, r);
    const next = document.getElementById('devSearchInput');
    if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
  });

  bindInspectTriggers(stage);
}

// --------------------- TAB 3: ALL DOMAINS ---------------------

function renderDomainsTab(stage, r) {
  const cats = [
    { id: 'all', label: `All (${r.domains.length})` },
    { id: 'dev-surface', label: `Dev / Preview (${r.devSites.length})` },
    { id: 'api', label: `API (${r.domains.filter((d) => d.category === 'api').length})` },
    { id: 'first-party', label: `First-Party (${r.domains.filter((d) => d.isFirstParty).length})` },
    { id: 'cdn', label: `CDN (${r.domains.filter((d) => d.category === 'cdn').length})` },
    { id: 'third-party', label: `Third-Party (${r.domains.filter((d) => d.category === 'third-party').length})` },
    { id: 'external', label: `External (${r.domains.filter((d) => d.category === 'external').length})` }
  ];

  const q = state.domainSearch.trim().toLowerCase();
  const filtered = r.domains.filter((d) => {
    if (state.domainFilter === 'dev-surface' && !d.isDevSurface) return false;
    else if (state.domainFilter === 'first-party' && !d.isFirstParty) return false;
    else if (state.domainFilter !== 'all' && state.domainFilter !== 'dev-surface' && state.domainFilter !== 'first-party' && d.category !== state.domainFilter) return false;
    if (q && !d.host.toLowerCase().includes(q) && !(d.vendor || '').toLowerCase().includes(q) && !d.apex.toLowerCase().includes(q)) return false;
    return true;
  });

  stage.innerHTML = `
    <div class="panel">
      <div class="panel-header">
        <h3 class="panel-title">All Extracted Domains &amp; Hosts</h3>
        <div class="row-gap">
          <button type="button" class="btn btn-ghost btn-sm" id="toggleApexGroupBtn">
            ${state.domainGroupByApex ? 'Switch to Host Table' : 'Group by Apex Domain'}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" id="copyFilteredHostsBtn">Copy List</button>
          <input type="text" id="domainSearchInput" class="code-input compact" style="max-width:220px;" placeholder="Search host or vendor…" value="${esc(state.domainSearch)}" />
        </div>
      </div>
      <div class="panel-body">
        <div class="toolbar">
          <div class="filter-pills">
            ${cats.map((c) => `
              <button type="button" class="filter-pill ${state.domainFilter === c.id ? 'active' : ''}" data-dom-filter="${c.id}">${esc(c.label)}</button>
            `).join('')}
          </div>
          <span class="muted-text mono">${filtered.length} hosts</span>
        </div>

        ${state.domainGroupByApex ? renderApexGroupedView(r, filtered) : renderHostsTable(filtered)}
      </div>
    </div>
  `;

  stage.querySelectorAll('[data-dom-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.domainFilter = btn.dataset.domFilter;
      renderDomainsTab(stage, r);
    });
  });

  document.getElementById('toggleApexGroupBtn')?.addEventListener('click', () => {
    state.domainGroupByApex = !state.domainGroupByApex;
    renderDomainsTab(stage, r);
  });

  document.getElementById('copyFilteredHostsBtn')?.addEventListener('click', () => {
    copyText(filtered.map((d) => d.host).join('\n'), `Copied ${filtered.length} hosts`);
  });

  const searchInput = document.getElementById('domainSearchInput');
  searchInput?.addEventListener('input', (e) => {
    state.domainSearch = e.target.value;
    renderDomainsTab(stage, r);
    const next = document.getElementById('domainSearchInput');
    if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
  });

  bindInspectTriggers(stage);
}

function renderHostsTable(list) {
  if (list.length === 0) return '<div class="empty-box">No domains match the current filter.</div>';
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Hostname</th>
            <th>Environment / Role</th>
            <th>Apex</th>
            <th>Vendor / Signal</th>
            <th>Sources</th>
            <th>Hits</th>
          </tr>
        </thead>
        <tbody>
          ${list.map((d) => `
            <tr data-inspect-host="${esc(d.host)}">
              <td class="mono" style="font-weight:700;">
                ${esc(d.host)}${d.ports?.length ? `<span style="color:var(--accent-amber);">:${esc(d.ports[0])}</span>` : ''}
                ${d.isFirstParty ? ' <span class="badge badge-first-party">1P</span>' : ''}
              </td>
              <td><span class="badge badge-${esc(d.isDevSurface ? d.envTag : d.category)}">${esc(d.isDevSurface ? d.envTag : d.category)}</span></td>
              <td class="mono muted-text">${esc(d.apex)}</td>
              <td>${esc(d.vendor || d.reasons?.[0] || '—')}</td>
              <td class="mono muted-text">${d.artifacts?.length || 1} file${(d.artifacts?.length || 1) === 1 ? '' : 's'}</td>
              <td class="mono">${d.occurrences}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderApexGroupedView(r, filtered) {
  const allowedHosts = new Set(filtered.map((d) => d.host));
  const groups = r.apexGroups
    .map((g) => ({ ...g, matchingHosts: g.hosts.filter((h) => allowedHosts.has(h)) }))
    .filter((g) => g.matchingHosts.length > 0);

  if (groups.length === 0) return '<div class="empty-box">No apex domains match the current filter.</div>';

  return `
    <div class="stack-categories">
      ${groups.map((g) => `
        <div class="stack-cat-card">
          <div class="stack-cat-head">
            <span>${esc(g.apex)} ${g.isFirstParty ? '(1st-party)' : ''}</span>
            <span>${g.matchingHosts.length} host${g.matchingHosts.length === 1 ? '' : 's'}</span>
          </div>
          <div class="stack-items">
            ${g.matchingHosts.map((host) => {
              const info = r.domains.find((d) => d.host === host);
              return `
                <button type="button" class="artifact-btn" data-inspect-host="${esc(host)}">
                  <span class="artifact-name">${esc(host)}</span>
                  <span class="artifact-meta">${esc(info?.isDevSurface ? info.envTag.toUpperCase() : info?.category || '')} · ${info?.occurrences || 0} hits</span>
                </button>
              `;
            }).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// --------------------- TAB 4: BUILD STACK ---------------------

function renderStackTab(stage, r) {
  const cats = Object.entries(r.stack.byCategory || {});
  const sec = r.stack.securityHeaders || {};

  stage.innerHTML = `
    ${cats.length === 0
      ? '<div class="panel"><div class="panel-body"><div class="empty-box">No technology fingerprints detected in the scanned code.</div></div></div>'
      : `
        <div class="stack-categories">
          ${cats.map(([cat, items]) => `
            <div class="stack-cat-card">
              <div class="stack-cat-head">
                <span>${esc(cat)}</span>
                <span>${items.length}</span>
              </div>
              <div class="stack-items">
                ${items.map((t) => `
                  <div class="tech-card">
                    <div class="tech-top">
                      <div class="tech-name">
                        <span class="tech-swatch" style="background:${esc(t.color || '#94a3b8')}"></span>
                        <span>${esc(t.name)}</span>
                        ${t.version ? `<span class="tech-ver">v${esc(t.version)}</span>` : ''}
                      </div>
                      <span class="badge ${t.confidence === 'high' ? 'badge-first-party' : t.confidence === 'medium' ? 'badge-api' : 'badge-neutral'}">${esc(t.confidence)}</span>
                    </div>
                    <div class="tech-proof">
                      ${(t.evidence || []).slice(0, 3).map((ev) => `
                        <div title="${esc(ev.source + ': ' + ev.detail)}">↳ ${esc(ev.source)}: ${esc(ev.detail)}</div>
                      `).join('')}
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      `
    }

    ${r.stack.scripts?.length > 0 ? `
      <div class="panel" style="margin-top:16px;">
        <div class="panel-header">
          <h3 class="panel-title">Build &amp; Dev Scripts (package.json)</h3>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Script</th><th>Command</th><th>File</th></tr></thead>
            <tbody>
              ${r.stack.scripts.map((s) => `
                <tr>
                  <td class="mono" style="color:var(--accent-cyan);font-weight:700;">${esc(s.name)}</td>
                  <td class="mono">${esc(s.command)}</td>
                  <td class="mono muted-text">${esc(s.artifact)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    ` : ''}

    <div class="panel" style="margin-top:16px;">
      <div class="panel-header">
        <h3 class="panel-title">HTTP Headers &amp; Web Platform Signals</h3>
        <span class="muted-text mono">${r.stack.platformSignals.headerCount} response headers captured</span>
      </div>
      <div class="panel-body">
        <div class="sec-grid">
          <div class="sec-item"><span class="sec-key">Server Header</span><span class="sec-val">${esc(sec.server || 'Hidden / Not Captured')}</span></div>
          <div class="sec-item"><span class="sec-key">X-Powered-By</span><span class="sec-val">${esc(sec.poweredBy || 'None')}</span></div>
          <div class="sec-item"><span class="sec-key">Content-Security-Policy</span><span class="sec-val ${sec.csp ? 'ok' : 'warn'}">${sec.csp ? 'Present' : 'Not detected'}</span></div>
          <div class="sec-item"><span class="sec-key">HSTS</span><span class="sec-val ${sec.hsts ? 'ok' : 'warn'}">${sec.hsts ? 'Enabled' : 'Not detected'}</span></div>
          <div class="sec-item"><span class="sec-key">PWA Manifest</span><span class="sec-val ${r.stack.platformSignals.hasManifest ? 'ok' : ''}">${r.stack.platformSignals.hasManifest ? 'Detected' : 'None'}</span></div>
          <div class="sec-item"><span class="sec-key">Service Worker</span><span class="sec-val ${r.stack.platformSignals.hasServiceWorker ? 'ok' : ''}">${r.stack.platformSignals.hasServiceWorker ? 'Registered' : 'None'}</span></div>
        </div>
      </div>
    </div>
  `;
}

// --------------------- TAB 5: SOURCE & HEADERS ---------------------

function renderCodeTab(stage, r) {
  const selected = r.artifacts.find((a) => a.id === state.selectedArtifactId) || r.artifacts[0] || null;
  const headerEntries = Object.entries(r.headers || {});
  const q = state.codeSearch.trim();

  let searchResultsHtml = '';
  if (q.length >= 2) {
    const matches = [];
    const lowerQ = q.toLowerCase();
    for (const art of r.artifacts) {
      const lines = (art.content || '').split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < 40; i++) {
        const idx = lines[i].toLowerCase().indexOf(lowerQ);
        if (idx !== -1) {
          const start = Math.max(0, idx - 50);
          const end = Math.min(lines[i].length, idx + q.length + 70);
          matches.push({
            artifactId: art.id,
            artifact: art.name,
            line: i + 1,
            snippet: lines[i].slice(start, end)
          });
        }
      }
    }
    searchResultsHtml = `
      <div class="panel">
        <div class="panel-header">
          <h3 class="panel-title">Global Source Search: "${esc(q)}" (${matches.length}${matches.length === 40 ? '+' : ''} matches)</h3>
        </div>
        <div class="panel-body">
          ${matches.length === 0
            ? '<div class="empty-box">No matches found across crawled files.</div>'
            : `<div class="dev-list">
                ${matches.map((m) => `
                  <div class="snippet-box" style="cursor:pointer;" data-open-art="${esc(m.artifactId)}">
                    <span class="snippet-loc">${esc(m.artifact)}:${m.line}</span>${highlightHostInSnippet(m.snippet, q)}
                  </div>
                `).join('')}
              </div>`
          }
        </div>
      </div>
    `;
  }

  const previewText = selected ? (selected.content || '').slice(0, 80000) : '';
  const truncatedNote = selected && (selected.content || '').length > 80000 ? `\n\n… [Preview truncated at 80 KB of ${formatBytes(selected.bytes)}]` : '';

  stage.innerHTML = `
    <div class="panel">
      <div class="panel-header">
        <h3 class="panel-title">Search Across All Crawled Source Code</h3>
        <input type="text" id="globalCodeSearch" class="code-input compact" style="max-width:340px;" placeholder="Search URLs, keys, endpoints, frameworks…" value="${esc(state.codeSearch)}" />
      </div>
    </div>

    ${searchResultsHtml}

    <div class="panel">
      <div class="panel-header">
        <h3 class="panel-title">Inspected Source Artifacts (${r.artifacts.length})</h3>
        ${selected ? `<span class="muted-text mono">${esc(selected.name)} · ${formatBytes(selected.bytes)} · ${selected.lines.toLocaleString()} lines</span>` : ''}
      </div>
      <div class="panel-body">
        <div class="code-layout">
          <div class="artifact-list">
            ${r.artifacts.map((a) => `
              <button type="button" class="artifact-btn ${selected?.id === a.id ? 'active' : ''}" data-select-art="${esc(a.id)}">
                <span class="artifact-name" title="${esc(a.name)}">${esc(a.name)}</span>
                <span class="artifact-meta">${esc(a.type.toUpperCase())} · ${formatBytes(a.bytes)}</span>
              </button>
            `).join('')}
          </div>
          <pre class="code-viewer">${esc(previewText + truncatedNote)}</pre>
        </div>
      </div>
    </div>

    ${headerEntries.length > 0 ? `
      <div class="panel">
        <div class="panel-header">
          <h3 class="panel-title">Captured HTTP Response Headers (${headerEntries.length})</h3>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Header</th><th>Value</th></tr></thead>
            <tbody>
              ${headerEntries.map(([k, v]) => `
                <tr>
                  <td class="mono" style="color:var(--accent-cyan);white-space:nowrap;">${esc(k)}</td>
                  <td class="mono" style="word-break:break-all;">${esc(v)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    ` : ''}
  `;

  stage.querySelectorAll('[data-select-art]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedArtifactId = btn.dataset.selectArt;
      renderCodeTab(stage, r);
    });
  });

  stage.querySelectorAll('[data-open-art]').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedArtifactId = el.dataset.openArt;
      renderCodeTab(stage, r);
    });
  });

  const searchEl = document.getElementById('globalCodeSearch');
  searchEl?.addEventListener('input', (e) => {
    state.codeSearch = e.target.value;
    renderCodeTab(stage, r);
    const next = document.getElementById('globalCodeSearch');
    if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
  });
}

// ===================== EVIDENCE DRAWER =====================

function bindInspectTriggers(container) {
  container.querySelectorAll('[data-inspect-host]').forEach((el) => {
    el.addEventListener('click', () => openEvidenceDrawer(el.dataset.inspectHost));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEvidenceDrawer(el.dataset.inspectHost);
      }
    });
  });
}

function openEvidenceDrawer(host) {
  if (!state.report) return;
  const domain = state.report.domains.find((d) => d.host === host);
  if (!domain) return;

  document.getElementById('drawerEyebrow').textContent = domain.isDevSurface
    ? `DEV / STAGING / PREVIEW SURFACE · ${domain.envTag.toUpperCase()}`
    : `DISCOVERED HOST · ${domain.category.toUpperCase()}`;
  document.getElementById('drawerTitle').textContent = domain.host;

  const body = document.getElementById('drawerBody');
  body.innerHTML = `
    <div class="row-gap" style="flex-wrap:wrap;">
      <span class="badge badge-${esc(domain.isDevSurface ? domain.envTag : domain.category)}">${esc(domain.isDevSurface ? domain.envTag : domain.category)}</span>
      ${domain.isFirstParty ? '<span class="badge badge-first-party">First-Party</span>' : '<span class="badge badge-neutral">Third-Party</span>'}
      ${domain.vendor ? `<span class="badge badge-api">${esc(domain.vendor)}</span>` : ''}
      <span class="badge badge-neutral">Apex: ${esc(domain.apex)}</span>
      <span class="badge badge-neutral">${domain.occurrences} hits</span>
    </div>

    <div class="drawer-section">
      <h4>Classification Signals</h4>
      <div class="url-list">
        ${(domain.reasons || []).map((reason) => `<div class="url-row"><span>${esc(reason)}</span></div>`).join('')}
      </div>
    </div>

    <div class="drawer-section">
      <h4>Discovered URLs (${domain.urls.length})</h4>
      <div class="url-list">
        ${domain.urls.map((u) => {
          const href = safeHref(u);
          return `
            <div class="url-row">
              ${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(href)}">${esc(u)}</a>` : `<span>${esc(u)}</span>`}
              <button type="button" class="btn btn-ghost btn-sm" data-copy-val="${esc(u)}">Copy</button>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <div class="drawer-section">
      <h4>Code &amp; Header Evidence (${domain.evidence.length})</h4>
      <div class="dev-list">
        ${domain.evidence.map((ev) => `
          <div class="snippet-box" style="white-space:pre-wrap;word-break:break-all;">
            <div class="snippet-loc">${esc(ev.artifact)} · line ${ev.line} (${esc(ev.sourceType)})</div>
            <div>${highlightHostInSnippet(ev.snippet, domain.host)}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  body.querySelectorAll('[data-copy-val]').forEach((btn) => {
    btn.addEventListener('click', () => copyText(btn.dataset.copyVal, 'Copied URL'));
  });

  document.getElementById('drawerBackdrop').classList.remove('hidden');
  document.getElementById('evidenceDrawer').classList.remove('hidden');
}

function closeAllDrawers() {
  document.getElementById('drawerBackdrop').classList.add('hidden');
  document.getElementById('evidenceDrawer').classList.add('hidden');
  document.getElementById('historyDrawer').classList.add('hidden');
}

// ===================== HISTORY DRAWER =====================

function openHistoryDrawer() {
  const body = document.getElementById('historyBody');
  if (state.history.length === 0) {
    body.innerHTML = '<div class="empty-box">No scans saved yet. Run a scan or click a Quick Launch preset.</div>';
  } else {
    body.innerHTML = state.history.map((h, idx) => `
      <div class="history-card" data-load-history="${idx}">
        <div class="dev-item-top">
          <strong class="mono">${esc(h.target)}</strong>
          <span class="badge badge-neutral">${esc(h.mode)}</span>
        </div>
        <div class="muted-text mono">${h.counts.devSites} dev · ${h.counts.totalDomains} hosts · ${h.counts.technologies} stack</div>
        <div class="muted-text" style="font-size:11px;">${esc(new Date(h.scannedAt).toLocaleString())}</div>
      </div>
    `).join('');

    body.querySelectorAll('[data-load-history]').forEach((card) => {
      card.addEventListener('click', () => {
        const item = state.history[Number(card.dataset.loadHistory)];
        if (item) {
          state.report = item;
          state.activeTab = 'overview';
          state.selectedArtifactId = item.artifacts?.[0]?.id || null;
          closeAllDrawers();
          setHudTab('inspector');
          renderWorkspace();
        }
      });
    });
  }

  document.getElementById('drawerBackdrop').classList.remove('hidden');
  document.getElementById('historyDrawer').classList.remove('hidden');
}

// ===================== WORKER MODAL =====================

let workerCodeCache = '';

async function openWorkerModal() {
  document.getElementById('workerModal').classList.remove('hidden');
  const pre = document.getElementById('workerCodePreview');
  if (!workerCodeCache) {
    try {
      const res = await fetch('./worker/cloudflare-worker.js');
      workerCodeCache = res.ok ? await res.text() : '// See worker/cloudflare-worker.js in repository';
    } catch {
      workerCodeCache = '// See worker/cloudflare-worker.js in repository';
    }
  }
  pre.textContent = workerCodeCache;
}

// ===================== FILE DROP HANDLING =====================

async function readDroppedFiles(fileList) {
  const files = [...fileList].slice(0, 15);
  const loaded = [];
  for (const file of files) {
    if (file.size > 4_000_000) continue;
    const content = await file.text();
    loaded.push({ name: file.name, content, bytes: file.size });
  }
  state.attachedFiles = [...state.attachedFiles, ...loaded].slice(0, 15);
  updateAttachedFilesUI();
}

function updateAttachedFilesUI() {
  const el = document.getElementById('droppedFilesList');
  if (state.attachedFiles.length === 0) {
    el.textContent = 'No files attached · Supports HTML, JS, CSS, JSON, YAML, TOML, .HAR';
  } else {
    el.textContent = `Attached (${state.attachedFiles.length}): ${state.attachedFiles.map((f) => f.name).join(', ')}`;
  }
}

// ===================== TOP HUD TABS (2 PRIMARY TABS) =====================

function setHudTab(tabId, { updateHash = true } = {}) {
  const target = VALID_HUD_TABS.has(tabId) ? tabId : 'subdomains';
  state.hudTab = target;

  document.querySelectorAll('[data-hud-tab]').forEach((btn) => {
    const active = btn.dataset.hudTab === target;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });

  document.querySelectorAll('[data-hud-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.hudPanel !== target);
  });

  if (updateHash && location.hash !== `#${target}`) {
    history.replaceState(null, '', `#${target}`);
  }
}

function getRuntimeContext() {
  return {
    serverAvailable: state.serverAvailable,
    workerUrl: document.getElementById('optWorkerUrl')?.value?.trim() || ''
  };
}

// ===================== BOOTSTRAP & EVENTS =====================

async function init() {
  // Restore theme
  const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);

  loadSettings();
  loadHistory();

  // Initialize Tab 1 (Subdomains powered by subdomain.app)
  const subdomains = createSubdomainsController({
    container: document.getElementById('panel-subdomains'),
    getContext: getRuntimeContext,
    copyText,
    showToast,
    onInspectHost: (url) => {
      setHudTab('inspector');
      setMode('website');
      const input = document.getElementById('websiteInput');
      if (input) input.value = url;
      handleWebsiteScan(url);
    }
  });
  subdomains.init();

  // Restore initial top HUD tab from URL hash (defaults to Tab 1: Subdomains)
  const initialHash = location.hash.replace(/^#/, '').toLowerCase();
  setHudTab(VALID_HUD_TABS.has(initialHash) ? initialHash : 'subdomains', { updateHash: false });

  document.querySelectorAll('[data-hud-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setHudTab(btn.dataset.hudTab));
  });

  window.addEventListener('hashchange', () => {
    const h = location.hash.replace(/^#/, '').toLowerCase();
    if (VALID_HUD_TABS.has(h)) setHudTab(h, { updateHash: false });
  });

  // Check if Node server engine is running
  const health = await checkServerAvailability();
  state.serverAvailable = health.available;
  const pill = document.getElementById('engineStatusPill');
  const pillText = document.getElementById('engineStatusText');
  if (health.available) {
    pill.classList.add('online');
    pillText.textContent = 'Server Ready';
  } else {
    pill.classList.add('relay');
    pillText.textContent = 'Browser Live';
  }

  // Brand click returns to Tab 1 (Subdomains)
  document.getElementById('brandReset').addEventListener('click', (e) => {
    e.preventDefault();
    setHudTab('subdomains');
  });

  // Theme toggle
  document.getElementById('themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(STORAGE_KEYS.THEME, next);
  });

  // Inspector input mode tabs
  document.querySelectorAll('.mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // Options toggle
  const toggleOptions = () => {
    const drawer = document.getElementById('optionsDrawer');
    const isHidden = drawer.classList.toggle('hidden');
    document.getElementById('optionsToggleBtn')?.setAttribute('aria-expanded', String(!isHidden));
  };
  document.getElementById('optionsToggleBtn')?.addEventListener('click', toggleOptions);

  // Save settings on change
  ['optMaxBundles', 'optTransport', 'optWorkerUrl', 'optGithubToken', 'optProbeMeta'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', saveSettings);
  });

  // Website form submit
  document.getElementById('websiteForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleWebsiteScan(document.getElementById('websiteInput').value);
  });

  // GitHub form submit
  document.getElementById('githubForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleGitHubScan(document.getElementById('githubInput').value);
  });

  // Source form submit
  document.getElementById('sourceForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const label = document.getElementById('sourceLabelInput').value.trim();
    const text = document.getElementById('sourceTextarea').value;
    const targetUrl = /^https?:\/\//i.test(label) ? label : '';
    try {
      const report = scanRawArtifacts({
        label: label || 'Local Source Analysis',
        text,
        files: state.attachedFiles,
        targetUrl
      });
      state.report = report;
      state.activeTab = 'overview';
      state.selectedArtifactId = report.artifacts?.[0]?.id || null;
      pushHistory(report);
      setStatus(null, '');
      renderWorkspace();
    } catch (err) {
      setStatus('error', err.message);
    }
  });

  document.getElementById('sourceFileInput').addEventListener('change', (e) => {
    if (e.target.files?.length) readDroppedFiles(e.target.files);
  });

  document.getElementById('clearSourceBtn').addEventListener('click', () => {
    document.getElementById('sourceTextarea').value = '';
    document.getElementById('sourceLabelInput').value = '';
    state.attachedFiles = [];
    updateAttachedFilesUI();
  });

  // Drag & drop on raw source box
  const dropZone = document.querySelector('.source-textarea-wrap');
  ['dragenter', 'dragover'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    });
  });
  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) readDroppedFiles(e.dataTransfer.files);
  });

  // Quick presets
  document.querySelectorAll('[data-preset]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const val = chip.dataset.preset;
      if (val === 'sample') {
        handleSampleScan();
      } else if (val.startsWith('url:')) {
        const u = val.slice(4);
        setMode('website');
        document.getElementById('websiteInput').value = u;
        handleWebsiteScan(u);
      } else if (val.startsWith('git:')) {
        const repo = val.slice(4);
        setMode('github');
        document.getElementById('githubInput').value = repo;
        handleGitHubScan(repo);
      }
    });
  });

  // Result subtabs
  document.querySelectorAll('#resultTabs .subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tab;
      renderWorkspace();
    });
  });

  // Exports
  document.getElementById('copyDevBtn').addEventListener('click', () => {
    if (!state.report) return;
    const hosts = state.report.devSites.map((d) => d.host);
    if (hosts.length === 0) return showToast('No dev/staging hosts to copy');
    copyText(hosts.join('\n'), `Copied ${hosts.length} dev/staging hosts`);
  });
  document.getElementById('exportJsonBtn').addEventListener('click', () => state.report && exportReportJson(state.report));
  document.getElementById('exportCsvBtn').addEventListener('click', () => state.report && exportDomainsCsv(state.report));
  document.getElementById('exportMdBtn').addEventListener('click', () => state.report && exportReportMarkdown(state.report));

  // Drawers & Modals
  document.getElementById('drawerCloseBtn').addEventListener('click', closeAllDrawers);
  document.getElementById('historyCloseBtn').addEventListener('click', closeAllDrawers);
  document.getElementById('drawerBackdrop').addEventListener('click', closeAllDrawers);
  document.getElementById('historyBtn').addEventListener('click', openHistoryDrawer);
  document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    state.history = [];
    localStorage.removeItem(STORAGE_KEYS.HISTORY);
    updateHistoryBadge();
    openHistoryDrawer();
  });

  document.getElementById('workerGuideBtn').addEventListener('click', openWorkerModal);
  document.getElementById('workerModalClose').addEventListener('click', () => {
    document.getElementById('workerModal').classList.add('hidden');
  });
  document.getElementById('workerModal').addEventListener('click', (e) => {
    if (e.target.id === 'workerModal') e.target.classList.add('hidden');
  });
  document.getElementById('copyWorkerCodeBtn').addEventListener('click', () => {
    if (workerCodeCache) copyText(workerCodeCache, 'Copied Cloudflare Worker code');
  });

  // Escape closes drawers/modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllDrawers();
      document.getElementById('workerModal').classList.add('hidden');
    }
  });
}

init();
