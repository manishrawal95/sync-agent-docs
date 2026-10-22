import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { RepoInfo, SkippedFile } from '../types.js';

/** Directories never worth descending into: dependencies, build output, our own scratch. */
export const SKIP_DIRS = new Set([
  'node_modules', '.venv', 'venv', 'dist', 'build', '.next', '.worktrees', '.sync-agent-docs', '.git',
]);

/** Records an unreadable path once, though both discovery passes may meet it. */
function noteUnreadable(skipped: SkippedFile[], path: string, note: string): void {
  if (!skipped.some((s) => s.path === path)) skipped.push({ path, reason: 'unreadable', note });
}

/** Loads a folder's .gitignore; a missing file means nothing is ignored, an unreadable one is noted. */
export async function loadIgnore(dir: string, skipped: SkippedFile[] = []): Promise<Ignore> {
  const ig = ignore();
  try {
    ig.add(await readFile(join(dir, '.gitignore'), 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') noteUnreadable(skipped, join(dir, '.gitignore'), code);
    else if (code !== 'ENOENT') {
      throw new Error(`discover: could not read ${join(dir, '.gitignore')} (${(err as Error).message}). Check its permissions.`, { cause: err });
    }
  }
  return ig;
}

/** A folder's entries, or null after noting why it could not be listed (EACCES, EPERM): one locked folder never stops a scan. */
export async function listDir(dir: string, skipped: SkippedFile[]): Promise<Dirent[] | null> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw new Error(`discover: could not list ${dir} (${(err as Error).message}). Check that it exists and is a folder.`, { cause: err });
    noteUnreadable(skipped, dir, code);
    return null;
  }
}

/** Test data that only looks like real config: skipped at any depth inside a repo, and not listed as skipped. */
const FIXTURE_DIRS = new Set(['fixtures', '__fixtures__', 'testdata', '__snapshots__']);
/** Test folders, skipped only at a repo's root; a nested `tests/` may hold real docs. */
const ROOT_TEST_DIRS = new Set(['test', 'tests']);

/** A folder inside a repo that holds test data rather than the repo's real config and docs. */
export function isTestData(name: string, atRepoRoot: boolean): boolean {
  return FIXTURE_DIRS.has(name) || (atRepoRoot && ROOT_TEST_DIRS.has(name));
}

/**
 * The main checkout a linked worktree belongs to, when that checkout lies inside the scan root, else null.
 * A linked worktree's `.git` is a file naming `<main>/.git/worktrees/<name>`; a submodule's names `.git/modules/...`
 * and stays a repo. A worktree whose main checkout is outside the scan (or bare) is the only copy seen, so it is kept.
 */
async function worktreeMain(dir: string, root: string, skipped: SkippedFile[]): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(dir, '.git'), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') noteUnreadable(skipped, join(dir, '.git'), code);
    else throw new Error(`discover: could not read ${join(dir, '.git')} (${(err as Error).message}). Check its permissions.`, { cause: err });
    return null;
  }
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
  if (!gitdir) return null;
  const common = /^(.*)[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(resolve(dir, gitdir))?.[1];
  if (!common || basename(common) !== '.git') return null;
  const main = dirname(common);
  const rel = relative(root, main);
  return rel.startsWith('..') || isAbsolute(rel) ? null : main;
}

async function walk(dir: string, root: string, repos: RepoInfo[], ig: Ignore | null, igBase: string, skipped: SkippedFile[], inRepo = false): Promise<void> {
  const entries = await listDir(dir, skipped);
  if (!entries) return;
  let rules = ig;
  let base = igBase;
  const dotGit = entries.find((e) => e.name === '.git');
  const isRepo = dotGit !== undefined;
  if (dotGit?.isFile()) {
    const main = await worktreeMain(dir, root, skipped);
    if (main) {
      skipped.push({ path: dir, reason: 'linked-worktree', note: `a worktree of ${main}, which is scanned instead` });
      return;
    }
  }
  if (isRepo) {
    repos.push({ name: basename(dir), path: dir });
    rules = await loadIgnore(dir, skipped);
    base = dir;
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
    if ((inRepo || isRepo) && isTestData(e.name, isRepo)) continue;
    const child = join(dir, e.name);
    if (rules?.ignores(relative(base, child) + '/')) continue;
    await walk(child, root, repos, rules, base, skipped, inRepo || isRepo);
  }
}

/** Every folder under root (root included) that holds a .git entry. Symlinked folders are not followed. */
export async function findRepos(root: string, skipped: SkippedFile[] = []): Promise<RepoInfo[]> {
  const repos: RepoInfo[] = [];
  await walk(root, root, repos, null, root, skipped);
  return repos;
}
