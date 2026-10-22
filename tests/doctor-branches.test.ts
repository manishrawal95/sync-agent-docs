import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applied, check, commit, git, NOW } from './helpers/doctor.js';

const BRANCH = 'sync-agent-docs/apply-20261022-120000';

describe('doctor: branches and apply records', () => {
  it('unmerged apply branches are pending, in each repo and the store', async () => {
    const { doctor } = await applied({ answerAll: true, merged: false });
    const r = await doctor();
    const keys = check(r, 'branches').findings.map((f) => f.key).sort();
    expect(keys).toContain(`branches:~/truth:${BRANCH}`);
    expect(keys).toContain(`branches:shop:${BRANCH}`);
    expect(check(r, 'branches').findings.every((f) => f.level === 'drift' && f.message.includes('merge'))).toBe(true);
    expect(check(r, 'applies').status).toBe('clean');
  });

  it('merged branches are not pending', async () => {
    const r = await (await applied({ answerAll: true })).doctor();
    expect(check(r, 'branches')).toEqual({ id: 'branches', status: 'clean', findings: [] });
    expect(check(r, 'applies').status).toBe('clean');
  });

  it('an unmerged apply branch that was deleted is a lost apply', async () => {
    const { root, doctor } = await applied({ answerAll: true, merged: false });
    const shop = join(root, 'shop');
    git(shop, 'switch', '-q', 'main');
    git(shop, 'branch', '-D', BRANCH);
    const c = check(await doctor(), 'applies');
    expect(c.findings).toEqual([expect.objectContaining({ key: `applies:20261022-120000:shop:gone`, level: 'drift', path: 'shop' })]);
  });

  it('an apply branch that moved off its commit and is unmerged has diverged', async () => {
    const { root, doctor } = await applied({ answerAll: true, merged: false });
    const shop = join(root, 'shop');
    await writeFile(join(shop, 'NOTES.txt'), 'more work\n');
    commit(shop, 'more work on the apply branch');
    expect(git(shop, 'branch', '--show-current')).toBe(BRANCH);
    const c = check(await doctor(), 'applies');
    expect(c.findings).toEqual([expect.objectContaining({ key: `applies:20261022-120000:shop:diverged`, level: 'drift' })]);
  });

  it('an apply branch reset back past its commit is a lost apply, even when its tip now matches main', async () => {
    const { root, doctor } = await applied({ answerAll: true, merged: false });
    const shop = join(root, 'shop');
    git(shop, 'reset', '-q', '--hard', 'HEAD~1');
    expect(git(shop, 'rev-parse', BRANCH)).toBe(git(shop, 'rev-parse', 'main'));
    const r = await doctor();
    expect(check(r, 'applies').findings).toEqual([expect.objectContaining({ key: `applies:20261022-120000:shop:gone`, level: 'drift', path: 'shop' })]);
  });

  it('an apply marked rolled back is not checked, even with its branch gone', async () => {
    const { root, doctor } = await applied({ answerAll: true, merged: false });
    const shop = join(root, 'shop');
    git(shop, 'switch', '-q', 'main');
    git(shop, 'branch', '-D', BRANCH);
    const path = join(root, '.sync-agent-docs', 'applies.json');
    const applies = JSON.parse(await readFile(path, 'utf8'));
    applies.applies[0].rolledBack = NOW.toISOString();
    await writeFile(path, JSON.stringify(applies));
    expect(check(await doctor(), 'applies')).toEqual({ id: 'applies', status: 'clean', findings: [] });
  });
});
