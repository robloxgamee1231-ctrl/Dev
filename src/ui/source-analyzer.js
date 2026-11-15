// Source Code Analyzer View (DEVTRACER — made by ★NDX★)
// Surfaces technology fingerprints, framework configurations, publicly referenced
// API endpoints, and exposed config references WITHOUT collecting or revealing secret values.

function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createSourceAnalyzerController({ container, getReport, onAnalyzeText, onTestEndpoint, copyText }) {
  const state = {
    filter: 'all', // 'all' | 'endpoints' | 'configs' | 'refs'
    search: ''
  };

  function render() {
    const report = getReport();
    const intel = report?.sourceIntel || {
      apiEndpoints: [],
      frameworkConfigs: [],
      configReferences: [],
      counts: { apiEndpoints: 0, frameworkConfigs: 0, configReferences: 0, redactedReferences: 0 }
    };
    const q = state.search.trim().toLowerCase();

    const endpoints = intel.apiEndpoints.filter(
      (e) => !q || e.url.toLowerCase().includes(q) || e.artifact.toLowerCase().includes(q) || e.kind.toLowerCase().includes(q)
    );
    const configs = intel.frameworkConfigs.filter(
      (c) => !q || c.framework.toLowerCase().includes(q) || c.detail.toLowerCase().includes(q) || c.artifact.toLowerCase().includes(q)
    );
    const refs = intel.configReferences.filter(
      (r) => !q || r.keyName.toLowerCase().includes(q) || r.category.toLowerCase().includes(q) || r.artifact.toLowerCase().includes(q)
    );

    container.innerHTML = `
      <div class="view-header">
        <div>
          <span class="section-eyebrow">PUBLIC SOURCE CODE INTELLIGENCE</span>
          <h1 class="view-title">Source Code Analyzer</h1>
          <p class="view-subtitle">Analyzes publicly accessible HTML, CSS, JavaScript, and config artifacts to map framework configurations, publicly referenced API endpoints, and exposed configuration keys while strictly redacting any secret values.</p>
        </div>
        <span class="badge badge-first-party">ZERO SECRET COLLECTION POLICY</span>
      </div>

      ${!report ? `
        <div class="panel glass-surface" style="margin-bottom:16px;">
          <div class="panel-header">
            <h3 class="panel-title">Analyze Public Source Code Directly</h3>
            <span class="muted-text mono">Or run any Website / GitHub scan from the top bar</span>
          </div>
          <div class="panel-body">
            <form id="saQuickForm">
              <textarea id="saQuickTextarea" class="code-textarea" rows="6" placeholder="Paste public HTML, JavaScript bundle, next.config.js, package.json, or DevTools HAR capture…"></textarea>
              <div class="row-gap" style="justify-content:flex-end;margin-top:10px;">
                <button type="submit" class="btn btn-primary btn-sm">Analyze Source Code</button>
              </div>
            </form>
          </div>
        </div>
      ` : `
        <div class="kpi-strip">
          <div class="kpi-card glass-surface">
            <div class="kpi-label">Tech Fingerprints</div>
            <div class="kpi-value cyan">${report.counts.technologies}</div>
            <div class="kpi-sub">${esc(report.target)}</div>
          </div>
          <div class="kpi-card glass-surface">
            <div class="kpi-label">Framework Configs</div>
            <div class="kpi-value green">${intel.counts.frameworkConfigs}</div>
            <div class="kpi-sub">SSR payloads, configs &amp; manifests</div>
          </div>
          <div class="kpi-card glass-surface">
            <div class="kpi-label">Referenced APIs</div>
            <div class="kpi-value violet">${intel.counts.apiEndpoints}</div>
            <div class="kpi-sub">REST · GraphQL · WebSocket · OpenAPI</div>
          </div>
          <div class="kpi-card glass-surface spotlight">
            <div class="kpi-label">Config References</div>
            <div class="kpi-value amber">${intel.counts.configReferences}</div>
            <div class="kpi-sub">${intel.counts.redactedReferences} sensitive values auto-redacted</div>
          </div>
        </div>

        <div class="toolbar" style="margin-top:6px;">
          <div class="filter-pills">
            <button type="button" class="filter-pill ${state.filter === 'all' ? 'active' : ''}" data-sa-filter="all">All Sections</button>
            <button type="button" class="filter-pill ${state.filter === 'endpoints' ? 'active' : ''}" data-sa-filter="endpoints">API Endpoints (${endpoints.length})</button>
            <button type="button" class="filter-pill ${state.filter === 'configs' ? 'active' : ''}" data-sa-filter="configs">Framework Configs (${configs.length})</button>
            <button type="button" class="filter-pill ${state.filter === 'refs' ? 'active' : ''}" data-sa-filter="refs">Config References (${refs.length})</button>
          </div>
          <input type="text" id="saSearchInput" class="code-input compact" style="max-width:240px;" placeholder="Filter endpoints, configs, keys…" value="${esc(state.search)}" />
        </div>

        <!-- 1. Publicly Referenced API Endpoints -->
        ${(state.filter === 'all' || state.filter === 'endpoints') ? `
          <div class="panel glass-surface" style="margin-bottom:16px;">
            <div class="panel-header">
              <h3 class="panel-title">Publicly Referenced API Endpoints <span class="tab-badge">${endpoints.length}</span></h3>
              <span class="muted-text mono">Click Test to inspect live status &amp; headers in API Inspector</span>
            </div>
            <div class="panel-body">
              ${endpoints.length === 0
                ? '<div class="empty-box">No public API endpoint references found in the scanned source artifacts.</div>'
                : `
                  <div class="table-wrap">
                    <table class="data-table">
                      <thead>
                        <tr>
                          <th>Method</th>
                          <th>Kind</th>
                          <th>Endpoint URL / Path</th>
                          <th>Source Location</th>
                          <th style="text-align:right;">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${endpoints.slice(0, 80).map((ep) => `
                          <tr>
                            <td><span class="badge badge-api">${esc(ep.method)}</span></td>
                            <td><span class="badge ${ep.kind === 'GraphQL' ? 'badge-cdn' : ep.kind === 'WebSocket' ? 'badge-dev' : 'badge-neutral'}">${esc(ep.kind)}</span></td>
                            <td class="mono" style="word-break:break-all;font-size:12px;">${esc(ep.url)}</td>
                            <td class="mono muted-text" style="font-size:11.5px;">${esc(ep.artifact)}:${ep.line}</td>
                            <td style="text-align:right;white-space:nowrap;">
                              <button type="button" class="btn btn-glass btn-xs" data-sa-copy="${esc(ep.url)}">Copy</button>
                              ${ep.method !== 'WS' ? `<button type="button" class="btn btn-glass btn-xs" data-sa-test="${esc(ep.url)}" data-sa-method="${esc(ep.method)}">Test →</button>` : ''}
                            </td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                  </div>
                `
              }
            </div>
          </div>
        ` : ''}

        <!-- 2. Framework Configurations -->
        ${(state.filter === 'all' || state.filter === 'configs') ? `
          <div class="panel glass-surface" style="margin-bottom:16px;">
            <div class="panel-header">
              <h3 class="panel-title">Framework &amp; Build Configurations <span class="tab-badge">${configs.length}</span></h3>
            </div>
            <div class="panel-body">
              ${configs.length === 0
                ? '<div class="empty-box">No explicit framework configuration markers detected in these artifacts.</div>'
                : `
                  <div class="tech-grid">
                    ${configs.map((c) => `
                      <div class="tech-card">
                        <div class="tech-top">
                          <span class="tech-name">${esc(c.framework)}</span>
                          <span class="badge badge-api">${esc(c.kind)}</span>
                        </div>
                        <div class="tech-evidence">${esc(c.detail)}</div>
                        <div class="muted-text mono" style="font-size:10.5px;margin-top:6px;">${esc(c.artifact)}:${c.line}</div>
                      </div>
                    `).join('')}
                  </div>
                `
              }
            </div>
          </div>
        ` : ''}

        <!-- 3. Exposed Configuration References (Secret Values Strictly Redacted) -->
        ${(state.filter === 'all' || state.filter === 'refs') ? `
          <div class="panel glass-surface">
            <div class="panel-header">
              <h3 class="panel-title">Exposed Configuration References <span class="tab-badge amber">${refs.length}</span></h3>
              <span class="badge badge-first-party">Secret Values Never Collected</span>
            </div>
            <div class="panel-body">
              ${refs.length === 0
                ? '<div class="empty-box">No exposed environment or configuration references detected in these artifacts.</div>'
                : `
                  <div class="table-wrap">
                    <table class="data-table">
                      <thead>
                        <tr>
                          <th>Key / Reference</th>
                          <th>Category</th>
                          <th>Safe Preview</th>
                          <th>Location</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${refs.map((r) => `
                          <tr>
                            <td class="mono" style="font-weight:600;">${esc(r.keyName)}</td>
                            <td><span class="badge ${r.severity === 'review' ? 'badge-dev' : 'badge-neutral'}">${esc(r.category)}</span></td>
                            <td class="mono" style="font-size:11.5px;color:${r.redacted ? 'var(--amber)' : 'var(--text-secondary)'};">${esc(r.valuePreview)}</td>
                            <td class="mono muted-text" style="font-size:11.5px;">${esc(r.artifact)}:${r.line}</td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                  </div>
                `
              }
            </div>
          </div>
        ` : ''}
      `}
    `;

    container.querySelector('#saQuickForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = container.querySelector('#saQuickTextarea')?.value || '';
      if (onAnalyzeText) onAnalyzeText(text);
    });
    container.querySelectorAll('[data-sa-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filter = btn.dataset.saFilter;
        render();
      });
    });
    const sEl = container.querySelector('#saSearchInput');
    sEl?.addEventListener('input', (e) => {
      state.search = e.target.value;
      render();
      const next = container.querySelector('#saSearchInput');
      if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
    });
    container.querySelectorAll('[data-sa-copy]').forEach((btn) => {
      btn.addEventListener('click', () => copyText(btn.dataset.saCopy, 'Copied endpoint URL'));
    });
    container.querySelectorAll('[data-sa-test]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (onTestEndpoint) onTestEndpoint({ url: btn.dataset.saTest, method: btn.dataset.saMethod });
      });
    });
  }

  function setSearchFilter(q) {
    state.search = q;
    render();
  }

  return { init: render, render, setSearchFilter };
}
