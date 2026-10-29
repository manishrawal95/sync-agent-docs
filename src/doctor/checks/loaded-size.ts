import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { importLines } from '../../compile/content.js';
import { COMPILED_FILES } from '../../compile/formats/index.js';
import { codeOf, inside, NOT_THERE, shortPath } from '../../paths.js';
import type { Check, Found } from '../types.js';
import { listedRepos } from './repos.js';

/** What an agent may load from one file per turn, imports included. */
export const LOADED_BUDGET_BYTES = 8 * 1024;

/** Codes for an import that cannot be counted: not there, or not ours to read. */
const SKIPPED: ReadonlySet<string> = new Set([...NOT_THERE, 'EACCES', 'EPERM']);

/** Whole budgets (in KB) a size has passed, so a finding re-keys only when the file grows a band. */
export function sizeBand(bytes: number): number {
  return Math.floor(bytes / LOADED_BUDGET_BYTES) * (LOADED_BUDGET_BYTES / 1024);
}

export interface LoadedSize {
  bytes: number;
  /** Real paths of the imports counted, sorted. */
  imports: string[];
}

/** The identity of `real` when it is a regular file; a folder holds nothing an agent loads. */
async function fileId(path: string, real: string): Promise<string | null> {
  try {
    const info = await stat(real);
    return info.isFile() ? `${info.dev}:${info.ino}` : null;
  } catch (err) {
    if (NOT_THERE.has((err as NodeJS.ErrnoException).code ?? '')) return null;
    throw new Error(`doctor: could not check ${path} (${codeOf(err)}). Check its permissions.`, { cause: err });
  }
}

/**
 * Bytes an agent loads from `path` every turn. `real` is its realpath (the base size); for a
 * CLAUDE.md, each distinct @ import inside `within` adds its size. Imports are only stat-ed, never read,
 * and only one level deep.
 */
export async function loadedSize(
  path: string,
  real: string,
  opts: { claude: boolean; home: string; within: string[] },
): Promise<LoadedSize> {
  let bytes: number;
  let text = '';
  try {
    bytes = (await stat(real)).size;
    if (opts.claude) text = await readFile(real, 'utf8');
  } catch (err) {
    throw new Error(`doctor: could not read ${path} (${codeOf(err)}). Check its permissions.`, { cause: err });
  }
  const sizes = new Map<string, number>();
  for (const ref of importLines(text)) {
    const target = ref.startsWith('~/') ? join(opts.home, ref.slice(2)) : isAbsolute(ref) ? ref : resolve(dirname(path), ref);
    try {
      const importReal = await realpath(target);
      if (sizes.has(importReal) || !opts.within.some((w) => inside(importReal, w))) continue;
      const info = await stat(importReal);
      if (info.isFile()) sizes.set(importReal, info.size);
    } catch (err) {
      if (SKIPPED.has((err as NodeJS.ErrnoException).code ?? '')) continue;
      throw new Error(`doctor: could not check ${target}, imported by ${path} (${codeOf(err)}). Check its permissions.`, { cause: err });
    }
  }
  const imports = [...sizes.keys()].sort();
  return { bytes: bytes + [...sizes.values()].reduce((a, b) => a + b, 0), imports };
}

export const loadedSizeCheck: Check = {
  id: 'loaded-size',
  async run(ctx) {
    const show = (p: string) => shortPath(p, ctx.root, ctx.home);
    const { repos, found, rootReal, storeReal } = await listedRepos(ctx);
    // `compiled` reports the repos it cannot look inside; this check does so only when that one is off.
    const out: Found[] = ctx.disabled.has('compiled') ? [...found] : [];
    const seen = new Set<string>();
    for (const { repo, repoReal } of repos) {
      for (const f of COMPILED_FILES) {
        const path = join(repo, f);
        let real: string;
        try {
          real = await realpath(path);
        } catch (err) {
          if (NOT_THERE.has((err as NodeJS.ErrnoException).code ?? '')) continue;
          throw new Error(`doctor: could not check ${path} (${codeOf(err)}). Check its permissions.`, { cause: err });
        }
        if (!inside(real, repoReal)) continue;
        const id = await fileId(path, real);
        if (id === null || seen.has(id)) continue;
        seen.add(id);
        const { bytes, imports } = await loadedSize(path, real, { claude: f === 'CLAUDE.md', home: ctx.home, within: [rootReal, storeReal] });
        if (bytes > LOADED_BUDGET_BYTES) {
          out.push({
            key: `loaded-size:${show(path)}:over-${sizeBand(bytes)}k`,
            message: `${show(path)}: an agent loads ${(Math.ceil(bytes / 102.4) / 10).toFixed(1)} KB from it every turn, imports included (budget ${LOADED_BUDGET_BYTES / 1024} KB). Move what only some tasks need into a doc it links to without @.${imports.length ? ` Imports counted: ${imports.map(show).join(', ')}.` : ''}`,
            path: show(path),
          });
        }
      }
    }
    return out;
  },
};
