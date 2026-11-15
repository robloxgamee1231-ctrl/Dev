import { TECH_CATEGORIES, TECH_SIGNATURES } from './signatures.js';

function parsePackageJsonDeps(artifacts) {
  const deps = new Map(); // pkgName -> { version, section, artifact }
  const scripts = [];
  for (const art of artifacts) {
    if (!/(?:^|\/)package\.json$/i.test(art.name || '')) continue;
    try {
      const parsed = JSON.parse(art.content);
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const obj = parsed[section];
        if (obj && typeof obj === 'object') {
          for (const [pkg, ver] of Object.entries(obj)) {
            if (!deps.has(pkg)) {
              deps.set(pkg, { version: String(ver || ''), section, artifact: art.name });
            }
          }
        }
      }
      if (parsed.scripts && typeof parsed.scripts === 'object') {
        for (const [k, v] of Object.entries(parsed.scripts)) {
          scripts.push({ name: k, command: String(v), artifact: art.name });
        }
      }
      if (parsed.packageManager && typeof parsed.packageManager === 'string') {
        const [pmName, pmVer] = parsed.packageManager.split('@');
        deps.set(`__pm__:${pmName}`, { version: pmVer || '', section: 'packageManager', artifact: art.name });
      }
    } catch {
      // Ignore malformed package.json
    }
  }
  return { deps, scripts };
}

function normalizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = String(v ?? '');
  }
  return out;
}

