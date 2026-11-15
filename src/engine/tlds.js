// Domain validation, eTLD+1 extraction, and code-noise filtering.

export const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz',
  'co.jp', 'ne.jp', 'or.jp', 'go.jp', 'ac.jp',
  'co.kr', 'or.kr', 'go.kr', 'ne.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk',
  'com.tw', 'org.tw', 'net.tw', 'edu.tw',
  'com.sg', 'org.sg', 'net.sg', 'edu.sg', 'gov.sg',
  'com.br', 'org.br', 'net.br', 'gov.br', 'edu.br',
  'com.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'com.ar', 'org.ar', 'gob.ar',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'firm.in',
  'co.za', 'org.za', 'gov.za', 'ac.za',
  'co.il', 'org.il', 'ac.il', 'gov.il',
  'com.tr', 'org.tr', 'net.tr', 'gov.tr',
  'com.pl', 'net.pl', 'org.pl',
  'com.ua', 'org.ua', 'net.ua',
  'com.my', 'org.my', 'net.my', 'gov.my',
  'co.id', 'or.id', 'ac.id', 'go.id',
  'co.th', 'or.th', 'ac.th', 'go.th',
  'com.vn', 'org.vn', 'net.vn', 'gov.vn',
  'com.ph', 'org.ph', 'net.ph', 'gov.ph',
  'com.eg', 'org.eg', 'gov.eg',
  'com.sa', 'org.sa', 'gov.sa',
  'co.ke', 'or.ke', 'go.ke',
  'com.ng', 'org.ng', 'gov.ng',
  'com.co', 'org.co', 'gov.co',
  'com.pe', 'org.pe', 'gob.pe',
  'com.ve', 'org.ve',
  'com.pk', 'org.pk', 'gov.pk',
  'com.bd', 'org.bd', 'gov.bd',
  // Hosting & platform multi-part roots
  'github.io', 'gitlab.io', 'bitbucket.io',
  'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev',
  'herokuapp.com', 'onrender.com', 'fly.dev', 'railway.app',
  'web.app', 'firebaseapp.com', 'appspot.com', 'run.app', 'cloudfunctions.net',
  'amplifyapp.com', 'cloudfront.net', 'amazonaws.com',
  'azurestaticapps.net', 'azurewebsites.net',
  'surge.sh', 'deno.dev', 'glitch.me', 'repl.co', 'replit.dev',
  'stackblitz.io', 'codesandbox.io', 'csb.app',
  'ngrok.io', 'ngrok-free.app', 'trycloudflare.com',
  'myshopify.com', 'webflow.io', 'framer.website', 'wixsite.com',
  'pantheonsite.io', 'wpengine.com', 'kinsta.cloud', 'now.sh'
]);

export const INTERNAL_DEV_TLDS = new Set([
  'local', 'localhost', 'internal', 'intranet', 'corp', 'lan', 'home', 'arpa', 'test', 'example', 'invalid', 'localdomain', 'docker', 'svc', 'cluster'
]);

