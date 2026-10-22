import { readFile } from 'node:fs/promises';
import { lineHasSecret } from '../../claims/secrets.js';
import { storePath } from '../../compile/deps.js';
import type { Check, Found } from '../types.js';

// How far edits may move a secret before a secret-looking line is taken to be a different one.
const WINDOW = 20;

/**
 * The 1-based line within WINDOW of `line` that looks like it holds a secret, so one that moved a
 * little is still found. Lines another manual record in the same file points at are not this one's.
 */
function nearestSecret(lines: string[], line: number, others: Set<number>): number | null {
  for (let d = 0; d <= WINDOW; d++) {
    for (const n of d ? [line - d, line + d] : [line]) if (n >= 1 && !others.has(n) && lineHasSecret(lines[n - 1] ?? '')) return n;
  }
  return null;
}

/**
 * Secrets the owner chose to rotate by hand: each is drift while its file still holds one, at the
 * recorded line or near it where edits moved it. Only the path and line are ever reported.
 */
export const secretsCheck: Check = {
  id: 'secrets',
  async run(ctx) {
    const out: Found[] = [];
    for (const s of ctx.store.secrets) {
      if (s.status !== 'manual') continue;
      const at = `${s.path}:${s.line}`;
      const file = storePath(s.path, ctx.store.config.root, ctx.home);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`doctor: could not read ${file} to check the secret at line ${s.line} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Check its permissions.`, { cause: err });
        out.push({ key: `secrets:${at}`, level: 'note', path: s.path, message: `${s.path} is gone, so the secret recorded at ${at} is no longer there. Rotate it if you have not.` });
        continue;
      }
      const others = new Set(ctx.store.secrets.filter((o) => o !== s && o.status === 'manual' && o.path === s.path).map((o) => o.line));
      const now = nearestSecret(text.split('\n'), s.line, others);
      if (now !== null) {
        const where = now === s.line ? at : `${s.path}:${now} (recorded at line ${s.line})`;
        out.push({ key: `secrets:${at}`, path: s.path, message: `${where} still holds the secret you chose to rotate by hand. Rotate it, move it to a secret store, then remove the line.` });
      }
    }
    return out;
  },
};
