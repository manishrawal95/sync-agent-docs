import { open, readFile, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { Ignore } from 'ignore';
import { ignoredPaths, toplevelOf } from '../git.js';
import { insideStore } from '../store/inside.js';
import { DEFAULT_VIEWS, type TruthConfig } from '../store/types.js';
import type { AgentFormat, RepoInfo, SkippedFile, SourceFile, SourceFormat } from '../types.js';
import { isTestData, listDir, loadIgnore, SKIP_DIRS } from './repos.js';

export const MAX_FILE_BYTES = 512 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;

/** Docs that record history rather than current state; their old values are not claims. */
const HISTORY_DOCS = new Set(['CHANGELOG.md', 'HISTORY.md']);

const AGENT_FILES: Record<string, AgentFormat> = {
  'CLAUDE.md': 'claude',
  'AGENTS.md': 'agents',
  'GEMINI.md': 'gemini',
};

function truthFormat(rel: string): SourceFormat | null {
  const name = basename(rel);
  if (name === 'package.json') return 'package-json';
  if (/^\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$/.test(rel)) return 'github-workflow';
  if (/^wrangler\.(toml|json|jsonc)$/.test(name)) return 'wrangler';
  if (name === 'vercel.json') return 'vercel-json';
  if (rel === join('.vercel', 'project.json') || rel.endsWith(sep + join('.vercel', 'project.json'))) return 'vercel-project';
  if (/^ecosystem\.config\.(c|m)?js$/.test(name)) return 'pm2';
  if (/^(docker-)?compose[\w.-]*\.ya?ml$/.test(name)) return 'compose';
  if (name === 'fly.toml') return 'fly';
  if (name === 'Procfile') return 'procfile';
  if (name.startsWith('.env')) return 'env';
  return null;
}

/** Sorts one repo-relative path into a claim or truth source, or null when it is neither. */
export function classifyPath(repo: RepoInfo, rel: string, realPath: string): SourceFile | null {
  const path = join(repo.path, rel);
  const base = { path, realPath, repo: repo.name, scope: 'repo' as const };
  const name = basename(rel);
  const parts = rel.split(sep);
  if (parts[0] === '.cursor' && parts[1] === 'rules' && parts.length === 3) {
    return { ...base, kind: 'claim', format: 'markdown', agent: 'cursor' };
  }
  if (rel === join('.github', 'copilot-instructions.md')) {
    return { ...base, kind: 'claim', format: 'markdown', agent: 'copilot' };
  }
  if (name.endsWith('.md') && !HISTORY_DOCS.has(name)) {
    return { ...base, kind: 'claim', format: 'markdown', agent: AGENT_FILES[name] ?? null };
  }
  const format = truthFormat(rel);
  return format ? { ...base, kind: 'truth', format, agent: null } : null;
}

/** Gitignored truth stays in scope: .env files (names only) and .vercel/ are ignored by design. */
function keptDespiteIgnore(name: string, isDir: boolean): boolean {
  return isDir ? name === '.vercel' : name.startsWith('.env');
}

/**
 * The paths a sync-agent-docs store in `dir` writes itself (sync-agent-docs.json, store/ and its views), which
 * are never read back as claims. A sync-agent-docs.json without a store/ folder beside it is not a store.
 */
async function storeOwned(dir: string, entries: Dirent[], skipped: SkippedFile[]): Promise<string[]> {
  if (!entries.some((e) => e.name === 'sync-agent-docs.json' && e.isFile()) || !entries.some((e) => e.name === 'store' && e.isDirectory())) return [];
  const config = join(dir, 'sync-agent-docs.json');
  const defaults = [config, join(dir, 'store'), ...Object.values(DEFAULT_VIEWS).map((v) => join(dir, v))];
  const note = (why: string) => skipped.push({ path: config, reason: 'unreadable', note: `store config ${why}; the default views (${Object.values(DEFAULT_VIEWS).join(', ')}) are left out instead` });
  try {
    const parsed: unknown = JSON.parse(await readFile(config, 'utf8'));
    const views = parsed !== null && typeof parsed === 'object' && 'views' in parsed ? parsed.views : undefined;
    if (views !== undefined && (views === null || typeof views !== 'object')) {
      note('has views that are not an object');
      return defaults;
    }
    const given = (views ?? {}) as Record<string, unknown>;
    const bad: string[] = [];
    const owned: string[] = [];
    for (const k of Object.keys(DEFAULT_VIEWS) as (keyof TruthConfig['views'])[]) {
      const at = given[k] === undefined ? null : await insideStore(dir, given[k]);
      if (given[k] !== undefined && at === null) bad.push(k);
      owned.push(at ?? join(dir, DEFAULT_VIEWS[k]));
    }
    if (bad.length) note(`names views ${bad.join(', ')} that are not a path inside ${dir}`);
    return [config, join(dir, 'store'), ...owned];
  } catch (err) {
    note(`could not be read (${(err as Error).message})`);
    return defaults;
  }
}

async function collect(repo: RepoInfo, dir: string, ig: Ignore, out: SourceFile[], skipped: SkippedFile[], root: string | null, owned: Set<string> = new Set()): Promise<void> {
  const entries = await listDir(dir, skipped);
  if (!entries) return;
  if (dir !== repo.path && entries.some((e) => e.name === '.git')) return; // a nested repo is scanned on its own
  for (const p of await storeOwned(dir, entries, skipped)) owned.add(p);
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = relative(repo.path, abs);
    if (owned.has(abs)) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || isTestData(e.name, dir === repo.path)) continue;
      if (ig.ignores(rel + '/') && !keptDespiteIgnore(e.name, true)) continue;
      await collect(repo, abs, ig, out, skipped, root, owned);
    } else if (e.isFile() || e.isSymbolicLink()) {
      if (ig.ignores(rel) && !keptDespiteIgnore(e.name, false)) continue;
      const real = await realpath(abs).catch(() => abs);
      // A link out of the scanned folder (`notes.md -> ~/.netrc`) would read a file the scan promises not to.
      if (root !== null && e.isSymbolicLink() && real !== root && !real.startsWith(`${root}${sep}`)) {
        skipped.push({ path: abs, reason: 'unreadable', note: 'links outside the scanned folder' });
        continue;
      }
      const source = classifyPath(repo, rel, real);
      if (source) out.push(source);
    }
  }
}

