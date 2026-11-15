import { extractDomainsFromArtifacts } from './domains.js';
import { detectBuildStack } from './stack.js';

function extractPageTitle(artifacts) {
  for (const a of artifacts) {
    if (a.type === 'html' && typeof a.content === 'string') {
      const m = a.content.match(/<title[^>]*>([^<]{1,180})<\/title>/i);
      if (m) return m[1].replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

function summarizeArchitecture(stack) {
  const pick = (cats, max = 2) =>
    stack.technologies
      .filter((t) => cats.includes(t.category))
      .slice(0, max)
      .map((t) => (t.version ? `${t.name} ${t.version}` : t.name));

  const primary = pick(['Meta-Framework', 'CMS & Site Builder', 'UI Framework'], 3);
  const build = pick(['Bundler & Build', 'Language & Runtime'], 2);
  const style = pick(['Styling & UI'], 2);
  const host = pick(['Hosting & Edge'], 2);

  const parts = [];
  if (primary.length) parts.push(primary.join(' + '));
  if (style.length) parts.push(style.join(' + '));
  if (build.length) parts.push(`Built with ${build.join(', ')}`);
  if (host.length) parts.push(`Hosted on ${host.join(', ')}`);

  return parts.length ? parts.join(' · ') : 'Static / Custom Web Stack (no framework signatures detected)';
}

export function analyzeScan({
  target = 'Untitled Source',
  targetUrl = '',
  mode = 'source',
  transport = 'local',
  headers = {},
  artifacts = [],
  repoFiles = [],
  meta = {}
} = {}) {
  const startedAt = Date.now();

  const normalizedArtifacts = artifacts.map((a, idx) => {
    const content = typeof a.content === 'string' ? a.content : '';
    return {
      id: `art-${idx}`,
      name: a.name || a.url || `source-${idx + 1}`,
      url: a.url || '',
      type: a.type || 'code',
      bytes: typeof a.bytes === 'number' ? a.bytes : content.length,
      lines: content ? content.split(/\r?\n/).length : 0,
      content
    };
  });

  const domainReport = extractDomainsFromArtifacts(normalizedArtifacts, {
    targetUrl: targetUrl || (mode === 'website' ? target : ''),
    headers
  });

  const stackReport = detectBuildStack(normalizedArtifacts, {
    headers,
    domains: domainReport.domains,
    repoFiles
  });

  const totalBytes = normalizedArtifacts.reduce((acc, a) => acc + a.bytes, 0);
  const title = meta.title || extractPageTitle(normalizedArtifacts);
  const architectureSummary = summarizeArchitecture(stackReport);

  const counts = {
    devSites: domainReport.devSites.length,
    totalDomains: domainReport.domains.length,
    apexDomains: domainReport.apexGroups.length,
    apiDomains: domainReport.domains.filter((d) => d.category === 'api').length,
    firstParty: domainReport.domains.filter((d) => d.isFirstParty).length,
    thirdParty: domainReport.domains.filter((d) => d.category === 'third-party').length,
    cdnDomains: domainReport.domains.filter((d) => d.category === 'cdn').length,
    technologies: stackReport.technologies.length,
    sourceMaps: domainReport.sourceMaps.length,
    envHints: domainReport.envHints.length,
    artifacts: normalizedArtifacts.length,
    totalBytes
  };

  return {
    id: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    scannedAt: new Date().toISOString(),
    durationMs: Math.max(1, Date.now() - startedAt),
    target,
    targetUrl: targetUrl || meta.finalUrl || '',
    mode,
    transport,
    title,
    architectureSummary,
    meta,
    headers,
    counts,
    domains: domainReport.domains,
    devSites: domainReport.devSites,
    apexGroups: domainReport.apexGroups,
    sourceMaps: domainReport.sourceMaps,
    envHints: domainReport.envHints,
    stack: stackReport,
    artifacts: normalizedArtifacts
  };
}
