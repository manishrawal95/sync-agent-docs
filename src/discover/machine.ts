import { execFile } from 'node:child_process';
import { access, constants, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { CURSOR_RULE } from './sources.js';
import { corpusTokens } from '../truth/formats/corpus-only.js';
import type { AgentFormat, SkippedFile, SourceFile, SourceFormat, SourceKind } from '../types.js';
import { codeOf, nextStep } from '../paths.js';

const run = promisify(execFile);

export interface MachinePass {
  sources: SourceFile[];
  /** Every machine-level file (and `crontab -l`) that the scan opens, for the report's first screen. */
  read: string[];
  skipped: SkippedFile[];
  /** Tokens from `crontab -l`, which has no file to cite. */
  corpus: string[];
}

interface Candidate { path: string; kind: SourceKind; format: SourceFormat; agent: AgentFormat | null }

interface ListOptions {
  dirsOnly?: boolean;
  /** Also list matching files in subfolders. Links are not followed. A subfolder that cannot be read is reported to `skipped`, not thrown. */
  deep?: SkippedFile[];
}

async function list(dir: string, pattern: RegExp, opts: ListOptions = {}, nested = false): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const here = entries
      .filter((e) => pattern.test(e.name) && (opts.deep ? !e.isDirectory() : !opts.dirsOnly || e.isDirectory() || e.isSymbolicLink()))
      .map((e) => join(dir, e.name));
    const below = opts.deep ? await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => list(join(dir, e.name), pattern, opts, true))) : [];
    return [...here, ...below.flat()].sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return [];
    if (nested && opts.deep && (code === 'EACCES' || code === 'EPERM')) {
      opts.deep.push({ path: dir, reason: 'unreadable', note: `${code}: this subfolder could not be listed, so rules inside it were not read. Fix its permissions to include them` });
      return [];
    }
    throw new Error(`machine pass: could not list ${dir} (${codeOf(err)}). ${nextStep(err)} Or pass --repos-only.`, { cause: err });
  }
}

type Make = (path: string) => Candidate;
const claim = (agent: AgentFormat | null): Make => (path) => ({ path, kind: 'claim', format: 'markdown', agent });
const truth = (format: SourceFormat): Make => (path) => ({ path, kind: 'truth', format, agent: null });

/** Machine files at fixed places under home. */
const FIXED: { path: string[]; make: Make }[] = [
  { path: ['.claude', 'CLAUDE.md'], make: claim('claude') },
  { path: ['.codex', 'AGENTS.md'], make: claim('agents') },
  { path: ['.gemini', 'GEMINI.md'], make: claim('gemini') },
  { path: ['.ssh', 'config'], make: truth('ssh-config') },
  ...['.zshrc', '.bashrc', '.profile'].map((n) => ({ path: [n], make: truth('shell-rc') })),
  { path: ['.config', 'gh', 'hosts.yml'], make: truth('gh-hosts') },
  { path: ['.gitconfig'], make: truth('git-config') },
];

/** Machine files under a folder of home that match its pattern: direct children, or any depth when `deep`. */
const LISTED: { dir: string[]; pattern: RegExp; deep: boolean; make: Make }[] = [
  { dir: ['.cursor', 'rules'], pattern: CURSOR_RULE, deep: true, make: claim('cursor') },
  { dir: ['Library', 'LaunchAgents'], pattern: /\.plist$/, deep: false, make: truth('launch-agent') },
  { dir: ['.config', 'systemd', 'user'], pattern: /\.(service|timer)$/, deep: false, make: truth('launch-agent') },
];

/** Claude memory: ~/.claude/projects/<project>/memory/*.md. */
const MEMORY_ROOT = ['.claude', 'projects'];
const MEMORY_FILE = /\.md$/;
// MEMORY.md loads every session; other memory files load on recall, so they are not agent files.
const memoryFile = (file: string): Candidate => claim(file.endsWith('/MEMORY.md') ? 'claude' : null)(file);

async function candidates(home: string, skipped: SkippedFile[] = []): Promise<Candidate[]> {
  const out: Candidate[] = FIXED.map((f) => f.make(join(home, ...f.path)));
  for (const project of await list(join(home, ...MEMORY_ROOT), /./, { dirsOnly: true })) {
    for (const file of await list(join(project, 'memory'), MEMORY_FILE)) out.push(memoryFile(file));
  }
  for (const l of LISTED) out.push(...(await list(join(home, ...l.dir), l.pattern, l.deep ? { deep: skipped } : {})).map(l.make));
  return out;
}

const isBelow = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Whether `path` is a machine file the machine pass reads or would read, decided by place and name, so a deleted file still counts. A path under a symlinked subfolder of a deep folder counts here, though `candidates` does not follow the link. */
export function isMachinePath(home: string, path: string): boolean {
  if (FIXED.some((f) => path === join(home, ...f.path))) return true;
  if (LISTED.some((l) => l.pattern.test(basename(path)) && (l.deep ? isBelow(join(home, ...l.dir), path) : dirname(path) === join(home, ...l.dir)))) return true;
  const memory = dirname(path);
  return dirname(memory) !== memory && basename(memory) === 'memory' && dirname(dirname(memory)) === join(home, ...MEMORY_ROOT) && MEMORY_FILE.test(basename(path));
}

/** The machine-level agent and memory files a plan may propose edits to. */
export async function machineClaimPaths(home: string): Promise<string[]> {
  return (await candidates(home)).filter((c) => c.kind === 'claim').map((c) => c.path);
}

async function crontab(command: string): Promise<{ corpus: string[] } | { skipped: SkippedFile }> {
  try {
    const { stdout } = await run(command, ['-l'], { maxBuffer: 512 * 1024 });
    return { corpus: stdout.split('\n').filter((l) => !l.trim().startsWith('#')).flatMap(corpusTokens) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const why = e.code === 'ENOENT' ? `${command} is not installed` : /no crontab/i.test(e.stderr ?? '') ? 'no crontab for this user' : `${command} -l failed`;
    return { skipped: { path: 'crontab -l', reason: 'unreadable', note: `crontab: ${why}; cron jobs were not checked` } };
  }
}

/**
 * Machine-level agent config and truth under `home`. Never opens ~/.claude/settings*.json
 * or anything in ~/.ssh but `config`.
 */
export async function machineSources(home: string, opts: { crontabCommand?: string } = {}): Promise<MachinePass> {
  const pass: MachinePass = { sources: [], read: [], skipped: [], corpus: [] };
  for (const c of await candidates(home, pass.skipped)) {
    try {
      if (!(await stat(c.path)).isFile()) continue;
      await access(c.path, constants.R_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') pass.skipped.push({ path: c.path, reason: 'unreadable', note: code ?? 'access check failed' });
      continue;
    }
    pass.sources.push({ ...c, realPath: await realpath(c.path), repo: null, scope: 'machine' });
    pass.read.push(c.path);
  }
  const cron = await crontab(opts.crontabCommand ?? 'crontab');
  if ('skipped' in cron) pass.skipped.push(cron.skipped);
  else {
    pass.corpus = cron.corpus;
    pass.read.push('crontab -l');
  }
  return pass;
}
