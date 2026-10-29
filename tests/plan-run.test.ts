import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Asker } from '../src/plan/prompt.js';
import { runRollback } from '../src/apply/rollback.js';
import { runApply } from '../src/apply/run.js';
import { runPlan } from '../src/plan/run.js';
import type { Plan } from '../src/plan/types.js';
import { readStore } from '../src/store/io.js';
import { materializeFixture } from './helpers/fixture.js';

const temp = async () => realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-run-')));

async function setup() {
  const fx = await materializeFixture('messy-dev', { commit: true });
  const store = join(fx.home, 'truth');
  const opts = { home: fx.home, reposOnly: false, crontabCommand: 'false', store, now: new Date('2026-10-22T12:00:00.000Z') };
  return { ...fx, store, opts };
}

/** Accepts every recommendation and picks option 1 where there is none; records everything shown. */
function scripted(): Asker & { transcript: string[] } {
  const transcript: string[] = [];
  return {
    transcript,
    print: (t) => void transcript.push(t),
    ask: (q) => {
      transcript.push(q);
      return Promise.resolve(/Enter to skip/.test(q) ? '1' : '');
    },
  };
}

const refusing: Asker = { print: () => undefined, ask: (q) => Promise.reject(new Error(`asked again: ${q}`)) };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('runPlan', () => {
  it('plan writes plan.json with open questions unanswered when not interactive', async () => {
    const { root, opts } = await setup();
    const plan = await runPlan(root, opts);
    const disk = JSON.parse(await readFile(join(root, '.sync-agent-docs', 'plan.json'), 'utf8')) as Plan;
    expect(disk.items.length).toBe(plan.items.length);
    expect(disk.items.length).toBeGreaterThan(0);
    expect(disk.items.every((i) => i.answer === null)).toBe(true);
  });

  it('scripted answers are remembered and not asked again', async () => {
    const { root, opts } = await setup();
    const first = await runPlan(root, { ...opts, asker: scripted() });
    expect(first.items.find((i) => i.tier === 'conflict')?.answer).toBe('3300');
    const second = await runPlan(root, { ...opts, asker: refusing });
    const open = second.items.filter((i) => i.answer === null && !i.follows);
    expect(open).toEqual([]);
    expect(second.items.find((i) => i.tier === 'conflict')?.answeredBy).toBe('remembered');
  });

  it('a prompt or flag answer edited by hand in plan.json survives the next plan', async () => {
    const { root, opts } = await setup();
    const planPath = join(root, '.sync-agent-docs', 'plan.json');
    const first = await runPlan(root, { ...opts, asker: scripted(), acceptAuto: true });
    const edited = JSON.parse(await readFile(planPath, 'utf8')) as Plan;
    const swapped = new Map<string, string>();
    for (const by of ['prompt', 'flag'] as const) {
      const item = edited.items.find((i) => i.answeredBy === by && i.options.length > 1 && i.options.some((o) => o !== i.answer));
      expect(item, `an item answered by ${by} with a second option`).toBeDefined();
      if (!item) continue;
      const other = item.options.find((o) => o !== item.answer);
      if (!other) continue;
      swapped.set(item.key, other);
      item.answer = other;
    }
    await writeFile(planPath, JSON.stringify(edited));
    const second = await runPlan(root, { ...opts, asker: refusing });
    expect(first.items.length).toBeGreaterThan(0);
    for (const [key, answer] of swapped) {
      const item = second.items.find((i) => i.key === key);
      expect(item?.answer).toBe(answer);
      expect(item?.answeredBy).toBe('hand');
    }
  });

  it('--accept-auto answers only the auto tier', async () => {
    const { root, opts } = await setup();
    const plan = await runPlan(root, { ...opts, acceptAuto: true });
    for (const i of plan.items) {
      if (i.tier === 'auto') expect([i.answer, i.answeredBy]).toEqual(['approve', 'flag']);
      else expect(i.answer).toBeNull();
    }
  });

  it('secret question never prints the value', async () => {
    const { root, secret, opts } = await setup();
    const asker = scripted();
    await runPlan(root, { ...opts, asker });
    const text = asker.transcript.join('\n');
    expect(text).toContain('shop/AGENTS.md:3');
    expect(text).not.toContain(secret);
    expect(await readFile(join(root, '.sync-agent-docs', 'plan.json'), 'utf8')).not.toContain(secret);
    expect(await readFile(join(root, '.sync-agent-docs', 'decisions.json'), 'utf8')).not.toContain(secret);
  });

  it('--use-scan without a scan says to run sync-agent-docs scan first', async () => {
    const { root, opts } = await setup();
    await expect(runPlan(root, { ...opts, useScan: true })).rejects.toThrow(/run sync-agent-docs scan first/i);
  });
});

