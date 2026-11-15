// Interactive SVG Domain & Environment Topology Graph.

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, max = 26) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

export function renderTopologySvg(report) {
  const width = 920;
  const height = 430;
  const cx = width / 2;
  const cy = height / 2;

  const devNodes = (report.devSites || []).slice(0, 7);
  const apiNodes = (report.domains || []).filter((d) => !d.isDevSurface && d.category === 'api').slice(0, 6);
  const fpNodes = (report.domains || []).filter((d) => !d.isDevSurface && d.category === 'first-party' && !d.isTarget).slice(0, 6);
  const infraNodes = (report.domains || []).filter((d) => !d.isDevSurface && (d.category === 'cdn' || d.category === 'third-party')).slice(0, 7);

  const clusters = [
    {
      id: 'dev',
      title: 'DEV / STAGING / PREVIEW',
      color: '#f59e0b',
      bg: 'rgba(245, 158, 11, 0.12)',
      nodes: devNodes,
      anchorX: 165,
      startY: 56,
      stepY: 42,
      align: 'left'
    },
    {
      id: 'api',
      title: 'API & BACKEND',
      color: '#38bdf8',
      bg: 'rgba(56, 189, 248, 0.12)',
      nodes: apiNodes,
      anchorX: width - 165,
      startY: 56,
      stepY: 42,
      align: 'right'
    },
    {
      id: 'fp',
      title: 'FIRST-PARTY DOMAINS',
      color: '#22c55e',
      bg: 'rgba(34, 197, 94, 0.12)',
      nodes: fpNodes,
      anchorX: 165,
      startY: 256,
      stepY: 38,
      align: 'left'
    },
    {
      id: 'infra',
      title: 'CDN & SERVICES',
      color: '#a78bfa',
      bg: 'rgba(167, 139, 250, 0.12)',
      nodes: infraNodes,
      anchorX: width - 165,
      startY: 256,
      stepY: 36,
      align: 'right'
    }
  ];

  // Dynamically space left/right column clusters so they never overlap vertically
  const layoutColumn = (topCluster, botCluster) => {
    const topCount = Math.max(1, topCluster.nodes.length);
    const botCount = Math.max(1, botCluster.nodes.length);
    const topHeight = topCount * 32 + 28;
    topCluster.startY = 42;
    topCluster.stepY = 30;
    botCluster.startY = Math.max(228, topCluster.startY + topHeight + 22);
    botCluster.stepY = Math.min(30, Math.floor((height - botCluster.startY - 24) / Math.max(1, botCount)));
  };

  layoutColumn(clusters[0], clusters[2]);
  layoutColumn(clusters[1], clusters[3]);

  const edgesSvg = [];
  const nodesSvg = [];

  for (const cluster of clusters) {
    const isLeft = cluster.align === 'left';
    const labelX = isLeft ? 24 : width - 24;
    const textAnchor = isLeft ? 'start' : 'end';

    nodesSvg.push(
      `<text x="${labelX}" y="${cluster.startY - 14}" text-anchor="${textAnchor}" fill="${cluster.color}" font-size="10" font-weight="700" letter-spacing="0.12em" font-family="var(--font-mono)">${esc(cluster.title)} (${cluster.nodes.length})</text>`
    );

    if (cluster.nodes.length === 0) {
      nodesSvg.push(
        `<text x="${labelX}" y="${cluster.startY + 12}" text-anchor="${textAnchor}" fill="var(--text-muted)" font-size="11" font-family="var(--font-mono)" opacity="0.65">None detected</text>`
      );
      continue;
    }

    cluster.nodes.forEach((node, idx) => {
      const ny = cluster.startY + idx * cluster.stepY + 10;
      const boxW = 248;
      const boxH = 24;
      const boxX = isLeft ? 22 : width - 22 - boxW;
      const connectX = isLeft ? boxX + boxW : boxX;
      const midX = isLeft ? (connectX + cx) / 2 : (cx + connectX) / 2;

      edgesSvg.push(
        `<path d="M ${cx} ${cy} C ${midX} ${cy}, ${midX} ${ny}, ${connectX} ${ny}" fill="none" stroke="${cluster.color}" stroke-opacity="${cluster.id === 'dev' ? '0.55' : '0.32'}" stroke-width="${cluster.id === 'dev' ? '1.6' : '1.15'}" ${cluster.id === 'dev' ? 'stroke-dasharray="4 3"' : ''} />`
      );

      const badge = (node.envTag || cluster.id).toUpperCase().slice(0, 7);
      nodesSvg.push(`
        <g class="topo-node" data-inspect-host="${esc(node.host)}" tabindex="0" role="button" aria-label="Inspect ${esc(node.host)}">
          <rect x="${boxX}" y="${ny - boxH / 2}" width="${boxW}" height="${boxH}" rx="6" fill="var(--surface-2)" stroke="${cluster.color}" stroke-opacity="0.45" stroke-width="1" />
          <circle cx="${isLeft ? boxX + 11 : boxX + boxW - 11}" cy="${ny}" r="3.5" fill="${cluster.color}" />
          <text x="${isLeft ? boxX + 21 : boxX + boxW - 21}" y="${ny + 3.5}" text-anchor="${isLeft ? 'start' : 'end'}" fill="var(--text-primary)" font-size="11" font-family="var(--font-mono)">${esc(truncate(node.host, 25))}</text>
          <text x="${isLeft ? boxX + boxW - 8 : boxX + 8}" y="${ny + 3}" text-anchor="${isLeft ? 'end' : 'start'}" fill="${cluster.color}" font-size="9" font-weight="700" font-family="var(--font-mono)" opacity="0.85">${esc(badge)}</text>
        </g>
      `);
    });
  }

  const centerLabel = truncate(report.domains.find((d) => d.isTarget)?.host || report.target || 'Target', 24);
  const centerSub = `${report.counts.devSites} dev · ${report.counts.totalDomains} hosts · ${report.counts.technologies} stack`;

  return `
    <svg class="topology-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Domain and environment topology graph">
      <defs>
        <radialGradient id="hubGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.22" />
          <stop offset="100%" stop-color="#38bdf8" stop-opacity="0" />
        </radialGradient>
      </defs>
      <circle cx="${cx}" cy="${cy}" r="118" fill="url(#hubGlow)" />
      <g class="topo-edges">${edgesSvg.join('')}</g>
      <g class="topo-hub">
        <rect x="${cx - 108}" y="${cy - 34}" width="216" height="68" rx="12" fill="var(--surface-1)" stroke="#38bdf8" stroke-width="1.5" />
        <text x="${cx}" y="${cy - 8}" text-anchor="middle" fill="var(--text-primary)" font-size="12.5" font-weight="700" font-family="var(--font-mono)">${esc(centerLabel)}</text>
        <text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${esc(centerSub)}</text>
      </g>
      <g class="topo-nodes">${nodesSvg.join('')}</g>
    </svg>
  `;
}
