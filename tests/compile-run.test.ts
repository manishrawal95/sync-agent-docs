import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApplyEntry } from '../src/apply/branches.js';
import { runRollback } from '../src/apply/rollback.js';
import { runApply } from '../src/apply/run.js';
import { readCompiledBlock } from '../src/compile/block.js';
import { compiledEditKey } from '../src/compile/compile.js';
import { runCompile } from '../src/compile/run.js';
import { rememberDecisions } from '../src/plan/decisions.js';
import { runPlan } from '../src/plan/run.js';
import { materializeFixture } from './helpers/fixture.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const LATER = new Date('2026-10-22T12:05:00.000Z');
const LAST = new Date('2026-10-22T12:10:00.000Z');
const BRANCH = 'sync-agent-docs/compile-20261022-120500';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd: string, msg: string) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', msg);
};
const merge = (entry: ApplyEntry | null) => {
  for (const r of entry?.repos ?? []) {
    git(r.path, 'switch', '-q', r.original);
    git(r.path, 'merge', '-q', '--ff-only', r.branch);
  }
};

/** The fixture planned, applied and merged by hand, the way a person would before running compile. */
async function merged() {
  const fx = await materializeFixture('messy-dev', { commit: true });
  const store = join(fx.home, 'truth');
  const plan = await runPlan(fx.root, { home: fx.home, reposOnly: false, crontabCommand: 'false', store, now: NOW });
  for (const i of plan.items) i.answer = i.tier === 'secret' ? 'rotate-remove' : i.follows ? 'accept' : (i.recommended ?? null);
  await writeFile(join(fx.root, '.sync-agent-docs', 'plan.json'), JSON.stringify(plan));
  merge(await runApply(fx.root, { home: fx.home, now: NOW }));
  const compile = (now = LATER) => runCompile(fx.root, { home: fx.home, now });
  return { ...fx, store, compile };
}

/** A store change compile must carry into shop's agent files: a new shop port. */
async function changeStore(store: string, value = '4400') {
  const path = join(store, 'store', 'facts.json');
  const facts = JSON.parse(await readFile(path, 'utf8')) as { facts: unknown[] };
  facts.facts.push({ entityId: 'project:shop', attribute: 'port', value, sources: [], status: 'verified' });
  await writeFile(path, JSON.stringify(facts, null, 2));
  commit(store, `port ${value}`);
}

const branches = (root: string) => ['ops', 'shop', 'blog'].map((r) => git(join(root, r), 'branch', '--list', 'sync-agent-docs/compile-*')).join('');

