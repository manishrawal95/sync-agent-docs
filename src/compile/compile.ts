import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { isIgnored, isTracked, toplevelOf } from '../git.js';
import { ABSENT, codeOf, danglingLink, isDir, linkLoop, nextStep, NOT_THERE, resolveReal, shortPath } from '../paths.js';
import { decisionKey } from '../plan/decisions.js';
import type { Store } from '../store/types.js';
import type { AgentFormat } from '../types.js';
import { viewFile } from '../views/render.js';
import { type CompiledBlock, editReason, outsideCompiled, readCompiledBlock, writeCompiledBlock } from './block.js';
import { repoDependencies, repoEntry } from './deps.js';
import { type AgentCompiler, IMPORT_LINE, importsCard } from './content.js';
import { COMPILED_FILES, COMPILERS } from './formats/index.js';
import { refusedLink } from './links.js';

/** `isIgnoredOrUntracked`, when given, lets drift report what compile would leave alone as skipped; without it no git runs. */
export interface CompileContext { storeDir: string; home: string; isIgnoredOrUntracked?: (file: string) => Promise<boolean> }
/**
 * `file` is absolute. edited: the body no longer matches its hash; missing: no block where one belongs;
 * stale: intact but behind the store; skipped: it would drift, but compile leaves it alone, for `reason`.
 */
export type CompiledDrift = { file: string; kind: 'edited' | 'missing' | 'stale' } | { file: string; kind: 'skipped'; reason: string };
/**
 * One agent file compile keeps: its text now (null when absent), the text it should have, and its
 * permission bits to keep (null for a new file). `edited` is set for a hand-edited block.
 */
export interface CompileTarget { format: AgentFormat; path: string; existing: string | null; next: string; mode: number | null; edited: CompiledBlock | null }

/** The plan question for a hand-edited block, keyed over the file and the edited body, so a new edit asks again. */
export function compiledEditKey(path: string, block: CompiledBlock, root: string, home: string): { key: string; subject: string } {
  const subject = shortPath(path, root, home);
  return { key: decisionKey('compiled-edit', subject, [block.actual]), subject };
}

type Inspected = { target: CompileTarget } | { path: string; broken: Error };


