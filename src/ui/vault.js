// API & Token Manager Dashboard (DEVTRACER — made by ★NDX★)
// Connects exclusively to server-side AES-256-GCM encrypted vault (/api/credentials).
// Secrets NEVER leave the server, are NEVER stored in browser storage, and are ALWAYS masked.

const TYPE_LABELS = {
  custom_api_key: 'Custom API Key',
  github_pat: 'GitHub PAT',
  bearer_token: 'Bearer Token',
  ai_provider: 'AI Provider Key',
  custom_integration: 'Custom Integration'
};

const TYPE_DEFAULTS = {
  custom_api_key: { headerName: 'X-API-Key', authScheme: 'raw', testUrl: '' },
  github_pat: { headerName: 'Authorization', authScheme: 'Bearer', testUrl: 'https://api.github.com/user' },
  bearer_token: { headerName: 'Authorization', authScheme: 'Bearer', testUrl: '' },
  ai_provider: { headerName: 'Authorization', authScheme: 'Bearer', testUrl: 'https://api.openai.com/v1/models' },
  custom_integration: { headerName: 'Authorization', authScheme: 'Bearer', testUrl: '' }
};

function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createVaultController({ container, getContext, showToast, onCredentialsChanged, onUseInApiInspector }) {
  const state = {
    credentials: [],
    loading: false,
    error: '',
    formOpen: false,
    editingId: null,
    testingId: null,
    lastTestReport: null
  };

  async function loadCredentials() {
    const ctx = getContext();
    if (!ctx.serverAvailable) {
      state.credentials = [];
      if (onCredentialsChanged) onCredentialsChanged([]);
      render();
      return;
    }
    state.loading = true;
    state.error = '';
    render();
    try {
      const res = await fetch('./api/credentials', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      state.credentials = data.credentials || [];
      if (onCredentialsChanged) onCredentialsChanged(state.credentials);
    } catch (err) {
      state.error = err?.message || 'Failed to load encrypted vault.';
    } finally {
      state.loading = false;
      render();
    }
  }

  async function saveCredential(form) {
    const payload = {
      name: form.querySelector('#vName').value.trim(),
      type: form.querySelector('#vType').value,
      provider: form.querySelector('#vProvider').value.trim(),
      headerName: form.querySelector('#vHeader').value.trim(),
      authScheme: form.querySelector('#vScheme').value.trim(),
      baseUrl: form.querySelector('#vBaseUrl').value.trim(),
      testUrl: form.querySelector('#vTestUrl').value.trim(),
      secret: form.querySelector('#vSecret').value.trim()
    };

    const isEdit = Boolean(state.editingId);
    if (isEdit && !payload.secret) delete payload.secret;

    state.error = '';
    try {
      const url = isEdit ? `./api/credentials/${encodeURIComponent(state.editingId)}` : './api/credentials';
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      // Clear secret input immediately
      form.querySelector('#vSecret').value = '';
      state.formOpen = false;
      state.editingId = null;
      showToast(isEdit ? 'Credential updated & encrypted at rest' : 'Credential encrypted (AES-256-GCM) & stored server-side');
      await loadCredentials();
    } catch (err) {
      state.error = err?.message || 'Could not save credential.';
      render();
    }
  }

  async function testCredential(id) {
    const cred = state.credentials.find((c) => c.id === id);
    if (!cred) return;
    state.testingId = id;
    state.error = '';
    state.lastTestReport = null;
    render();
    try {
      const res = await fetch(`./api/credentials/${encodeURIComponent(id)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testUrl: cred.testUrl || cred.baseUrl })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      state.lastTestReport = { credName: cred.name, ...data.result };
      showToast(`${cred.name}: HTTP ${data.result.status} (${data.result.latencyMs}ms)`);
      await loadCredentials();
    } catch (err) {
      state.error = err?.message || 'Connection test failed.';
      state.testingId = null;
      render();
    } finally {
      state.testingId = null;
      render();
    }
  }

  async function revokeCredential(id) {
    state.error = '';
    try {
      const res = await fetch(`./api/credentials/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast('Credential revoked & encrypted secret wiped');
      await loadCredentials();
    } catch (err) {
      state.error = err?.message || 'Failed to revoke credential.';
      render();
    }
  }

  async function deleteCredential(id) {
    state.error = '';
    try {
      const res = await fetch(`./api/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast('Credential deleted');
      await loadCredentials();
    } catch (err) {
      state.error = err?.message || 'Failed to delete credential.';
      render();
    }
  }

  function render() {
    const ctx = getContext();
    const editing = state.editingId ? state.credentials.find((c) => c.id === state.editingId) : null;
    const activeCount = state.credentials.filter((c) => c.status === 'active').length;
    const revokedCount = state.credentials.filter((c) => c.status === 'revoked').length;

    container.innerHTML = `
      <div class="view-header">
        <div>
          <span class="section-eyebrow">ENCRYPTED SERVER-SIDE CREDENTIAL MANAGER</span>
          <h1 class="view-title">API &amp; Token Vault</h1>
          <p class="view-subtitle">Stores API keys, GitHub PATs, Bearer tokens, AI provider keys, and custom integrations encrypted at rest with <code>AES-256-GCM</code>. Secrets never enter browser storage or logs.</p>
        </div>
        ${ctx.serverAvailable ? `
          <div class="row-gap">
            <button type="button" class="btn btn-glass btn-xs" id="vaultRefreshBtn">Refresh</button>
            <button type="button" class="btn btn-primary btn-sm" id="vaultAddBtn">${state.formOpen ? 'Close Form' : '+ Add Credential'}</button>
          </div>
        ` : ''}
      </div>

      <div class="kpi-strip">
        <div class="kpi-card glass-surface">
          <div class="kpi-label">Encryption Cipher</div>
          <div class="kpi-value cyan" style="font-size:20px;">AES-256-GCM</div>
          <div class="kpi-sub">Authenticated encryption at rest</div>
        </div>
        <div class="kpi-card glass-surface">
          <div class="kpi-label">Active Credentials</div>
          <div class="kpi-value green">${activeCount}</div>
          <div class="kpi-sub">Masked in UI · Server-injected only</div>
        </div>
        <div class="kpi-card glass-surface">
          <div class="kpi-label">Revoked / Wiped</div>
          <div class="kpi-value amber">${revokedCount}</div>
          <div class="kpi-sub">Ciphertext permanently purged</div>
        </div>
        <div class="kpi-card glass-surface">
          <div class="kpi-label">Vault Storage</div>
          <div class="kpi-value" style="font-size:18px;">${ctx.serverAvailable ? 'Server Online' : 'Backend Off'}</div>
          <div class="kpi-sub">${ctx.serverAvailable ? '.devtracer/vault.enc.json (0600)' : 'Run npm start for server vault'}</div>
        </div>
      </div>

      ${!ctx.serverAvailable ? `
        <div class="panel glass-surface" style="margin-top:16px;">
          <div class="panel-header">
            <h3 class="panel-title">Server-Side Security Policy Active</h3>
            <span class="badge badge-dev">STATIC GITHUB PAGES MODE</span>
          </div>
          <div class="panel-body">
            <p class="modal-p">To guarantee secrets are encrypted at rest and never exposed in browser storage, code, or logs, the <strong>API &amp; Token Vault</strong> runs strictly on the DEVTRACER Node.js backend.</p>
            <pre class="code-viewer small"># Clone &amp; start DEVTRACER with AES-256-GCM encrypted server vault
git clone https://github.com/robloxgamee1231-ctrl/Dev.git
cd Dev
DEVTRACER_VAULT_KEY="your-strong-passphrase" npm start
# Open http://localhost:3000 → API &amp; Token Vault</pre>
          </div>
        </div>
      ` : `
        ${state.error ? `<div class="status-banner error glass-surface full-width">${esc(state.error)}</div>` : ''}

        ${state.formOpen ? `
          <form class="panel glass-surface" id="vaultForm" style="margin-bottom:16px;">
            <div class="panel-header">
              <h3 class="panel-title">${editing ? `Edit / Rotate: ${esc(editing.name)}` : 'Add Encrypted Credential'}</h3>
              <span class="badge badge-first-party">AES-256-GCM · SERVER-SIDE ONLY</span>
            </div>
            <div class="panel-body">
              <div class="vault-form-grid">
                <label class="opt-field">
                  <span>Label / Name *</span>
                  <input type="text" id="vName" class="code-input" required placeholder="e.g. GitHub Org PAT or OpenAI Prod" value="${esc(editing?.name || '')}" />
                </label>
                <label class="opt-field">
                  <span>Credential Type</span>
                  <select id="vType" class="code-input">
                    ${Object.entries(TYPE_LABELS)
                      .map(([val, lbl]) => `<option value="${val}" ${(editing?.type || 'custom_api_key') === val ? 'selected' : ''}>${lbl}</option>`)
                      .join('')}
                  </select>
                </label>
                <label class="opt-field">
                  <span>Provider / Service</span>
                  <input type="text" id="vProvider" class="code-input" placeholder="e.g. GitHub, OpenAI, Anthropic, Stripe" value="${esc(editing?.provider || '')}" />
                </label>
                <label class="opt-field">
                  <span>${editing ? 'Replace Secret Value (leave blank to keep)' : 'Secret / Token Value *'}</span>
                  <input type="password" id="vSecret" class="code-input" ${editing ? '' : 'required'} autocomplete="new-password" placeholder="Encrypted immediately on server…" />
                </label>
                <label class="opt-field">
                  <span>HTTP Auth Header</span>
                  <input type="text" id="vHeader" class="code-input" value="${esc(editing?.headerName || 'X-API-Key')}" placeholder="Authorization or X-API-Key" />
                </label>
                <label class="opt-field">
                  <span>Auth Scheme</span>
                  <input type="text" id="vScheme" class="code-input" value="${esc(editing?.authScheme ?? 'raw')}" placeholder="Bearer, Token, or raw" />
                </label>
                <label class="opt-field">
                  <span>Base Endpoint URL (optional)</span>
                  <input type="url" id="vBaseUrl" class="code-input" value="${esc(editing?.baseUrl || '')}" placeholder="https://api.example.com/v1" />
                </label>
                <label class="opt-field">
                  <span>Connection Test URL (optional)</span>
                  <input type="url" id="vTestUrl" class="code-input" value="${esc(editing?.testUrl || '')}" placeholder="https://api.github.com/user" />
                </label>
              </div>
              <div class="row-gap" style="justify-content:flex-end;margin-top:14px;">
                <button type="button" class="btn btn-glass btn-sm" id="vaultCancelBtn">Cancel</button>
                <button type="submit" class="btn btn-primary btn-sm">${editing ? 'Save & Encrypt Changes' : 'Encrypt & Store'}</button>
              </div>
            </div>
          </form>
        ` : ''}

        ${state.lastTestReport ? `
          <div class="panel glass-surface" style="margin-bottom:16px;">
            <div class="panel-header">
              <div class="row-gap">
                <h3 class="panel-title">Connection Test: ${esc(state.lastTestReport.credName)}</h3>
                <span class="badge ${state.lastTestReport.ok ? 'badge-first-party' : 'badge-dev'}">HTTP ${state.lastTestReport.status}</span>
                <span class="muted-text mono">${state.lastTestReport.latencyMs}ms</span>
              </div>
              <span class="muted-text mono">${esc(state.lastTestReport.url)}</span>
            </div>
            <div class="panel-body">
              <pre class="code-viewer small">${esc(state.lastTestReport.bodyPreview?.slice(0, 1200) || '(Empty response body)')}</pre>
            </div>
          </div>
        ` : ''}

        <div class="panel glass-surface">
          <div class="panel-header">
            <h3 class="panel-title">Stored Credentials <span class="tab-badge">${state.credentials.length}</span></h3>
            <span class="muted-text mono">Zero raw secrets returned by API · Strict SSRF checks on tests</span>
          </div>
          <div class="panel-body">
            ${state.credentials.length === 0
              ? `<div class="empty-box">No credentials stored yet. Click <strong>+ Add Credential</strong> to encrypt a GitHub PAT, Bearer token, AI provider key, or custom API integration server-side.</div>`
              : `
                <div class="table-wrap">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th>Name &amp; Provider</th>
                        <th>Type &amp; Header</th>
                        <th>Masked Secret</th>
                        <th>Status / Last Test</th>
                        <th style="text-align:right;">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${state.credentials.map((c) => `
                        <tr>
                          <td>
                            <div style="font-weight:600;">${esc(c.name)}</div>
                            <div class="muted-text mono" style="font-size:11px;">${esc(c.provider || c.baseUrl || 'Custom integration')}</div>
                          </td>
                          <td>
                            <span class="badge badge-api">${esc(TYPE_LABELS[c.type] || c.type)}</span>
                            <div class="muted-text mono" style="font-size:11px;margin-top:4px;">${esc(c.headerName)} (${esc(c.authScheme || 'raw')})</div>
                          </td>
                          <td class="mono" style="font-weight:600;">${esc(c.maskedPreview)}</td>
                          <td>
                            <span class="badge ${c.status === 'active' ? 'badge-first-party' : 'badge-dev'}">${esc(c.status)}</span>
                            ${c.lastTestResult ? `<div class="muted-text mono" style="font-size:11px;margin-top:4px;">HTTP ${c.lastTestResult.status} · ${c.lastTestResult.latencyMs}ms</div>` : ''}
                          </td>
                          <td style="text-align:right;white-space:nowrap;">
                            ${c.status === 'active' ? `
                              <button type="button" class="btn btn-glass btn-xs" data-vault-test="${esc(c.id)}" ${state.testingId === c.id ? 'disabled' : ''}>${state.testingId === c.id ? 'Testing…' : 'Test'}</button>
                              <button type="button" class="btn btn-glass btn-xs" data-vault-use="${esc(c.id)}">Use →</button>
                              <button type="button" class="btn btn-glass btn-xs" data-vault-edit="${esc(c.id)}">Edit</button>
                              <button type="button" class="btn btn-danger-ghost btn-xs" data-vault-revoke="${esc(c.id)}">Revoke</button>
                            ` : `
                              <button type="button" class="btn btn-glass btn-xs" data-vault-edit="${esc(c.id)}">Replace</button>
                            `}
                            <button type="button" class="btn btn-glass btn-xs" data-vault-delete="${esc(c.id)}">Delete</button>
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
      `}
    `;

    container.querySelector('#vaultRefreshBtn')?.addEventListener('click', loadCredentials);
    container.querySelector('#vaultAddBtn')?.addEventListener('click', () => {
      state.editingId = null;
      state.formOpen = !state.formOpen;
      render();
    });
    container.querySelector('#vaultCancelBtn')?.addEventListener('click', () => {
      state.editingId = null;
      state.formOpen = false;
      render();
    });
    container.querySelector('#vType')?.addEventListener('change', (e) => {
      const def = TYPE_DEFAULTS[e.target.value];
      if (!def || state.editingId) return;
      const hEl = container.querySelector('#vHeader');
      const sEl = container.querySelector('#vScheme');
      const tEl = container.querySelector('#vTestUrl');
      if (hEl) hEl.value = def.headerName;
      if (sEl) sEl.value = def.authScheme;
      if (tEl && !tEl.value) tEl.value = def.testUrl;
    });
    container.querySelector('#vaultForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      saveCredential(e.currentTarget);
    });
    container.querySelectorAll('[data-vault-test]').forEach((btn) => {
      btn.addEventListener('click', () => testCredential(btn.dataset.vaultTest));
    });
    container.querySelectorAll('[data-vault-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.editingId = btn.dataset.vaultEdit;
        state.formOpen = true;
        render();
      });
    });
    container.querySelectorAll('[data-vault-revoke]').forEach((btn) => {
      btn.addEventListener('click', () => revokeCredential(btn.dataset.vaultRevoke));
    });
    container.querySelectorAll('[data-vault-delete]').forEach((btn) => {
      btn.addEventListener('click', () => deleteCredential(btn.dataset.vaultDelete));
    });
    container.querySelectorAll('[data-vault-use]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cred = state.credentials.find((c) => c.id === btn.dataset.vaultUse);
        if (cred && onUseInApiInspector) onUseInApiInspector(cred);
      });
    });
  }

  return { init: loadCredentials, refresh: loadCredentials, render, getCredentials: () => state.credentials };
}