export const VALID_TLDS = new Set([
  // Common gTLDs & modern web TLDs
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name', 'pro', 'mobi', 'tel', 'jobs', 'travel', 'aero', 'coop', 'museum', 'asia', 'cat', 'post', 'xxx',
  'io', 'dev', 'app', 'ai', 'co', 'me', 'tv', 'gg', 'sh', 'fm', 'am', 'im', 'ly', 'to', 'cc', 'ws', 'bz', 'nu', 'vc', 'la', 'so', 'st', 'cx', 'gs', 'ms', 'tc', 'vg', 'ac', 'ag', 'sc', 'sx',
  'cloud', 'tech', 'site', 'online', 'store', 'shop', 'blog', 'news', 'media', 'digital', 'agency', 'studio', 'design', 'works', 'tools', 'systems', 'solutions', 'services', 'network', 'software', 'codes', 'code', 'build', 'run', 'page', 'pages', 'web', 'website', 'space', 'zone', 'world', 'global', 'earth', 'live', 'stream', 'video', 'audio', 'music', 'games', 'game', 'play', 'fun', 'wtf', 'xyz', 'top', 'vip', 'pro', 'club', 'team', 'group', 'company', 'inc', 'llc', 'ltd', 'corp', 'enterprises', 'ventures', 'capital', 'finance', 'fund', 'money', 'bank', 'pay', 'cash', 'exchange', 'market', 'trade', 'deals', 'sale', 'promo', 'email', 'chat', 'social', 'community', 'forum', 'wiki', 'docs', 'guide', 'help', 'support', 'care', 'health', 'bio', 'life', 'fit', 'art', 'gallery', 'photo', 'photos', 'pics', 'press', 'pub', 'ink', 'today', 'now', 'one', 'plus', 'link', 'click', 'host', 'hosting', 'domains', 'email', 'id', 'box', 'bot', 'new', 'foo', 'bar', 'zip', 'mov', 'nexus', 'dad', 'phd', 'prof', 'esq', 'ing', 'meme', 'rsvp', 'channel', 'day', 'how', 'soy', 'boo', 'map', 'search', 'secure', 'trust', 'safety', 'security', 'shield', 'watch', 'report', 'review', 'reviews', 'foundation', 'institute', 'academy', 'school', 'college', 'university', 'courses', 'training', 'events', 'show', 'stage', 'center', 'city', 'town', 'place', 'house', 'home', 'land', 'estate', 'rentals', 'apartments', 'property', 'build', 'builders', 'construction', 'engineering', 'energy', 'solar', 'green', 'eco', 'earth', 'farm', 'food', 'coffee', 'cafe', 'bar', 'pub', 'pizza', 'restaurant', 'kitchen', 'recipes', 'wine', 'beer', 'fashion', 'style', 'shoes', 'watch', 'jewelry', 'luxury', 'boutique', 'beauty', 'hair', 'skin', 'care', 'dental', 'clinic', 'hospital', 'doctor', 'md', 'vet', 'pet', 'dog', 'cat', 'auto', 'car', 'cars', 'bike', 'boats', 'flights', 'tours', 'vacations', 'holiday', 'hotel', 'hotels', 'travel', 'cruises', 'camp', 'surf', 'ski', 'golf', 'soccer', 'football', 'tennis', 'hockey', 'baseball', 'basketball', 'racing', 'fitness', 'yoga', 'dance', 'film', 'movie', 'theater', 'tickets', 'concert', 'band', 'audio', 'radio', 'podcast', 'books', 'read', 'author', 'write', 'law', 'legal', 'attorney', 'lawyer', 'tax', 'accountant', 'consulting', 'management', 'marketing', 'ads', 'seo', 'analytics', 'data', 'ai', 'ml', 'bot', 'api', 'cdn', 'dns', 'vpn', 'ssl', 'tls', 'pk', 'rs', 'rocks', 'ninja', 'guru', 'expert', 'cool', 'awesome', 'best', 'gold', 'star', 'red', 'blue', 'black', 'pink', 'green', 'white',
  // Country-code TLDs
  'uk', 'us', 'ca', 'de', 'fr', 'es', 'it', 'nl', 'be', 'ch', 'at', 'se', 'no', 'dk', 'fi', 'is', 'ie', 'pt', 'pl', 'cz', 'sk', 'hu', 'ro', 'bg', 'gr', 'hr', 'si', 'rs', 'ua', 'by', 'ru', 'kz', 'ee', 'lv', 'lt', 'lu', 'mt', 'cy', 'tr', 'il', 'ae', 'sa', 'qa', 'kw', 'bh', 'om', 'jo', 'lb', 'eg', 'ma', 'tn', 'dz', 'za', 'ng', 'ke', 'gh', 'tz', 'ug', 'et', 'au', 'nz', 'jp', 'kr', 'cn', 'hk', 'tw', 'mo', 'sg', 'my', 'id', 'th', 'vn', 'ph', 'in', 'pk', 'bd', 'lk', 'np', 'br', 'mx', 'ar', 'cl', 'co', 'pe', 've', 'ec', 'uy', 'py', 'bo', 'cr', 'pa', 'gt', 'do', 'pr', 'cu', 'jm', 'tt', 'eu', 'su', 'gg', 'je', 'im', 'fo', 'gl', 'ax', 'li', 'mc', 'sm', 'va', 'ad', 'gi', 'mk', 'al', 'ba', 'me', 'md', 'ge', 'am', 'az', 'uz', 'kg', 'tj', 'tm', 'mn', 'kh', 'la', 'mm', 'bn', 'tl', 'fj', 'pg', 'nc', 'pf', 'ws', 'vu', 'sb', 'to', 'ki', 'nr', 'tv', 'fm', 'mh', 'pw', 'mp', 'gu', 'as', 'vi', 'ky', 'bm', 'bs', 'bb', 'gd', 'lc', 'vc', 'kn', 'dm', 'ag', 'ai', 'aw', 'cw', 'sx', 'bq', 'sr', 'gy', 'gf', 'fk', 'gs', 'sh', 'ac', 'ta', 'io', 'tf', 'aq', 'bv', 'hm', 'sj', 'pm', 'wf', 'yt', 're', 'mq', 'gp', 'bl', 'mf',
  // Internal / dev TLDs
  ...INTERNAL_DEV_TLDS
]);

