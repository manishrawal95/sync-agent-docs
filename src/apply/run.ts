import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { refusedLink } from '../compile/links.js';
import { openDotDir, openSubDir, refuseTrackedDotDir, writeFresh } from '../dotdir.js';
import { withLock } from '../lock.js';
import { commitAll, git, GitError, isDirty, isIgnored, isTracked, toplevelOf } from '../git.js';
import { machineClaimPaths } from '../discover/machine.js';
import { checkStorePath, inside, isDir, linkLoop, resolveReal, shortPath } from '../paths.js';
import { readDecisions } from '../plan/decisions.js';
import { toDecision } from '../plan/prompt.js';
import { swapValue } from '../plan/lines.js';
import { TIERS, type Edit, type Plan, type PlanItem } from '../plan/types.js';
import { readJsonFile, readStore, storeFiles } from '../store/io.js';
import type { Store } from '../store/types.js';
import { detectViewEdits } from '../views/edits.js';
import { blockHash, mergeView, parseBlockFacts, readBlocks, renderBlocks, type ViewBlock } from '../views/render.js';
import { compileChanges } from '../compile/run.js';
import type { CompileTarget } from '../compile/compile.js';
import { BranchRun, branchId, checkRepo, type ApplyEntry } from './branches.js';
import { composeStore, type FoldedBlock } from './compose.js';
import { checkEdits, editText, manualPatch } from './edits.js';

export interface ApplyOptions { home: string; now?: Date }

async function readPlan(root: string): Promise<Plan> {
  const path = join(root, '.sync-agent-docs', 'plan.json');
  const plan = await readJsonFile<Plan>(path, 'apply');
  if (!plan) throw new Error(`apply: ${path} does not exist. Run sync-agent-docs plan first.`);
  for (const i of plan.items) {
    if (i.answer !== null && !i.options.includes(i.answer)) {
      throw new Error(`apply: ${path}: "${i.title}" has the answer "${i.answer}", which is not one of ${i.options.join(', ')}. Fix it or run sync-agent-docs plan again.`);
    }
  }
  return plan;
}

/**
 * The edits each answered item makes, in tier order. A remove beats a replace on the same line;
 * two replaces on one line apply in turn, and one whose value is gone after the first is refused.
 */
function chosenEdits(plan: Plan, show: (p: string) => string): { byPath: Map<string, Edit[]>; itemsByPath: Map<string, PlanItem[]> } {
  const byKey = new Map(plan.items.map((i) => [i.key, i]));
  const byPath = new Map<string, Edit[]>();
  const itemsByPath = new Map<string, PlanItem[]>();
  const madeBy = new Map<Edit, PlanItem>();
  const ordered = [...plan.items].sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  for (const i of ordered) {
    if (i.answer === null) continue;
    let edits: Edit[];
    if (i.follows) {
      const led = byKey.get(i.follows)?.answer;
      edits = i.answer === 'accept' && led ? (i.edits[led] ?? []) : [];
    } else {
      edits = i.edits[i.answer] ?? [];
    }
    for (const e of edits) {
      const list = byPath.get(e.path) ?? [];
      const same = list.findIndex((x) => x.op !== 'append' && e.op !== 'append' && x.line === e.line);
      const first = same >= 0 ? list[same] : undefined;
      if (first) {
        if (e.op === 'remove' && first.op === 'replace') list[same] = e;
        else if (e.op === 'replace' && first.op === 'replace' && e.after !== first.after) {
          const next = e.from !== undefined && e.to !== undefined && first.after !== undefined ? swapValue(first.after, e.from, e.to) : null;
          if (next === null) {
            throw new Error(`apply: ${show(e.path)} line ${e.line}: "${madeBy.get(first)?.title ?? 'an earlier item'}" and "${i.title}" both change it, and after the first the second no longer fits, so nothing was written. Answer one of them differently in plan.json and run sync-agent-docs apply again.`);
          }
          list[same] = { ...first, after: next };
          madeBy.set(list[same], madeBy.get(first) ?? i);
        }
      } else if (!(e.op === 'append' && list.some((x) => x.op === 'append' && x.after === e.after))) {
        list.push(e);
        madeBy.set(e, i);
      }
      byPath.set(e.path, list);
      const items = itemsByPath.get(e.path) ?? [];
      if (!items.includes(i)) items.push(i);
      itemsByPath.set(e.path, items);
    }
  }
  return { byPath, itemsByPath };
}

