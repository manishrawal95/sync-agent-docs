import { relative } from 'node:path';
import { BranchRun, branchId, checkRepo, type ApplyEntry } from '../apply/branches.js';
import { refuseTrackedDotDir } from '../dotdir.js';
import { withLock } from '../lock.js';
import { git, toplevelOf } from '../git.js';
import { inside, isDir, resolveReal, shortPath } from '../paths.js';
import { readDecisions } from '../plan/decisions.js';
import { resolveStore } from '../plan/run.js';
import { readStore } from '../store/io.js';
import type { Store } from '../store/types.js';
import { editReason, type EditReason } from './block.js';
import { compiledEditKey, compileTargets, gitSkip, type CompileContext, type CompileTarget } from './compile.js';
import { storePath } from './deps.js';

export interface CompileOptions { home: string; store?: string; now?: Date }
export interface CompileResult { entry: ApplyEntry | null; notes: string[] }

export const COMPILE_MESSAGE = 'chore(sync-agent-docs): compile agent blocks';

/** What compile would write, by repo, and the hand-edited files with no answer, which the caller refuses or keeps. */
export interface CompileChanges { changes: Map<string, CompileTarget[]>; notes: string[]; edited: { path: string; reason: EditReason }[] }

/** Why compile refuses: the files grouped by the reason their block counts as edited, the same two reasons doctor and plan give. */
function refusal(edited: CompileChanges['edited']): string {
  const where = (reason: EditReason): string => edited.filter((e) => e.reason === reason).map((e) => e.path).join(', ');
  return [
    where('body-changed') && `the compiled block was edited by hand in ${where('body-changed')}`,
    where('hash-missing') && `the compiled block's hash line is missing in ${where('hash-missing')}, so sync-agent-docs cannot tell it from a hand edit; a damaged marker looks the same`,
  ].filter(Boolean).join('; and ');
}

/**
 * Every agent file to rewrite in every repo the store lists. `texts` gives a file's text by real
 * path when the caller is changing it in the same commit; `answers` holds compiled-edit answers by key.
 * A skipped file gets a note; nothing is written.
 */
export async function compileChanges(root: string, store: Store, ctx: CompileContext, answers: Map<string, string>, texts?: ReadonlyMap<string, string>): Promise<CompileChanges> {
  const show = (p: string): string => shortPath(p, root, ctx.home);
  const notes: string[] = [];
  const edited: CompileChanges['edited'] = [];
  const changes = new Map<string, CompileTarget[]>();
  const storeReal = await resolveReal(ctx.storeDir, 'compile');
  const rootReal = await resolveReal(storePath(store.config.root, ctx.home, ctx.home), 'compile');
  for (const r of store.config.repos) {
    const repo = storePath(r.path, store.config.root, ctx.home);
    if (!(await isDir(repo, 'compile'))) {
      notes.push(`${show(repo)} is listed in sync-agent-docs.json but is not there, so compile skipped it.`);
      continue;
    }
    const repoReal = await resolveReal(repo, 'compile');
    // The store's own commit is apply's; agent files there would restate the store to itself.
    if (repoReal === storeReal) {
      notes.push(`${show(repo)} is the truth store, so compile skipped it. Take it out of repos in sync-agent-docs.json to silence this note.`);
      continue;
    }
    if (!inside(repoReal, rootReal)) {
      throw new Error(`compile: sync-agent-docs.json lists ${show(repo)}, which is outside root ${store.config.root}, so nothing was written. Move the repo under ${store.config.root}, or take it out of repos in sync-agent-docs.json.`);
    }
    const found = await compileTargets(repo, store, ctx, texts);
    notes.push(...found.notes);
    const write: CompileTarget[] = [];
    for (const t of found.targets) {
      if (t.next === t.existing) continue;
      const skip = await gitSkip(repo, relative(repo, t.path), t.existing !== null);
      if (skip === 'ignored') {
        notes.push(`${show(t.path)} was left alone: git ignores it, so compile could not commit it. Take it out of .gitignore to have compile keep it.`);
        continue;
      }
      if (skip === 'untracked') {
        notes.push(`${show(t.path)} was left alone: git does not track it. Commit it to have compile keep it.`);
        continue;
      }
      if (t.edited) {
        const answer = answers.get(compiledEditKey(t.path, t.edited, root, ctx.home).key);
        if (answer === 'keep') {
          notes.push(`${show(t.path)}: its hand-edited block was kept, as you answered in plan.`);
          continue;
        }
        if (answer !== 'discard') {
          edited.push({ path: show(t.path), reason: editReason(t.edited) ?? 'body-changed' });
          continue;
        }
      }
      write.push(t);
    }
    if (write.length) changes.set(repo, write);
  }
  return { changes, notes, edited };
}

