import { randomBytes } from 'node:crypto';
import { link, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { rmSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openDotDir } from './dotdir.js';
import { codeOf, nextStep } from './paths.js';

export type LockedCommand = 'plan' | 'apply' | 'compile' | 'rollback';
export interface LockHolder { pid: number; startedAt: string; command: LockedCommand }
export const LOCK_FILE = 'run.lock';
/** Inside `.git`, so taking it never changes the store's working tree. */
export const STORE_LOCK_FILE = 'sync-agent-docs-run.lock';

/** What a locked command can do while it holds the root lock. */
export interface RunLock {
  /** Also locks the truth store at `dir` once it is a git repository; a store not made yet has nothing to lock. Released before the root lock. */
  store(dir: string): Promise<void>;
}

const COMMANDS: readonly string[] = ['plan', 'apply', 'compile', 'rollback'];
const ATTEMPTS = 3;

/** One lock file: where it is and the words that place it in a refusal ("in <root>", "on the truth store <store>"). */
interface LockSite { folder: string; lock: string; place: string }

/** Locks this process holds now, as `<lock path>\0<startedAt>`: a lock naming this pid is live only when it is one of these. */
const held = new Set<string>();

/** Whether a process with this pid exists (EPERM counts as alive); any other failure is thrown as it came. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw err;
  }
}

/** The holder a lock names; null for anything sync-agent-docs did not write, including a pid of 0 or below, which kill would read as a process group. */
function parseHolder(text: string): LockHolder | null {
  try {
    const v = JSON.parse(text) as Partial<LockHolder> | null;
    if (v && Number.isInteger(v.pid) && (v.pid as number) > 0 && typeof v.startedAt === 'string' && typeof v.command === 'string' && COMMANDS.includes(v.command)) return v as LockHolder;
  } catch {
    // Not JSON: reported below as a file sync-agent-docs did not write.
  }
  return null;
}

/** Whether the holder still runs: this process holds only the locks it took, so its own pid on any other lock is a leftover. */
function holderRuns(site: LockSite, holder: LockHolder, command: LockedCommand): boolean {
  if (holder.pid === process.pid) return held.has(`${site.lock}\0${holder.startedAt}`);
  try {
    return isAlive(holder.pid);
  } catch (err) {
    throw new Error(`${command}: could not check whether process ${holder.pid} is running (${codeOf(err)}), so ${site.lock} was left in place. Delete it if no sync-agent-docs run is active, then run sync-agent-docs ${command} again.`, { cause: err });
  }
}

/** Tries once to link a new lock into place; false when a lock already exists. */
async function tryCreate(folder: string, lock: string, text: string): Promise<boolean> {
  const tmp = join(folder, `.${basename(lock)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, text, { flag: 'wx' });
    await link(tmp, lock);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    await rm(tmp, { force: true });
  }
}

async function acquire(site: LockSite, command: LockedCommand, mine: LockHolder): Promise<void> {
  const { folder, lock, place } = site;
  const text = `${JSON.stringify(mine)}\n`;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      if (await tryCreate(folder, lock, text)) return;
    } catch (err) {
      throw new Error(`${command}: could not write ${lock} (${codeOf(err)}). Make ${folder} writable and run sync-agent-docs ${command} again.`, { cause: err });
    }
    let raw: string;
    try {
      raw = await readFile(lock, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`${command}: could not read ${lock} (${codeOf(err)}). Make it readable and run sync-agent-docs ${command} again.`, { cause: err });
    }
    const holder = parseHolder(raw);
    if (!holder) {
      throw new Error(`${command}: ${lock} is not a lock sync-agent-docs wrote, so nothing was written. If no sync-agent-docs command is running, delete it and run sync-agent-docs ${command} again.`);
    }
    if (holderRuns(site, holder, command)) {
      throw new Error(`${command}: sync-agent-docs ${holder.command} (pid ${holder.pid}, started ${holder.startedAt}) is running ${place}, so nothing was written. Wait for it to finish and run sync-agent-docs ${command} again. If no sync-agent-docs command is running, delete ${lock}.`);
    }
    const stale = join(folder, `.${basename(lock)}.stale.${process.pid}.${randomBytes(6).toString('hex')}`);
    try {
      await rename(lock, stale);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`${command}: could not take over ${lock} (${codeOf(err)}). Make ${folder} writable and run sync-agent-docs ${command} again.`, { cause: err });
    }
    // Another run may have taken over the dead lock between our read and our rename, so what we moved can be its live lock.
    const moved = await readFile(stale, 'utf8').catch((err: NodeJS.ErrnoException) => {
      throw new Error(`${command}: could not read ${stale} (${err.code ?? err.message}). Delete it and run sync-agent-docs ${command} again.`, { cause: err });
    });
    if (moved === raw) {
      await rm(stale, { force: true });
      continue;
    }
    const other = parseHolder(moved);
    const who = other ? `sync-agent-docs ${other.command} (pid ${other.pid}, started ${other.startedAt})` : `another sync-agent-docs run`;
    const restored = await link(stale, lock).then(() => true, (err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') return false;
      throw new Error(`${command}: took over ${lock} while ${who} was taking it, and could not put it back (${err.code ?? err.message}). The lock is kept at ${stale}; check ps for sync-agent-docs runs, move it back to ${lock} if ${who} still runs, then run sync-agent-docs ${command} again.`, { cause: err });
    });
    if (restored) {
      await rm(stale, { force: true });
      throw new Error(`${command}: ${who} is running ${place}, so nothing was written. Wait for it to finish and run sync-agent-docs ${command} again. If no sync-agent-docs command is running, delete ${lock}.`);
    }
    // The stale file is the only copy of that run's lock, so it stays until the owner has checked.
    const third = await readFile(lock, 'utf8').then(parseHolder, () => null);
    const thirdWho = third ? `sync-agent-docs ${third.command} (pid ${third.pid}, started ${third.startedAt})` : 'another sync-agent-docs run';
    throw new Error(`${command}: ${who} and ${thirdWho} both took ${lock} at once, so nothing was written. Check ps for sync-agent-docs runs and wait for them to finish, then delete ${stale} and run sync-agent-docs ${command} again.`);
  }
  throw new Error(`${command}: could not take ${lock}; another sync-agent-docs run keeps taking it. Run sync-agent-docs ${command} again.`);
}

const isMine = (text: string, mine: LockHolder): boolean => {
  const h = parseHolder(text);
  return h?.pid === mine.pid && h.startedAt === mine.startedAt;
};

/** Removes the lock when it is still this run's; a lock deleted by hand and retaken by another run is left alone. */
async function release(lock: string, mine: LockHolder): Promise<void> {
  const text = await readFile(lock, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (text !== null && isMine(text, mine)) await rm(lock, { force: true });
}

/** Takes the lock at `site` for this run and returns how to give it back, async on the normal path and sync from an exit handler. */
async function take(site: LockSite, command: LockedCommand): Promise<{ lock: string; release(): Promise<void>; releaseSync(): void }> {
  const mine: LockHolder = { pid: process.pid, startedAt: new Date().toISOString(), command };
  await acquire(site, command, mine);
  const key = `${site.lock}\0${mine.startedAt}`;
  held.add(key);
  return {
    lock: site.lock,
    async release() {
      // Held until the file is gone, so a run in this process never reads it as a leftover and takes it over.
      try {
        await release(site.lock, mine);
      } finally {
        held.delete(key);
      }
    },
    releaseSync() {
      held.delete(key);
      try {
        if (isMine(readFileSync(site.lock, 'utf8'), mine)) rmSync(site.lock, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        process.stderr.write(`${command}: could not remove ${site.lock} on exit (${codeOf(err)}). Delete it before the next sync-agent-docs run.\n`);
      }
    },
  };
}

/** The store's own `.git` folder, or null when the store is not a git repository (yet): apply makes a new one there. */
async function storeGitDir(dir: string, command: LockedCommand): Promise<string | null> {
  const dotGit = join(dir, '.git');
  const info = await lstat(dotGit).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw new Error(`${command}: could not check ${dotGit} (${codeOf(err)}), so nothing was written. ${nextStep(err)} Then run sync-agent-docs ${command} again.`, { cause: err });
  });
  return info?.isDirectory() ? dotGit : null;
}

/**
 * Takes <root>/.sync-agent-docs/run.lock, runs fn, and releases the lock however fn ends. fn can also lock the truth store
 * (<store>/.git/sync-agent-docs-run.lock), since runs from different roots write the same store; locks go in reverse order.
 */
export async function withLock<T>(root: string, command: LockedCommand, fn: (lock: RunLock) => Promise<T>): Promise<T> {
  const folder = await openDotDir(root, command);
  const taken = [await take({ folder, lock: join(folder, LOCK_FILE), place: `in ${root}` }, command)];
  // process.exit skips the release below; the exit handler removes the locks synchronously.
  const onExit = (): void => {
    for (const t of [...taken].reverse()) t.releaseSync();
  };
  process.once('exit', onExit);
  const lock: RunLock = {
    async store(dir) {
      const gitDir = await storeGitDir(dir, command);
      if (gitDir) taken.push(await take({ folder: gitDir, lock: join(gitDir, STORE_LOCK_FILE), place: `on the truth store ${dir}` }, command));
    },
  };
  /** Releases every lock, newest first, even when one fails; the failures in one sentence each. */
  const releaseAll = async (): Promise<{ text: string; cause: unknown } | null> => {
    process.off('exit', onExit);
    const failed: { text: string; cause: unknown }[] = [];
    for (const t of taken.reverse()) {
      await t.release().catch((err: unknown) => failed.push({ text: `${command}: finished, but could not remove ${t.lock} (${codeOf(err)}). Delete it before the next run.`, cause: err }));
    }
    return failed.length ? { text: failed.map((f) => f.text).join(' '), cause: failed[0]?.cause } : null;
  };
  let result: T;
  try {
    result = await fn(lock);
  } catch (err) {
    const failed = await releaseAll();
    if (!failed) throw err;
    const e = err instanceof Error ? err : new Error(String(err), { cause: err });
    e.message += ` ${failed.text}`;
    throw e;
  }
  const failed = await releaseAll();
  if (failed) throw new Error(failed.text, { cause: failed.cause });
  return result;
}