describe('cli plan', () => {
  it('plan --json prints the plan and never the secret', async () => {
    const { root, home, secret, store } = await setup();
    const bin = await temp();
    await writeFile(join(bin, 'crontab'), '#!/bin/sh\necho "no crontab" >&2\nexit 1\n');
    await chmod(join(bin, 'crontab'), 0o755);
    const r = spawnSync('node', ['--import', 'tsx', 'src/cli.ts', 'plan', root, '--json', '--store', store], {
      encoding: 'utf8', env: { ...process.env, HOME: home, NO_COLOR: '1', PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const plan = JSON.parse(r.stdout) as Plan;
    expect(plan.items.some((i) => i.tier === 'secret')).toBe(true);
    expect(r.stdout).not.toContain(secret);
  });

  it('a .sync-agent-docs folder tracked by git refuses plan, apply and rollback and names the files', async () => {
    const { root, opts } = await setup();
    await mkdir(join(root, '.sync-agent-docs'), { recursive: true });
    await writeFile(join(root, '.sync-agent-docs', 'decisions.json'), '{"schema":1,"decisions":[]}');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-f', '.sync-agent-docs/decisions.json']]) spawnSync('git', args, { cwd: root });
    const tracked = /\.sync-agent-docs\/decisions\.json[\s\S]*git rm -r --cached \.sync-agent-docs/;
    await expect(runPlan(root, opts)).rejects.toThrow(tracked);
    await expect(runApply(root, { home: opts.home })).rejects.toThrow(tracked);
    await expect(runRollback(root)).rejects.toThrow(tracked);
  });

  it('a value the store holds alongside another is still asked, since approving it would drop the other', async () => {
    const { root, home, store, opts } = await setup();
    await runPlan(root, { ...opts, acceptAuto: true, asker: scripted() });
    await runApply(root, { home: opts.home, now: opts.now });
    git(join(root, 'shop'), 'switch', '-q', 'main');
    await writeFile(join(root, 'shop', 'README.md'), '# shop\n\nshop runs on port 3300\n');
    git(join(root, 'shop'), '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'docs: port 3300');
    await writeFile(join(home, '.claude', 'CLAUDE.md'), (await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).replace('port 4000', 'port 3300'));
    const path = join(store, 'store', 'facts.json');
    const file = JSON.parse(await readFile(path, 'utf8')) as { facts: unknown[] };
    file.facts.push({ entityId: 'project:shop', attribute: 'port', value: '3301', sources: [], status: 'verified' });
    await writeFile(path, JSON.stringify(file, null, 2));
    const again = await runPlan(root, { ...opts, now: new Date('2026-10-22T12:05:00.000Z') });
    expect(again.items.find((i) => i.entityId === 'project:shop' && i.attribute === 'port')).toMatchObject({ candidates: ['3300'], answer: null });
  });

  it('a store the last apply wrote that has gone missing is refused, not started again', async () => {
    const { root, store, opts } = await setup();
    await runPlan(root, { ...opts, acceptAuto: true });
    await runApply(root, { home: opts.home, now: opts.now });
    await rename(store, `${store}-moved`);
    const later = { ...opts, store: undefined, now: new Date('2026-10-22T12:05:00.000Z') };
    await expect(runPlan(root, later)).rejects.toThrow(/the last apply wrote the store at .*truth, but it is gone.*--store/);
    expect((await runPlan(root, { ...later, store: `${store}-moved` })).store).toBe(`${store}-moved`);
  });

  it('plan --store outside home is refused', async () => {
    const { root, opts } = await setup();
    await expect(runPlan(root, { ...opts, store: join(await temp(), 'truth') })).rejects.toThrow(/--store names a store outside your home folder/);
  });

  it('a store path from applies.json must be absolute and inside home, or the plan says to pass --store', async () => {
    const { root, home, opts } = await setup();
    const noStore = { ...opts, store: undefined };
    await mkdir(join(root, '.sync-agent-docs'), { recursive: true });
    const applies = (store: string) => writeFile(join(root, '.sync-agent-docs', 'applies.json'), JSON.stringify({ schema: 1, applies: [{ id: 'x', at: '', store, repos: [], manual: [], skipped: [] }] }));
    for (const bad of [join(await temp(), 'elsewhere'), 'relative/truth', join(home, '..', 'outside')]) {
      await applies(bad);
      await expect(runPlan(root, noStore)).rejects.toThrow(/pass --store/i);
    }
    const elsewhere = await temp();
    await symlink(elsewhere, join(home, 'link-to-elsewhere'));
    await applies(join(home, 'link-to-elsewhere', 'new-store'));
    await expect(runPlan(root, noStore)).rejects.toThrow(/pass --store/i);
    await mkdir(join(home, 'notes'));
    await symlink(join(home, 'notes'), join(home, 'notes-link'));
    await applies(join(home, 'notes-link', 'truth'));
    expect((await runPlan(root, noStore)).store).toBe(join(await realpath(home), 'notes', 'truth'));
  });

  it('--use-scan refuses a scan older than a file it would edit, instead of editing the wrong line', async () => {
    const { root, opts } = await setup();
    const first = await runPlan(root, opts);
    const edit = first.items.flatMap((i) => Object.values(i.edits).flat()).find((e) => e.op !== 'append');
    if (!edit) throw new Error('fixture has no line edit');
    await writeFile(edit.path, `a new first line\n${await readFile(edit.path, 'utf8')}`);
    await expect(runPlan(root, { ...opts, useScan: true })).rejects.toThrow(/changed since the scan.*sync-agent-docs scan/);
  });

  it('a global agent file that agrees with one side of a repo conflict is part of that conflict', async () => {
    const { root, home, opts } = await setup();
    // README now says 4000, as ~/.claude/CLAUDE.md does; the config says 3300.
    await writeFile(join(root, 'shop', 'README.md'), '# shop\n\nshop runs on port 4000\n');
    const plan = await runPlan(root, opts);
    const global = join(home, '.claude', 'CLAUDE.md');
    const conflict = plan.items.find((i) => i.tier === 'conflict' && i.entityId === 'project:shop' && i.attribute === 'port');
    expect(conflict?.evidence.map((e) => e.path)).toContain(global);
    const touched = plan.items.flatMap((i) => (i === conflict || i.key.includes(global) ? Object.values(i.edits).flat() : [])).map((e) => e.path);
    expect(touched).toContain(global);
  });

  it('a value the store settled is not asked again when its question changes shape', async () => {
    const { root, home, opts } = await setup();
    await runPlan(root, { ...opts, acceptAuto: true, asker: scripted() });
    await runApply(root, { home: opts.home, now: opts.now });
    // Every file now agrees with the settled 3300, so the conflict comes back as a plain fact with a new key.
    git(join(root, 'shop'), 'switch', '-q', 'main');
    await writeFile(join(root, 'shop', 'README.md'), '# shop\n\nshop runs on port 3300\n');
    git(join(root, 'shop'), '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'docs: port 3300');
    await writeFile(join(home, '.claude', 'CLAUDE.md'), (await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).replace('port 4000', 'port 3300'));
    const again = await runPlan(root, { ...opts, now: new Date('2026-10-22T12:05:00.000Z') });
    const port = again.items.find((i) => i.entityId === 'project:shop' && i.attribute === 'port');
    expect(port).toMatchObject({ kind: 'fact', candidates: ['3300'], answer: 'approve', answeredBy: 'remembered' });
    const store = join(home, 'truth');
    await runApply(root, { home: opts.home, now: new Date('2026-10-22T12:06:00.000Z') });
    const facts = (await readStore(store))?.facts ?? [];
    expect(facts.filter((f) => f.entityId === 'project:shop' && f.attribute === 'port').map((f) => f.value)).toEqual(['3300']);
  });

  it('--use-scan refuses a scan.json made for another root', async () => {
    const { root, opts } = await setup();
    await runPlan(root, opts);
    const path = join(root, '.sync-agent-docs', 'scan.json');
    const scan = JSON.parse(await readFile(path, 'utf8')) as { root: string };
    await writeFile(path, JSON.stringify({ ...scan, root: await temp() }));
    await expect(runPlan(root, { ...opts, useScan: true })).rejects.toThrow(/scan\.json was made for/);
  });

  it('a remembered secret answer applies only when its recorded candidates are the current ones', async () => {
    const { root, opts } = await setup();
    const first = await runPlan(root, opts);
    const secret = first.items.find((i) => i.tier === 'secret');
    expect(secret).toBeDefined();
    if (!secret) return;
    const forged = { key: secret.key, kind: 'secret', subject: secret.subject, candidates: ['some-other-line'], answer: 'false-positive', decidedAt: '2026-10-22T11:00:00.000Z' };
    await writeFile(join(root, '.sync-agent-docs', 'decisions.json'), JSON.stringify({ schema: 1, decisions: [forged] }));
    const second = await runPlan(root, opts);
    expect(second.items.find((i) => i.key === secret.key)?.answer).toBeNull();
  });

  it('a .SYNC-AGENT-DOCS folder tracked by git is refused too, as is a .sync-agent-docs symlink', async () => {
    const { root, opts } = await setup();
    await mkdir(join(root, '.SYNC-AGENT-DOCS'));
    await writeFile(join(root, '.SYNC-AGENT-DOCS', 'decisions.json'), '{"schema":1,"decisions":[]}');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-f', '.SYNC-AGENT-DOCS/decisions.json']]) spawnSync('git', args, { cwd: root });
    await expect(runPlan(root, opts)).rejects.toThrow(/\.SYNC-AGENT-DOCS\/decisions\.json[\s\S]*git rm -r --cached/);

    const other = await setup();
    const elsewhere = await temp();
    await symlink(elsewhere, join(other.root, '.sync-agent-docs'));
    await expect(runPlan(other.root, other.opts)).rejects.toThrow(/\.sync-agent-docs is a symlink/);
    expect((await lstat(join(other.root, '.sync-agent-docs'))).isSymbolicLink()).toBe(true);
  });
});
