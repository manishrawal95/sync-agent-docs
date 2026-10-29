import { execFileSync } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compiledDrift, compileTargets, isIgnoredOrUntracked } from '../src/compile/compile.js';
import { writeCompiledBlock } from '../src/compile/block.js';
import { CARD_NOTE, factsBody, HEADING, INTRO } from '../src/compile/content.js';
import { detectCompiledEdits } from '../src/compile/edits.js';
import { refusedLink } from '../src/compile/links.js';
import type { Store } from '../src/store/types.js';

async function setup(files: Record<string, string>) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'tf-drift-')));
  const repo = join(home, 'dev', 'shop');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const [f, text] of Object.entries(files)) await writeFile(join(repo, f), text);
  const store: Store = {
    config: { schema: 1, root: '~/dev', repos: [{ name: 'shop', path: '~/dev/shop' }], agentFormats: ['claude', 'agents', 'gemini', 'cursor', 'copilot'], views: { hosts: 'hosts.md', services: 'services.md', projects: 'projects' }, generated: {} },
    entities: [{ id: 'project:shop', kind: 'project', names: ['shop'], identifiers: {}, notes: '' }],
    facts: [{ entityId: 'project:shop', attribute: 'port', value: '3300', sources: [], status: 'verified' }],
    secrets: [], decisions: [],
  };
  return { home, repo, store, ctx: { storeDir: join(home, 'truth'), home } };
}

async function writeNext(repo: string, store: Store, ctx: { storeDir: string; home: string }) {
  for (const t of (await compileTargets(repo, store, ctx)).targets) {
    await mkdir(join(t.path, '..'), { recursive: true });
    await writeFile(t.path, t.next);
  }
}

