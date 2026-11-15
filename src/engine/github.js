import { analyzeScan } from './analyzer.js';

export function parseGitHubInput(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  s = s.replace(/\.git$/i, '');

  // Handle git@github.com:owner/repo
  const sshMatch = s.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2], branch: '' };
  }

  // Handle full GitHub URL
  const urlMatch = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^/\s#?]+))?/i);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], branch: urlMatch[3] || '' };
  }

  // Handle shorthand owner/repo or owner/repo@branch
  const shortMatch = s.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:@([a-zA-Z0-9_./-]+))?$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], branch: shortMatch[3] || '' };
  }

  return null;
}

function decodeBase64Utf8(b64) {
  const clean = (b64 || '').replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(clean, 'base64').toString('utf8');
  }
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

const NON_PROD_REPO_DIR_RE = /(?:^|\/)(?:node_modules|dist|build|coverage|\.git|vendor|__snapshots__|__tests__|__fixtures__|test|tests|spec|specs|e2e|playground|playgrounds|examples|example|fixtures|fixture|bench|benchmarks|templates|template|starters|demos)\//i;

function scoreRepoFile(path) {
  const p = path.toLowerCase();
  const base = p.split('/').pop() || p;
  const depth = p.split('/').length - 1;

  // Skip lockfiles, minified vendor assets, tests, playgrounds, examples, images, binaries
  if (NON_PROD_REPO_DIR_RE.test(p)) return -1;
  if (/\.(?:png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|eot|mp4|mp3|pdf|zip|gz|tar|wasm|lock|lockb)$/i.test(p)) return -1;
  if (base === 'package-lock.json' || base === 'pnpm-lock.yaml' || base === 'yarn.lock') return -1;

  // Tier 1: highest signal root manifests & hosting/deploy configs
  if (p === 'package.json') return 100;
  if (p === 'cname' || base === 'cname') return 99;
  if (/^(?:vercel\.json|netlify\.toml|wrangler\.(?:toml|jsonc?)|fly\.toml|render\.yaml|firebase\.json|amplify\.yml|railway\.(?:json|toml))$/.test(p)) return 96;
  if (depth <= 1 && /^\.env(?:\.(?:example|sample|template|development|staging|production|local\.example))?$/.test(base)) return 95;

  // Tier 2: framework & bundler configs (root or docs/apps)
  if (/^(?:next|nuxt|vite|astro|svelte|remix|gatsby|webpack|rollup|rspack|rsbuild|tailwind|docusaurus)\.config\.[cm]?[jt]s$/.test(p)) return 92;
  if (/(?:^|\/)\.vitepress\/config\.[cm]?[jt]s$/.test(p)) return 90;
  if (p === 'angular.json' || p === 'turbo.json' || p === 'nx.json' || p === 'deno.json' || p === 'composer.json' || p === 'pyproject.toml' || p === 'cargo.toml' || p === 'go.mod') return 88;

  // Tier 3: CI/CD workflows (often expose preview/staging URLs & hosting platform)
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) return 86;

  // Tier 4: HTML entry & app configs
  if (/^(?:index\.html|public\/index\.html|src\/index\.html|app\/index\.html|docs\/index\.html)$/.test(p)) return 84;
  if (/(?:^|\/)(?:config|env|endpoints|constants|hosts|domains|api)\.[cm]?[jt]sx?$/.test(p) && depth <= 3) return 80;
  if (depth <= 1 && (base === 'dockerfile' || base === 'docker-compose.yml' || base === 'docker-compose.yaml')) return 76;
  if (base === 'package.json' && depth <= 2) return 75;
  if (p === 'readme.md') return 72;
  if (/^(?:public|static)\/(?:robots\.txt|manifest\.json|site\.webmanifest|sitemap\.xml)$/.test(p)) return 68;

  return 0;
}

function inferArtifactType(path) {
  const lower = path.toLowerCase();
  if (/\.html?$/.test(lower)) return 'html';
  if (/\.[cm]?[jt]sx?$/.test(lower)) return 'js';
  if (/\.(?:css|scss|sass|less)$/.test(lower)) return 'css';
  if (/\.jsonc?$/.test(lower)) return 'json';
  return 'config';
}