async function readExisting(path: string): Promise<string | null> {
  try {
    await lstat(path);
  } catch (err) {
    if (ABSENT.has(codeOf(err))) return null;
    throw new Error(`compile: could not check ${path} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
  }
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`compile: could not read ${path} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
  }
}

/** The project card import for a CLAUDE.md, or null when the store has no card for this repo or its path has whitespace (`notes` then says why). */
function cardImport(store: Store, repoName: string, ctx: CompileContext, notes: string[]): string | null {
  const project = store.entities.find((e) => e.id === `project:${repoName}`);
  if (!project) return null;
  const card = `@${shortPath(ctx.storeDir, '\0', ctx.home)}/${viewFile(store.config.views, project)}`;
  if (IMPORT_LINE.test(card)) return card;
  notes.push(`${repoName} got no card import: the card path ${card.slice(1)} has whitespace, and Claude Code imports cannot hold whitespace. Move the store to a path without spaces, then run sync-agent-docs compile again.`);
  return null;
}

/** The agent files that are one file on disk, so compile writes that file once and never replaces a link. */
interface Group { real: string; path: string; compilers: AgentCompiler[]; links: string[] }

async function inspect(repoPath: string, store: Store, ctx: CompileContext, texts?: ReadonlyMap<string, string>): Promise<{ found: Inspected[]; notes: string[]; skipped: { file: string; reason: string }[] }> {
  const repoReal = await realpath(repoPath);
  const entry = repoEntry(repoPath, store, ctx.home);
  const entityIds = repoDependencies(repoPath, store, ctx.home);
  const wanted = entry.formats ?? [];
  const found: Inspected[] = [];
  const notes: string[] = [];
  const card = cardImport(store, entry.name, ctx, notes);
  const skipped: { file: string; reason: string }[] = [];
  const groups = new Map<string, Group>();
  for (const c of COMPILERS) {
    if (!store.config.agentFormats.includes(c.format)) continue;
    const path = join(repoPath, c.file);
    if (await linkLoop(path, 'compile')) {
      notes.push(`${path} is a link loop, so compile skipped it. Delete the link or point it at a file.`);
      skipped.push({ file: path, reason: 'it is a link loop, so compile leaves it alone' });
      continue;
    }
    const to = await danglingLink(path, 'compile');
    if (to !== null) {
      notes.push(`${path} is a link to ${to}, which does not exist, so compile skipped it. Point the link at a file, or delete it.`);
      skipped.push({ file: path, reason: `it is a link to ${to}, which does not exist, so compile leaves it alone` });
      continue;
    }
    if (await isDir(path, 'compile')) {
      notes.push(`${path} is a folder, not a file, so compile skipped it. Rename the folder, or delete it.`);
      skipped.push({ file: path, reason: 'it is a folder, not a file, so compile leaves it alone' });
      continue;
    }
    // A link is followed only to another agent file: never into .git, a script or a manifest.
    const refused = await refusedLink(path, 'compile', repoPath);
    if (refused && !refused.inRepo) {
      notes.push(`${path} is a link to ${refused.real}, outside the repo, so compile left it alone. Edit that file by hand, or replace the link with a file of its own.`);
      skipped.push({ file: path, reason: `it is a link to ${refused.real}, outside the repo, so compile leaves it alone` });
      continue;
    }
    if (refused) {
      notes.push(`${path} is a link to ${refused.target}, which is not an agent file, so compile left it alone. Point the link at one of ${COMPILED_FILES.join(', ')}, or replace it with a file of its own.`);
      skipped.push({ file: path, reason: `it is a link to ${refused.target}, which is not an agent file, so compile leaves it alone` });
      continue;
    }
    const real = await resolveReal(path, 'compile');
    // Written by its place in the repo, never through a link, so a link stays a link.
    const at = join(repoPath, relative(repoReal, real));
    const g = groups.get(real) ?? { real, path: at, compilers: [], links: [] };
    g.compilers.push(c);
    if (at !== path) g.links.push(path);
    groups.set(real, g);
  }
  for (const g of groups.values()) {
    const owner = g.compilers.find((c) => join(repoPath, c.file) === g.path) ?? g.compilers[0];
    if (!owner) continue;
    // A file several agents read gets the Claude block, which is the others' block plus the card import.
    const writer = g.compilers.find((c) => c.format === 'claude') ?? owner;
    // Every link gets the note, even when the target's own format is not allowed: it is still written.
    for (const link of g.links) {
      notes.push(`${link} is a link to ${relative(repoPath, g.path)}, so compile wrote the block into ${relative(repoPath, g.path)} only and kept the link.`);
    }
    const existing = texts?.get(g.real) ?? (await readExisting(g.path));
    if (existing === null && !g.compilers.some((c) => wanted.includes(c.format)) && !(await anyPresent(g.compilers, repoPath))) continue;
    let block: CompiledBlock | null;
    try {
      block = existing === null ? null : readCompiledBlock(existing);
    } catch (err) {
      found.push({ path: g.path, broken: err as Error });
      continue;
    }
    const outside = existing === null ? '' : outsideCompiled(existing);
    const body = writer.body({ repoPath, store, entityIds, outside, card, project: `project:${entry.name}`, shared: writer.format === 'claude' && importsCard(outside, card) && (await sharesFile(repoPath, g.path, writer.file)) });
    const next = writeCompiledBlock(existing, body, owner.newFilePrefix);
    const mode = existing === null ? null : (await lstat(g.path)).mode & 0o7777;
    found.push({ target: { format: owner.format, path: g.path, existing, next, mode, edited: block && editReason(block) ? block : null } });
  }
  return { found, notes, skipped };
}

/** True when another agent file in the repo is the same file on disk (a link or a hard link), whether or not its format is enabled. */
async function sharesFile(repoPath: string, own: string, ownFile: string): Promise<boolean> {
  const { dev, ino } = await stat(own);
  for (const f of COMPILED_FILES) {
    if (f === ownFile) continue;
    const path = join(repoPath, f);
    try {
      const other = await stat(path);
      if (other.dev === dev && other.ino === ino) return true;
    } catch (err) {
      // A file that cannot be found cannot be this file.
      if (NOT_THERE.has((err as NodeJS.ErrnoException).code ?? '')) continue;
      throw new Error(`compile: could not check ${path} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
    }
  }
  return false;
}

async function anyPresent(compilers: AgentCompiler[], repoPath: string): Promise<boolean> {
  for (const c of compilers) if (await c.present(repoPath)) return true;
  return false;
}

/**
 * Every agent file compile keeps in the repo, with its next text. `texts` overrides a file's text on
 * disk, by real path, for a caller editing it in the same commit. A broken compiled block is refused.
 */
export async function compileTargets(repoPath: string, store: Store, ctx: CompileContext, texts?: ReadonlyMap<string, string>): Promise<{ targets: CompileTarget[]; notes: string[] }> {
  const { found, notes } = await inspect(repoPath, store, ctx, texts);
  const targets: CompileTarget[] = [];
  for (const f of found) {
    if ('broken' in f) throw new Error(`compile: ${relative(repoPath, f.path)} in ${repoPath}: ${f.broken.message} Nothing was written.`, { cause: f.broken });
    targets.push(f.target);
  }
  return { targets, notes };
}

/**
 * How each compiled block in a repo differs from what compile would write now. Reads files only, no
 * git; `sync-agent-docs doctor` calls this and reimplements none of it. A broken block counts as edited.
 */
export async function compiledDrift(repoPath: string, store: Store, ctx: CompileContext): Promise<CompiledDrift[]> {
  const { found, skipped } = await inspect(repoPath, store, ctx);
  const out: CompiledDrift[] = skipped.map((s) => ({ ...s, kind: 'skipped' }));
  for (const f of found) {
    const file = 'broken' in f ? f.path : f.target.path;
    const kind = 'broken' in f ? 'edited' : driftKind(f.target);
    if (!kind) continue;
    if (await ctx.isIgnoredOrUntracked?.(file)) out.push({ file, kind: 'skipped', reason: 'git ignores or does not track it, so compile leaves it alone' });
    else out.push({ file, kind });
  }
  return out;
}

function driftKind(t: CompileTarget): 'edited' | 'missing' | 'stale' | null {
  const block = t.existing === null ? null : readCompiledBlock(t.existing);
  if (!block) return 'missing';
  if (t.edited) return 'edited';
  return t.next !== t.existing ? 'stale' : null;
}

/** Why compile would leave `rel` in `repo` alone: git ignores it, or it exists and git does not track it. */
export async function gitSkip(repo: string, rel: string, exists: boolean): Promise<'ignored' | 'untracked' | null> {
  if (await isIgnored(repo, rel)) return 'ignored';
  return exists && !(await isTracked(repo, rel)) ? 'untracked' : null;
}

/** The git-backed checker for CompileContext: true when compile would not commit `file` (absolute). */
export async function isIgnoredOrUntracked(file: string): Promise<boolean> {
  let dir = dirname(file);
  while (!(await isDir(dir, 'compile')) && dirname(dir) !== dir) dir = dirname(dir);
  const repo = await toplevelOf(dir);
  if (!repo) return true;
  const exists = await lstat(file).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false;
      throw new Error(`compile: could not check ${file} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
    },
  );
  return (await gitSkip(repo, relative(repo, await resolveReal(file, 'compile')), exists)) !== null;
}
