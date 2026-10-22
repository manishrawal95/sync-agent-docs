import { realpath } from 'node:fs/promises';
import { readApplies, MANAGED_BRANCH } from '../../apply/branches.js';
import { storePath } from '../../compile/deps.js';
import { branchTip, git, hasCommit, isAncestor, toplevelOf } from '../../git.js';
import { isDir, shortPath } from '../../paths.js';
import type { Check, DoctorContext, Found } from '../types.js';

/** Whether a local branch outside `sync-agent-docs/` holds `commit`, which is how a merge shows. */
async function merged(repo: string, commit: string): Promise<boolean> {
  const out = await git(repo, ['for-each-ref', '--contains', commit, '--format=%(refname:short)', 'refs/heads/'], 'doctor');
  return out.split('\n').some((b) => b !== '' && !b.startsWith('sync-agent-docs/'));
}

/** Every listed repo that is on disk and is a git repo of its own, then the store, each once. */
async function repos(ctx: DoctorContext): Promise<string[]> {
  const all = [...ctx.store.config.repos.map((r) => storePath(r.path, ctx.store.config.root, ctx.home)), ctx.storeDir];
  const out: string[] = [];
  for (const p of new Set(all)) {
    if ((await isDir(p, 'doctor')) && (await toplevelOf(p)) === (await realpath(p))) out.push(p);
  }
  return out;
}

/** sync-agent-docs branches that no branch of the owner's has merged yet. */
export const branchesCheck: Check = {
  id: 'branches',
  async run(ctx) {
    const out: Found[] = [];
    for (const repo of await repos(ctx)) {
      const shown = shortPath(repo, ctx.root, ctx.home);
      const refs = await git(repo, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/sync-agent-docs/'], 'doctor');
      for (const line of refs.split('\n')) {
        const [branch, commit] = line.split(' ');
        if (!branch || !commit || !MANAGED_BRANCH.test(branch) || (await merged(repo, commit))) continue;
        out.push({ key: `branches:${shown}:${branch}`, path: shown, message: `${shown} has ${branch}, which is not merged. Review it and merge it, or run sync-agent-docs rollback.` });
      }
    }
    return out;
  },
};

/** Each recorded apply's commit must still be in its branch's history, or merged. */
export const appliesCheck: Check = {
  id: 'applies',
  async run(ctx) {
    const out: Found[] = [];
    for (const entry of (await readApplies(ctx.root, 'doctor')).applies) {
      if (entry.rolledBack) continue;
      for (const r of entry.repos) {
        const shown = shortPath(r.path, ctx.root, ctx.home);
        const key = `applies:${entry.id}:${shown}`;
        if (!(await isDir(r.path, 'doctor'))) {
          out.push({ key: `${key}:not-there`, level: 'note', path: shown, message: `${shown} from apply ${entry.id} is not on disk, so its commit was not checked.` });
          continue;
        }
        if (r.commit === null) {
          out.push({ key: `${key}:no-commit`, path: shown, message: `apply ${entry.id} stopped before committing in ${shown}. Run sync-agent-docs rollback, then sync-agent-docs apply again.` });
          continue;
        }
        const head = await branchTip(r.path, r.branch);
        const exists = await hasCommit(r.path, r.commit);
        const kept = exists && (await merged(r.path, r.commit));
        const again = 'Run sync-agent-docs plan and sync-agent-docs apply again.';
        if (head === null) {
          if (!kept) out.push({ key: `${key}:gone`, path: shown, message: `${r.branch} in ${shown} was deleted before it was merged, so apply ${entry.id}'s changes there are lost. ${again}` });
        } else if (head !== r.commit && !kept && !(exists && (await isAncestor(r.path, r.commit, head)))) {
          out.push({ key: `${key}:gone`, path: shown, message: `${r.branch} in ${shown} no longer holds apply ${entry.id}'s commit ${r.commit.slice(0, 12)} and no branch merged it, so its changes there are lost. ${again}` });
        } else if (head !== r.commit && !(await merged(r.path, head))) {
          out.push({ key: `${key}:diverged`, path: shown, message: `${r.branch} in ${shown} has commits apply ${entry.id} did not make and is not merged. Review the branch, then merge it or run sync-agent-docs rollback.` });
        }
      }
    }
    return out;
  },
};
