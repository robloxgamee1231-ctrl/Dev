// Server-Side AES-256-GCM Encrypted Credential Vault (DEVTRACER — made by ★NDX★)
// Secrets are encrypted at rest, never logged, never returned to the browser,
// and only decrypted in-memory server-side for authorized outbound tests.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const CREDENTIAL_TYPES = new Set([
  'custom_api_key',
  'github_pat',
  'bearer_token',
  'ai_provider',
  'custom_integration'
]);

const DEFAULT_HEADER_BY_TYPE = {
  custom_api_key: { headerName: 'X-API-Key', authScheme: 'raw' },
  github_pat: { headerName: 'Authorization', authScheme: 'Bearer' },
  bearer_token: { headerName: 'Authorization', authScheme: 'Bearer' },
  ai_provider: { headerName: 'Authorization', authScheme: 'Bearer' },
  custom_integration: { headerName: 'Authorization', authScheme: 'Bearer' }
};

export function maskSecret(raw) {
  const s = String(raw || '').trim();
  if (!s) return '••••••••';
  if (s.length <= 8) return '••••••••';
  const prefixMatch = s.match(/^(ghp_|gho_|github_pat_|sk-ant-|sk-proj-|sk-or-|sk-|AIza|pk_live_|pk_test_)/);
  const prefix = prefixMatch ? prefixMatch[1] : s.slice(0, 3);
  const suffix = s.slice(-4);
  return `${prefix}••••••${suffix}`;
}

function validateHeaderName(name) {
  const clean = String(name || '').trim();
  if (!clean) return 'Authorization';
  if (!/^[A-Za-z0-9-]{2,64}$/.test(clean)) {
    throw Object.assign(new Error('Invalid HTTP header name.'), { status: 400, code: 'INVALID_HEADER' });
  }
  return clean;
}

function validateOptionalUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    return u.href;
  } catch {
    throw Object.assign(new Error('Endpoint URL must be a valid http(s) URL.'), { status: 400, code: 'INVALID_URL' });
  }
}

