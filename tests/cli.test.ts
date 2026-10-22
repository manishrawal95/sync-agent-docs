import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const cli = ['--import', 'tsx', 'src/cli.ts'];

describe('cli', () => {
  it('prints version', () => {
    const out = execFileSync('node', [...cli, '--version'], { encoding: 'utf8' });
    expect(out.trim()).toBe(pkg.version);
  });

  it('unknown command exits 1 with a hint', () => {
    const r = spawnSync('node', [...cli, 'nope'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('truthfile --help');
  });
});
