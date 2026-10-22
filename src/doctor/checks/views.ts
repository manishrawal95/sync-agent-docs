import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderViews } from '../../apply/run.js';
import { detectViewEdits } from '../../views/edits.js';
import type { Check, Found } from '../types.js';

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`doctor: could not read ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Check its permissions.`, { cause: err });
  }
}

/** Generated views edited by hand, and views the store would render differently now. */
export const viewsCheck: Check = {
  id: 'views',
  async run({ storeDir, store }) {
    const out: Found[] = [];
    const edits = await detectViewEdits(storeDir, store, 'doctor');
    for (const i of edits) {
      out.push({ key: `views:${i.subject}:edited`, message: `${i.title}. Run sync-agent-docs plan to fold the edit into the store or discard it.`, path: i.subject.split('#')[0] ?? i.subject });
    }
    const rendered = await renderViews(storeDir, store, new Set(edits.map((i) => i.subject)), 'doctor');
    for (const [file, { text }] of rendered) {
      const now = await readOrNull(join(storeDir, file));
      if (now === text) continue;
      const what = now === null ? 'is missing' : 'is out of date with the store';
      out.push({ key: `views:${file}:out-of-date`, message: `${file} ${what}. Run sync-agent-docs plan and sync-agent-docs apply to regenerate it.`, path: file });
    }
    return out;
  },
};
