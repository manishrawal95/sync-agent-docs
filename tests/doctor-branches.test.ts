import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
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

  it.skipIf(process.getuid?.() === 0)('a recorded repo whose .git git cannot open stops doctor with git\'s own reason', async () => {
    const { root, doctor } = await applied({ answerAll: true, merged: false });
    const dotGit = join(root, 'shop', '.git');
    await chmod(dotGit, 0o000);
    try {
      const err = await doctor().then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/^doctor: the applies check could not run: doctor: git rev-parse failed in .*shop: .*not a git repository.* Fix that repo and run doctor again\.$/);
    } finally {
      await chmod(dotGit, 0o755);
    }
  });

  it('a recorded repo that is no longer a git repo is drift naming the fix, not an abort', async () => {
    const { root, doctor } = await applied({ answerAll: true, merged: false });
    await rm(join(root, 'shop', '.git'), { recursive: true });
    const c = check(await doctor(), 'applies');
    expect(c.status).toBe('drift');
    expect(c.findings).toEqual([expect.objectContaining({
      key: 'applies:20261022-120000:shop:not-a-repo',
      message: expect.stringMatching(/^shop from apply 20261022-120000 is no longer a git repository, so its commit was not checked\. Re-clone it, or run sync-agent-docs rollback or remove that apply entry from \.sync-agent-docs\/applies\.json\.$/),
    })]);
  });
});
