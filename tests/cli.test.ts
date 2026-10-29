import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeFixture } from './helpers/fixture.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const cli = ['--import', 'tsx', 'src/cli.ts'];
const temp = async () => realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-cli-')));

describe('cli', () => {
  it('prints version', () => {
    const out = execFileSync('node', [...cli, '--version'], { encoding: 'utf8' });
    expect(out.trim()).toBe(pkg.version);
  });

  it('unknown command exits 1 with a hint', () => {
    const r = spawnSync('node', [...cli, 'nope'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('sync-agent-docs --help');
  });

  it('help says --ai runs only claude and rollback undoes apply or compile', () => {
    const plan = execFileSync('node', [...cli, 'plan', '--help'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
    expect(plan).toContain('ask your claude CLI');
    expect(plan).toContain('codex and gemini are not supported yet');
    const rollback = execFileSync('node', [...cli, 'rollback', '--help'], { encoding: 'utf8' });
    expect(rollback).toContain('the last apply or compile');
  });

  it('a failing command names its stage once', async () => {
    const dir = await temp();
    const r = spawnSync('node', [...cli, 'rollback', dir], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^sync-agent-docs rollback failed: nothing to roll back;/);
    expect(r.stderr).not.toContain('failed: rollback:');
  });

  it('a path holding terminal escapes is printed without them, for every command', async () => {
    const dir = join(await temp(), 'shop\u001b]0;X\u0007\u001b[2Jnope');
    for (const cmd of ['scan', 'plan', 'apply', 'rollback', 'compile', 'doctor']) {
      const r = spawnSync('node', [...cli, cmd, dir], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
      expect(r.stderr).toContain('shop]0;X[2Jnope does not exist');
      // eslint-disable-next-line no-control-regex
      expect(r.stderr + r.stdout).not.toMatch(/[\u001b\u0007]/);
    }
  });

  it('apply has no --store option', () => {
    const r = spawnSync('node', [...cli, 'apply', '.', '--store', 'x'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown option '--store'/);
  });

  it("commander's own errors drop control characters from what was typed", () => {
    const r = spawnSync('node', [...cli, 'scan', '--x\u001b]0;owned\u0007', '.'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown option '--x\]0;owned'/);
    expect(r.stderr.includes('\u001b') || r.stderr.includes('\u0007')).toBe(false);
  });

  it('--json escapes C1 and bidi controls as \\uXXXX, so the text round-trips and reorders nothing on a terminal', async () => {
    const root = await temp();
    const name = 'shop\u202e\u009bx';
    const repo = join(root, name);
    await mkdir(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, 'CLAUDE.md'), '# Shop\n\nRuns on port 3300.\n');
    const r = spawnSync('node', [...cli, 'scan', root, '--json'], { encoding: 'utf8', env: { ...process.env, HOME: root, NO_COLOR: '1' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('\\u202e');
    expect(r.stdout).toContain('\\u009b');
    expect(r.stdout).not.toMatch(/[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(JSON.stringify(JSON.parse(r.stdout))).toContain(name);
  });

  it('scan, plan --json --accept-auto, apply, rollback through the CLI', async () => {
    const { root, home, secret } = await materializeFixture('messy-dev', { commit: true });
    const store = join(home, 'truth');
    const bin = await temp();
    await writeFile(join(bin, 'crontab'), '#!/bin/sh\necho "no crontab" >&2\nexit 1\n');
    await chmod(join(bin, 'crontab'), 0o755);
    const run = (...args: string[]) => spawnSync('node', [...cli, ...args], {
      encoding: 'utf8', env: { ...process.env, HOME: home, NO_COLOR: '1', PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    const branches = () => execFileSync('git', ['branch', '--list', 'sync-agent-docs/*'], { cwd: store, encoding: 'utf8' }).trim();

    const steps = [run('scan', root), run('plan', root, '--json', '--accept-auto', '--store', store), run('apply', root)];
    for (const r of steps) {
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain(secret);
    }
    expect(steps[2]?.stdout).toContain('Nothing was merged or pushed');
    expect(branches()).toMatch(/sync-agent-docs\/apply-\d{8}-\d{6}/);

    const back = run('rollback', root);
    expect(back.stderr).toBe('');
    expect(back.status).toBe(0);
    expect(branches()).toBe('');
    const again = run('rollback', root);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/nothing to roll back/);
  });

  it('compile through the CLI: up to date after a merged apply, a branch after a store change, undone by rollback', async () => {
    const { root, home, secret } = await materializeFixture('messy-dev', { commit: true });
    const store = join(home, 'truth');
    const bin = await temp();
    await writeFile(join(bin, 'crontab'), '#!/bin/sh\necho "no crontab" >&2\nexit 1\n');
    await chmod(join(bin, 'crontab'), 0o755);
    const run = (...args: string[]) => spawnSync('node', [...cli, ...args], {
      encoding: 'utf8', env: { ...process.env, HOME: home, NO_COLOR: '1', PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    for (const r of [run('scan', root), run('plan', root, '--json', '--accept-auto', '--store', store), run('apply', root)]) expect(r.status).toBe(0);
    const applies = JSON.parse(readFileSync(join(root, '.sync-agent-docs', 'applies.json'), 'utf8')) as { applies: { repos: { path: string; branch: string; original: string }[] }[] };
    for (const r of applies.applies[0]?.repos ?? []) {
      git(r.path, 'switch', '-q', r.original);
      git(r.path, 'merge', '-q', '--ff-only', r.branch);
    }

    const same = run('compile', root);
    expect(same.stderr).toBe('');
    expect(same.status).toBe(0);
    expect(same.stdout).toContain('up to date');

    const factsPath = join(store, 'store', 'facts.json');
    const facts = JSON.parse(readFileSync(factsPath, 'utf8')) as { facts: unknown[] };
    facts.facts.push({ entityId: 'project:shop', attribute: 'port', value: '4400', sources: [], status: 'verified' });
    await writeFile(factsPath, JSON.stringify(facts, null, 2));
    git(store, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'port 4400');
    const shop = join(root, 'shop');
    const changed = run('compile', root);
    expect(changed.stderr).toBe('');
    expect(changed.status).toBe(0);
    expect(changed.stdout).toContain('Nothing was merged or pushed');
    expect(changed.stdout).not.toContain(secret);
    const branch = git(shop, 'branch', '--list', '--format=%(refname:short)', 'sync-agent-docs/compile-*');
    expect(branch).toMatch(/^sync-agent-docs\/compile-\d{8}-\d{6}$/);
    expect(git(shop, 'show', `${branch}:CLAUDE.md`)).toContain('| port | `4400` | verified |');

    const back = run('rollback', root);
    expect(back.status).toBe(0);
    expect(git(shop, 'branch', '--list', 'sync-agent-docs/compile-*')).toBe('');
  });

  it('doctor through the CLI: 0 after the documented flow, 1 on a hand edit, 2 on a bad checks.json', async () => {
    const { root, home, secret } = await materializeFixture('messy-dev', { commit: true });
    const store = join(home, 'truth');
    const bin = await temp();
    await writeFile(join(bin, 'crontab'), '#!/bin/sh\necho "no crontab" >&2\nexit 1\n');
    await chmod(join(bin, 'crontab'), 0o755);
    const run = (...args: string[]) => spawnSync('node', [...cli, ...args], {
      encoding: 'utf8', env: { ...process.env, HOME: home, NO_COLOR: '1', PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    for (const r of [run('scan', root), run('plan', root, '--json', '--accept-auto', '--store', store), run('apply', root)]) expect(r.status).toBe(0);
    const applies = JSON.parse(readFileSync(join(root, '.sync-agent-docs', 'applies.json'), 'utf8')) as { applies: { repos: { path: string; branch: string; original: string }[] }[] };
    for (const r of applies.applies[0]?.repos ?? []) {
      git(r.path, 'switch', '-q', r.original);
      git(r.path, 'merge', '-q', '--ff-only', r.branch);
    }
    expect(run('compile', root).status).toBe(0);

    const clean = run('doctor', root);
    expect(clean.stderr).toBe('');
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('No drift.');
    expect(clean.stdout).toMatch(/\d+ plan items are still open/);

    const live = run('doctor', root, '--live', '--json');
    expect(live.status).toBe(0);
    expect(live.stderr).toContain('doctor --live: the store records no network targets');
    expect(JSON.parse(live.stdout)).toMatchObject({ schema: 1, drift: false, live: [] });

    const claude = join(root, 'shop', 'CLAUDE.md');
    await writeFile(claude, readFileSync(claude, 'utf8').replace('<!-- sync-agent-docs:end compiled -->', 'port is really 9999\n<!-- sync-agent-docs:end compiled -->'));
    const edited = run('doctor', root);
    expect(edited.status).toBe(1);
    expect(edited.stdout).toContain('DRIFT compiled');
    expect(edited.stdout).toContain('shop/CLAUDE.md');
    const json = run('doctor', root, '--json');
    expect(json.status).toBe(1);
    const parsed = JSON.parse(json.stdout) as { drift: boolean; checks: { id: string; status: string }[] };
    expect(parsed.drift).toBe(true);
    expect(parsed.checks.find((c) => c.id === 'compiled')?.status).toBe('drift');
    for (const out of [clean.stdout, live.stdout, edited.stdout, json.stdout]) expect(out).not.toContain(secret);

    await writeFile(join(root, '.sync-agent-docs', 'checks.json'), JSON.stringify({ schema: 1, disabled: ['rescna'] }));
    const bad = run('doctor', root);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/^sync-agent-docs doctor failed: .*checks\.json: disabled\[0\] is "rescna"/);
  });
});
