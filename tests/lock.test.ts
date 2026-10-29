import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runApply } from '../src/apply/run.js';
import { isAlive, withLock } from '../src/lock.js';
import { runPlan } from '../src/plan/run.js';
import { materializeFixture } from './helpers/fixture.js';

const temp = async () => realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-lock-')));
const lockOf = (root: string) => join(root, '.sync-agent-docs', 'run.lock');
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid as number;
const holder = (pid: number) => JSON.stringify({ pid, startedAt: '2026-10-28T09:00:00.000Z', command: 'apply' });

describe('run lock', () => {
  it('writes pid, start time and command while held, and removes the lock after', async () => {
    const root = await temp();
    const seen = await withLock(root, 'plan', async () => JSON.parse(await readFile(lockOf(root), 'utf8')));
    expect(seen).toEqual({ pid: process.pid, startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), command: 'plan' });
    await expect(stat(lockOf(root))).rejects.toThrow(/ENOENT/);
  });

  it('releases the lock when the command throws', async () => {
    const root = await temp();
    await expect(withLock(root, 'compile', async () => { throw new Error('compile: boom'); })).rejects.toThrow('compile: boom');
    await expect(stat(lockOf(root))).rejects.toThrow(/ENOENT/);
  });

  it('refuses while a live process holds it, naming its pid, command and start time', async () => {
    const root = await temp();
    await mkdir(join(root, '.sync-agent-docs'));
    await writeFile(lockOf(root), holder(process.ppid));
    let ran = false;
    await expect(withLock(root, 'plan', async () => { ran = true; })).rejects.toThrow(
      new RegExp(`^plan: sync-agent-docs apply \\(pid ${process.ppid}, started 2026-10-28T09:00:00.000Z\\) is running in .*nothing was written.*delete .*run\\.lock`));
    expect(ran).toBe(false);
    expect(await readFile(lockOf(root), 'utf8')).toBe(holder(process.ppid));
  });

  it('takes over a lock whose process is gone', async () => {
    const root = await temp();
    await mkdir(join(root, '.sync-agent-docs'));
    const pid = deadPid();
    expect(isAlive(pid)).toBe(false);
    await writeFile(lockOf(root), holder(pid));
    expect(await withLock(root, 'rollback', async () => 'ran')).toBe('ran');
    await expect(stat(lockOf(root))).rejects.toThrow(/ENOENT/);
    expect((await readdir(join(root, '.sync-agent-docs'))).filter((n) => n.includes('run.lock'))).toEqual([]);
  });

  it('refuses a lock file it did not write', async () => {
    const root = await temp();
    await mkdir(join(root, '.sync-agent-docs'));
    await writeFile(lockOf(root), 'not json');
    await expect(withLock(root, 'apply', async () => 'ran')).rejects.toThrow(/apply: .*run\.lock is not a lock sync-agent-docs wrote/);
  });

  it('refuses a lock naming pid 0 or a negative pid as damaged, never as live', async () => {
    for (const pid of [0, -1]) {
      const root = await temp();
      await mkdir(join(root, '.sync-agent-docs'));
      await writeFile(lockOf(root), holder(pid));
      await expect(withLock(root, 'apply', async () => 'ran')).rejects.toThrow(/apply: .*run\.lock is not a lock sync-agent-docs wrote/);
    }
  });

  it('takes over a lock naming this process that this process never took', async () => {
    const root = await temp();
    await mkdir(join(root, '.sync-agent-docs'));
    await writeFile(lockOf(root), holder(process.pid));
    expect(await withLock(root, 'plan', async () => 'ran')).toBe('ran');
    await expect(stat(lockOf(root))).rejects.toThrow(/ENOENT/);
  });

  it('names the command and the lock when it cannot tell whether the holder runs', async () => {
    const root = await temp();
    await mkdir(join(root, '.sync-agent-docs'));
    await writeFile(lockOf(root), holder(424242));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('kill EINVAL'), { code: 'EINVAL' }); });
    try {
      await expect(withLock(root, 'compile', async () => 'ran')).rejects.toThrow(
        `compile: could not check whether process 424242 is running (EINVAL), so ${lockOf(root)} was left in place. Delete it if no sync-agent-docs run is active, then run sync-agent-docs compile again.`);
    } finally {
      kill.mockRestore();
    }
    expect(await readFile(lockOf(root), 'utf8')).toBe(holder(424242));
  });

  it('a non-Error thrown by the command still carries the failed release', async () => {
    const root = await temp();
    const thrown = await withLock(root, 'apply', async () => {
      await rm(lockOf(root));
      await mkdir(lockOf(root));
      throw 'boom';
    }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(new RegExp(`^boom apply: finished, but could not remove ${lockOf(root)} \\(EISDIR\\)\\. Delete it before the next run\\.$`));
  });

  it('says on stderr when the exit handler cannot remove the lock', async () => {
    const root = await temp();
    let onExit: (() => void) | undefined;
    const once = vi.spyOn(process, 'once').mockImplementation(((event: string, fn: () => void) => {
      if (event === 'exit') onExit = fn;
      return process;
    }) as typeof process.once);
    const errors: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; });
    try {
      await withLock(root, 'plan', async () => {
        await rm(lockOf(root));
        await mkdir(lockOf(root));
        onExit?.();
        await rm(lockOf(root), { recursive: true });
      });
    } finally {
      once.mockRestore();
      write.mockRestore();
    }
    expect(errors).toEqual([`plan: could not remove ${lockOf(root)} on exit (EISDIR). Delete it before the next sync-agent-docs run.\n`]);
  });

  it('refuses a .sync-agent-docs that is a file, naming the folder once', async () => {
    const root = await temp();
    await writeFile(join(root, '.sync-agent-docs'), 'x');
    await expect(withLock(root, 'plan', async () => 'ran')).rejects.toThrow(
      `plan: ${join(root, '.sync-agent-docs')} is a symlink or not a folder, so nothing was read or written there.`);
  });

  it('two applies at once: one runs, the other is refused by the lock, not a bare EEXIST', async () => {
    const { root, home } = await materializeFixture('messy-dev', { commit: true });
    const t1 = new Date('2026-10-22T12:00:00Z');
    await runPlan(root, { home, reposOnly: false, crontabCommand: 'false', store: join(home, 'truth'), now: t1, acceptAuto: true });
    const rs = await Promise.allSettled([runApply(root, { home, now: t1 }), runApply(root, { home, now: new Date('2026-10-22T12:00:01Z') })]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as Error).message).toMatch(/^apply: sync-agent-docs apply \(pid \d+, started .*\) is running in/);
    expect((refused.reason as Error).message).not.toContain('EEXIST');
    const applies = JSON.parse(await readFile(join(root, '.sync-agent-docs', 'applies.json'), 'utf8')) as { applies: unknown[] };
    expect(applies.applies).toHaveLength(1);
    await expect(stat(lockOf(root))).rejects.toThrow(/ENOENT/);
  });

  it('an asker that rejects (Ctrl-C at a question) leaves no lock', async () => {
    const { root, home } = await materializeFixture('messy-dev', { commit: true });
    const asker = { ask: async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); }, print: () => undefined };
    await expect(runPlan(root, { home, reposOnly: false, crontabCommand: 'false', store: join(home, 'truth'), asker })).rejects.toThrow(/aborted/);
    await expect(stat(lockOf(root))).rejects.toThrow(/ENOENT/);
  });
});
