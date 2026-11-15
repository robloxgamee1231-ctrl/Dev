import {
  INTERNAL_DEV_TLDS,
  PLACEHOLDER_HOSTS,
  getApexDomain,
  getSubdomain,
  isIPv4,
  isValidHostname,
  normalizeHost
} from './tlds.js';

// Deploy / preview / ephemeral / staging platforms commonly found in code & builds
const PREVIEW_PLATFORM_PATTERNS = [
  { suffix: 'vercel.app', label: 'Vercel Preview / Deployment', env: 'preview' },
  { suffix: 'now.sh', label: 'Vercel Legacy (now.sh)', env: 'preview' },
  { suffix: 'netlify.app', label: 'Netlify Deploy / Preview', env: 'preview' },
  { suffix: 'pages.dev', label: 'Cloudflare Pages', env: 'preview' },
  { suffix: 'workers.dev', label: 'Cloudflare Workers', env: 'preview' },
  { suffix: 'github.io', label: 'GitHub Pages', env: 'preview' },
  { suffix: 'gitlab.io', label: 'GitLab Pages', env: 'preview' },
  { suffix: 'bitbucket.io', label: 'Bitbucket Pages', env: 'preview' },
  { suffix: 'herokuapp.com', label: 'Heroku App', env: 'preview' },
  { suffix: 'onrender.com', label: 'Render Deployment', env: 'preview' },
  { suffix: 'fly.dev', label: 'Fly.io Deployment', env: 'preview' },
  { suffix: 'railway.app', label: 'Railway Deployment', env: 'preview' },
  { suffix: 'web.app', label: 'Firebase Hosting', env: 'preview' },
  { suffix: 'firebaseapp.com', label: 'Firebase App', env: 'preview' },
  { suffix: 'amplifyapp.com', label: 'AWS Amplify Preview', env: 'preview' },
  { suffix: 'azurestaticapps.net', label: 'Azure Static Web Apps', env: 'preview' },
  { suffix: 'azurewebsites.net', label: 'Azure App Service', env: 'preview' },
  { suffix: 'appspot.com', label: 'Google App Engine', env: 'preview' },
  { suffix: 'run.app', label: 'Google Cloud Run', env: 'preview' },
  { suffix: 'cloudfunctions.net', label: 'Google Cloud Functions', env: 'preview' },
  { suffix: 'surge.sh', label: 'Surge.sh Static Deploy', env: 'preview' },
  { suffix: 'deno.dev', label: 'Deno Deploy', env: 'preview' },
  { suffix: 'glitch.me', label: 'Glitch Sandbox', env: 'dev' },
  { suffix: 'repl.co', label: 'Replit Preview', env: 'dev' },
  { suffix: 'replit.dev', label: 'Replit Dev Server', env: 'dev' },
  { suffix: 'stackblitz.io', label: 'StackBlitz Sandbox', env: 'dev' },
  { suffix: 'codesandbox.io', label: 'CodeSandbox', env: 'dev' },
  { suffix: 'csb.app', label: 'CodeSandbox Preview', env: 'dev' },
  { suffix: 'ngrok.io', label: 'ngrok Dev Tunnel', env: 'dev' },
  { suffix: 'ngrok-free.app', label: 'ngrok Dev Tunnel', env: 'dev' },
  { suffix: 'trycloudflare.com', label: 'Cloudflare Quick Tunnel', env: 'dev' },
  { suffix: 'loca.lt', label: 'Localtunnel Dev Tunnel', env: 'dev' },
  { suffix: 'myshopify.com', label: 'Shopify Store Origin', env: 'preview' },
  { suffix: 'webflow.io', label: 'Webflow Staging Site', env: 'staging' },
  { suffix: 'framer.website', label: 'Framer Preview Site', env: 'preview' },
  { suffix: 'wixsite.com', label: 'Wix Staging Site', env: 'preview' },
  { suffix: 'pantheonsite.io', label: 'Pantheon Dev/Staging', env: 'staging' },
  { suffix: 'wpengine.com', label: 'WP Engine Staging', env: 'staging' },
  { suffix: 'wpenginepowered.com', label: 'WP Engine Origin', env: 'staging' },
  { suffix: 'kinsta.cloud', label: 'Kinsta Staging', env: 'staging' },
  { suffix: 'cloudfront.net', label: 'AWS CloudFront Origin', env: 'cdn' },
  { suffix: 's3.amazonaws.com', label: 'AWS S3 Bucket', env: 'cdn' },
  { suffix: 'blob.core.windows.net', label: 'Azure Blob Storage', env: 'cdn' },
  { suffix: 'r2.dev', label: 'Cloudflare R2 Public Bucket', env: 'cdn' }
];

