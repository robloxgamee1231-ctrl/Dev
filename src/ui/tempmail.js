// Temp Mail HUD Module
// Primary: ThrowawayMail (https://throwawaymail.app/api/docs)
// Automatic CORS-native browser providers for GitHub Pages:
//   - Mail.gw (https://api.mail.gw) — CORS *, real rotating domains
//   - Guerrilla Mail (https://api.guerrillamail.com) — CORS *, 60-min inbox

const MAILBOX_STORAGE_KEY = 'devtrace_tempmail_v2';
const THROWAWAY_BASE = 'https://throwawaymail.app';
const MAILGW_BASE = 'https://api.mail.gw';
const GUERRILLA_BASE = 'https://api.guerrillamail.com/ajax.php';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(str) {
  return UUID_RE.test(String(str || '').trim());
}

export function formatCountdown(expiresAtIso, nowMs = Date.now()) {
  if (!expiresAtIso) return { label: 'Active', expired: false, urgent: false, remainingMs: Infinity };
  const target = Date.parse(expiresAtIso);
  if (Number.isNaN(target)) return { label: 'Active', expired: false, urgent: false, remainingMs: Infinity };
  const remainingMs = Math.max(0, target - nowMs);
  if (remainingMs <= 0) {
    return { label: 'Expired', expired: true, urgent: true, remainingMs: 0 };
  }
  const totalSec = Math.ceil(remainingMs / 1000);
  if (totalSec > 7200) {
    const hrs = Math.floor(totalSec / 3600);
    return { label: `${hrs}h+ active`, expired: false, urgent: false, remainingMs };
  }
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

export function extractActionLinks(text = '', html = '') {
  const pool = `${text}\n${html}`;
  const found = new Set();
  const re = /https?:\/\/[^\s"'<>()]+/gi;
  let m;
  while ((m = re.exec(pool)) !== null && found.size < 4) {
    const url = m[0].replace(/[.,;)]+$/, '');
    if (/(?:verify|confirm|activate|auth|magic|login|token|reset|validate|invite)/i.test(url)) {
      found.add(url);
    }
  }
  return [...found];
}

function randomToken(len = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint8Array(len);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
  return out;
}

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

function formatBytes(n) {
  const b = Number(n) || 0;
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(1)} KB`;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function createTempMailController({ container, getContext, copyText, showToast }) {
  const state = {
    preferredProvider: 'auto', // 'auto' | 'throwaway' | 'mailgw' | 'guerrilla'
    mailbox: null, // { provider, mailbox_id, address, expires_at, created_at, token?, account_id?, sid_token? }
    messages: [],
    selectedMessageId: null,
    messageCache: new Map(),
    viewMode: 'text',
    autoRefresh: true,
    loading: false,
    polling: false,
    lastSyncAt: null,
    error: '',
    restoreOpen: false
  };

  let countdownTimer = null;
  let pollTimer = null;

  function loadSavedMailbox() {
    try {
      const saved = JSON.parse(localStorage.getItem(MAILBOX_STORAGE_KEY) || 'null');
      if (saved && saved.address && saved.provider) {
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

  // ==================== PROVIDER 1: THROWAWAYMAIL.APP ====================

  async function throwawayRequest(path, { method = 'GET' } = {}) {
    const ctx = getContext();
    const directUrl = `${THROWAWAY_BASE}${path}`;
    const attempts = [];

    // Prefer Worker or local server first when available (zero CORS friction)
    if (ctx.workerUrl && /^https?:\/\//i.test(ctx.workerUrl)) {
      attempts.push(async () => {
        const base = ctx.workerUrl.replace(/\/+$/, '');
        const res = await fetch(`${base}?url=${encodeURIComponent(directUrl)}&method=${encodeURIComponent(method)}`, {
          signal: AbortSignal.timeout(10_000)
        });
        const wrapper = await res.json();
        if (wrapper.error) throw new Error(wrapper.error);
        if (wrapper.status === 204) return null;
        const data = wrapper.body ? JSON.parse(wrapper.body) : null;
        if (wrapper.status >= 400) {
          const err = new Error(data?.detail || data?.error || `HTTP ${wrapper.status}`);
          err.httpStatus = wrapper.status;
          throw err;
        }
        return data;
      });
    }

    if (ctx.serverAvailable) {
      attempts.push(async () => {
        const res = await fetch(`.${path}`, {
          method,
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(9_000)
        });
        if (res.status === 204) return null;
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          const err = new Error(data?.detail || data?.error || `HTTP ${res.status}`);
          err.httpStatus = res.status;
          throw err;
        }
        return data;
      });
    }

    // Direct browser attempt (fast timeout so CORS failure fails over instantly)
    attempts.push(async () => {
      const res = await fetch(directUrl, {
        method,
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000)
      });
      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(data?.detail || data?.error || `HTTP ${res.status}`);
        err.httpStatus = res.status;
        throw err;
      }
      return data;
    });

    let lastErr;
    for (const run of attempts) {
      try {
        return await run();
      } catch (err) {
        if (err?.httpStatus === 404 || err?.httpStatus === 422 || err?.httpStatus === 400) throw err;
        lastErr = err;
      }
    }
    throw lastErr || new Error('ThrowawayMail unreachable from browser (CORS)');
  }

  async function createThrowawayMailbox() {
    const data = await throwawayRequest('/api/mailboxes', { method: 'POST' });
    return {
      provider: 'throwaway',
      providerLabel: 'ThrowawayMail',
      mailbox_id: data.mailbox_id,
      address: data.address,
      expires_at: data.expires_at,
      created_at: data.created_at
    };
  }

  // ==================== PROVIDER 2: MAIL.GW (CORS * NATIVE) ====================

  async function mailGwFetch(path, { method = 'GET', token = '', body = null } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${MAILGW_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000)
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.['hydra:description'] || data?.detail || data?.message || `Mail.gw HTTP ${res.status}`);
      err.httpStatus = res.status;
      throw err;
    }
    return data;
  }

  async function createMailGwMailbox() {
    const domRes = await mailGwFetch('/domains?page=1');
    const members = domRes?.['hydra:member'] || [];
    const active = members.filter((d) => d.isActive !== false && d.domain);
    if (active.length === 0) throw new Error('Mail.gw returned no active domains.');
    const domain = active[Math.floor(Math.random() * active.length)].domain;
    const user = `dt${randomToken(9)}`;
    const address = `${user}@${domain}`;
    const password = `P!${randomToken(14)}`;

    const acc = await mailGwFetch('/accounts', { method: 'POST', body: { address, password } });
    const tok = await mailGwFetch('/token', { method: 'POST', body: { address, password } });

    return {
      provider: 'mailgw',
      providerLabel: 'Mail.gw',
      mailbox_id: acc.id,
      account_id: acc.id,
      address: acc.address || address,
      token: tok.token,
      created_at: acc.createdAt || new Date().toISOString(),
      expires_at: null // Active until deleted (7-day retention)
    };
  }

  // ==================== PROVIDER 3: GUERRILLA MAIL (CORS * NATIVE) ====================

  async function guerrillaFetch(params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${GUERRILLA_BASE}?${qs}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000)
    });
    if (!res.ok) throw new Error(`GuerrillaMail HTTP ${res.status}`);
    return await res.json();
  }

  async function createGuerrillaMailbox() {
    const data = await guerrillaFetch({ f: 'get_email_address', lang: 'en' });
    if (!data?.email_addr || !data?.sid_token) throw new Error('GuerrillaMail returned invalid session.');
    const createdMs = Date.now();
    return {
      provider: 'guerrilla',
      providerLabel: 'GuerrillaMail',
      mailbox_id: data.sid_token,
      sid_token: data.sid_token,
      address: data.email_addr,
      created_at: new Date(createdMs).toISOString(),
      expires_at: new Date(createdMs + 60 * 60 * 1000).toISOString()
    };
  }

  // ==================== UNIFIED ACTIONS ====================

  async function createMailbox() {
    if (state.loading) return;
    state.loading = true;
    state.error = '';
    render();

    const order =
      state.preferredProvider === 'throwaway'
        ? [createThrowawayMailbox]
        : state.preferredProvider === 'mailgw'
          ? [createMailGwMailbox]
          : state.preferredProvider === 'guerrilla'
            ? [createGuerrillaMailbox]
            : [createThrowawayMailbox, createMailGwMailbox, createGuerrillaMailbox];

    let created = null;
    const errors = [];
    for (const fn of order) {
      try {
        created = await fn();
        if (created) break;
      } catch (err) {
        errors.push(err?.message || 'provider failed');
      }
    }

    if (created) {
      state.mailbox = created;
      state.messages = [];
      state.selectedMessageId = null;
      state.messageCache.clear();
      state.lastSyncAt = new Date().toISOString();
      persistMailbox();
      startTimers();
      showToast(`Live inbox ready (${created.providerLabel}): ${created.address}`);
      // Immediately fetch initial inbox (e.g. Guerrilla welcome message)
      state.loading = false;
      render();
      refreshInbox({ silent: true });
      return;
    }

    state.error = `Could not allocate a temporary mailbox (${errors.join(' · ')}).`;
    state.loading = false;
    render();
  }

  async function refreshInbox({ silent = false } = {}) {
    const mb = state.mailbox;
    if (!mb || state.polling) return;
    const cd = formatCountdown(mb.expires_at);
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
      let normalized = [];

      if (mb.provider === 'throwaway') {
        const data = await throwawayRequest(`/api/mailboxes/${encodeURIComponent(mb.mailbox_id)}`, { method: 'GET' });
        mb.expires_at = data.expires_at;
        normalized = (data.messages || []).map((m) => ({
          message_id: String(m.message_id),
          from_address: m.from_address || '',
          from_name: m.from_name || '',
          subject: m.subject || '(No subject)',
          received_at: m.received_at || '',
          size: m.size || 0,
          read: Boolean(m.read)
        }));
      } else if (mb.provider === 'mailgw') {
        const data = await mailGwFetch('/messages?page=1', { token: mb.token });
        normalized = (data?.['hydra:member'] || []).map((m) => ({
          message_id: String(m.id),
          from_address: m.from?.address || '',
          from_name: m.from?.name || '',
          subject: m.subject || '(No subject)',
          received_at: m.createdAt || '',
          size: m.size || 0,
          read: Boolean(m.seen)
        }));
      } else if (mb.provider === 'guerrilla') {
        const data = await guerrillaFetch({ f: 'get_email_list', offset: '0', sid_token: mb.sid_token });
        normalized = (data?.list || []).map((m) => ({
          message_id: String(m.mail_id),
          from_address: m.mail_from || '',
          from_name: '',
          subject: m.mail_subject || '(No subject)',
          received_at: m.mail_timestamp ? new Date(Number(m.mail_timestamp) * 1000).toISOString() : '',
          size: Number(m.mail_size) || 0,
          read: m.mail_read === '1' || m.mail_read === 1
        }));
      }

      state.messages = normalized;
      state.lastSyncAt = new Date().toISOString();
      persistMailbox();

      if (state.messages.length > prevCount && prevCount > 0) {
        showToast(`New email arrived (${state.messages.length} in inbox)`);
      }
      if (!state.selectedMessageId && state.messages.length > 0) {
        selectMessage(state.messages[0].message_id);
      }
    } catch (err) {
      if (err?.httpStatus === 404 || err?.httpStatus === 401) {
        state.error = 'Mailbox expired or closed. Click New Address to generate a fresh inbox.';
        state.mailbox = null;
        state.messages = [];
        persistMailbox();
        stopTimers();
      } else if (!silent) {
        state.error = err?.message || 'Refresh failed.';
      }
    } finally {
      state.polling = false;
      render();
    }
  }

  async function selectMessage(messageId) {
    const mb = state.mailbox;
    if (!mb || !messageId) return;
    state.selectedMessageId = String(messageId);
    render();
    if (state.messageCache.has(state.selectedMessageId)) return;

    try {
      let detail = null;
      if (mb.provider === 'throwaway') {
        const d = await throwawayRequest(
          `/api/mailboxes/${encodeURIComponent(mb.mailbox_id)}/messages/${encodeURIComponent(messageId)}`,
          { method: 'GET' }
        );
        detail = {
          message_id: String(d.message_id),
          from_address: d.from_address || '',
          from_name: d.from_name || '',
          to_addresses: d.to_addresses || [mb.address],
          reply_to: d.reply_to || '',
          subject: d.subject || '(No subject)',
          received_at: d.received_at || '',
          text: d.text || '',
          html: d.html || ''
        };
      } else if (mb.provider === 'mailgw') {
        const d = await mailGwFetch(`/messages/${encodeURIComponent(messageId)}`, { token: mb.token });
        const htmlBody = Array.isArray(d.html) ? d.html.join('\n') : (d.html || '');
        detail = {
          message_id: String(d.id),
          from_address: d.from?.address || '',
          from_name: d.from?.name || '',
          to_addresses: (d.to || []).map((t) => t.address || t).filter(Boolean),
          reply_to: '',
          subject: d.subject || '(No subject)',
          received_at: d.createdAt || '',
          text: d.text || stripHtmlToText(htmlBody),
          html: htmlBody
        };
      } else if (mb.provider === 'guerrilla') {
        const d = await guerrillaFetch({ f: 'fetch_email', email_id: String(messageId), sid_token: mb.sid_token });
        const htmlBody = d.mail_body || '';
        detail = {
          message_id: String(d.mail_id || messageId),
          from_address: d.mail_from || '',
          from_name: '',
          to_addresses: [mb.address],
          reply_to: '',
          subject: d.mail_subject || '(No subject)',
          received_at: d.mail_timestamp ? new Date(Number(d.mail_timestamp) * 1000).toISOString() : '',
          text: stripHtmlToText(htmlBody),
          html: htmlBody
        };
      }

      if (detail) {
        state.messageCache.set(state.selectedMessageId, detail);
        state.viewMode = detail.text ? 'text' : detail.html ? 'html' : 'text';
        const summary = state.messages.find((m) => m.message_id === state.selectedMessageId);
        if (summary) summary.read = true;
      }
    } catch (err) {
      state.error = err?.message || 'Failed to load email body.';
    }
    render();
  }

  async function deleteMailbox() {
    const mb = state.mailbox;
    if (!mb || state.loading) return;
    state.loading = true;
    state.error = '';
    render();
    try {
      if (mb.provider === 'throwaway') {
        await throwawayRequest(`/api/mailboxes/${encodeURIComponent(mb.mailbox_id)}`, { method: 'DELETE' });
      } else if (mb.provider === 'mailgw' && mb.account_id) {
        await mailGwFetch(`/accounts/${encodeURIComponent(mb.account_id)}`, { method: 'DELETE', token: mb.token });
      } else if (mb.provider === 'guerrilla') {
        await guerrillaFetch({ f: 'forget_me', email_addr: mb.address, sid_token: mb.sid_token });
      }
    } catch {
      // Clear local state regardless
    } finally {
      state.mailbox = null;
      state.messages = [];
      state.selectedMessageId = null;
      state.messageCache.clear();
      persistMailbox();
      stopTimers();
      state.loading = false;
      showToast('Mailbox burned');
      render();
    }
  }

  async function restoreThrowawayById(rawId) {
    const id = String(rawId || '').trim();
    if (!isValidUuid(id)) {
      state.error = 'Enter a valid ThrowawayMail UUID (e.g. 550e8400-e29b-41d4-a716-446655440000).';
      render();
      return;
    }
    state.loading = true;
    state.error = '';
    render();
    try {
      const data = await throwawayRequest(`/api/mailboxes/${encodeURIComponent(id)}`, { method: 'GET' });
      state.mailbox = {
        provider: 'throwaway',
        providerLabel: 'ThrowawayMail',
        mailbox_id: data.mailbox_id,
        address: data.address,
        expires_at: data.expires_at,
        created_at: data.created_at
      };
      state.messages = (data.messages || []).map((m) => ({
        message_id: String(m.message_id),
        from_address: m.from_address || '',
        from_name: m.from_name || '',
        subject: m.subject || '(No subject)',
        received_at: m.received_at || '',
        size: m.size || 0,
        read: Boolean(m.read)
      }));
      state.selectedMessageId = state.messages[0]?.message_id || null;
      state.messageCache.clear();
      state.restoreOpen = false;
      state.lastSyncAt = new Date().toISOString();
      persistMailbox();
      startTimers();
      showToast(`Connected to ${data.address}`);
      if (state.selectedMessageId) selectMessage(state.selectedMessageId);
    } catch (err) {
      state.error = err?.message || 'Could not restore mailbox.';
    } finally {
      state.loading = false;
      render();
    }
  }

  function stopPollTimer() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function stopTimers() {
    stopPollTimer();
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  function startTimers() {
    stopTimers();
    if (!state.mailbox) return;
    if (state.mailbox.expires_at) {
      countdownTimer = setInterval(() => {
        const el = container.querySelector('#tmCountdown');
        if (!el || !state.mailbox) return;
        const cd = formatCountdown(state.mailbox.expires_at);
        el.textContent = cd.expired ? 'Expired' : `${cd.label} left`;
        el.className = `tm-countdown ${cd.expired ? 'expired' : cd.urgent ? 'urgent' : ''}`;
        if (cd.expired) stopPollTimer();
      }, 1000);
    }
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
    const actionLinks = selectedMsg ? extractActionLinks(selectedMsg.text || '', selectedMsg.html || '') : [];

    container.innerHTML = `
      <div class="zai-hero">
        <h1 class="zai-title">Disposable Temp Mail</h1>
        <p class="zai-subtitle">Instant working inbox powered by <code>throwawaymail.app</code> with automatic CORS-native browser failover (<code>mail.gw</code> &amp; <code>guerrillamail</code>) so it works straight from GitHub Pages.</p>
      </div>

      <!-- Liquid Glass Composer Bar -->
      <div class="zai-composer glass-surface">
        <div class="composer-main-row">
          <div class="composer-display ${mb ? 'has-value' : ''}">
            ${mb
              ? `<span class="mono composer-address" id="tmAddressText">${esc(mb.address)}</span>`
              : `<span class="composer-placeholder">Click Create Mailbox to generate a live disposable email…</span>`
            }
          </div>
          <div class="composer-actions">
            ${mb ? `<button type="button" class="btn btn-glass btn-sm" id="tmCopyBtn">Copy</button>` : ''}
            <button type="button" class="btn btn-primary btn-sm" id="tmCreateBtn" ${state.loading ? 'disabled' : ''}>
              ${state.loading ? 'Creating…' : mb ? 'New Address' : 'Create Mailbox'}
            </button>
          </div>
        </div>

        <div class="composer-footer-row">
          <div class="composer-meta-left">
            ${mb ? `
              <span class="badge badge-first-party">${esc(mb.providerLabel || mb.provider)}</span>
              <span class="tm-countdown ${cd.expired ? 'expired' : cd.urgent ? 'urgent' : ''}" id="tmCountdown">${cd.expired ? 'Expired' : mb.expires_at ? `${cd.label} left` : 'Active · 7d TTL'}</span>
              ${mb.provider === 'throwaway' ? `<button type="button" class="link-btn mono" id="tmCopyIdBtn" title="Copy mailbox UUID">UUID: ${esc(mb.mailbox_id.slice(0, 8))}…</button>` : ''}
              <label class="inline-toggle">
                <input type="checkbox" id="tmAutoPoll" ${state.autoRefresh ? 'checked' : ''} />
                <span>Auto-refresh (5s)</span>
              </label>
            ` : `
              <span class="muted-text mono">Provider:</span>
              <select id="tmProviderSelect" class="glass-select mono" aria-label="Temp Mail Provider">
                <option value="auto" ${state.preferredProvider === 'auto' ? 'selected' : ''}>Auto (ThrowawayMail → Mail.gw)</option>
                <option value="mailgw" ${state.preferredProvider === 'mailgw' ? 'selected' : ''}>Mail.gw (Browser Direct)</option>
                <option value="guerrilla" ${state.preferredProvider === 'guerrilla' ? 'selected' : ''}>GuerrillaMail (Browser Direct)</option>
                <option value="throwaway" ${state.preferredProvider === 'throwaway' ? 'selected' : ''}>ThrowawayMail (Server / Worker)</option>
              </select>
            `}
          </div>
          <div class="composer-meta-right">
            ${mb ? `
              <button type="button" class="btn btn-glass btn-xs" id="tmRefreshBtn" ${state.polling ? 'disabled' : ''}>${state.polling ? 'Checking…' : 'Refresh'}</button>
              <button type="button" class="btn btn-danger-ghost btn-xs" id="tmDeleteBtn">Burn</button>
            ` : ''}
            <button type="button" class="btn btn-glass btn-xs" id="tmRestoreToggleBtn">${state.restoreOpen ? 'Close' : 'Restore UUID'}</button>
            <a href="https://throwawaymail.app/api/docs" target="_blank" rel="noopener noreferrer" class="btn btn-glass btn-xs">API Docs ↗</a>
          </div>
        </div>
      </div>

      ${state.restoreOpen ? `
        <form class="inline-panel glass-surface" id="tmRestoreForm">
          <input type="text" id="tmRestoreInput" class="code-input compact" placeholder="Paste ThrowawayMail mailbox_id UUID…" autocomplete="off" spellcheck="false" />
          <button type="submit" class="btn btn-primary btn-sm">Reconnect</button>
        </form>
      ` : ''}

      ${state.error ? `<div class="status-banner error glass-surface">${esc(state.error)}</div>` : ''}

      <!-- Split Inbox + Reader -->
      <div class="tm-workspace">
        <div class="panel glass-surface tm-list-panel">
          <div class="panel-header">
            <h3 class="panel-title">Inbox <span class="tab-badge">${state.messages.length}</span></h3>
            <span class="muted-text mono">${state.lastSyncAt ? `Synced ${formatTime(state.lastSyncAt)}` : 'Idle'}</span>
          </div>
          <div class="tm-msg-list">
            ${!mb
              ? `<div class="empty-box">Hit <strong>Create Mailbox</strong> above — works immediately on GitHub Pages with zero setup.</div>`
              : state.messages.length === 0
                ? `<div class="empty-box">
                    <div class="pulse-line"><span class="live-dot"></span>Listening on <code>${esc(mb.address)}</code></div>
                    <div class="muted-text" style="margin-top:6px;">Send a signup or test email to this address — inbox polls every 5s.</div>
                  </div>`
                : state.messages.map((m) => `
                  <button type="button" class="tm-msg-row ${state.selectedMessageId === m.message_id ? 'active' : ''}" data-msg-id="${esc(m.message_id)}">
                    <div class="tm-msg-top">
                      <span class="tm-sender">${!m.read ? '<span class="unread-dot"></span>' : ''}${esc(m.from_name || m.from_address || 'Unknown sender')}</span>
                      <span class="muted-text mono">${esc(formatTime(m.received_at))}</span>
                    </div>
                    <div class="tm-subject">${esc(m.subject)}</div>
                    <div class="tm-submeta mono">${esc(m.from_address)}${m.size ? ` · ${formatBytes(m.size)}` : ''}</div>
                  </button>
                `).join('')
            }
          </div>
        </div>

        <div class="panel glass-surface tm-reader-panel">
          <div class="panel-header">
            <h3 class="panel-title">${selectedMsg ? esc(selectedMsg.subject) : 'Message Viewer'}</h3>
            ${selectedMsg ? `
              <div class="row-gap">
                <button type="button" class="filter-pill ${state.viewMode === 'text' ? 'active' : ''}" data-tm-view="text">Plain Text</button>
                ${selectedMsg.html ? `<button type="button" class="filter-pill ${state.viewMode === 'html' ? 'active' : ''}" data-tm-view="html">Sandboxed HTML</button>` : ''}
              </div>
            ` : ''}
          </div>
          <div class="panel-body">
            ${!state.selectedMessageId
              ? `<div class="empty-box">Incoming messages, OTP verification codes, and confirmation links render here.</div>`
              : !selectedMsg
                ? `<div class="empty-box">Loading message…</div>`
                : `
                  <div class="tm-meta-grid">
                    <div><span class="muted-text">From</span><span class="mono">${esc(selectedMsg.from_name ? `${selectedMsg.from_name} <${selectedMsg.from_address}>` : selectedMsg.from_address)}</span></div>
                    <div><span class="muted-text">To</span><span class="mono">${esc((selectedMsg.to_addresses || []).join(', '))}</span></div>
                    <div><span class="muted-text">Received</span><span class="mono">${esc(selectedMsg.received_at ? new Date(selectedMsg.received_at).toLocaleString() : 'Just now')}</span></div>
                  </div>

                  ${otps.length > 0 ? `
                    <div class="otp-bar">
                      <span class="otp-label">VERIFICATION CODE</span>
                      <div class="row-gap">
                        ${otps.map((code) => `
                          <button type="button" class="otp-chip" data-copy-otp="${esc(code)}">${esc(code)} · Copy</button>
                        `).join('')}
                      </div>
                    </div>
                  ` : ''}

                  ${actionLinks.length > 0 ? `
                    <div class="url-list" style="margin-bottom:12px;">
                      ${actionLinks.map((lnk) => {
                        const href = safeHref(lnk);
                        return href ? `<div class="url-row"><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">Verify / Action Link ↗ ${esc(lnk.slice(0, 72))}</a><button type="button" class="btn btn-glass btn-xs" data-copy-otp="${esc(href)}">Copy</button></div>` : '';
                      }).join('')}
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
    container.querySelector('#tmProviderSelect')?.addEventListener('change', (e) => {
      state.preferredProvider = e.target.value;
    });
    container.querySelector('#tmRestoreToggleBtn')?.addEventListener('click', () => {
      state.restoreOpen = !state.restoreOpen;
      render();
    });
    container.querySelector('#tmRestoreForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      restoreThrowawayById(container.querySelector('#tmRestoreInput')?.value);
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
      btn.addEventListener('click', () => copyText(btn.dataset.copyOtp, `Copied ${btn.dataset.copyOtp.slice(0, 32)}`));
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
