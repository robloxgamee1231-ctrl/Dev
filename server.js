import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { analyzeScan } from './src/engine/analyzer.js';
import { scanGitHubRepo } from './src/engine/github.js';
import { getApexDomain, normalizeHost } from './src/engine/tlds.js';
import { createCredentialVault } from './src/server/vault.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname;

const MAX_FILE_BYTES = 1_500_000;
const MAX_TOTAL_BYTES = 9_000_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

// Known noisy third-party ad/tracker hosts whose bundles we skip crawling (we still record their domains from HTML!)
const SKIP_BUNDLE_HOSTS = [
  'googletagmanager.com',
  'google-analytics.com',
  'doubleclick.net',
  'googlesyndication.com',
  'connect.facebook.net',
  'static.hotjar.com',
  'clarity.ms',
  'snap.licdn.com',
  'analytics.tiktok.com',
  'bat.bing.com',
  'platform.twitter.com'
];

export function isBlockedIP(ip) {
  if (!ip || typeof ip !== 'string') return true;
  let addr = ip.trim().toLowerCase();

  // Unwrap IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
  if (addr.startsWith('::ffff:')) {
    const mapped = addr.slice(7);
    if (net.isIPv4(mapped)) addr = mapped;
  }

  if (net.isIPv4(addr)) {
    const parts = addr.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast & reserved
    return false;
  }

  if (net.isIPv6(addr)) {
    if (addr === '::' || addr === '::1') return true;
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique local fc00::/7
    if (addr.startsWith('fe8') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb')) return true; // link-local fe80::/10
    if (addr.startsWith('ff')) return true; // multicast
    return false;
  }

  return true;
}

export async function assertSafeTargetUrl(rawUrl, { allowLocalTest = false } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error('Invalid URL format. Include a domain like https://example.com.'), { status: 400, code: 'INVALID_URL' });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('Only http:// and https:// URLs are supported.'), { status: 400, code: 'INVALID_SCHEME' });
  }

  const host = normalizeHost(parsed.hostname);
  if (!host) {
    throw Object.assign(new Error('Missing hostname.'), { status: 400, code: 'INVALID_URL' });
  }

  if (allowLocalTest) return parsed;

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw Object.assign(new Error('Private and loopback hostnames are blocked by server SSRF protection.'), { status: 403, code: 'SSRF_BLOCKED' });
  }

  if (net.isIP(host)) {
    if (isBlockedIP(host)) {
      throw Object.assign(new Error('Private or reserved IP addresses are blocked by server SSRF protection.'), { status: 403, code: 'SSRF_BLOCKED' });
    }
    return parsed;
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch (err) {
    throw Object.assign(
      new Error(`DNS lookup failed for ${host}. The server may not have network egress to this host.`),
      { status: 502, code: 'NETWORK_RESTRICTED', cause: err }
    );
  }

  if (!records || records.length === 0) {
    throw Object.assign(new Error(`No DNS records found for ${host}.`), { status: 502, code: 'NETWORK_RESTRICTED' });
  }

  for (const rec of records) {
    if (isBlockedIP(rec.address)) {
      throw Object.assign(new Error(`Resolved IP (${rec.address}) is private/reserved and blocked.`), { status: 403, code: 'SSRF_BLOCKED' });
    }
  }

  return parsed;
}

async function readBoundedText(response, maxBytes = MAX_FILE_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        try { await reader.cancel(); } catch {}
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        try { await reader.cancel(); } catch {}
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(combined);
}

