// Source Code Intelligence Analyzer (DEVTRACER — made by ★NDX★)
// Extracts publicly referenced API endpoints, framework configurations,
// and exposed configuration references while STRICTLY NEVER collecting
// or revealing secret values from inspected websites.

const SENSITIVE_KEY_RE = /(?:secret|token|password|passwd|pwd|private|credential|cred|auth_key|api_?key|access_?key|signing|bearer|jwt|session_?key|webhook_?secret|client_?secret|master_?key|encryption|dsn)/i;
const SENSITIVE_VALUE_RE = /^(?:sk[-_]|rk[-_]|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.|Bearer\s+|Basic\s+)/i;

const CONFIG_FILE_SIGNATURES = [
  { re: /(?:^|\/)next\.config\.[cm]?[jt]s$/i, framework: 'Next.js', kind: 'Framework Config' },
  { re: /(?:^|\/)vite\.config\.[cm]?[jt]s$/i, framework: 'Vite', kind: 'Bundler Config' },
  { re: /(?:^|\/)astro\.config\.[cm]?[jt]s$/i, framework: 'Astro', kind: 'Framework Config' },
  { re: /(?:^|\/)nuxt\.config\.[cm]?[jt]s$/i, framework: 'Nuxt', kind: 'Framework Config' },
  { re: /(?:^|\/)svelte\.config\.[cm]?[jt]s$/i, framework: 'SvelteKit', kind: 'Framework Config' },
  { re: /(?:^|\/)webpack\.config\.[cm]?[jt]s$/i, framework: 'Webpack', kind: 'Bundler Config' },
  { re: /(?:^|\/)tailwind\.config\.[cm]?[jt]s$/i, framework: 'Tailwind CSS', kind: 'Styling Config' },
  { re: /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/i, framework: 'TypeScript', kind: 'Compiler Config' },
  { re: /(?:^|\/)vercel\.json$/i, framework: 'Vercel', kind: 'Deployment Config' },
  { re: /(?:^|\/)netlify\.toml$/i, framework: 'Netlify', kind: 'Deployment Config' },
  { re: /(?:^|\/)wrangler\.(?:toml|jsonc?)$/i, framework: 'Cloudflare Workers', kind: 'Edge Config' },
  { re: /(?:^|\/)Dockerfile(?:\.[^/]+)?$/i, framework: 'Docker', kind: 'Container Config' },
  { re: /(?:^|\/)docker-compose\.ya?ml$/i, framework: 'Docker Compose', kind: 'Container Config' },
  { re: /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i, framework: 'GitHub Actions', kind: 'CI/CD Pipeline' },
  { re: /(?:^|\/)package\.json$/i, framework: 'Node / npm', kind: 'Package Manifest' },
  { re: /(?:^|\/)(?:openapi|swagger)\.(?:json|ya?ml)$/i, framework: 'OpenAPI / Swagger', kind: 'API Spec' }
];

