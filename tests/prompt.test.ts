import { describe, expect, it } from 'vitest';
import { askOpenQuestions, type Asker } from '../src/plan/prompt.js';
import type { PlanItem } from '../src/plan/types.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');

function recorder(reply = ''): Asker & { seen: string[] } {
  const seen: string[] = [];
  return { seen, print: (t) => void seen.push(t), ask: (q) => (seen.push(q), Promise.resolve(reply)) };
}

const item = (over: Partial<PlanItem>): PlanItem => ({
  key: 'k1', tier: 'conflict', kind: 'conflict', title: 'Port for shop', subject: 'shop', candidates: ['3000', '3300'],
  evidence: [], options: ['3000', '3300'], answer: null, edits: {}, notes: [], ...over,
});

describe('askOpenQuestions', () => {
  it('terminal escapes in scanned text never reach print or ask', async () => {
    const evil = '\x1b[31mred\x9b2J\x07';
    const asker = recorder();
    await askOpenQuestions([
      item({
        title: `Port ${evil}`, notes: [`note ${evil}`], options: [`3000${evil}`, '3300'],
        evidence: [{ value: `3000${evil}`, path: `/r/${evil}/README.md`, line: 1, kind: 'claim', scope: 'repo' }],
      }),
      item({ key: 'k2', tier: 'auto', kind: 'fact', title: `Auto ${evil}`, options: ['approve', 'reject'] }),
    ], asker, NOW);
    expect(asker.seen.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-control-regex
    for (const s of asker.seen) expect(s).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(asker.seen.join('\n')).toContain('red');
  });

  it('a remembered secret answer is shown as answered earlier, without the value', async () => {
    const asker = recorder();
    await askOpenQuestions([
      item({ key: 's1', tier: 'secret', kind: 'secret', title: 'Possible secret at shop/.env:3', subject: 'shop/.env', candidates: ['h'], options: ['rotate-remove', 'false-positive'], answer: 'false-positive', answeredBy: 'remembered' }),
    ], asker, NOW);
    expect(asker.seen.join('\n')).toMatch(/answered earlier: Possible secret at shop\/\.env:3 -> false-positive/);
  });

  it("each option shows its edits as - before and + after", async () => {
    const asker = recorder();
    await askOpenQuestions([
      item({ edits: {
        '3300': [{ path: '/r/shop/README.md', line: 3, op: 'replace', before: 'shop runs on port 3000', after: 'shop runs on port 3300' }],
        '3000': [{ path: '/r/shop/CLAUDE.md', line: 5, op: 'remove', before: 'port 3300' }, { path: '/r/shop/CLAUDE.md', line: 0, op: 'append', after: '@truth/projects/shop.md' }],
      } }),
    ], asker, NOW);
    const out = asker.seen.join('\n');
    expect(out).toMatch(/1\) 3000[\s\S]*\/r\/shop\/CLAUDE\.md:5\n\s+- port 3300[\s\S]*\+ @truth\/projects\/shop\.md[\s\S]*2\) 3300\n\s+\/r\/shop\/README\.md:3\n\s+- shop runs on port 3000\n\s+\+ shop runs on port 3300/);
  });

  it('a secret edit shows only its path and line', async () => {
    const asker = recorder();
    await askOpenQuestions([
      item({ key: 's1', tier: 'secret', kind: 'secret', title: 'Possible secret at shop/.env:3', subject: 'shop/.env', candidates: ['h'], options: ['rotate-remove', 'false-positive'],
        edits: { 'rotate-remove': [{ path: '/r/shop/.env', line: 3, op: 'remove', lineHash: 'h', secret: true, before: 'TOKEN=not-shown' }] } }),
    ], asker, NOW);
    const out = asker.seen.join('\n');
    expect(out).toMatch(/1\) rotate-remove\n\s+\/r\/shop\/\.env:3 \(line removed, not shown\)/);
    expect(out).not.toContain('not-shown');
  });
});