async function safeFetch(url, { allowLocalTest = false, maxBytes = MAX_FILE_BYTES, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeTargetUrl(currentUrl, { allowLocalTest });
    let res;
    try {
      res = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DEVTRACER/1.0; +https://github.com/robloxgamee1231-ctrl/Dev)',
          Accept: 'text/html,application/xhtml+xml,application/javascript,text/javascript,text/css,application/json,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
    } catch (err) {
      throw Object.assign(
        new Error(`Could not fetch ${currentUrl}: ${err?.message || 'connection failed'}`),
        { status: 502, code: 'NETWORK_RESTRICTED', cause: err }
      );
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), currentUrl).toString();
      currentUrl = next;
      continue;
    }

    const headersObj = {};
    res.headers.forEach((value, key) => {
      headersObj[key.toLowerCase()] = value;
    });

    const contentType = headersObj['content-type'] || '';
    const text = await readBoundedText(res, maxBytes);

    return {
      ok: res.ok,
      status: res.status,
      finalUrl: currentUrl,
      headers: headersObj,
      contentType,
      text
    };
  }

  throw Object.assign(new Error('Too many HTTP redirects.'), { status: 502, code: 'TOO_MANY_REDIRECTS' });
}

function discoverLinkedAssets(html, baseUrl) {
  const base = new URL(baseUrl);
  const baseApex = getApexDomain(base.hostname);

  const scripts = [];
  const styles = [];
  const manifests = [];
  const seen = new Set();

  const resolve = (raw) => {
    try {
      const u = new URL(raw.trim(), base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u;
    } catch {
      return null;
    }
  };

  // <script src="...">
  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    const u = resolve(m[1] || m[2]);
    if (!u || seen.has(u.href)) continue;
    seen.add(u.href);
    const host = normalizeHost(u.hostname);
    if (SKIP_BUNDLE_HOSTS.some((s) => host === s || host.endsWith('.' + s))) continue;
    const isSameOrigin = u.origin === base.origin;
    const isSameApex = getApexDomain(host) === baseApex;
    scripts.push({
      url: u.href,
      name: u.pathname.replace(/^\/+/, '') || u.hostname,
      priority: isSameOrigin ? 3 : isSameApex ? 2 : 1
    });
  }

  // <link rel="modulepreload" href="...">
  const preloadRe = /<link\b[^>]*\brel\s*=\s*["'][^"']*(?:modulepreload|preload)[^"']*["'][^>]*>/gi;
  while ((m = preloadRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/as\s*=\s*["']script["']|modulepreload/i.test(tag)) continue;
    const hrefMatch = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const u = resolve(hrefMatch[1]);
    if (!u || seen.has(u.href)) continue;
    seen.add(u.href);
    const isSameOrigin = u.origin === base.origin;
    const isSameApex = getApexDomain(normalizeHost(u.hostname)) === baseApex;
    if (isSameOrigin || isSameApex) {
      scripts.push({
        url: u.href,
        name: u.pathname.replace(/^\/+/, '') || u.hostname,
        priority: isSameOrigin ? 3 : 2
      });
    }
  }

  // <link rel="stylesheet" href="..."> & manifest
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    const relMatch = tag.match(/\brel\s*=\s*["']([^"']+)["']/i);
    const hrefMatch = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!relMatch || !hrefMatch) continue;
    const rel = relMatch[1].toLowerCase();
    const u = resolve(hrefMatch[1]);
    if (!u || seen.has(u.href)) continue;
    const isSameOrigin = u.origin === base.origin;
    const isSameApex = getApexDomain(normalizeHost(u.hostname)) === baseApex;

    if (rel.includes('stylesheet') && (isSameOrigin || isSameApex)) {
      seen.add(u.href);
      styles.push({ url: u.href, name: u.pathname.replace(/^\/+/, '') || 'style.css' });
    } else if (rel.includes('manifest') && isSameOrigin) {
      seen.add(u.href);
      manifests.push({ url: u.href, name: u.pathname.replace(/^\/+/, '') || 'manifest.json' });
    }
  }

  scripts.sort((a, b) => b.priority - a.priority);
  return { scripts, styles, manifests };
}

export async function performServerWebsiteScan(rawUrl, { maxBundles = 8, probeMeta = true, allowLocalTest = false } = {}) {
  let normalizedUrl = String(rawUrl || '').trim();
  if (!normalizedUrl) {
    throw Object.assign(new Error('URL is required.'), { status: 400, code: 'INVALID_URL' });
  }
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = 'https://' + normalizedUrl;
  }

  const mainRes = await safeFetch(normalizedUrl, { allowLocalTest, maxBytes: MAX_FILE_BYTES });
  const finalUrl = mainRes.finalUrl;
  const origin = new URL(finalUrl).origin;

  const artifacts = [
    {
      name: new URL(finalUrl).pathname === '/' ? 'index.html' : new URL(finalUrl).pathname.replace(/^\/+/, ''),
      url: finalUrl,
      type: 'html',
      content: mainRes.text,
      bytes: mainRes.text.length
    }
  ];

  let totalBytes = mainRes.text.length;
  const { scripts, styles, manifests } = discoverLinkedAssets(mainRes.text, finalUrl);

  const boundedBundles = Math.max(0, Math.min(20, Number(maxBundles) || 0));
  const fetchQueue = [
    ...scripts.slice(0, boundedBundles).map((s) => ({ ...s, type: 'js', maxBytes: 900_000 })),
    ...styles.slice(0, 3).map((s) => ({ ...s, type: 'css', maxBytes: 450_000 })),
    ...manifests.slice(0, 1).map((m) => ({ ...m, type: 'json', maxBytes: 120_000 }))
  ];

  if (probeMeta) {
    fetchQueue.push(
      { url: `${origin}/robots.txt`, name: 'robots.txt', type: 'config', maxBytes: 120_000 },
      { url: `${origin}/sitemap.xml`, name: 'sitemap.xml', type: 'config', maxBytes: 220_000 },
      { url: `${origin}/.well-known/security.txt`, name: '.well-known/security.txt', type: 'config', maxBytes: 60_000 }
    );
  }

  // Fetch all linked assets concurrently under a tight 6.5s overall budget
  if (fetchQueue.length > 0) {
    const collected = [];
    const fetchAll = Promise.all(
      fetchQueue.map(async (item) => {
        try {
          const r = await safeFetch(item.url, { allowLocalTest, maxBytes: item.maxBytes, timeoutMs: 4_800 });
          if (!r.ok || !r.text) return;
          if (item.type !== 'html' && /^\s*<!doctype html/i.test(r.text)) return;
          collected.push({
            name: item.name,
            url: r.finalUrl,
            type: item.type,
            content: r.text,
            bytes: r.text.length
          });
        } catch {}
      })
    );

    let budgetTimer;
    try {
      await Promise.race([
        fetchAll,
        new Promise((resolve) => {
          budgetTimer = setTimeout(resolve, 6_500);
          budgetTimer.unref?.();
        })
      ]);
    } finally {
      clearTimeout(budgetTimer);
    }

    for (const art of collected) {
      if (totalBytes + art.bytes <= MAX_TOTAL_BYTES) {
        totalBytes += art.bytes;
        artifacts.push(art);
      }
    }
  }

  return analyzeScan({
    target: normalizedUrl,
    targetUrl: finalUrl,
    mode: 'website',
    transport: 'server',
    headers: mainRes.headers,
    artifacts,
    meta: {
      status: mainRes.status,
      finalUrl,
      contentType: mainRes.contentType,
      discoveredScripts: scripts.length,
      crawledScripts: artifacts.filter((a) => a.type === 'js').length
    }
  });
}

