import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderHtml } from '../src/report/html.js';
import { renderSvg } from '../src/report/svg.js';
import { displayPath, printable } from '../src/report/terminal.js';
import { runScan } from '../src/scan.js';
import type { ScanResult } from '../src/types.js';
import { materializeFixture } from './helpers/fixture.js';

async function fixtureScan(): Promise<{ root: string; home: string; result: ScanResult }> {
  const { root, home } = await materializeFixture('messy-dev');
  return { root, home, result: await runScan(root, { home, reposOnly: false, crontabCommand: 'sync-agent-docs-test-no-crontab' }) };
}

describe('reports', () => {
  it('html escapes a doc line containing <script>', async () => {
    const { result } = await fixtureScan();
    const evil = { ...result, findings: [...result.findings, { type: 'possible-conflict' as const, message: '<script>alert(1)</script>', entityId: 'project:<img>', attribute: 'port' as const, values: [{ value: '1"><b>', at: [{ path: '/x/<i>.md', line: 2 }], truthBacked: false }] }] };
    const html = renderHtml(evil);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img>');
    expect(html).not.toContain('<i>.md');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Worth a look');
  });

  it('html has no http(s) src or href to external hosts', async () => {
    const { result } = await fixtureScan();
    const html = renderHtml(result);
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/@import|url\(\s*["']?https?:/i);
    expect(html).toContain('name="viewport"');
    expect(html).toContain('What scan cannot see');
    for (const at of ['shop/README.md:3', 'shop/AGENTS.md:3', 'shop/CLAUDE.md:4', 'shop/CLAUDE.md:5', 'ops/hosts.md']) expect(html).toContain(at);
  });

  it('svg contains the score and no paths or IPs from the fixture', async () => {
    const { result, root, home } = await fixtureScan();
    const svg = renderSvg(result);
    expect(svg).toContain('73');
    expect(svg).toMatch(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    for (const leak of [root, home, 'shop', 'hetzner', 'CLAUDE.md', '10.0.0.4', '100.64.1.10', '3300']) expect(svg).not.toContain(leak);
    expect(svg).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });

  it('runScan writes report.html and score.svg', async () => {
    const { root, result } = await fixtureScan();
    expect(await readFile(join(root, '.sync-agent-docs', 'report.html'), 'utf8')).toBe(renderHtml(result));
    expect(await readFile(join(root, '.sync-agent-docs', 'score.svg'), 'utf8')).toBe(renderSvg(result));
  });

  it('printable drops bidi embedding, override and isolate controls', () => {
    const bidi = '\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069';
    expect(printable(`a${bidi}b`)).toBe('ab');
    expect(printable('tab\there\nnext')).toBe('tab\there\nnext');
    expect(displayPath('/r/shop/\u202Edm.EDUALC', '/r')).toBe('shop/dm.EDUALC');
  });
});
