import type { FindingType, ScanResult } from '../types.js';

/**
 * A share card that carries only counts: no file paths, host names or values,
 * so it can be posted without leaking anything about the setup.
 */
export function renderSvg(r: ScanResult): string {
  const count = (t: FindingType) => r.findings.filter((f) => f.type === t).length;
  const pct = Math.round((100 * r.duplicatedTokens) / Math.max(r.agentTokens, 1));
  const stats: [string, string][] = [
    [String(count('conflict') + count('global-local')), 'conflicts'],
    [String(count('stale')), 'stale'],
    [String(count('secret')), 'secrets'],
    [`${pct}%`, 'duplicated'],
  ];
  const cells = stats.map(([n, label], i) => {
    const x = 40 + i * 140;
    return `<text x="${x}" y="232" font-size="30" font-weight="600" fill="#1a1d21">${n}</text><text x="${x}" y="258" font-size="15" fill="#5c6370">${label}</text>`;
  }).join('');
  const date = r.scannedAt.slice(0, 10);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="315" viewBox="0 0 600 315" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" role="img" aria-label="Context health ${r.score} out of 100">
<rect width="600" height="315" fill="#ffffff"/>
<rect x="0.5" y="0.5" width="599" height="314" fill="none" stroke="#e3e6ea"/>
<text x="40" y="64" font-size="17" fill="#5c6370">Context health</text>
<text x="40" y="146" font-size="72" font-weight="700" fill="#1a1d21">${r.score}<tspan font-size="28" font-weight="400" fill="#5c6370">/100</tspan></text>
<rect x="40" y="170" width="${Math.round(5.2 * r.score)}" height="4" fill="#b42318"/>
<rect x="${40 + Math.round(5.2 * r.score)}" y="170" width="${520 - Math.round(5.2 * r.score)}" height="4" fill="#e3e6ea"/>
${cells}
<text x="40" y="292" font-size="12" fill="#5c6370">sync-agent-docs scan, ${date}, ${r.repos.length} repos</text>
</svg>
`;
}