describe('compile', () => {
  it('compile writes blocks on a new branch, leaves main alone, and finds nothing to do once merged', async () => {
    const { root, store, compile } = await merged();
    await changeStore(store);
    const shop = join(root, 'shop');
    const main = git(shop, 'rev-parse', 'main');
    const { entry } = await compile();
    expect(entry?.kind).toBe('compile');
    expect(git(shop, 'rev-parse', 'main')).toBe(main);
    expect(git(shop, 'show', `${BRANCH}:CLAUDE.md`)).toContain('| port | `4400` | verified |');
    expect(git(shop, 'show', `${BRANCH}:AGENTS.md`)).toContain('| port | `4400` | verified |');
    expect(git(shop, 'log', '-1', '--format=%s', BRANCH)).toBe('chore(sync-agent-docs): compile agent blocks');
    merge(entry);
    expect((await compile(LAST)).entry).toBeNull();
  });

  it('rollback deletes the branches compile made', async () => {
    const { root, store, compile } = await merged();
    await changeStore(store);
    const { entry } = await compile();
    await runRollback(root);
    for (const r of entry?.repos ?? []) {
      expect(git(r.path, 'branch', '--list', BRANCH)).toBe('');
      expect(git(r.path, 'symbolic-ref', '--short', 'HEAD')).toBe(r.original);
    }
  });

  it('compile refuses a dirty repo by name before writing anything', async () => {
    const { root, store, compile } = await merged();
    await changeStore(store);
    await appendFile(join(root, 'shop', 'README.md'), 'wip\n');
    await expect(compile()).rejects.toThrow(/compile: .*shop has uncommitted changes/);
    expect(branches(root)).toBe('');
  });

  it('an untracked file of your own does not stop compile and is left alone', async () => {
    const { root, store, compile } = await merged();
    await changeStore(store);
    const shop = join(root, 'shop');
    await writeFile(join(shop, 'notes.txt'), 'wip\n');
    const { entry } = await compile();
    expect(git(shop, 'show', `${BRANCH}:CLAUDE.md`)).toContain('`4400`');
    await runRollback(root);
    expect(await readFile(join(shop, 'notes.txt'), 'utf8')).toBe('wip\n');
    expect(entry?.repos.map((r) => r.path)).toContain(shop);
  });

  it('compile leaves an untracked file it would write alone, now that untracked files no longer stop it', async () => {
    const { root, store, compile } = await merged();
    await changeStore(store);
    const agents = join(root, 'shop', 'AGENTS.md');
    git(join(root, 'shop'), 'rm', '-q', '--cached', 'AGENTS.md');
    git(join(root, 'shop'), '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'untrack AGENTS.md');
    await writeFile(agents, 'my own notes\n');
    const { notes } = await compile();
    expect(notes).toContain('shop/AGENTS.md was left alone: git does not track it. Commit it to have compile keep it.');
    expect(await readFile(agents, 'utf8')).toBe('my own notes\n');
    await runRollback(root);
    expect(await readFile(agents, 'utf8')).toBe('my own notes\n');
  });

  it('compile refuses a hand edit inside a block, naming the file and pointing at plan', async () => {
    const { root, store, compile } = await merged();
    await changeStore(store);
    merge((await compile()).entry);
    const path = join(root, 'shop', 'CLAUDE.md');
    const edited = (await readFile(path, 'utf8')).replace('| port | `4400` |', '| port | `4401` |');
    await writeFile(path, edited);
    commit(join(root, 'shop'), 'hand edit');
    await changeStore(store, '4500');
    await expect(compile(LAST)).rejects.toThrow(/shop\/CLAUDE\.md[\s\S]*sync-agent-docs plan/);
    expect(await readFile(path, 'utf8')).toBe(edited);
    expect(git(join(root, 'shop'), 'branch', '--list', 'sync-agent-docs/compile-20261022-121000')).toBe('');
  });

  it('a remembered discard lets compile overwrite the edit, and keep leaves the file alone', async () => {
    for (const answer of ['discard', 'keep']) {
      const { root, home, store, compile } = await merged();
      await changeStore(store);
      merge((await compile()).entry);
      const path = join(root, 'shop', 'CLAUDE.md');
      const edited = (await readFile(path, 'utf8')).replace('| port | `4400` |', '| port | `4401` |');
      await writeFile(path, edited);
      commit(join(root, 'shop'), 'hand edit');
      const block = readCompiledBlock(edited);
      if (!block) throw new Error('no block');
      const { key, subject } = compiledEditKey(path, block, root, home);
      await rememberDecisions(root, [{ key, kind: 'compiled-edit', subject, candidates: [block.actual], answer, decidedAt: LATER.toISOString() }]);
      await changeStore(store, '4500');
      const { entry, notes } = await compile(LAST);
      const shopBranch = entry?.repos.find((r) => r.path === join(root, 'shop'))?.branch;
      if (answer === 'discard') {
        expect(git(join(root, 'shop'), 'show', `${shopBranch}:CLAUDE.md`)).toContain('| port | `4500` |');
      } else {
        expect(await readFile(path, 'utf8')).toBe(edited);
        expect(notes.join('\n')).toMatch(/CLAUDE\.md.*kept/);
      }
    }
  });

  it('compile skips an agent file git ignores, with a note', async () => {
    const { root, store, compile } = await merged();
    const blog = join(root, 'blog');
    await writeFile(join(blog, '.gitignore'), 'AGENTS.md\n');
    await writeFile(join(blog, 'AGENTS.md'), '# Agents\n');
    commit(blog, 'ignore agents');
    await changeStore(store);
    const { notes } = await compile();
    expect(notes.join('\n')).toMatch(/blog\/AGENTS\.md.*ignores/);
    expect(await readFile(join(blog, 'AGENTS.md'), 'utf8')).toBe('# Agents\n');
  });

  it('compile never writes through a CLAUDE.md linked outside its repo', async () => {
    const { root, home, store, compile } = await merged();
    const blog = join(root, 'blog');
    await writeFile(join(home, 'shared.md'), '# Shared\n');
    await rm(join(blog, 'CLAUDE.md'));
    await symlink(join(home, 'shared.md'), join(blog, 'CLAUDE.md'));
    commit(blog, 'share');
    await changeStore(store);
    const { notes } = await compile();
    expect(notes.join('\n')).toMatch(/blog\/CLAUDE\.md is a link/);
    expect(await readFile(join(home, 'shared.md'), 'utf8')).toBe('# Shared\n');
  });

  it('compile keeps a CLAUDE.md that links to AGENTS.md a link, and writes the block once into AGENTS.md', async () => {
    const { root, store, compile } = await merged();
    const blog = join(root, 'blog');
    await rm(join(blog, 'CLAUDE.md'));
    await writeFile(join(blog, 'AGENTS.md'), '# blog\n');
    await symlink('AGENTS.md', join(blog, 'CLAUDE.md'));
    commit(blog, 'one agent file');
    await changeStore(store);
    const { entry, notes } = await compile();
    expect(entry?.repos.map((r) => r.path)).toContain(blog);
    expect(git(blog, 'ls-tree', BRANCH, 'CLAUDE.md')).toMatch(/^120000 /);
    expect(git(blog, 'show', `${BRANCH}:AGENTS.md`)).toContain('@~/truth/projects/blog.md');
    expect(notes.join('\n')).toMatch(/blog\/CLAUDE\.md is a link to AGENTS\.md/);
  });

  it('compile follows an agent-file link only to another agent file, leaving scripts and .git alone', async () => {
    const { root, store, compile } = await merged();
    const blog = join(root, 'blog');
    await mkdir(join(blog, 'scripts'));
    const deploy = '#!/bin/sh\necho deploy\n';
    await writeFile(join(blog, 'scripts', 'deploy.sh'), deploy);
    await rm(join(blog, 'CLAUDE.md'));
    await symlink('scripts/deploy.sh', join(blog, 'CLAUDE.md'));
    await symlink('.git/config', join(blog, 'AGENTS.md'));
    commit(blog, 'odd links');
    const config = await readFile(join(blog, '.git', 'config'));
    await changeStore(store);
    const { notes } = await compile();
    expect(await readFile(join(blog, 'scripts', 'deploy.sh'), 'utf8')).toBe(deploy);
    expect(await readFile(join(blog, '.git', 'config'))).toEqual(config);
    const text = notes.join('\n');
    expect(text).toMatch(/blog\/CLAUDE\.md is a link to scripts\/deploy\.sh, which is not an agent file, so compile left it alone/);
    expect(text).toMatch(/blog\/AGENTS\.md is a link to \.git\/config, which is not an agent file, so compile left it alone/);
  });

  it('compile keeps the file mode of an agent file it rewrites', async () => {
    const { root, store, compile } = await merged();
    const blog = join(root, 'blog');
    await writeFile(join(blog, 'GEMINI.md'), '# blog\n', { mode: 0o755 });
    commit(blog, 'gemini');
    await changeStore(store);
    await compile();
    expect(git(blog, 'ls-tree', BRANCH, 'GEMINI.md')).toMatch(/^100755 /);
  });

  it('a failure in one repo undoes every repo compile wrote', async () => {
    const { root, store, compile } = await merged();
    await changeStore(store);
    await writeFile(join(root, 'shop', '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
    await expect(compile()).rejects.toThrow(/hook says no[\s\S]*changes were undone/);
    expect(branches(root)).toBe('');
    for (const r of ['ops', 'shop', 'blog']) expect(git(join(root, r), 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('compile with no store says to run plan and apply first', async () => {
    const fx = await materializeFixture('messy-dev', { commit: true });
    await expect(runCompile(fx.root, { home: fx.home, now: LATER })).rejects.toThrow(/sync-agent-docs plan.*sync-agent-docs apply/);
  });

  it('compile never writes agent files into the truth store, even when sync-agent-docs.json lists it as a repo', async () => {
    const { store, compile } = await merged();
    const path = join(store, 'sync-agent-docs.json');
    const config = JSON.parse(await readFile(path, 'utf8')) as { repos: unknown[] };
    config.repos.push({ name: 'truth', path: '~/truth', formats: ['claude'] });
    await writeFile(path, JSON.stringify(config, null, 2));
    commit(store, 'list the store');
    const result = await compile();
    expect(result.entry?.repos.map((r) => r.path) ?? []).not.toContain(store);
    expect(git(store, 'branch', '--list', 'sync-agent-docs/compile-*')).toBe('');
    expect(result.notes.join('\n')).toMatch(/truth is the truth store, so compile skipped it/);
  });

  it('compile refuses a listed repo outside root, naming it, and writes nothing', async () => {
    const { root, home, store, compile } = await merged();
    const away = join(home, 'elsewhere');
    execFileSync('git', ['init', '-q', '-b', 'main', away]);
    await writeFile(join(away, 'CLAUDE.md'), '# away\n');
    commit(away, 'away');
    const path = join(store, 'sync-agent-docs.json');
    const config = JSON.parse(await readFile(path, 'utf8')) as { repos: unknown[] };
    config.repos.push({ name: 'away', path: '~/elsewhere' });
    await writeFile(path, JSON.stringify(config, null, 2));
    commit(store, 'list away');
    await changeStore(store);
    await expect(compile()).rejects.toThrow(/compile: sync-agent-docs\.json lists ~\/elsewhere, which is outside root ~\/dev/);
    expect(branches(root)).toBe('');
  });

  it('compile names apply branches in the store not merged yet, even when it says up to date', async () => {
    const { store, compile } = await merged();
    git(store, 'switch', '-q', '-c', 'sync-agent-docs/apply-20261022-130000');
    await changeStore(store);
    git(store, 'switch', '-q', 'main');
    const { entry, notes } = await compile();
    expect(entry).toBeNull();
    const text = notes.join('\n');
    expect(text).toMatch(/up to date/);
    expect(text).toMatch(/sync-agent-docs\/apply-20261022-130000 is not merged in the truth store, so compile used the store without it\. Merge it, then run sync-agent-docs compile again\./);
  });
});
