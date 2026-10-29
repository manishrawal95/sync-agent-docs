import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRollback } from '../src/apply/rollback.js';
import { runApply } from '../src/apply/run.js';
import type { Applies } from '../src/apply/branches.js';
import { runPlan } from '../src/plan/run.js';
import { materializeFixture } from './helpers/fixture.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const BRANCH = 'sync-agent-docs/apply-20261022-120000';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function applied() {
  const fx = await materializeFixture('messy-dev', { commit: true });
  const store = join(fx.home, 'truth');
  const plan = await runPlan(fx.root, { home: fx.home, reposOnly: false, crontabCommand: 'false', store, now: NOW });
  for (const i of plan.items) i.answer = i.tier === 'secret' ? 'rotate-remove' : i.follows ? 'accept' : (i.recommended ?? null);
  await writeFile(join(fx.root, '.sync-agent-docs', 'plan.json'), JSON.stringify(plan));
  const entry = await runApply(fx.root, { home: fx.home, now: NOW });
  return { ...fx, store, entry };
}

describe('rollback', () => {
  it("rollback restores each repo's branch and deletes the apply branches", async () => {
    const { root, store, entry } = await applied();
    const { notes } = await runRollback(root);
    for (const r of entry.repos) {
      expect(git(r.path, 'branch', '--list', BRANCH)).toBe('');
      expect(git(r.path, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    }
    expect(await readFile(join(root, 'shop', 'README.md'), 'utf8')).toContain('port 3000');
    expect(git(store, 'log', '--format=%s')).toBe('chore(sync-agent-docs): start the truth store');
    expect(notes).toEqual([]);
    const applies = JSON.parse(await readFile(join(root, '.sync-agent-docs', 'applies.json'), 'utf8')) as Applies;
    expect(applies.applies[0]?.rolledBack).toBeDefined();
  });

  it('an extra commit on an apply branch refuses and names the repo', async () => {
    const { root } = await applied();
    const shop = join(root, 'shop');
    await writeFile(join(shop, 'extra.txt'), 'mine\n');
    git(shop, 'add', '-A');
    git(shop, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'mine');
    await expect(runRollback(root)).rejects.toThrow(new RegExp(`${shop}.*has commits on ${BRANCH} that apply did not make`));
    expect(git(join(root, 'ops'), 'branch', '--list', BRANCH)).not.toBe('');
  });

  it('a renamed original branch refuses before anything is rolled back', async () => {
    const { root, entry } = await applied();
    const shop = join(root, 'shop');
    git(shop, 'branch', '-m', 'main', 'trunk');
    await expect(runRollback(root)).rejects.toThrow(new RegExp(`${shop}.*main.*nothing was rolled back`));
    for (const r of entry.repos) expect(git(r.path, 'branch', '--list', BRANCH)).not.toBe('');
    const applies = JSON.parse(await readFile(join(root, '.sync-agent-docs', 'applies.json'), 'utf8')) as Applies;
    expect(applies.applies[0]?.rolledBack).toBeUndefined();
  });

  it('nothing to roll back says so', async () => {
    const fx = await materializeFixture('messy-dev', { commit: true });
    await expect(runRollback(fx.root)).rejects.toThrow(/nothing to roll back/i);
  });

  it('a second rollback does not repeat the first', async () => {
    const { root } = await applied();
    await runRollback(root);
    await expect(runRollback(root)).rejects.toThrow(/nothing to roll back/i);
  });

  it('a branch already deleted by hand is a note, not a failure', async () => {
    const { root } = await applied();
    const ops = join(root, 'ops');
    git(ops, 'switch', '-q', 'main');
    git(ops, 'branch', '-D', BRANCH);
    const { notes } = await runRollback(root);
    expect(notes).toEqual([`${ops}: branch ${BRANCH} was already gone.`]);
  });

  it('a repo apply stopped in before its commit is rolled back too', async () => {
    const { root } = await applied();
    const shop = join(root, 'shop');
    git(shop, 'reset', '-q', '--hard', 'main');
    const path = join(root, '.sync-agent-docs', 'applies.json');
    const applies = JSON.parse(await readFile(path, 'utf8')) as Applies;
    for (const r of applies.applies[0]?.repos ?? []) if (r.path === shop) r.commit = null;
    await writeFile(path, JSON.stringify(applies));
    await runRollback(root);
    expect(git(shop, 'branch', '--list', BRANCH)).toBe('');
    expect(git(shop, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  const nullCommit = async (root: string, repo: string) => {
    const path = join(root, '.sync-agent-docs', 'applies.json');
    const applies = JSON.parse(await readFile(path, 'utf8')) as Applies;
    for (const r of applies.applies[0]?.repos ?? []) if (r.path === repo) r.commit = null;
    await writeFile(path, JSON.stringify(applies));
  };

  it('an apply stopped while writing is rolled back, its edits kept in a stash', async () => {
    const { root } = await applied();
    const shop = join(root, 'shop');
    git(shop, 'reset', '-q', 'main');
    await nullCommit(root, shop);
    const { notes } = await runRollback(root);
    expect(git(shop, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(shop, 'branch', '--list', BRANCH)).toBe('');
    expect(git(shop, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(shop, 'README.md'), 'utf8')).toContain('port 3000');
    expect(git(shop, 'stash', 'list')).toMatch(/sync-agent-docs rollback/);
    expect(notes.join('\n')).toMatch(new RegExp(`${shop}: .*stash`));
  });

  it('an apply stopped after its commit but before recording it is rolled back', async () => {
    const { root } = await applied();
    const shop = join(root, 'shop');
    await nullCommit(root, shop);
    await runRollback(root);
    expect(git(shop, 'branch', '--list', BRANCH)).toBe('');
    expect(git(shop, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('an untracked file of your own on a cut-off apply branch is left alone', async () => {
    const { root } = await applied();
    const shop = join(root, 'shop');
    git(shop, 'reset', '-q', 'main');
    await nullCommit(root, shop);
    await writeFile(join(shop, 'mine.txt'), 'mine\n');
    await runRollback(root);
    expect(git(shop, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(await readFile(join(shop, 'mine.txt'), 'utf8')).toBe('mine\n');
  });

  it('an uncommitted change apply did not write still refuses', async () => {
    const { root } = await applied();
    const shop = join(root, 'shop');
    git(shop, 'reset', '-q', 'main');
    await nullCommit(root, shop);
    await writeFile(join(shop, 'ecosystem.config.cjs'), 'mine\n');
    await expect(runRollback(root)).rejects.toThrow(/uncommitted changes/);
  });

  const setFiles = async (root: string, repo: string, files: string[]) => {
    const path = join(root, '.sync-agent-docs', 'applies.json');
    const applies = JSON.parse(await readFile(path, 'utf8')) as Applies;
    for (const r of applies.applies[0]?.repos ?? []) if (r.path === repo) r.files = files;
    await writeFile(path, JSON.stringify(applies));
  };

  it('a hand-edited files list naming a path outside the repo stashes nothing', async () => {
    const { root } = await applied();
    const shop = join(root, 'shop');
    git(shop, 'reset', '-q', 'main');
    await nullCommit(root, shop);
    const changed = git(shop, 'status', '--porcelain', '--untracked-files=no').split('\n').map((l) => l.slice(3));
    await setFiles(root, shop, changed.map((f) => join(shop, '..', 'ops', f)));
    await expect(runRollback(root)).rejects.toThrow(/uncommitted changes/);
    expect(git(shop, 'stash', 'list')).toBe('');
  });

  it("a cut-off apply's commit touching a file it did not record is refused", async () => {
    const { root } = await applied();
    const shop = join(root, 'shop');
    await nullCommit(root, shop);
    await setFiles(root, shop, []);
    await expect(runRollback(root)).rejects.toThrow(/has commits on .* that apply did not make/);
    expect(git(shop, 'branch', '--list', BRANCH)).not.toBe('');
  });

  it('a repo with no apply commit but commits of its own is refused', async () => {
    const { root } = await applied();
    const shop = join(root, 'shop');
    git(shop, 'reset', '-q', '--hard', 'main');
    git(shop, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'mine');
    const path = join(root, '.sync-agent-docs', 'applies.json');
    const applies = JSON.parse(await readFile(path, 'utf8')) as Applies;
    for (const r of applies.applies[0]?.repos ?? []) if (r.path === shop) r.commit = null;
    await writeFile(path, JSON.stringify(applies));
    await expect(runRollback(root)).rejects.toThrow(/has commits on .* that apply did not make/);
  });

  it('a branch already merged is kept with a note to revert by hand', async () => {
    const { root } = await applied();
    const ops = join(root, 'ops');
    git(ops, 'switch', '-q', 'main');
    git(ops, 'merge', '-q', '--ff-only', BRANCH);
    const { notes } = await runRollback(root);
    expect(notes).toEqual([`${ops}: ${BRANCH} is already merged into main; revert it by hand.`]);
    expect(git(ops, 'branch', '--list', BRANCH)).not.toBe('');
    expect(git(join(root, 'shop'), 'branch', '--list', BRANCH)).toBe('');
  });
  it('an apply merged everywhere is refused, not marked rolled back', async () => {
    const { root, entry } = await applied();
    for (const r of entry.repos) {
      git(r.path, 'switch', '-q', 'main');
      git(r.path, 'merge', '-q', '--ff-only', BRANCH);
    }
    await expect(runRollback(root)).rejects.toThrow(/already merged.*nothing was rolled back.*revert/i);
    const applies = JSON.parse(await readFile(join(root, '.sync-agent-docs', 'applies.json'), 'utf8')) as Applies;
    expect(applies.applies[0]?.rolledBack).toBeUndefined();
  });

  it('a hand-edited applies.json naming a branch apply never makes deletes nothing', async () => {
    const { root, entry } = await applied();
    const [shop] = entry.repos;
    const path = join(root, '.sync-agent-docs', 'applies.json');
    const applies = JSON.parse(await readFile(path, 'utf8')) as Applies;
    const [last] = applies.applies;
    if (!shop || !last) throw new Error('the fixture apply made no branch');
    const main = git(shop.path, 'rev-parse', 'main');
    last.repos = [{ ...shop, branch: 'main', original: '--detach', commit: main }];
    await writeFile(path, JSON.stringify(applies));
    await expect(runRollback(root)).rejects.toThrow(/main is not a branch sync-agent-docs makes/);
    expect(git(shop.path, 'rev-parse', 'main')).toBe(main);
    last.repos = [{ ...shop, original: '--detach' }];
    await writeFile(path, JSON.stringify(applies));
    await expect(runRollback(root)).rejects.toThrow(/--detach is not a branch name/);
    expect(git(shop.path, 'branch', '--list', shop.branch)).not.toBe('');
  });
});