describe('compiledDrift', () => {
  it('reports an agent file with no block as missing, and nothing once compiled', async () => {
    const { repo, store, ctx } = await setup({ 'CLAUDE.md': '# Shop\n' });
    expect(await compiledDrift(repo, store, ctx)).toEqual([{ file: join(repo, 'CLAUDE.md'), kind: 'missing' }]);
    await writeNext(repo, store, ctx);
    expect(await compiledDrift(repo, store, ctx)).toEqual([]);
    expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toContain('@~/truth/projects/shop.md');
  });

  it('reports a hand edit inside the block as edited', async () => {
    const { repo, store, ctx } = await setup({ 'CLAUDE.md': '# Shop\n' });
    await writeNext(repo, store, ctx);
    const text = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    await writeFile(join(repo, 'CLAUDE.md'), text.replace('| `3300` |', '| `3301` |'));
    expect(await compiledDrift(repo, store, ctx)).toEqual([{ file: join(repo, 'CLAUDE.md'), kind: 'edited' }]);
  });

  it('reports an intact block as stale once the store changes', async () => {
    const { repo, store, ctx } = await setup({ 'CLAUDE.md': '# Shop\n' });
    await writeNext(repo, store, ctx);
    store.facts = store.facts.map((f) => ({ ...f, value: '3400' }));
    expect(await compiledDrift(repo, store, ctx)).toEqual([{ file: join(repo, 'CLAUDE.md'), kind: 'stale' }]);
  });

  it('reports a configured format whose file is absent as missing, and leaves unconfigured absent files alone', async () => {
    const { repo, store, ctx } = await setup({});
    store.config.repos = [{ name: 'shop', path: '~/dev/shop', formats: ['agents'] }];
    expect(await compiledDrift(repo, store, ctx)).toEqual([{ file: join(repo, 'AGENTS.md'), kind: 'missing' }]);
  });

  it('only compiles formats sync-agent-docs.json allows', async () => {
    const { repo, store, ctx } = await setup({ 'CLAUDE.md': '# Shop\n', 'GEMINI.md': '# G\n' });
    store.config.agentFormats = ['gemini'];
    expect((await compileTargets(repo, store, ctx)).targets.map((t) => t.format)).toEqual(['gemini']);
  });

  it('reports a broken block as edited and refuses to compile it, naming the file', async () => {
    const { repo, store, ctx } = await setup({ 'CLAUDE.md': '<!-- sync-agent-docs:begin compiled -->\nhalf\n' });
    expect(await compiledDrift(repo, store, ctx)).toEqual([{ file: join(repo, 'CLAUDE.md'), kind: 'edited' }]);
    await expect(compileTargets(repo, store, ctx)).rejects.toThrow(/CLAUDE\.md.*compiled has no end marker/);
  });

  it('never targets an agent file linked to a file outside the repo', async () => {
    const { home, repo, store, ctx } = await setup({});
    await writeFile(join(home, 'shared.md'), '# Shared\n');
    await symlink(join(home, 'shared.md'), join(repo, 'CLAUDE.md'));
    const { targets, notes } = await compileTargets(repo, store, ctx);
    expect(targets).toEqual([]);
    expect(notes.join('\n')).toMatch(/CLAUDE\.md.*outside the repo/);
    expect(await compiledDrift(repo, store, ctx)).toEqual([
      { file: join(repo, 'CLAUDE.md'), kind: 'skipped', reason: `it is a link to ${join(home, 'shared.md')}, outside the repo, so compile leaves it alone` },
    ]);
  });

  it('an agent-file link to a file that is not an agent file is skipped, never targeted, and the file is untouched', async () => {
    for (const [dest, setupDest] of [
      ['scripts/deploy.sh', async (repo: string) => { await mkdir(join(repo, 'scripts')); await writeFile(join(repo, 'scripts', 'deploy.sh'), '#!/bin/sh\n'); }],
      ['.git/config', async () => undefined],
    ] as const) {
      const { repo, store, ctx } = await setup({});
      await setupDest(repo);
      const before = await readFile(join(repo, dest));
      await symlink(dest, join(repo, 'CLAUDE.md'));
      const { targets, notes } = await compileTargets(repo, store, ctx);
      expect(targets.map((t) => t.path)).not.toContain(join(repo, dest));
      expect(notes.join('\n')).toContain(`CLAUDE.md is a link to ${dest}, which is not an agent file`);
      expect(await compiledDrift(repo, store, ctx)).toContainEqual({ file: join(repo, 'CLAUDE.md'), kind: 'skipped', reason: `it is a link to ${dest}, which is not an agent file, so compile leaves it alone` });
      expect(await readFile(join(repo, dest))).toEqual(before);
    }
  });

  it('a CLAUDE.md linked to AGENTS.md in the repo is one target: AGENTS.md, with the card import, and a note naming the link', async () => {
    const { repo, store, ctx } = await setup({ 'AGENTS.md': '# Agents\n' });
    await symlink('AGENTS.md', join(repo, 'CLAUDE.md'));
    const { targets, notes } = await compileTargets(repo, store, ctx);
    expect(targets.map((t) => t.path)).toEqual([join(repo, 'AGENTS.md')]);
    expect(targets[0]?.next).toContain('@~/truth/projects/shop.md');
    expect(notes.join('\n')).toMatch(/CLAUDE\.md is a link to AGENTS\.md/);
    expect(await compiledDrift(repo, store, ctx)).toEqual([{ file: join(repo, 'AGENTS.md'), kind: 'missing' }]);
  });

  it('with only claude allowed, a CLAUDE.md linked to AGENTS.md writes AGENTS.md and says so', async () => {
    const { repo, store, ctx } = await setup({ 'AGENTS.md': '# Agents\n' });
    store.config.agentFormats = ['claude'];
    await symlink('AGENTS.md', join(repo, 'CLAUDE.md'));
    const { targets, notes } = await compileTargets(repo, store, ctx);
    expect(targets.map((t) => t.path)).toEqual([join(repo, 'AGENTS.md')]);
    expect(notes.join('\n')).toContain('CLAUDE.md is a link to AGENTS.md, so compile wrote the block into AGENTS.md only and kept the link.');
  });

  it('a hand-made copy of the block above the real one is edited, not stale, and compile refuses it', async () => {
    const { repo, store, ctx } = await setup({ 'CLAUDE.md': '# Shop\n' });
    await writeNext(repo, store, ctx);
    const text = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const block = text.slice(text.indexOf('<!-- sync-agent-docs:begin'));
    await writeFile(join(repo, 'CLAUDE.md'), `# Shop\n\n${block.replace('| `3300` |', '| `3301` |')}\n${block}`);
    expect(await compiledDrift(repo, store, ctx)).toEqual([{ file: join(repo, 'CLAUDE.md'), kind: 'edited' }]);
    await expect(compileTargets(repo, store, ctx)).rejects.toThrow(/CLAUDE\.md.*appears twice/);
  });

  it('a dangling agent-file link is a note and a skip, and the other files still count', async () => {
    const { home, repo, store, ctx } = await setup({ 'AGENTS.md': '# Shop\n' });
    await writeNext(repo, store, ctx);
    const text = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    await writeFile(join(repo, 'AGENTS.md'), text.replace('| `3300` |', '| `3301` |'));
    await symlink('gone.md', join(repo, 'CLAUDE.md'));
    const { targets, notes } = await compileTargets(repo, store, ctx);
    expect(targets.map((t) => t.path)).toEqual([join(repo, 'AGENTS.md')]);
    expect(notes.join('\n')).toMatch(/CLAUDE\.md is a link to gone\.md, which does not exist, so compile skipped it/);
    expect(await compiledDrift(repo, store, ctx)).toEqual([
      { file: join(repo, 'CLAUDE.md'), kind: 'skipped', reason: 'it is a link to gone.md, which does not exist, so compile leaves it alone' },
      { file: join(repo, 'AGENTS.md'), kind: 'edited' },
    ]);
    const items = await detectCompiledEdits(home, store, ctx);
    expect(items.map((i) => i.subject)).toEqual(['dev/shop/AGENTS.md']);
  });

  it('plan skips a listed repo whose folder is gone, and nothing else', async () => {
    const { home, store, ctx } = await setup({});
    store.config.repos.push({ name: 'gone', path: '~/dev/gone' });
    expect(await detectCompiledEdits(home, store, ctx)).toEqual([]);
  });

  it('with a git checker, a file compile would leave alone is skipped with a reason; without one, nothing is', async () => {
    const { repo, store, ctx } = await setup({ 'CLAUDE.md': '# Shop\n', 'AGENTS.md': '# Shop\n', 'GEMINI.md': '# Shop\n', '.gitignore': 'CLAUDE.md\n' });
    execFileSync('git', ['add', 'GEMINI.md', '.gitignore'], { cwd: repo });
    const plain = await compiledDrift(repo, store, ctx);
    expect(plain.map((d) => d.kind)).toEqual(['missing', 'missing', 'missing']);
    const checked = await compiledDrift(repo, store, { ...ctx, isIgnoredOrUntracked });
    const reason = 'git ignores or does not track it, so compile leaves it alone';
    expect(checked).toEqual([
      { file: join(repo, 'CLAUDE.md'), kind: 'skipped', reason },
      { file: join(repo, 'AGENTS.md'), kind: 'skipped', reason },
      { file: join(repo, 'GEMINI.md'), kind: 'missing' },
    ]);
    expect(await isIgnoredOrUntracked(join(repo, '.cursor', 'rules', 'sync-agent-docs.mdc'))).toBe(false);
  });

  it('a CLAUDE.md of its own with the card import outside the block gets no project section', async () => {
    const { repo, store, ctx } = await setup({ 'CLAUDE.md': '# Shop\n\n@~/truth/projects/shop.md\n' });
    const [t] = (await compileTargets(repo, store, ctx)).targets;
    expect(t?.next).not.toContain('| port | `3300` |');
    expect(t?.next).toContain(CARD_NOTE);
  });

  it('a link loop at an agent file whose format is off does not stop compile', async () => {
    const { repo, store, ctx } = await setup({ 'CLAUDE.md': '# Shop\n\n@~/truth/projects/shop.md\n' });
    store.config.agentFormats = ['claude', 'agents', 'cursor', 'copilot'];
    await symlink('GEMINI.md', join(repo, 'GEMINI.md'));
    const [t] = (await compileTargets(repo, store, ctx)).targets;
    expect(t?.next).toContain(CARD_NOTE);
    expect(t?.next).not.toContain('| port | `3300` |');
  });

  it('a CLAUDE.md linked to AGENTS.md keeps the project section even with the import outside', async () => {
    const { repo, store, ctx } = await setup({ 'AGENTS.md': '# Agents\n\n@~/truth/projects/shop.md\n' });
    await symlink('AGENTS.md', join(repo, 'CLAUDE.md'));
    const [t] = (await compileTargets(repo, store, ctx)).targets;
    expect(t?.path).toBe(join(repo, 'AGENTS.md'));
    expect(t?.next).toContain('| port | `3300` |');
  });

  it('with only claude allowed, an AGENTS.md linked to CLAUDE.md still counts as shared', async () => {
    const { repo, store, ctx } = await setup({ 'CLAUDE.md': '# Shop\n\n@~/truth/projects/shop.md\n' });
    store.config.agentFormats = ['claude'];
    await symlink('CLAUDE.md', join(repo, 'AGENTS.md'));
    const [t] = (await compileTargets(repo, store, ctx)).targets;
    expect(t?.next).toContain('| port | `3300` |');
  });

  it('a CLAUDE.md hard-linked to AGENTS.md keeps the project section even with the import outside', async () => {
    const { repo, store, ctx } = await setup({ 'CLAUDE.md': '# Shop\n\n@~/truth/projects/shop.md\n' });
    await link(join(repo, 'CLAUDE.md'), join(repo, 'AGENTS.md'));
    const [t] = (await compileTargets(repo, store, ctx)).targets;
    expect(t?.next).toContain('| port | `3300` |');
  });

  it('an agent file path compile cannot stat does not stop a CLAUDE.md that has no card import outside', async () => {
    const { repo, store, ctx } = await setup({ 'CLAUDE.md': '# Shop\n' });
    await mkdir(join(repo, '.cursor'));
    store.config.agentFormats = ['claude'];
    await chmod(join(repo, '.cursor'), 0o000);
    try {
      const [t] = (await compileTargets(repo, store, ctx)).targets;
      expect(t?.next).toContain('| port | `3300` |');
    } finally {
      await chmod(join(repo, '.cursor'), 0o755);
    }
  });

  it('a block written before the trim is stale once, and clean after compile rewrites it', async () => {
    const { repo, store, ctx } = await setup({});
    const old = [HEADING, INTRO, factsBody(store, ['project:shop'])].join('\n\n');
    await writeFile(join(repo, 'CLAUDE.md'), writeCompiledBlock('# Shop\n\n@~/truth/projects/shop.md\n', old));
    expect(await compiledDrift(repo, store, ctx)).toEqual([{ file: join(repo, 'CLAUDE.md'), kind: 'stale' }]);
    await writeNext(repo, store, ctx);
    expect(await compiledDrift(repo, store, ctx)).toEqual([]);
  });
});