export async function scanGitHubRepo(input, { token = '', maxFiles = 12, onProgress = () => {} } = {}) {
  const parsed = parseGitHubInput(input);
  if (!parsed) {
    throw new Error('Enter a valid GitHub repo like "owner/repo" or "https://github.com/owner/repo".');
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token && token.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  const { owner, repo } = parsed;
  onProgress({ step: 'meta', label: `Fetching repository metadata for ${owner}/${repo}…` });

  const repoRes = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers });
  if (!repoRes.ok) {
    if (repoRes.status === 404) throw new Error(`Repository "${owner}/${repo}" not found or private.`);
    if (repoRes.status === 403) throw new Error('GitHub API rate limit reached. Add a GitHub token in Options or wait a minute.');
    throw new Error(`GitHub API error (${repoRes.status}) while loading ${owner}/${repo}.`);
  }
  const repoData = await repoRes.json();
  const branch = parsed.branch || repoData.default_branch || 'main';

  onProgress({ step: 'tree', label: `Reading file tree on branch "${branch}"…` });
  const treeRes = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers }
  );

  let allFiles = [];
  if (treeRes.ok) {
    const treeJson = await treeRes.json();
    allFiles = (treeJson.tree || [])
      .filter((item) => item.type === 'blob' && item.path)
      .map((item) => ({ path: item.path, size: item.size || 0 }));
  }

  const candidateFiles = allFiles
    .filter((f) => f.size > 0 && f.size <= 350000)
    .map((f) => ({ ...f, score: scoreRepoFile(f.path) }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, Math.min(18, Math.max(4, maxFiles)));

  const artifacts = [];

  // Include repository homepage & description metadata if present
  if (repoData.homepage || repoData.description) {
    const metaLines = [
      `Repository: ${repoData.full_name}`,
      repoData.homepage ? `Homepage: ${repoData.homepage}` : '',
      repoData.description ? `Description: ${repoData.description}` : '',
      Array.isArray(repoData.topics) && repoData.topics.length ? `Topics: ${repoData.topics.join(', ')}` : ''
    ].filter(Boolean).join('\n');
    artifacts.push({
      name: 'github-repo-metadata.txt',
      url: repoData.html_url,
      type: 'config',
      content: metaLines,
      bytes: metaLines.length
    });
  }

  onProgress({ step: 'files', label: `Inspecting ${candidateFiles.length} high-signal source & config files…` });

  // Fetch files in small concurrent batches
  const batchSize = 4;
  for (let i = 0; i < candidateFiles.length; i += batchSize) {
    const batch = candidateFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (f) => {
        try {
          const encodedPath = f.path.split('/').map(encodeURIComponent).join('/');
          const res = await fetch(
            `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
            { headers }
          );
          if (!res.ok) return null;
          const json = await res.json();
          if (!json || typeof json.content !== 'string') return null;
          const text = decodeBase64Utf8(json.content);
          return {
            name: f.path,
            url: json.html_url || `${repoData.html_url}/blob/${branch}/${f.path}`,
            type: inferArtifactType(f.path),
            content: text,
            bytes: json.size || text.length
          };
        } catch {
          return null;
        }
      })
    );
    for (const item of results) {
      if (item) artifacts.push(item);
    }
  }

  onProgress({ step: 'analyze', label: 'Classifying dev environments, domains & build stack…' });

  let targetUrl = '';
  if (repoData.homepage && /^https?:\/\//i.test(repoData.homepage.trim())) {
    targetUrl = repoData.homepage.trim();
  }

  const prodRepoFiles = allFiles
    .map((f) => f.path)
    .filter((p) => !NON_PROD_REPO_DIR_RE.test(p) && p.split('/').length <= 3);

  return analyzeScan({
    target: `${owner}/${repo}`,
    targetUrl,
    mode: 'github',
    transport: 'github-api',
    headers: {},
    artifacts,
    repoFiles: prodRepoFiles,
    meta: {
      title: repoData.full_name,
      description: repoData.description || '',
      homepage: repoData.homepage || '',
      stars: repoData.stargazers_count || 0,
      language: repoData.language || '',
      defaultBranch: branch,
      totalRepoFiles: allFiles.length,
      repoUrl: repoData.html_url
    }
  });
}
