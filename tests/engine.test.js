import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getApexDomain, isValidHostname } from '../src/engine/tlds.js';
import { extractDomainsFromArtifacts } from '../src/engine/domains.js';
import { detectBuildStack } from '../src/engine/stack.js';
import { analyzeScan } from '../src/engine/analyzer.js';
import { buildSampleScan } from '../src/engine/sample.js';
import { parseGitHubInput } from '../src/engine/github.js';
import { extractOtpCodes, formatCountdown, isValidUuid } from '../src/ui/tempmail.js';
import { classifySubdomainList, normalizeRootDomain } from '../src/ui/subdomains.js';
import { createAppServer, isBlockedIP } from '../server.js';

test('tlds: rejects JS property noise and file extensions while keeping real hosts', () => {
  assert.equal(isValidHostname('window.top', { strictBare: true }), false);
  assert.equal(isValidHostname('document.body', { strictBare: true }), false);
  assert.equal(isValidHostname('main.bundle.js', { strictBare: true }), false);
  assert.equal(isValidHostname('styles.css', { strictBare: true }), false);
  assert.equal(isValidHostname('README.md', { strictBare: true }), false);
  assert.equal(isValidHostname('v1.2.3', { strictBare: true }), false);

  assert.equal(isValidHostname('staging.northstarcloud.io', { strictBare: true }), true);
  assert.equal(isValidHostname('preview-42.vercel.app', { strictBare: true }), true);
  assert.equal(isValidHostname('api.example.co.uk', { strictBare: true }), true);
  assert.equal(getApexDomain('api.staging.acme.co.uk'), 'acme.co.uk');
  assert.equal(getApexDomain('pr-12.demo-site.pages.dev'), 'demo-site.pages.dev');
});

test('domains: discovers dev, staging, preview, localhost, CSP, and sourcemaps accurately', () => {
  const html = `
    <html>
      <script>
        const prod = "https://api.acme.io/v1";
        const dev = "https://dev.acme.io/api";
        const staging = "https://staging-app.acme.io";
        const vercel = "https://acme-web-git-feat-ui.vercel.app";
        const cf = "https://pr-99.acme-docs.pages.dev";
        const local = "http://localhost:5173/graphql";
        const noise = window.location.href + document.body.id + "bundle.min.js";
      </script>
    </html>
  `;
  const js = `
    const s = "https://deploy-preview-12--acme-site.netlify.app";
    //# sourceMappingURL=app.chunk.js.map
  `;

  const report = extractDomainsFromArtifacts(
    [
      { name: 'index.html', type: 'html', content: html },
      { name: 'app.js', type: 'js', content: js }
    ],
    {
      targetUrl: 'https://acme.io',
      headers: {
        'content-security-policy': "connect-src 'self' https://qa.acme.io https://api.acme.io"
      }
    }
  );

  const devHosts = new Set(report.devSites.map((d) => d.host));
  assert.ok(devHosts.has('dev.acme.io'), 'should detect dev.acme.io');
  assert.ok(devHosts.has('staging-app.acme.io'), 'should detect staging-app.acme.io');
  assert.ok(devHosts.has('qa.acme.io'), 'should detect qa.acme.io from CSP header');
  assert.ok(devHosts.has('acme-web-git-feat-ui.vercel.app'), 'should detect Vercel preview host');
  assert.ok(devHosts.has('pr-99.acme-docs.pages.dev'), 'should detect Cloudflare Pages preview host');
  assert.ok(devHosts.has('deploy-preview-12--acme-site.netlify.app'), 'should detect Netlify preview host');
  assert.ok(devHosts.has('localhost'), 'should detect localhost dev server');

  const allHosts = new Set(report.domains.map((d) => d.host));
  assert.ok(allHosts.has('api.acme.io'), 'should detect API host');
  assert.equal(allHosts.has('bundle.min.js'), false, 'must filter JS filenames');
  assert.equal(report.sourceMaps.length, 1);
  assert.equal(report.sourceMaps[0].ref, 'app.chunk.js.map');
});

