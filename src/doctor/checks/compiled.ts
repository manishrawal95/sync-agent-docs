import { readFile } from 'node:fs/promises';
import { editReason, readCompiledBlock, type CompiledBlock } from '../../compile/block.js';
import { compiledDrift, compiledEditKey, isIgnoredOrUntracked } from '../../compile/compile.js';
import { codeOf, nextStep, shortPath } from '../../paths.js';
import type { Check, DoctorContext, Found } from '../types.js';
import { listedRepos } from './repos.js';

const WHY = {
  missing: 'it has no compiled block. Run sync-agent-docs compile to add one.',
  stale: 'its compiled block is behind the store. Run sync-agent-docs compile to bring it up to date.',
};

/** Reads the compiled block of `file`: the block, or the reader's message when its markers are broken. */
async function readBlock(file: string): Promise<{ block: CompiledBlock | null } | { broken: string }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`doctor: could not read ${file} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
  }
  try {
    return { block: readCompiledBlock(text) };
  } catch (err) {
    return { broken: (err as Error).message };
  }
}

/** Whether plan remembered a keep answer for this exact edit. Broken markers have no edit key, so they stay drift. */
function kept(file: string, block: CompiledBlock | null, ctx: DoctorContext): boolean {
  if (!block) return false;
  const { key } = compiledEditKey(file, block, ctx.root, ctx.home);
  return ctx.decisions.some((d) => d.key === key && d.answer === 'keep');
}

/** The finding text for an edited block: which of the three ways it counts as edited. */
function editedWhy(path: string, read: Awaited<ReturnType<typeof readBlock>>): string {
  if ('broken' in read) return `${path}: its compiled block's markers are broken: ${read.broken}`;
  if (read.block && editReason(read.block) === 'hash-missing') {
    return `${path}: its compiled block's hash line is missing, so sync-agent-docs cannot tell it from a hand edit; a damaged marker looks the same. Run sync-agent-docs plan to discard or keep it.`;
  }
  return `${path}: its compiled block was edited by hand (the body no longer matches its hash line). Run sync-agent-docs plan to discard or keep the edit.`;
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
          continue;
        }
        if (d.kind !== 'edited') {
          out.push({ key: `compiled:${path}:${d.kind}`, message: `${path}: ${WHY[d.kind]}`, path });
          continue;
        }
        const read = await readBlock(d.file);
        if ('block' in read && kept(d.file, read.block, ctx)) {
          out.push({ key: `compiled:${path}:kept`, level: 'note', message: `${path}: its hand-edited block is kept, as you answered in plan.`, path });
        } else {
          out.push({ key: `compiled:${path}:edited`, message: editedWhy(path, read), path });
        }
      }
    }
    return out;
  },
};