async function readJsonBody(req, maxBytes = 65_536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const ALLOWED_STATIC_PREFIXES = ['/styles/', '/src/', '/worker/'];

async function serveStatic(req, res, pathname) {
  let relPath = pathname === '/' ? '/index.html' : pathname;
  try {
    relPath = decodeURIComponent(relPath);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const isAllowed =
    relPath === '/index.html' ||
    ALLOWED_STATIC_PREFIXES.some((prefix) => relPath.startsWith(prefix));

  if (!isAllowed) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const resolved = path.resolve(ROOT_DIR, '.' + relPath);
  if (!resolved.startsWith(ROOT_DIR + path.sep) && resolved !== path.join(ROOT_DIR, 'index.html')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const data = await fs.readFile(resolved);
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const ROOT_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

async function proxyUpstreamJson(targetUrl, { method = 'GET', timeoutMs = 15_000 } = {}) {
  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'DevTrace/1.0 (+https://github.com/robloxgamee1231-ctrl/Dev)'
      }
    });
  } catch (err) {
    throw Object.assign(
      new Error(`Upstream request failed: ${err?.message || 'network unreachable'}`),
      { status: 502, code: 'NETWORK_RESTRICTED' }
    );
  }

  if (upstream.status === 204) {
    return { status: 204, body: null };
  }

  const text = await readBoundedText(upstream, MAX_FILE_BYTES);
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text.slice(0, 240) || `HTTP ${upstream.status}` };
  }
  return { status: upstream.status, body: parsed };
}

