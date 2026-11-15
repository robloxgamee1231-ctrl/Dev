// Comprehensive build stack & technology fingerprinting signatures (95+ technologies).

export const TECH_CATEGORIES = [
  'Meta-Framework',
  'UI Framework',
  'Bundler & Build',
  'Styling & UI',
  'CMS & Site Builder',
  'Hosting & Edge',
  'Language & Runtime',
  'Package & CI/CD',
  'Data, Auth & Payments',
  'Analytics & Monitoring',
  'Libraries & Graphics'
];

export const TECH_SIGNATURES = [
  // ===================== META-FRAMEWORKS =====================
  {
    id: 'nextjs',
    name: 'Next.js',
    category: 'Meta-Framework',
    color: '#ffffff',
    headers: { 'x-powered-by': /Next\.js/i, 'x-nextjs-cache': /.+/, 'x-nextjs-matched-path': /.+/ },
    html: [/__NEXT_DATA__/, /\/_next\/static\//, /next-route-announcer/, /<meta[^>]+name=["']next-head-count["']/i],
    js: [/self\.__next_f\b/, /__NEXT_P/, /next\/router/, /next\/navigation/],
    pkg: ['next'],
    files: [/^next\.config\.(?:js|mjs|cjs|ts)$/i],
    version: [/next["']?\s*[:@]\s*["']?([\d.]+)/i]
  },
  {
    id: 'nuxt',
    name: 'Nuxt',
    category: 'Meta-Framework',
    color: '#00dc82',
    headers: { 'x-powered-by': /Nuxt/i },
    html: [/__NUXT__/, /\/_nuxt\//, /id=["']__nuxt["']/, /<meta[^>]+name=["']generator["'][^>]+content=["']Nuxt/i],
    js: [/window\.__NUXT__/, /useNuxtApp/],
    pkg: ['nuxt', 'nuxt3'],
    files: [/^nuxt\.config\.(?:js|ts|mjs)$/i],
    version: [/content=["']Nuxt\s*([\d.]+)/i]
  },
  {
    id: 'astro',
    name: 'Astro',
    category: 'Meta-Framework',
    color: '#ff5d01',
    headers: { 'x-powered-by': /Astro/i },
    html: [/<astro-island\b/i, /data-astro-cid-/, /\/_astro\//, /<meta[^>]+name=["']generator["'][^>]+content=["']Astro\s*v?([\d.]+)?/i],
    js: [/astro:page-load/, /astro-island/],
    pkg: ['astro'],
    files: [/^astro\.config\.(?:js|mjs|cjs|ts)$/i],
    version: [/Astro\s*v?([\d.]+)/i]
  },
  {
    id: 'sveltekit',
    name: 'SvelteKit',
    category: 'Meta-Framework',
    color: '#ff3e00',
    html: [/data-sveltekit-/, /\/_app\/immutable\//, /__sveltekit_/],
    js: [/__sveltekit_/, /@sveltejs\/kit/],
    pkg: ['@sveltejs/kit'],
    files: [/^svelte\.config\.(?:js|mjs|cjs|ts)$/i]
  },
  {
    id: 'remix',
    name: 'Remix / React Router v7',
    category: 'Meta-Framework',
    color: '#3992ff',
    html: [/window\.__remixContext/, /window\.__reactRouterContext/, /__remixManifest/],
    js: [/__remixContext/, /@remix-run\/react/],
    pkg: ['@remix-run/react', '@remix-run/node', '@remix-run/cloudflare', '@react-router/dev'],
    files: [/^remix\.config\.(?:js|mjs|cjs|ts)$/i]
  },
  {
    id: 'gatsby',
    name: 'Gatsby',
    category: 'Meta-Framework',
    color: '#663399',
    html: [/id=["']___gatsby["']/, /<meta[^>]+name=["']generator["'][^>]+content=["']Gatsby\s*([\d.]+)?/i, /gatsby-focus-wrapper/],
    js: [/___gatsby/, /window\.___chunkMapping/],
    pkg: ['gatsby'],
    files: [/^gatsby-config\.(?:js|ts|mjs)$/i],
    version: [/Gatsby\s*([\d.]+)/i]
  },
  {
    id: 'angular',
    name: 'Angular',
    category: 'Meta-Framework',
    color: '#dd0031',
    html: [/\bng-version=["']([\d.]+)["']/i, /_ngcontent-/, /_nghost-/, /<app-root\b/i],
    js: [/@angular\/core/, /ngDevMode/],
    pkg: ['@angular/core'],
    files: [/^angular\.json$/i],
    version: [/ng-version=["']([\d.]+)["']/i]
  },
  {
    id: 'qwik',
    name: 'Qwik',
    category: 'Meta-Framework',
    color: '#ac7ef4',
    html: [/\bq:container=/, /\bq:version=["']([\d.]+)["']/, /qwikloader/i],
    pkg: ['@builder.io/qwik'],
    version: [/q:version=["']([\d.]+)["']/i]
  },
  {
    id: 'docusaurus',
    name: 'Docusaurus',
    category: 'Meta-Framework',
    color: '#25c2a0',
    html: [/<meta[^>]+name=["']generator["'][^>]+content=["']Docusaurus\s*v?([\d.]+)?/i, /docusaurus_skipToContent/],
    pkg: ['@docusaurus/core'],
    files: [/^docusaurus\.config\.(?:js|ts|mjs)$/i],
    version: [/Docusaurus\s*v?([\d.]+)/i]
  },
  {
    id: 'vitepress',
    name: 'VitePress',
    category: 'Meta-Framework',
    color: '#646cff',
    html: [/<meta[^>]+name=["']generator["'][^>]+content=["']VitePress\s*v?([\d.]+)?/i, /__VP_HASH_MAP__/],
    pkg: ['vitepress'],
    files: [/\.vitepress\/config\.(?:js|ts|mjs)$/i],
    version: [/VitePress\s*v?([\d.]+)/i]
  },

  // ===================== UI FRAMEWORKS =====================
  {
    id: 'react',
    name: 'React',
    category: 'UI Framework',
    color: '#61dafb',
    html: [/data-reactroot/, /data-reactid/, /__REACT_DEVTOOLS_GLOBAL_HOOK__/],
    js: [/react-dom/, /\$\$typeof:\s*Symbol\.for\(["']react\.element["']\)/, /react\.production\.min\.js/, /createRoot\(/, /__reactFiber\$/],
    pkg: ['react', 'react-dom'],
    version: [/react@([\d.]+)/i, /React\.version\s*=\s*["']([\d.]+)["']/]
  },
  {
    id: 'vue',
    name: 'Vue.js',
    category: 'UI Framework',
    color: '#42b883',
    html: [/\bdata-v-[a-f0-9]{6,10}\b/, /\bv-cloak\b/, /__VUE__/],
    js: [/__VUE_OPTIONS_API__/, /__VUE_PROD_DEVTOOLS__/, /createVNode/, /vue\.runtime/],
    pkg: ['vue'],
    version: [/vue@([\d.]+)/i]
  },
  {
    id: 'svelte',
    name: 'Svelte',
    category: 'UI Framework',
    color: '#ff3e00',
    html: [/\bclass=["'][^"']*\bsvelte-[a-z0-9]{5,10}\b/],
    js: [/svelte\/internal/, /SvelteComponent/],
    pkg: ['svelte'],
    files: [/^svelte\.config\.(?:js|mjs|ts)$/i]
  },
  {
    id: 'solidjs',
    name: 'SolidJS',
    category: 'UI Framework',
    color: '#2c4f7c',
    html: [/_\$HY\b/, /data-hk=/],
    js: [/solid-js\/web/, /_\$HY\.events/],
    pkg: ['solid-js']
  },
  {
    id: 'preact',
    name: 'Preact',
    category: 'UI Framework',
    color: '#673ab8',
    js: [/__PREACT_DEVTOOLS__/, /preact\/hooks/, /preact\/compat/],
    pkg: ['preact']
  },
  {
    id: 'lit',
    name: 'Lit / Web Components',
    category: 'UI Framework',
    color: '#324fff',
    html: [/<!--lit-part/, /<!--\?lit\$/],
    js: [/lit-html/, /lit-element/, /\$litElement\$/],
    pkg: ['lit', 'lit-html', 'lit-element']
  },
  {
    id: 'alpine',
    name: 'Alpine.js',
    category: 'UI Framework',
    color: '#77c1d2',
    html: [/\bx-data=["']/, /\bx-show=["']/, /alpinejs/i],
    js: [/Alpine\.start\(/, /x-data/],
    pkg: ['alpinejs']
  },
  {
    id: 'htmx',
    name: 'HTMX',
    category: 'UI Framework',
    color: '#3366cc',
    html: [/\bhx-(?:get|post|put|delete|swap|target)=["']/, /htmx\.min\.js/i],
    js: [/htmx\.config/],
    pkg: ['htmx.org']
  },
  {
    id: 'hotwire',
    name: 'Hotwire Turbo',
    category: 'UI Framework',
    color: '#ffe801',
    html: [/<turbo-frame\b/i, /data-turbo-track/, /data-controller=/],
    js: [/@hotwired\/turbo/, /Turbo\.session/],
    pkg: ['@hotwired/turbo', '@hotwired/stimulus']
  },
  {
    id: 'jquery',
    name: 'jQuery',
    category: 'UI Framework',
    color: '#0769ad',
    html: [/jquery[-.](?:min\.)?js/i, /jquery-(\d+\.\d+\.\d+)/i],
    js: [/jQuery\s+v?(\d+\.\d+\.\d+)/, /\bjQuery\.fn\.jquery\b/],
    pkg: ['jquery'],
    version: [/jquery[-/@v ](\d+\.\d+\.\d+)/i]
  },
  {
    id: 'ember',
    name: 'Ember.js',
    category: 'UI Framework',
    color: '#e04e39',
    html: [/class=["'][^"']*ember-application/, /<meta[^>]+name=["'][^"']*config\/environment["']/],
    pkg: ['ember-source']
  },

  // ===================== BUNDLERS & BUILD TOOLS =====================
  {
    id: 'vite',
    name: 'Vite',
    category: 'Bundler & Build',
    color: '#646cff',
    html: [/\/@vite\/client/, /\/assets\/index-[a-zA-Z0-9_-]{8}\.(?:js|css)/, /type=["']module["'][^>]+crossorigin[^>]+src=["']\/assets\//],
    js: [/import\.meta\.hot/, /__vite_preload/, /vite\/preload-helper/],
    pkg: ['vite'],
    files: [/^vite\.config\.(?:js|ts|mjs|cjs)$/i]
  },
  {
    id: 'webpack',
    name: 'Webpack',
    category: 'Bundler & Build',
    color: '#8dd6f9',
    js: [/webpackChunk/, /__webpack_require__/, /webpackJsonp/, /__webpack_modules__/],
    pkg: ['webpack', 'webpack-cli'],
    files: [/^webpack\.config\.(?:js|ts|mjs|cjs)$/i]
  },
  {
    id: 'turbopack',
    name: 'Turbopack',
    category: 'Bundler & Build',
    color: '#ff1e56',
    js: [/TURBOPACK/, /__turbopack_require__/],
    pkg: ['turbopack']
  },
  {
    id: 'turborepo',
    name: 'Turborepo',
    category: 'Bundler & Build',
    color: '#ef4444',
    pkg: ['turbo'],
    files: [/^turbo\.json$/i]
  },
  {
    id: 'rspack',
    name: 'Rspack / Rsbuild',
    category: 'Bundler & Build',
    color: '#f59e0b',
    js: [/__rspack_/],
    pkg: ['@rspack/core', '@rsbuild/core'],
    files: [/^rspack\.config\.(?:js|ts|mjs)$/i, /^rsbuild\.config\.(?:js|ts|mjs)$/i]
  },
  {
    id: 'rollup',
    name: 'Rollup',
    category: 'Bundler & Build',
    color: '#ff3333',
    pkg: ['rollup'],
    files: [/^rollup\.config\.(?:js|ts|mjs|cjs)$/i]
  },
  {
    id: 'esbuild',
    name: 'esbuild',
    category: 'Bundler & Build',
    color: '#ffcf00',
    js: [/var __defProp = Object\.defineProperty;\s*var __getOwnProp/],
    pkg: ['esbuild']
  },
  {
    id: 'parcel',
    name: 'Parcel',
    category: 'Bundler & Build',
    color: '#e7a76c',
    js: [/parcelRequire/],
    pkg: ['parcel'],
    files: [/^\.parcelrc$/i]
  },
  {
    id: 'swc',
    name: 'SWC',
    category: 'Bundler & Build',
    color: '#f97316',
    pkg: ['@swc/core', '@swc/cli'],
    files: [/^\.swcrc$/i]
  },
  {
    id: 'babel',
    name: 'Babel',
    category: 'Bundler & Build',
    color: '#f9dc3e',
    pkg: ['@babel/core'],
    files: [/^babel\.config\.(?:js|json|cjs|mjs)$/i, /^\.babelrc(?:\.json)?$/i]
  },
  {
    id: 'postcss',
    name: 'PostCSS',
    category: 'Bundler & Build',
    color: '#dd3a0a',
    pkg: ['postcss'],
    files: [/^postcss\.config\.(?:js|cjs|mjs|ts)$/i]
  },
  {
    id: 'nx',
    name: 'Nx Monorepo',
    category: 'Bundler & Build',
    color: '#143055',
    pkg: ['nx', '@nx/workspace'],
    files: [/^nx\.json$/i]
  },

  // ===================== STYLING & UI =====================
  {
    id: 'tailwind',
    name: 'Tailwind CSS',
    category: 'Styling & UI',
    color: '#38bdf8',
    html: [/tailwindcss/i, /class=["'][^"']*(?:\bflex\b[^"']*\bitems-center\b|\bgrid-cols-\d|\bpx-\d+\s+py-\d+|\btext-(?:slate|zinc|neutral|gray)-\d{3})/],
    css: [/--tw-border-spacing-x:/, /--tw-ring-offset-shadow:/, /--tw-translate-x:/, /@tailwind\s+base/],
    pkg: ['tailwindcss', '@tailwindcss/vite', '@tailwindcss/postcss'],
    files: [/^tailwind\.config\.(?:js|ts|mjs|cjs)$/i]
  },
  {
    id: 'bootstrap',
    name: 'Bootstrap',
    category: 'Styling & UI',
    color: '#7952b3',
    html: [/bootstrap(?:\.min)?\.(?:css|js)/i, /data-bs-toggle=/],
    css: [/--bs-blue:/, /Bootstrap\s+v([\d.]+)/i],
    pkg: ['bootstrap'],
    version: [/Bootstrap\s+v?([\d.]+)/i, /bootstrap@([\d.]+)/i]
  },
  {
    id: 'mui',
    name: 'Material UI (MUI)',
    category: 'Styling & UI',
    color: '#007fff',
    html: [/\bMuiButton-root\b/, /\bMuiBox-root\b/, /\bMuiTypography-root\b/, /data-emotion=["']css /],
    css: [/\.Mui[A-Z][a-zA-Z]+-root/],
    pkg: ['@mui/material', '@material-ui/core']
  },
  {
    id: 'chakra',
    name: 'Chakra UI',
    category: 'Styling & UI',
    color: '#319795',
    html: [/\bchakra-ui-/, /class=["'][^"']*\bchakra-(?:button|stack|text|heading)\b/],
    css: [/--chakra-colors-/],
    pkg: ['@chakra-ui/react']
  },
  {
    id: 'antd',
    name: 'Ant Design',
    category: 'Styling & UI',
    color: '#1677ff',
    html: [/\bant-btn\b/, /\bant-layout\b/, /\bant-row\b/],
    css: [/\.ant-btn\b/],
    pkg: ['antd']
  },
  {
    id: 'radix',
    name: 'Radix UI',
    category: 'Styling & UI',
    color: '#e2e8f0',
    html: [/data-radix-/, /radix-themes/],
    js: [/@radix-ui\//],
    pkg: ['@radix-ui/react-dialog', '@radix-ui/react-slot', '@radix-ui/themes']
  },
  {
    id: 'shadcn',
    name: 'shadcn/ui',
    category: 'Styling & UI',
    color: '#fafafa',
    files: [/^components\.json$/i],
    pkg: ['class-variance-authority', 'tailwind-merge']
  },
  {
    id: 'styled-components',
    name: 'styled-components',
    category: 'Styling & UI',
    color: '#db7093',
    html: [/data-styled=["']active["']/, /data-styled-version=["']([\d.]+)["']/],
    pkg: ['styled-components'],
    version: [/data-styled-version=["']([\d.]+)["']/]
  },
  {
    id: 'emotion',
    name: 'Emotion CSS',
    category: 'Styling & UI',
    color: '#d36ac2',
    html: [/<style[^>]+data-emotion=/i],
    pkg: ['@emotion/react', '@emotion/styled']
  },
  {
    id: 'sass',
    name: 'Sass / SCSS',
    category: 'Styling & UI',
    color: '#cc6699',
    pkg: ['sass', 'node-sass'],
    files: [/\.scss$/i]
  },
  {
    id: 'unocss',
    name: 'UnoCSS',
    category: 'Styling & UI',
    color: '#94a3b8',
    css: [/--un-translate-x:/],
    pkg: ['unocss'],
    files: [/^uno\.config\.(?:js|ts|mjs)$/i]
  },
  {
    id: 'fontawesome',
    name: 'Font Awesome',
    category: 'Styling & UI',
    color: '#528dd7',
    html: [/font-?awesome/i, /\bfa-(?:solid|regular|brands)\s+fa-/],
    domains: ['use.fontawesome.com', 'kit.fontawesome.com'],
    pkg: ['@fortawesome/fontawesome-svg-core']
  },
  {
    id: 'lucide',
    name: 'Lucide Icons',
    category: 'Styling & UI',
    color: '#f56565',
    html: [/class=["'][^"']*\blucide\s+lucide-/],
    pkg: ['lucide', 'lucide-react', 'lucide-vue-next', 'lucide-svelte']
  },

  // ===================== CMS & SITE BUILDERS =====================
  {
    id: 'wordpress',
    name: 'WordPress',
    category: 'CMS & Site Builder',
    color: '#21759b',
    headers: { 'x-powered-by': /WordPress/i, link: /api\.w\.org/i },
    html: [/\/wp-content\//, /\/wp-includes\//, /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s*([\d.]+)?/i],
    version: [/WordPress\s*([\d.]+)/i]
  },
  {
    id: 'shopify',
    name: 'Shopify',
    category: 'CMS & Site Builder',
    color: '#96bf48',
    headers: { 'x-shopify-stage': /.+/, 'x-shopid': /.+/, powered: /Shopify/i },
    html: [/Shopify\.theme\b/, /cdn\.shopify\.com/, /shopify-section/],
    domains: ['cdn.shopify.com', 'myshopify.com']
  },
  {
    id: 'webflow',
    name: 'Webflow',
    category: 'CMS & Site Builder',
    color: '#4353ff',
    html: [/data-wf-site=/, /data-wf-page=/, /<meta[^>]+content=["']Webflow["'][^>]+name=["']generator["']/i, /website-files\.com/],
    domains: ['webflow.io', 'assets.website-files.com']
  },
  {
    id: 'framer',
    name: 'Framer',
    category: 'CMS & Site Builder',
    color: '#0055ff',
    html: [/framerusercontent\.com/, /<meta[^>]+name=["']generator["'][^>]+content=["']Framer/i, /data-framer-hydrate/],
    domains: ['framerusercontent.com', 'framer.website']
  },
  {
    id: 'wix',
    name: 'Wix',
    category: 'CMS & Site Builder',
    color: '#faad4d',
    headers: { 'x-wix-request-id': /.+/ },
    html: [/static\.wixstatic\.com/, /<meta[^>]+name=["']generator["'][^>]+content=["']Wix\.com/i],
    domains: ['wixstatic.com', 'wixsite.com']
  },
  {
    id: 'squarespace',
    name: 'Squarespace',
    category: 'CMS & Site Builder',
    color: '#e5e7eb',
    headers: { server: /Squarespace/i },
    html: [/static\d*\.squarespace\.com/, /<!-- This is Squarespace\. -->/],
    domains: ['squarespace.com', 'sqspcdn.com']
  },
  {
    id: 'ghost',
    name: 'Ghost CMS',
    category: 'CMS & Site Builder',
    color: '#15171a',
    headers: { 'x-powered-by': /Ghost/i },
    html: [/<meta[^>]+name=["']generator["'][^>]+content=["']Ghost\s*([\d.]+)?/i, /\/ghost\/api\//],
    version: [/Ghost\s*([\d.]+)/i]
  },
  {
    id: 'drupal',
    name: 'Drupal',
    category: 'CMS & Site Builder',
    color: '#0678be',
    headers: { 'x-generator': /Drupal/i, 'x-drupal-cache': /.+/ },
    html: [/<meta[^>]+name=["']Generator["'][^>]+content=["']Drupal\s*([\d.]+)?/i, /\/sites\/default\/files\//],
    version: [/Drupal\s*([\d.]+)/i]
  },
  {
    id: 'hugo',
    name: 'Hugo',
    category: 'CMS & Site Builder',
    color: '#ff4088',
    html: [/<meta[^>]+name=["']generator["'][^>]+content=["']Hugo\s*([\d.]+)?/i],
    files: [/^hugo\.(?:toml|yaml|yml|json)$/i],
    version: [/Hugo\s*([\d.]+)/i]
  },
  {
    id: 'jekyll',
    name: 'Jekyll',
    category: 'CMS & Site Builder',
    color: '#cc0000',
    html: [/<meta[^>]+name=["']generator["'][^>]+content=["']Jekyll\s*v?([\d.]+)?/i],
    files: [/^_config\.yml$/i],
    version: [/Jekyll\s*v?([\d.]+)/i]
  },
  {
    id: 'eleventy',
    name: 'Eleventy (11ty)',
    category: 'CMS & Site Builder',
    color: '#cbd5e1',
    html: [/<meta[^>]+name=["']generator["'][^>]+content=["']Eleventy\s*v?([\d.]+)?/i],
    pkg: ['@11ty/eleventy'],
    files: [/^\.eleventy\.js$/i, /^eleventy\.config\.(?:js|mjs|cjs)$/i],
    version: [/Eleventy\s*v?([\d.]+)/i]
  },
  {
    id: 'contentful',
    name: 'Contentful',
    category: 'CMS & Site Builder',
    color: '#2478cc',
    html: [/images\.ctfassets\.net/],
    domains: ['ctfassets.net', 'contentful.com'],
    pkg: ['contentful']
  },
  {
    id: 'sanity',
    name: 'Sanity CMS',
    category: 'CMS & Site Builder',
    color: '#f03e2f',
    html: [/cdn\.sanity\.io/],
    domains: ['sanity.io', 'apicdn.sanity.io'],
    pkg: ['sanity', '@sanity/client'],
    files: [/^sanity\.config\.(?:js|ts)$/i]
  },
  {
    id: 'strapi',
    name: 'Strapi CMS',
    category: 'CMS & Site Builder',
    color: '#4945ff',
    headers: { 'x-powered-by': /Strapi/i },
    pkg: ['@strapi/strapi']
  },

  // ===================== HOSTING, EDGE & CDN =====================
  {
    id: 'vercel',
    name: 'Vercel',
    category: 'Hosting & Edge',
    color: '#ffffff',
    headers: { server: /^Vercel/i, 'x-vercel-id': /.+/, 'x-vercel-cache': /.+/ },
    domains: ['vercel.app', 'vercel-insights.com', 'vercel-scripts.com'],
    files: [/^vercel\.json$/i]
  },
  {
    id: 'netlify',
    name: 'Netlify',
    category: 'Hosting & Edge',
    color: '#00c7b7',
    headers: { server: /Netlify/i, 'x-nf-request-id': /.+/ },
    domains: ['netlify.app', 'netlify.com'],
    files: [/^netlify\.toml$/i]
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare / Pages / Workers',
    category: 'Hosting & Edge',
    color: '#f38020',
    headers: { server: /cloudflare/i, 'cf-ray': /.+/, 'cf-cache-status': /.+/ },
    domains: ['pages.dev', 'workers.dev', 'cloudflareinsights.com', 'challenges.cloudflare.com'],
    files: [/^wrangler\.(?:toml|json|jsonc)$/i]
  },
  {
    id: 'github-pages',
    name: 'GitHub Pages / GitHub',
    category: 'Hosting & Edge',
    color: '#f0f6fc',
    headers: { server: /GitHub\.com/i, 'x-github-request-id': /.+/ },
    domains: ['github.io', 'githubassets.com'],
    files: [/^CNAME$/i]
  },
  {
    id: 'aws-cloudfront',
    name: 'AWS CloudFront / S3',
    category: 'Hosting & Edge',
    color: '#ff9900',
    headers: { server: /AmazonS3|CloudFront/i, 'x-amz-cf-id': /.+/, 'x-amz-cf-pop': /.+/, via: /CloudFront/i },
    domains: ['cloudfront.net', 's3.amazonaws.com', 'amplifyapp.com']
  },
  {
    id: 'fastly',
    name: 'Fastly CDN',
    category: 'Hosting & Edge',
    color: '#ff282d',
    headers: { 'x-fastly-request-id': /.+/, 'x-served-by': /cache-/i, via: /varnish/i },
    domains: ['fastly.net']
  },
  {
    id: 'akamai',
    name: 'Akamai Edge',
    category: 'Hosting & Edge',
    color: '#009bde',
    headers: { server: /AkamaiGHost/i, 'x-akamai-transformed': /.+/ },
    domains: ['akamaihd.net', 'akamaized.net', 'edgekey.net']
  },
  {
    id: 'firebase-hosting',
    name: 'Firebase / Google Cloud',
    category: 'Hosting & Edge',
    color: '#ffca28',
    headers: { server: /Google Frontend|gws|ESF/i },
    domains: ['web.app', 'firebaseapp.com', 'firebaseio.com', 'run.app'],
    files: [/^firebase\.json$/i]
  },
  {
    id: 'flyio',
    name: 'Fly.io',
    category: 'Hosting & Edge',
    color: '#7c3aed',
    headers: { server: /Fly\//i, 'fly-request-id': /.+/ },
    domains: ['fly.dev'],
    files: [/^fly\.toml$/i]
  },
  {
    id: 'render',
    name: 'Render',
    category: 'Hosting & Edge',
    color: '#46e3b7',
    headers: { 'x-render-origin-server': /.+/ },
    domains: ['onrender.com'],
    files: [/^render\.yaml$/i]
  },
  {
    id: 'railway',
    name: 'Railway',
    category: 'Hosting & Edge',
    color: '#c084fc',
    headers: { server: /railway/i },
    domains: ['railway.app'],
    files: [/^railway\.(?:json|toml)$/i]
  },
  {
    id: 'nginx',
    name: 'Nginx',
    category: 'Hosting & Edge',
    color: '#009639',
    headers: { server: /nginx(?:\/([\d.]+))?/i },
    version: [/nginx\/([\d.]+)/i]
  },
  {
    id: 'apache',
    name: 'Apache HTTP Server',
    category: 'Hosting & Edge',
    color: '#d22128',
    headers: { server: /Apache(?:\/([\d.]+))?/i },
    version: [/Apache\/([\d.]+)/i]
  },
  {
    id: 'caddy',
    name: 'Caddy',
    category: 'Hosting & Edge',
    color: '#22c55e',
    headers: { server: /^Caddy/i },
    files: [/^Caddyfile$/i]
  },

  // ===================== LANGUAGES & RUNTIMES =====================
  {
    id: 'typescript',
    name: 'TypeScript',
    category: 'Language & Runtime',
    color: '#3178c6',
    pkg: ['typescript'],
    files: [/^tsconfig(?:\.[a-z]+)?\.json$/i, /\.tsx?$/i]
  },
  {
    id: 'wasm',
    name: 'WebAssembly (WASM)',
    category: 'Language & Runtime',
    color: '#654ff0',
    html: [/\.wasm\b/],
    js: [/WebAssembly\.instantiate/, /\.wasm["'`]/]
  },
  {
    id: 'nodejs',
    name: 'Node.js / Express',
    category: 'Language & Runtime',
    color: '#339933',
    headers: { 'x-powered-by': /Express/i },
    pkg: ['express', 'fastify', 'koa', 'hono', '@nestjs/core'],
    files: [/^package\.json$/i]
  },
  {
    id: 'bun',
    name: 'Bun',
    category: 'Language & Runtime',
    color: '#fbf0df',
    files: [/^bun\.lockb?$/i, /^bunfig\.toml$/i]
  },
  {
    id: 'deno',
    name: 'Deno',
    category: 'Language & Runtime',
    color: '#70ffaf',
    domains: ['deno.dev', 'deno.land'],
    files: [/^deno\.jsonc?$/i]
  },
  {
    id: 'python',
    name: 'Python (Django / FastAPI / Flask)',
    category: 'Language & Runtime',
    color: '#3776ab',
    headers: { server: /uvicorn|gunicorn|Werkzeug|WSGIServer/i },
    html: [/csrfmiddlewaretoken/],
    files: [/^pyproject\.toml$/i, /^requirements\.txt$/i, /^manage\.py$/i]
  },
  {
    id: 'rails',
    name: 'Ruby on Rails',
    category: 'Language & Runtime',
    color: '#cc0000',
    headers: { 'x-powered-by': /Phusion Passenger/i, 'x-runtime': /^0\.\d+/ },
    html: [/<meta[^>]+name=["']csrf-param["'][^>]+content=["']authenticity_token["']/i],
    files: [/^Gemfile$/i]
  },
  {
    id: 'php',
    name: 'PHP / Laravel',
    category: 'Language & Runtime',
    color: '#777bb4',
    headers: { 'x-powered-by': /PHP(?:\/([\d.]+))?/i, 'set-cookie': /laravel_session|PHPSESSID/i },
    files: [/^composer\.json$/i, /^artisan$/i],
    version: [/PHP\/([\d.]+)/i]
  },
  {
    id: 'rust',
    name: 'Rust',
    category: 'Language & Runtime',
    color: '#dea584',
    files: [/^Cargo\.toml$/i]
  },
  {
    id: 'go',
    name: 'Go',
    category: 'Language & Runtime',
    color: '#00add8',
    files: [/^go\.mod$/i]
  },

  // ===================== PACKAGE MANAGERS & CI/CD =====================
  {
    id: 'pnpm',
    name: 'pnpm',
    category: 'Package & CI/CD',
    color: '#f69220',
    files: [/^pnpm-lock\.yaml$/i, /^pnpm-workspace\.yaml$/i]
  },
  {
    id: 'yarn',
    name: 'Yarn',
    category: 'Package & CI/CD',
    color: '#2c8ebb',
    files: [/^yarn\.lock$/i, /^\.yarnrc\.yml$/i]
  },
  {
    id: 'npm',
    name: 'npm',
    category: 'Package & CI/CD',
    color: '#cb3837',
    files: [/^package-lock\.json$/i]
  },
  {
    id: 'github-actions',
    name: 'GitHub Actions',
    category: 'Package & CI/CD',
    color: '#2088ff',
    files: [/^\.github\/workflows\/.+\.ya?ml$/i]
  },
  {
    id: 'docker',
    name: 'Docker',
    category: 'Package & CI/CD',
    color: '#2496ed',
    files: [/^Dockerfile(?:\..+)?$/i, /^docker-compose\.ya?ml$/i, /^compose\.ya?ml$/i]
  },

  // ===================== DATA, AUTH & PAYMENTS =====================
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'Data, Auth & Payments',
    color: '#3ecf8e',
    js: [/supabase\.co/, /@supabase\/supabase-js/],
    domains: ['supabase.co', 'supabase.in'],
    pkg: ['@supabase/supabase-js', '@supabase/ssr']
  },
  {
    id: 'firebase',
    name: 'Firebase SDK',
    category: 'Data, Auth & Payments',
    color: '#ffca28',
    js: [/firebaseapp\.com/, /initializeApp\(/, /firestore\.googleapis\.com/],
    domains: ['firebaseio.com', 'firestore.googleapis.com'],
    pkg: ['firebase', 'firebase-admin']
  },
  {
    id: 'clerk',
    name: 'Clerk Auth',
    category: 'Data, Auth & Payments',
    color: '#6c47ff',
    html: [/clerk\.browser\.js/, /clerk-publishable-key/],
    domains: ['clerk.com', 'clerk.accounts.dev'],
    pkg: ['@clerk/nextjs', '@clerk/clerk-react', '@clerk/clerk-js']
  },
  {
    id: 'auth0',
    name: 'Auth0',
    category: 'Data, Auth & Payments',
    color: '#eb5424',
    domains: ['auth0.com'],
    pkg: ['@auth0/auth0-react', '@auth0/nextjs-auth0']
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Data, Auth & Payments',
    color: '#635bff',
    html: [/js\.stripe\.com/],
    js: [/js\.stripe\.com\/v3/, /pk_(?:live|test)_[a-zA-Z0-9]+/],
    domains: ['stripe.com', 'js.stripe.com'],
    pkg: ['stripe', '@stripe/stripe-js']
  },
  {
    id: 'graphql',
    name: 'GraphQL / Apollo',
    category: 'Data, Auth & Payments',
    color: '#e10098',
    js: [/__APOLLO_STATE__/, /ApolloClient/, /\/graphql\b/],
    pkg: ['graphql', '@apollo/client', 'urql']
  },
  {
    id: 'trpc',
    name: 'tRPC',
    category: 'Data, Auth & Payments',
    color: '#398ccb',
    js: [/\/api\/trpc/],
    pkg: ['@trpc/client', '@trpc/server', '@trpc/react-query']
  },
  {
    id: 'prisma',
    name: 'Prisma ORM',
    category: 'Data, Auth & Payments',
    color: '#5a67d8',
    pkg: ['prisma', '@prisma/client'],
    files: [/prisma\/schema\.prisma$/i]
  },
  {
    id: 'drizzle',
    name: 'Drizzle ORM',
    category: 'Data, Auth & Payments',
    color: '#c5f74f',
    pkg: ['drizzle-orm'],
    files: [/^drizzle\.config\.(?:ts|js)$/i]
  },
  {
    id: 'algolia',
    name: 'Algolia Search',
    category: 'Data, Auth & Payments',
    color: '#003dff',
    domains: ['algolia.net', 'algolianet.com'],
    pkg: ['algoliasearch', '@docsearch/react']
  },

  // ===================== ANALYTICS & MONITORING =====================
  {
    id: 'ga4',
    name: 'Google Analytics',
    category: 'Analytics & Monitoring',
    color: '#e37400',
    html: [/gtag\(['"]config['"],\s*['"]G-[A-Z0-9]+['"]/, /google-analytics\.com\/(?:analytics|g\/collect)/],
    domains: ['google-analytics.com', 'analytics.google.com']
  },
  {
    id: 'gtm',
    name: 'Google Tag Manager',
    category: 'Analytics & Monitoring',
    color: '#4285f4',
    html: [/googletagmanager\.com\/gtm\.js/, /GTM-[A-Z0-9]{5,}/],
    domains: ['googletagmanager.com']
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'Analytics & Monitoring',
    color: '#6c5fc7',
    html: [/browser\.sentry-cdn\.com/],
    js: [/__SENTRY__/, /ingest\.sentry\.io/, /Sentry\.init\(/],
    domains: ['sentry.io', 'ingest.sentry.io'],
    pkg: ['@sentry/browser', '@sentry/nextjs', '@sentry/react']
  },
  {
    id: 'posthog',
    name: 'PostHog',
    category: 'Analytics & Monitoring',
    color: '#f9bd2b',
    js: [/posthog\.init\(/, /app\.posthog\.com/, /us\.i\.posthog\.com/],
    domains: ['posthog.com'],
    pkg: ['posthog-js']
  },
  {
    id: 'datadog',
    name: 'Datadog RUM',
    category: 'Analytics & Monitoring',
    color: '#632ca6',
    js: [/DD_RUM/, /datadog-rum/],
    domains: ['datadoghq.com', 'browser-intake-datadoghq.com'],
    pkg: ['@datadog/browser-rum']
  },
  {
    id: 'plausible',
    name: 'Plausible Analytics',
    category: 'Analytics & Monitoring',
    color: '#5850ec',
    html: [/plausible\.io\/js\/script/],
    domains: ['plausible.io']
  },
  {
    id: 'segment',
    name: 'Segment',
    category: 'Analytics & Monitoring',
    color: '#52bd95',
    js: [/cdn\.segment\.com\/analytics\.js/],
    domains: ['segment.io', 'segment.com']
  },
  {
    id: 'mixpanel',
    name: 'Mixpanel',
    category: 'Analytics & Monitoring',
    color: '#7856ff',
    domains: ['mixpanel.com'],
    pkg: ['mixpanel-browser']
  },
  {
    id: 'clarity',
    name: 'Microsoft Clarity',
    category: 'Analytics & Monitoring',
    color: '#00a4ef',
    html: [/clarity\.ms\/tag\//],
    domains: ['clarity.ms']
  },
  {
    id: 'hotjar',
    name: 'Hotjar',
    category: 'Analytics & Monitoring',
    color: '#fd3a5c',
    html: [/static\.hotjar\.com/],
    domains: ['hotjar.com']
  },
  {
    id: 'intercom',
    name: 'Intercom',
    category: 'Analytics & Monitoring',
    color: '#286efa',
    html: [/widget\.intercom\.io/],
    domains: ['intercom.io', 'intercomcdn.com']
  },
  {
    id: 'launchdarkly',
    name: 'LaunchDarkly',
    category: 'Analytics & Monitoring',
    color: '#405bff',
    domains: ['launchdarkly.com'],
    pkg: ['launchdarkly-js-client-sdk']
  },

  // ===================== LIBRARIES & GRAPHICS =====================
  {
    id: 'threejs',
    name: 'Three.js / WebGL',
    category: 'Libraries & Graphics',
    color: '#ffffff',
    js: [/THREE\.WebGLRenderer/, /__THREE__/],
    pkg: ['three', '@react-three/fiber']
  },
  {
    id: 'gsap',
    name: 'GSAP Animation',
    category: 'Libraries & Graphics',
    color: '#88ce02',
    js: [/GreenSockGlobals/, /gsap\.registerPlugin/],
    pkg: ['gsap']
  },
  {
    id: 'framer-motion',
    name: 'Motion / Framer Motion',
    category: 'Libraries & Graphics',
    color: '#bb4b96',
    js: [/framer-motion/, /data-projection-id/],
    pkg: ['framer-motion', 'motion']
  },
  {
    id: 'tanstack-query',
    name: 'TanStack Query',
    category: 'Libraries & Graphics',
    color: '#ff4154',
    pkg: ['@tanstack/react-query', '@tanstack/vue-query', 'react-query']
  },
  {
    id: 'redux',
    name: 'Redux',
    category: 'Libraries & Graphics',
    color: '#764abc',
    js: [/__REDUX_DEVTOOLS_EXTENSION__/],
    pkg: ['redux', '@reduxjs/toolkit', 'react-redux']
  },
  {
    id: 'zustand',
    name: 'Zustand',
    category: 'Libraries & Graphics',
    color: '#d97706',
    pkg: ['zustand']
  },
  {
    id: 'd3',
    name: 'D3.js',
    category: 'Libraries & Graphics',
    color: '#f9a03c',
    js: [/d3\.selectAll\(/, /d3-scale/],
    pkg: ['d3']
  },
  {
    id: 'chartjs',
    name: 'Chart.js',
    category: 'Libraries & Graphics',
    color: '#ff6384',
    pkg: ['chart.js']
  },
  {
    id: 'mapbox',
    name: 'Mapbox GL',
    category: 'Libraries & Graphics',
    color: '#4264fb',
    html: [/api\.mapbox\.com/],
    domains: ['mapbox.com'],
    pkg: ['mapbox-gl']
  },
  {
    id: 'socketio',
    name: 'Socket.IO',
    category: 'Libraries & Graphics',
    color: '#e2e8f0',
    js: [/\/socket\.io\//, /io\.Socket/],
    pkg: ['socket.io', 'socket.io-client']
  },
  {
    id: 'playwright-vitest',
    name: 'Vitest / Jest / Playwright',
    category: 'Package & CI/CD',
    color: '#729b1b',
    pkg: ['vitest', 'jest', '@playwright/test', 'cypress'],
    files: [/^vitest\.config\.(?:ts|js|mjs)$/i, /^playwright\.config\.(?:ts|js)$/i, /^jest\.config\.(?:js|ts|cjs|mjs)$/i]
  }
];
