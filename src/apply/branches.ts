import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { branchTip, commitAll, currentBranch, git, isDirty, isTracked } from '../git.js';
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from '../store/io.js';
import { SCHEMA_VERSION } from '../store/types.js';

/**
 * The branch machinery `apply` and `compile` share: each repo gets a new branch and one commit,
 * every step is recorded in applies.json so `rollback` can undo it, and a failure puts every repo back.
 */
export type BranchStage = 'apply' | 'compile';
/**
 * `commit` is null while a repo is still being written, or when the run stopped there. `files` lists
 * each file the run was about to write, recorded before writing it, so rollback can tell the edits
 * of a run that was cut off from anyone else's; it is absent on entries written before that.
 */
export interface ApplyRepo { path: string; branch: string; original: string; commit: string | null; files?: string[] }
/** `kind` is absent on entries written before compile existed; those are applies. */
/** A manual patch's target, and the sha256 of that file when apply wrote the patch: while it matches, the patch still applies. */
export interface ManualTarget { file: string; patch: string; sha256: string }
/** `storeParent` is the work tree a new store was created inside; absent when the store stands alone or already existed. `targets` is absent on entries written before doctor read it. */
export interface ApplyEntry { id: string; at: string; store: string; repos: ApplyRepo[]; manual: string[]; targets?: ManualTarget[]; skipped: string[]; secrets?: string[]; storeParent?: string; rolledBack?: string; kind?: BranchStage }
export interface Applies { schema: 1; applies: ApplyEntry[] }
/** What a repo had written to it, so a failure can put it back: tracked files are checked out again, created ones removed. */
export interface Touched { repo: string; tracked: string[]; created: string[] }

const pad = (n: number): string => String(n).padStart(2, '0');
/** `YYYYMMDD-HHMMSS` in UTC, the suffix of every branch one run makes. */
export const branchId = (d: Date): string =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

/** The branches apply and compile make; nothing else is theirs to delete. */
export const MANAGED_BRANCH = /^sync-agent-docs\/(apply|compile)-[0-9-]+$/;

export const appliesPath = (root: string): string => join(root, '.sync-agent-docs', 'applies.json');

export async function readApplies(root: string, stage: string): Promise<Applies> {
  return (await readJsonFile<Applies>(appliesPath(root), stage)) ?? { schema: SCHEMA_VERSION, applies: [] };
}

/** Refuses a repo that cannot be branched cleanly: detached, dirty, or already holding the branch. */
export async function checkRepo(repo: string, branch: string, stage: BranchStage): Promise<string> {
  const original = await currentBranch(repo);
  if (!original) throw new Error(`${stage}: ${repo} is on a detached HEAD, so nothing was written. Check out a branch and run sync-agent-docs ${stage} again.`);
  if (await isDirty(repo)) throw new Error(`${stage}: ${repo} has uncommitted changes, so nothing was written. Commit or stash them and run sync-agent-docs ${stage} again.`);
  if (await branchTip(repo, branch)) throw new Error(`${stage}: ${repo}: branch ${branch} already exists, so nothing was written. Wait a second and run sync-agent-docs ${stage} again, or delete that branch.`);
  return original;
}

/** One run's writes: its applies.json entry, what it touched, and where it is, for the error if it stops. */
export class BranchRun {
  readonly touched: Touched[] = [];
  at = '';

  private constructor(readonly root: string, readonly stage: BranchStage, readonly entry: ApplyEntry, private readonly applies: Applies) {}

  static async start(root: string, stage: BranchStage, entry: ApplyEntry): Promise<BranchRun> {
    return new BranchRun(root, stage, entry, await readApplies(root, stage));
  }

  async record(): Promise<void> {
    await writeJsonAtomic(appliesPath(this.root), { ...this.applies, applies: [...this.applies.applies, this.entry] });
  }

  async write(t: Touched, path: string, text: string, mode?: number): Promise<void> {
    (await isTracked(t.repo, path) ? t.tracked : t.created).push(path);
    const repo = this.entry.repos.find((r) => r.path === t.repo);
    if (repo) {
      (repo.files ??= []).push(path);
      await this.record();
    }
    await writeTextAtomic(path, text, mode);
  }

  /**
   * Switches `repo` to the run's new branch, lets `fill` write its files, and commits them with the
   * message `fill` returns. When the files come out unchanged, the branch is deleted and the repo
   * left out of the run, so a plan with nothing new leaves no empty branches to review.
   */
  async commitOnBranch(repo: string, branch: string, original: string, fill: (t: Touched) => Promise<string>): Promise<void> {
    this.at = repo;
    await git(repo, ['switch', '-q', '-c', branch], this.stage);
    const done: ApplyRepo = { path: repo, branch, original, commit: null };
    this.entry.repos.push(done);
    await this.record();
    const t: Touched = { repo, tracked: [], created: [] };
    this.touched.push(t);
    const message = await fill(t);
    const files = [...t.tracked, ...t.created];
    if (!files.length || !(await git(repo, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all', '--', ...files], this.stage)).trim()) {
      await git(repo, ['switch', '-q', original], this.stage);
      await git(repo, ['branch', '-q', '-D', branch], this.stage);
      this.entry.repos.splice(this.entry.repos.indexOf(done), 1);
      this.touched.splice(this.touched.indexOf(t), 1);
    } else {
      done.commit = await commitAll(repo, files, message);
    }
    await this.record();
  }

  /** Undoes everything after a failure and throws the error to show, saying whether the undo worked. */
  async fail(err: unknown, createdStore: string | null): Promise<never> {
    const why = (err as Error).message;
    try {
      await undo(this.touched, this.entry.repos, createdStore, this.stage);
      this.entry.rolledBack = new Date().toISOString();
      await this.record();
    } catch (undoErr) {
      throw new Error(`${this.stage}: stopped at ${this.at}: ${why} Undoing it also failed: ${(undoErr as Error).message} The branches made so far are listed in ${appliesPath(this.root)}; run sync-agent-docs rollback to remove them.`, { cause: undoErr });
    }
    throw new Error(`${this.stage}: stopped at ${this.at}: ${why} The changes were undone: each repo is back on its branch and the ${this.stage} branches are deleted.`, { cause: err });
  }
}

/**
 * Puts every repo a run touched back as it was, newest first, and removes a store folder it created.
 * A repo that cannot be put back does not stop the others; every failure is reported together.
 */
async function undo(touched: Touched[], repos: ApplyRepo[], createdStore: string | null, stage: BranchStage): Promise<void> {
  const failed: unknown[] = [];
  for (const r of [...repos].reverse()) {
    try {
      const t = touched.find((x) => x.repo === r.path);
      if (r.commit === null && t) {
        const files = [...t.tracked, ...t.created];
        if (files.length) await git(r.path, ['reset', '-q', '--', ...files], stage);
        if (t.tracked.length) await git(r.path, ['checkout', '-q', '--', ...t.tracked], stage);
        for (const f of t.created) await rm(f, { force: true });
      }
      if ((await currentBranch(r.path)) === r.branch) await git(r.path, ['switch', '-q', r.original], stage);
      await git(r.path, ['branch', '-q', '-D', r.branch], stage);
    } catch (err) {
      failed.push(err);
    }
  }
  try {
    if (createdStore && !failed.length) await rm(createdStore, { recursive: true, force: true });
  } catch (err) {
    failed.push(err);
  }
  if (failed.length) throw new AggregateError(failed, failed.map((e) => (e as Error).message).join(' '));
}
