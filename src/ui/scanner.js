import { analyzeScan } from '../engine/analyzer.js';
import { scanGitHubRepo } from '../engine/github.js';
import { getApexDomain, normalizeHost } from '../engine/tlds.js';

const SKIP_BUNDLE_HOSTS = [
  'googletagmanager.com',
  'google-analytics.com',
  'doubleclick.net',
  'googlesyndication.com',
  'connect.facebook.net',
  'static.hotjar.com',
  'clarity.ms'
];

export async function checkServerAvailability() {
  try {
    const res = await fetch('./api/health', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { available: false };
    const data = await res.json();
    return { available: Boolean(data?.ok), info: data };
  } catch {
    return { available: false };
  }
}

async function fetchViaCustomWorker(workerBaseUrl, targetUrl) {
  const base = workerBaseUrl.trim().replace(/\/+$/, '');
  const endpoint = `${base}?url=${encodeURIComponent(targetUrl)}`;
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Worker returned HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return {
    status: data.status || 200,
    finalUrl: data.finalUrl || targetUrl,
    headers: data.headers || {},
    text: String(data.body || ''),
    via: 'custom-worker'
  };
}

async function fetchViaBrowserRelay(targetUrl, customWorkerUrl = '') {
  if (customWorkerUrl && /^https?:\/\//i.test(customWorkerUrl.trim())) {
    return await fetchViaCustomWorker(customWorkerUrl, targetUrl);
  }

  // Relay 1: allorigins JSON wrapper
  const attempts = [
    async () => {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`, {
        signal: AbortSignal.timeout(11_000)
      });
      if (!r.ok) throw new Error(`allorigins ${r.status}`);
      const json = await r.json();
      if (typeof json.contents !== 'string' || !json.contents.length) throw new Error('empty contents');
      return {
        status: json.status?.http_code || 200,
        finalUrl: json.status?.url || targetUrl,
        headers: json.status?.content_type ? { 'content-type': json.status.content_type } : {},
        text: json.contents,
        via: 'browser-relay'
      };
    },
    // Relay 2: codetabs proxy
    async () => {
      const r = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`, {
        signal: AbortSignal.timeout(11_000)
      });
      if (!r.ok) throw new Error(`codetabs ${r.status}`);
      const text = await r.text();
      if (!text) throw new Error('empty response');
      return {
        status: r.status,
        finalUrl: targetUrl,
        headers: {},
        text,
        via: 'browser-relay'
      };
    },
    // Fallback 3: direct browser fetch (succeeds for CORS-permissive endpoints)
    async () => {
      const r = await fetch(targetUrl, { mode: 'cors', signal: AbortSignal.timeout(8_000) });
      if (!r.ok) throw new Error(`direct ${r.status}`);
      const headers = {};
      r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      return {
        status: r.status,
        finalUrl: r.url || targetUrl,
        headers,
        text: await r.text(),
        via: 'browser-direct'
      };
    }
  ];

  let lastErr;
  for (const fn of attempts) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All browser relays failed to reach the target URL.');
}

function discoverClientAssets(html, baseUrl) {
  const base = new URL(baseUrl);
  const baseApex = getApexDomain(base.hostname);
  const scripts = [];
  const styles = [];
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
    if (isSameOrigin || isSameApex) {
      scripts.push({ url: u.href, name: u.pathname.replace(/^\/+/, '') || u.hostname, priority: isSameOrigin ? 2 : 1 });
    }
  }

  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/rel\s*=\s*["'][^"']*stylesheet/i.test(tag)) continue;
    const hrefMatch = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const u = resolve(hrefMatch[1]);
    if (!u || seen.has(u.href)) continue;
    if (u.origin === base.origin || getApexDomain(normalizeHost(u.hostname)) === baseApex) {
      seen.add(u.href);
      styles.push({ url: u.href, name: u.pathname.replace(/^\/+/, '') || 'style.css' });
    }
  }

  scripts.sort((a, b) => b.priority - a.priority);
  return { scripts, styles };
}

