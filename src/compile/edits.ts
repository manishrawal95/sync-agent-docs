import { readFile } from 'node:fs/promises';
import type { PlanItem } from '../plan/types.js';
import { codeOf, isDir, nextStep, shortPath } from '../paths.js';
import type { Store } from '../store/types.js';
import { editReason, readCompiledBlock } from './block.js';
import { compiledDrift, compiledEditKey, type CompileContext } from './compile.js';
import { storePath } from './deps.js';

/**
 * A compiled block edited by hand becomes a discard-or-keep question. A block with broken markers is
 * left to compile and apply, which refuse it by name, since neither answer could repair it.
 */
export async function detectCompiledEdits(root: string, store: Store, ctx: CompileContext): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  for (const r of store.config.repos) {
    const repo = storePath(r.path, store.config.root, ctx.home);
    // A listed repo whose folder is gone has nothing to ask about; compile notes it when it runs.
    if (!(await isDir(repo, 'plan'))) continue;
    let drift;
    try {
      drift = await compiledDrift(repo, store, ctx);
    } catch (err) {
      throw new Error(`plan: could not read the agent files in ${shortPath(repo, root, ctx.home)}: ${(err as Error).message}`, { cause: err });
    }
    for (const d of drift) {
      if (d.kind !== 'edited') continue;
      const text = await readFile(d.file, 'utf8').catch((err: unknown) => {
        throw new Error(`plan: could not read ${shortPath(d.file, root, ctx.home)} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
      });
      let block;
      try {
        block = readCompiledBlock(text);
      } catch {
        // Broken markers: compile and apply refuse this file by name, so there is nothing to ask.
        continue;
      }
      if (!block) continue;
      const { key, subject } = compiledEditKey(d.file, block, root, ctx.home);
      items.push({
        key, tier: 'move', kind: 'compiled-edit', subject, candidates: [block.actual],
        title: editReason(block) === 'hash-missing' ? `${subject}: the compiled block has lost its hash line` : `${subject}: the compiled block was edited by hand`, evidence: [],
        options: ['discard', 'keep'], recommended: 'discard', answer: null, edits: {},
        notes: ['discard: compile rewrites the block from the store; change the store to change it. keep: compile leaves this edit in place until the block is edited again.'],
      });
    }
  }
  return items;
}