const RUNTIME_CONFIG_MARKERS = [
  { re: /<script[^>]+id=["']__NEXT_DATA__["']/i, framework: 'Next.js', kind: 'Hydration Payload', detail: '__NEXT_DATA__ SSR runtime config' },
  { re: /window\.__NUXT__\s*=|id=["']__NUXT_DATA__["']/i, framework: 'Nuxt', kind: 'Hydration Payload', detail: '__NUXT__ state payload' },
  { re: /window\.__REMIX_CONTEXT__|__remixContext/i, framework: 'Remix', kind: 'Hydration Payload', detail: 'Remix router context' },
  { re: /<astro-island\b/i, framework: 'Astro', kind: 'Island Hydration', detail: 'Astro client island directive' },
  { re: /window\.__APOLLO_STATE__/i, framework: 'Apollo GraphQL', kind: 'State Cache', detail: 'Apollo hydrated GraphQL cache' },
  { re: /window\.__INITIAL_STATE__/i, framework: 'SSR Framework', kind: 'State Payload', detail: 'window.__INITIAL_STATE__ hydration' },
  { re: /navigator\.serviceWorker\.register\s*\(\s*["']([^"']+)["']/i, framework: 'Service Worker / PWA', kind: 'Runtime Worker', detail: 'Service worker registration' },
  { re: /<link[^>]+rel=["']manifest["'][^>]*href=["']([^"']+)["']/i, framework: 'Web App Manifest', kind: 'PWA Config', detail: 'Manifest reference' },
  { re: /import\.meta\.env(?:\.[A-Z0-9_]+)?/g, framework: 'Vite / ESM', kind: 'Env Reference', detail: 'import.meta.env reference' }
];

function buildLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToLine(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(1, hi + 1);
}

function safeSnippet(content, index, len) {
  const start = Math.max(0, index - 28);
  const end = Math.min(content.length, index + len + 44);
  let raw = content.slice(start, end).replace(/\s+/g, ' ').trim();
  // Scrub any bearer/key-looking literals from snippets defensively
  raw = raw.replace(/(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
  raw = raw.replace(/\b(?:sk|rk)[-_][A-Za-z0-9_-]{12,}/g, '[REDACTED]');
  raw = raw.replace(/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{12,}/g, '[REDACTED]');
  raw = raw.replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
  raw = raw.replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]*)?/g, '[REDACTED_JWT]');
  return raw.slice(0, 160);
}

function looksLikeHighEntropySecret(val) {
  const v = String(val || '').trim();
  if (!v) return false;
  if (SENSITIVE_VALUE_RE.test(v)) return true;
  if (v.length >= 24 && !/\s/.test(v) && !/^https?:\/\//i.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v)) {
    return true;
  }
  return false;
}

function sanitizePublicConfigValue(keyName, rawVal) {
  const val = String(rawVal || '').trim();
  if (SENSITIVE_KEY_RE.test(keyName) || looksLikeHighEntropySecret(val)) {
    return {
      valuePreview: '[REDACTED — secret values are never collected or displayed]',
      redacted: true
    };
  }
  // Safe public value (URL, boolean, short non-secret mode string)
  if (/^(?:https?:\/\/|wss?:\/\/|\/|true|false|\d+|development|staging|production|preview|beta|test|sandbox)$/i.test(val) || val.length <= 42) {
    return { valuePreview: val.slice(0, 96), redacted: false };
  }
  return {
    valuePreview: '[REDACTED — long config value omitted]',
    redacted: true
  };
}

function classifyEndpointKind(urlStr) {
  const low = urlStr.toLowerCase();
  if (/^wss?:\/\//i.test(low)) return 'WebSocket';
  if (/(?:openapi|swagger)\.(?:json|ya?ml)|\/api-docs\b|\/docs\/openapi/i.test(low)) return 'OpenAPI';
  if (/\/graphql\b|\/gql\b/i.test(low)) return 'GraphQL';
  if (/\/\.well-known\//i.test(low)) return 'Well-Known';
  return 'REST';
}

function resolveEndpointUrl(rawPath, baseOrigin) {
  const cleaned = String(rawPath || '').trim().replace(/[),;'"]+$/, '');
  if (!cleaned || cleaned.length > 260) return null;
  if (/^(?:https?|wss?):\/\//i.test(cleaned)) {
    try {
      const u = new URL(cleaned);
      return { url: u.href, path: u.pathname + u.search };
    } catch {
      return null;
    }
  }
  if (cleaned.startsWith('/') && !cleaned.startsWith('//') && /^\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/i.test(cleaned)) {
    if (baseOrigin) {
      try {
        const u = new URL(cleaned, baseOrigin);
        return { url: u.href, path: u.pathname + u.search };
      } catch {}
    }
    return { url: cleaned, path: cleaned };
  }
  return null;
}

export function analyzeSourceIntelligence(artifacts = [], { targetUrl = '', repoFiles = [] } = {}) {
  let baseOrigin = '';
  try {
    if (targetUrl) baseOrigin = new URL(targetUrl).origin;
  } catch {}

  const apiEndpoints = [];
  const seenEndpoints = new Set();

  const frameworkConfigs = [];
  const seenConfigs = new Set();

  const configReferences = [];
  const seenRefs = new Set();

  const addEndpoint = ({ method = 'GET', rawUrl, artifact, line, snippet }) => {
    const resolved = resolveEndpointUrl(rawUrl, baseOrigin);
    if (!resolved) return;
    // Skip obvious static asset files
    if (/\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|css|map|mp4|webm|pdf)(?:\?|$)/i.test(resolved.path)) return;
    const normMethod = String(method || 'GET').toUpperCase();
    const key = `${normMethod}::${resolved.url}`;
    if (seenEndpoints.has(key) || apiEndpoints.length >= 120) return;
    seenEndpoints.add(key);
    apiEndpoints.push({
      id: `ep-${apiEndpoints.length + 1}`,
      method: normMethod,
      url: resolved.url,
      path: resolved.path,
      kind: classifyEndpointKind(resolved.url),
      artifact,
      line,
      snippet
    });
  };

  const addFrameworkConfig = ({ framework, kind, detail, artifact, line = 1 }) => {
    const key = `${framework}::${kind}::${artifact}`;
    if (seenConfigs.has(key) || frameworkConfigs.length >= 60) return;
    seenConfigs.add(key);
    frameworkConfigs.push({ framework, kind, detail, artifact, line });
  };

  const addConfigRef = ({ keyName, category, severity = 'info', valuePreview, redacted = false, artifact, line }) => {
    const key = `${keyName}::${artifact}::${line}`;
    if (seenRefs.has(key) || configReferences.length >= 80) return;
    seenRefs.add(key);
    configReferences.push({
      keyName,
      category,
      severity,
      valuePreview,
      redacted,
      artifact,
      line
    });
  };

  // 1. Repo config file inventory
  for (const file of repoFiles || []) {
    for (const sig of CONFIG_FILE_SIGNATURES) {
      if (sig.re.test(file)) {
        addFrameworkConfig({
          framework: sig.framework,
          kind: sig.kind,
          detail: file,
          artifact: file,
          line: 1
        });
      }
    }
  }

  // 2. Scan artifact contents
  for (const art of artifacts || []) {
    const content = typeof art?.content === 'string' ? art.content : '';
    if (!content) continue;
    const artifact = art.name || art.url || 'source';
    const lineStarts = buildLineIndex(content);

    // Config file match on artifact name
    for (const sig of CONFIG_FILE_SIGNATURES) {
      if (sig.re.test(artifact)) {
        addFrameworkConfig({
          framework: sig.framework,
          kind: sig.kind,
          detail: artifact,
          artifact,
          line: 1
        });
      }
    }

    // Runtime framework config markers
    for (const marker of RUNTIME_CONFIG_MARKERS) {
      marker.re.lastIndex = 0;
      const m = marker.re.exec(content);
      if (m) {
        addFrameworkConfig({
          framework: marker.framework,
          kind: marker.kind,
          detail: m[1] ? `${marker.detail} (${m[1].slice(0, 60)})` : marker.detail,
          artifact,
          line: offsetToLine(lineStarts, m.index)
        });
      }
    }

    // A. Explicit fetch(url, { method }) & axios.<method>(url) calls
    const fetchRe = /\bfetch\s*\(\s*["'`]([^"'`\r\n]{2,220})["'`](?:\s*,\s*\{[^}]{0,220}?\bmethod\s*:\s*["'](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'])?/gi;
    let m;
    while ((m = fetchRe.exec(content)) !== null) {
      addEndpoint({
        method: m[2] || 'GET',
        rawUrl: m[1],
        artifact,
        line: offsetToLine(lineStarts, m.index),
        snippet: safeSnippet(content, m.index, m[0].length)
      });
    }

    const axiosRe = /\b(?:axios|http|apiClient|client)\.(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`\r\n]{2,220})["'`]/gi;
    while ((m = axiosRe.exec(content)) !== null) {
      addEndpoint({
        method: m[1].toUpperCase(),
        rawUrl: m[2],
        artifact,
        line: offsetToLine(lineStarts, m.index),
        snippet: safeSnippet(content, m.index, m[0].length)
      });
    }

    // B. WebSocket endpoints
    const wsRe = /["'`](wss?:\/\/[^"'`\s<>]{4,200})["'`]/gi;
    while ((m = wsRe.exec(content)) !== null) {
      addEndpoint({
        method: 'WS',
        rawUrl: m[1],
        artifact,
        line: offsetToLine(lineStarts, m.index),
        snippet: safeSnippet(content, m.index, m[0].length)
      });
    }

    // C. Full public API / GraphQL / OpenAPI URLs
    const apiUrlRe = /["'`](https?:\/\/[a-z0-9.-]+\.[a-z]{2,14}\/(?:api|v[1-9]\d*|graphql|gql|rest|oauth|auth|openapi\.json|swagger\.json|api-docs|\.well-known)[^"'`\s<>]{0,160})["'`]/gi;
    while ((m = apiUrlRe.exec(content)) !== null) {
      addEndpoint({
        method: 'GET',
        rawUrl: m[1],
        artifact,
        line: offsetToLine(lineStarts, m.index),
        snippet: safeSnippet(content, m.index, m[0].length)
      });
    }

    // D. Relative public API paths ("/api/v1/...", "/graphql", "/openapi.json")
    const relApiRe = /["'`](\/(?:api\/[a-z0-9_./{}-]{1,120}|v[1-9]\/[a-z0-9_./{}-]{1,120}|graphql\b|openapi\.json|swagger\.json|\.well-known\/[a-z0-9_.-]+))["'`]/gi;
    while ((m = relApiRe.exec(content)) !== null) {
      addEndpoint({
        method: 'GET',
        rawUrl: m[1],
        artifact,
        line: offsetToLine(lineStarts, m.index),
        snippet: safeSnippet(content, m.index, m[0].length)
      });
    }

    // E. Safe configuration & env variable references (NEVER captures secrets!)
    const envAssignRe = /\b((?:NEXT_PUBLIC|VITE|REACT_APP|NUXT_PUBLIC|PUBLIC|ASTRO|GATSBY|VUE_APP|APP|API|DEV|STAGING|PREVIEW|AUTH|SENTRY|FIREBASE|SUPABASE|STRIPE)_[A-Z0-9_]{2,40})\s*[:=]\s*["'`]([^"'`\r\n]{1,180})["'`]/g;
    while ((m = envAssignRe.exec(content)) !== null) {
      const keyName = m[1];
      const { valuePreview, redacted } = sanitizePublicConfigValue(keyName, m[2]);
      addConfigRef({
        keyName,
        category: redacted ? 'Sensitive Config Reference (Redacted)' : 'Public Environment Variable',
        severity: redacted ? 'review' : 'info',
        valuePreview,
        redacted,
        artifact,
        line: offsetToLine(lineStarts, m.index)
      });
    }

    // F. Detect exposed credential-like key references WITHOUT collecting values!
    const secretRefRe = /\b(apiKey|api_key|clientSecret|client_secret|accessToken|access_token|privateKey|private_key|authToken|auth_token|webhookSecret|signingSecret|sentryDsn|databaseUrl|DATABASE_URL)\s*[:=]\s*["'`]([^"'`\r\n]{6,180})["'`]/g;
    while ((m = secretRefRe.exec(content)) !== null) {
      addConfigRef({
        keyName: m[1],
        category: 'Credential Key Reference (Value Redacted)',
        severity: 'review',
        valuePreview: '[REDACTED — secret values are never collected or displayed]',
        redacted: true,
        artifact,
        line: offsetToLine(lineStarts, m.index)
      });
    }

    // G. Publicly exposed dev/debug configuration flags
    const debugFlagRe = /\b(debug|DEBUG|enableDebug|devMode|DEV_MODE|isDev)\s*[:=]\s*true\b/g;
    while ((m = debugFlagRe.exec(content)) !== null) {
      addConfigRef({
        keyName: m[1],
        category: 'Development Flag',
        severity: 'review',
        valuePreview: 'true',
        redacted: false,
        artifact,
        line: offsetToLine(lineStarts, m.index)
      });
    }

    // H. robots.txt sensitive/dev route disclosures
    if (/robots\.txt$/i.test(artifact)) {
      const disallowRe = /^Disallow:\s*(\/(?:dev|staging|stage|qa|beta|test|debug|admin|internal|api|graphql|swagger|openapi|preview)[^\s#]*)/gim;
      while ((m = disallowRe.exec(content)) !== null) {
        addConfigRef({
          keyName: 'robots.txt Disallow',
          category: 'Exposed Route Hint',
          severity: 'info',
          valuePreview: m[1],
          redacted: false,
          artifact,
          line: offsetToLine(lineStarts, m.index)
        });
      }
    }
  }

  return {
    apiEndpoints,
    frameworkConfigs,
    configReferences,
    counts: {
      apiEndpoints: apiEndpoints.length,
      frameworkConfigs: frameworkConfigs.length,
      configReferences: configReferences.length,
      redactedReferences: configReferences.filter((r) => r.redacted).length
    }
  };
}