// Well-known public consumer / documentation hosts that happen to contain dev-like words
const NON_DEV_KNOWN_HOSTS = new Set([
  'play.google.com',
  'play.apple.com',
  'dev.to',
  'web.dev',
  'pkg.go.dev',
  'developers.google.com',
  'developer.mozilla.org',
  'developer.apple.com',
  'developer.chrome.com',
  'developers.facebook.com',
  'developers.cloudflare.com',
  'devblogs.microsoft.com'
]);

const DEV_LABEL_RE = /^(?:dev|dev\d+|dev-[a-z0-9-]+|[a-z0-9-]+-dev|develop|development|local|localhost|sandbox|sbx|sbx-[a-z0-9-]+|lab|labs|nightly|canary|alpha|exp|experimental|internal|int|intranet|corp|debug|devbox|workstation|playground|proto|prototype)$/i;
const STAGING_LABEL_RE = /^(?:staging|stage|stg|stg\d+|stg-[a-z0-9-]+|[a-z0-9-]+-stg|[a-z0-9-]+-staging|qa|qa\d+|qa-[a-z0-9-]+|[a-z0-9-]+-qa|uat|uat\d+|preprod|pre-prod|pre|beta|beta\d+|rc|rc\d+|test|testing|test\d+|demo|sit|perf|loadtest|mirror|next|vnext|preview|pr-\d+|pull-\d+|branch-[a-z0-9-]+)$/i;
const API_LABEL_RE = /^(?:api|api\d+|api-[a-z0-9-]+|[a-z0-9-]+-api|graphql|gql|rpc|ws|wss|socket|realtime|stream|events|gateway|gw|edge|auth|oauth|sso|login|id|identity|accounts|backend|service|services|svc|data|telemetry|ingest|collect|webhook|webhooks|hooks|proxy)$/i;
const CDN_LABEL_RE = /^(?:cdn|cdn\d+|cdn-[a-z0-9-]+|static|static\d+|assets|asset|media|img|imgs|image|images|files|uploads|storage|bucket|fonts|font|js|css|dl|download|downloads|dist|pkg|packages|cache|edge-assets|res|resources)$/i;

const KNOWN_CDNS = [
  ['cloudflare.com', 'Cloudflare'],
  ['cdnjs.cloudflare.com', 'cdnjs'],
  ['jsdelivr.net', 'jsDelivr CDN'],
  ['unpkg.com', 'unpkg CDN'],
  ['esm.sh', 'esm.sh CDN'],
  ['skypack.dev', 'Skypack CDN'],
  ['googleapis.com', 'Google APIs / Fonts'],
  ['gstatic.com', 'Google Static Assets'],
  ['googleusercontent.com', 'Google User Content'],
  ['fastly.net', 'Fastly CDN'],
  ['akamaihd.net', 'Akamai CDN'],
  ['akamaized.net', 'Akamai CDN'],
  ['edgekey.net', 'Akamai Edge'],
  ['cloudfront.net', 'AWS CloudFront'],
  ['s3.amazonaws.com', 'AWS S3 Storage'],
  ['blob.core.windows.net', 'Azure Blob Storage'],
  ['ctfassets.net', 'Contentful Media CDN'],
  ['cloudinary.com', 'Cloudinary Media'],
  ['imgix.net', 'imgix Media'],
  ['imagekit.io', 'ImageKit'],
  ['bunnycdn.com', 'Bunny CDN'],
  ['b-cdn.net', 'Bunny CDN'],
  ['stackpathcdn.com', 'StackPath CDN'],
  ['azureedge.net', 'Azure CDN'],
  ['githubassets.com', 'GitHub Assets CDN'],
  ['githubusercontent.com', 'GitHub Raw Content'],
  ['twimg.com', 'Twitter/X Media CDN'],
  ['fbcdn.net', 'Meta CDN'],
  ['shopifycdn.com', 'Shopify CDN'],
  ['vimeocdn.com', 'Vimeo CDN'],
  ['ytimg.com', 'YouTube Media'],
  ['typekit.net', 'Adobe Fonts'],
  ['use.fontawesome.com', 'Font Awesome CDN']
];

