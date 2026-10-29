import { lstat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { codeOf, inside, nextStep, resolveReal } from '../paths.js';
import { COMPILED_FILES } from './formats/index.js';

/** Where a link that must not be written through leads: `target` is relative to the repo when inside it. */
export interface RefusedLink { real: string; target: string; inRepo: boolean }

/** The nearest folder at or above `dir`, by name, that holds a .git entry; null outside every repo. */
async function repoTop(dir: string, stage: string): Promise<string | null> {
  for (let at = dir; ; at = dirname(at)) {
    const found = await lstat(join(at, '.git')).then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
        throw new Error(`${stage}: could not check ${join(at, '.git')} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
      },
    );
    if (found) return at;
    if (dirname(at) === at) return null;
  }
}

/**
 * The one rule for writing a file reached through a link, which compile, drift, plan and apply all
 * follow: it is written only when its real path is one of the five agent files of its repo, never a
 * script, a manifest or anything under .git. A machine file outside every repo (say ~/.claude/CLAUDE.md
 * linked into a config repo) may lead to a file of the same name that is not under .git. Returns null
 * when `path` may be written. `top` is the repo `path` belongs to, when the caller knows it.
 */
export async function refusedLink(path: string, stage: string, top?: string): Promise<RefusedLink | null> {
  const repo = top ?? (await repoTop(dirname(path), stage));
  const base = repo ?? dirname(path);
  const baseReal = await resolveReal(base, stage);
  const real = await resolveReal(path, stage);
  if (real === join(baseReal, relative(base, path))) return null;
  if (COMPILED_FILES.some((f) => join(baseReal, f) === real)) return null;
  if (!repo && basename(real) === basename(path) && !real.split(sep).includes('.git')) return null;
  const inRepo = repo !== null && inside(real, baseReal);
  return { real, target: inRepo ? relative(baseReal, real) : real, inRepo };
}