/**
 * Drops what git ignores by rules the root .gitignore does not hold. A folder that is not a git repo keeps
 * the root .gitignore rules alone; any other git failure stops the scan, since ignored files would be read.
 */
async function dropGitIgnored(repo: RepoInfo, files: SourceFile[]): Promise<SourceFile[]> {
  if (!(await toplevelOf(repo.path))) return files;
  const ignored = await ignoredPaths(repo.path, files.map((f) => relative(repo.path, f.path)), 'scan');
  return files.filter((f) => {
    const rel = relative(repo.path, f.path);
    return !ignored.has(rel) || keptDespiteIgnore(basename(rel), false) || rel.split(sep).includes('.vercel');
  });
}

/**
 * Every claim (docs, agent files) and truth (config) source in one repo, in path order. With `root`
 * (a real path), a symlink that resolves outside it is skipped.
 */
export async function classifySources(repo: RepoInfo, skipped: SkippedFile[] = [], root: string | null = null): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  await collect(repo, repo.path, await loadIgnore(repo.path, skipped), out, skipped, root);
  const kept = await dropGitIgnored(repo, out);
  return kept.sort((a, b) => a.path.localeCompare(b.path));
}

/** Reads a file as UTF-8 text, or says why it was skipped. Never throws. */
export async function readTextSafe(path: string): Promise<{ text: string } | { skipped: SkippedFile }> {
  try {
    // stat before open: opening a FIFO would block, and a device has no real size.
    if (!(await stat(path)).isFile()) return { skipped: { path, reason: 'unreadable', note: 'not a regular file' } };
    const handle = await open(path, 'r');
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    try {
      // Bounded read: the file can grow between stat and read.
      while (size < buf.length) {
        const { bytesRead } = await handle.read(buf, size, buf.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
    } finally {
      await handle.close();
    }
    if (size > MAX_FILE_BYTES) return { skipped: { path, reason: 'too-large' } };
    const bytes = buf.subarray(0, size);
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { skipped: { path, reason: 'binary' } };
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return { skipped: { path, reason: 'not-utf8' } };
    }
  } catch (err) {
    return { skipped: { path, reason: 'unreadable', note: (err as NodeJS.ErrnoException).code ?? (err as Error).message } };
  }
}

/** One source per real file; when a machine file is a symlink into a repo, the repo copy wins. */
export function dedupeByRealPath(files: SourceFile[]): SourceFile[] {
  const byReal = new Map<string, SourceFile>();
  for (const f of files) {
    const kept = byReal.get(f.realPath);
    if (!kept || (kept.scope === 'machine' && f.scope === 'repo')) byReal.set(f.realPath, f);
  }
  return [...byReal.values()];
}
