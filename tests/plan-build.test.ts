import { appendFile, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlan } from '../src/plan/build.js';
import { decisionKey } from '../src/plan/decisions.js';
import { isPureRestatement, lineHash, replaceValue } from '../src/plan/lines.js';
import type { Plan, PlanItem } from '../src/plan/types.js';
import { collectScan } from '../src/scan.js';
import type { Decision } from '../src/store/types.js';
import type { ScanResult } from '../src/types.js';
import { materializeFixture } from './helpers/fixture.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');

async function setup(prepare?: (root: string) => Promise<void>) {
  const fx = await materializeFixture('messy-dev', { commit: true });
  await prepare?.(fx.root);
  const scan = await collectScan(fx.root, { home: fx.home, reposOnly: false, crontabCommand: 'false' });
  const plan = async (decisions: Decision[] = []) => buildPlan({ scan, decisions, store: join(fx.home, 'dev', 'truth'), home: fx.home, now: NOW });
  return { ...fx, scan, plan };
}

const one = (plan: Plan, pred: (i: PlanItem) => boolean): PlanItem => {
  const found = plan.items.filter(pred);
  expect(found).toHaveLength(1);
  return found[0] as PlanItem;
};

describe('lines', () => {
  it('a pure restatement has nothing left but the value, names and stopwords', () => {
    expect(isPureRestatement('- shop runs on port 4000', '4000', ['shop'])).toBe(true);
    expect(isPureRestatement('hetzner box: 100.64.1.10', '100.64.1.10', ['hetzner', '100.64.1.10'])).toBe(true);
    expect(isPureRestatement('shop runs on port 3000 behind nginx with gzip', '3000', ['shop'])).toBe(false);
  });

  it('replaceValue swaps whole tokens only', () => {
    expect(replaceValue('port 3000 and 30001', '3000', '3300')).toBe('port 3300 and 30001');
    expect(lineHash('a')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('buildPlan', () => {
  it('shop port is one conflict item with 3000, 3300, 4000, recommending 3300', async () => {
    const plan = await (await setup()).plan();
    const item = one(plan, (i) => i.tier === 'conflict' && i.entityId === 'project:shop' && i.attribute === 'port');
    expect(item.candidates).toEqual(['3000', '3300', '4000']);
    expect(item.options).toEqual(['3000', '3300', '4000', 'all-valid']);
    expect(item.recommended).toBe('3300');
    expect(item.evidence.find((e) => e.path.endsWith('ecosystem.config.cjs'))?.lastCommit).toMatch(/^[0-9a-f]{7} \d{4}-\d{2}-\d{2}$/);
  });

  it('choosing 3300 rewrites shop/README.md in place and removes the global CLAUDE.md line', async () => {
    const { root, home, plan } = await setup();
    const item = one(await plan(), (i) => i.tier === 'conflict' && i.attribute === 'port');
    const edits = item.edits['3300'] ?? [];
    expect(edits).toContainEqual(expect.objectContaining({ path: join(root, 'shop', 'README.md'), line: 3, op: 'replace', before: 'shop runs on port 3000', after: 'shop runs on port 3300', lineHash: lineHash('shop runs on port 3000') }));
    expect(edits).toContainEqual(expect.objectContaining({ path: join(home, '.claude', 'CLAUDE.md'), line: 3, op: 'remove' }));
    expect(edits.some((e) => e.path.endsWith('ecosystem.config.cjs') || e.path.endsWith('hosts.md'))).toBe(false);
    expect(item.edits['3000']?.some((e) => e.path.endsWith('ecosystem.config.cjs'))).toBeFalsy();
    expect(item.notes.join(' ')).toMatch(/config disagrees/);
  });

  it('duplicated hetzner ip removes both CLAUDE.md copies and appends the hosts.md import', async () => {
    const { root, plan } = await setup();
    const item = one(await plan(), (i) => i.kind === 'duplicate');
    expect(item.tier).toBe('move');
    expect(item.recommended).toBe('approve');
    const edits = item.edits.approve ?? [];
    for (const repo of ['ops', 'shop']) {
      const file = join(root, repo, 'CLAUDE.md');
      expect(edits).toContainEqual(expect.objectContaining({ path: file, op: 'remove', before: 'hetzner box: 100.64.1.10' }));
      expect(edits).toContainEqual(expect.objectContaining({ path: file, op: 'append', after: '@~/dev/truth/hosts.md' }));
    }
  });

  it("the appended import follows the store's own view paths", async () => {
    const { root, home, scan } = await setup();
    const views = { hosts: 'infra/machines.md', services: 'services.md', projects: 'cards' };
    const built = await buildPlan({ scan, decisions: [], store: join(home, 'dev', 'truth'), home, now: NOW, views });
    const edits = one(built, (i) => i.kind === 'duplicate').edits.approve ?? [];
    expect(edits).toContainEqual(expect.objectContaining({ path: join(root, 'shop', 'CLAUDE.md'), op: 'append', after: '@~/dev/truth/infra/machines.md' }));
  });

  it('an agent file linked to a file that is not an agent file is still scanned, but plan proposes no edit there and says why', async () => {
    const { root, scan, plan } = await setup(async (r) => {
      const shop = join(r, 'shop');
      await mkdir(join(shop, 'scripts'));
      await rename(join(shop, 'CLAUDE.md'), join(shop, 'scripts', 'agent.sh'));
      await symlink('scripts/agent.sh', join(shop, 'CLAUDE.md'));
    });
    const link = join(root, 'shop', 'CLAUDE.md');
    expect(scan.facts.some((f) => f.at.path === link)).toBe(true);
    const built = await plan();
    const paths = built.items.flatMap((i) => Object.values(i.edits).flat().map((e) => e.path));
    expect(paths).not.toContain(link);
    expect(paths).not.toContain(join(root, 'shop', 'scripts', 'agent.sh'));
    expect(built.items.flatMap((i) => i.notes ?? []).join('\n')).toContain('shop/CLAUDE.md is a link to scripts/agent.sh, which is not an agent file, so plan proposes no edit there.');
  });

  it('stale 10.0.0.4 is a delete question', async () => {
    const { root, plan } = await setup();
    const item = one(await plan(), (i) => i.kind === 'stale');
    expect(item.options).toEqual(['delete', 'keep']);
    expect(item.recommended).toBe('delete');
    expect(item.edits.delete).toEqual([expect.objectContaining({ path: join(root, 'shop', 'CLAUDE.md'), line: 5, op: 'remove' })]);
  });

  describe('remembered line deletes', () => {
    const rewriteLine = async (root: string, from: string, to: string) => {
      const file = join(root, 'shop', 'CLAUDE.md');
      await writeFile(file, (await readFile(file, 'utf8')).replace(from, to));
    };
    const remember = (i: PlanItem): Decision => ({ key: i.key, kind: i.kind, subject: i.subject, candidates: i.candidates, answer: 'delete', decidedAt: NOW.toISOString() });
    const replan = async (fx: Awaited<ReturnType<typeof setup>>, decisions: Decision[]) => {
      const scan = await collectScan(fx.root, { home: fx.home, reposOnly: false, crontabCommand: 'false' });
      return buildPlan({ scan, decisions, store: join(fx.home, 'dev', 'truth'), home: fx.home, now: NOW });
    };

    it('a remembered stale delete does not apply to a new line with the same value', async () => {
      const fx = await setup();
      const decision = remember(one(await fx.plan(), (i) => i.kind === 'stale'));
      await rewriteLine(fx.root, 'old staging box 10.0.0.4', 'retired staging box 10.0.0.4');
      expect(one(await replan(fx, [decision]), (i) => i.kind === 'stale').answer).toBeNull();
    });

    it('a remembered duplicate delete does not apply when the duplicated line changes', async () => {
      const fx = await setup();
      const first = one(await fx.plan(), (i) => i.kind === 'duplicate');
      const decision = { ...remember(first), answer: 'approve' };
      await rewriteLine(fx.root, 'hetzner box: 100.64.1.10', 'hetzner box (primary): 100.64.1.10');
      expect(one(await replan(fx, [decision]), (i) => i.kind === 'duplicate').answer).toBeNull();
    });

    it('an unchanged line keeps its remembered stale answer', async () => {
      const fx = await setup();
      const decision = remember(one(await fx.plan(), (i) => i.kind === 'stale'));
      const item = one(await replan(fx, [decision]), (i) => i.kind === 'stale');
      expect(item.answer).toBe('delete');
      expect(item.answeredBy).toBe('remembered');
    });
  });

  it('secret item carries no line text and no secret', async () => {
    const { secret, plan } = await setup();
    const p = await plan();
    const item = one(p, (i) => i.tier === 'secret');
    expect(item.options).toEqual(['rotate-remove', 'false-positive']);
    expect(item.recommended).toBeUndefined();
    expect(item.subject).toBe('shop/AGENTS.md');
    const [edit] = item.edits['rotate-remove'] ?? [];
    expect(edit).toMatchObject({ line: 3, op: 'remove', secret: true });
    expect(edit?.lineHash).toMatch(/^[0-9a-f]{16}$/);
    expect(edit?.before).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain(secret);
  });

  it('hetzner ip and shop env are auto items', async () => {
    const p = await (await setup()).plan();
    const auto = p.items.filter((i) => i.tier === 'auto');
    expect(auto.map((i) => `${i.subject}=${i.candidates.join(',')}`).sort()).toEqual(['host:hetzner|ip=100.64.1.10', 'project:shop|env=DATABASE_URL']);
    expect(auto.every((i) => i.recommended === 'approve' && i.options.join() === 'approve,skip')).toBe(true);
  });

  it('a root package.json adds a command item per project', async () => {
    const { plan } = await setup((root) => writeFile(join(root, 'shop', 'package.json'), JSON.stringify({ scripts: { test: 'vitest', dev: 'next dev' } })));
    const item = one(await plan(), (i) => i.subject === 'project:shop|command');
    expect(item.tier).toBe('auto');
    expect(item.candidates).toEqual(['npm run dev', 'npm run test']);
  });

  it('a remembered decision answers the item', async () => {
    const { plan } = await setup();
    const key = decisionKey('conflict', 'project:shop|port', ['3000', '3300', '4000']);
    const item = one(await plan([{ key, kind: 'conflict', subject: 'project:shop|port', candidates: ['3000', '3300', '4000'], answer: '3300', decidedAt: NOW.toISOString() }]), (i) => i.key === key);
    expect(item.answer).toBe('3300');
    expect(item.answeredBy).toBe('remembered');
  });

  it('a changed candidate set asks again', async () => {
    const { plan } = await setup();
    const key = decisionKey('conflict', 'project:shop|port', ['3000', '3300']);
    const item = one(await plan([{ key, kind: 'conflict', subject: 'project:shop|port', candidates: ['3000', '3300'], answer: '3300', decidedAt: NOW.toISOString() }]), (i) => i.tier === 'conflict');
    expect(item.key).not.toBe(key);
    expect(item.answer).toBeNull();
  });

  it('a mixed agent line becomes a rewrite item', async () => {
    const { root, plan } = await setup((r) => appendFile(join(r, 'shop', 'CLAUDE.md'), 'shop runs on port 3000 behind nginx with gzip\n'));
    const p = await plan();
    const conflict = one(p, (i) => i.tier === 'conflict');
    const rewrite = one(p, (i) => i.kind === 'rewrite');
    expect(rewrite.tier).toBe('move');
    expect(rewrite.follows).toBe(conflict.key);
    expect(rewrite.options).toEqual(['accept', 'skip']);
    expect(rewrite.edits['3300']).toEqual([expect.objectContaining({ path: join(root, 'shop', 'CLAUDE.md'), op: 'replace', after: 'shop runs on port 3300 behind nginx with gzip' })]);
    expect(conflict.edits['3300']?.some((e) => e.path === join(root, 'shop', 'CLAUDE.md') && e.op !== 'append')).toBe(false);
  });

  it('two entities named web with no shared identifier is an identity question with no recommendation', async () => {
    const scan: ScanResult = {
      root: '/nowhere', scannedAt: NOW.toISOString(), repos: [], machineFilesRead: [], skipped: [],
      agentFileCounts: { claude: 0, agents: 0, gemini: 0, cursor: 0, copilot: 0 },
      entities: [
        { id: 'app:a', kind: 'app', names: ['web'], identifiers: { domain: 'a.example.com' } },
        { id: 'app:b', kind: 'app', names: ['web'], identifiers: { domain: 'b.example.com' } },
      ],
      facts: [], findings: [], agentTokens: 0, duplicatedTokens: 0, score: 100,
    };
    const plan = await buildPlan({ scan, decisions: [], store: '/nowhere/truth', home: '/nowhere/home', now: NOW });
    const item = one(plan, (i) => i.tier === 'identity');
    expect(item.options).toEqual(['same', 'different']);
    expect(item.candidates).toEqual(['app:a', 'app:b']);
    expect(item.recommended).toBeUndefined();
  });

  it('tiers come in spec order', async () => {
    const p = await (await setup()).plan();
    const order = ['auto', 'conflict', 'identity', 'move', 'secret'];
    const seen = p.items.map((i) => order.indexOf(i.tier));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(p.items.map((i) => i.tier))).toEqual(new Set(['auto', 'conflict', 'move', 'secret']));
  });
});
