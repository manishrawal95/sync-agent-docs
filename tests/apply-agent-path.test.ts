import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runApply } from '../src/apply/run.js';
import { runPlan } from '../src/plan/run.js';
import { materializeFixture } from './helpers/fixture.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** The fixture planned and answered with every recommendation, as a plan.json an old apply would still honour. */
async function planned() {
  const fx = await materializeFixture('messy-dev', { commit: true });
  const plan = await runPlan(fx.root, { home: fx.home, reposOnly: false, crontabCommand: 'false', store: join(fx.home, 'truth'), now: NOW });
  for (const i of plan.items) i.answer = i.recommended ?? null;
  await writeFile(join(fx.root, '.sync-agent-docs', 'plan.json'), JSON.stringify(plan));
  return { ...fx, apply: () => runApply(fx.root, { home: fx.home, now: NOW }) };
}

describe('apply: an old plan edit on an agent path that is no longer a file', () => {
  it('refuses a link loop by name before writing anything in any repo', async () => {
    const { root, apply } = await planned();
    const shop = join(root, 'shop');
    await rm(join(shop, 'CLAUDE.md'));
    await symlink('CLAUDE.md', join(shop, 'CLAUDE.md'));
    await expect(apply()).rejects.toThrow('apply: shop/CLAUDE.md is a link loop, so nothing was written. Delete the link or point it at a file, then run sync-agent-docs plan again.');
    expect(await readlink(join(shop, 'CLAUDE.md'))).toBe('CLAUDE.md');
    for (const repo of ['shop', 'blog']) expect(git(join(root, repo), 'branch', '--list', 'sync-agent-docs/*')).toBe('');
  });

  it('refuses a folder by name before writing anything in any repo', async () => {
    const { root, apply } = await planned();
    const shop = join(root, 'shop');
    await rm(join(shop, 'CLAUDE.md'));
    await mkdir(join(shop, 'CLAUDE.md'));
    const readme = await readFile(join(shop, 'README.md'), 'utf8');
    await expect(apply()).rejects.toThrow('apply: shop/CLAUDE.md is a folder, not a file, so nothing was written. Move it, then run sync-agent-docs plan again.');
    expect(await readFile(join(shop, 'README.md'), 'utf8')).toBe(readme);
    for (const repo of ['shop', 'blog']) expect(git(join(root, repo), 'branch', '--list', 'sync-agent-docs/*')).toBe('');
  });
});
