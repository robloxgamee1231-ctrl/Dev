// API Inspector Module (DEVTRACER — made by ★NDX★)
// Displays publicly documented OpenAPI / discovered site API endpoints,
// identifies HTTP methods, status codes, and response headers, and supports
// authorized API testing using server-side encrypted Vault credentials.

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prettyBody(raw, contentType = '') {
  if (!raw) return '(Empty response body)';
  if (contentType.includes('json') || /^\s*[{[]/.test(raw)) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {}
  }
  return raw;
}

function statusBadgeClass(code) {
  if (code >= 200 && code < 300) return 'badge-first-party';
  if (code >= 300 && code < 400) return 'badge-api';
  if (code >= 400 && code < 500) return 'badge-dev';
  return 'badge-danger';
}

export function parseOpenApiSpec(spec, specUrl = '') {
  if (!spec || typeof spec !== 'object' || !spec.paths || typeof spec.paths !== 'object') {
    throw new Error('Not a valid OpenAPI / Swagger JSON document (missing "paths").');
  }
  let baseUrl = '';
  if (Array.isArray(spec.servers) && spec.servers[0]?.url) {
    baseUrl = spec.servers[0].url;
    if (baseUrl.startsWith('/') && specUrl) {
      try { baseUrl = new URL(baseUrl, specUrl).origin + baseUrl; } catch {}
    }
  } else if (spec.host) {
    const scheme = Array.isArray(spec.schemes) && spec.schemes[0] ? spec.schemes[0] : 'https';
    baseUrl = `${scheme}://${spec.host}${spec.basePath || ''}`;
  } else if (specUrl) {
    try { baseUrl = new URL(specUrl).origin; } catch {}
  }

  const endpoints = [];
  for (const [routePath, ops] of Object.entries(spec.paths)) {
    if (!ops || typeof ops !== 'object') continue;
    for (const [m, def] of Object.entries(ops)) {
      const method = m.toUpperCase();
      if (!METHODS.includes(method)) continue;
      const fullUrl = baseUrl ? `${baseUrl.replace(/\/+$/, '')}${routePath}` : routePath;
      endpoints.push({
        method,
        path: routePath,
        url: fullUrl,
        summary: def?.summary || def?.operationId || '',
        tag: Array.isArray(def?.tags) && def.tags[0] ? def.tags[0] : 'OpenAPI'
      });
    }
  }
  return {
    title: spec.info?.title || 'OpenAPI Specification',
    version: spec.info?.version || '',
    baseUrl,
    endpoints
  };
}

export function createApiInspectorController({ container, getContext, getDiscoveredEndpoints, getVaultCredentials, copyText, showToast }) {
  const state = {
    method: 'GET',
    url: 'https://api.github.com/repos/vitejs/vite',
    credentialId: '',
    customHeadersText: '',
    bodyText: '',
    loading: false,
    error: '',
    response: null,
    responseTab: 'body', // 'body' | 'headers'
    openApiUrl: '',
    openApiLoading: false,
    openApiDoc: null,
    history: []
  };

  async function sendRequest() {
    if (state.loading) return;
    const url = state.url.trim();
    if (!url) {
      state.error = 'Enter an API endpoint URL to test.';
      render();
      return;
    }

    let customHeaders = {};
    if (state.customHeadersText.trim()) {
      try {
        customHeaders = JSON.parse(state.customHeadersText);
      } catch {
        state.error = 'Custom Headers must be valid JSON (e.g. {"Accept": "application/json"}).';
        render();
        return;
      }
    }

    const ctx = getContext();
    state.loading = true;
    state.error = '';
    render();

    try {
      let result;
      if (ctx.serverAvailable) {
        const res = await fetch('./api/inspect-endpoint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url,
            method: state.method,
            headers: customHeaders,
            body: state.method !== 'GET' && state.method !== 'HEAD' ? state.bodyText : null,
            credentialId: state.credentialId || ''
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        result = data;
      } else {
        if (state.credentialId) {
          throw new Error('Authenticated Vault requests require the local DEVTRACER backend (npm start).');
        }
        const started = Date.now();
        const opts = {
          method: state.method,
          headers: { Accept: 'application/json, text/plain, */*', ...customHeaders },
          signal: AbortSignal.timeout(10_000)
        };
        if (state.method !== 'GET' && state.method !== 'HEAD' && state.bodyText.trim()) {
          opts.body = state.bodyText;
        }
        const r = await fetch(url, opts);
        const latencyMs = Math.max(1, Date.now() - started);
        const headers = {};
        r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        const text = state.method === 'HEAD' ? '' : (await r.text()).slice(0, 40_000);
        result = {
          ok: r.ok,
          status: r.status,
          statusText: r.statusText || '',
          method: state.method,
          url: r.url || url,
          latencyMs,
          contentType: headers['content-type'] || '',
          bytes: text.length,
          headers,
          bodyPreview: text,
          authUsed: null
        };
      }

      state.response = result;
      state.history = [
        { method: result.method, url: result.url, status: result.status, latencyMs: result.latencyMs, at: new Date().toLocaleTimeString() },
        ...state.history.filter((h) => h.url !== result.url || h.method !== result.method)
      ].slice(0, 10);
      showToast(`${result.method} ${result.status} (${result.latencyMs}ms)`);
    } catch (err) {
      state.error = err?.message || 'API request failed (check CORS or start local DEVTRACER server).';
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadOpenApiSpec(rawUrl) {
    const specUrl = String(rawUrl || '').trim();
    if (!specUrl) return;
    state.openApiUrl = specUrl;
    state.openApiLoading = true;
    state.error = '';
    render();
    const ctx = getContext();
    try {
      let json;
      if (ctx.serverAvailable) {
        const res = await fetch('./api/inspect-endpoint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: specUrl, method: 'GET', credentialId: state.credentialId || '' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        json = JSON.parse(data.bodyPreview);
      } else {
        const r = await fetch(specUrl, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        json = await r.json();
      }
      state.openApiDoc = parseOpenApiSpec(json, specUrl);
      showToast(`Loaded ${state.openApiDoc.endpoints.length} endpoints from ${state.openApiDoc.title}`);
    } catch (err) {
      state.error = `OpenAPI load failed: ${err?.message || 'invalid spec or blocked by CORS'}`;
    } finally {
      state.openApiLoading = false;
      render();
    }
  }

  function prefill({ url, method = 'GET', credentialId = '' }) {
    if (url) state.url = url;
    if (method && METHODS.includes(method.toUpperCase())) state.method = method.toUpperCase();
    if (credentialId !== undefined) state.credentialId = credentialId;
    render();
  }

  function render() {
    const ctx = getContext();
    const creds = (getVaultCredentials ? getVaultCredentials() : []).filter((c) => c.status === 'active');
    const discovered = getDiscoveredEndpoints ? getDiscoveredEndpoints() : [];
    const resp = state.response;
    const headerEntries = resp ? Object.entries(resp.headers || {}) : [];

    container.innerHTML = `
      <div class="view-header">
        <div>
          <span class="section-eyebrow">API &amp; ENDPOINT INTELLIGENCE</span>
          <h1 class="view-title">API Inspector &amp; Authorized Tester</h1>
          <p class="view-subtitle">Inspects publicly documented OpenAPI specs and discovered site endpoints, identifies HTTP methods, status codes, and response headers, and executes authorized tests via server-side encrypted Vault credentials.</p>
        </div>
      </div>

      <!-- Live API Request Composer -->
      <form class="panel glass-surface" id="apiReqForm" style="margin-bottom:16px;">
        <div class="composer-main-row" style="gap:8px;">
          <select id="apiMethodSelect" class="glass-select mono" style="font-weight:700;padding:8px 12px;">
            ${METHODS.map((m) => `<option value="${m}" ${state.method === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
          <input
            type="text"
            id="apiUrlInput"
            class="composer-input mono"
            placeholder="https://api.example.com/v1/status"
            value="${esc(state.url)}"
            autocomplete="off"
            spellcheck="false"
          />
          <button type="submit" class="btn btn-primary btn-sm" id="apiSendBtn" ${state.loading ? 'disabled' : ''}>
            ${state.loading ? 'Sending…' : 'Send Request'}
          </button>
        </div>

        <div class="composer-footer-row">
          <div class="composer-meta-left">
            <span class="muted-text mono">Auth:</span>
            <select id="apiCredSelect" class="glass-select mono" ${!ctx.serverAvailable ? 'disabled title="Start local backend for Vault credentials"' : ''}>
              <option value="">No Auth (Public Endpoint)</option>
              ${creds.map((c) => `<option value="${esc(c.id)}" ${state.credentialId === c.id ? 'selected' : ''}>🔒 ${esc(c.name)} (${esc(c.maskedPreview)})</option>`).join('')}
            </select>
            ${!ctx.serverAvailable ? '<span class="muted-text" style="font-size:11px;">(Public CORS mode · Run <code>npm start</code> for Vault auth + full headers)</span>' : ''}
          </div>
          <div class="composer-meta-right">
            <button type="button" class="preset-chip" data-api-preset="https://api.github.com/repos/vitejs/vite">GitHub API</button>
            <button type="button" class="preset-chip" data-api-preset="https://api.subdomain.app/v1/query?domain=vercel.com">subdomain.app API</button>
            <button type="button" class="preset-chip" data-api-preset="https://dns.google/resolve?name=github.com&type=A">Google DoH</button>
          </div>
        </div>

        <div class="options-drawer" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <label class="opt-field">
            <span>Custom Headers (JSON, optional)</span>
            <textarea id="apiHeadersInput" class="code-textarea" rows="2" placeholder='{"Accept": "application/json"}'>${esc(state.customHeadersText)}</textarea>
          </label>
          <label class="opt-field">
            <span>Request Body (POST / PUT / PATCH)</span>
            <textarea id="apiBodyInput" class="code-textarea" rows="2" placeholder='{"query": "..."}'>${esc(state.bodyText)}</textarea>
          </label>
        </div>
      </form>

      ${state.error ? `<div class="status-banner error glass-surface full-width">${esc(state.error)}</div>` : ''}

      <!-- Response Inspector -->
      ${resp ? `
        <div class="panel glass-surface" style="margin-bottom:16px;">
          <div class="panel-header">
            <div class="row-gap" style="flex-wrap:wrap;">
              <span class="badge ${statusBadgeClass(resp.status)}">${resp.status} ${esc(resp.statusText)}</span>
              <span class="badge badge-api">${esc(resp.method)}</span>
              <span class="mono muted-text">${resp.latencyMs}ms · ${resp.bytes.toLocaleString()} bytes</span>
              ${resp.authUsed ? `<span class="badge badge-first-party">🔒 ${esc(resp.authUsed.name)} (${esc(resp.authUsed.headerName)})</span>` : ''}
            </div>
            <div class="row-gap">
              <div class="composer-mode-pills">
                <button type="button" class="mode-tab ${state.responseTab === 'body' ? 'active' : ''}" data-resp-tab="body">Body</button>
                <button type="button" class="mode-tab ${state.responseTab === 'headers' ? 'active' : ''}" data-resp-tab="headers">Headers (${headerEntries.length})</button>
              </div>
              <button type="button" class="btn btn-glass btn-xs" id="apiCopyRespBtn">Copy</button>
            </div>
          </div>
          <div class="panel-body">
            ${state.responseTab === 'headers'
              ? `
                <div class="table-wrap">
                  <table class="data-table">
                    <thead><tr><th>Header</th><th>Value</th></tr></thead>
                    <tbody>
                      ${headerEntries.length === 0
                        ? '<tr><td colspan="2" class="muted-text">No response headers exposed (CORS-limited in browser; run npm start for all headers).</td></tr>'
                        : headerEntries.map(([k, v]) => `<tr><td class="mono" style="font-weight:600;">${esc(k)}</td><td class="mono" style="word-break:break-all;">${esc(v)}</td></tr>`).join('')
                      }
                    </tbody>
                  </table>
                </div>
              `
              : `<pre class="code-viewer">${esc(prettyBody(resp.bodyPreview, resp.contentType))}</pre>`
            }
          </div>
        </div>
      ` : ''}

      <div class="overview-grid">
        <!-- Publicly Documented OpenAPI / Swagger Loader -->
        <div class="panel glass-surface">
          <div class="panel-header">
            <h3 class="panel-title">OpenAPI / Swagger Discovery</h3>
            ${state.openApiDoc ? `<span class="badge badge-first-party">${state.openApiDoc.endpoints.length} routes</span>` : ''}
          </div>
          <div class="panel-body">
            <form class="row-gap" id="openApiForm" style="margin-bottom:12px;">
              <input type="url" id="openApiInput" class="code-input compact" placeholder="Paste public openapi.json or swagger.json URL…" value="${esc(state.openApiUrl)}" />
              <button type="submit" class="btn btn-glass btn-xs" ${state.openApiLoading ? 'disabled' : ''}>${state.openApiLoading ? 'Loading…' : 'Load Spec'}</button>
            </form>
            ${state.openApiDoc ? `
              <div class="muted-text mono" style="margin-bottom:8px;">${esc(state.openApiDoc.title)} ${esc(state.openApiDoc.version)}</div>
              <div class="endpoint-list">
                ${state.openApiDoc.endpoints.slice(0, 40).map((ep) => `
                  <div class="endpoint-row">
                    <span class="badge badge-api">${esc(ep.method)}</span>
                    <span class="mono endpoint-url" title="${esc(ep.url)}">${esc(ep.path)}</span>
                    <button type="button" class="btn btn-glass btn-xs" data-load-ep="${esc(ep.url)}" data-load-method="${esc(ep.method)}">Test</button>
                  </div>
                `).join('')}
              </div>
            ` : `
              <div class="empty-box" style="padding:20px 10px;">
                Paste any public OpenAPI 3 / Swagger JSON spec URL (e.g. <code>https://api.subdomain.app/openapi.json</code>) to inspect its documented endpoints and methods.
              </div>
            `}
          </div>
        </div>

        <!-- Endpoints Discovered from Active Site Scan -->
        <div class="panel glass-surface">
          <div class="panel-header">
            <h3 class="panel-title">Discovered Site Endpoints <span class="tab-badge">${discovered.length}</span></h3>
            <span class="muted-text mono">From active Website / Source scan</span>
          </div>
          <div class="panel-body">
            ${discovered.length === 0
              ? '<div class="empty-box" style="padding:20px 10px;">Run a Website or Source Code scan to automatically populate publicly referenced REST, GraphQL, and WebSocket endpoints here.</div>'
              : `
                <div class="endpoint-list">
                  ${discovered.slice(0, 35).map((ep) => `
                    <div class="endpoint-row">
                      <span class="badge ${ep.kind === 'GraphQL' ? 'badge-cdn' : ep.kind === 'WebSocket' ? 'badge-dev' : 'badge-api'}">${esc(ep.method)}</span>
                      <div class="endpoint-meta">
                        <div class="mono endpoint-url" title="${esc(ep.url)}">${esc(ep.path || ep.url)}</div>
                        <div class="muted-text mono" style="font-size:10.5px;">${esc(ep.artifact)}:${ep.line} · ${esc(ep.kind)}</div>
                      </div>
                      ${ep.method !== 'WS' ? `<button type="button" class="btn btn-glass btn-xs" data-load-ep="${esc(ep.url)}" data-load-method="${esc(ep.method)}">Test</button>` : ''}
                    </div>
                  `).join('')}
                </div>
              `
            }
          </div>
        </div>
      </div>
    `;

    container.querySelector('#apiMethodSelect')?.addEventListener('change', (e) => { state.method = e.target.value; });
    container.querySelector('#apiUrlInput')?.addEventListener('input', (e) => { state.url = e.target.value; });
    container.querySelector('#apiCredSelect')?.addEventListener('change', (e) => { state.credentialId = e.target.value; });
    container.querySelector('#apiHeadersInput')?.addEventListener('input', (e) => { state.customHeadersText = e.target.value; });
    container.querySelector('#apiBodyInput')?.addEventListener('input', (e) => { state.bodyText = e.target.value; });
    container.querySelector('#apiReqForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      sendRequest();
    });
    container.querySelectorAll('[data-api-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.url = btn.dataset.apiPreset;
        state.method = 'GET';
        render();
        sendRequest();
      });
    });
    container.querySelectorAll('[data-resp-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.responseTab = btn.dataset.respTab;
        render();
      });
    });
    container.querySelector('#apiCopyRespBtn')?.addEventListener('click', () => {
      if (!resp) return;
      const payload = state.responseTab === 'headers' ? JSON.stringify(resp.headers, null, 2) : resp.bodyPreview;
      copyText(payload, 'Copied response');
    });
    container.querySelector('#openApiForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      loadOpenApiSpec(container.querySelector('#openApiInput')?.value);
    });
    container.querySelectorAll('[data-load-ep]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.url = btn.dataset.loadEp;
        state.method = btn.dataset.loadMethod || 'GET';
        render();
        sendRequest();
      });
    });
  }

  return { init: render, render, prefill, sendRequest };
}