const KNOWN_THIRD_PARTY = [
  ['googletagmanager.com', 'Google Tag Manager'],
  ['google-analytics.com', 'Google Analytics'],
  ['analytics.google.com', 'Google Analytics'],
  ['doubleclick.net', 'Google Ads / DoubleClick'],
  ['googlesyndication.com', 'Google AdSense'],
  ['sentry.io', 'Sentry Error Tracking'],
  ['ingest.sentry.io', 'Sentry Ingest'],
  ['browser-intake-datadoghq.com', 'Datadog RUM'],
  ['datadoghq.com', 'Datadog'],
  ['posthog.com', 'PostHog Analytics'],
  ['mixpanel.com', 'Mixpanel'],
  ['amplitude.com', 'Amplitude'],
  ['segment.io', 'Segment'],
  ['segment.com', 'Segment'],
  ['plausible.io', 'Plausible Analytics'],
  ['usefathom.com', 'Fathom Analytics'],
  ['hotjar.com', 'Hotjar'],
  ['clarity.ms', 'Microsoft Clarity'],
  ['fullstory.com', 'FullStory'],
  ['logrocket.io', 'LogRocket'],
  ['launchdarkly.com', 'LaunchDarkly Feature Flags'],
  ['statsig.com', 'Statsig'],
  ['optimizely.com', 'Optimizely'],
  ['stripe.com', 'Stripe Payments'],
  ['js.stripe.com', 'Stripe.js'],
  ['paypal.com', 'PayPal'],
  ['braintreegateway.com', 'Braintree'],
  ['intercom.io', 'Intercom'],
  ['intercomcdn.com', 'Intercom'],
  ['crisp.chat', 'Crisp Chat'],
  ['zendesk.com', 'Zendesk'],
  ['hubspot.com', 'HubSpot'],
  ['hs-scripts.com', 'HubSpot'],
  ['marketo.net', 'Marketo'],
  ['algolia.net', 'Algolia Search'],
  ['algolianet.com', 'Algolia Search'],
  ['supabase.co', 'Supabase BaaS'],
  ['firebaseio.com', 'Firebase Realtime DB'],
  ['auth0.com', 'Auth0 Identity'],
  ['clerk.com', 'Clerk Auth'],
  ['clerk.accounts.dev', 'Clerk Dev Instance'],
  ['okta.com', 'Okta Identity'],
  ['recaptcha.net', 'Google reCAPTCHA'],
  ['hcaptcha.com', 'hCaptcha'],
  ['challenges.cloudflare.com', 'Cloudflare Turnstile'],
  ['vercel-insights.com', 'Vercel Analytics'],
  ['vercel-scripts.com', 'Vercel Speed Insights'],
  ['newrelic.com', 'New Relic'],
  ['nr-data.net', 'New Relic'],
  ['bugsnag.com', 'Bugsnag'],
  ['rollbar.com', 'Rollbar'],
  ['contentful.com', 'Contentful CMS'],
  ['sanity.io', 'Sanity CMS'],
  ['prismic.io', 'Prismic CMS'],
  ['storyblok.com', 'Storyblok CMS'],
  ['strapi.io', 'Strapi CMS'],
  ['shopify.com', 'Shopify'],
  ['github.com', 'GitHub'],
  ['api.github.com', 'GitHub API'],
  ['npmjs.org', 'npm Registry'],
  ['registry.npmjs.org', 'npm Registry'],
  ['discord.com', 'Discord'],
  ['slack.com', 'Slack'],
  ['twitter.com', 'Twitter / X'],
  ['x.com', 'X'],
  ['linkedin.com', 'LinkedIn'],
  ['facebook.com', 'Meta / Facebook'],
  ['youtube.com', 'YouTube']
];

const DEV_PORTS = new Set([
  '3000', '3001', '3002', '3030', '3333', '4000', '4173', '4200', '4321',
  '5000', '5001', '5173', '5174', '5432', '5500', '6006', '7000', '8000',
  '8001', '8008', '8080', '8081', '8443', '8787', '8888', '9000', '9090', '9229', '1313'
]);

// Fast line-offset helper so large bundles locate line numbers in O(log n)
function buildLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToLine(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(1, hi + 1);
}

function makeSnippet(text, index, matchLen) {
  const start = Math.max(0, index - 65);
  const end = Math.min(text.length, index + matchLen + 65);
  let slice = text.slice(start, end).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (start > 0) slice = '…' + slice;
  if (end < text.length) slice = slice + '…';
  return slice;
}

