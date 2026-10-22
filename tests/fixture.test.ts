import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeFixture } from './helpers/fixture.js';

async function allFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

describe('fixture', () => {
  it('materializes repos with .git', async () => {
    const { root } = await materializeFixture('messy-dev');
    for (const repo of ['ops', 'shop', 'blog']) expect(existsSync(join(root, repo, '.git'))).toBe(true);
  });

  it('commit: true leaves every repo clean on main', async () => {
    const { root } = await materializeFixture('messy-dev', { commit: true });
    for (const repo of ['ops', 'shop', 'blog']) {
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: join(root, repo), encoding: 'utf8' })).toBe('');
      expect(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: join(root, repo), encoding: 'utf8' }).trim()).toBe('main');
    }
  });

  it('secret is never on disk in the source tree', async () => {
    const { secret } = await materializeFixture('messy-dev');
    const source = new URL('./fixtures/', import.meta.url).pathname;
    for (const file of await allFiles(source)) {
      expect(await readFile(file, 'utf8')).not.toContain(secret);
    }
  });
});
