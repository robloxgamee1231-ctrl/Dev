import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { analyzeScan } from './src/engine/analyzer.js';
import { getApexDomain, normalizeHost } from './src/engine/tlds.js';

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

async function safeFetch(url, { allowLocalTest = false, maxBytes = MAX_FILE_BYTES } = {}) {
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeTargetUrl(currentUrl, { allowLocalTest });
    let res;
    try {
      res = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DevTrace/1.0; +https://github.com/robloxgamee1231-ctrl/Dev)',
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

  // Fetch linked assets concurrently in batches of 4
  const batchSize = 4;
  for (let i = 0; i < fetchQueue.length; i += batchSize) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    const batch = fetchQueue.slice(i, i + batchSize);
    const settled = await Promise.all(
      batch.map(async (item) => {
        try {
          const r = await safeFetch(item.url, { allowLocalTest, maxBytes: item.maxBytes });
          if (!r.ok || !r.text) return null;
          // Skip HTML error pages returned for missing robots.txt / sitemap.xml / .js
          if (item.type !== 'html' && /^\s*<!doctype html/i.test(r.text)) return null;
          return {
            name: item.name,
            url: r.finalUrl,
            type: item.type,
            content: r.text,
            bytes: r.text.length
          };
        } catch {
          return null;
        }
      })
    );
    for (const art of settled) {
      if (art && totalBytes + art.bytes <= MAX_TOTAL_BYTES) {
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

export function createAppServer({ allowLocalTest = false } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://localhost');
      const pathname = reqUrl.pathname;

      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          service: 'devtrace',
          transport: 'server',
          nodeVersion: process.version
        });
      }

      if (pathname === '/api/scan' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const report = await performServerWebsiteScan(body.url, {
          maxBundles: body.maxBundles ?? 8,
          probeMeta: body.probeMeta !== false,
          allowLocalTest: allowLocalTest || process.env.ALLOW_LOCAL_TEST_TARGETS === '1'
        });
        return sendJson(res, 200, report);
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
    console.log(`[DevTrace] Server listening on http://${HOST}:${PORT}`);
  });
}
