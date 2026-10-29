import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { codeOf, nextStep } from './paths.js';

const exec = promisify(execFile);

/**
 * Config that stops a repo's own config (`.git/config`, `.git/config.worktree` and what they include)
 * from running commands while sync-agent-docs reads it: no fsmonitor hook and an empty command for every
 * filter it defines.
 * A scanned folder can be an unpacked archive whose config nobody chose; the owner's global config,
 * which is where git-lfs puts its filter, is trusted as git trusts it. The pairs travel as
 * GIT_CONFIG_KEY_n/VALUE_n, so a filter name holding `=` cannot change what is set. Hooks still run
 * as they do for any git command: commit hooks and commit signing on apply's commits, and
 * `post-checkout` when apply, compile or rollback switch branches. Read once per folder: a run is short and sync-agent-docs sets no filter.
 */
const guarded = new Map<string, Promise<NodeJS.ProcessEnv>>();
function guardedEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  let env = guarded.get(cwd);
  if (!env) {
    env = readGuards(cwd);
    guarded.set(cwd, env);
    // A failure is reported by the call that hit it, and the next call reads the config again.
    env.catch(() => guarded.delete(cwd));
  }
  return env;
}

async function readGuards(cwd: string): Promise<NodeJS.ProcessEnv> {
  let keys: string[] = [];
  try {
    // Every scope is read and the repo's own kept: `--local` alone misses config.worktree.
    const out = (await exec('git', ['config', '--includes', '--show-scope', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], { cwd })).stdout;
    keys = out.split('\n').flatMap((line) => {
      const tab = line.indexOf('\t');
      return tab > 0 && ['local', 'worktree'].includes(line.slice(0, tab)) ? [line.slice(tab + 1)] : [];
    });
  } catch (err) {
    // Exit 1 means no config defines a filter; outside a repo there is no local config to guard.
    const e = err as { code?: unknown; stderr?: string };
    if (e.code !== 1 && !/only be used inside a git repository|not a git repository/i.test(e.stderr ?? '')) throw err;
  }
  const pairs: [string, string][] = [['core.fsmonitor', 'false'], ['submodule.recurse', 'false'], ...keys.map((k): [string, string] => [k, ''])];
  const env: NodeJS.ProcessEnv = { ...process.env };
  const start = Number(env.GIT_CONFIG_COUNT) || 0;
  pairs.forEach(([k, v], n) => {
    env[`GIT_CONFIG_KEY_${start + n}`] = k;
    env[`GIT_CONFIG_VALUE_${start + n}`] = v;
  });
  env.GIT_CONFIG_COUNT = String(start + pairs.length);
  return env;
}

const run = async (file: string, args: string[], opts: { cwd: string; maxBuffer?: number; input?: string }) => {
  const { input, ...rest } = opts;
  const pending = exec(file, args, { ...rest, env: await guardedEnv(opts.cwd) });
  // EPIPE means git exited before reading all of the input; its exit code and stderr reach the caller
  // through `pending`. Any other write error is kept and thrown once git has finished.
  let writeError: Error | undefined;
  if (input !== undefined) {
    pending.child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') writeError = err;
    });
    pending.child.stdin?.end(input);
  }
  let result;
  try {
    result = await pending;
  } catch (err) {
    // git failed too: its error is the one the caller reads, with the stdin error kept as its cause.
    if (writeError) (err as Error).cause ??= writeError;
    throw err;
  }
  if (writeError) throw writeError;
  return result;
};

export class GitError extends Error {}

/**
 * git's first stderr line, with any URL cut out so it stays short and leaks no remote. A first line
 * ending in ':' introduces what failed (an ignored path, say), so the next line is kept with it.
 */
export function shortReason(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  const line = first.endsWith(':') && lines[1] ? `${first} ${lines[1]}` : first;
  return line.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+?(?=[:\s]|$)/gi, '<url>').trim();
}

/** Why git could not run in `cwd`: a missing folder, a missing git, or git's own reason. */
async function failure(cwd: string, err: unknown): Promise<string> {
  const e = err as NodeJS.ErrnoException & { stderr?: string };
  if (e.code === 'ENOENT') {
    try {
      await stat(cwd);
    } catch (statErr) {
      if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') return `${cwd} does not exist`;
      throw new GitError(`could not check ${cwd} (${codeOf(statErr)}). ${nextStep(statErr)}`, { cause: statErr });
    }
    return 'git is not installed or not on PATH';
  }
  return shortReason(e.stderr ?? '') || e.message;
}

/** The git subcommand in `args`, past any leading `-c key=value` pairs. */
const subcommand = (args: string[]): string => {
  let n = 0;
  while (args[n] === '-c') n += 2;
  return args[n] ?? '';
};

/** Runs git in `cwd`. A failure names the command, the folder and git's first stderr line. */
export async function git(cwd: string, args: string[], stage: string): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    throw new GitError(`${stage}: git ${subcommand(args)} failed in ${cwd}: ${await failure(cwd, err)}. Fix that repo and run ${stage} again.`, { cause: err });
  }
}

/**
 * Runs git for a check where one kind of failure is an answer: null when `answer` accepts the exit
 * code and stderr. Any other failure throws with git's reason.
 */
