import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getApexDomain, isValidHostname } from '../src/engine/tlds.js';
import { extractDomainsFromArtifacts } from '../src/engine/domains.js';
import { detectBuildStack } from '../src/engine/stack.js';
import { analyzeSourceIntelligence } from '../src/engine/source-intel.js';
import { analyzeScan } from '../src/engine/analyzer.js';
import { buildSampleScan } from '../src/engine/sample.js';
import { parseGitHubInput } from '../src/engine/github.js';
import { createCredentialVault, maskSecret } from '../src/server/vault.js';
import { classifySubdomainList, extractDomaineeHosts, normalizeRootDomain, sortRows } from '../src/ui/subdomains.js';
import { parseOpenApiSpec } from '../src/ui/api-inspector.js';
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

test('source-intel: extracts API endpoints & framework configs while strictly redacting secret values', () => {
  const secretToken = 'sk_live_SUPERSECRET_SHOULD_NEVER_APPEAR_99999';
  const artifacts = [
    {
      name: 'index.html',
      type: 'html',
      content: `<script id="__NEXT_DATA__" type="application/json">{"buildId":"b42","page":"/"}</script>`
    },
    {
      name: 'app.bundle.js',
      type: 'js',
      content: `
        fetch("https://api.acme.io/v2/projects", { method: "POST" });
        const gql = "https://api.acme.io/graphql";
        const ws = new WebSocket("wss://realtime.acme.io/ws");
        const NEXT_PUBLIC_API_URL = "https://api.acme.io/v2";
        const STRIPE_SECRET_KEY = "${secretToken}";
      `
    }
  ];

  const intel = analyzeSourceIntelligence(artifacts, { targetUrl: 'https://acme.io' });
  assert.ok(intel.apiEndpoints.some((e) => e.url.includes('/v2/projects') && e.method === 'POST'));
  assert.ok(intel.apiEndpoints.some((e) => e.kind === 'GraphQL'));
  assert.ok(intel.apiEndpoints.some((e) => e.kind === 'WebSocket'));
  assert.ok(intel.frameworkConfigs.some((c) => c.framework === 'Next.js'));

  const serialized = JSON.stringify(intel);
  assert.equal(serialized.includes(secretToken), false, 'MUST NEVER leak raw secret values into report output');
  assert.ok(intel.configReferences.some((r) => r.keyName === 'STRIPE_SECRET_KEY' && r.redacted === true));
  assert.ok(intel.counts.redactedReferences >= 1);
});