test('stack: detects frameworks, bundlers, styling, hosting, and versions', () => {
  const artifacts = [
    {
      name: 'index.html',
      type: 'html',
      content: `<!doctype html><html><head><meta name="generator" content="Astro v4.15.2"></head><body class="flex items-center px-4 py-2"><astro-island></astro-island></body></html>`
    },
    {
      name: 'assets/app.js',
      type: 'js',
      content: `import.meta.hot; __vite_preload(); Sentry.init({ dsn: "https://o1.ingest.sentry.io/1" });`
    },
    {
      name: 'styles.css',
      type: 'css',
      content: `:root { --tw-border-spacing-x: 0; }`
    },
    {
      name: 'package.json',
      type: 'json',
      content: JSON.stringify({
        packageManager: 'pnpm@9.1.0',
        dependencies: { astro: '^4.15.2', react: '^18.3.1' },
        devDependencies: { typescript: '^5.6.0', tailwindcss: '^3.4.0', vite: '^5.4.0' }
      })
    }
  ];

  const stack = detectBuildStack(artifacts, {
    headers: { server: 'cloudflare', 'cf-ray': '8e1234-EWR' },
    repoFiles: ['astro.config.mjs', 'tailwind.config.ts', 'tsconfig.json', 'pnpm-lock.yaml']
  });

  const ids = new Set(stack.technologies.map((t) => t.id));
  assert.ok(ids.has('astro'));
  assert.ok(ids.has('react'));
  assert.ok(ids.has('vite'));
  assert.ok(ids.has('tailwind'));
  assert.ok(ids.has('typescript'));
  assert.ok(ids.has('cloudflare'));
  assert.ok(ids.has('pnpm'));
  assert.ok(ids.has('sentry'));

  const astro = stack.technologies.find((t) => t.id === 'astro');
  assert.equal(astro.version, '4.15.2');
});

test('sample showcase scan produces rich multi-environment report', () => {
  const sample = buildSampleScan();
  assert.ok(sample.counts.devSites >= 8, `expected >= 8 dev sites, got ${sample.counts.devSites}`);
  assert.ok(sample.counts.technologies >= 12, `expected >= 12 stack items, got ${sample.counts.technologies}`);
  assert.ok(sample.architectureSummary.includes('Next.js'));
  assert.ok(sample.sourceMaps.length >= 1);
});

test('parseGitHubInput handles shorthand, HTTPS URLs, tree branches, and SSH', () => {
  assert.deepEqual(parseGitHubInput('vitejs/vite'), { owner: 'vitejs', repo: 'vite', branch: '' });
  assert.deepEqual(parseGitHubInput('https://github.com/vercel/next.js/tree/canary'), {
    owner: 'vercel',
    repo: 'next.js',
    branch: 'canary'
  });
  assert.deepEqual(parseGitHubInput('git@github.com:withastro/astro.git'), {
    owner: 'withastro',
    repo: 'astro',
    branch: ''
  });
  assert.equal(parseGitHubInput('not-a-repo'), null);
});