/** A note per apply branch the store has not merged: compile reads the store as checked out, so those facts are missing. */
async function unmergedApplies(storeDir: string): Promise<string[]> {
  if (!(await toplevelOf(storeDir))) return [];
  const out = await git(storeDir, ['branch', '--list', '--no-merged', 'HEAD', '--format=%(refname:short)', 'sync-agent-docs/apply-*'], 'compile');
  return out.split('\n').filter(Boolean).map((b) => `${b} is not merged in the truth store, so compile used the store without it. Merge it, then run sync-agent-docs compile again.`);
}

/**
 * Rewrites the compiled block in every agent file of every repo the store lists, each repo on a new
 * `sync-agent-docs/compile-<id>` branch with one commit, recorded in applies.json so rollback undoes it.
 * Every check runs before the first write. Nothing is merged or pushed; nothing to change makes no branch.
 */
export async function runCompile(root: string, opts: CompileOptions): Promise<CompileResult> {
  await refuseTrackedDotDir(root, 'compile');
  return withLock(root, 'compile', async (lock) => {
    const now = opts.now ?? new Date();
    const storeDir = await resolveStore(root, opts.home, opts.store, 'compile');
    await lock.store(storeDir);
    const store = await readStore(storeDir);
    if (!store) throw new Error(`compile: there is no truth store at ${storeDir}. Run sync-agent-docs plan and then sync-agent-docs apply to make one, or pass --store with its folder.`);
    const ctx = { storeDir, home: opts.home };
    const answers = new Map((await readDecisions(root, storeDir)).map((d) => [d.key, d.answer]));

    const { changes, notes, edited } = await compileChanges(root, store, ctx, answers);
    notes.push(...(await unmergedApplies(storeDir)));
    if (edited.length) {
      throw new Error(`compile: ${refusal(edited)}. Nothing was written. Run sync-agent-docs plan to choose whether to keep or discard each, then sync-agent-docs apply.`);
    }
    if (!changes.size) return { entry: null, notes: ['Every compiled block is up to date. No branch was made.', ...notes] };

    const id = branchId(now);
    const branch = `sync-agent-docs/compile-${id}`;
    const originals = new Map<string, string>();
    for (const repo of changes.keys()) originals.set(repo, await checkRepo(repo, branch, 'compile'));

    const entry: ApplyEntry = { id, at: now.toISOString(), store: storeDir, repos: [], manual: [], skipped: [], kind: 'compile' };
    const run = await BranchRun.start(root, 'compile', entry);
    try {
      await run.record();
      for (const [repo, targets] of changes) {
        await run.commitOnBranch(repo, branch, originals.get(repo) ?? 'main', async (t) => {
          for (const target of targets) await run.write(t, target.path, target.next, target.mode ?? undefined);
          return COMPILE_MESSAGE;
        });
      }
    } catch (err) {
      return run.fail(err, null);
    }
    return { entry, notes };
  });
}

export function renderCompileSummary({ entry, notes }: CompileResult): string {
  if (!entry) return notes.join('\n');
  return [
    `Compiled agent blocks (${entry.id}). Nothing was merged or pushed.`,
    ...entry.repos.map((r) => `  ${r.path}: branch ${r.branch} (from ${r.original})`),
    ...notes,
    'Next: review each branch and merge it yourself, or run sync-agent-docs rollback to delete them.',
  ].join('\n');
}
