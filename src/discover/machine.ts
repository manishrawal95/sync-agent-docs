import { execFile } from 'node:child_process';
import { access, constants, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { corpusTokens } from '../truth/formats/corpus-only.js';
import type { AgentFormat, SkippedFile, SourceFile, SourceFormat, SourceKind } from '../types.js';

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

async function list(dir: string, pattern: RegExp, dirsOnly = false): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => pattern.test(e.name) && (!dirsOnly || e.isDirectory() || e.isSymbolicLink())).map((e) => join(dir, e.name)).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return [];
    throw new Error(`machine pass: could not list ${dir} (${(err as Error).message}). Check its permissions or pass --repos-only.`, { cause: err });
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

/** Machine files that are direct children of a folder under home and match its pattern. */
const LISTED: { dir: string[]; pattern: RegExp; make: Make }[] = [
  { dir: ['.cursor', 'rules'], pattern: /./, make: claim('cursor') },
  { dir: ['Library', 'LaunchAgents'], pattern: /\.plist$/, make: truth('launch-agent') },
  { dir: ['.config', 'systemd', 'user'], pattern: /\.(service|timer)$/, make: truth('launch-agent') },
];

/** Claude memory: ~/.claude/projects/<project>/memory/*.md. */
const MEMORY_ROOT = ['.claude', 'projects'];
const MEMORY_FILE = /\.md$/;
// MEMORY.md loads every session; other memory files load on recall, so they are not agent files.
const memoryFile = (file: string): Candidate => claim(file.endsWith('/MEMORY.md') ? 'claude' : null)(file);

async function candidates(home: string): Promise<Candidate[]> {
  const out: Candidate[] = FIXED.map((f) => f.make(join(home, ...f.path)));
  for (const project of await list(join(home, ...MEMORY_ROOT), /./, true)) {
    for (const file of await list(join(project, 'memory'), MEMORY_FILE)) out.push(memoryFile(file));
  }
  for (const l of LISTED) out.push(...(await list(join(home, ...l.dir), l.pattern)).map(l.make));
  return out;
}

/** Whether `path` is a machine file the machine pass reads or would read, decided by place and name, so a deleted file still counts. */
export function isMachinePath(home: string, path: string): boolean {
  if (FIXED.some((f) => path === join(home, ...f.path))) return true;
  if (LISTED.some((l) => dirname(path) === join(home, ...l.dir) && l.pattern.test(basename(path)))) return true;
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
  for (const c of await candidates(home)) {
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
