import { execFile } from 'node:child_process';
import { access, constants, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
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

async function list(dir: string, pattern: RegExp): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => pattern.test(n)).sort().map((n) => join(dir, n));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`machine pass: could not list ${dir} (${(err as Error).message}). Check its permissions or pass --repos-only.`, { cause: err });
  }
}

async function candidates(home: string): Promise<Candidate[]> {
  const claim = (path: string, agent: AgentFormat | null): Candidate => ({ path, kind: 'claim', format: 'markdown', agent });
  const truth = (path: string, format: SourceFormat): Candidate => ({ path, kind: 'truth', format, agent: null });
  const memory: Candidate[] = [];
  for (const project of await list(join(home, '.claude', 'projects'), /./)) {
    // MEMORY.md loads every session; other memory files load on recall, so they are not agent files.
    for (const file of await list(join(project, 'memory'), /\.md$/)) memory.push(claim(file, file.endsWith('/MEMORY.md') ? 'claude' : null));
  }
  return [
    claim(join(home, '.claude', 'CLAUDE.md'), 'claude'),
    ...memory,
    claim(join(home, '.codex', 'AGENTS.md'), 'agents'),
    claim(join(home, '.gemini', 'GEMINI.md'), 'gemini'),
    ...(await list(join(home, '.cursor', 'rules'), /./)).map((p) => claim(p, 'cursor')),
    truth(join(home, '.ssh', 'config'), 'ssh-config'),
    ...(await list(join(home, 'Library', 'LaunchAgents'), /\.plist$/)).map((p) => truth(p, 'launch-agent')),
    ...(await list(join(home, '.config', 'systemd', 'user'), /\.(service|timer)$/)).map((p) => truth(p, 'launch-agent')),
    ...['.zshrc', '.bashrc', '.profile'].map((n) => truth(join(home, n), 'shell-rc')),
    truth(join(home, '.config', 'gh', 'hosts.yml'), 'gh-hosts'),
    truth(join(home, '.gitconfig'), 'git-config'),
  ];
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
