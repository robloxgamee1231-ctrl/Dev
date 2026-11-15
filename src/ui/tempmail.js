// Temp Mail HUD Module — powered by https://throwawaymail.app/api/docs (OAS 3.1)

const MAILBOX_STORAGE_KEY = 'devtrace_tempmail_v1';
const BASE_URL = 'https://throwawaymail.app';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(str) {
  return UUID_RE.test(String(str || '').trim());
}

export function formatCountdown(expiresAtIso, nowMs = Date.now()) {
  if (!expiresAtIso) return { label: '--:--', expired: false, urgent: false, remainingMs: 0 };
  const target = Date.parse(expiresAtIso);
  if (Number.isNaN(target)) return { label: '--:--', expired: false, urgent: false, remainingMs: 0 };
  const remainingMs = Math.max(0, target - nowMs);
  if (remainingMs <= 0) {
    return { label: 'Expired', expired: true, urgent: true, remainingMs: 0 };
  }
  const totalSec = Math.ceil(remainingMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return {
    label: `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`,
    expired: false,
    urgent: totalSec <= 120,
    remainingMs
  };
}

export function extractOtpCodes(text = '', subject = '') {
  const combined = `${subject}\n${text}`;
  const found = new Set();

  // Context-anchored OTP / verification code patterns
  const patterns = [
    /(?:verification|verify|confirm(?:ation)?|security|login|sign[- ]?in|auth(?:entication)?|one[- ]?time|otp|passcode|pin)\s*(?:code|pin|number)?\s*(?:is|:|#|-)?\s*([A-Z0-9]{4,8}|\d{3}[-\s]\d{3})\b/gi,
    /\bcode\s*(?:is|:|#)\s*(\d{4,8})\b/gi,
    /(?:^|\n)\s*(\d{6})\s*(?:\n|$)/g
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(combined)) !== null) {
      const cleaned = m[1].replace(/[\s-]/g, '');
      if (/\d{4,8}/.test(cleaned) && !/^(?:19|20)\d{2}$/.test(cleaned)) {
        found.add(cleaned);
      }
    }
  }
  return [...found].slice(0, 4);
}

function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(1)} KB`;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function createTempMailController({ container, getContext, copyText, showToast }) {
  const state = {
    mailbox: null, // { mailbox_id, address, expires_at, created_at }
    messages: [],
    selectedMessageId: null,
    messageCache: new Map(), // message_id -> MessageDetailResponse
    viewMode: 'text', // 'text' | 'html'
    autoRefresh: true,
    loading: false,
    polling: false,
    lastSyncAt: null,
    error: '',
    restoreOpen: false,
    transportUsed: ''
  };

  let countdownTimer = null;
  let pollTimer = null;

  function loadSavedMailbox() {
    try {
      const saved = JSON.parse(localStorage.getItem(MAILBOX_STORAGE_KEY) || 'null');
      if (saved && saved.mailbox_id && saved.address) {
        const cd = formatCountdown(saved.expires_at);
        if (!cd.expired) {
          state.mailbox = saved;
        } else {
          localStorage.removeItem(MAILBOX_STORAGE_KEY);
        }
      }
    } catch {}
  }

  function persistMailbox() {
    try {
      if (state.mailbox) localStorage.setItem(MAILBOX_STORAGE_KEY, JSON.stringify(state.mailbox));
      else localStorage.removeItem(MAILBOX_STORAGE_KEY);
    } catch {}
  }

  async function mailApi(path, { method = 'GET' } = {}) {
    const ctx = getContext();
    const directUrl = `${BASE_URL}${path}`;
    const attempts = [];

    // 1. Direct browser call to throwawaymail.app
    attempts.push(async () => {
      const res = await fetch(directUrl, {
        method,
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000)
      });
      if (res.status === 204) return { status: 204, data: null, via: 'direct' };
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(data?.detail || data?.error || `ThrowawayMail HTTP ${res.status}`);
        err.httpStatus = res.status;
        throw err;
      }
      return { status: res.status, data, via: 'direct' };
    });

    // 2. Custom Cloudflare Worker (if configured for GitHub Pages)
    if (ctx.workerUrl && /^https?:\/\//i.test(ctx.workerUrl)) {
      attempts.push(async () => {
        const base = ctx.workerUrl.replace(/\/+$/, '');
        const url = `${base}?url=${encodeURIComponent(directUrl)}&method=${encodeURIComponent(method)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(14_000) });
        const wrapper = await res.json();
        if (wrapper.error) throw new Error(wrapper.error);
        if (wrapper.status === 204) return { status: 204, data: null, via: 'worker' };
        const data = wrapper.body ? JSON.parse(wrapper.body) : null;
        if (wrapper.status >= 400) {
          const err = new Error(data?.detail || data?.error || `ThrowawayMail HTTP ${wrapper.status}`);
          err.httpStatus = wrapper.status;
          throw err;
        }
        return { status: wrapper.status, data, via: 'worker' };
      });
    }

    // 3. Local DevTrace Node server proxy (if available)
    if (ctx.serverAvailable) {
      attempts.push(async () => {
        const localUrl = `.${path}`;
        const res = await fetch(localUrl, {
          method,
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(14_000)
        });
        if (res.status === 204) return { status: 204, data: null, via: 'server' };
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          const err = new Error(data?.detail || data?.error || `ThrowawayMail HTTP ${res.status}`);
          err.httpStatus = res.status;
          throw err;
        }
        return { status: res.status, data, via: 'server' };
      });
    }

    let lastErr;
    for (const run of attempts) {
      try {
        const result = await run();
        state.transportUsed = result.via;
        return result;
      } catch (err) {
        // Real 404/422 from upstream shouldn't retry across transports
        if (err?.httpStatus === 404 || err?.httpStatus === 422 || err?.httpStatus === 400) {
          throw err;
        }
        lastErr = err;
      }
    }

    throw new Error(
      lastErr?.message
        ? `${lastErr.message}. If blocked by browser CORS, configure Pages Proxy (Cloudflare Worker) or run locally with npm start.`
        : 'Could not reach throwawaymail.app API.'
    );
  }

  async function createMailbox() {
    if (state.loading) return;
    state.loading = true;
    state.error = '';
    render();
    try {
      const { data } = await mailApi('/api/mailboxes', { method: 'POST' });
      state.mailbox = data;
      state.messages = [];
      state.selectedMessageId = null;
      state.messageCache.clear();
      state.lastSyncAt = new Date().toISOString();
      persistMailbox();
      startTimers();
      showToast(`Created ${data.address}`);
    } catch (err) {
      state.error = err.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function refreshInbox({ silent = false } = {}) {
    if (!state.mailbox || state.polling) return;
    const cd = formatCountdown(state.mailbox.expires_at);
    if (cd.expired) {
      stopPollTimer();
      render();
      return;
    }
    state.polling = true;
    if (!silent) {
      state.error = '';
      render();
    }
    try {
      const prevCount = state.messages.length;
      const { data } = await mailApi(`/api/mailboxes/${encodeURIComponent(state.mailbox.mailbox_id)}`, { method: 'GET' });
      state.mailbox = {
        mailbox_id: data.mailbox_id,
        address: data.address,
        expires_at: data.expires_at,
        created_at: data.created_at
      };
      state.messages = Array.isArray(data.messages) ? data.messages : [];
      state.lastSyncAt = new Date().toISOString();
      persistMailbox();

      if (state.messages.length > prevCount && prevCount > 0) {
        showToast(`New email received (${state.messages.length} total)`);
      }
      // Auto-select newest message when inbox gets its first message
      if (!state.selectedMessageId && state.messages.length > 0) {
        selectMessage(state.messages[0].message_id);
      }
    } catch (err) {
      if (err?.httpStatus === 404) {
        state.error = 'Mailbox expired or deleted on throwawaymail.app. Generate a new address.';
        state.mailbox = null;
        state.messages = [];
        persistMailbox();
        stopTimers();
      } else if (!silent) {
        state.error = err.message;
      }
    } finally {
      state.polling = false;
      render();
    }
  }

  async function selectMessage(messageId) {
    if (!state.mailbox || !messageId) return;
    state.selectedMessageId = messageId;
    render();
    if (state.messageCache.has(messageId)) return;

    try {
      const { data } = await mailApi(
        `/api/mailboxes/${encodeURIComponent(state.mailbox.mailbox_id)}/messages/${encodeURIComponent(messageId)}`,
        { method: 'GET' }
      );
      state.messageCache.set(messageId, data);
      // Pick HTML view automatically if text is empty and html exists
      state.viewMode = data.text ? 'text' : data.html ? 'html' : 'text';
      // Mark read in summary list
      const item = state.messages.find((m) => m.message_id === messageId);
      if (item) item.read = true;
    } catch (err) {
      state.error = err.message;
    }
    render();
  }

  async function deleteMailbox() {
    if (!state.mailbox || state.loading) return;
    const id = state.mailbox.mailbox_id;
    state.loading = true;
    state.error = '';
    render();
    try {
      await mailApi(`/api/mailboxes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      // Clear locally even if already expired on server
    } finally {
      state.mailbox = null;
      state.messages = [];
      state.selectedMessageId = null;
      state.messageCache.clear();
      persistMailbox();
      stopTimers();
      state.loading = false;
      showToast('Mailbox deleted');
      render();
    }
  }

  async function restoreMailboxById(rawId) {
    const id = String(rawId || '').trim();
    if (!isValidUuid(id)) {
      state.error = 'Enter a valid mailbox UUID (e.g. 550e8400-e29b-41d4-a716-446655440000).';
      render();
      return;
    }
    state.loading = true;
    state.error = '';
    render();
    try {
      const { data } = await mailApi(`/api/mailboxes/${encodeURIComponent(id)}`, { method: 'GET' });
      state.mailbox = {
        mailbox_id: data.mailbox_id,
        address: data.address,
        expires_at: data.expires_at,
        created_at: data.created_at
      };
      state.messages = Array.isArray(data.messages) ? data.messages : [];
      state.selectedMessageId = state.messages[0]?.message_id || null;
      state.messageCache.clear();
      state.restoreOpen = false;
      state.lastSyncAt = new Date().toISOString();
      persistMailbox();
      startTimers();
      showToast(`Connected to ${data.address}`);
      if (state.selectedMessageId) selectMessage(state.selectedMessageId);
    } catch (err) {
      state.error = err.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  function stopPollTimer() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function stopTimers() {
    stopPollTimer();
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function startTimers() {
    stopTimers();
    if (!state.mailbox) return;
    countdownTimer = setInterval(() => {
      const el = container.querySelector('#tmCountdown');
      if (!el || !state.mailbox) return;
      const cd = formatCountdown(state.mailbox.expires_at);
      el.textContent = cd.expired ? 'Expired' : `${cd.label} left`;
      el.className = `tm-countdown ${cd.expired ? 'expired' : cd.urgent ? 'urgent' : ''}`;
      if (cd.expired) stopPollTimer();
    }, 1000);

    if (state.autoRefresh) {
      pollTimer = setInterval(() => {
        if (!document.hidden && !container.classList.contains('hidden')) {
          refreshInbox({ silent: true });
        }
      }, 5000);
    }
  }

  function render() {
    const mb = state.mailbox;
    const cd = mb ? formatCountdown(mb.expires_at) : null;
    const selectedMsg = state.selectedMessageId ? state.messageCache.get(state.selectedMessageId) : null;
    const otps = selectedMsg ? extractOtpCodes(selectedMsg.text || '', selectedMsg.subject || '') : [];

    container.innerHTML = `
      <div class="zai-hero">
        <h1 class="zai-title">Disposable Temp Mail</h1>
        <p class="zai-subtitle">Instant 10-minute inbox via <code>throwawaymail.app/api</code> — create an address, receive verification codes, and burn on demand.</p>
      </div>

      <!-- Z.ai Composer Bar for Temp Mail -->
      <div class="zai-composer">
        <div class="composer-main-row">
          <div class="composer-display ${mb ? 'has-value' : ''}">
            ${mb
              ? `<span class="mono composer-address" id="tmAddressText">${esc(mb.address)}</span>`
              : `<span class="composer-placeholder">Generate a temporary mailbox to start receiving messages…</span>`
            }
          </div>
          <div class="composer-actions">
            ${mb ? `<button type="button" class="btn btn-ghost btn-sm" id="tmCopyBtn">Copy</button>` : ''}
            <button type="button" class="btn btn-primary btn-sm" id="tmCreateBtn" ${state.loading ? 'disabled' : ''}>
              ${state.loading ? 'Working…' : mb ? 'New Address' : 'Create Mailbox'}
            </button>
          </div>
        </div>

        <div class="composer-footer-row">
          <div class="composer-meta-left">
            ${mb ? `
              <span class="tm-countdown ${cd.expired ? 'expired' : cd.urgent ? 'urgent' : ''}" id="tmCountdown">${cd.expired ? 'Expired' : `${cd.label} left`}</span>
              <span class="sep">·</span>
              <button type="button" class="link-btn mono" id="tmCopyIdBtn" title="Copy mailbox UUID to restore later">ID: ${esc(mb.mailbox_id.slice(0, 8))}…</button>
              <span class="sep">·</span>
              <label class="inline-toggle">
                <input type="checkbox" id="tmAutoPoll" ${state.autoRefresh ? 'checked' : ''} />
                <span>Auto-refresh (5s)</span>
              </label>
            ` : `
              <span class="muted-text mono">POST /api/mailboxes · 10 min TTL</span>
            `}
          </div>
          <div class="composer-meta-right">
            ${mb ? `
              <button type="button" class="btn btn-ghost btn-xs" id="tmRefreshBtn" ${state.polling ? 'disabled' : ''}>${state.polling ? 'Checking…' : 'Refresh'}</button>
              <button type="button" class="btn btn-danger-ghost btn-xs" id="tmDeleteBtn">Burn</button>
            ` : ''}
            <button type="button" class="btn btn-ghost btn-xs" id="tmRestoreToggleBtn">${state.restoreOpen ? 'Close Restore' : 'Restore ID'}</button>
            <a href="https://throwawaymail.app/api/docs" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-xs">API Docs ↗</a>
          </div>
        </div>
      </div>

      ${state.restoreOpen ? `
        <form class="inline-panel" id="tmRestoreForm">
          <input type="text" id="tmRestoreInput" class="code-input compact" placeholder="Paste mailbox_id UUID to reconnect…" autocomplete="off" spellcheck="false" />
          <button type="submit" class="btn btn-primary btn-sm">Connect</button>
        </form>
      ` : ''}

      ${state.error ? `<div class="status-banner error">${esc(state.error)}</div>` : ''}

      <!-- Inbox Split View -->
      <div class="tm-workspace">
        <div class="panel tm-list-panel">
          <div class="panel-header">
            <h3 class="panel-title">Inbox <span class="tab-badge">${state.messages.length}</span></h3>
            <span class="muted-text mono">${state.lastSyncAt ? `Synced ${formatTime(state.lastSyncAt)}` : 'Waiting'}</span>
          </div>
          <div class="tm-msg-list">
            ${!mb
              ? `<div class="empty-box">Click <strong>Create Mailbox</strong> to allocate an instant disposable inbox.</div>`
              : state.messages.length === 0
                ? `<div class="empty-box">
                    <div class="pulse-line"><span class="live-dot"></span>Listening on <code>${esc(mb.address)}</code></div>
                    <div class="muted-text" style="margin-top:6px;">Send an email to this address — messages appear automatically every 5s.</div>
                  </div>`
                : state.messages.map((m) => `
                  <button type="button" class="tm-msg-row ${state.selectedMessageId === m.message_id ? 'active' : ''}" data-msg-id="${esc(m.message_id)}">
                    <div class="tm-msg-top">
                      <span class="tm-sender">${!m.read ? '<span class="unread-dot"></span>' : ''}${esc(m.from_name || m.from_address)}</span>
                      <span class="muted-text mono">${esc(formatTime(m.received_at))}</span>
                    </div>
                    <div class="tm-subject">${esc(m.subject || '(No subject)')}</div>
                    <div class="tm-submeta mono">${esc(m.from_address)} · ${formatBytes(m.size)}</div>
                  </button>
                `).join('')
            }
          </div>
        </div>

        <div class="panel tm-reader-panel">
          <div class="panel-header">
            <h3 class="panel-title">${selectedMsg ? esc(selectedMsg.subject || '(No subject)') : 'Message Viewer'}</h3>
            ${selectedMsg ? `
              <div class="row-gap">
                <button type="button" class="filter-pill ${state.viewMode === 'text' ? 'active' : ''}" data-tm-view="text">Plain Text</button>
                ${selectedMsg.html ? `<button type="button" class="filter-pill ${state.viewMode === 'html' ? 'active' : ''}" data-tm-view="html">Sandboxed HTML</button>` : ''}
              </div>
            ` : ''}
          </div>
          <div class="panel-body">
            ${!state.selectedMessageId
              ? `<div class="empty-box">Select an incoming email from the inbox to read its headers, verification codes, and body.</div>`
              : !selectedMsg
                ? `<div class="empty-box">Loading message content…</div>`
                : `
                  <div class="tm-meta-grid">
                    <div><span class="muted-text">From</span><span class="mono">${esc(selectedMsg.from_name ? `${selectedMsg.from_name} <${selectedMsg.from_address}>` : selectedMsg.from_address)}</span></div>
                    <div><span class="muted-text">To</span><span class="mono">${esc((selectedMsg.to_addresses || []).join(', '))}</span></div>
                    <div><span class="muted-text">Received</span><span class="mono">${esc(new Date(selectedMsg.received_at).toLocaleString())}</span></div>
                    ${selectedMsg.reply_to ? `<div><span class="muted-text">Reply-To</span><span class="mono">${esc(selectedMsg.reply_to)}</span></div>` : ''}
                  </div>

                  ${otps.length > 0 ? `
                    <div class="otp-bar">
                      <span class="otp-label">DETECTED CODE</span>
                      <div class="row-gap">
                        ${otps.map((code) => `
                          <button type="button" class="otp-chip" data-copy-otp="${esc(code)}">${esc(code)} · Copy</button>
                        `).join('')}
                      </div>
                    </div>
                  ` : ''}

                  ${state.viewMode === 'html' && selectedMsg.html
                    ? `<iframe class="mail-iframe" sandbox="" referrerpolicy="no-referrer" title="Sandboxed email preview" srcdoc="${esc(selectedMsg.html)}"></iframe>`
                    : `<pre class="code-viewer">${esc(selectedMsg.text || '(No plain-text body — switch to Sandboxed HTML)')}</pre>`
                  }
                `
            }
          </div>
        </div>
      </div>
    `;

    // Bind events
    container.querySelector('#tmCreateBtn')?.addEventListener('click', createMailbox);
    container.querySelector('#tmCopyBtn')?.addEventListener('click', () => {
      if (state.mailbox) copyText(state.mailbox.address, `Copied ${state.mailbox.address}`);
    });
    container.querySelector('#tmCopyIdBtn')?.addEventListener('click', () => {
      if (state.mailbox) copyText(state.mailbox.mailbox_id, 'Copied mailbox UUID');
    });
    container.querySelector('#tmRefreshBtn')?.addEventListener('click', () => refreshInbox({ silent: false }));
    container.querySelector('#tmDeleteBtn')?.addEventListener('click', deleteMailbox);
    container.querySelector('#tmAutoPoll')?.addEventListener('change', (e) => {
      state.autoRefresh = e.target.checked;
      startTimers();
    });
    container.querySelector('#tmRestoreToggleBtn')?.addEventListener('click', () => {
      state.restoreOpen = !state.restoreOpen;
      render();
    });
    container.querySelector('#tmRestoreForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      restoreMailboxById(container.querySelector('#tmRestoreInput')?.value);
    });

    container.querySelectorAll('[data-msg-id]').forEach((btn) => {
      btn.addEventListener('click', () => selectMessage(btn.dataset.msgId));
    });
    container.querySelectorAll('[data-tm-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.viewMode = btn.dataset.tmView;
        render();
      });
    });
    container.querySelectorAll('[data-copy-otp]').forEach((btn) => {
      btn.addEventListener('click', () => copyText(btn.dataset.copyOtp, `Copied code ${btn.dataset.copyOtp}`));
    });
  }

  function init() {
    loadSavedMailbox();
    render();
    if (state.mailbox) {
      startTimers();
      refreshInbox({ silent: true });
    }
  }

  return { init, render };
}