/** The deepest folder at or above `path` that exists, where a store not yet made would land. */
async function nearestExisting(path: string): Promise<string> {
  let dir = path;
  while (!(await exists(dir))) dir = dirname(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`apply: could not check ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Check its permissions.`, { cause: err });
  }
}

async function readOrNull(path: string, stage = 'apply'): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${stage}: could not read ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Check its permissions.`, { cause: err });
  }
}

const viewTitle = (file: string): string => (file.startsWith('projects/') ? basename(file, '.md') : basename(file, '.md').replace(/^./, (c) => c.toUpperCase()));

/** Every view file's next text and its block hashes. A block with an open view-edit question is kept as it stands. */
export async function renderViews(storeDir: string, store: Store, keep: Set<string>, stage = 'apply'): Promise<Map<string, { text: string; hashes: Record<string, string> }>> {
  const blocks = renderBlocks(store);
  const files = new Set([...Object.keys(blocks), ...Object.keys(store.config.generated)]);
  const out = new Map<string, { text: string; hashes: Record<string, string> }>();
  for (const file of files) {
    const path = join(storeDir, file);
    const existing = await readOrNull(path, stage);
    let current: Record<string, string> = {};
    try {
      current = existing === null ? {} : readBlocks(existing);
    } catch (err) {
      throw new Error(`${stage}: ${path}: ${(err as Error).message}`, { cause: err });
    }
    const wanted: ViewBlock[] = (blocks[file] ?? []).map((b) => {
      const raw = keep.has(`${file}#${b.id}`) ? current[b.id] : undefined;
      return raw === undefined ? b : { ...b, raw };
    });
    const text = mergeView(existing, viewTitle(file), wanted);
    const prev = store.config.generated[file] ?? {};
    const hashes = Object.fromEntries(Object.entries(readBlocks(text)).map(([id, body]) => [id, keep.has(`${file}#${id}`) && prev[id] ? prev[id] : blockHash(body)]));
    out.set(file, { text, hashes });
  }
  return out;
}

/** Rows of each hand-edited block the user chose to fold. */
async function foldedBlocks(storeDir: string, plan: Plan): Promise<FoldedBlock[]> {
  const out: FoldedBlock[] = [];
  for (const i of plan.items) {
    if (i.kind !== 'view-edit' || i.answer !== 'fold' || !i.entityId) continue;
    const [file = '', id = ''] = i.subject.split('#');
    const text = await readOrNull(join(storeDir, file));
    const body = text === null ? undefined : readBlocks(text)[id];
    if (body === undefined) continue;
    out.push({ entityId: i.entityId, commands: id.endsWith(':commands'), facts: parseBlockFacts(body) });
  }
  return out;
}

function commitMessage(id: string, items: PlanItem[]): string {
  const lines = [...new Set(items.map((i) => `- ${i.title}`))];
  return `chore(sync-agent-docs): apply plan ${id}${lines.length ? `\n\n${lines.join('\n')}` : ''}`;
}

/**
 * Writes the truth store, its views and every approved edit, each repo on a new
 * `sync-agent-docs/apply-<id>` branch with one commit. Every refusal happens before the first write;
 * nothing is merged or pushed.
 */
