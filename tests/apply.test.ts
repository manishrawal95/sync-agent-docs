import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRollback } from '../src/apply/rollback.js';
import { renderApplySummary, runApply } from '../src/apply/run.js';
import { runPlan } from '../src/plan/run.js';
import { lineHash } from '../src/plan/lines.js';
import type { Plan, PlanItem } from '../src/plan/types.js';
import { materializeFixture } from './helpers/fixture.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const BRANCH = 'sync-agent-docs/apply-20261022-120000';
const temp = async () => realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-apply-')));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Plans the fixture without prompts, then answers items by hand the way a person editing plan.json would. */
async function planned(
  answers: (i: PlanItem) => string | null = recommended,
  { prepare, storeAt }: { prepare?: (store: string, root: string) => Promise<void>; storeAt?: (root: string) => string } = {},
) {
  const fx = await materializeFixture('messy-dev', { commit: true });
  const store = storeAt?.(fx.root) ?? join(fx.home, 'truth');
  await prepare?.(store, fx.root);
  const opts = { home: fx.home, reposOnly: false, crontabCommand: 'false', store, now: NOW };
  const plan = await runPlan(fx.root, opts);
  const path = join(fx.root, '.sync-agent-docs', 'plan.json');
  for (const i of plan.items) i.answer = answers(i);
  await writeFile(path, JSON.stringify(plan));
  const apply = () => runApply(fx.root, { home: fx.home, now: NOW });
  return { ...fx, store, plan, planPath: path, apply };
}

function recommended(i: PlanItem): string | null {
  if (i.tier === 'secret') return 'rotate-remove';
  return i.follows ? 'accept' : (i.recommended ?? null);
}

/** A store folder that already is a git repo with one hand-written commit. */
async function handRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(join(dir, 'hosts.md'), '# Hosts\n\nThe box lives in Helsinki.\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'hand');
}

const tips = (root: string) => Object.fromEntries(['ops', 'shop', 'blog'].map((r) => [r, git(join(root, r), 'rev-parse', 'main')]));

