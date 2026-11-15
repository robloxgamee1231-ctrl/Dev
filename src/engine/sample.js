import { analyzeScan } from './analyzer.js';

export function buildSampleScan() {
  const headers = {
    server: 'Vercel',
    'x-vercel-id': 'iad1::k7x9p-1731702900-a91f3c',
    'x-vercel-cache': 'HIT',
    'x-powered-by': 'Next.js',
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy':
      "default-src 'self'; script-src 'self' https://js.stripe.com https://www.googletagmanager.com; connect-src 'self' https://api.northstarcloud.io https://api-staging.northstarcloud.io https://dev.northstarcloud.io wss://realtime.northstarcloud.io https://o45012.ingest.sentry.io https://us.i.posthog.com; img-src 'self' https://cdn.northstarcloud.io https://images.ctfassets.net"
  };

  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="next-head-count" content="14" />
  <title>Northstar Cloud — Edge Telemetry Platform</title>
  <link rel="manifest" href="/manifest.json" />
  <link rel="stylesheet" href="https://cdn.northstarcloud.io/_next/static/css/9e1c4a82f0.css" />
  <script src="https://js.stripe.com/v3/" defer></script>
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-NS8821X9"></script>
</head>
<body class="bg-slate-950 text-slate-100 flex items-center">
  <div id="__next" data-reactroot="" data-radix-portal="">
    <main class="px-6 py-12 grid-cols-3">
      <svg class="lucide lucide-radar"></svg>
    </main>
  </div>
  <script id="__NEXT_DATA__" type="application/json">
  {
    "buildId": "ns-2026-11-15-prod",
    "runtimeConfig": {
      "prodApi": "https://api.northstarcloud.io/v2",
      "stagingApi": "https://api-staging.northstarcloud.io/v2",
      "previewHost": "https://northstar-web-git-feat-billing-northstar.vercel.app",
      "docsOrigin": "https://docs.northstarcloud.io",
      "statusPage": "https://status.northstarcloud.io"
    }
  }
  </script>
  <script src="/_next/static/chunks/webpack-8c9a12d4.js" defer></script>
  <script src="/_next/static/chunks/main-app-4b71e2.js" defer></script>
</body>
</html>`;

  const mainBundleJs = `/* Northstar Cloud Client Bundle */
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([[421], {
  8102: function(__unused_webpack_module, __webpack_exports__, __webpack_require__) {
    const ENV = {
      NEXT_PUBLIC_API_URL: "https://api.northstarcloud.io/v2",
      NEXT_PUBLIC_DEV_API: "https://dev-api.northstarcloud.io/v2",
      NEXT_PUBLIC_QA_PORTAL: "https://qa.northstarcloud.io",
      NEXT_PUBLIC_SANDBOX_HOST: "https://sandbox.northstarcloud.io",
      NEXT_PUBLIC_PREVIEW_CF: "https://pr-418.northstar-docs.pages.dev",
      NEXT_PUBLIC_FALLBACK_LOCAL: "http://localhost:3001/api/trpc",
      NEXT_PUBLIC_CLERK_DEV: "https://pleased-falcon-42.clerk.accounts.dev",
      NEXT_PUBLIC_SUPABASE_URL: "https://xkjf9821northstar.supabase.co"
    };
    const React = { version: "19.0.0" };
    // Initialize Sentry & PostHog telemetry
    window.__SENTRY__ = { dsn: "https://a1b2c3@o45012.ingest.sentry.io/99182" };
    posthog.init("phc_northstar_live", { api_host: "https://us.i.posthog.com" });
    // Realtime socket & CDN assets
    const ws = new WebSocket("wss://realtime.northstarcloud.io/stream");
    const devTunnel = "https://northstar-dev-demo.trycloudflare.com/webhook";
    const netlifyLegacy = "https://deploy-preview-89--northstar-marketing.netlify.app";
    const stripeKey = "pk_live_northstar_001";
    const graphqlEndpoint = "https://graphql.northstarcloud.io/graphql";
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
  }
}]);
//# sourceMappingURL=main-app-4b71e2.js.map
`;

  const appCss = `/* Compiled Tailwind Stylesheet */
:root { --tw-border-spacing-x: 0; --tw-translate-x: 0; --tw-ring-offset-shadow: 0 0 #0000; }
@font-face { src: url("https://fonts.gstatic.com/s/inter/v18/inter.woff2"); }
.hero { background-image: url("https://images.ctfassets.net/ns81/hero-grid.webp"); }
`;

  const robotsTxt = `User-agent: *
Disallow: /admin
Disallow: /internal-preview
# Staging mirror: https://staging.northstarcloud.io
Sitemap: https://northstarcloud.io/sitemap.xml
`;

  const packageJson = JSON.stringify(
    {
      name: 'northstar-cloud-web',
      packageManager: 'pnpm@9.12.0',
      scripts: {
        dev: 'next dev --turbopack -p 3000',
        build: 'next build',
        'deploy:staging': 'vercel --env NEXT_PUBLIC_API_URL=https://api-staging.northstarcloud.io'
      },
      dependencies: {
        next: '^15.1.0',
        react: '^19.0.0',
        'react-dom': '^19.0.0',
        '@supabase/supabase-js': '^2.46.0',
        '@clerk/nextjs': '^6.2.0',
        '@trpc/client': '^11.0.0',
        '@tanstack/react-query': '^5.59.0',
        '@radix-ui/react-dialog': '^1.1.2',
        'framer-motion': '^11.11.0',
        'lucide-react': '^0.454.0',
        'posthog-js': '^1.178.0',
        '@sentry/nextjs': '^8.36.0',
        stripe: '^17.2.0',
        zustand: '^5.0.0'
      },
      devDependencies: {
        typescript: '^5.6.3',
        tailwindcss: '^3.4.14',
        postcss: '^8.4.47',
        vitest: '^2.1.4'
      }
    },
    null,
    2
  );

  return analyzeScan({
    target: 'https://northstarcloud.io',
    targetUrl: 'https://northstarcloud.io',
    mode: 'sample',
    transport: 'local',
    headers,
    repoFiles: ['next.config.mjs', 'tailwind.config.ts', 'tsconfig.json', 'pnpm-lock.yaml', 'vercel.json', '.github/workflows/deploy.yml'],
    artifacts: [
      { name: 'index.html', url: 'https://northstarcloud.io/', type: 'html', content: indexHtml },
      { name: '_next/static/chunks/main-app-4b71e2.js', url: 'https://northstarcloud.io/_next/static/chunks/main-app-4b71e2.js', type: 'js', content: mainBundleJs },
      { name: '_next/static/css/9e1c4a82f0.css', url: 'https://cdn.northstarcloud.io/_next/static/css/9e1c4a82f0.css', type: 'css', content: appCss },
      { name: 'robots.txt', url: 'https://northstarcloud.io/robots.txt', type: 'config', content: robotsTxt },
      { name: 'package.json', url: 'https://northstarcloud.io/package.json', type: 'json', content: packageJson }
    ],
    meta: {
      status: 200,
      finalUrl: 'https://northstarcloud.io/',
      note: 'Built-in multi-environment production fixture'
    }
  });
}
