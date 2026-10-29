import { readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Codes for a path that holds no file, so nothing is loaded from it. */
export const NOT_THERE: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

/** The error's code, or its message when it has none. */
export const codeOf = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err as Error).message;

/** Files under the scan root relative to it, files under home as `~/...`, anything else as is. */
export function shortPath(path: string, root: string, home: string): string {
  if (path.startsWith(`${root}/`)) return relative(root, path);
  return path.startsWith(`${home}/`) ? `~/${relative(home, path)}` : path;
}

/** `path` with every symlink resolved: realpath of the nearest folder that exists, then the missing tail. */
export async function resolveReal(path: string, stage: string): Promise<string> {
  const tail: string[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try {
      return join(await realpath(at), ...tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || dirname(at) === at) {
        throw new Error(`${stage}: could not resolve ${path} (${code ?? (err as Error).message}). Check its permissions.`, { cause: err });
      }
      tail.push(basename(at));
    }
  }
}

/**
 * A store path from --store or a file under `.sync-agent-docs`, which sync-agent-docs does not trust: it must be
 * absolute and, once symlinks are resolved, inside home. Returns the resolved path.
 */
export async function checkStorePath(store: unknown, home: string, source: string, stage: string, next: string): Promise<string> {
  const refuse = (): Error => new Error(`${stage}: ${source} names a store outside your home folder, so it was not used. ${next}`);
  if (typeof store !== 'string' || !isAbsolute(store)) throw refuse();
  const real = await resolveReal(store, stage);
  const rel = relative(await resolveReal(home, stage), real);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw refuse();
  return real;
}

/** Whether `path` is a folder; a missing path is not, and any other failure is named for `stage`. */
export async function isDir(path: string, stage: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`${stage}: could not check ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Check its permissions.`, { cause: err });
  }
}

/** Where a link at `path` points when nothing is there, or null when `path` is not a dangling link. */
export async function danglingLink(path: string, stage: string): Promise<string | null> {
  try {
    await stat(path);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw new Error(`${stage}: could not check ${path} (${code ?? (err as Error).message}). Check its permissions.`, { cause: err });
  }
  try {
    return await readlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EINVAL: a regular path, ENOENT: nothing there at all; neither is a link.
    if (code === 'EINVAL' || code === 'ENOENT') return null;
    throw new Error(`${stage}: could not read the link ${path} (${code ?? (err as Error).message}). Check its permissions.`, { cause: err });
  }
}

/** Whether `path` is `dir` or under it; both already resolved. */
export const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep);
