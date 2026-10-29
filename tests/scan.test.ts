import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeCompiledBlock } from '../src/compile/block.js';
import { renderTerminal } from '../src/report/terminal.js';
import { runScan } from '../src/scan.js';
import type { ScanResult } from '../src/types.js';
import { materializeFixture } from './helpers/fixture.js';

const scan = (root: string, home: string) => runScan(root, { home, reposOnly: true, crontabCommand: 'sync-agent-docs-test-no-crontab', now: new Date('2026-10-21T12:00:00Z') });

const cli = ['--import', 'tsx', 'src/cli.ts'];

/** Runs the CLI with the fixture as HOME and a crontab that has no jobs, so the owner's machine is never read. */
async function runCli(args: string[], home: string) {
  const bin = join(home, '..', 'fake-bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'crontab'), '#!/bin/sh\necho "crontab: no crontab for test" >&2\nexit 1\n');
  await chmod(join(bin, 'crontab'), 0o755);
  return spawnSync('node', [...cli, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home, NO_COLOR: '1', PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(p);
  }
  return out;
}

describe('scan', () => {
  it('scan of the fixture writes scan.json and a self-ignoring .sync-agent-docs', async () => {
    const { root, home } = await materializeFixture('messy-dev');
    const result = await runScan(root, { home, reposOnly: false, crontabCommand: 'sync-agent-docs-test-no-crontab', now: new Date('2026-10-21T12:00:00Z') });
    expect(await readFile(join(root, '.sync-agent-docs', '.gitignore'), 'utf8')).toBe('*\n');
    const written = JSON.parse(await readFile(join(root, '.sync-agent-docs', 'scan.json'), 'utf8')) as ScanResult;
    expect(written).toEqual(JSON.parse(JSON.stringify(result)));
    expect(written.scannedAt).toBe('2026-10-21T12:00:00.000Z');
    expect(written.repos.map((r) => r.name).sort()).toEqual(['blog', 'ops', 'shop']);
    expect(written.entities.length).toBeGreaterThan(0);
  });

  it('terminal output shows the shop port conflict first', async () => {
    const { root, home } = await materializeFixture('messy-dev');
    const out = renderTerminal(await runScan(root, { home, reposOnly: false, crontabCommand: 'sync-agent-docs-test-no-crontab' }), { color: false });
    const lines = out.split('\n');
    const first = lines.findIndex((l) => /✖|⚠|◐|\?/.test(l));
    expect(lines[first]).toMatch(/✖ 1 conflict\s+shop port: 3300 \(.*shop\/ecosystem\.config\.cjs.*\)/);
    expect(out).toContain('3000 (shop/README.md)');
    expect(out).toContain('Also read: ');
    expect(out).toContain('3 repos');
    expect(out).toContain('Context health: 73/100');
    expect(out).not.toMatch(/—/);
  });

  it("a doc's 'listens on N' conflicts with the config once the config's port moves", async () => {
    const { root, home } = await materializeFixture('messy-dev');
    const eco = join(root, 'shop', 'ecosystem.config.cjs');
    await writeFile(eco, (await readFile(eco, 'utf8')).replace('-p 3300', '-p 3400'));
    const result = await scan(root, home);
    const conflict = result.findings.find((f) => f.type === 'conflict');
    const at = (value: string) => conflict?.values?.find((v) => v.value === value)?.at.map((a) => `${a.path.slice(root.length + 1)}:${a.line}`);
    expect(at('3300')).toContain('shop/CLAUDE.md:3');
    expect(at('3400')).toContain('shop/ecosystem.config.cjs:6');
  });

  it('a clean scan says so and still prints the score', async () => {
    const { root, home } = await materializeFixture('messy-dev');
    const result = await runScan(root, { home, reposOnly: true });
    const out = renderTerminal({ ...result, findings: [], score: 100 }, { color: false });
    expect(out).toContain('No conflicts, stale references or plain-text secrets found');
    expect(out).toContain('Context health: 100/100');
  });

  it('the next step names what was actually found', async () => {
    const { root, home } = await materializeFixture('messy-dev');
    const result = await runScan(root, { home, reposOnly: true });
    const only = (type: string) => renderTerminal({ ...result, findings: result.findings.filter((f) => f.type === type) }, { color: false });
    expect(only('conflict')).toContain('Next: fix the conflict first');
    expect(only('secret')).toContain('Next: move the plain-text secret out of that file first');
    expect(only('stale')).toContain('Next: update or remove the stale references');
    for (const type of ['secret', 'stale']) expect(only(type)).not.toContain('conflict');
  });

  it('no output contains the secret', async () => {
    const { root, home, secret } = await materializeFixture('messy-dev');
    const text = await runCli(['scan', root], home);
    const json = await runCli(['scan', root, '--json'], home);
    expect(text.status).toBe(0);
    expect(json.status).toBe(0);
    for (const out of [text.stdout, text.stderr, json.stdout, json.stderr]) expect(out).not.toContain(secret.slice(4));
    for (const file of await allFiles(join(root, '.sync-agent-docs'))) expect(await readFile(file, 'utf8')).not.toContain(secret.slice(4));
    expect(text.stdout).toContain('secret');
  });

  it('--repos-only reads no machine files', async () => {
    const { root, home } = await materializeFixture('messy-dev');
    const r = await runCli(['scan', root, '--repos-only', '--json'], home);
    const result = JSON.parse(r.stdout) as ScanResult;
    expect(result.machineFilesRead).toEqual([]);
    expect(result.findings.some((f) => f.type === 'global-local')).toBe(false);
    expect(result.facts.every((f) => f.at.path.startsWith(root))).toBe(true);
    expect((await runCli(['scan', root, '--repos-only'], home)).stdout).not.toContain('Also read');
  });

  it('refuses a .sync-agent-docs that is a symlink and writes nothing through it', async () => {
    const { root, home } = await materializeFixture('messy-dev');
    const elsewhere = join(home, '..', 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, join(root, '.sync-agent-docs'));
    await expect(runScan(root, { home, reposOnly: true })).rejects.toThrow(/\.sync-agent-docs is a symlink or not a folder/);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('replaces a symlinked file inside .sync-agent-docs instead of writing through it', async () => {
    const { root, home } = await materializeFixture('messy-dev');
    const target = join(home, '..', 'victim.txt');
    await writeFile(target, 'keep me\n');
    await mkdir(join(root, '.sync-agent-docs'));
    await symlink(target, join(root, '.sync-agent-docs', 'scan.json'));
    await runScan(root, { home, reposOnly: true });
    expect(await readFile(target, 'utf8')).toBe('keep me\n');
    expect((JSON.parse(await readFile(join(root, '.sync-agent-docs', 'scan.json'), 'utf8')) as ScanResult).root).toBe(root);
  });

  it('terminal output strips control characters from doc values and paths', async () => {
    const { root, home } = await materializeFixture('messy-dev');
    const result = await runScan(root, { home, reposOnly: true });
    const evil = { path: join(root, 'shop', 'x\u0007.md'), line: 1 };
    const out = renderTerminal({
      ...result,
      findings: [{ type: 'stale', message: '', attribute: 'path', values: [{ value: '/etc/\u001b[2Jx\u009b', at: [evil], truthBacked: false }], at: [evil] }],
    }, { color: false });
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(out).toContain('/etc/[2Jx');
    expect(renderTerminal(result, { color: true })).toContain('\u001b[1m');
  });

  it('a missing path or a file says which, for every command, with what to pass instead', async () => {
    const { home, root } = await materializeFixture('messy-dev');
    const missing = join(home, 'nope');
    const file = join(root, 'shop', 'README.md');
    for (const cmd of ['scan', 'plan', 'apply', 'rollback', 'compile', 'doctor']) {
      const gone = await runCli([cmd, missing], home);
      expect(gone.status).toBe(cmd === 'doctor' ? 2 : 1);
      expect(gone.stderr.trim()).toBe(`sync-agent-docs ${cmd}: ${missing} does not exist. Pass the folder that holds your repos.`);
      const notDir = await runCli([cmd, file], home);
      expect(notDir.stderr.trim()).toBe(`sync-agent-docs ${cmd}: ${file} is a file; pass the folder that holds your repos.`);
    }
  });
  it("a compiled block's lines are never claims, duplicates or restatements, but are still checked for secrets", async () => {
    const { root, home } = await materializeFixture('messy-dev');
    const body = '## Facts from the truth store\n\n### shop (project)\n\n| Attribute | Value | Status |\n|---|---|---|\n| port | 3300 | verified |\nshop listens on 3300 behind 100.64.1.10 for the whole ops team';
    const text = `# ops\n\n${writeCompiledBlock(null, body)}`;
    await writeFile(join(root, 'ops', 'CLAUDE.md'), text);
    await writeFile(join(root, 'ops', 'AGENTS.md'), text);
    const result = await scan(root, home);
    const inBlock = (l: { path: string; line: number }) => ['CLAUDE.md', 'AGENTS.md'].some((f) => l.path === join(root, 'ops', f)) && l.line >= 3;
    expect(result.facts.filter((f) => inBlock(f.at))).toEqual([]);
    expect(result.findings.filter((f) => f.type !== 'secret' && (f.at ?? []).some(inBlock))).toEqual([]);
    const secret = 'AKIA' + 'Z7Q3XK4M2PLW8RTV';
    const leaked = `# ops\n\n${writeCompiledBlock(null, body.replace('for the whole ops team', `key ${secret}`))}`;
    await writeFile(join(root, 'ops', 'AGENTS.md'), leaked);
    expect((await scan(root, home)).findings.some((f) => f.type === 'secret' && (f.at ?? []).some(inBlock))).toBe(true);
  });

  it('a block whose hash does not match, or that sits outside the files compile writes, is scanned as plain text', async () => {
    const { root, home } = await materializeFixture('messy-dev');
    const line = 'ops uses port 4100';
    const valid = writeCompiledBlock(null, line);
    await writeFile(join(root, 'ops', 'CLAUDE.md'), `# ops\n\n${valid.replace(line, 'ops uses port 4200')}`);
    await mkdir(join(root, 'ops', 'docs'));
    await writeFile(join(root, 'ops', 'docs', 'AGENTS.md'), valid);
    await writeFile(join(root, 'ops', 'NOTES.md'), valid);
    const facts = (await scan(root, home)).facts;
    const at = (path: string) => facts.some((f) => f.at.path === path && f.attribute === 'port');
    expect(at(join(root, 'ops', 'CLAUDE.md'))).toBe(true);
    expect(at(join(root, 'ops', 'docs', 'AGENTS.md'))).toBe(true);
  });

  it('a broken compiled block is scanned as plain text and does not throw', async () => {
    const { root, home } = await materializeFixture('messy-dev');
    await writeFile(join(root, 'ops', 'CLAUDE.md'), '# ops\n\n<!-- sync-agent-docs:begin compiled -->\nops uses port 4100\n');
    const result = await runScan(root, { home, reposOnly: true, crontabCommand: 'sync-agent-docs-test-no-crontab', now: new Date('2026-10-21T12:00:00Z') });
    expect(result.facts.some((f) => f.at.path === join(root, 'ops', 'CLAUDE.md') && f.at.line === 4)).toBe(true);
  });

  it('ps -p in a doc raises no port conflict', async () => {
    const { root, home } = await materializeFixture('messy-dev');
    await writeFile(join(root, 'ops', 'CLAUDE.md'), '# ops\n\nCheck it with `ps -p 48213`\n');
    const result = await scan(root, home);
    expect(JSON.stringify(result.facts)).not.toContain('48213');
    expect(JSON.stringify(result.findings)).not.toContain('48213');
  });
});