export function detectBuildStack(artifacts, { headers = {}, domains = [], repoFiles = [] } = {}) {
  const normHeaders = normalizeHeaders(headers);
  const htmlArtifacts = artifacts.filter((a) => a.type === 'html' || /\.html?$/i.test(a.name || ''));
  const jsArtifacts = artifacts.filter((a) => a.type === 'js' || /\.[cm]?[jt]sx?$/i.test(a.name || ''));
  const cssArtifacts = artifacts.filter((a) => a.type === 'css' || /\.(?:css|scss|sass|less)$/i.test(a.name || ''));
  const allFileNames = [
    ...repoFiles,
    ...artifacts.map((a) => a.name || '').filter(Boolean)
  ];
  const uniqueFiles = [...new Set(allFileNames)];
  const { deps, scripts } = parsePackageJsonDeps(artifacts);

  const hostSet = new Set((domains || []).map((d) => d.host));
  const detected = [];

  for (const sig of TECH_SIGNATURES) {
    const evidence = [];
    let score = 0;
    let version = null;

    // 1. Headers
    if (sig.headers) {
      for (const [hName, re] of Object.entries(sig.headers)) {
        const val = normHeaders[hName.toLowerCase()];
        if (val && re.test(val)) {
          score += 45;
          evidence.push({ source: 'HTTP Header', detail: `${hName}: ${val.slice(0, 100)}` });
        }
      }
    }

    // 2. HTML
    if (sig.html && htmlArtifacts.length > 0) {
      for (const art of htmlArtifacts) {
        for (const re of sig.html) {
          const m = art.content.match(re);
          if (m) {
            score += 40;
            evidence.push({
              source: art.name || 'HTML',
              detail: `HTML pattern matched: ${m[0].slice(0, 90)}`
            });
            break;
          }
        }
      }
    }

    // 3. JS bundles & inline scripts (also check HTML for inline scripts)
    if (sig.js) {
      const targets = [...jsArtifacts, ...htmlArtifacts];
      let jsMatched = false;
      for (const art of targets) {
        if (jsMatched) break;
        for (const re of sig.js) {
          const m = art.content.match(re);
          if (m) {
            score += 35;
            jsMatched = true;
            evidence.push({
              source: art.name || 'Script',
              detail: `Script signature: ${m[0].slice(0, 90)}`
            });
            break;
          }
        }
      }
    }

    // 4. CSS
    if (sig.css) {
      const targets = [...cssArtifacts, ...htmlArtifacts];
      let cssMatched = false;
      for (const art of targets) {
        if (cssMatched) break;
        for (const re of sig.css) {
          const m = art.content.match(re);
          if (m) {
            score += 35;
            cssMatched = true;
            evidence.push({
              source: art.name || 'CSS',
              detail: `Stylesheet rule: ${m[0].slice(0, 90)}`
            });
            break;
          }
        }
      }
    }

    // 5. package.json dependencies
    if (sig.pkg && deps.size > 0) {
      for (const pkgName of sig.pkg) {
        if (deps.has(pkgName)) {
          const info = deps.get(pkgName);
          score += 65;
          if (!version && info.version) {
            version = info.version.replace(/^[~^>=<\s]+/, '');
          }
          evidence.push({
            source: info.artifact,
            detail: `${info.section}: "${pkgName}": "${info.version}"`
          });
        }
      }
    }

    // Check packageManager field for pnpm/yarn/npm/bun
    if (['pnpm', 'yarn', 'npm', 'bun'].includes(sig.id) && deps.has(`__pm__:${sig.id}`)) {
      const info = deps.get(`__pm__:${sig.id}`);
      score += 60;
      if (!version && info.version) version = info.version;
      evidence.push({ source: info.artifact, detail: `packageManager: ${sig.id}@${info.version}` });
    }

    // 6. Repo config files
    if (sig.files && uniqueFiles.length > 0) {
      for (const fileRe of sig.files) {
        const hit = uniqueFiles.find((f) => {
          const base = f.split('/').pop() || f;
          return fileRe.test(f) || fileRe.test(base);
        });
        if (hit) {
          score += 55;
          evidence.push({ source: 'Repository File', detail: hit });
          break;
        }
      }
    }

    // 7. Discovered domains
    if (sig.domains && hostSet.size > 0) {
      for (const suffix of sig.domains) {
        const hitHost = [...hostSet].find((h) => h === suffix || h.endsWith('.' + suffix));
        if (hitHost) {
          score += 30;
          evidence.push({ source: 'Domain Reference', detail: hitHost });
          break;
        }
      }
    }

    if (score === 0) continue;

    // 8. Extract version string if not already obtained from package.json
    if (!version && sig.version) {
      const searchPool = [
        ...Object.values(normHeaders),
        ...htmlArtifacts.map((a) => a.content.slice(0, 120000)),
        ...jsArtifacts.map((a) => a.content.slice(0, 120000)),
        ...cssArtifacts.map((a) => a.content.slice(0, 60000))
      ];
      outer: for (const vRe of sig.version) {
        for (const text of searchPool) {
          const vm = text.match(vRe);
          if (vm && vm[1]) {
            version = vm[1];
            break outer;
          }
        }
      }
    }

    const confidence = score >= 60 ? 'high' : score >= 35 ? 'medium' : 'signal';
    detected.push({
      id: sig.id,
      name: sig.name,
      category: sig.category,
      color: sig.color,
      version: version || null,
      confidence,
      score: Math.min(100, score),
      evidence
    });
  }

  // Also capture any raw <meta name="generator"> not matched by built-in signatures
  const rawGenerators = [];
  for (const art of htmlArtifacts) {
    const genRe = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator["']/gi;
    let gm;
    while ((gm = genRe.exec(art.content)) !== null) {
      const val = (gm[1] || gm[2] || '').trim();
      if (val && !rawGenerators.includes(val)) {
        rawGenerators.push(val);
        const alreadyCovered = detected.some((d) => val.toLowerCase().includes(d.name.toLowerCase().split(' ')[0]));
        if (!alreadyCovered) {
          detected.push({
            id: `generator-${val.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
            name: val,
            category: 'CMS & Site Builder',
            color: '#94a3b8',
            version: null,
            confidence: 'high',
            score: 80,
            evidence: [{ source: art.name || 'HTML', detail: `<meta name="generator" content="${val}">` }]
          });
        }
      }
    }
  }

  // Sort by category order then score desc
  detected.sort((a, b) => {
    const ca = TECH_CATEGORIES.indexOf(a.category);
    const cb = TECH_CATEGORIES.indexOf(b.category);
    if (ca !== cb) return (ca === -1 ? 99 : ca) - (cb === -1 ? 99 : cb);
    return b.score - a.score || a.name.localeCompare(b.name);
  });

  // Group by category
  const byCategory = {};
  for (const item of detected) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }

  // Security & web platform posture signals
  const securityHeaders = {
    csp: Boolean(normHeaders['content-security-policy']),
    hsts: Boolean(normHeaders['strict-transport-security']),
    xFrameOptions: normHeaders['x-frame-options'] || null,
    referrerPolicy: normHeaders['referrer-policy'] || null,
    permissionsPolicy: Boolean(normHeaders['permissions-policy']),
    server: normHeaders['server'] || null,
    poweredBy: normHeaders['x-powered-by'] || null
  };

  const hasServiceWorker = artifacts.some((a) => /serviceWorker\.register\(/i.test(a.content || ''));
  const hasManifest = htmlArtifacts.some((a) => /rel=["']manifest["']/i.test(a.content || '')) ||
    artifacts.some((a) => /manifest\.json|webmanifest/i.test(a.name || ''));

  return {
    technologies: detected,
    byCategory,
    rawGenerators,
    scripts: scripts.slice(0, 25),
    securityHeaders,
    platformSignals: {
      hasServiceWorker,
      hasManifest,
      headerCount: Object.keys(normHeaders).length
    }
  };
}