export function createCredentialVault({ vaultDir, masterSecret = process.env.DEVTRACER_VAULT_KEY || '' } = {}) {
  const dir = vaultDir || path.resolve(process.cwd(), '.devtracer');
  const vaultFile = path.join(dir, 'vault.enc.json');
  const keyFile = path.join(dir, '.master.key');
  const saltFile = path.join(dir, '.salt');

  let cachedKey = null;

  async function ensureDir() {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }

  async function getMasterKey() {
    if (cachedKey) return cachedKey;
    await ensureDir();

    if (masterSecret) {
      let salt;
      try {
        salt = await fs.readFile(saltFile);
      } catch {
        salt = crypto.randomBytes(16);
        await fs.writeFile(saltFile, salt, { mode: 0o600 });
      }
      cachedKey = crypto.scryptSync(masterSecret, salt, 32);
      return cachedKey;
    }

    try {
      const hex = (await fs.readFile(keyFile, 'utf8')).trim();
      const buf = Buffer.from(hex, 'hex');
      if (buf.length === 32) {
        cachedKey = buf;
        return cachedKey;
      }
    } catch {}

    const fresh = crypto.randomBytes(32);
    await fs.writeFile(keyFile, fresh.toString('hex'), { mode: 0o600 });
    cachedKey = fresh;
    return cachedKey;
  }

  async function encryptValue(plaintext) {
    const key = await getMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: authTag.toString('base64'),
      data: encrypted.toString('base64')
    };
  }

  async function decryptValue(blob) {
    if (!blob || !blob.iv || !blob.tag || !blob.data) return '';
    const key = await getMasterKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  }

  async function readStore() {
    try {
      const raw = await fs.readFile(vaultFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.entries)) return parsed;
    } catch {}
    return { version: 1, cipher: 'aes-256-gcm', entries: [] };
  }

  async function writeStore(store) {
    await ensureDir();
    await fs.writeFile(vaultFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  }

  function toPublicView(entry) {
    return {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      provider: entry.provider || '',
      headerName: entry.headerName,
      authScheme: entry.authScheme,
      baseUrl: entry.baseUrl || '',
      testUrl: entry.testUrl || '',
      maskedPreview: entry.status === 'revoked' ? '[REVOKED]' : entry.maskedPreview,
      status: entry.status,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      lastTestedAt: entry.lastTestedAt || null,
      lastTestResult: entry.lastTestResult || null
    };
  }

  async function list() {
    const store = await readStore();
    return store.entries.map(toPublicView);
  }

  async function create(payload = {}) {
    const name = String(payload.name || '').trim().slice(0, 80);
    const type = String(payload.type || 'custom_api_key').trim();
    const secret = String(payload.secret || '').trim();

    if (!name) throw Object.assign(new Error('Credential name is required.'), { status: 400 });
    if (!CREDENTIAL_TYPES.has(type)) throw Object.assign(new Error('Unsupported credential type.'), { status: 400 });
    if (!secret || secret.length < 4) throw Object.assign(new Error('Credential secret value is required (min 4 chars).'), { status: 400 });

    const defaults = DEFAULT_HEADER_BY_TYPE[type];
    const headerName = validateHeaderName(payload.headerName || defaults.headerName);
    const authScheme = String(payload.authScheme ?? defaults.authScheme).trim().slice(0, 24);
    const provider = String(payload.provider || '').trim().slice(0, 60);
    const baseUrl = validateOptionalUrl(payload.baseUrl);
    const testUrl = validateOptionalUrl(payload.testUrl || (type === 'github_pat' ? 'https://api.github.com/user' : ''));

    const now = new Date().toISOString();
    const entry = {
      id: `cred_${crypto.randomBytes(8).toString('hex')}`,
      name,
      type,
      provider,
      headerName,
      authScheme,
      baseUrl,
      testUrl,
      maskedPreview: maskSecret(secret),
      encrypted: await encryptValue(secret),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastTestedAt: null,
      lastTestResult: null
    };

    const store = await readStore();
    store.entries.unshift(entry);
    await writeStore(store);
    return toPublicView(entry);
  }

  async function update(id, payload = {}) {
    const store = await readStore();
    const entry = store.entries.find((e) => e.id === id);
    if (!entry) throw Object.assign(new Error('Credential not found.'), { status: 404 });

    if (payload.name != null) {
      const n = String(payload.name).trim().slice(0, 80);
      if (!n) throw Object.assign(new Error('Name cannot be empty.'), { status: 400 });
      entry.name = n;
    }
    if (payload.type != null && CREDENTIAL_TYPES.has(String(payload.type))) {
      entry.type = String(payload.type);
    }
    if (payload.provider != null) entry.provider = String(payload.provider).trim().slice(0, 60);
    if (payload.headerName != null) entry.headerName = validateHeaderName(payload.headerName);
    if (payload.authScheme != null) entry.authScheme = String(payload.authScheme).trim().slice(0, 24);
    if (payload.baseUrl != null) entry.baseUrl = validateOptionalUrl(payload.baseUrl);
    if (payload.testUrl != null) entry.testUrl = validateOptionalUrl(payload.testUrl);

    // Rotate / replace secret if a new secret was supplied
    if (payload.secret && String(payload.secret).trim().length >= 4) {
      const freshSecret = String(payload.secret).trim();
      entry.encrypted = await encryptValue(freshSecret);
      entry.maskedPreview = maskSecret(freshSecret);
      entry.status = 'active';
    }

    entry.updatedAt = new Date().toISOString();
    await writeStore(store);
    return toPublicView(entry);
  }

  async function revoke(id) {
    const store = await readStore();
    const entry = store.entries.find((e) => e.id === id);
    if (!entry) throw Object.assign(new Error('Credential not found.'), { status: 404 });
    entry.status = 'revoked';
    entry.encrypted = null;
    entry.maskedPreview = '[REVOKED]';
    entry.updatedAt = new Date().toISOString();
    await writeStore(store);
    return toPublicView(entry);
  }

  async function remove(id) {
    const store = await readStore();
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx === -1) throw Object.assign(new Error('Credential not found.'), { status: 404 });
    store.entries.splice(idx, 1);
    await writeStore(store);
    return { deleted: true, id };
  }

  async function recordTestResult(id, result) {
    const store = await readStore();
    const entry = store.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.lastTestedAt = new Date().toISOString();
    entry.lastTestResult = result;
    await writeStore(store);
    return toPublicView(entry);
  }

  // INTERNAL SERVER-SIDE ONLY: Builds outbound auth header without exposing secret to caller logs/UI
  async function resolveOutboundAuth(id) {
    const store = await readStore();
    const entry = store.entries.find((e) => e.id === id);
    if (!entry) throw Object.assign(new Error('Credential not found.'), { status: 404 });
    if (entry.status !== 'active' || !entry.encrypted) {
      throw Object.assign(new Error('Credential has been revoked.'), { status: 400, code: 'CREDENTIAL_REVOKED' });
    }
    const secret = await decryptValue(entry.encrypted);
    const scheme = entry.authScheme && entry.authScheme.toLowerCase() !== 'raw' ? `${entry.authScheme} ` : '';
    return {
      meta: toPublicView(entry),
      headers: { [entry.headerName]: `${scheme}${secret}` }
    };
  }

  return {
    list,
    create,
    update,
    revoke,
    remove,
    recordTestResult,
    resolveOutboundAuth,
    vaultFile
  };
}
