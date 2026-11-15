// Export scan reports as JSON, CSV, or Markdown.

function slugify(str) {
  return String(str || 'scan')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'scan';
}

export function triggerDownload(filename, content, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportReportJson(report) {
  // Omit raw multi-megabyte artifact text from export summary unless compact
  const clean = {
    ...report,
    artifacts: (report.artifacts || []).map(({ content, ...meta }) => meta)
  };
  triggerDownload(
    `devtrace-${slugify(report.target)}.json`,
    JSON.stringify(clean, null, 2),
    'application/json;charset=utf-8'
  );
}

function csvCell(v) {
  const s = String(v ?? '');
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function exportDomainsCsv(report) {
  const header = ['Host', 'Apex Domain', 'Category', 'Environment', 'Dev Surface', 'First Party', 'Occurrences', 'Vendor', 'Reasons', 'Sample URL'];
  const rows = (report.domains || []).map((d) => [
    d.host,
    d.apex,
    d.category,
    d.envTag,
    d.isDevSurface ? 'YES' : 'NO',
    d.isFirstParty ? 'YES' : 'NO',
    d.occurrences,
    d.vendor || '',
    (d.reasons || []).join(' | '),
    (d.urls || [])[0] || ''
  ]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  triggerDownload(`devtrace-domains-${slugify(report.target)}.csv`, csv, 'text/csv;charset=utf-8');
}

export function exportReportMarkdown(report) {
  const lines = [];
  lines.push(`# DevTrace Report: ${report.target}`);
  lines.push('');
  lines.push(`- **Scanned:** ${report.scannedAt}`);
  lines.push(`- **Mode / Transport:** ${report.mode} (${report.transport})`);
  lines.push(`- **Architecture Summary:** ${report.architectureSummary}`);
  lines.push(`- **Counts:** ${report.counts.devSites} dev/staging/preview sites · ${report.counts.totalDomains} domains · ${report.counts.technologies} technologies · ${report.counts.artifacts} artifacts`);
  lines.push('');

  lines.push('## Dev, Staging & Preview Sites');
  lines.push('');
  if ((report.devSites || []).length === 0) {
    lines.push('_None discovered in scanned artifacts._');
  } else {
    lines.push('| Host | Environment | First-Party | Hits | Signal |');
    lines.push('|---|---|---|---:|---|');
    for (const d of report.devSites) {
      lines.push(`| \`${d.host}\` | ${d.envTag} | ${d.isFirstParty ? 'Yes' : 'No'} | ${d.occurrences} | ${(d.reasons || []).join('; ')} |`);
    }
  }
  lines.push('');

  lines.push('## Build Stack & Technologies');
  lines.push('');
  for (const [cat, items] of Object.entries(report.stack?.byCategory || {})) {
    lines.push(`### ${cat}`);
    for (const t of items) {
      const ver = t.version ? ` \`v${t.version}\`` : '';
      const proof = (t.evidence || []).slice(0, 2).map((e) => `${e.source}: ${e.detail}`).join('; ');
      lines.push(`- **${t.name}**${ver} (${t.confidence}) — ${proof}`);
    }
    lines.push('');
  }

  lines.push('## All Discovered Domains');
  lines.push('');
  lines.push('| Host | Category | Hits | Sample URL |');
  lines.push('|---|---|---:|---|');
  for (const d of report.domains || []) {
    lines.push(`| \`${d.host}\` | ${d.category} | ${d.occurrences} | ${(d.urls || [])[0] || ''} |`);
  }

  triggerDownload(`devtrace-${slugify(report.target)}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
}