test('vault: AES-256-GCM encryption at rest, masking, rotation, outbound auth, and ciphertext-wiping revocation', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devtracer-vault-'));
  try {
    const vault = createCredentialVault({ vaultDir: tmpDir });
    const rawSecret = 'ghp_1234567890abcdefghijklmnopqrstuvwx';
    const created = await vault.create({
      name: 'CI GitHub Token',
      type: 'github_pat',
      provider: 'GitHub',
      secret: rawSecret,
      baseUrl: 'https://api.github.com'
    });

    assert.ok(created.id.startsWith('cred_'));
    assert.equal('secret' in created, false, 'public view must never contain raw secret');
    assert.equal('encryptedSecret' in created, false, 'public view must never contain ciphertext');
    assert.equal(created.maskedPreview.includes(rawSecret), false);
    assert.ok(created.maskedPreview.includes('•'));
    assert.equal(maskSecret('short'), '••••••••');

    // Verify encrypted file on disk never stores plaintext secret
    const diskText = await fs.readFile(path.join(tmpDir, 'vault.enc.json'), 'utf8');
    assert.equal(diskText.includes(rawSecret), false, 'plaintext secret must NEVER exist on disk');
    assert.ok(diskText.includes('"alg": "aes-256-gcm"') || diskText.includes('"alg":"aes-256-gcm"'));

    // Internal server-side resolution returns decrypted Authorization header
    const auth = await vault.resolveOutboundAuth(created.id);
    assert.equal(auth.headers.Authorization, `Bearer ${rawSecret}`);

    // Rotate secret
    const rotatedSecret = 'ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    await vault.update(created.id, { secret: rotatedSecret });
    const authAfter = await vault.resolveOutboundAuth(created.id);
    assert.equal(authAfter.headers.Authorization, `Bearer ${rotatedSecret}`);

    // Revoke wipes ciphertext and rejects outbound resolution
    const revoked = await vault.revoke(created.id);
    assert.equal(revoked.status, 'revoked');
    await assert.rejects(() => vault.resolveOutboundAuth(created.id), /revoked/i);
    const diskAfterRevoke = await fs.readFile(path.join(tmpDir, 'vault.enc.json'), 'utf8');
    assert.equal(diskAfterRevoke.includes('"ciphertext"'), false, 'revoked record must wipe encrypted ciphertext');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('sample showcase scan produces rich multi-environment + sourceIntel report', () => {
  const sample = buildSampleScan();
  assert.ok(sample.counts.devSites >= 8, `expected >= 8 dev sites, got ${sample.counts.devSites}`);
  assert.ok(sample.counts.technologies >= 12, `expected >= 12 stack items, got ${sample.counts.technologies}`);
  assert.ok(sample.sourceIntel, 'sample scan must include sourceIntel');
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

test('parseOpenApiSpec enumerates documented paths and HTTP methods', () => {
  const parsed = parseOpenApiSpec(
    {
      openapi: '3.0.3',
      info: { title: 'Demo API', version: '1.2.0' },
      servers: [{ url: 'https://api.demo.io/v1' }],
      paths: {
        '/health': { get: { summary: 'Health check', tags: ['System'] } },
        '/items': { post: { summary: 'Create item', tags: ['Items'] } }
      }
    },
    'https://api.demo.io/openapi.json'
  );
  assert.equal(parsed.title, 'Demo API');
  assert.equal(parsed.endpoints.length, 2);
  assert.equal(parsed.endpoints[0].url, 'https://api.demo.io/v1/health');
  assert.equal(parsed.endpoints[1].method, 'POST');
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

test('HTTP server end-to-end: health, sidebar UI, SSRF blocks, deep crawl, DNS validation, Vault + API Inspector auth', async () => {
  const tmpVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devtracer-srv-vault-'));

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
      res.end(`self.webpackChunk = []; fetch("https://dev.mockcorp.io/api/v1/status"); const pr = "https://mockcorp-pr-77.vercel.app"; //# sourceMappingURL=app.js.map`);
      return;
    }
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('User-agent: *\n# Internal QA: https://qa.mockcorp.io\n');
      return;
    }
    if (req.url === '/protected-api') {
      const auth = req.headers['x-api-key'] || '';
      res.writeHead(auth === 'super-secret-api-key-1234' ? 200 : 401, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'session=should-be-stripped; HttpOnly'
      });
      res.end(JSON.stringify({ authorized: auth === 'super-secret-api-key-1234' }));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise((r) => mockSite.listen(0, '127.0.0.1', r));
  const mockPort = mockSite.address().port;

  const strictApp = createAppServer({ allowLocalTest: false, vaultDir: tmpVaultDir });
  await new Promise((r) => strictApp.listen(0, '127.0.0.1', r));
  const strictPort = strictApp.address().port;

  const testApp = createAppServer({ allowLocalTest: true, vaultDir: tmpVaultDir });
  await new Promise((r) => testApp.listen(0, '127.0.0.1', r));
  const testPort = testApp.address().port;

  try {
    // Health endpoint includes vaultReady: true
    const healthRes = await fetch(`http://127.0.0.1:${strictPort}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.vaultReady, true);

    // Static index.html includes DEVTRACER made by ★NDX★ and all 6 dashboard modules (and zero Temp Mail)
    const htmlRes = await fetch(`http://127.0.0.1:${strictPort}/`);
    assert.equal(htmlRes.status, 200);
    const htmlBody = await htmlRes.text();
    assert.ok(htmlBody.includes('DEVTRACER'));
    assert.ok(htmlBody.includes('NDX'));
    assert.ok(htmlBody.includes('★'));
    assert.ok(htmlBody.includes('Website Inspector'));
    assert.ok(htmlBody.includes('Domain Intelligence'));
    assert.ok(htmlBody.includes('Source Code Analyzer'));
    assert.ok(htmlBody.includes('API Inspector'));
    assert.ok(htmlBody.includes('API &amp; Token Vault'));
    assert.ok(htmlBody.includes('Scan History'));
    assert.equal(htmlBody.includes('Temp Mail'), false, 'Temp Mail tab must stay removed');

    // Validation checks on subdomain + DNS routes
    const badSubRes = await fetch(`http://127.0.0.1:${strictPort}/api/subdomains?domain=not_a_domain`);
    assert.equal(badSubRes.status, 400);
    const badDnsRes = await fetch(`http://127.0.0.1:${strictPort}/api/dns?domain=not_a_domain`);
    assert.equal(badDnsRes.status, 400);

    // SSRF rejection on /api/scan and /api/inspect-endpoint
    const ssrfRes = await fetch(`http://127.0.0.1:${strictPort}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}/` })
    });
    assert.equal(ssrfRes.status, 403);
    assert.equal((await ssrfRes.json()).code, 'SSRF_BLOCKED');

    const ssrfApiRes = await fetch(`http://127.0.0.1:${strictPort}/api/inspect-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/', method: 'GET' })
    });
    assert.equal(ssrfApiRes.status, 403);

    // Full deep crawl against mockSite
    const scanRes = await fetch(`http://127.0.0.1:${testPort}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}/`, maxBundles: 5, probeMeta: true })
    });
    assert.equal(scanRes.status, 200);
    const report = await scanRes.json();

    const devHosts = new Set(report.devSites.map((d) => d.host));
    assert.ok(devHosts.has('dev.mockcorp.io'));
    assert.ok(devHosts.has('mockcorp-pr-77.vercel.app'));
    assert.ok(devHosts.has('staging-edge.mockcorp.io'));
    assert.ok(devHosts.has('qa.mockcorp.io'));
    assert.ok(report.sourceIntel.apiEndpoints.some((e) => e.url.includes('/api/v1/status')));

    // Vault REST create -> server-side authorized /api/inspect-endpoint -> strip set-cookie -> revoke
    const createCredRes = await fetch(`http://127.0.0.1:${testPort}/api/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'MockCorp API Key',
        type: 'custom_api_key',
        headerName: 'X-API-Key',
        authScheme: 'raw',
        secret: 'super-secret-api-key-1234',
        baseUrl: `http://127.0.0.1:${mockPort}`
      })
    });
    assert.equal(createCredRes.status, 201);
    const { credential } = await createCredRes.json();
    assert.equal(JSON.stringify(credential).includes('super-secret-api-key-1234'), false);

    const authInspectRes = await fetch(`http://127.0.0.1:${testPort}/api/inspect-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `http://127.0.0.1:${mockPort}/protected-api`,
        method: 'GET',
        credentialId: credential.id
      })
    });
    assert.equal(authInspectRes.status, 200);
    const authInspect = await authInspectRes.json();
    assert.equal(authInspect.status, 200);
    assert.ok(authInspect.bodyPreview.includes('"authorized":true'));
    assert.equal('set-cookie' in authInspect.headers, false, 'must strip set-cookie from upstream responses');

    const revokeRes = await fetch(`http://127.0.0.1:${testPort}/api/credentials/${credential.id}/revoke`, {
      method: 'POST'
    });
    assert.equal(revokeRes.status, 200);
    assert.equal((await revokeRes.json()).credential.status, 'revoked');
  } finally {
    mockSite.close();
    strictApp.close();
    testApp.close();
    await fs.rm(tmpVaultDir, { recursive: true, force: true });
  }
});

