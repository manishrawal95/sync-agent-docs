import { mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRollback } from '../src/apply/rollback.js';
import { runApply } from '../src/apply/run.js';
import { runCompile } from '../src/compile/run.js';
import { withLock } from '../src/lock.js';
import { runPlan } from '../src/plan/run.js';
import { materializeFixture } from './helpers/fixture.js';

const temp = async () => realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-storelock-')));
const storeLockOf = (store: string) => join(store, '.git', 'sync-agent-docs-run.lock');
const rootLockOf = (root: string) => join(root, '.sync-agent-docs', 'run.lock');
const live = `${JSON.stringify({ pid: process.ppid, startedAt: '2026-10-28T09:00:00.000Z', command: 'compile' })}\n`;
const refusal = (command: string, store: string) =>
  new RegExp(`^${command}: sync-agent-docs compile \\(pid ${process.ppid}, started 2026-10-28T09:00:00.000Z\\) is running on the truth store ${store}, so nothing was written\\..*delete ${storeLockOf(store)}`);

describe('store lock', () => {
  it('a second root on the same store is refused while the first holds it, and both locks go after', async () => {
    const [a, b, store] = [await temp(), await temp(), await temp()];
    await mkdir(join(store, '.git'));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const first = withLock(a, 'apply', async (lock) => {
      await lock.store(store);
      expect(JSON.parse(await readFile(storeLockOf(store), 'utf8'))).toMatchObject({ pid: process.pid, command: 'apply' });
      entered();
      await gate;
      return 'first';
    });
    await inside;
    let ran = false;
    await expect(withLock(b, 'compile', async (lock) => { await lock.store(store); ran = true; })).rejects.toThrow(
      new RegExp(`^compile: sync-agent-docs apply \\(pid ${process.pid}, started .*\\) is running on the truth store ${store}, so nothing was written`));
    expect(ran).toBe(false);
    await expect(stat(rootLockOf(b))).rejects.toThrow(/ENOENT/);
    release();
    expect(await first).toBe('first');
    await expect(stat(storeLockOf(store))).rejects.toThrow(/ENOENT/);
    await expect(stat(rootLockOf(a))).rejects.toThrow(/ENOENT/);
    expect(await readdir(join(store, '.git'))).toEqual([]);
  });

  it('a store that is not a git repository yet takes no lock', async () => {
    const [root, store] = [await temp(), await temp()];
    expect(await withLock(root, 'apply', async (lock) => { await lock.store(store); return readdir(store); })).toEqual([]);
    expect(await withLock(root, 'apply', async (lock) => { await lock.store(join(store, 'new')); return 'ran'; })).toBe('ran');
  });

  it('apply, compile and rollback refuse while another run holds the store; plan only reads it', async () => {
    const { root, home } = await materializeFixture('messy-dev', { commit: true });
    const store = join(home, 'truth');
    const now = new Date('2026-10-22T12:00:00Z');
    await runPlan(root, { home, reposOnly: false, crontabCommand: 'false', store, now, acceptAuto: true });
    await runApply(root, { home, now });
    await writeFile(storeLockOf(store), live);

    await expect(runCompile(root, { home })).rejects.toThrow(refusal('compile', store));
    await expect(runRollback(root)).rejects.toThrow(refusal('rollback', store));
    await runPlan(root, { home, reposOnly: false, crontabCommand: 'false', store, now: new Date('2026-10-22T12:00:05Z'), acceptAuto: true });
    await expect(runApply(root, { home, now: new Date('2026-10-22T12:00:06Z') })).rejects.toThrow(refusal('apply', store));
    expect(await readFile(storeLockOf(store), 'utf8')).toBe(live);
    await expect(stat(rootLockOf(root))).rejects.toThrow(/ENOENT/);
  });
});
