import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git, toplevelOf } from './git.js';

/** Whether `out` exists (null when not); refuses a symlink or a file there, so nothing is read or written through one. */
async function realDotDir(out: string, stage: string): Promise<{ isDirectory(): boolean } | null> {
  const existing = await lstat(out).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${stage}: could not check ${out} (${err.code ?? err.message}). Check its permissions.`, { cause: err });
  });
  if (existing && !existing.isDirectory()) {
    throw new Error(`${stage}: ${out} .sync-agent-docs is a symlink or not a folder, so nothing was read or written there. Remove it and run the ${stage} again.`);
  }
  return existing;
}

/**
 * Opens `<root>/.sync-agent-docs`, creating it with a `.gitignore` that ignores the folder itself.
 * Refuses a symlink or a file there, so nothing is ever written through a planted link.
 */
export async function openDotDir(root: string, stage: string): Promise<string> {
  const out = join(root, '.sync-agent-docs');
  const existing = await realDotDir(out, stage);
  try {
    if (!existing) await mkdir(out);
    await writeFresh(out, '.gitignore', '*\n');
  } catch (err) {
    throw new Error(`${stage}: could not write ${out} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Make the folder writable and run the ${stage} again.`, { cause: err });
  }
  return out;
}

/** Opens (creating) a folder inside an open `.sync-agent-docs`, refusing a symlink or a file there like the folder itself. */
export async function openSubDir(dot: string, name: string, stage: string): Promise<string> {
  const out = join(dot, name);
  const existing = await lstat(out).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${stage}: could not check ${out} (${err.code ?? err.message}). Check its permissions.`, { cause: err });
  });
  if (existing && !existing.isDirectory()) {
    throw new Error(`${stage}: ${out} is a symlink or not a folder, so nothing was written. Remove it and run the ${stage} again.`);
  }
  if (!existing) await mkdir(out);
  return out;
}

/**
 * Refuses a `<root>/.sync-agent-docs` that is a symlink, or that git tracks in any letter case: a cloned repo could ship decisions that wave its
 * secrets through, or an applies.json that points the store elsewhere.
 */
export async function refuseTrackedDotDir(root: string, stage: string): Promise<void> {
  await realDotDir(join(root, '.sync-agent-docs'), stage);
  if (!(await toplevelOf(root))) return;
  // icase: on a case-insensitive disk a committed .SYNC-AGENT-DOCS folder is read as .sync-agent-docs.
  const tracked = (await git(root, ['ls-files', '-z', '--', ':(icase).sync-agent-docs'], stage)).split('\0').filter(Boolean);
  if (tracked.length) {
    throw new Error(`${stage}: git tracks files in ${join(root, '.sync-agent-docs')} (${tracked.join(', ')}), so sync-agent-docs will not trust them. Remove them from git with: git rm -r --cached .sync-agent-docs`);
  }
}

/**
 * Writes to a new temp file (O_EXCL, so never through a planted symlink) and renames it over
 * the name, which replaces a symlink entry rather than following it.
 */
export async function writeFresh(dir: string, name: string, text: string, mode?: number): Promise<void> {
  const tmp = join(dir, `.${name.replaceAll('/', '_')}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, text, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    await rename(tmp, join(dir, name));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
