import { readFile } from 'node:fs/promises';
import { readCompiledBlock, type CompiledBlock } from '../../compile/block.js';
import { compiledDrift, compiledEditKey, isIgnoredOrUntracked } from '../../compile/compile.js';
import { storePath } from '../../compile/deps.js';
import { inside, isDir, resolveReal, shortPath } from '../../paths.js';
import type { Check, DoctorContext, Found } from '../types.js';

const WHY = {
  edited: 'its compiled block was edited by hand. Run sync-agent-docs plan to discard or keep the edit.',
  missing: 'it has no compiled block. Run sync-agent-docs compile to add one.',
  stale: 'its compiled block is behind the store. Run sync-agent-docs compile to bring it up to date.',
};

/** Whether plan remembered a keep answer for this exact edit. */
async function kept(file: string, ctx: DoctorContext): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`doctor: could not read ${file} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Check its permissions.`, { cause: err });
  }
  let block: CompiledBlock | null;
  try {
    block = readCompiledBlock(text);
  } catch {
    // Broken markers have no edit key, so no answer can be remembered for them; they stay drift.
    return false;
  }
  if (!block) return false;
  const { key } = compiledEditKey(file, block, ctx.root, ctx.home);
  return ctx.decisions.some((d) => d.key === key && d.answer === 'keep');
}

export const compiledCheck: Check = {
  id: 'compiled',
  async run(ctx) {
    const { store, home } = ctx;
    const show = (p: string) => shortPath(p, ctx.root, home);
    const out: Found[] = [];
    const storeReal = await resolveReal(ctx.storeDir, 'doctor');
    const rootReal = await resolveReal(storePath(store.config.root, home, home), 'doctor');
    for (const r of store.config.repos) {
      const repo = storePath(r.path, store.config.root, home);
      if (!(await isDir(repo, 'doctor'))) {
        out.push({ key: `compiled:${show(repo)}:not-there`, level: 'note', message: `${show(repo)} is listed in sync-agent-docs.json but is not there, so it was not checked.`, path: show(repo) });
        continue;
      }
      const repoReal = await resolveReal(repo, 'doctor');
      if (repoReal === storeReal) {
        out.push({ key: `compiled:${show(repo)}:store`, level: 'note', message: `${show(repo)} is the truth store, so it has no compiled blocks to check.`, path: show(repo) });
        continue;
      }
      if (!inside(repoReal, rootReal)) {
        out.push({ key: `compiled:${show(repo)}:outside-root`, message: `${show(repo)} is listed in sync-agent-docs.json but is outside root ${store.config.root}, so compile will refuse it. Move it under the root or take it out of repos.`, path: show(repo) });
        continue;
      }
      for (const d of await compiledDrift(repo, store, { storeDir: ctx.storeDir, home, isIgnoredOrUntracked })) {
        const path = show(d.file);
        if (d.kind === 'skipped') {
          out.push({ key: `compiled:${path}:skipped`, level: 'note', message: `${path} was not checked: ${d.reason}.`, path });
        } else if (d.kind === 'edited' && (await kept(d.file, ctx))) {
          out.push({ key: `compiled:${path}:kept`, level: 'note', message: `${path}: its hand-edited block is kept, as you answered in plan.`, path });
        } else {
          out.push({ key: `compiled:${path}:${d.kind}`, message: `${path}: ${WHY[d.kind]}`, path });
        }
      }
    }
    return out;
  },
};
