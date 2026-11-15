import { analyzeScan } from '../engine/analyzer.js';
import { scanGitHubRepo, parseGitHubInput } from '../engine/github.js';
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
    via: 'custom-worker',
    relayId: 'worker'
  };
}

function buildRelayCandidates(targetUrl) {
  return [
    {
      id: 'corsproxy',
      run: async () => {
        const r = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`, {
          signal: AbortSignal.timeout(10_000)
        });
        if (!r.ok) throw new Error(`corsproxy ${r.status}`);
        const text = await r.text();
        if (!text || text.length < 20) throw new Error('empty corsproxy response');
        return { status: r.status, finalUrl: targetUrl, headers: {}, text, via: 'browser-relay', relayId: 'corsproxy' };
      }
    },
    {
      id: 'allorigins-get',
      run: async () => {
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
          via: 'browser-relay',
          relayId: 'allorigins-get'
        };
      }
    },
    {
      id: 'allorigins-raw',
      run: async () => {
        const r = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`, {
          signal: AbortSignal.timeout(10_000)
        });
        if (!r.ok) throw new Error(`allorigins-raw ${r.status}`);
        const text = await r.text();
        if (!text) throw new Error('empty raw response');
        return { status: r.status, finalUrl: targetUrl, headers: {}, text, via: 'browser-relay', relayId: 'allorigins-raw' };
      }
    },
    {
      id: 'corslol',
      run: async () => {
        const r = await fetch(`https://cors.lol/?url=${encodeURIComponent(targetUrl)}`, {
          signal: AbortSignal.timeout(10_000)
        });
        if (!r.ok) throw new Error(`cors.lol ${r.status}`);
        const text = await r.text();
        if (!text) throw new Error('empty cors.lol response');
        return { status: r.status, finalUrl: targetUrl, headers: {}, text, via: 'browser-relay', relayId: 'corslol' };
      }
    },
    {
      id: 'codetabs',
      run: async () => {
        const r = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`, {
          signal: AbortSignal.timeout(10_000)
        });
        if (!r.ok) throw new Error(`codetabs ${r.status}`);
        const text = await r.text();
        if (!text) throw new Error('empty codetabs response');
        return { status: r.status, finalUrl: targetUrl, headers: {}, text, via: 'browser-relay', relayId: 'codetabs' };
      }
    },
    {
      id: 'direct',
      run: async () => {
        const r = await fetch(targetUrl, { mode: 'cors', signal: AbortSignal.timeout(7_000) });
        if (!r.ok) throw new Error(`direct ${r.status}`);
        const headers = {};
        r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        return { status: r.status, finalUrl: r.url || targetUrl, headers, text: await r.text(), via: 'browser-direct', relayId: 'direct' };
      }
    }
  ];
}

async function fetchViaBrowserRelay(targetUrl, customWorkerUrl = '', preferredRelayId = '') {
  if (customWorkerUrl && /^https?:\/\//i.test(customWorkerUrl.trim())) {
    return await fetchViaCustomWorker(customWorkerUrl, targetUrl);
  }

  let candidates = buildRelayCandidates(targetUrl);
  if (preferredRelayId) {
    const first = candidates.find((c) => c.id === preferredRelayId);
    if (first) candidates = [first, ...candidates.filter((c) => c.id !== preferredRelayId)];
  }

  let lastErr;
  for (const c of candidates) {
    try {
      return await c.run();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All browser relays failed to reach the target URL.');
}

// CORS-native DNS-over-HTTPS enrichment (works directly from GitHub Pages!)
async function fetchDnsEnrichment(hostname) {
  const types = ['A', 'CNAME', 'NS', 'TXT'];
  const results = await Promise.allSettled(
    types.map(async (type) => {
      const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(6_000)
      });
      if (!r.ok) return { type, answers: [] };
      const j = await r.json();
      return { type, answers: Array.isArray(j.Answer) ? j.Answer : [] };
    })
  );

  const lines = [];
  const inferredHeaders = {};
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const ans of r.value.answers) {
      const val = String(ans.data || '').trim();
      lines.push(`${r.value.type}\t${ans.name}\t${val}`);
      const low = val.toLowerCase();
      if (low.includes('cloudflare')) inferredHeaders.server = inferredHeaders.server || 'cloudflare';
      if (low.includes('vercel')) inferredHeaders['x-vercel-id'] = 'dns-cname';
      if (low.includes('netlify')) inferredHeaders['x-nf-request-id'] = 'dns-cname';
      if (low.includes('cloudfront.net')) inferredHeaders['x-amz-cf-id'] = 'dns-cname';
      if (low.includes('fastly')) inferredHeaders['x-served-by'] = 'cache-fastly';
      if (low.includes('github.io') || low.includes('github.com')) inferredHeaders.server = inferredHeaders.server || 'GitHub.com';
      if (low.includes('shopify')) inferredHeaders['x-shopid'] = 'dns-cname';
      if (low.includes('akamai')) inferredHeaders['x-akamai-transformed'] = 'dns-cname';
    }
  }

  return {
    lines,
    headers: inferredHeaders,
    artifact: lines.length > 0
      ? { name: 'dns-records.txt', type: 'config', content: lines.join('\n'), bytes: lines.join('\n').length }
      : null
  };
}

async function runWithConcurrency(items, limit, workerFn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await workerFn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
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

  // Auto-detect GitHub repository URLs pasted into Website mode
  if (/^(?:https?:\/\/)?github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+(?:\/.*)?$/i.test(url)) {
    const parsed = parseGitHubInput(url);
    if (parsed && parsed.owner && parsed.repo) {
      onProgress({ step: 'fetch', label: `Detected GitHub repo ${parsed.owner}/${parsed.repo} — inspecting source directly…` });
      return await scanGitHubRepo(`${parsed.owner}/${parsed.repo}`, { onProgress });
    }
  }

  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
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
      if (data?.code === 'SSRF_BLOCKED' || data?.code === 'INVALID_URL' || data?.code === 'INVALID_SCHEME') {
        throw new Error(data.error || 'Target rejected.');
      }
      if (transport === 'server') {
        throw new Error(data?.error || `Server crawl failed (${res.status}).`);
      }
      onProgress({ step: 'fallback', label: 'Server egress restricted for this host — switching to browser relay…' });
    } catch (err) {
      if (transport === 'server' || /SSRF|Invalid|Private|loopback/i.test(err.message)) {
        throw err;
      }
      onProgress({ step: 'fallback', label: 'Switching to browser-side relay transport…' });
    }
  }

  // 2. Browser-side relay + CORS-native DNS-over-HTTPS enrichment (works on GitHub Pages!)
  onProgress({ step: 'fetch', label: `Fetching ${url} HTML + live DNS via browser relays…` });
  const [mainSettled, dnsSettled] = await Promise.allSettled([
    fetchViaBrowserRelay(url, customWorkerUrl),
    fetchDnsEnrichment(parsedUrl.hostname)
  ]);

  const dns = dnsSettled.status === 'fulfilled' ? dnsSettled.value : { lines: [], headers: {}, artifact: null };

  if (mainSettled.status !== 'fulfilled') {
    if (dns.artifact) {
      // Site blocked public relays, but we still got live DNS & hosting telemetry!
      return analyzeScan({
        target: url,
        targetUrl: url,
        mode: 'website',
        transport: 'browser-dns',
        headers: dns.headers,
        artifacts: [dns.artifact],
        meta: {
          note: `Target blocked public HTML relays (${mainSettled.reason?.message || 'firewall'}). Returned live DNS-over-HTTPS infrastructure records; connect a Cloudflare Worker or run local Node server for full HTML & bundle crawl.`
        }
      });
    }
    throw mainSettled.reason || new Error('Could not reach target URL from browser relays.');
  }

  const main = mainSettled.value;
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
  if (dns.artifact) artifacts.push(dns.artifact);

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
    onProgress({ step: 'bundles', label: `Inspecting ${queue.length} linked bundles & manifests (throttled)…` });
    const settled = await runWithConcurrency(queue, 2, async (item) => {
      try {
        const r = await fetchViaBrowserRelay(item.url, customWorkerUrl, main.relayId);
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
    });
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
    headers: { ...dns.headers, ...(main.headers || {}) },
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
    if (/\.har$/i.test(f.name)) {
      try {
        const har = JSON.parse(f.content);
        if (Array.isArray(har?.log?.entries)) {
          return scanHarObject(har, f.name);
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
