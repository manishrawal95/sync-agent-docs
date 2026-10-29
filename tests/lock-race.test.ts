import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename as realRename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDotDir } from '../src/dotdir.js';

// Runs the injected step once, just before the first rename of run.lock: where a second run could take the dead lock over.
let beforeRename: (() => Promise<void>) | null = null;
let beforeMkdir: (() => Promise<void>) | null = null;
let beforeRestore: (() => Promise<void>) | null = null;
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    mkdir: async (...args: Parameters<typeof real.mkdir>) => {
      const step = beforeMkdir;
      beforeMkdir = null;
      if (step) await step();
      return real.mkdir(...args);
    },
    link: async (from: string, to: string) => {
      const step = beforeRestore;
      if (step && from.includes('.stale.')) {
        beforeRestore = null;
        await step();
      }
      return real.link(from, to);
    },
    rename: async (from: string, to: string) => {
      if (beforeRename && from.endsWith('run.lock')) {
        const step = beforeRename;
        beforeRename = null;
        await step();
      }
      return real.rename(from, to);
    },
  };
});
const { withLock } = await import('../src/lock.js');

const temp = async () => realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-lockrace-')));
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid as number;
const text = (pid: number, command: string) => JSON.stringify({ pid, startedAt: '2026-10-28T09:00:00.000Z', command });

describe('stale lock takeover race', () => {
  it('puts back a live lock another run linked before our rename, and refuses naming it', async () => {
    const root = await temp();
    const dot = join(root, '.sync-agent-docs');
    await mkdir(dot);
    const lock = join(dot, 'run.lock');
    await writeFile(lock, text(deadPid(), 'apply'));
    const live = `${text(process.ppid, 'compile')}\n`;
    beforeRename = async () => {
      await realRename(lock, join(dot, 'other.gone'));
      await writeFile(lock, live);
    };
    let ran = false;
    await expect(withLock(root, 'plan', async () => { ran = true; })).rejects.toThrow(
      new RegExp(`^plan: sync-agent-docs compile \\(pid ${process.ppid}, started 2026-10-28T09:00:00.000Z\\) is running`));
    expect(ran).toBe(false);
    expect(await readFile(lock, 'utf8')).toBe(live);
    expect((await readdir(dot)).filter((n) => n.includes('stale'))).toEqual([]);
  });

  it('refuses naming both runs when a third took the lock while we put it back', async () => {
    const root = await temp();
    const dot = join(root, '.sync-agent-docs');
    await mkdir(dot);
    const lock = join(dot, 'run.lock');
    await writeFile(lock, text(deadPid(), 'apply'));
    beforeRename = async () => {
      await realRename(lock, join(dot, 'other.gone'));
      await writeFile(lock, `${text(process.ppid, 'compile')}\n`);
    };
    beforeRestore = async () => writeFile(lock, `${text(process.ppid, 'rollback')}\n`);
    await expect(withLock(root, 'plan', async () => undefined)).rejects.toThrow(
      new RegExp(`sync-agent-docs compile \\(pid ${process.ppid}, started .*sync-agent-docs rollback \\(pid ${process.ppid}, started .*both took .*Check ps.*delete .*\\.stale\\.`));
    expect(await readFile(lock, 'utf8')).toBe(`${text(process.ppid, 'rollback')}\n`);
    const stale = (await readdir(dot)).filter((n) => n.includes('.stale.'));
    expect(stale).toHaveLength(1);
    expect(await readFile(join(dot, stale[0] as string), 'utf8')).toBe(`${text(process.ppid, 'compile')}\n`);
  });
});

describe('openDotDir', () => {
  it('says what is there when a parallel run put a file where the folder goes', async () => {
    const root = await temp();
    beforeMkdir = async () => writeFile(join(root, '.sync-agent-docs'), 'x');
    await expect(openDotDir(root, 'plan')).rejects.toThrow(/is a file, not a folder.*Move or delete it/);
  });

  it('two calls at once on a fresh root both succeed', async () => {
    const root = await temp();
    const [a, b] = await Promise.all([openDotDir(root, 'plan'), openDotDir(root, 'apply')]);
    expect(a).toBe(b);
  });
});
