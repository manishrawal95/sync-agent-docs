import { storePath } from '../../compile/deps.js';
import { inside, isDir, resolveReal, shortPath } from '../../paths.js';
import type { DoctorContext, Found } from '../types.js';

export interface ListedRepo { repo: string; repoReal: string }

/**
 * The repos sync-agent-docs.json lists that a check can look inside. A repo that is missing, is the
 * store, or sits outside the root comes back in `found`, the findings `compiled` reports; another check reports them only when `compiled` is off.
 */
export async function listedRepos(ctx: DoctorContext): Promise<{ repos: ListedRepo[]; found: Found[]; rootReal: string; storeReal: string }> {
  const { store, home } = ctx;
  const show = (p: string) => shortPath(p, ctx.root, home);
  const repos: ListedRepo[] = [];
  const found: Found[] = [];
  const storeReal = await resolveReal(ctx.storeDir, 'doctor');
  const rootReal = await resolveReal(storePath(store.config.root, home, home), 'doctor');
  for (const r of store.config.repos) {
    const repo = storePath(r.path, store.config.root, home);
    if (!(await isDir(repo, 'doctor'))) {
      found.push({ key: `compiled:${show(repo)}:not-there`, level: 'note', message: `${show(repo)} is listed in sync-agent-docs.json but is not there, so it was not checked.`, path: show(repo) });
      continue;
    }
    const repoReal = await resolveReal(repo, 'doctor');
    if (repoReal === storeReal) {
      found.push({ key: `compiled:${show(repo)}:store`, level: 'note', message: `${show(repo)} is the truth store, so it has no compiled blocks to check.`, path: show(repo) });
      continue;
    }
    if (!inside(repoReal, rootReal)) {
      found.push({ key: `compiled:${show(repo)}:outside-root`, message: `${show(repo)} is listed in sync-agent-docs.json but is outside root ${store.config.root}, so compile will refuse it. Move it under the root or take it out of repos.`, path: show(repo) });
      continue;
    }
    repos.push({ repo, repoReal });
  }
  return { repos, found, rootReal, storeReal };
}
