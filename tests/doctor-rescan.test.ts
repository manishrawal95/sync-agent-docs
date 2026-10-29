import { randomBytes } from 'node:crypto';
import { appendFile, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factChecksCheck } from '../src/doctor/checks/rescan.js';
import type { DoctorContext } from '../src/doctor/types.js';
import { renderDoctor, runDoctor } from '../src/doctor/run.js';
import { readStore } from '../src/store/io.js';
import { applied, check, commit, NOW } from './helpers/doctor.js';

describe('doctor: rescan and fact checks', () => {
  it('after plan --accept-auto, apply and a merge, open items are a note and nothing fails', async () => {
    const { root, doctor, secret } = await applied();
    const r = await doctor();
    expect(r.checks.filter((c) => c.status === 'drift')).toEqual([]);
    const notes = check(r, 'rescan').findings;
    expect(notes).toEqual([expect.objectContaining({ key: 'rescan:open', level: 'note' })]);
    expect(notes[0]?.message).toMatch(/^\d+ plan items are still open/);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(await readFile(join(root, '.sync-agent-docs', 'doctor.json'), 'utf8')).not.toContain(secret);
  });

  it('a new conflicting line is drift keyed by its plan item', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    await appendFile(join(root, 'shop', 'README.md'), '\nshop also listens on port 3999\n');
    commit(join(root, 'shop'), 'new port');
    const c = check(await doctor(), 'rescan');
    expect(c.status).toBe('drift');
    expect(c.findings).toContainEqual(expect.objectContaining({ level: 'drift', key: expect.stringMatching(/^rescan:[0-9a-f]{16}$/), message: expect.stringContaining('3999') }));
  });

  it('a manual patch nobody applied leaves real drift: the global file still disagrees', async () => {
    const { doctor } = await applied({ answerAll: true, patched: false });
    const c = check(await doctor(), 'rescan');
    expect(c.status).toBe('drift');
    const [f] = c.findings;
    expect(f).toMatchObject({ level: 'drift', key: expect.stringMatching(/^rescan:[0-9a-f]{16}$/) });
    expect(f?.message).toBe('shop port: the store says 3300, but ~/.claude/CLAUDE.md:3 still says 4000. sync-agent-docs could not change that file, so apply the patch it wrote by hand: .sync-agent-docs/manual/20261022-120000-1-CLAUDE.md.patch');
  });

  it('a file edited after apply gets no patch hint, since no patch covers the new line', async () => {
    const { home, doctor } = await applied({ answerAll: true });
    await appendFile(join(home, '.claude', 'CLAUDE.md'), 'shop runs on port 4100\n');
    const c = check(await doctor(), 'rescan');
    expect(c.findings).toContainEqual(expect.objectContaining({ level: 'drift', message: 'shop port: the store says 3300, but ~/.claude/CLAUDE.md:3 still says 4100. Run sync-agent-docs plan to settle it.' }));
  });

  it('an untracked file inside a repo gets the patch hint too', async () => {
    const { root, doctor } = await applied({ answerAll: true, before: async (fx) => {
      // Scan reads an untracked file git does not ignore, and apply can only patch it.
      await writeFile(join(fx.root, 'blog', 'LOCAL.md'), '# Local notes\n\nshop runs on port 4000\n');
    } });
    const patches = await readdir(join(root, '.sync-agent-docs', 'manual'));
    const local = patches.find((n) => n.endsWith('-LOCAL.md.patch'));
    expect(local).toBeDefined();
    const c = check(await doctor(), 'rescan');
    expect(c.findings).toContainEqual(expect.objectContaining({ level: 'drift', message: `shop port: the store says 3300, but blog/LOCAL.md:3 still says 4000. sync-agent-docs could not change that file, so apply the patch it wrote by hand: .sync-agent-docs/manual/${local}` }));
  });

  it('a repo line that still disagrees with a settled value names the line and sends you to plan', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    await appendFile(join(root, 'shop', 'README.md'), '\nshop listens on port 3000\n');
    commit(join(root, 'shop'), 'old port again');
    const c = check(await doctor(), 'rescan');
    expect(c.findings).toContainEqual(expect.objectContaining({ level: 'drift', message: expect.stringMatching(/^shop port: the store says 3300, but shop\/README\.md:\d+ still says 3000\. Run sync-agent-docs plan to settle it\.$/) }));
  });

  it('a value the store holds alongside another is still reported open, as plan asks about it', async () => {
    const { home, store, doctor } = await applied({ answerAll: true, patched: false });
    const global = join(home, '.claude', 'CLAUDE.md');
    await writeFile(global, (await readFile(global, 'utf8')).replace('port 4000', 'port 3300'));
    const path = join(store, 'store', 'facts.json');
    const file = JSON.parse(await readFile(path, 'utf8')) as { facts: unknown[] };
    file.facts.push({ entityId: 'project:shop', attribute: 'port', value: '3301', sources: [], status: 'verified' });
    await writeFile(path, JSON.stringify(file, null, 2));
    commit(store, 'second port');
    const c = check(await doctor(), 'rescan');
    expect(c.findings).toContainEqual(expect.objectContaining({ message: expect.stringContaining('shop port: 3300.') }));
  });

  it('a config that no longer says what the store recorded fails fact-checks', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    const path = join(root, 'shop', 'ecosystem.config.cjs');
    await writeFile(path, (await readFile(path, 'utf8')).replace('-p 3300', '-p 3400'));
    commit(join(root, 'shop'), 'move port');
    const c = check(await doctor(), 'fact-checks');
    expect(c.status).toBe('drift');
    expect(c.findings).toEqual([expect.objectContaining({ key: 'fact-checks:project:shop|port|shop/ecosystem.config.cjs|3300', path: 'shop/ecosystem.config.cjs' })]);
    expect(c.findings[0]?.message).toContain('3300');
  });

  it('with --repos-only, machine-file facts are one note, not drift', async () => {
    const { doctor } = await applied({ answerAll: true });
    const full = check(await doctor(), 'fact-checks');
    expect(full.findings.filter((f) => f.key === 'fact-checks:repos-only')).toEqual([]);
    const c = check(await doctor({ reposOnly: true }), 'fact-checks');
    expect(c.status).toBe('clean');
    expect(c.findings).toEqual([expect.objectContaining({ key: 'fact-checks:repos-only', level: 'note', message: expect.stringMatching(/^[1-9]\d* facts from machine files were not rechecked \(--repos-only\)\.$/) })]);
  });

  it.each([
    ['a LaunchAgents plist', ['Library', 'LaunchAgents', 'com.example.shop.plist']],
    ['a systemd unit', ['.config', 'systemd', 'user', 'shop.service']],
    ['a cursor rule', ['.cursor', 'rules', 'shop.mdc']],
    ['a memory file', ['.claude', 'projects', '-Users-example-shop', 'memory', 'note.md']],
  ])('with --repos-only, a fact checked against %s that has since been deleted is still a machine fact', async (_name, parts) => {
    const { home, store } = await applied({ answerAll: true });
    const loaded = await readStore(store);
    if (!loaded) throw new Error('the applied fixture has no store');
    const gone = join(home, ...parts);
    loaded.facts.push({ entityId: 'project:shop', attribute: 'port', value: '3300', sources: [], status: 'verified', check: { kind: 'config', path: gone, attribute: 'port', value: '3300' } });
    const ctx = { root: home, home, reposOnly: true, store: loaded, scan: () => Promise.resolve({ facts: [] }) } as unknown as DoctorContext;
    const found = await factChecksCheck.run(ctx);
    expect(found.filter((f) => f.path?.includes(parts.at(-1) ?? ''))).toEqual([]);
    expect(found.filter((f) => f.key === 'fact-checks:repos-only')).toHaveLength(1);
  });

  it('with --repos-only and the scan root set to the home folder, machine files are still the ones not rechecked', async () => {
    const { home, store } = await applied({ answerAll: true });
    const loaded = await readStore(store);
    if (!loaded) throw new Error('the applied fixture has no store');
    const ctx = { root: home, home, reposOnly: true, store: loaded, scan: () => Promise.resolve({ facts: [] }) } as unknown as DoctorContext;
    const found = await factChecksCheck.run(ctx);
    expect(found.filter((f) => f.key === 'fact-checks:repos-only')).toEqual([expect.objectContaining({ level: 'note' })]);
    expect(found.filter((f) => f.path?.startsWith('.claude') || f.path?.startsWith('~'))).toEqual([]);
  });

  it.each([
    ['a root given with a trailing slash', async (root: string) => `${root}/`],
    ['a root reached through a symlink', async (root: string) => {
      const link = `${root}-link`;
      await symlink(root, link);
      return link;
    }],
  ])('with --repos-only, %s still counts repo facts as repo facts', async (_name, spell) => {
    const { root, home, doctor } = await applied({ answerAll: true });
    const expected = check(await doctor({ reposOnly: true }), 'fact-checks').findings;
    const other = await runDoctor(await spell(root), { home, crontabCommand: 'false', now: NOW, reposOnly: true });
    // Only the note: a scan through a symlink spells its paths differently, which is not what this checks.
    expect(check(other, 'fact-checks').findings.filter((f) => f.level === 'note')).toEqual(expected);
  });

  it('commands approved from package.json pass fact-checks until a script is removed', async () => {
    const { root, doctor } = await applied({ before: async (fx) => {
      await writeFile(join(fx.root, 'shop', 'package.json'), JSON.stringify({ scripts: { dev: 'next dev', test: 'vitest' } }));
      commit(join(fx.root, 'shop'), 'scripts');
    } });
    expect(check(await doctor(), 'fact-checks').findings).toEqual([]);
    await writeFile(join(root, 'shop', 'package.json'), JSON.stringify({ scripts: { dev: 'next dev' } }));
    commit(join(root, 'shop'), 'drop test');
    const c = check(await doctor(), 'fact-checks');
    expect(c.findings).toEqual([expect.objectContaining({ key: 'fact-checks:project:shop|command|shop/package.json|npm run test' })]);
  });

  it('a credential in a new line never reaches the report', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    const pass = 'pw9' + randomBytes(12).toString('hex');
    await appendFile(join(root, 'shop', 'README.md'), `\nshop database: postgres://app:${pass}@db.example.invalid:5432/app\n`);
    commit(join(root, 'shop'), 'db url');
    const r = await doctor();
    expect(renderDoctor(r)).not.toContain(pass);
    expect(JSON.stringify(r)).not.toContain(pass);
    expect(await readFile(join(root, '.sync-agent-docs', 'doctor.json'), 'utf8')).not.toContain(pass);
  });
});
