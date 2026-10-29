import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blameLine, commitAll, currentBranch, git, GitError, ignoredPaths, isDirty, isIgnored, isTracked, shortReason, toplevelOf } from '../src/git.js';

const temp = async () => realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-git-')));
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function repo(): Promise<string> {
  const dir = await temp();
  sh(dir, 'init', '-q', '-b', 'main');
  await writeFile(join(dir, 'a.md'), 'one\ntwo\n');
  await commitAll(dir, ['a.md'], 'first');
  return dir;
}

describe('git', () => {
  it('ignoredPaths returns only the paths git ignores', async () => {
    const dir = await repo();
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs', '.gitignore'), 'private.md\n');
    await writeFile(join(dir, '.git', 'info', 'exclude'), 'local.md\n');
    expect(await ignoredPaths(dir, ['docs/private.md', 'local.md', 'README.md'], 'scan')).toEqual(new Set(['docs/private.md', 'local.md']));
    expect(await ignoredPaths(dir, ['README.md', 'docs/public.md'], 'scan')).toEqual(new Set());
    expect(await ignoredPaths(dir, [], 'scan')).toEqual(new Set());
  });

  it('ignoredPaths on a folder that is not a repo rejects with a GitError, even with more paths than the pipe holds', async () => {
    const dir = await temp();
    const paths = Array.from({ length: 60000 }, (_, n) => `docs/file-${n}.md`);
    const err = await ignoredPaths(dir, paths, 'scan').then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err?.message).toMatch(/could not read the ignore rules/);
    expect(err?.message).toContain(dir);
  });

  it('isDirty sees a changed tracked file but not an untracked one', async () => {
    const dir = await repo();
    expect(await isDirty(dir)).toBe(false);
    await writeFile(join(dir, 'new.md'), 'x');
    expect(await isDirty(dir)).toBe(false);
    await writeFile(join(dir, 'a.md'), 'changed\n');
    expect(await isDirty(dir)).toBe(true);
  });

  it('currentBranch is null on a detached HEAD', async () => {
    const dir = await repo();
    expect(await currentBranch(dir)).toBe('main');
    sh(dir, 'checkout', '-q', '--detach');
    expect(await currentBranch(dir)).toBeNull();
  });

  it('toplevelOf follows a symlink into a repo and is null outside', async () => {
    const dir = await repo();
    const outside = await temp();
    await symlink(join(dir, 'a.md'), join(outside, 'link.md'));
    expect(await toplevelOf(join(outside, 'link.md'))).toBe(dir);
    await writeFile(join(outside, 'plain.md'), 'x');
    expect(await toplevelOf(join(outside, 'plain.md'))).toBeNull();
  });

  it('toplevelOf of a folder looks inside it, not at its parent', async () => {
    const dir = await repo();
    expect(await toplevelOf(dir)).toBe(dir);
    expect(await toplevelOf(await temp())).toBeNull();
  });

  it('commitAll commits only the named files', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'a.md'), 'one\nTWO\n');
    await writeFile(join(dir, 'other.md'), 'x');
    const sha = await commitAll(dir, ['a.md'], 'second');
    expect(sh(dir, 'rev-parse', 'HEAD')).toBe(sha);
    expect(sh(dir, 'status', '--porcelain')).toBe('?? other.md');
  });

  it('blameLine names the commit that last touched a line', async () => {
    const dir = await repo();
    const sha = sh(dir, 'rev-parse', '--short', 'HEAD');
    expect(await blameLine(join(dir, 'a.md'), 2)).toMatch(new RegExp(`^${sha.slice(0, 7)}\\w* \\d{4}-\\d{2}-\\d{2}$`));
    await writeFile(join(dir, 'u.md'), 'x\n');
    expect(await blameLine(join(dir, 'u.md'), 1)).toBeUndefined();
  });

  it("a scanned repo's own config runs no command: no fsmonitor, no filter", async () => {
    // Configured before sync-agent-docs first runs git there, as in a folder it is handed.
    const dir = await temp();
    sh(dir, 'init', '-q', '-b', 'main');
    await writeFile(join(dir, 'a.md'), 'one\ntwo\n');
    sh(dir, 'add', 'a.md');
    sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
    const marks = await temp();
    await writeFile(join(dir, '.git', 'info', 'attributes'), '* filter=evil\n*.md filter=a=b\n');
    sh(dir, 'config', 'filter.evil.clean', `touch ${marks}/filter; cat`);
    // A filter name holding `=` must not turn the guard for it into some other setting.
    sh(dir, 'config', 'filter.a=b.clean', `touch ${marks}/equals; cat`);
    sh(dir, 'config', 'core.fsmonitor', `touch ${marks}/fsmonitor; false`);
    // A new mtime makes git look at the file again, which is when it would run the filter.
    await utimes(join(dir, 'a.md'), new Date(), new Date(Date.now() + 5000));
    expect(await blameLine(join(dir, 'a.md'), 1)).toBeDefined();
    await isDirty(dir);
    await isTracked(dir, 'a.md');
    await isIgnored(dir, 'a.md');
    await currentBranch(dir);
    expect(await readdir(marks)).toEqual([]);
  });

  it('a filter set in .git/config.worktree runs no command either', async () => {
    const dir = await temp();
    sh(dir, 'init', '-q', '-b', 'main');
    await writeFile(join(dir, 'a.md'), 'one\n');
    sh(dir, 'add', 'a.md');
    sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
    const marks = await temp();
    await writeFile(join(dir, '.git', 'info', 'attributes'), '* filter=wt\n');
    sh(dir, 'config', 'extensions.worktreeConfig', 'true');
    sh(dir, 'config', '--worktree', 'filter.wt.clean', `touch ${marks}/worktree; cat`);
    await utimes(join(dir, 'a.md'), new Date(), new Date(Date.now() + 5000));
    expect(await blameLine(join(dir, 'a.md'), 1)).toBeDefined();
    await isDirty(dir);
    expect(await readdir(marks)).toEqual([]);
  });

  it('a missing folder is named, not blamed on git being missing', async () => {
    const gone = join(await temp(), 'gone');
    await expect(git(gone, ['status'], 'apply')).rejects.toThrow(new RegExp(`${gone} does not exist`));
    await expect(git(gone, ['status'], 'apply')).rejects.not.toThrow(/not installed/);
  });

  it('currentBranch outside a repo says so instead of reporting a detached HEAD', async () => {
    await expect(currentBranch(await temp())).rejects.toThrow(/could not read the branch .*not a git repository/);
  });

  it('toplevelOf reports a broken repo instead of calling it no repo', async () => {
    const dir = await repo();
    await writeFile(join(dir, '.git', 'config'), '[[[ not config\n');
    await expect(toplevelOf(join(dir, 'a.md'))).rejects.toThrow(new RegExp(`${dir}.*bad config`));
  });

  it("git's reason is one short line with no URLs", () => {
    expect(shortReason('\nfatal: unable to access https://example.invalid/x.git: timed out\nhint: see https://git-scm.com/docs\n')).toBe('fatal: unable to access <url>: timed out');
  });

  it('a failure names the subcommand past any -c pairs', async () => {
    const dir = await repo();
    await expect(git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'empty'], 'apply')).rejects.toThrow(/git commit failed in/);
  });

  it("git's reason keeps the next line when the first ends with a colon", () => {
    expect(shortReason('The following paths are ignored by one of your .gitignore files:\nhosts.md\nhint: Use -f\n')).toBe('The following paths are ignored by one of your .gitignore files: hosts.md');
  });
});