function cleanTrailingPunctuation(raw) {
  return raw.replace(/[),.;:'"`\]}>\\]+$/, '');
}

function parseUrlParts(rawUrl) {
  try {
    let normalized = rawUrl;
    if (normalized.startsWith('//')) normalized = 'https:' + normalized;
    const u = new URL(normalized);
    return {
      protocol: u.protocol.replace(':', ''),
      host: normalizeHost(u.hostname),
      port: u.port || '',
      pathname: u.pathname || '/',
      full: rawUrl
    };
  } catch {
    return null;
  }
}

function matchVendor(host, table) {
  for (const [suffix, label] of table) {
    if (host === suffix || host.endsWith('.' + suffix)) {
      return label;
    }
  }
  return null;
}

export function classifyHost(host, { targetHost = '', targetApex = '', ports = new Set(), sampleUrls = [], contexts = [] } = {}) {
  const h = normalizeHost(host);
  const apex = getApexDomain(h);
  const sub = getSubdomain(h);
  const labels = h.split('.');
  const tld = labels[labels.length - 1];
  const isTarget = Boolean(targetHost && (h === targetHost || h === 'www.' + targetHost || 'www.' + h === targetHost));
  const isFirstParty = Boolean(targetApex && apex === targetApex);
  const isPlaceholder = PLACEHOLDER_HOSTS.has(h);
  const reasons = [];

  let category = 'external';
  let envTag = 'prod';
  let isDevSurface = false;
  let priority = 10;
  let vendor = null;

  // 1. Localhost / loopback / private / internal TLDs
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '0.0.0.0' ||
    h.endsWith('.localhost') ||
    INTERNAL_DEV_TLDS.has(tld) ||
    /^10\.\d+\.\d+\.\d+$/.test(h) ||
    /^192\.168\.\d+\.\d+$/.test(h) ||
    /^172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)
  ) {
    category = 'dev';
    envTag = 'local';
    isDevSurface = true;
    priority = 100;
    reasons.push(INTERNAL_DEV_TLDS.has(tld) ? `Internal/dev TLD (.${tld})` : 'Localhost / private network host');
  }

  // 2. Check Clerk dev instance & other explicit dev SaaS domains
  if (!isDevSurface && h.endsWith('.accounts.dev')) {
    category = 'dev';
    envTag = 'dev';
    isDevSurface = true;
    priority = 92;
    vendor = 'Clerk Dev Instance';
    reasons.push('Clerk development auth instance (*.accounts.dev)');
  }

  // 3. Preview / staging / ephemeral hosting platforms
  if (!isDevSurface) {
    for (const p of PREVIEW_PLATFORM_PATTERNS) {
      if (h !== p.suffix && h.endsWith('.' + p.suffix)) {
        if (p.env === 'cdn') {
          category = 'cdn';
          envTag = 'cdn';
          vendor = p.label;
          priority = 45;
          reasons.push(`Cloud asset origin: ${p.label}`);
        } else {
          category = p.env; // preview | staging | dev
          envTag = p.env;
          isDevSurface = true;
          vendor = p.label;
          priority = 90;
          reasons.push(`Deploy/preview host: ${p.label} (*.${p.suffix})`);
        }
        break;
      }
    }
  }

  // 4. Inspect subdomain labels for dev / staging / preview / QA patterns
  const subLabels = sub ? sub.split('.') : [];
  const isKnownNonDev = NON_DEV_KNOWN_HOSTS.has(h);
  if (!isKnownNonDev) {
    for (const label of subLabels) {
      if (DEV_LABEL_RE.test(label)) {
        category = 'dev';
        envTag = 'dev';
        isDevSurface = true;
        priority = Math.max(priority, 96);
        reasons.push(`Dev subdomain token "${label}"`);
        break;
      }
      if (STAGING_LABEL_RE.test(label)) {
        category = 'staging';
        envTag = label.startsWith('pr-') || label === 'preview' ? 'preview' : 'staging';
        isDevSurface = true;
        priority = Math.max(priority, 94);
        reasons.push(`Staging/QA subdomain token "${label}"`);
        break;
      }
    }
  }

  // 5. Check compound hyphenated tokens in hostname (e.g. myapp-staging.example.com or api-dev.foo.io)
  if (!isDevSurface && !isKnownNonDev) {
    const firstLabel = labels[0] || '';
    if (/(?:^|-)(?:dev|sandbox|sbx|nightly|canary|alpha|internal|local)(?:-|$|\d)/i.test(firstLabel) && !isPlaceholder) {
      category = 'dev';
      envTag = 'dev';
      isDevSurface = true;
      priority = Math.max(priority, 92);
      reasons.push(`Dev host prefix "${firstLabel}"`);
    } else if (/(?:^|-)(?:staging|stage|stg|qa|uat|preprod|beta|preview|demo)(?:-|$|\d)/i.test(firstLabel) && !isPlaceholder) {
      category = 'staging';
      envTag = 'staging';
      isDevSurface = true;
      priority = Math.max(priority, 90);
      reasons.push(`Staging/preview host prefix "${firstLabel}"`);
    }
  }

  // 6. Explicit dev port found on host
  const devPortsFound = [...ports].filter((p) => DEV_PORTS.has(p));
  if (devPortsFound.length > 0 && !isDevSurface) {
    category = 'dev';
    envTag = 'dev';
    isDevSurface = true;
    priority = Math.max(priority, 88);
    reasons.push(`Exposed dev port :${devPortsFound.join(', :')}`);
  } else if (devPortsFound.length > 0) {
    reasons.push(`Dev port :${devPortsFound.join(', :')}`);
  }

  // 7. Context clues from env variable names in source code
  if (!isDevSurface && contexts.some((c) => /\b(?:DEV|STAGING|STAGE|PREVIEW|SANDBOX|QA|UAT|LOCAL|TEST)_(?:URL|HOST|API|DOMAIN|ORIGIN|ENDPOINT)\b/i.test(c))) {
    category = 'staging';
    envTag = 'staging';
    isDevSurface = true;
    priority = Math.max(priority, 86);
    reasons.push('Referenced in non-production environment config variable');
  }

  // 8. Non-dev categorizations (API, CDN, First-Party, Third-Party)
  if (!isDevSurface && category === 'external') {
    const cdnVendor = matchVendor(h, KNOWN_CDNS);
    const tpVendor = matchVendor(h, KNOWN_THIRD_PARTY);
    const hasApiSub = subLabels.some((l) => API_LABEL_RE.test(l));
    const hasCdnSub = subLabels.some((l) => CDN_LABEL_RE.test(l));
    const hasApiPath = sampleUrls.some((u) => /\/(?:api|graphql|gql|v[1-9]|oauth|auth|rpc)\b/i.test(u));

    if (hasApiSub || (isFirstParty && hasApiPath && !isTarget)) {
      category = 'api';
      envTag = 'api';
      priority = isFirstParty ? 75 : 55;
      vendor = tpVendor || cdnVendor || null;
      reasons.push(hasApiSub ? `API/service subdomain (${sub})` : 'API endpoint path detected');
    } else if (cdnVendor || hasCdnSub) {
      category = 'cdn';
      envTag = 'cdn';
      priority = isFirstParty ? 60 : 40;
      vendor = cdnVendor || (isFirstParty ? 'First-Party Asset Host' : null);
      reasons.push(cdnVendor ? `CDN / Media provider: ${cdnVendor}` : `Asset subdomain (${sub})`);
    } else if (isTarget) {
      category = 'first-party';
      envTag = 'prod';
      priority = 70;
      reasons.push('Primary target domain');
    } else if (isFirstParty) {
      category = 'first-party';
      envTag = 'prod';
      priority = 68;
      reasons.push(`First-party subdomain of ${targetApex}`);
    } else if (tpVendor) {
      category = 'third-party';
      envTag = 'saas';
      priority = 35;
      vendor = tpVendor;
      reasons.push(`Known third-party service: ${tpVendor}`);
    } else {
      category = 'external';
      envTag = 'external';
      priority = 15;
      reasons.push('External domain reference');
    }
  }

  // Flag first-party dev/staging sites as highest priority!
  if (isDevSurface && isFirstParty) {
    priority = Math.min(100, priority + 4);
    reasons.push(`Matches target apex domain (${targetApex})`);
  }

  return {
    host: h,
    apex,
    subdomain: sub,
    category, // dev | staging | preview | api | first-party | cdn | third-party | external
    envTag,   // local | dev | staging | preview | api | prod | cdn | saas | external
    isDevSurface,
    isFirstParty,
    isTarget,
    isPlaceholder,
    vendor,
    priority,
    reasons
  };
}

