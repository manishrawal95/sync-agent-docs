import { readFile } from 'node:fs/promises';
import { readCompiledBlock, type CompiledBlock } from '../../compile/block.js';
import { compiledDrift, compiledEditKey, isIgnoredOrUntracked } from '../../compile/compile.js';
import { shortPath } from '../../paths.js';
import type { Check, DoctorContext, Found } from '../types.js';
import { listedRepos } from './repos.js';

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
    const { repos, found } = await listedRepos(ctx);
    const out: Found[] = [...found];
    for (const { repo } of repos) {
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