export async function scanWebsiteUrl(rawUrl, options = {}) {
  const {
    transport = 'auto', // 'auto' | 'server' | 'relay'
    serverAvailable = false,
    maxBundles = 8,
    probeMeta = true,
    customWorkerUrl = '',
    onProgress = () => {}
  } = options;

  let url = String(rawUrl || '').trim();
  if (!url) throw new Error('Enter a website URL to inspect.');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try {
    new URL(url);
  } catch {
    throw new Error('Enter a valid URL like https://vercel.com or github.com.');
  }

  // 1. Try Node server deep crawler first when available
  if ((transport === 'auto' || transport === 'server') && serverAvailable) {
    onProgress({ step: 'fetch', label: `Crawling ${url} via DevTrace server engine (HTML + headers + JS bundles)…` });
    try {
      const res = await fetch('./api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, maxBundles, probeMeta }),
        signal: AbortSignal.timeout(45_000)
      });
      const data = await res.json();
      if (res.ok) {
        onProgress({ step: 'done', label: 'Analysis complete.' });
        return data;
      }
      // If SSRF blocked or bad URL, do NOT fall back — surface immediately
      if (data?.code === 'SSRF_BLOCKED' || data?.code === 'INVALID_URL' || data?.code === 'INVALID_SCHEME') {
        throw new Error(data.error || 'Target rejected.');
      }
      if (transport === 'server') {
        throw new Error(data?.error || `Server crawl failed (${res.status}).`);
      }
      // Otherwise fall through to browser relay when server egress is restricted
      onProgress({ step: 'fallback', label: 'Server egress restricted for this host — switching to browser relay…' });
    } catch (err) {
      if (transport === 'server' || /SSRF|Invalid|Private|loopback/i.test(err.message)) {
        throw err;
      }
      onProgress({ step: 'fallback', label: 'Switching to browser-side relay transport…' });
    }
  }

  // 2. Browser-side relay pipeline (works on GitHub Pages AND when sandbox server egress is restricted)
  onProgress({ step: 'fetch', label: `Fetching ${url} HTML via browser relay…` });
  const main = await fetchViaBrowserRelay(url, customWorkerUrl);
  const finalUrl = main.finalUrl || url;
  const origin = new URL(finalUrl).origin;

  const artifacts = [
    {
      name: new URL(finalUrl).pathname === '/' ? 'index.html' : new URL(finalUrl).pathname.replace(/^\/+/, ''),
      url: finalUrl,
      type: 'html',
      content: main.text,
      bytes: main.text.length
    }
  ];

  const { scripts, styles } = discoverClientAssets(main.text, finalUrl);
  const bundleCap = Math.min(customWorkerUrl ? maxBundles : Math.min(5, maxBundles), 12);
  const queue = [
    ...scripts.slice(0, bundleCap).map((s) => ({ ...s, type: 'js' })),
    ...styles.slice(0, 2).map((s) => ({ ...s, type: 'css' }))
  ];
  if (probeMeta) {
    queue.push({ url: `${origin}/robots.txt`, name: 'robots.txt', type: 'config' });
  }

  if (queue.length > 0) {
    onProgress({ step: 'bundles', label: `Inspecting ${queue.length} linked bundles & manifests…` });
    const settled = await Promise.all(
      queue.map(async (item) => {
        try {
          const r = await fetchViaBrowserRelay(item.url, customWorkerUrl);
          if (!r.text || (item.type !== 'html' && /^\s*<!doctype html/i.test(r.text))) return null;
          return {
            name: item.name,
            url: item.url,
            type: item.type,
            content: r.text.slice(0, 800_000),
            bytes: r.text.length
          };
        } catch {
          return null;
        }
      })
    );
    for (const a of settled) {
      if (a) artifacts.push(a);
    }
  }

  onProgress({ step: 'analyze', label: 'Extracting dev/staging domains & fingerprinting build stack…' });

  return analyzeScan({
    target: url,
    targetUrl: finalUrl,
    mode: 'website',
    transport: main.via,
    headers: main.headers || {},
    artifacts,
    meta: {
      status: main.status,
      finalUrl,
      discoveredScripts: scripts.length,
      crawledScripts: artifacts.filter((a) => a.type === 'js').length
    }
  });
}