const ALLOWED_INSPECT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const CRED_ID_RE = /^cred_[0-9a-f]{16}$/i;

async function inspectPublicDnsRecords(domain) {
  const safeCall = async (fn) => {
    try { return await fn(); } catch { return []; }
  };
  const [a, aaaa, cname, mx, ns, txt, soa] = await Promise.all([
    safeCall(() => dns.resolve4(domain)),
    safeCall(() => dns.resolve6(domain)),
    safeCall(() => dns.resolveCname(domain)),
    safeCall(() => dns.resolveMx(domain)),
    safeCall(() => dns.resolveNs(domain)),
    safeCall(() => dns.resolveTxt(domain)),
    safeCall(() => dns.resolveSoa(domain).then((s) => (s ? [s] : [])))
  ]);
  return {
    domain,
    records: {
      A: a,
      AAAA: aaaa,
      CNAME: cname,
      MX: mx.map((m) => `${m.priority} ${m.exchange}`),
      NS: ns,
      TXT: txt.map((parts) => (Array.isArray(parts) ? parts.join('') : String(parts))),
      SOA: soa.map((s) => `${s.nsname} (${s.hostmaster})`)
    }
  };
}

async function performAuthorizedEndpointRequest({
  url,
  method = 'GET',
  headers = {},
  body = null,
  credentialId = '',
  vault,
  allowLocalTest = false
}) {
  let targetUrl = String(url || '').trim();
  if (!targetUrl) throw Object.assign(new Error('Endpoint URL is required.'), { status: 400, code: 'INVALID_URL' });
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

  const normMethod = String(method || 'GET').toUpperCase();
  if (!ALLOWED_INSPECT_METHODS.has(normMethod)) {
    throw Object.assign(new Error(`Unsupported HTTP method: ${normMethod}`), { status: 400 });
  }

  await assertSafeTargetUrl(targetUrl, { allowLocalTest });

  const outboundHeaders = {
    'User-Agent': 'DEVTRACER-API-Inspector/1.0',
    Accept: 'application/json, text/plain, */*'
  };

  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      const cleanKey = String(k || '').trim();
      if (!cleanKey || !/^[A-Za-z0-9-]{2,64}$/.test(cleanKey)) continue;
      if (/^(?:host|content-length|connection)$/i.test(cleanKey)) continue;
      outboundHeaders[cleanKey] = String(v ?? '').slice(0, 1024);
    }
  }

  let authUsed = null;
  if (credentialId && vault) {
    const resolved = await vault.resolveOutboundAuth(credentialId);
    Object.assign(outboundHeaders, resolved.headers);
    authUsed = { id: resolved.meta.id, name: resolved.meta.name, headerName: resolved.meta.headerName };
  }

  let requestBody;
  if (body != null && body !== '' && normMethod !== 'GET' && normMethod !== 'HEAD') {
    requestBody = typeof body === 'string' ? body : JSON.stringify(body);
    if (!Object.keys(outboundHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      outboundHeaders['Content-Type'] = 'application/json';
    }
  }

  const startedAt = Date.now();
  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: normMethod,
      headers: outboundHeaders,
      body: requestBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000)
    });
  } catch (err) {
    throw Object.assign(
      new Error(`Endpoint request failed: ${err?.message || 'network unreachable'}`),
      { status: 502, code: 'NETWORK_RESTRICTED' }
    );
  }

  const latencyMs = Math.max(1, Date.now() - startedAt);
  const respHeaders = {};
  upstream.headers.forEach((v, k) => {
    if (k.toLowerCase() === 'set-cookie') return; // Never echo session cookies
    respHeaders[k.toLowerCase()] = v;
  });

  const text = normMethod === 'HEAD' ? '' : await readBoundedText(upstream, 250_000);
  return {
    ok: upstream.ok,
    status: upstream.status,
    statusText: upstream.statusText || '',
    method: normMethod,
    url: targetUrl,
    latencyMs,
    contentType: respHeaders['content-type'] || '',
    bytes: text.length,
    headers: respHeaders,
    bodyPreview: text.slice(0, 40_000),
    authUsed
  };
}

