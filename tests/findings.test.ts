import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeFindings, entityName, tokensOf } from '../src/compare/findings.js';
import { scoreOf } from '../src/compare/score.js';
import { collectScan } from '../src/scan.js';
import type { Fact, Finding } from '../src/types.js';
import { materializeFixture } from './helpers/fixture.js';

const NO_CRONTAB = 'sync-agent-docs-test-no-crontab';

/** Stale env names for a one-repo scan; `.env` makes the repo env-checkable. */
async function staleEnvNames(files: Record<string, string>): Promise<string[]> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-env-')));
  const repo = join(home, 'dev', 'app');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(repo, rel, '..'), { recursive: true });
    await writeFile(join(repo, rel), text);
  }
  const result = await collectScan(join(home, 'dev'), { home, reposOnly: false, crontabCommand: NO_CRONTAB });
  return result.findings.filter((f) => f.type === 'stale' && f.attribute === 'env').flatMap((f) => f.values?.map((v) => v.value) ?? []);
}

async function scanFixture() {
  const fx = await materializeFixture('messy-dev');
  return { ...fx, result: await collectScan(fx.root, { home: fx.home, reposOnly: false, crontabCommand: NO_CRONTAB }) };
}

/** A finding in the shape of messy-dev.expected.json. */
function summarize(f: Finding, root: string): Record<string, unknown> {
  const files = [...new Set((f.at ?? []).map((a) => relative(root, a.path)))].sort();
  switch (f.type) {
    case 'conflict': case 'possible-conflict':
      return { type: f.type, entity: entityName(f.entityId ?? ''), attribute: f.attribute, values: f.values?.map((v) => v.value).sort() };
    case 'global-local':
      return { type: f.type, entity: entityName(f.entityId ?? ''), attribute: f.attribute, value: f.values?.[0]?.value };
    case 'stale':
      return { type: f.type, attribute: f.attribute, value: f.values?.[0]?.value };
    case 'duplicated':
      return { type: f.type, entity: entityName(f.entityId ?? ''), attribute: f.attribute, value: f.values?.[0]?.value, files };
    case 'secret':
      return { type: f.type, files };
  }
}

const fact = (value: string, path: string, over: Partial<Fact> = {}): Fact => ({
  attribute: 'port', value, at: { path, line: 1 }, lineText: `shop port ${value}`,
  kind: 'claim', scope: 'repo', agent: null, entityId: 'project:shop', ...over,
});

