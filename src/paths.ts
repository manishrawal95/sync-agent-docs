import { readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Codes for a path that holds no file, so nothing is loaded from it. */
export const NOT_THERE: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

/** Codes for a path that is absent: nothing there, or a file where a folder would be. A link loop is not absent, so it is named. */
export const ABSENT: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/** The error's code, or its message when it has none. */
export const codeOf = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err as Error).message;

/** What to do about a failed filesystem call, by its error code. */
export function nextStep(err: unknown): string {
  switch (codeOf(err)) {
    case 'ELOOP': return 'A link in the path leads back to itself; fix or delete that link.';
    case 'ENOTDIR': return 'Part of the path is a file, not a folder; move it or pick another path.';
    case 'EACCES':
    case 'EPERM': return 'Check its permissions.';
    case 'EISDIR': return 'The path is a folder, not a file; pick the file inside it.';
    case 'ENOSPC': return 'The disk is full; free some space and try again.';
    case 'EROFS': return 'The disk is read-only; pick a writable path.';
    case 'EMFILE':
    case 'ENFILE': return 'Too many files are open; close some programs and try again.';
    default: return 'Check the path and try again.';
  }
}

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
      if (!ABSENT.has(codeOf(err)) || dirname(at) === at) {
        throw new Error(`${stage}: could not resolve ${path} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
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
    if (ABSENT.has(codeOf(err))) return false;
    throw new Error(`${stage}: could not check ${path} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
  }
}

/** Whether `path` is a link loop: following its links never reaches a file. Any other failure is named for `stage`. */
export async function linkLoop(path: string, stage: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return true;
    if (ABSENT.has(code ?? '')) return false;
    throw new Error(`${stage}: could not check ${path} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
  }
}

/** Where a link at `path` points when nothing is there, or null when `path` is not a dangling link. Check `linkLoop` first: a loop throws here. */
export async function danglingLink(path: string, stage: string): Promise<string | null> {
  try {
    await stat(path);
    return null;
  } catch (err) {
    if (!ABSENT.has(codeOf(err))) throw new Error(`${stage}: could not check ${path} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
  }
  try {
    return await readlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EINVAL: a regular path, ENOENT and ENOTDIR: nothing there at all; none is a link.
    if (code === 'EINVAL' || code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new Error(`${stage}: could not read the link ${path} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
  }
}

/** Whether `path` is `dir` or under it; both already resolved. */
export const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep);