export function createAppServer({ allowLocalTest = false, vaultDir } = {}) {
  const vault = createCredentialVault({ vaultDir });
  const localAllowed = allowLocalTest || process.env.ALLOW_LOCAL_TEST_TARGETS === '1';

  return http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://localhost');
      const pathname = reqUrl.pathname;

      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          service: 'devtracer',
          transport: 'server',
          vaultReady: true,
          nodeVersion: process.version
        });
      }

      if (pathname === '/api/scan' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const report = await performServerWebsiteScan(body.url, {
          maxBundles: body.maxBundles ?? 6,
          probeMeta: body.probeMeta !== false,
          allowLocalTest: localAllowed
        });
        return sendJson(res, 200, report);
      }

      // Authorized GitHub Repo Scan (optionally uses encrypted Vault PAT server-side!)
      if (pathname === '/api/github-scan' && req.method === 'POST') {
        const body = await readJsonBody(req);
        let token = '';
        if (body.credentialId && CRED_ID_RE.test(String(body.credentialId))) {
          const auth = await vault.resolveOutboundAuth(String(body.credentialId));
          const authVal = Object.values(auth.headers)[0] || '';
          token = authVal.replace(/^Bearer\s+/i, '').trim();
        }
        const report = await scanGitHubRepo(body.repo, { token, maxFiles: body.maxFiles ?? 12 });
        return sendJson(res, 200, report);
      }

      // Live Public DNS Records Inspector
      if (pathname === '/api/dns' && req.method === 'GET') {
        let domain = String(reqUrl.searchParams.get('domain') || '').trim().toLowerCase();
        domain = domain.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].split(':')[0];
        if (!domain || !ROOT_DOMAIN_RE.test(domain)) {
          return sendJson(res, 400, { error: 'Enter a valid domain like example.com.' });
        }
        const dnsData = await inspectPublicDnsRecords(domain);
        return sendJson(res, 200, dnsData);
      }

      // Proxy: Subdomain API (primary: api.subdomain.app, fallback: api.domainee.dev)
      if (pathname === '/api/subdomains' && req.method === 'GET') {
        let domain = String(reqUrl.searchParams.get('domain') || '').trim().toLowerCase();
        domain = domain.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].split(':')[0].replace(/^www\./i, '');
        if (!domain || !ROOT_DOMAIN_RE.test(domain)) {
          return sendJson(res, 400, { error: 'Enter a valid domain like example.com.' });
        }
        try {
          const result = await proxyUpstreamJson(
            `https://api.subdomain.app/v1/query?domain=${encodeURIComponent(domain)}`,
            { method: 'GET', timeoutMs: 35_000 }
          );
          if (result.status < 400 && Array.isArray(result.body?.subdomains)) {
            return sendJson(res, 200, { ...result.body, source: 'subdomain.app' });
          }
        } catch {}

        // Seamless server-side fallback to domainee.dev
        const fallback = await proxyUpstreamJson(
          `https://api.domainee.dev/v1/tools/subdomain-finder?domain=${encodeURIComponent(domain)}`,
          { method: 'GET', timeoutMs: 25_000 }
        );
        if (fallback.status < 400 && Array.isArray(fallback.body?.data?.subdomains)) {
          const rawList = fallback.body.data.subdomains;
          const hosts = rawList.map((item) => (typeof item === 'string' ? item : item?.host)).filter(Boolean);
          const addressMap = {};
          for (const item of rawList) {
            if (item && typeof item === 'object' && item.host && Array.isArray(item.addresses)) {
              addressMap[item.host.toLowerCase()] = item.addresses;
            }
          }
          return sendJson(res, 200, {
            domain,
            count: hosts.length,
            total: fallback.body.data.counts?.total ?? hosts.length,
            subdomains: hosts,
            addresses: addressMap,
            source: 'domainee.dev'
          });
        }
        return sendJson(res, 502, { error: 'Subdomain providers temporarily unreachable from server.' });
      }

      // API Inspector — Authorized Live Endpoint Tester (SSRF-hardened, server-side auth injection)
      if (pathname === '/api/inspect-endpoint' && req.method === 'POST') {
        const body = await readJsonBody(req, 131_072);
        const result = await performAuthorizedEndpointRequest({
          url: body.url,
          method: body.method || 'GET',
          headers: body.headers || {},
          body: body.body ?? null,
          credentialId: body.credentialId || '',
          vault,
          allowLocalTest: localAllowed
        });
        return sendJson(res, 200, result);
      }

      // Encrypted Credential Vault CRUD & Connection Tester (Secrets NEVER returned!)
      if (pathname === '/api/credentials' && req.method === 'GET') {
        return sendJson(res, 200, { encrypted: true, cipher: 'AES-256-GCM', credentials: await vault.list() });
      }

      if (pathname === '/api/credentials' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const created = await vault.create(body);
        return sendJson(res, 201, { credential: created });
      }

      const credMatch = pathname.match(/^\/api\/credentials\/([^/]+)$/);
      if (credMatch) {
        const id = credMatch[1];
        if (!CRED_ID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid credential ID.' });
        if (req.method === 'PUT') {
          const body = await readJsonBody(req);
          const updated = await vault.update(id, body);
          return sendJson(res, 200, { credential: updated });
        }
        if (req.method === 'DELETE') {
          const deleted = await vault.remove(id);
          return sendJson(res, 200, deleted);
        }
      }

      const revokeMatch = pathname.match(/^\/api\/credentials\/([^/]+)\/revoke$/);
      if (revokeMatch && req.method === 'POST') {
        const id = revokeMatch[1];
        if (!CRED_ID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid credential ID.' });
        const revoked = await vault.revoke(id);
        return sendJson(res, 200, { credential: revoked });
      }

      const testMatch = pathname.match(/^\/api\/credentials\/([^/]+)\/test$/);
      if (testMatch && req.method === 'POST') {
        const id = testMatch[1];
        if (!CRED_ID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid credential ID.' });
        const body = await readJsonBody(req);
        const auth = await vault.resolveOutboundAuth(id);
        const testUrl = String(body.testUrl || auth.meta.testUrl || auth.meta.baseUrl || '').trim();
        if (!testUrl) {
          return sendJson(res, 400, { error: 'Provide a Test Endpoint URL on this credential to test connectivity.' });
        }
        const testRes = await performAuthorizedEndpointRequest({
          url: testUrl,
          method: body.method || 'GET',
          credentialId: id,
          vault,
          allowLocalTest: localAllowed
        });
        const summary = {
          ok: testRes.ok,
          status: testRes.status,
          latencyMs: testRes.latencyMs,
          url: testRes.url
        };
        const updated = await vault.recordTestResult(id, summary);
        return sendJson(res, 200, { credential: updated, result: testRes });
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        return await serveStatic(req, res, pathname);
      }

      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
    } catch (err) {
      const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
      sendJson(res, status, {
        error: err?.message || 'Internal server error',
        code: err?.code || 'INTERNAL_ERROR'
      });
    }
  });
}

// Start server only when executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const HOST = process.env.HOST || '0.0.0.0';
  const PORT = Number(process.env.PORT || 3000);
  const server = createAppServer();
  server.listen(PORT, HOST, () => {
    console.log(`[DEVTRACER] Server listening on http://${HOST}:${PORT}`);
  });
}