// Extensions and code identifiers that look like `foo.ext` in JS/CSS/HTML
export const FILE_LIKE_TLDS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'xhtml',
  'json', 'jsonl', 'map', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'webm', 'ogg', 'wav', 'flac', 'mov', 'avi',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'mdx', 'rst', 'csv', 'tsv',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'wasm', 'bin', 'exe', 'dll', 'so', 'dylib',
  'py', 'rb', 'php', 'java', 'kt', 'swift', 'go', 'c', 'cpp', 'h', 'hpp', 'cs', 'fs', 'vb', 'lua',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'lock', 'log', 'bak', 'tmp', 'swp', 'sql',
  'vue', 'svelte', 'astro', 'graphql', 'gql', 'proto', 'prisma', 'dockerfile', 'makefile', 'gradle',
  'min', 'bundle', 'chunk', 'module', 'spec', 'dist', 'esm', 'umd', 'iife', 'd'
]);

// Common JS/DOM object roots that precede property chains like `window.top`, `event.target`, `data.id`, `console.info`
export const JS_NOISE_ROOTS = new Set([
  'window', 'document', 'console', 'navigator', 'location', 'history', 'screen', 'performance',
  'object', 'array', 'string', 'number', 'boolean', 'function', 'symbol', 'bigint', 'math', 'date',
  'regexp', 'error', 'promise', 'proxy', 'reflect', 'json', 'intl', 'map', 'set', 'weakmap', 'weakset',
  'global', 'globalthis', 'self', 'this', 'super', 'prototype', 'constructor', 'module', 'exports',
  'require', 'process', 'buffer', 'stream', 'crypto', 'events', 'util', 'path', 'http', 'https',
  'url', 'querystring', 'timers', 'worker', 'fetch', 'request', 'response', 'headers', 'body',
  'element', 'node', 'event', 'target', 'currenttarget', 'style', 'classlist', 'dataset', 'attributes',
  'parent', 'children', 'childnodes', 'nextsibling', 'previoussibling', 'firstchild', 'lastchild',
  'innerhtml', 'outerhtml', 'textcontent', 'value', 'checked', 'disabled', 'selected', 'files',
  'react', 'reactdom', 'vue', 'svelte', 'angular', 'jquery', 'webpack', 'vite', 'rollup', 'esbuild',
  'props', 'state', 'context', 'store', 'router', 'route', 'params', 'query', 'meta', 'config',
  'options', 'settings', 'data', 'result', 'results', 'item', 'items', 'list', 'row', 'rows',
  'user', 'users', 'account', 'session', 'token', 'auth', 'client', 'server', 'app', 'page',
  'input', 'output', 'form', 'field', 'fields', 'button', 'modal', 'dialog', 'menu', 'panel',
  'header', 'footer', 'sidebar', 'layout', 'theme', 'color', 'colors', 'font', 'fonts', 'icon',
  'image', 'img', 'video', 'audio', 'canvas', 'svg', 'rect', 'point', 'size', 'width', 'height',
  'left', 'right', 'top', 'bottom', 'index', 'count', 'length', 'total', 'limit', 'offset',
  'error', 'err', 'msg', 'message', 'status', 'code', 'type', 'name', 'id', 'key', 'val', 'ref',
  'e', 't', 'n', 'r', 'i', 'o', 'a', 's', 'u', 'c', 'l', 'd', 'f', 'p', 'h', 'm', 'v', 'g', 'b', 'y', 'w', 'x', 'k', 'z', 'j', 'q'
]);

