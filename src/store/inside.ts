import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The real path of `path`, resolving its nearest existing ancestor and keeping the rest as written. */
async function realOf(path: string): Promise<string> {
  let base = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(base), ...rest.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(base) === base) throw err;
      rest.push(relative(dirname(base), base));
      base = dirname(base);
    }
  }
}

/**
 * The path a store-relative `value` (a view or generated file) names inside `dir`, or null when it
 * is not a non-empty relative string that stays inside `dir`, symlinks followed.
 */
export async function insideStore(dir: string, value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || value === '' || isAbsolute(value)) return null;
  const at = resolve(dir, value);
  if (!at.startsWith(dir + sep)) return null;
  const [realDir, realAt] = await Promise.all([realOf(dir), realOf(at)]);
  return realAt.startsWith(realDir + sep) ? at : null;
}