// Regex patterns tuned to avoid catastrophic backtracking on minified JS
const FULL_URL_RE = /\b(?:https?|wss?):\/\/([a-zA-Z0-9._-]+(?::\d{2,5})?)(\/[^\s"'`<>()[\]{}\\]*)?/g;
const PROTO_REL_RE = /(?:["'`(=,\s])(\/\/([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?::\d{2,5})?)(\/[^\s"'`<>()[\]{}\\]*)?)/g;
const LOCALHOST_RE = /\b((?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5}))(\/[^\s"'`<>()[\]{}\\]*)?/gi;
const QUOTED_HOST_RE = /["'`]([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?::\d{2,5})?)["'`]/g;
const CONFIG_HOST_RE = /(?:host|domain|origin|cname|base_?url|api_?url|site_?url|endpoint|server_?name|proxy_?pass)\s*[:=]\s*["'`]?([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?::\d{2,5})?)["'`]?/gi;
const SOURCEMAP_RE = /\/\/[#@]\s*sourceMappingURL=([^\s*]+)|\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\//g;

// Extract hostnames from CSP & security/CORS headers
function extractFromHeaders(headers, targetUrl, recordMatch) {
  if (!headers || typeof headers !== 'object') return;
  const headerKeys = Object.keys(headers);
  for (const key of headerKeys) {
    const val = String(headers[key] ?? '');
    if (!val) continue;
    const lowerKey = key.toLowerCase();

    // Full URLs in any header (Link, Location, Access-Control-Allow-Origin, Report-To, NEL, CSP)
    FULL_URL_RE.lastIndex = 0;
    let m;
    while ((m = FULL_URL_RE.exec(val)) !== null) {
      const cleaned = cleanTrailingPunctuation(m[0]);
      const parsed = parseUrlParts(cleaned);
      if (parsed && isValidHostname(parsed.host)) {
        recordMatch({
          host: parsed.host,
          port: parsed.port,
          url: cleaned,
          artifact: `HTTP Header: ${key}`,
          sourceType: 'header',
          line: 1,
          snippet: `${key}: ${val.slice(0, 180)}`,
          context: `HTTP header ${lowerKey}`
        });
      }
    }

    // CSP bare hostnames (e.g. `connect-src 'self' *.staging.example.com api.example.com`)
    if (lowerKey === 'content-security-policy' || lowerKey === 'content-security-policy-report-only') {
      const tokens = val.split(/[\s;,]+/);
      for (const tok of tokens) {
        if (!tok || tok.startsWith("'") || tok.endsWith(':')) continue;
        const stripped = tok.replace(/^\*\./, '').replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').split('/')[0];
        const [hostPart, portPart] = stripped.split(':');
        if (hostPart && isValidHostname(hostPart, { strictBare: true })) {
          recordMatch({
            host: normalizeHost(hostPart),
            port: portPart || '',
            url: tok,
            artifact: `HTTP Header: ${key}`,
            sourceType: 'header',
            line: 1,
            snippet: `${key}: … ${tok} …`,
            context: 'CSP directive'
          });
        }
      }
    }
  }
}

export function extractDomainsFromArtifacts(artifacts, { targetUrl = '', headers = {} } = {}) {
  let targetHost = '';
  let targetApex = '';
  if (targetUrl) {
    const parsedTarget = parseUrlParts(targetUrl);
    if (parsedTarget) {
      targetHost = parsedTarget.host;
      targetApex = getApexDomain(targetHost);
    }
  }

  const hostMap = new Map();
  const sourceMaps = [];
  const envHints = [];
  const seenSourceMaps = new Set();

  function recordMatch({ host, port = '', url = '', artifact, sourceType, line, snippet, context = '' }) {
    const h = normalizeHost(host);
    if (!h) return;
    let entry = hostMap.get(h);
    if (!entry) {
      entry = {
        host: h,
        ports: new Set(),
        urls: new Set(),
        artifacts: new Set(),
        sourceTypes: new Set(),
        contexts: [],
        evidence: [],
        occurrences: 0
      };
      hostMap.set(h, entry);
    }
    entry.occurrences += 1;
    if (port) entry.ports.add(String(port));
    if (url && entry.urls.size < 25) entry.urls.add(url);
    if (artifact) entry.artifacts.add(artifact);
    if (sourceType) entry.sourceTypes.add(sourceType);
    if (context && entry.contexts.length < 15) entry.contexts.push(context);
    if (entry.evidence.length < 12) {
      const dedupeKey = `${artifact}:${line}:${snippet.slice(0, 48)}`;
      if (!entry.evidence.some((e) => e._k === dedupeKey)) {
        entry.evidence.push({
          _k: dedupeKey,
          artifact,
          sourceType,
          line,
          snippet,
          url: url || h
        });
      }
    }
  }

  // 1. Extract from HTTP response headers
  extractFromHeaders(headers, targetUrl, recordMatch);

  // 2. Scan every artifact (HTML, JS, CSS, manifests, robots, GitHub repo files)
  for (const art of artifacts) {
    const content = typeof art.content === 'string' ? art.content : '';
    if (!content) continue;
    const artifactName = art.name || art.url || 'source';
    const sourceType = art.type || 'code';
    const lineStarts = buildLineIndex(content);
    const isCname = /(?:^|\/)CNAME$/i.test(artifactName);

    // Special case: GitHub Pages CNAME file
    if (isCname) {
      const cnameHost = normalizeHost(content.split(/\r?\n/)[0]?.trim() || '');
      if (isValidHostname(cnameHost)) {
        recordMatch({
          host: cnameHost,
          url: `https://${cnameHost}`,
          artifact: artifactName,
          sourceType: 'config',
          line: 1,
          snippet: content.trim().slice(0, 140),
          context: 'GitHub Pages CNAME'
        });
      }
    }

    // Extract sourceMappingURL hints
    SOURCEMAP_RE.lastIndex = 0;
    let sm;
    while ((sm = SOURCEMAP_RE.exec(content)) !== null) {
      const ref = (sm[1] || sm[2] || '').trim();
      if (!ref || ref.startsWith('data:')) continue;
      const key = `${artifactName}::${ref}`;
      if (!seenSourceMaps.has(key)) {
        seenSourceMaps.add(key);
        sourceMaps.push({
          ref,
          artifact: artifactName,
          line: offsetToLine(lineStarts, sm.index)
        });
      }
    }

    // Extract explicit env var URL/host declarations (NEXT_PUBLIC_*, VITE_*, REACT_APP_*, etc.)
    const envRe = /\b((?:NEXT_PUBLIC|VITE|REACT_APP|NUXT_PUBLIC|PUBLIC|ASTRO|GATSBY|VUE_APP|APP|API|DEV|STAGING|PREVIEW|SITE)_[A-Z0-9_]{2,40})\s*[:=]\s*["'`]([^"'`\r\n]{4,180})["'`]/g;
    let em;
    while ((em = envRe.exec(content)) !== null && envHints.length < 60) {
      const varName = em[1];
      const varVal = em[2];
      if (/(?:https?:\/\/|wss?:\/\/|localhost|\.[a-z]{2,12}\b)/i.test(varVal)) {
        envHints.push({
          name: varName,
          value: varVal,
          artifact: artifactName,
          line: offsetToLine(lineStarts, em.index)
        });
      }
    }

    // A. Full protocol URLs (https://, http://, wss://, ws://)
    FULL_URL_RE.lastIndex = 0;
    let m;
    let count = 0;
    while ((m = FULL_URL_RE.exec(content)) !== null && count < 4000) {
      count++;
      const cleaned = cleanTrailingPunctuation(m[0]);
      const parsed = parseUrlParts(cleaned);
      if (!parsed || !isValidHostname(parsed.host)) continue;
      const line = offsetToLine(lineStarts, m.index);
      const snippet = makeSnippet(content, m.index, cleaned.length);
      recordMatch({
        host: parsed.host,
        port: parsed.port,
        url: cleaned,
        artifact: artifactName,
        sourceType,
        line,
        snippet,
        context: snippet
      });
    }

    // B. Protocol-relative URLs (//cdn.example.com/...)
    PROTO_REL_RE.lastIndex = 0;
    count = 0;
    while ((m = PROTO_REL_RE.exec(content)) !== null && count < 1500) {
      count++;
      const rawUrl = cleanTrailingPunctuation(m[1]);
      // Skip JS comments like `// foo.bar` by ensuring no space immediately after //
      const parsed = parseUrlParts(rawUrl);
      if (!parsed || !isValidHostname(parsed.host, { strictBare: true })) continue;
      const line = offsetToLine(lineStarts, m.index);
      const snippet = makeSnippet(content, m.index, rawUrl.length);
      recordMatch({
        host: parsed.host,
        port: parsed.port,
        url: 'https:' + rawUrl,
        artifact: artifactName,
        sourceType,
        line,
        snippet,
        context: snippet
      });
    }

    // C. Bare localhost / loopback with port
    LOCALHOST_RE.lastIndex = 0;
    count = 0;
    while ((m = LOCALHOST_RE.exec(content)) !== null && count < 400) {
      count++;
      const hostAndPort = m[1];
      const [h, port] = hostAndPort.split(':');
      const line = offsetToLine(lineStarts, m.index);
      const snippet = makeSnippet(content, m.index, m[0].length);
      recordMatch({
        host: h,
        port,
        url: `http://${hostAndPort}${m[3] || ''}`,
        artifact: artifactName,
        sourceType,
        line,
        snippet,
        context: snippet
      });
    }

    // D. Quoted hostnames in JS/JSON/HTML/config (strictly validated to eliminate JS noise)
    QUOTED_HOST_RE.lastIndex = 0;
    count = 0;
    while ((m = QUOTED_HOST_RE.exec(content)) !== null && count < 2500) {
      count++;
      const raw = m[1];
      if (raw.includes('..') || raw.length > 140) continue;
      const [hostPart, portPart] = raw.split(':');
      if (!isValidHostname(hostPart, { allowBareLocal: false, strictBare: true })) continue;
      // Avoid matching email addresses if preceded by @
      if (m.index > 0 && content[m.index - 1] === '@') continue;
      const line = offsetToLine(lineStarts, m.index);
      const snippet = makeSnippet(content, m.index, m[0].length);
      recordMatch({
        host: hostPart,
        port: portPart || '',
        url: portPart ? `https://${hostPart}:${portPart}` : `https://${hostPart}`,
        artifact: artifactName,
        sourceType,
        line,
        snippet,
        context: snippet
      });
    }

    // E. Config key assignments (`domain = staging.acme.com`, `proxy_pass ...`)
    CONFIG_HOST_RE.lastIndex = 0;
    count = 0;
    while ((m = CONFIG_HOST_RE.exec(content)) !== null && count < 600) {
      count++;
      const raw = m[1];
      const [hostPart, portPart] = raw.split(':');
      if (!isValidHostname(hostPart, { allowBareLocal: false, strictBare: true })) continue;
      const line = offsetToLine(lineStarts, m.index);
      const snippet = makeSnippet(content, m.index, m[0].length);
      recordMatch({
        host: hostPart,
        port: portPart || '',
        url: `https://${raw}`,
        artifact: artifactName,
        sourceType,
        line,
        snippet,
        context: snippet
      });
    }
  }

  // Finalize and classify every discovered host
  const domains = [];
  for (const entry of hostMap.values()) {
    const sampleUrls = [...entry.urls].slice(0, 12);
    const classification = classifyHost(entry.host, {
      targetHost,
      targetApex,
      ports: entry.ports,
      sampleUrls,
      contexts: entry.contexts
    });

    // Exclude pure XML/W3C/schema boilerplate from cluttering results (tag as boilerplate)
    const isSpecNamespace = ['w3.org', 'www.w3.org', 'schema.org', 'xmlns.com', 'purl.org', 'ogp.me', 'gmpg.org', 'xmlpull.org'].includes(entry.host);
    if (isSpecNamespace) continue;

    domains.push({
      ...classification,
      ports: [...entry.ports],
      occurrences: entry.occurrences,
      urls: sampleUrls,
      artifacts: [...entry.artifacts],
      sourceTypes: [...entry.sourceTypes],
      evidence: entry.evidence.map(({ _k, ...rest }) => rest)
    });
  }

  // Sort: dev/staging/preview first, then by priority desc, then occurrences desc
  domains.sort((a, b) => {
    if (a.isDevSurface !== b.isDevSurface) return a.isDevSurface ? -1 : 1;
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return a.host.localeCompare(b.host);
  });

  // Group by apex domain for summary insights
  const apexMap = new Map();
  for (const d of domains) {
    if (!apexMap.has(d.apex)) {
      apexMap.set(d.apex, {
        apex: d.apex,
        isFirstParty: d.isFirstParty,
        hasDevSurface: false,
        hosts: [],
        totalOccurrences: 0
      });
    }
    const g = apexMap.get(d.apex);
    g.hosts.push(d.host);
    g.totalOccurrences += d.occurrences;
    if (d.isDevSurface) g.hasDevSurface = true;
  }

  const apexGroups = [...apexMap.values()].sort((a, b) => {
    if (a.isFirstParty !== b.isFirstParty) return a.isFirstParty ? -1 : 1;
    if (a.hasDevSurface !== b.hasDevSurface) return a.hasDevSurface ? -1 : 1;
    return b.hosts.length - a.hosts.length || b.totalOccurrences - a.totalOccurrences;
  });

  const devSites = domains.filter((d) => d.isDevSurface && !d.isPlaceholder);

  return {
    targetHost,
    targetApex,
    domains,
    devSites,
    apexGroups,
    sourceMaps,
    envHints
  };
}