describe('computeFindings', () => {
  it('fixture yields exactly the expected findings', async () => {
    const { root, result } = await scanFixture();
    const expected = JSON.parse(await readFile(new URL('./fixtures/messy-dev.expected.json', import.meta.url), 'utf8')) as { findings: unknown[] };
    expect(result.findings.map((f) => summarize(f, root))).toEqual(expected.findings);
  });

  it('two docs disagreeing with no truth value is a possible-conflict', async () => {
    const { findings } = await computeFindings({ facts: [fact('3000', '/a/README.md'), fact('3001', '/a/docs.md')], corpus: new Set(), secrets: [], agentLines: [] });
    expect(findings.map((f) => f.type)).toEqual(['possible-conflict']);
  });

  it('a dev port and a start port both from config are not a conflict', async () => {
    const truth = { kind: 'truth' as const };
    const facts = [fact('3000', '/a/package.json', truth), fact('3300', '/a/ecosystem.config.cjs', truth), fact('3300', '/a/README.md')];
    expect((await computeFindings({ facts, corpus: new Set(), secrets: [], agentLines: [] })).findings).toEqual([]);
    const off = await computeFindings({ facts: [...facts, fact('3001', '/a/docs.md')], corpus: new Set(), secrets: [], agentLines: [] });
    expect(off.findings.map((f) => [f.type, f.values?.map((v) => v.value)])).toEqual([['conflict', ['3000', '3300', '3001']]]);
  });

  it('a machine claim alone with a matching repo value raises nothing', async () => {
    const { findings } = await computeFindings({ facts: [fact('3000', '/a/README.md'), fact('3000', '/h/CLAUDE.md', { scope: 'machine' })], corpus: new Set(), secrets: [], agentLines: [] });
    expect(findings).toEqual([]);
  });

  it('score of the fixture', async () => {
    const { result } = await scanFixture();
    // conflict 6 + global-local 6 + stale 3 + secret 10; duplicated line "hetzner box: 100.64.1.10" is 6 tokens.
    expect(result.duplicatedTokens).toBe(tokensOf('hetzner box: 100.64.1.10'));
    expect(result.score).toBe(100 - 6 - 6 - 3 - 10 - Math.round((20 * 6) / result.agentTokens));
    expect(result.score).toBe(scoreOf(result.findings, result.agentTokens, result.duplicatedTokens));
    expect(result.score).toBe(73);
  });

  it('0.0.0.0/0 and 127.0.0.1 never appear as stale', async () => {
    const { result } = await scanFixture();
    const staleValues = result.findings.filter((f) => f.type === 'stale').flatMap((f) => f.values?.map((v) => v.value) ?? []);
    expect(staleValues).toEqual(['10.0.0.4']);
  });

  it('a path that exists on disk is not stale', async () => {
    const { home } = await materializeFixture('messy-dev');
    const facts = [fact('~/.ssh/config', '/a/README.md', { attribute: 'path', entityId: null }), fact('~/.ssh/gone', '/a/README.md', { attribute: 'path', entityId: null })];
    const { findings } = await computeFindings({ facts, corpus: new Set(), secrets: [], agentLines: [], home });
    expect(findings.map((f) => f.values?.[0]?.value)).toEqual(['~/.ssh/gone']);
  });

  it('a path outside home and the scan root, or a ~/ path with no top folder here, is never stale (it may live on a server)', async () => {
    const facts = ['/opt/specter', '/root/app/.env', '/r/gone', '~/gone', '~/bin/cron.sh'].map((v) => fact(v, '/r/a/README.md', { attribute: 'path', entityId: null }));
    const { findings } = await computeFindings({ facts, corpus: new Set(), secrets: [], agentLines: [], home: '/h', root: '/r' });
    expect(findings.map((f) => f.values?.[0]?.value)).toEqual(['/r/gone']);
  });

  it('an env name is stale only when its repo lists env names', async () => {
    const env = (value: string, path: string, over: Partial<Fact> = {}) => fact(value, path, { attribute: 'env', entityId: null, ...over });
    const facts = [
      env('FOO_KEY', '/r/a/.env', { kind: 'truth' }),
      env('BAR_KEY', '/r/a/README.md'),
      env('BAZ_KEY', '/r/b/README.md'),
      env('QUX_KEY', '/h/.claude/CLAUDE.md', { scope: 'machine' }),
    ];
    const repos = [{ name: 'a', path: '/r/a' }, { name: 'b', path: '/r/b' }];
    const { findings } = await computeFindings({ facts, corpus: new Set(), secrets: [], agentLines: [], home: '/h', root: '/r', repos });
    expect(findings.map((f) => f.values?.[0]?.value)).toEqual(['BAR_KEY']);
  });

  it('a name assigned inline in a package.json script is not stale', async () => {
    const stale = await staleEnvNames({
      '.env': 'DB_URL=x\n',
      'package.json': '{"name":"app","scripts":{"dev":"NEXT_TELEMETRY_DISABLED=1 next dev"}}',
      'README.md': '# app\n\nSet NEXT_TELEMETRY_DISABLED=1 to opt out.\n',
    });
    expect(stale).toEqual([]);
  });

  it('runtime names are never stale', async () => {
    const names = ['NODE_ENV', 'PORT', 'CI', 'PATH', 'HOME', 'PWD', 'SHELL', 'USER', 'TZ'];
    const stale = await staleEnvNames({ '.env': 'DB_URL=x\n', 'README.md': '# app\n\n' + names.map((n) => `${n}=1`).join('\n') + '\n' });
    expect(stale).toEqual([]);
  });

  it('a name a workflow reads as secrets.NAME is not stale', async () => {
    const stale = await staleEnvNames({
      '.env': 'DB_URL=x\n',
      '.github/workflows/deploy.yml': 'jobs:\n  d:\n    steps:\n      - with:\n          token: ${{ secrets.DEPLOY_HOOK }}\n',
      'README.md': '# app\n\nSet DEPLOY_HOOK=1 in CI.\n',
    });
    expect(stale).toEqual([]);
  });

  it('a workflow file alone does not make a repo env-checkable', async () => {
    const stale = await staleEnvNames({
      '.github/workflows/deploy.yml': 'token: ${{ secrets.DEPLOY_HOOK }}\n',
      'README.md': '# app\n\nSet OTHER_NAME=1 and DEPLOY_HOOK=1.\n',
    });
    expect(stale).toEqual([]);
  });

  it('score never drops below 0', () => {
    expect(scoreOf(Array.from({ length: 20 }, () => ({ type: 'secret', message: '' }) as Finding), 10, 10)).toBe(0);
  });

  it("a host's second IP in a doc is a possible conflict, never a scored conflict", async () => {
    const host = { entityId: 'host:box', attribute: 'ip' as const };
    const ssh = fact('100.64.1.2', '/h/.ssh/config', { ...host, kind: 'truth', scope: 'machine' });
    for (const scope of ['repo', 'machine'] as const) {
      const { findings } = await computeFindings({ facts: [ssh, fact('89.0.0.9', '/r/ops/hosts.md', { ...host, scope })], corpus: new Set(['89.0.0.9']), secrets: [], agentLines: [] });
      expect(findings.map((f) => f.type)).toEqual(['possible-conflict']);
    }
  });

  it('a linked IP no config knows is still stale', async () => {
    const host = { entityId: 'host:box', attribute: 'ip' as const };
    const facts = [fact('100.64.1.2', '/h/.ssh/config', { ...host, kind: 'truth', scope: 'machine' }), fact('10.0.0.4', '/r/ops/hosts.md', host)];
    const { findings } = await computeFindings({ facts, corpus: new Set(), secrets: [], agentLines: [] });
    expect(findings.map((f) => f.type)).toEqual(['possible-conflict', 'stale']);
  });

  it('under repos-only the stale message claims only what was checked', async () => {
    const facts = [fact('/r/gone', '/r/README.md', { attribute: 'path', entityId: null })];
    const machine = await computeFindings({ facts, corpus: new Set(), secrets: [], agentLines: [], root: '/r' });
    const repos = await computeFindings({ facts, corpus: new Set(), secrets: [], agentLines: [], root: '/r', reposOnly: true });
    expect(machine.findings[0]?.message).toContain('nothing on this machine uses it');
    expect(repos.findings[0]?.message).toBe('path /r/gone is in your docs but in no scanned repo config');
  });

  it('a path it cannot read is noted, not called stale', async () => {
    const { root } = await materializeFixture('messy-dev');
    const locked = join(root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const facts = [fact(join(locked, 'x'), join(root, 'README.md'), { attribute: 'path', entityId: null })];
      const { findings, skipped } = await computeFindings({ facts, corpus: new Set(), secrets: [], agentLines: [], root });
      expect(findings).toEqual([]);
      expect(skipped).toEqual([{ path: join(locked, 'x'), reason: 'unreadable', note: 'EACCES' }]);
    } finally {
      await chmod(locked, 0o755);
    }
  });
});