export async function runApply(root: string, opts: ApplyOptions): Promise<ApplyEntry> {
  const now = opts.now ?? new Date();
  const id = branchId(now);
  const branch = `sync-agent-docs/apply-${id}`;
  await refuseTrackedDotDir(root, 'apply');
  return withLock(root, 'apply', async (lock) => {
    const plan = await readPlan(root);
    const storeDir = await checkStorePath(plan.store, opts.home, join(root, '.sync-agent-docs', 'plan.json'), 'apply', 'Run sync-agent-docs plan --store <folder> with a folder inside your home folder.');
    await lock.store(storeDir);
    const show = (p: string): string => shortPath(p, root, opts.home);

    // Group edits by repo; a file outside any repo, or one git does not track, gets a patch instead.
    const { byPath, itemsByPath } = chosenEdits(plan, show);
    const repoFiles = new Map<string, { real: string; text: string; edits: Edit[]; items: PlanItem[] }[]>();
    const manual: { path: string; text: string; edits: Edit[]; why: string }[] = [];
    // plan.json is a file anyone can edit: an edit may only reach the scanned folder or a machine agent
    // file. The folder is resolved, not the file, so a linked agent file stays the link rule's to judge.
    const where = async (p: string): Promise<string> => join(await resolveReal(dirname(p), 'apply'), basename(p));
    const realRoot = await realpath(root);
    const machine = new Set(await Promise.all((await machineClaimPaths(opts.home)).map(where)));
    for (const path of byPath.keys()) {
      const at = await where(path);
      if (!inside(at, realRoot) && !machine.has(at)) {
        const items = (itemsByPath.get(path) ?? []).map((i) => i.title).join('; ');
        throw new Error(`apply: ${show(path)} is outside ${show(root)} and is not a machine agent file, so nothing was written. Items: ${items}. Run sync-agent-docs plan again; it proposes no edit there.`);
      }
    }
    for (const [path, edits] of byPath) {
      // An old plan.json can predate a link loop or a folder where an agent file was; refuse before any write.
      if (await linkLoop(path, 'apply')) {
        throw new Error(`apply: ${show(path)} is a link loop, so nothing was written. Delete the link or point it at a file, then run sync-agent-docs plan again.`);
      }
      if (await isDir(path, 'apply')) {
        throw new Error(`apply: ${show(path)} is a folder, not a file, so nothing was written. Move it, then run sync-agent-docs plan again.`);
      }
      // An old plan.json can predate the link; the rule is the one compile and plan follow.
      const refused = await refusedLink(path, 'apply');
      if (refused) {
        const items = (itemsByPath.get(path) ?? []).map((i) => i.title).join('; ');
        throw new Error(`apply: ${show(path)} is a link to ${refused.inRepo ? refused.target : show(refused.real)}, which is not an agent file, so nothing was written. Items: ${items}. Run sync-agent-docs plan again; it proposes no edit there.`);
      }
      let real: string;
      let text: string;
      try {
        real = await realpath(path);
        text = await readFile(real, 'utf8');
      } catch (err) {
        throw new Error(`apply: could not read ${show(path)} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}), so nothing was written; run sync-agent-docs plan again.`, { cause: err });
      }
      checkEdits(text, edits, show(path));
      const repo = await toplevelOf(real);
      if (!repo || !(await isTracked(repo, real))) {
        manual.push({ path, text, edits, why: repo ? 'git does not track it' : 'it is not inside a git repository' });
        continue;
      }
      repoFiles.set(repo, [...(repoFiles.get(repo) ?? []), { real, text, edits, items: itemsByPath.get(path) ?? [] }]);
    }

    // Files that only get a patch: the store records them, and a secret in one is not reported removed.
    const manualPaths = new Set(manual.map((m) => m.path));

    // A new store is `git init`ed where it stands, so the repo around it must be clean first.
    const storeExists = await exists(storeDir);
    let storeParent: string | null = null;
    if (!storeExists) {
      try {
        storeParent = await toplevelOf(await nearestExisting(dirname(storeDir)));
      } catch (err) {
        if (err instanceof GitError) throw err;
        throw new Error(`apply: could not check where the new store ${storeDir} would be created (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}), so nothing was written. Check that the folders above it exist and are readable, or pick another store path with sync-agent-docs plan --store <folder>.`, { cause: err });
      }
      if (storeParent && (await isDirty(storeParent))) {
        throw new Error(`apply: ${storeParent} has uncommitted changes and the new store ${storeDir} would be created inside it, so nothing was written. Commit or stash them there, or pick another store path with sync-agent-docs plan --store <folder> outside that repo.`);
      }
    }

    const originals = new Map<string, string>();
    for (const repo of repoFiles.keys()) originals.set(repo, await checkRepo(repo, branch, 'apply'));

    if (storeExists) {
      const top = await toplevelOf(storeDir);
      if (top !== (await realpath(storeDir))) {
        throw new Error(`apply: ${storeDir} exists but is not the top of a git repository, so nothing was written. Run sync-agent-docs plan --store with another folder, or run git init there.`);
      }
      if (!originals.has(top)) originals.set(top, await checkRepo(top, branch, 'apply'));
    }

    const prev = storeExists ? await readStore(storeDir) : null;
    // A view block edited by hand after plan ran (or edited again since) has no answer in plan.json:
    // overwriting it would lose the edit. The key holds the edited text's hash, so a re-edit is new.
    const planned = new Set(plan.items.filter((i) => i.kind === 'view-edit').map((i) => i.key));
    const late = prev ? (await detectViewEdits(storeDir, prev, 'apply')).filter((i) => !planned.has(i.key)) : [];
    if (late.length) {
      throw new Error(`apply: ${late.map((i) => i.subject).join(', ')} ${late.length === 1 ? 'was' : 'were'} edited by hand after the plan was made, so nothing was written. Run sync-agent-docs plan again to choose what to keep.`);
    }
    // A remembered answer someone changed by hand in plan.json is a new decision too.
    const known = await readDecisions(root, storeDir);
    const stored = new Map(known.map((d) => [d.key, d.answer]));
    const answered = plan.items.filter((i) => i.answer !== null && (i.answeredBy !== 'remembered' || stored.get(i.key) !== i.answer));
    const decisions = [...known, ...answered.map((i) => toDecision(i, i.answer ?? '', now))];
    const store = composeStore(prev, plan, decisions, opts.home, await foldedBlocks(storeDir, plan), manualPaths);
    const openEdits = new Set(plan.items.filter((i) => i.kind === 'view-edit' && i.answer === null).map((i) => i.subject));
    const views = await renderViews(storeDir, store, openEdits);
    store.config.generated = Object.fromEntries([...views].map(([file, v]) => [file, v.hashes]));
    if (storeExists) {
      // A store or view file that is there but untracked would be overwritten, and an ignored one
      // would then fail to commit.
      const real = await realpath(storeDir);
      for (const path of [...storeFiles(real, store).map(([p]) => p), ...[...views.keys()].map((f) => join(real, f))]) {
        if ((await exists(path)) && !(await isTracked(real, path))) {
          if (await isIgnored(real, path)) {
            throw new Error(`apply: ${path} is in the store but git ignores it, so nothing was written. Take it out of the store's .gitignore and commit it, or move it away, then run sync-agent-docs apply again.`);
          }
          throw new Error(`apply: ${path} is in the store but git does not track it, so nothing was written. Commit it or move it away, then run sync-agent-docs apply again.`);
        }
      }
    }

    // Agent files get their compiled blocks in the same commit as their line edits; a block edited by
    // hand is kept until plan's compiled-edit question is answered discard.
    const answers = new Map<string, string>();
    for (const d of known) if (d.answer !== null) answers.set(d.key, d.answer);
    for (const i of plan.items) if (i.answer !== null) answers.set(i.key, i.answer);
    const edited = new Map([...repoFiles.values()].flat().map((f) => [f.real, editText(f.text, f.edits)]));
    // By real repo and real file path, the keys the line edits use.
    const compiled = new Map<string, Map<string, CompileTarget>>();
    for (const [repo, targets] of (await compileChanges(root, store, { storeDir, home: opts.home }, answers, edited)).changes) {
      const real = await realpath(repo);
      const files = new Map<string, CompileTarget>();
      for (const c of targets) files.set(await resolveReal(c.path, 'apply'), c);
      compiled.set(real, files);
      if (!originals.has(real)) originals.set(real, await checkRepo(real, branch, 'apply'));
    }

    // Every check passed: from here on, write.
    const dot = await openDotDir(root, 'apply');
    const entry: ApplyEntry = {
      id, at: now.toISOString(), store: storeDir, repos: [], manual: [],
      skipped: plan.items.filter((i) => i.answer === null).map((i) => i.title),
      ...(storeParent ? { storeParent } : {}),
      secrets: [
        ...plan.items.filter((i) => i.secretAt && i.answer === 'rotate-manual').flatMap((i) => i.notes.filter((n) => n.startsWith('the secret stays in '))),
        ...plan.items.filter((i) => i.kind === 'secret' && i.answer === 'rotate-remove').flatMap((i) => (i.edits['rotate-remove'] ?? []).filter((e) => manualPaths.has(e.path)).map((e) => `${show(e.path)}:${e.line} (patch written; rotate the key and apply the patch by hand)`)),
      ],
    };
    // Checked before any branch exists, so a planted link stops the run with nothing to undo.
    const patches = manual.length ? await openSubDir(dot, 'manual', 'apply') : '';
    const run = await BranchRun.start(root, 'apply', entry);
    run.at = 'the manual patches';
    try {
      for (const [n, m] of manual.entries()) {
        const name = `${id}-${n + 1}-${basename(m.path)}.patch`;
        await writeFresh(patches, name, manualPatch(m.path, m.text, m.edits, m.why));
        entry.manual.push(join(patches, name));
        (entry.targets ??= []).push({ file: m.path, patch: join(patches, name), sha256: createHash('sha256').update(m.text).digest('hex') });
      }
      await run.record();

      run.at = storeDir;
      if (!storeExists) {
        await mkdir(storeDir, { recursive: true });
        await git(storeDir, ['init', '-q', '-b', 'main'], 'apply');
        await commitAll(storeDir, [], 'chore(sync-agent-docs): start the truth store');
      }
      const storeRepo = await realpath(storeDir);
      // The store repo gets its writes in the same branch and commit as its own line edits, if it has any.
      const repos = [...new Set([...repoFiles.keys(), ...compiled.keys()])].filter((r) => r !== storeRepo);
      for (const repo of [...repos, storeRepo]) {
        await run.commitOnBranch(repo, branch, originals.get(repo) ?? 'main', async (t) => {
          const files = repoFiles.get(repo) ?? [];
          const blocks = new Map(compiled.get(repo));
          for (const f of files) {
            const next = blocks.get(f.real)?.next ?? editText(f.text, f.edits);
            blocks.delete(f.real);
            await run.write(t, f.real, next, (await lstat(f.real)).mode & 0o7777);
          }
          for (const [path, c] of blocks) await run.write(t, path, c.next, c.mode ?? undefined);
          let items = files.flatMap((f) => f.items);
          if (repo === storeRepo) {
            for (const [path, json] of storeFiles(storeRepo, store)) await run.write(t, path, json);
            for (const [file, v] of views) await run.write(t, join(storeRepo, file), v.text);
            items = [...items, ...plan.items.filter((i) => i.answer !== null)];
          }
          return commitMessage(id, items);
        });
      }
    } catch (err) {
      return run.fail(err, storeExists ? null : storeDir);
    }
    return entry;
  });
}

export function renderApplySummary(entry: ApplyEntry): string {
  const lines = [entry.repos.length ? `Applied plan ${entry.id}. Nothing was merged or pushed.` : `Applied plan ${entry.id}. No file changed, so no branch was made.`];
  for (const r of entry.repos) lines.push(`  ${r.path}: branch ${r.branch} (from ${r.original})`);
  if (entry.manual.length) {
    lines.push('Files outside git were left alone. Patches to review and apply by hand:');
    for (const m of entry.manual) lines.push(`  ${m}`);
  }
  for (const s of entry.secrets ?? []) lines.push(`Not removed: ${s}.`);
  if (entry.storeParent) lines.push(`The store ${entry.store} is a new git repo nested inside ${entry.storeParent}.`);
  if (entry.skipped.length) lines.push(`${entry.skipped.length} open items were left alone; run sync-agent-docs plan to answer them.`);
  if (entry.repos.length) lines.push('Next: review each branch and merge it yourself, or run sync-agent-docs rollback to delete them.');
  return lines.join('\n');
}