async function check(cwd: string, args: string[], what: string, answer: (code: number, stderr: string) => boolean, input?: string): Promise<string | null> {
  try {
    return (await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, input })).stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: number | string };
    if (typeof e.code === 'number' && answer(e.code, e.stderr ?? '')) return null;
    throw new GitError(`could not read ${what} in ${cwd}: ${await failure(cwd, err)}. Fix that repo and run again.`, { cause: err });
  }
}

/** Runs git and reports only whether it succeeded, for checks whose failure is an answer. */
async function succeeds(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await run('git', args, { cwd })).stdout;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new GitError(`git could not run in ${cwd}: ${await failure(cwd, err)}. Fix that and run again.`, { cause: err });
    return null;
  }
}

/** The repo root holding the file or folder `path` (after following symlinks), or null when it is not in a git repo. */
export async function toplevelOf(path: string): Promise<string | null> {
  const real = await realpath(path);
  const top = await check((await stat(real)).isDirectory() ? real : dirname(real), ['rev-parse', '--show-toplevel'], 'the repository', (_code, stderr) => /not a git repository/i.test(stderr));
  return top ? realpath(top.trim()) : null;
}

/** The checked-out branch, or null on a detached HEAD. */
export async function currentBranch(repo: string): Promise<string | null> {
  // `symbolic-ref -q` exits 1 and stays quiet on a detached HEAD; anything else is a real failure.
  const out = await check(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], 'the branch', (code, stderr) => code === 1 && !stderr.trim());
  return out ? out.trim() : null;
}

/** Uncommitted changes to tracked files; an untracked file is not one, since switching branches leaves it be. */
export async function isDirty(repo: string): Promise<boolean> {
  return (await git(repo, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=all'], 'apply')).trim() !== '';
}

/** Whether git tracks `file` in `repo`; an ignored or untracked file is not. */
export async function isTracked(repo: string, file: string): Promise<boolean> {
  return (await succeeds(repo, ['ls-files', '--error-unmatch', '--', file])) !== null;
}

/** Whether `.gitignore` or another exclude rule in `repo` covers `file`. */
export async function isIgnored(repo: string, file: string): Promise<boolean> {
  // `check-ignore -q` exits 1 when the file is not ignored; anything else is a real failure.
  return (await check(repo, ['check-ignore', '-q', '--', file], 'the ignore rules', (code) => code === 1)) !== null;
}

/** Which of `paths` (relative to `repo`) git ignores by any rule: nested .gitignore, info/exclude or the global excludes file. One git call. */
export async function ignoredPaths(repo: string, paths: string[], stage: string): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  // `check-ignore` exits 1 when none of the paths is ignored; anything else is a real failure.
  const out = await check(repo, ['check-ignore', '--stdin', '-z'], `the ignore rules for ${stage}`, (code) => code === 1, paths.join('\0') + '\0');
  return new Set(out ? out.split('\0').filter(Boolean) : []);
}

/** Whether commit `a` is already part of `b`'s history. */
export async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  return (await succeeds(repo, ['merge-base', '--is-ancestor', a, b])) !== null;
}

/** Whether `repo` still has `commit`; a deleted branch's commit can be pruned. */
export async function hasCommit(repo: string, commit: string): Promise<boolean> {
  return (await succeeds(repo, ['rev-parse', '--verify', '-q', `${commit}^{commit}`])) !== null;
}

/** Whether `name` is a valid branch name that cannot be read as an option. */
export async function validBranch(repo: string, name: string): Promise<boolean> {
  return !name.startsWith('-') && (await succeeds(repo, ['check-ref-format', '--branch', name])) !== null;
}

export async function branchTip(repo: string, branch: string): Promise<string | null> {
  const out = await succeeds(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
  return out ? out.trim() : null;
}

/** Commits exactly `files` with the repo's identity, or a fallback one when the repo has none. */
/** A fallback author for the commits sync-agent-docs makes in a repo with no git identity set. */
export async function identity(repo: string): Promise<string[]> {
  return (await succeeds(repo, ['config', 'user.email'])) ? [] : ['-c', 'user.name=sync-agent-docs', '-c', 'user.email=sync-agent-docs@localhost'];
}

export async function commitAll(repo: string, files: string[], message: string, stage = 'apply'): Promise<string> {
  await git(repo, ['add', '--', ...files], stage);
  await git(repo, [...(await identity(repo)), 'commit', '-q', '--allow-empty', '-m', message, '--', ...files], stage);
  return (await git(repo, ['rev-parse', 'HEAD'], stage)).trim();
}

/** `<short sha> <YYYY-MM-DD>` of the commit that last touched the line; undefined when uncommitted or untracked. */
export async function blameLine(file: string, line: number): Promise<string | undefined> {
  const real = await realpath(file);
  const out = await succeeds(dirname(real), ['blame', '--porcelain', '--no-textconv', '-L', `${line},${line}`, '--', join('.', basename(real))]);
  if (!out) return undefined;
  const sha = out.slice(0, 40);
  if (/^0+$/.test(sha)) return undefined;
  const time = /^committer-time (\d+)$/m.exec(out)?.[1];
  return `${sha.slice(0, 7)}${time ? ` ${new Date(Number(time) * 1000).toISOString().slice(0, 10)}` : ''}`;
}
