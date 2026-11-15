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
    const res = await fetch('./api/health', { cache: 'no-store', signal: AbortSignal.timeout(1800) });
    if (!res.ok) return { available: false };
    const data = await res.json();
    return { available: Boolean(data?.ok), info: data };
  } catch {
    return { available: false };
  }
}

function isBlockedRelayStub(text, expectHtml = false) {
  if (!text || text.length < 16) return true;
  if (expectHtml) {
    const head = text.slice(0, 600).toLowerCase();
    if (head.includes('<title>just a moment...</title>') && text.length < 18_000) return true;
    if (head.includes('attention required! | cloudflare') && text.length < 18_000) return true;
    if (/^\s*\{\s*"error"\s*:/.test(head) && text.length < 600) return true;
  }
  return false;
}

async function fetchViaCustomWorker(workerBaseUrl, targetUrl, timeoutMs = 9_000) {
  const base = workerBaseUrl.trim().replace(/\/+$/, '');
  const endpoint = `${base}?url=${encodeURIComponent(targetUrl)}`;
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
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

function buildRelayDefs(targetUrl, { expectHtml = false, timeoutMs = 6_500 } = {}) {
  const enc = encodeURIComponent(targetUrl);

  const checkText = (text) => {
    if (isBlockedRelayStub(text, expectHtml)) throw new Error('blocked or empty stub');
    return text;
  };

  return [
    {
      id: 'allorigins-raw',
      run: async (signal) => {
        const r = await fetch(`https://api.allorigins.win/raw?url=${enc}`, { signal });
        if (!r.ok) throw new Error(`allorigins-raw ${r.status}`);
        const text = checkText(await r.text());
        return { status: r.status, finalUrl: targetUrl, headers: {}, text, via: 'browser-relay', relayId: 'allorigins-raw' };
      }
    },
    {
      id: 'allorigins-get',
      run: async (signal) => {
        const r = await fetch(`https://api.allorigins.win/get?url=${enc}`, { signal });
        if (!r.ok) throw new Error(`allorigins-get ${r.status}`);
        const json = await r.json();
        const text = checkText(typeof json?.contents === 'string' ? json.contents : '');
        return {
          status: json.status?.http_code || 200,
          finalUrl: json.status?.url || targetUrl,
          headers: json.status?.content_type ? { 'content-type': json.status.content_type } : {},
          text,
          via: 'browser-relay',
          relayId: 'allorigins-get'
        };
      }
    },
    {
      id: 'corsproxy',
      run: async (signal) => {
        const r = await fetch(`https://corsproxy.io/?url=${enc}`, { signal });
        if (!r.ok) throw new Error(`corsproxy ${r.status}`);
        const text = checkText(await r.text());
        return { status: r.status, finalUrl: targetUrl, headers: {}, text, via: 'browser-relay', relayId: 'corsproxy' };
      }
    },
    {
      id: 'codetabs',
      run: async (signal) => {
        const r = await fetch(`https://api.codetabs.com/v1/proxy?quest=${enc}`, { signal });
        if (!r.ok) throw new Error(`codetabs ${r.status}`);
        const text = checkText(await r.text());
        return { status: r.status, finalUrl: targetUrl, headers: {}, text, via: 'browser-relay', relayId: 'codetabs' };
      }
    },
    {
      id: 'corslol',
      run: async (signal) => {
        const r = await fetch(`https://cors.lol/?url=${enc}`, { signal });
        if (!r.ok) throw new Error(`cors.lol ${r.status}`);
        const text = checkText(await r.text());
        return { status: r.status, finalUrl: targetUrl, headers: {}, text, via: 'browser-relay', relayId: 'corslol' };
      }
    },
    {
      id: 'direct',
      run: async (signal) => {
        const r = await fetch(targetUrl, { mode: 'cors', signal });
        if (!r.ok) throw new Error(`direct ${r.status}`);
        const headers = {};
        r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        const text = checkText(await r.text());
        return { status: r.status, finalUrl: r.url || targetUrl, headers, text, via: 'browser-direct', relayId: 'direct' };
      }
    }
  ].map((def) => ({ ...def, timeoutMs }));
}

// Races all relays simultaneously — first valid payload wins immediately, cancels the rest!
async function raceBrowserRelays(targetUrl, { customWorkerUrl = '', expectHtml = false, timeoutMs = 6_500 } = {}) {
  if (customWorkerUrl && /^https?:\/\//i.test(customWorkerUrl.trim())) {
    return await fetchViaCustomWorker(customWorkerUrl, targetUrl, timeoutMs + 2_000);
  }

  const defs = buildRelayDefs(targetUrl, { expectHtml, timeoutMs });
  const controllers = defs.map(() => new AbortController());

  const tasks = defs.map((def, i) => {
    const timer = setTimeout(() => controllers[i].abort(), timeoutMs);
    return def
      .run(controllers[i].signal)
      .finally(() => clearTimeout(timer));
  });

  try {
    const winner = await Promise.any(tasks);
    controllers.forEach((c) => c.abort());
    return winner;
  } catch {
    controllers.forEach((c) => c.abort());
    throw new Error('All fast browser relays timed out or were blocked by target firewall.');
  }
}

// Fast single/pair fetch for linked JS bundles using the already-proven winning relay
async function fetchAssetFast(targetUrl, { customWorkerUrl = '', preferredRelayId = '', timeoutMs = 4_200 } = {}) {
  if (customWorkerUrl && /^https?:\/\//i.test(customWorkerUrl.trim())) {
    return await fetchViaCustomWorker(customWorkerUrl, targetUrl, timeoutMs);
  }

  const defs = buildRelayDefs(targetUrl, { expectHtml: false, timeoutMs });
  // Race winning relay + 1 distinct backup relay only (fast, low rate-limit pressure)
  const chosen = [];
  const primary = defs.find((d) => d.id === preferredRelayId);
  if (primary) chosen.push(primary);
  const backup = defs.find((d) => d.id !== preferredRelayId && d.id !== 'direct');
  if (backup) chosen.push(backup);

  const controllers = chosen.map(() => new AbortController());
  const tasks = chosen.map((def, i) => {
    const timer = setTimeout(() => controllers[i].abort(), timeoutMs);
    return def.run(controllers[i].signal).finally(() => clearTimeout(timer));
  });

  try {
    const winner = await Promise.any(tasks);
    controllers.forEach((c) => c.abort());
    return winner;
  } catch {
    controllers.forEach((c) => c.abort());
    return null;
  }
}

// CORS-native DNS-over-HTTPS enrichment (super fast, ~150ms, works everywhere!)
async function fetchDnsEnrichment(hostname) {
  const types = ['A', 'CNAME', 'NS', 'TXT'];
  const results = await Promise.allSettled(
    types.map(async (type) => {
      const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(3_500)
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
    maxBundles = 6,
    probeMeta = true,
    customWorkerUrl = '',
    onProgress = () => {},
    onPartialReport = null
  } = options;

  let url = String(rawUrl || '').trim();
  if (!url) throw new Error('Enter a website URL to inspect.');

  // Auto-detect GitHub repo shorthand ("vitejs/vite") or full GitHub repo URL
  const isGithubShorthand = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(url) && !url.includes('.');
  const isGithubRepoUrl = /^(?:https?:\/\/)?github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+(?:\/.*)?$/i.test(url);
  if (isGithubShorthand || isGithubRepoUrl) {
    const parsed = parseGitHubInput(url);
    if (parsed && parsed.owner && parsed.repo) {
      onProgress({ step: 'fetch', label: `Inspecting GitHub repo ${parsed.owner}/${parsed.repo}…` });
      return await scanGitHubRepo(`${parsed.owner}/${parsed.repo}`, { onProgress });
    }
  }

  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Enter a valid URL like https://vercel.com or stripe.com.');
  }

  const startedAt = Date.now();

  // 1. Node server deep crawler when running locally (fastest + full HTTP headers!)
  if ((transport === 'auto' || transport === 'server') && serverAvailable) {
    onProgress({ step: 'fetch', label: `Fast-crawling ${url} via DEVTRACER server engine…` });
    try {
      const res = await fetch('./api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, maxBundles, probeMeta }),
        signal: AbortSignal.timeout(20_000)
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
      onProgress({ step: 'fallback', label: 'Switching to parallel browser relay race…' });
    } catch (err) {
      if (transport === 'server' || /SSRF|Invalid|Private|loopback/i.test(err.message)) {
        throw err;
      }
      onProgress({ step: 'fallback', label: 'Racing fast browser relays…' });
    }
  }

  // 2. Parallel Browser Relay Race + Instant CORS-Native DNS-over-HTTPS!
  onProgress({ step: 'fetch', label: `Racing fast relays + DNS for ${parsedUrl.hostname}…` });
  const [mainSettled, dnsSettled] = await Promise.allSettled([
    raceBrowserRelays(url, { customWorkerUrl, expectHtml: true, timeoutMs: 7_000 }),
    fetchDnsEnrichment(parsedUrl.hostname)
  ]);

  const dns = dnsSettled.status === 'fulfilled' ? dnsSettled.value : { lines: [], headers: {}, artifact: null };

  if (mainSettled.status !== 'fulfilled') {
    if (dns.artifact) {
      return analyzeScan({
        target: url,
        targetUrl: url,
        mode: 'website',
        transport: 'browser-dns',
        headers: dns.headers,
        artifacts: [dns.artifact],
        meta: {
          note: `Target blocked public HTML relays (${mainSettled.reason?.message || 'WAF'}). Returned live DNS-over-HTTPS hosting & infrastructure telemetry; paste View-Source/.HAR or add a Worker for full HTML & bundle crawl.`
        }
      });
    }
    throw mainSettled.reason || new Error('Could not reach target URL from browser relays.');
  }

  const main = mainSettled.value;
  const finalUrl = main.finalUrl || url;
  const origin = new URL(finalUrl).origin;

  const baseArtifacts = [
    {
      name: new URL(finalUrl).pathname === '/' ? 'index.html' : new URL(finalUrl).pathname.replace(/^\/+/, ''),
      url: finalUrl,
      type: 'html',
      content: main.text,
      bytes: main.text.length
    }
  ];
  if (dns.artifact) baseArtifacts.push(dns.artifact);

  const { scripts, styles } = discoverClientAssets(main.text, finalUrl);
  const bundleCap = Math.min(customWorkerUrl ? maxBundles : Math.min(4, maxBundles), 10);
  const queue = [
    ...scripts.slice(0, bundleCap).map((s) => ({ ...s, type: 'js' })),
    ...styles.slice(0, 1).map((s) => ({ ...s, type: 'css' }))
  ];
  if (probeMeta) {
    queue.push({ url: `${origin}/robots.txt`, name: 'robots.txt', type: 'config' });
  }

  // Emit instant progressive report RIGHT NOW (~1-2s!) before JS bundles finish
  if (typeof onPartialReport === 'function' && queue.length > 0) {
    const initialReport = analyzeScan({
      target: url,
      targetUrl: finalUrl,
      mode: 'website',
      transport: main.via,
      headers: { ...dns.headers, ...(main.headers || {}) },
      artifacts: baseArtifacts,
      meta: {
        status: main.status,
        finalUrl,
        discoveredScripts: scripts.length,
        crawledScripts: 0
      }
    });
    const htmlMs = Date.now() - startedAt;
    onPartialReport(initialReport, `HTML ready in ${(htmlMs / 1000).toFixed(1)}s — enriching ${queue.length} bundles in background…`);
  }

  // Fetch linked bundles concurrently under a hard 5.5s total time budget so it NEVER hangs!
  const artifacts = [...baseArtifacts];
  if (queue.length > 0) {
    const collected = [];
    const bundleAll = Promise.all(
      queue.map(async (item) => {
        try {
          const r = await fetchAssetFast(item.url, {
            customWorkerUrl,
            preferredRelayId: main.relayId,
            timeoutMs: 4_500
          });
          if (!r || !r.text || (item.type !== 'html' && /^\s*<!doctype html/i.test(r.text))) return;
          collected.push({
            name: item.name,
            url: item.url,
            type: item.type,
            content: r.text.slice(0, 600_000),
            bytes: r.text.length
          });
        } catch {}
      })
    );

    let budgetTimer;
    try {
      await Promise.race([
        bundleAll,
        new Promise((resolve) => { budgetTimer = setTimeout(resolve, 5_500); })
      ]);
    } finally {
      clearTimeout(budgetTimer);
    }

    artifacts.push(...collected);
  }

  onProgress({ step: 'analyze', label: 'Finalizing domains & build stack report…' });

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