describe('refusedLink', () => {
  it('lets a file be written through a link only when it lands on an agent file, or a same-named machine file outside .git', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'tf-links-')));
    const repo = join(home, 'dev', 'cfg');
    await mkdir(join(repo, 'claude-config'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    await writeFile(join(repo, 'AGENTS.md'), '# a\n');
    await writeFile(join(repo, 'claude-config', 'CLAUDE.md'), '# machine\n');
    await mkdir(join(home, '.claude'));
    await symlink(join(repo, 'claude-config', 'CLAUDE.md'), join(home, '.claude', 'CLAUDE.md'));
    await symlink('AGENTS.md', join(repo, 'CLAUDE.md'));
    await symlink('claude-config/CLAUDE.md', join(repo, 'GEMINI.md'));
    await mkdir(join(home, '.gemini'));
    await symlink(join(repo, '.git', 'config'), join(home, '.gemini', 'config'));
    expect(await refusedLink(join(home, '.claude', 'CLAUDE.md'), 'plan')).toBeNull();
    expect(await refusedLink(join(repo, 'CLAUDE.md'), 'plan')).toBeNull();
    expect(await refusedLink(join(repo, 'AGENTS.md'), 'plan')).toBeNull();
    expect(await refusedLink(join(repo, 'GEMINI.md'), 'plan')).toMatchObject({ target: join('claude-config', 'CLAUDE.md'), inRepo: true });
    expect(await refusedLink(join(home, '.gemini', 'config'), 'plan')).toMatchObject({ inRepo: false });
  });
});
