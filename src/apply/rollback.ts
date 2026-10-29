import { isAbsolute, relative } from 'node:path';
import { branchTip, currentBranch, git, identity, isAncestor, validBranch } from '../git.js';
import { refuseTrackedDotDir } from '../dotdir.js';
import { withLock } from '../lock.js';
import { writeJsonAtomic } from '../store/io.js';
import { appliesPath, readApplies, MANAGED_BRANCH, type ApplyEntry, type ApplyRepo } from './branches.js';

/** The repo-relative paths a run recorded before writing them; a path outside the repo is never one. */
function ownFiles(r: ApplyRepo): Set<string> {
  return new Set((r.files ?? []).map((f) => relative(r.path, f)).filter((f) => f !== '' && !f.startsWith('..') && !isAbsolute(f)));
}

/**
 * Whether the branch of a repo where apply stopped before recording its commit holds only apply's
 * work: nothing beyond where it started, or the one commit apply makes, touching only its files.
 */
async function ownUnrecorded(r: ApplyRepo, own: Set<string>): Promise<boolean> {
  const commits = (await git(r.path, ['rev-list', `refs/heads/${r.original}..refs/heads/${r.branch}`], 'rollback')).split('\n').filter(Boolean);
  if (!commits.length) return true;
  const [only] = commits;
  if (commits.length > 1 || !only) return false;
  const subject = (await git(r.path, ['log', '-1', '--format=%s', only], 'rollback')).trim();
  const files = (await git(r.path, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', only], 'rollback')).split('\0').filter(Boolean);
  return subject.startsWith('chore(sync-agent-docs): ') && files.every((f) => own.has(f));
}

/**
 * Paths with uncommitted changes: tracked ones, and untracked ones the run recorded as its own.
 * Another untracked file is left out, since switching branches leaves it be. A rename or copy
 * counts as foreign, so null is returned and rollback refuses.
 */
async function changedPaths(repo: string, own: Set<string>): Promise<string[] | null> {
  const entries = (await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], 'rollback')).split('\0').filter(Boolean);
  if (entries.some((e) => /[RC]/.test(e.slice(0, 2)))) return null;
  return entries.filter((e) => !e.startsWith('??') || own.has(e.slice(3))).map((e) => e.slice(3));
}

/**
 * Deletes the branches of the last apply that was not rolled back, switching each repo back to
 * the branch it was on. Every repo is checked before any is touched, and a branch holding
 * commits apply did not make is refused, so rollback never throws away someone's work. A branch
 * already merged is kept: deleting it would not undo the merge.
 */
export async function runRollback(root: string, now: Date = new Date()): Promise<{ entry: ApplyEntry; back: ApplyEntry['repos']; notes: string[] }> {
  await refuseTrackedDotDir(root, 'rollback');
  return withLock(root, 'rollback', async (lock) => {
    const applies = await readApplies(root, 'rollback');
    // An apply that changed no file made no branch, so there is nothing of it to undo.
    const index = applies.applies.findLastIndex((a) => !a.rolledBack && a.repos.length > 0);
    const entry = applies.applies[index];
    if (!entry) throw new Error(`rollback: nothing to roll back; ${appliesPath(root)} lists no apply that is still in place.`);
    await lock.store(entry.store);

    const notes: string[] = [];
    const live: ApplyEntry['repos'] = [];
    const merged: string[] = [];
    const stash: { r: ApplyRepo; paths: string[] }[] = [];
    for (const r of entry.repos) {
      // applies.json is a file anyone can edit: rollback deletes only a branch sync-agent-docs names.
      if (!MANAGED_BRANCH.test(r.branch)) {
        throw new Error(`rollback: ${appliesPath(root)} says ${r.branch} in ${r.path}, but ${r.branch} is not a branch sync-agent-docs makes, so nothing was rolled back. Fix that entry or delete the branch yourself.`);
      }
      if (!(await validBranch(r.path, r.original))) {
        throw new Error(`rollback: ${appliesPath(root)} says to go back to ${r.original} in ${r.path}, but ${r.original} is not a branch name, so nothing was rolled back. Fix that entry and run sync-agent-docs rollback again.`);
      }
      const tip = await branchTip(r.path, r.branch);
      if (!tip) {
        notes.push(`${r.path}: branch ${r.branch} was already gone.`);
        continue;
      }
      if ((await branchTip(r.path, r.original)) === null) {
        throw new Error(`rollback: ${r.path} has no branch ${r.original} to return to (it was renamed or deleted), so nothing was rolled back. Recreate it under that name (git branch ${r.original} <commit>) or fix that entry in ${appliesPath(root)}, then run sync-agent-docs rollback again.`);
      }
      // A null commit means apply stopped in this repo before recording a commit, so only its own files may differ.
      const files = ownFiles(r);
      const own = r.commit === null ? await ownUnrecorded(r, files) : tip === r.commit;
      if (!own) {
        throw new Error(`rollback: ${r.path} has commits on ${r.branch} that apply did not make, so nothing was rolled back. Merge or delete that branch yourself, then run sync-agent-docs rollback again.`);
      }
      if (r.commit !== null && (await isAncestor(r.path, r.commit, r.original))) {
        notes.push(`${r.path}: ${r.branch} is already merged into ${r.original}; revert it by hand.`);
        merged.push(r.path);
        continue;
      }
      const changed = (await currentBranch(r.path)) === r.branch ? await changedPaths(r.path, files) : [];
      if (changed?.length !== 0) {
        // Edits apply wrote before it was cut off are its own; they are stashed, never discarded.
        if (r.commit === null && changed?.every((p) => files.has(p))) stash.push({ r, paths: changed });
        else throw new Error(`rollback: ${r.path} is on ${r.branch} with uncommitted changes, so nothing was rolled back. Commit or stash them and run sync-agent-docs rollback again.`);
      }
      live.push(r);
    }

    // With every branch merged there is nothing rollback can undo; marking the apply rolled back would hide that.
    if (!live.length && merged.length) {
      throw new Error(`rollback: plan ${entry.id} is already merged in ${merged.join(', ')}, so nothing was rolled back. Revert its commits by hand with git revert.`);
    }

    for (const { r, paths } of stash) {
      await git(r.path, [...(await identity(r.path)), 'stash', 'push', '-q', '--include-untracked', '-m', `sync-agent-docs rollback ${entry.id}`, '--', ...paths], 'rollback');
      notes.push(`${r.path}: apply stopped before committing; its unfinished edits are kept in git stash as "sync-agent-docs rollback ${entry.id}". Drop that stash once you have checked it.`);
    }
    for (const r of live) {
      if ((await currentBranch(r.path)) === r.branch) await git(r.path, ['switch', '-q', r.original], 'rollback');
      await git(r.path, ['branch', '-q', '-D', r.branch], 'rollback');
    }
    entry.rolledBack = now.toISOString();
    await writeJsonAtomic(appliesPath(root), applies);
    return { entry, back: live, notes };
  });
}

export function renderRollbackSummary({ entry, back, notes }: { entry: ApplyEntry; back: ApplyEntry['repos']; notes: string[] }): string {
  return [
    `Rolled back plan ${entry.id}.`,
    ...back.map((r) => `  ${r.path}: back on ${r.original}`),
    ...notes,
    ...(entry.manual.length ? ['Manual patches were left in place; if you applied one by hand, undo that by hand too:', ...entry.manual.map((m) => `  ${m}`)] : []),
  ].join('\n');
}