export async function scanGitHub(repoInput, options = {}) {
  return await scanGitHubRepo(repoInput, options);
}

export function scanRawArtifacts({ label = 'Pasted Source', text = '', files = [], targetUrl = '' } = {}) {
  const artifacts = [];
  const mergedHeaders = {};
  const repoFiles = [];

  if (text && text.trim()) {
    const trimmed = text.trim();
    // Auto-detect HAR JSON archive paste
    if (trimmed.startsWith('{') && trimmed.includes('"log"') && trimmed.includes('"entries"')) {
      try {
        const har = JSON.parse(trimmed);
        if (Array.isArray(har?.log?.entries)) {
          return scanHarObject(har, label);
        }
      } catch {}
    }

    const guessedType = /^<!doctype html|<html\b|<head\b|<script\b/i.test(trimmed)
      ? 'html'
      : trimmed.startsWith('{') && trimmed.includes('"dependencies"')
        ? 'json'
        : 'js';

    artifacts.push({
      name: guessedType === 'html' ? 'pasted.html' : guessedType === 'json' ? 'package.json' : 'pasted-source.js',
      type: guessedType,
      content: text,
      bytes: text.length
    });
  }

  for (const f of files) {
    if (!f || typeof f.content !== 'string') continue;
    repoFiles.push(f.name);
    // Support dropped .har files
    if (/\.har$/i.test(f.name)) {
      try {
        const har = JSON.parse(f.content);
        if (Array.isArray(har?.log?.entries)) {
          const harReport = scanHarObject(har, f.name);
          return harReport;
        }
      } catch {}
    }
    const lower = f.name.toLowerCase();
    const type = /\.html?$/.test(lower)
      ? 'html'
      : /\.[cm]?[jt]sx?$/.test(lower)
        ? 'js'
        : /\.(?:css|scss|sass|less)$/.test(lower)
          ? 'css'
          : /\.jsonc?$/.test(lower)
            ? 'json'
            : 'config';
    artifacts.push({
      name: f.name,
      type,
      content: f.content,
      bytes: f.content.length
    });
  }

  if (artifacts.length === 0) {
    throw new Error('Paste source code or drop at least one file to inspect.');
  }

  return analyzeScan({
    target: label || (files.length === 1 ? files[0].name : `${artifacts.length} Local Source Files`),
    targetUrl,
    mode: 'source',
    transport: 'local',
    headers: mergedHeaders,
    artifacts,
    repoFiles
  });
}

function scanHarObject(har, label) {
  const entries = har.log.entries || [];
  const artifacts = [];
  const headers = {};
  let firstDocUrl = '';

  for (const entry of entries.slice(0, 60)) {
    const reqUrl = entry?.request?.url || '';
    const text = entry?.response?.content?.text || '';
    const mime = entry?.response?.content?.mimeType || '';
    if (!firstDocUrl && /html/i.test(mime) && reqUrl) {
      firstDocUrl = reqUrl;
      for (const h of entry?.response?.headers || []) {
        if (h?.name) headers[h.name.toLowerCase()] = h.value || '';
      }
    }
    if (!text || text.length > 1_200_000) continue;
    const type = /html/i.test(mime)
      ? 'html'
      : /javascript|ecmascript/i.test(mime)
        ? 'js'
        : /css/i.test(mime)
          ? 'css'
          : /json/i.test(mime)
            ? 'json'
            : 'code';
    let shortName = reqUrl;
    try {
      const u = new URL(reqUrl);
      shortName = u.hostname + u.pathname;
    } catch {}
    artifacts.push({
      name: shortName || 'har-entry',
      url: reqUrl,
      type,
      content: text,
      bytes: text.length
    });
  }

  return analyzeScan({
    target: firstDocUrl || label || 'HAR Capture',
    targetUrl: firstDocUrl,
    mode: 'source',
    transport: 'local',
    headers,
    artifacts,
    meta: { note: `Parsed ${artifacts.length} responses from HAR archive` }
  });
}