describe('apply', () => {
  it('apply refuses a dirty repo and names it', async () => {
    const { root, apply } = await planned();
    await appendFile(join(root, 'ops', 'hosts.md'), 'wip\n');
    await expect(apply()).rejects.toThrow(/ops.*uncommitted changes/);
    expect(git(join(root, 'shop'), 'branch', '--list', 'sync-agent-docs/*')).toBe('');
  });

  it('a branch named sync-agent-docs is refused before anything is written', async () => {
    const { root, store, apply } = await planned();
    git(join(root, 'shop'), 'branch', 'sync-agent-docs');
    const before = tips(root);
    await expect(apply()).rejects.toThrow(/apply: .*shop has a branch named sync-agent-docs.*nothing was written.*git -C '.*shop' branch -m sync-agent-docs/);
    expect(tips(root)).toEqual(before);
    for (const r of ['ops', 'shop', 'blog']) expect(git(join(root, r), 'branch', '--list', 'sync-agent-docs/*')).toBe('');
    await expect(stat(store)).rejects.toThrow(/ENOENT/);
  });

  it('a branch named sync-agent-docs-old is not refused', async () => {
    const { root, apply } = await planned();
    git(join(root, 'shop'), 'branch', 'sync-agent-docs-old');
    await expect(apply()).resolves.toBeDefined();
  });

  it('apply writes the store, views and edits on new branches and leaves main untouched', async () => {
    const { root, store, apply } = await planned();
    const before = tips(root);
    const entry = await apply();
    expect(tips(root)).toEqual(before);
    const shop = join(root, 'shop');
    expect(git(shop, 'show', `${BRANCH}:README.md`)).toContain('shop runs on port 3300');
    expect(git(shop, 'show', `${BRANCH}:CLAUDE.md`)).not.toContain('hetzner box: 100.64.1.10');
    expect(git(shop, 'show', `${BRANCH}:CLAUDE.md`)).toContain('@');
    expect(git(shop, 'show', `${BRANCH}:CLAUDE.md`)).not.toContain('10.0.0.4');
    expect(entry.repos.map((r) => r.path).sort()).toEqual([join(root, 'ops'), shop, join(root, 'blog'), store].sort());
    expect(entry.repos.every((r) => r.branch === BRANCH && r.original === 'main')).toBe(true);
    const facts = JSON.parse(git(store, 'show', `${BRANCH}:store/facts.json`)) as { facts: { entityId: string; attribute: string; value: string; status: string }[] };
    expect(facts.facts).toContainEqual(expect.objectContaining({ entityId: 'project:shop', attribute: 'port', value: '3300', status: 'verified' }));
    const hosts = git(store, 'show', `${BRANCH}:hosts.md`);
    expect(hosts).toContain('Generated by sync-agent-docs');
    expect(hosts).toContain('| ip | `100.64.1.10` | verified |');
    expect(git(store, 'show', `${BRANCH}:projects/shop.md`)).toContain('## Commands');
    const applies = JSON.parse(await readFile(join(root, '.sync-agent-docs', 'applies.json'), 'utf8')) as { applies: unknown[] };
    expect(applies.applies).toHaveLength(1);
  });

  it('machine file outside git becomes a manual patch', async () => {
    const { root, home, apply } = await planned();
    const entry = await apply();
    expect(entry.manual).toHaveLength(1);
    const patch = await readFile(entry.manual[0] ?? '', 'utf8');
    expect(entry.manual[0]?.startsWith(join(root, '.sync-agent-docs', 'manual'))).toBe(true);
    expect(patch).toContain(join(home, '.claude', 'CLAUDE.md'));
    expect(patch).toContain('-shop runs on port 4000');
    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toContain('shop runs on port 4000');
  });

  it('a .sync-agent-docs/manual that is a link is refused, and no patch lands where it points', async () => {
    const { root, apply } = await planned();
    const elsewhere = await mkdtemp(join(tmpdir(), 'tf-elsewhere-'));
    await symlink(elsewhere, join(root, '.sync-agent-docs', 'manual'));
    await expect(apply()).rejects.toThrow(/manual is a symlink or not a folder/);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('a changed line refuses before any branch exists', async () => {
    const { root, apply } = await planned();
    await writeFile(join(root, 'shop', 'README.md'), '# shop\n\nshop runs on port 3001\n');
    git(join(root, 'shop'), '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'edit');
    await expect(apply()).rejects.toThrow(/shop\/README\.md.*line 3.*run sync-agent-docs plan again/);
    for (const r of ['ops', 'shop', 'blog']) expect(git(join(root, r), 'branch', '--list', 'sync-agent-docs/*')).toBe('');
  });

  it('an answer outside the options is refused', async () => {
    const { planPath, apply } = await planned();
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as Plan;
    const conflict = plan.items.find((i) => i.tier === 'conflict');
    if (conflict) conflict.answer = '9999';
    await writeFile(planPath, JSON.stringify(plan));
    await expect(apply()).rejects.toThrow(/9999.*not one of/);
  });

  it('secret removal leaves no secret in the commit, patch or store', async () => {
    const { root, store, secret, apply } = await planned();
    const entry = await apply();
    const shop = join(root, 'shop');
    expect(git(shop, 'show', `${BRANCH}:AGENTS.md`)).not.toContain(secret);
    expect(git(shop, 'log', '-1', '--format=%B', BRANCH)).not.toContain(secret);
    expect(git(shop, 'log', '-1', '--format=%B', BRANCH)).toContain('chore(sync-agent-docs): apply plan 20261022-120000');
    for (const p of entry.manual) expect(await readFile(p, 'utf8')).not.toContain(secret);
    for (const f of ['sync-agent-docs.json', 'store/facts.json', 'store/decisions.json', 'store/entities.json']) expect(git(store, 'show', `${BRANCH}:${f}`)).not.toContain(secret);
    const secrets = JSON.parse(git(store, 'show', `${BRANCH}:store/facts.json`)) as { secrets: unknown[] };
    expect(secrets.secrets).toEqual([{ path: 'shop/AGENTS.md', line: 3, status: 'removed' }]);
  });

  it('a secret in a file outside git is not reported removed', async () => {
    const token = 'ghp_' + 'Ab9'.repeat(12);
    const { store, apply } = await planned(recommended, {
      prepare: async (_store, root) => { await appendFile(join(root, '..', '.claude', 'CLAUDE.md'), `GITHUB_TOKEN=${token}\n`); },
    });
    const entry = await apply();
    const facts = JSON.parse(git(store, 'show', `${BRANCH}:store/facts.json`)) as { secrets: { path: string; status: string }[] };
    expect(facts.secrets.find((s) => s.path === '~/.claude/CLAUDE.md')?.status).toBe('manual');
    const summary = renderApplySummary(entry);
    expect(summary).toContain('Not removed: ~/.claude/CLAUDE.md:');
    expect(summary).not.toContain('ghp_');
  });

  it('adopting an existing repo keeps its hand-written hosts.md prose', async () => {
    const { store, apply } = await planned(recommended, { prepare: handRepo });
    await apply();
    const hosts = git(store, 'show', `${BRANCH}:hosts.md`);
    expect(hosts).toContain('The box lives in Helsinki.');
    expect(hosts).toContain('sync-agent-docs:begin host:hetzner');
    expect(git(store, 'rev-parse', 'main')).toBe(git(store, 'rev-parse', `${BRANCH}~1`));
  });

  it('a detached HEAD is refused', async () => {
    const { root, apply } = await planned();
    git(join(root, 'ops'), 'checkout', '-q', '--detach');
    await expect(apply()).rejects.toThrow(/ops.*detached HEAD/);
  });

  it('an existing apply branch is refused', async () => {
    const { root, apply } = await planned();
    git(join(root, 'shop'), 'branch', BRANCH);
    await expect(apply()).rejects.toThrow(new RegExp(`shop.*${BRANCH}.*already exists`));
    expect(git(join(root, 'ops'), 'branch', '--list', 'sync-agent-docs/*')).toBe('');
  });

  it('a hand edit to a view block is kept while open and folded into the store when answered', async () => {
    const { root, home, store, apply } = await planned();
    await apply();
    const card = join(store, 'projects', 'shop.md');
    await writeFile(card, (await readFile(card, 'utf8')).replace('No commands recorded yet.', '- `npm run dev`'));
    git(store, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'hand edit');
    const again = async (minute: number, answer: string | null) => {
      const now = new Date(`2026-10-22T12:0${minute}:00.000Z`);
      const plan = await runPlan(root, { home, reposOnly: false, crontabCommand: 'false', store, now });
      const edit = plan.items.find((i) => i.kind === 'view-edit');
      expect(edit?.subject).toBe('projects/shop.md#project:shop:commands');
      if (edit) edit.answer = answer;
      await writeFile(join(root, '.sync-agent-docs', 'plan.json'), JSON.stringify(plan));
      return runApply(root, { home, now });
    };
    await again(1, null);
    expect(await readFile(card, 'utf8')).toContain('- `npm run dev`');
    await again(2, 'fold');
    const facts = JSON.parse(await readFile(join(store, 'store', 'facts.json'), 'utf8')) as { facts: { attribute: string; value: string; status: string }[] };
    expect(facts.facts).toContainEqual(expect.objectContaining({ attribute: 'command', value: 'npm run dev', status: 'inferred' }));
  });

  it('apply without a plan says to run sync-agent-docs plan', async () => {
    const fx = await materializeFixture('messy-dev', { commit: true });
    await expect(runApply(fx.root, { home: fx.home, now: NOW })).rejects.toThrow(/run sync-agent-docs plan first/i);
    // The run lock opens the folder; the refusal leaves it holding only the .gitignore, no plan, applies or lock.
    expect(await readdir(join(fx.root, '.sync-agent-docs'))).toEqual(['.gitignore']);
  });

  it('a plan.json store outside home is refused, with no way around it in apply', async () => {
    const { root, home, planPath } = await planned();
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as { store: string };
    for (const store of [join(await temp(), 'truth'), 'relative/truth']) {
      await writeFile(planPath, JSON.stringify({ ...plan, store }));
      await expect(runApply(root, { home, now: NOW })).rejects.toThrow(/outside your home folder[\s\S]*sync-agent-docs plan --store/);
    }
    for (const r of ['ops', 'shop', 'blog']) expect(git(join(root, r), 'branch', '--list', 'sync-agent-docs/*')).toBe('');
  });

  it('a store that is also an edited repo gets one branch and one commit with both', async () => {
    const { root, apply } = await planned(recommended, { storeAt: (r) => join(r, 'ops') });
    const ops = join(root, 'ops');
    const main = git(ops, 'rev-parse', 'main');
    const entry = await apply();
    expect(entry.repos.filter((r) => r.path === ops)).toHaveLength(1);
    expect(git(ops, 'rev-parse', `${BRANCH}~1`)).toBe(main);
    const files = git(ops, 'show', '--name-only', '--format=', BRANCH).split('\n');
    expect(files).toEqual(expect.arrayContaining(['sync-agent-docs.json', 'store/facts.json', 'hosts.md']));
    expect(files.some((f) => !f.startsWith('store/') && !['sync-agent-docs.json', 'hosts.md', 'services.md'].includes(f) && !f.startsWith('projects/'))).toBe(true);
    expect(git(ops, 'status', '--porcelain')).toBe('');
  });

  it('an untracked file in a repo gets a patch instead of an edit', async () => {
    const { root, apply } = await planned(recommended, {
      prepare: async (_store, r) => {
        await writeFile(join(r, 'shop', 'notes.md'), '# notes\n\nshop runs on port 4000\n');
      },
    });
    const shop = join(root, 'shop');
    const entry = await apply();
    expect(await readFile(join(shop, 'notes.md'), 'utf8')).toContain('port 4000');
    expect(git(shop, 'show', '--name-only', '--format=', BRANCH)).not.toContain('notes.md');
    const patches = await Promise.all(entry.manual.map((m) => readFile(m, 'utf8')));
    const notes = patches.find((p) => p.includes(join(shop, 'notes.md')));
    expect(notes).toContain('git does not track it');
    expect(notes).toContain('-shop runs on port 4000');
    expect(git(shop, 'status', '--porcelain')).toBe('?? notes.md');
  });

  it('a failure partway through undoes every repo touched so far', async () => {
    const { root, store, apply } = await planned(recommended, {
      prepare: async (dir) => {
        await handRepo(dir);
        await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
      },
    });
    const before = tips(root);
    const storeMain = git(store, 'rev-parse', 'main');
    await expect(apply()).rejects.toThrow(/hook says no[\s\S]*changes were undone/);
    expect(tips(root)).toEqual(before);
    for (const repo of [join(root, 'ops'), join(root, 'shop'), join(root, 'blog'), store]) {
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
      expect(git(repo, 'branch', '--list', 'sync-agent-docs/*')).toBe('');
    }
    expect(git(store, 'rev-parse', 'main')).toBe(storeMain);
    const applies = JSON.parse(await readFile(join(root, '.sync-agent-docs', 'applies.json'), 'utf8')) as { applies: { rolledBack?: string }[] };
    expect(applies.applies.every((a) => a.rolledBack)).toBe(true);
  });

  it('a store whose config steers a view outside it is refused before anything is written', async () => {
    const { root, home, apply } = await planned(recommended, {
      prepare: async (dir) => {
        await handRepo(dir);
        await mkdir(join(dir, 'store'), { recursive: true });
        await writeFile(join(dir, 'sync-agent-docs.json'), JSON.stringify({ schema: 1, root: '~/dev', repos: [], agentFormats: [], views: { hosts: 'hosts.md', services: 'services.md', projects: 'projects' }, generated: {} }));
        git(dir, 'add', '-A');
        git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'config');
      },
    });
    const store = join(home, 'truth');
    await writeFile(join(home, 'victim.txt'), 'precious\n');
    const config = JSON.parse(await readFile(join(store, 'sync-agent-docs.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(store, 'sync-agent-docs.json'), JSON.stringify({ ...config, views: { hosts: '../victim.txt', services: 'services.md', projects: 'projects' } }));
    git(store, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'steer');
    const before = tips(root);
    await expect(apply()).rejects.toThrow(/sync-agent-docs\.json: views\.hosts/);
    expect(await readFile(join(home, 'victim.txt'), 'utf8')).toBe('precious\n');
    expect(tips(root)).toEqual(before);
    expect(git(store, 'branch', '--list', 'sync-agent-docs/*')).toBe('');
  });

  it('a store view that git does not track is refused with that reason', async () => {
    const { root, store, apply } = await planned(recommended, {
      prepare: async (dir) => {
        await handRepo(dir);
        git(dir, 'rm', '-q', '--cached', 'hosts.md');
        git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'untrack hosts');
      },
    });
    const before = tips(root);
    const kept = await readFile(join(store, 'hosts.md'), 'utf8');
    const err = await apply().then(() => undefined, (e: Error) => e);
    expect(err?.message).toMatch(new RegExp(`${join(store, 'hosts.md')} is in the store but git does not track it`));
    expect(err?.message).not.toMatch(/gitignore/);
    expect(await readFile(join(store, 'hosts.md'), 'utf8')).toBe(kept);
    expect(tips(root)).toEqual(before);
  });

  it('a store view that git ignores is refused before anything is written', async () => {
    const { root, store, apply } = await planned(recommended, {
      prepare: async (dir) => {
        await handRepo(dir);
        await writeFile(join(dir, '.gitignore'), 'hosts.md\n');
        git(dir, 'rm', '-q', '--cached', 'hosts.md');
        git(dir, 'add', '-A');
        git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'ignore hosts');
      },
    });
    const before = tips(root);
    const kept = await readFile(join(store, 'hosts.md'), 'utf8');
    await expect(apply()).rejects.toThrow(new RegExp(`${join(store, 'hosts.md')}.*git ignores it`));
    expect(await readFile(join(store, 'hosts.md'), 'utf8')).toBe(kept);
    expect(tips(root)).toEqual(before);
    for (const repo of [join(root, 'ops'), join(root, 'shop'), join(root, 'blog'), store]) {
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
      expect(git(repo, 'branch', '--list', 'sync-agent-docs/*')).toBe('');
    }
  });

  it('undo keeps going past a repo it cannot put back and reports every failure', async () => {
    const { root, apply } = await planned(recommended, {
      prepare: async (dir, r) => {
        await handRepo(dir);
        // The store commits last; its hook deletes ops's original branch, so undoing ops fails.
        await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\nunset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE\ngit -C '${join(r, 'ops')}' branch -q -D main\necho "hook says no" >&2\nexit 1\n`, { mode: 0o755 });
      },
    });
    const err = await apply().then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/hook says no/);
    expect(err).toMatch(new RegExp(`Undoing it also failed:[\\s\\S]*${join(root, 'ops')}`));
    for (const repo of ['shop', 'blog']) {
      expect(git(join(root, repo), 'symbolic-ref', '--short', 'HEAD')).toBe('main');
      expect(git(join(root, repo), 'branch', '--list', 'sync-agent-docs/*')).toBe('');
      expect(git(join(root, repo), 'status', '--porcelain')).toBe('');
    }
  });

  it('a failure removes a store folder that apply created', async () => {
    const { root, store, apply } = await planned(recommended, {
      prepare: async (_store, r) => {
        await writeFile(join(r, 'shop', '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
      },
    });
    await expect(stat(store)).rejects.toThrow(/ENOENT/);
    await expect(apply()).rejects.toThrow(/hook says no[\s\S]*changes were undone/);
    await expect(stat(store)).rejects.toThrow(/ENOENT/);
    for (const repo of ['ops', 'shop', 'blog']) {
      expect(git(join(root, repo), 'status', '--porcelain')).toBe('');
      expect(git(join(root, repo), 'symbolic-ref', '--short', 'HEAD')).toBe('main');
      expect(git(join(root, repo), 'branch', '--list', 'sync-agent-docs/*')).toBe('');
    }
  });

  it('a remembered answer changed by hand in plan.json is recorded as the new decision', async () => {
    const { root, home, store, planPath, apply } = await planned((i) => (i.tier === 'secret' ? 'false-positive' : recommended(i)));
    await apply();
    const later = new Date('2026-10-22T12:05:00.000Z');
    const again = await runPlan(root, { home, reposOnly: false, crontabCommand: 'false', store, now: later });
    const secret = again.items.find((i) => i.tier === 'secret' && i.answeredBy === 'remembered');
    expect(secret?.answer).toBe('false-positive');
    for (const i of again.items) if (i === secret) i.answer = 'rotate-remove';
    await writeFile(planPath, JSON.stringify(again));
    await runApply(root, { home, now: later });
    const decisions = JSON.parse(await readFile(join(store, 'store', 'decisions.json'), 'utf8')) as { decisions: { key: string; answer: string }[] };
    expect(decisions.decisions.find((d) => d.key === secret?.key)?.answer).toBe('rotate-remove');
  });

  describe('two replaces on one line', () => {
    const line = 'web 4000 api 5000';
    async function twoSwaps(a: [string, string], b: [string, string]) {
      const fx = await planned(recommended, {
        prepare: async (_store, r) => {
          await writeFile(join(r, 'shop', 'PORTS.md'), `${line}\n`);
          git(join(r, 'shop'), 'add', '-A');
          git(join(r, 'shop'), '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'ports');
        },
      });
      const base = fx.plan.items.find((i) => i.tier === 'conflict');
      if (!base) throw new Error('fixture has no conflict item');
      const path = join(fx.root, 'shop', 'PORTS.md');
      const swap = (title: string, [from, to]: [string, string]): PlanItem => ({
        ...base, key: title, title, follows: undefined, options: ['go'], answer: 'go', answeredBy: 'hand',
        edits: { go: [{ path, line: 1, op: 'replace', lineHash: lineHash(line), before: line, after: line.replace(from, to), from, to }] },
      });
      const plan = JSON.parse(await readFile(fx.planPath, 'utf8')) as Plan;
      plan.items.push(swap('Port A', a), swap('Port B', b));
      await writeFile(fx.planPath, JSON.stringify(plan));
      return { ...fx, path };
    }

    it('both apply, one after the other', async () => {
      const { root, apply } = await twoSwaps(['4000', '4100'], ['5000', '5100']);
      await apply();
      expect(git(join(root, 'shop'), 'show', `${BRANCH}:PORTS.md`)).toBe('web 4100 api 5100');
    });

    it('a second replace that no longer fits is refused and names both items', async () => {
      const { root, apply } = await twoSwaps(['4000', '4100'], ['4000', '4200']);
      await expect(apply()).rejects.toThrow(/"Port A" and "Port B"/);
      expect(git(join(root, 'shop'), 'branch', '--list', 'sync-agent-docs/*')).toBe('');
    });
  });
});

describe('a store under the scan root', () => {
  it('a new store inside a repo with uncommitted changes is refused before any write', async () => {
    const { root, store, apply } = await planned(recommended, {
      storeAt: (r) => join(r, 'ops', 'truth'),
      prepare: async (_s, r) => appendFile(join(r, 'ops', 'hosts.md'), 'edited by hand\n'),
    });
    const parent = join(root, 'ops');
    const err = await apply().then(() => null, (e: Error) => e);
    expect(err?.message).toContain(`${parent} has uncommitted changes`);
    expect(err?.message).toContain('another store path');
    await expect(stat(store)).rejects.toThrow();
    for (const r of ['ops', 'shop', 'blog']) expect(git(join(root, r), 'branch', '--list', 'sync-agent-docs/*')).toBe('');
  });
  it('a new store inside a clean repo is made and the summary says it is nested', async () => {
    const { root, apply } = await planned(recommended, { storeAt: (r) => join(r, 'ops', 'truth') });
    const entry = await apply();
    expect(entry.storeParent).toBe(join(root, 'ops'));
    expect(renderApplySummary(entry)).toContain('is a new git repo nested inside');
  });
  it('a store path under a dangling link stops apply naming the store, with nothing written', async () => {
    const { root, store, apply } = await planned(recommended, {
      storeAt: (r) => join(r, 'gone', 'truth'),
      prepare: async (_store, r) => symlink(join(r, 'missing-target'), join(r, 'gone')),
    });
    const err = await apply().then(() => null, (e: Error) => e);
    expect(err?.message).toContain(`could not check where the new store ${store} would be created`);
    expect(err?.message).toContain('sync-agent-docs plan --store');
    await expect(stat(store)).rejects.toThrow();
    for (const r of ['ops', 'shop', 'blog']) expect(git(join(root, r), 'branch', '--list', 'sync-agent-docs/*')).toBe('');
  });
  it('a second plan after drift never edits the store or its views as claims', async () => {
    const { root, store, home, apply } = await planned(recommended, { storeAt: (r) => join(r, 'truth') });
    await apply();
    for (const r of await readdir(root)) {
      if (r.startsWith('.') || !git(join(root, r), 'branch', '--list', BRANCH)) continue;
      git(join(root, r), 'switch', '-q', 'main');
      git(join(root, r), 'merge', '-q', '--ff-only', BRANCH);
    }
    const eco = join(root, 'shop', 'ecosystem.config.cjs');
    await writeFile(eco, (await readFile(eco, 'utf8')).replace('3300', '3400'));
    git(join(root, 'shop'), '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'port');
    const again = await runPlan(root, { home, reposOnly: false, crontabCommand: 'false', store, now: new Date('2026-10-22T12:01:00.000Z') });
    const edited = again.items.flatMap((i) => Object.values(i.edits).flat()).map((e) => e.path);
    expect(edited.filter((p) => p.startsWith(`${store}/`))).toEqual([]);
    expect(again.items.some((i) => i.evidence.some((e) => e.path.startsWith(`${store}/`)))).toBe(false);
  });
  it('apply compiles agent blocks into the same per-repo commit as the line edits', async () => {
    const { root, apply } = await planned();
    await apply();
    const shop = join(root, 'shop');
    expect(git(shop, 'rev-list', '--count', `main..${BRANCH}`)).toBe('1');
    const claude = git(shop, 'show', `${BRANCH}:CLAUDE.md`);
    expect(claude).not.toContain('hetzner box: 100.64.1.10');
    expect(claude).toContain('<!-- sync-agent-docs:begin compiled -->');
    expect(claude).toContain('| port | `3300` | verified |');
    expect(git(shop, 'show', `${BRANCH}:AGENTS.md`)).toContain('<!-- sync-agent-docs:begin compiled -->');
    expect(git(join(root, 'blog'), 'show', `${BRANCH}:CLAUDE.md`)).toContain('<!-- sync-agent-docs:begin compiled -->');
  });

  it('apply keeps a CLAUDE.md that links to AGENTS.md a link, with the card import in AGENTS.md', async () => {
    const { root, apply } = await planned(recommended, {
      prepare: async (_store, r) => {
        const blog = join(r, 'blog');
        await rename(join(blog, 'CLAUDE.md'), join(blog, 'AGENTS.md'));
        await symlink('AGENTS.md', join(blog, 'CLAUDE.md'));
        git(blog, 'add', '-A');
        git(blog, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'one agent file');
      },
    });
    await apply();
    const blog = join(root, 'blog');
    expect(git(blog, 'ls-tree', BRANCH, 'CLAUDE.md')).toMatch(/^120000 /);
    const agents = git(blog, 'show', `${BRANCH}:AGENTS.md`);
    expect(agents).toContain('@~/truth/projects/blog.md');
    expect(agents.match(/sync-agent-docs:begin compiled/g)).toHaveLength(1);
  });

  it('apply leaves a file an agent-file link points at byte-identical when it is not an agent file', async () => {
    const deploy = '#!/bin/sh\necho deploy\n';
    const { root, apply } = await planned(recommended, {
      prepare: async (_store, r) => {
        const blog = join(r, 'blog');
        await mkdir(join(blog, 'scripts'));
        await writeFile(join(blog, 'scripts', 'deploy.sh'), deploy);
        await rename(join(blog, 'CLAUDE.md'), join(blog, 'NOTES.md'));
        await symlink('scripts/deploy.sh', join(blog, 'CLAUDE.md'));
        git(blog, 'add', '-A');
        git(blog, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'odd link');
      },
    });
    await apply();
    const blog = join(root, 'blog');
    expect(await readFile(join(blog, 'scripts', 'deploy.sh'), 'utf8')).toBe(deploy);
    for (const ref of git(blog, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean)) {
      expect(git(blog, 'show', `${ref}:scripts/deploy.sh`)).toBe(deploy.trim());
    }
  });

  it('apply refuses, by name, an old plan edit on an agent file now linked to a file that is not an agent file', async () => {
    const { root, apply } = await planned();
    const shop = join(root, 'shop');
    await mkdir(join(shop, 'scripts'));
    await rename(join(shop, 'CLAUDE.md'), join(shop, 'scripts', 'agent.sh'));
    await symlink('scripts/agent.sh', join(shop, 'CLAUDE.md'));
    git(shop, 'add', '-A');
    git(shop, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'agent script');
    const before = await readFile(join(shop, 'scripts', 'agent.sh'), 'utf8');
    await expect(apply()).rejects.toThrow(/apply: shop\/CLAUDE\.md is a link to scripts\/agent\.sh, which is not an agent file, so nothing was written\. Items: .+\. Run sync-agent-docs plan again/);
    expect(await readFile(join(shop, 'scripts', 'agent.sh'), 'utf8')).toBe(before);
    expect(git(shop, 'branch', '--list', 'sync-agent-docs/*')).toBe('');
  });

  it('a secret in a file an agent-file link points at is left for rotation by hand and never recorded as removed', async () => {
    const { root, store, plan, secret, apply } = await planned((i) => (i.tier === 'secret' ? 'rotate-manual' : recommended(i)), {
      prepare: async (_store, r) => {
        const shop = join(r, 'shop');
        await mkdir(join(shop, 'scripts'));
        await rename(join(shop, 'AGENTS.md'), join(shop, 'scripts', 'env.sh'));
        await symlink('scripts/env.sh', join(shop, 'AGENTS.md'));
        git(shop, 'add', '-A');
        git(shop, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'env script');
      },
    });
    const note = 'the secret stays in scripts/env.sh; rotate it, then remove it there by hand';
    const item = plan.items.find((i) => i.tier === 'secret');
    expect(item?.options).toEqual(['rotate-manual', 'false-positive']);
    expect(item?.edits).toEqual({});
    expect(item?.notes).toContain(note);
    const entry = await apply();
    expect(await readFile(join(root, 'shop', 'scripts', 'env.sh'), 'utf8')).toContain(secret);
    const facts = JSON.parse(git(store, 'show', `${BRANCH}:store/facts.json`)) as { secrets: unknown[] };
    expect(facts.secrets).toEqual([{ path: 'shop/scripts/env.sh', line: 3, status: 'manual' }]);
    expect(renderApplySummary(entry)).toContain(note);
  });

  it('apply keeps the file mode of an agent file it compiles', async () => {
    const { root, apply } = await planned(recommended, {
      prepare: async (_store, r) => {
        const blog = join(r, 'blog');
        await writeFile(join(blog, 'GEMINI.md'), '# blog\n', { mode: 0o755 });
        git(blog, 'add', '-A');
        git(blog, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'gemini');
      },
    });
    await apply();
    expect(git(join(root, 'blog'), 'ls-tree', BRANCH, 'GEMINI.md')).toMatch(/^100755 /);
  });

  it('a hand-edited compiled block is a plan question: kept while open, rewritten on discard', async () => {
    const { root, home, store, apply } = await planned();
    const entry = await apply();
    for (const r of entry.repos) {
      git(r.path, 'switch', '-q', r.original);
      git(r.path, 'merge', '-q', '--ff-only', r.branch);
    }
    const shop = join(root, 'shop');
    const path = join(shop, 'CLAUDE.md');
    const edited = (await readFile(path, 'utf8')).replace('| port | `3300` |', '| port | `3301` |');
    await writeFile(path, edited);
    git(shop, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'hand edit');
    const later = new Date('2026-10-22T12:05:00.000Z');
    const opts = { home, reposOnly: false, crontabCommand: 'false', store, now: later };
    const plan = await runPlan(root, opts);
    const item = plan.items.find((i) => i.kind === 'compiled-edit');
    expect(item).toMatchObject({ subject: 'shop/CLAUDE.md', options: ['discard', 'keep'], answer: null });
    for (const i of plan.items) if (i.kind !== 'compiled-edit') i.answer = recommended(i);
    await writeFile(join(root, '.sync-agent-docs', 'plan.json'), JSON.stringify(plan));
    const kept = await runApply(root, { home, now: later });
    expect(kept.repos.length).toBeGreaterThan(0);
    expect(await readFile(path, 'utf8')).toContain('| port | `3301` |');
    await runRollback(root);
    if (item) item.answer = 'discard';
    await writeFile(join(root, '.sync-agent-docs', 'plan.json'), JSON.stringify(plan));
    const last = new Date('2026-10-22T12:10:00.000Z');
    await runApply(root, { home, now: last });
    expect(git(shop, 'show', 'sync-agent-docs/apply-20261022-121000:CLAUDE.md')).toContain('| port | `3300` |');
  });
  it("a repo's formats in sync-agent-docs.json survive the next apply and make compile write that file", async () => {
    const { root, home, store, apply } = await planned();
    const entry = await apply();
    for (const r of entry.repos) {
      git(r.path, 'switch', '-q', r.original);
      git(r.path, 'merge', '-q', '--ff-only', r.branch);
    }
    const configPath = join(store, 'sync-agent-docs.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { repos: { name: string; formats?: string[] }[] };
    for (const r of config.repos) if (r.name === 'blog') r.formats = ['gemini'];
    await writeFile(configPath, JSON.stringify(config, null, 2));
    git(store, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'blog wants gemini');
    const later = new Date('2026-10-22T12:05:00.000Z');
    const plan = await runPlan(root, { home, reposOnly: false, crontabCommand: 'false', store, now: later });
    for (const i of plan.items) i.answer = recommended(i);
    await writeFile(join(root, '.sync-agent-docs', 'plan.json'), JSON.stringify(plan));
    await runApply(root, { home, now: later });
    const next = 'sync-agent-docs/apply-20261022-120500';
    const saved = JSON.parse(git(store, 'show', `${next}:sync-agent-docs.json`)) as { repos: { name: string; formats?: string[] }[] };
    expect(saved.repos.find((r) => r.name === 'blog')?.formats).toEqual(['gemini']);
    expect(git(join(root, 'blog'), 'show', `${next}:GEMINI.md`)).toContain('<!-- sync-agent-docs:begin compiled -->');
  });
});
