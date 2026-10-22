import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApplyEntry } from '../../src/apply/branches.js';
import { runApply } from '../../src/apply/run.js';
import { runDoctor } from '../../src/doctor/run.js';
import type { CheckId, DoctorResult } from '../../src/doctor/types.js';
import { runPlan } from '../../src/plan/run.js';
import { materializeFixture } from './fixture.js';

export const NOW = new Date('2026-10-22T12:00:00.000Z');
export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
export const commit = (cwd: string, msg: string) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', msg);
};
export const merge = (entry: ApplyEntry | null) => {
  for (const r of entry?.repos ?? []) {
    git(r.path, 'switch', '-q', r.original);
    git(r.path, 'merge', '-q', '--ff-only', r.branch);
  }
};

/**
 * The fixture planned and applied. `answerAll` answers every item the way the compile tests do;
 * without it only the auto tier is answered, as `plan --accept-auto` would. The apply branches are
 * merged by hand unless `merged` is false, and the manual patch is applied unless `patched` is false.
 * `before` changes the fixture before plan runs.
 */
export async function applied(opts: { answerAll?: boolean; merged?: boolean; patched?: boolean; before?: (fx: Awaited<ReturnType<typeof materializeFixture>>) => Promise<void> } = {}) {
  const fx = await materializeFixture('messy-dev', { commit: true });
  await opts.before?.(fx);
  const store = join(fx.home, 'truth');
  const plan = await runPlan(fx.root, { home: fx.home, reposOnly: false, crontabCommand: 'false', store, now: NOW, acceptAuto: !opts.answerAll });
  if (opts.answerAll) {
    for (const i of plan.items) i.answer = i.tier === 'secret' ? 'rotate-remove' : i.follows ? 'accept' : (i.recommended ?? null);
    await writeFile(join(fx.root, '.sync-agent-docs', 'plan.json'), JSON.stringify(plan));
  }
  const entry = await runApply(fx.root, { home: fx.home, now: NOW });
  if (opts.merged !== false) merge(entry);
  // The one manual patch apply writes (git does not track ~/.claude/CLAUDE.md), applied by hand as the owner would.
  if (opts.answerAll && opts.patched !== false) {
    const global = join(fx.home, '.claude', 'CLAUDE.md');
    await writeFile(global, (await readFile(global, 'utf8')).replace('shop runs on port 4000\n', ''));
  }
  const doctor = (extra: Partial<Parameters<typeof runDoctor>[1]> = {}) => runDoctor(fx.root, { home: fx.home, crontabCommand: 'false', now: NOW, ...extra });
  return { ...fx, store, entry, doctor };
}

export const check = (r: DoctorResult, id: CheckId) => {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no ${id} check in the result`);
  return c;
};