// Placeholder / dummy hosts frequently left in docs or templates
export const PLACEHOLDER_HOSTS = new Set([
  'example.com', 'www.example.com', 'example.org', 'example.net',
  'yourdomain.com', 'your-domain.com', 'mydomain.com', 'domain.com',
  'test.com', 'foo.com', 'bar.com', 'baz.com', 'acme.com',
  'w3.org', 'www.w3.org', 'schema.org', 'xmlns.com', 'purl.org', 'ogp.me', 'gmpg.org'
]);

export function normalizeHost(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let host = raw.trim().toLowerCase();
  host = host.replace(/^\[|\]$/g, '');
  host = host.replace(/\.+$/, '');
  return host;
}

export function isIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

export function isValidHostname(host, { allowBareLocal = true, strictBare = false } = {}) {
  const h = normalizeHost(host);
  if (!h || h.length > 253) return false;
  if (allowBareLocal && (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0')) {
    return true;
  }
  if (isIPv4(h)) return true;

  const labels = h.split('.');
  if (labels.length < 2) return false;

  // Validate label syntax
  for (const label of labels) {
    if (!label || label.length > 63) return false;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return false;
  }

  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];

  // Reject purely numeric TLDs (like v1.2.3)
  if (/^\d+$/.test(tld)) return false;

  // Must be in valid TLD table
  if (!VALID_TLDS.has(tld)) return false;

  // In strictBare mode (bare string without http://), heavily reject code property chains & filenames
  if (strictBare) {
    // Reject 2-label strings whose TLD is also a common file extension or ambiguous word unless clearly a known domain
    if (FILE_LIKE_TLDS.has(tld) && !['io', 'ai', 'sh', 'rs', 'go', 'md', 'pro', 'id', 'st', 'to', 'so', 'cc', 'me', 'tv', 'co', 'de', 'fr', 'es', 'it', 'pl', 'nl', 'uk', 'us', 'ca', 'au', 'jp', 'in', 'br', 'ch', 'se', 'no', 'fi', 'dk', 'be', 'at', 'cz', 'ru', 'cn', 'kr', 'sg', 'hk', 'tw', 'mx', 'ar', 'cl', 'za', 'nz', 'ie', 'pt', 'gr', 'hu', 'ro', 'bg', 'ua', 'tr', 'il', 'ae', 'sa'].includes(tld)) {
      return false;
    }
    // Specifically reject `.sh`, `.rs`, `.go`, `.md`, `.py`, `.id`, `.so`, `.to`, `.pro`, `.st`, `.cc`, `.in`, `.as`, `.is`, `.at`, `.by`, `.do`, `.it`, `.me`, `.my`, `.no`, `.nu`, `.or`, `.re`, `.se`, `.si`, `.am`, `.fm`, `.im`, `.la`, `.ly`, `.ms`, `.sc`, `.tc`, `.tv`, `.vc`, `.vg`, `.ws`, `.ad`, `.ag`, `.ai`, `.al`, `.au`, `.az`, `.ba`, `.bb`, `.bd`, `.be`, `.bf`, `.bg`, `.bh`, `.bi`, `.bj`, `.bm`, `.bn`, `.bo`, `.br`, `.bs`, `.bt`, `.bv`, `.bw`, `.bz`, `.ca`, `.cd`, `.cf`, `.cg`, `.ch`, `.ci`, `.ck`, `.cl`, `.cm`, `.cn`, `.co`, `.cr`, `.cu`, `.cv`, `.cw`, `.cx`, `.cy`, `.cz` when root looks like a JS identifier
    const ambiguousCodeTlds = new Set([
      'id', 'top', 'name', 'data', 'info', 'link', 'page', 'site', 'app', 'dev', 'run', 'build', 'code', 'map', 'box', 'new', 'one', 'pro', 'zip', 'mov', 'md', 'sh', 'rs', 'go', 'io', 'ai', 'to', 'in', 'is', 'at', 'by', 'do', 'it', 'me', 'my', 'no', 'so', 'as', 're', 'am', 'im', 'la', 'ms', 'st', 'ws', 'cc', 'co', 'tv', 'fm', 'ly', 'gg', 'ac', 'ad', 'ag', 'al', 'ar', 'au', 'be', 'bg', 'br', 'ca', 'ch', 'cl', 'cn', 'cr', 'cu', 'cz', 'de', 'dk', 'ec', 'ee', 'eg', 'es', 'eu', 'fi', 'fr', 'gr', 'hk', 'hr', 'hu', 'ie', 'il', 'jp', 'ke', 'kr', 'lt', 'lu', 'lv', 'ma', 'mx', 'ng', 'nl', 'nz', 'pe', 'ph', 'pk', 'pl', 'pt', 'ro', 'ru', 'sa', 'se', 'sg', 'si', 'sk', 'th', 'tr', 'tw', 'ua', 'uk', 'us', 'uy', 've', 'vn', 'za', 'bar', 'foo', 'pub', 'art', 'bio', 'bot', 'day', 'fun', 'how', 'ink', 'law', 'now', 'pet', 'red', 'tax', 'vet', 'win', 'xyz', 'chat', 'club', 'cool', 'date', 'docs', 'fans', 'fast', 'film', 'food', 'free', 'game', 'gold', 'guru', 'help', 'host', 'live', 'love', 'mail', 'menu', 'news', 'open', 'play', 'plus', 'read', 'sale', 'shop', 'show', 'star', 'team', 'tech', 'time', 'wiki', 'work', 'zone', 'cloud', 'email', 'group', 'guide', 'house', 'media', 'money', 'music', 'photo', 'place', 'press', 'radio', 'space', 'stage', 'store', 'style', 'today', 'tools', 'trade', 'video', 'watch', 'world', 'write'
    ]);

    if (labels.length === 2 && JS_NOISE_ROOTS.has(labels[0])) {
      return false;
    }
    if (labels.length === 2 && ambiguousCodeTlds.has(tld)) {
      // Allow only if TLD is very strong commercial/dev domain or has >= 3 labels
      const strongBareTlds = new Set(['com', 'org', 'net', 'edu', 'gov', 'io', 'dev', 'app', 'ai', 'co', 'cloud', 'local', 'localhost', 'internal', 'test', 'corp', 'lan']);
      if (!strongBareTlds.has(tld)) return false;
      // Even for io/dev/app/ai/co, reject single-char SLD or obvious code words
      if (sld.length < 3) return false;
      if (['test', 'index', 'main', 'bundle', 'chunk', 'vendor', 'polyfill', 'runtime', 'manifest', 'config', 'setup', 'utils', 'helper', 'helpers', 'types', 'schema', 'model', 'view', 'style', 'styles', 'theme', 'script', 'scripts', 'client', 'server', 'worker', 'shared', 'common', 'public', 'static', 'assets', 'build', 'dist', 'out', 'src', 'lib', 'bin', 'pkg', 'env', 'tmp', 'log', 'err', 'api', 'web', 'www', 'http', 'https'].includes(sld) && !INTERNAL_DEV_TLDS.has(tld)) {
        return false;
      }
    }
    // Reject file-like patterns like `foo.min.js`, `chunk.abc.dev` when ending in common extensions
    if (FILE_LIKE_TLDS.has(tld) && tld !== 'io' && tld !== 'ai' && tld !== 'sh' && tld !== 'rs' && tld !== 'md') {
      return false;
    }
    // Reject `.md`, `.sh`, `.rs`, `.go` in bare mode unless it has a known hosting suffix or explicit protocol
    if (['md', 'sh', 'rs', 'go', 'py', 'rb', 'ts', 'js', 'css', 'json', 'map', 'xml', 'svg', 'png', 'jpg', 'gif', 'ico', 'txt', 'yml', 'yaml', 'toml', 'lock'].includes(tld)) {
      if (tld === 'sh' && !['surge.sh', 'now.sh', 'esm.sh', 'fly.sh', 'bun.sh', 'brew.sh', 'deno.sh', 'rustup.sh', 'nix.sh', 'mise.sh'].some((k) => h === k || h.endsWith('.' + k))) {
        return false;
      }
      if (tld !== 'sh') return false;
    }
  }

  // Reject single-char second-level domain for generic unknown TLDs except well-known ones (x.com, t.co, g.co, a.co, m.me)
  if (labels.length === 2 && sld.length === 1 && !['x.com', 't.co', 'g.co', 'a.co', 'm.me', 'w.wiki', 'q.com', 'z.com'].includes(h)) {
    return false;
  }

  return true;
}

export function getApexDomain(host) {
  const h = normalizeHost(host);
  if (!h) return '';
  if (h === 'localhost' || isIPv4(h)) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

export function getSubdomain(host) {
  const h = normalizeHost(host);
  const apex = getApexDomain(h);
  if (!h || !apex || h === apex) return '';
  return h.slice(0, -(apex.length + 1));
}