test('server SSRF protection blocks private, loopback, metadata, and IPv6 local ranges', () => {
  assert.equal(isBlockedIP('127.0.0.1'), true);
  assert.equal(isBlockedIP('10.0.0.5'), true);
  assert.equal(isBlockedIP('172.16.10.2'), true);
  assert.equal(isBlockedIP('192.168.1.1'), true);
  assert.equal(isBlockedIP('169.254.169.254'), true);
  assert.equal(isBlockedIP('100.64.0.1'), true);
  assert.equal(isBlockedIP('0.0.0.0'), true);
  assert.equal(isBlockedIP('::1'), true);
  assert.equal(isBlockedIP('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedIP('fe80::1'), true);
  assert.equal(isBlockedIP('fc00::1'), true);

  assert.equal(isBlockedIP('140.82.112.4'), false);
  assert.equal(isBlockedIP('1.1.1.1'), false);
  assert.equal(isBlockedIP('2606:4700:4700::1111'), false);
});

test('HTTP server end-to-end: health, static UI, SSRF block, and deep crawl of mock site', async () => {
  // 1. Start mock target site serving HTML + JS bundle + robots.txt
  const mockSite = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        Server: 'Vercel',
        'X-Powered-By': 'Next.js',
        'Content-Security-Policy': "connect-src 'self' https://staging-edge.mockcorp.io"
      });
      res.end(`<!doctype html><html><head><title>MockCorp</title></head><body><div id="__next"></div><script id="__NEXT_DATA__">{"buildId":"1"}</script><script src="/_next/static/chunks/app.js"></script></body></html>`);
      return;
    }
    if (req.url === '/_next/static/chunks/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(`self.webpackChunk = []; const dev = "https://dev.mockcorp.io/api"; const pr = "https://mockcorp-pr-77.vercel.app"; //# sourceMappingURL=app.js.map`);
      return;
    }
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('User-agent: *\n# Internal QA: https://qa.mockcorp.io\n');
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise((r) => mockSite.listen(0, '127.0.0.1', r));
  const mockPort = mockSite.address().port;

  // 2. Start hardened DevTrace server (blocks loopback!)
  const strictApp = createAppServer({ allowLocalTest: false });
  await new Promise((r) => strictApp.listen(0, '127.0.0.1', r));
  const strictPort = strictApp.address().port;

  // 3. Start local-test DevTrace server (can crawl mockSite!)
  const testApp = createAppServer({ allowLocalTest: true });
  await new Promise((r) => testApp.listen(0, '127.0.0.1', r));
  const testPort = testApp.address().port;

  try {
    // Health endpoint
    const healthRes = await fetch(`http://127.0.0.1:${strictPort}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);

    // Static index.html includes Z.ai HUD and 3 primary tabs
    const htmlRes = await fetch(`http://127.0.0.1:${strictPort}/`);
    assert.equal(htmlRes.status, 200);
    const htmlBody = await htmlRes.text();
    assert.ok(htmlBody.includes('DevTrace'));
    assert.ok(htmlBody.includes('Temp Mail'));
    assert.ok(htmlBody.includes('Subdomains'));
    assert.ok(htmlBody.includes('Site Inspector'));

    // Validation checks on new proxy routes
    const badSubRes = await fetch(`http://127.0.0.1:${strictPort}/api/subdomains?domain=not_a_domain`);
    assert.equal(badSubRes.status, 400);
    const badMailRes = await fetch(`http://127.0.0.1:${strictPort}/api/mailboxes/invalid-id`);
    assert.equal(badMailRes.status, 400);

    // SSRF rejection on strict server
    const ssrfRes = await fetch(`http://127.0.0.1:${strictPort}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}/` })
    });
    assert.equal(ssrfRes.status, 403);
    const ssrfJson = await ssrfRes.json();
    assert.equal(ssrfJson.code, 'SSRF_BLOCKED');

    const metaRes = await fetch(`http://127.0.0.1:${strictPort}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' })
    });
    assert.equal(metaRes.status, 403);

    // Full deep crawl against mockSite
    const scanRes = await fetch(`http://127.0.0.1:${testPort}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}/`, maxBundles: 5, probeMeta: true })
    });
    assert.equal(scanRes.status, 200);
    const report = await scanRes.json();

    const devHosts = new Set(report.devSites.map((d) => d.host));
    assert.ok(devHosts.has('dev.mockcorp.io'), 'crawled JS bundle and extracted dev.mockcorp.io');
    assert.ok(devHosts.has('mockcorp-pr-77.vercel.app'), 'crawled JS bundle and extracted Vercel preview');
    assert.ok(devHosts.has('staging-edge.mockcorp.io'), 'extracted staging host from CSP header');
    assert.ok(devHosts.has('qa.mockcorp.io'), 'probed robots.txt and extracted qa.mockcorp.io');

    const techIds = new Set(report.stack.technologies.map((t) => t.id));
    assert.ok(techIds.has('nextjs'), 'detected Next.js');
    assert.ok(techIds.has('vercel'), 'detected Vercel');
    assert.ok(techIds.has('webpack'), 'detected Webpack from linked bundle');
    assert.equal(report.sourceMaps.length, 1);
  } finally {
    mockSite.close();
    strictApp.close();
    testApp.close();
  }
});

test('tempmail helpers: OTP extraction, countdown formatting, and UUID validation', () => {
  assert.equal(isValidUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(isValidUuid('not-a-uuid'), false);

  const codes = extractOtpCodes('Your verification code is 849201.\nExpires in 10 minutes.', 'Verify your login');
  assert.deepEqual(codes, ['849201']);

  const now = Date.parse('2026-11-15T20:00:00Z');
  const active = formatCountdown('2026-11-15T20:09:30Z', now);
  assert.equal(active.label, '09:30');
  assert.equal(active.expired, false);
  assert.equal(active.urgent, false);

  const urgent = formatCountdown('2026-11-15T20:01:15Z', now);
  assert.equal(urgent.urgent, true);
  assert.equal(urgent.expired, false);

  const expired = formatCountdown('2026-11-15T19:59:00Z', now);
  assert.equal(expired.expired, true);
});

test('subdomains helpers: root domain normalization and dev/staging classification', () => {
  assert.equal(normalizeRootDomain('https://www.GitHub.com/orgs/test'), 'github.com');
  assert.equal(normalizeRootDomain('api.staging.acme.co.uk'), 'acme.co.uk');
  assert.equal(normalizeRootDomain('invalid'), '');

  const classified = classifySubdomainList('acme.io', [
    'www.acme.io',
    'dev.acme.io',
    'staging-api.acme.io',
    'api.acme.io',
    'cdn.acme.io',
    'blog.acme.io'
  ]);

  assert.equal(classified.counts.dev, 2);
  assert.equal(classified.counts.api, 1);
  assert.equal(classified.counts.cdn, 1);
  // Dev hosts sorted first
  assert.equal(classified.rows[0].bucket, 'dev');
  assert.equal(classified.rows[1].bucket, 'dev');
});