test('subdomains & domainee helpers: root normalization, 7 environment categories, domainee parsing, and sorting', () => {
  assert.equal(normalizeRootDomain('https://www.GitHub.com/orgs/test'), 'github.com');
  assert.equal(normalizeRootDomain('api.staging.acme.co.uk'), 'acme.co.uk');
  assert.equal(normalizeRootDomain('invalid'), '');

  const domParsed = extractDomaineeHosts({
    ok: true,
    data: {
      domain: 'acme.io',
      counts: { total: 2 },
      subdomains: [
        { host: 'dev.acme.io', addresses: ['1.2.3.4'] },
        { host: 'beta.acme.io', addresses: ['5.6.7.8'] }
      ]
    }
  });
  assert.deepEqual(domParsed.hosts, ['dev.acme.io', 'beta.acme.io']);
  assert.deepEqual(domParsed.addressMap['dev.acme.io'], ['1.2.3.4']);

  const classified = classifySubdomainList('acme.io', [
    'www.acme.io',
    '*.dev.acme.io',
    'dev.acme.io',
    'staging-api.acme.io',
    'beta.acme.io',
    'preview-42.acme.io',
    'api.acme.io',
    'cdn.acme.io',
    'unrelated.other.org'
  ]);

  assert.equal(classified.counts.development, 1);
  assert.equal(classified.counts.staging, 1);
  assert.equal(classified.counts.beta, 1);
  assert.equal(classified.counts.preview, 1);
  assert.equal(classified.counts.api, 1);
  assert.equal(classified.counts.cdn, 1);
  assert.equal(classified.counts.production, 1);
  assert.equal(classified.counts.dev, 4);
  assert.equal(classified.rows.some((r) => r.host === 'unrelated.other.org'), false);

  sortRows(classified.rows, 'recent');
  assert.equal(classified.rows[0].host, 'www.acme.io');

  sortRows(classified.rows, 'alpha');
  assert.equal(classified.rows[0].host, 'api.acme.io');
});
