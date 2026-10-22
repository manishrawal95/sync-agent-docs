import { homedir } from 'node:os';
import { relative } from 'node:path';
import pc from 'picocolors';
import { entityName } from '../compare/findings.js';
import type { AgentFormat, Finding, FindingType, Location, ScanResult, ValueGroup } from '../types.js';

export const AGENT_LABELS: Record<AgentFormat, string> = {
  claude: 'CLAUDE.md', agents: 'AGENTS.md', gemini: 'GEMINI.md', cursor: '.cursor/rules', copilot: 'copilot-instructions.md',
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Doc text and file names can carry ANSI escapes; drop C0/C1 controls (tab and newline kept) before printing. */
export const printable = (s: string): string => s.replace(CONTROL, '');

/** Repo files relative to the scan root, home files as `~/...`, anything else as is. */
export function displayPath(path: string, root: string): string {
  if (path === root || path.startsWith(`${root}/`)) return printable(relative(root, path) || '.');
  const home = homedir();
  return printable(path.startsWith(`${home}/`) ? `~/${relative(home, path)}` : path);
}

function files(at: Location[], root: string): string {
  return [...new Set(at.map((a) => displayPath(a.path, root)))].join(', ');
}

const valueLine = (g: ValueGroup, root: string): string => `${printable(g.value)} (${files(g.at, root)})`;

/** The first finding of a type, as one or more lines; every value comes from the result. */
function example(f: Finding, all: Finding[], root: string): string[] {
  const name = printable(f.entityId ? `${entityName(f.entityId)} ${f.attribute ?? ''}` : (f.attribute ?? ''));
  const values = (f.values ?? []).map((g) => ({ ...g, value: printable(g.value) }));
  switch (f.type) {
    case 'conflict':
    case 'possible-conflict': {
      const lead = `${name}: `;
      return values.map((g, i) => (i === 0 ? lead : ' '.repeat(lead.length)) + valueLine(g, root));
    }
    case 'global-local': {
      const [mine, ...repo] = values;
      return [`${files(mine?.at ?? [], root)} says ${name} ${mine?.value ?? ''}; the repo says ${repo.map((g) => g.value).join(', ')}`];
    }
    case 'stale':
      return [`${files(f.at ?? [], root)} names ${f.attribute ?? ''} ${values[0]?.value ?? ''}, not in any config or ssh entry`];
    case 'duplicated':
      return [`${name} ${values[0]?.value ?? ''} repeated in ${files(f.at ?? [], root)}`];
    case 'secret': {
      const at = all.flatMap((s) => s.at ?? []);
      const shown = at.slice(0, 3).map((a) => `${displayPath(a.path, root)}:${a.line}`).join(', ');
      return [`${shown}${at.length > 3 ? ` + ${at.length - 3} more` : ''}  (${at.length === 1 ? 'value' : 'values'} hidden)`];
    }
  }
}

const BLOCKS: { type: FindingType; icon: string; label: (n: number) => string; color: 'red' | 'yellow' }[] = [
  { type: 'conflict', icon: '✖', label: (n) => plural(n, 'conflict'), color: 'red' },
  { type: 'global-local', icon: '✖', label: (n) => `${n} global vs repo`, color: 'red' },
  { type: 'possible-conflict', icon: '?', label: (n) => plural(n, 'possible conflict'), color: 'yellow' },
  { type: 'stale', icon: '⚠', label: (n) => `${n} stale`, color: 'yellow' },
  { type: 'secret', icon: '⚠', label: (n) => `${plural(n, 'secret')} in plain text`, color: 'yellow' },
];

/** The first thing to fix, from what was found: conflicts, then plain-text secrets, then stale references. */
function nextStep(found: Finding[]): string | null {
  const conflicts = found.filter((f) => f.type === 'conflict' || f.type === 'global-local' || f.type === 'possible-conflict').length;
  const secrets = found.filter((f) => f.type === 'secret').length;
  const stale = found.filter((f) => f.type === 'stale').length;
  if (conflicts > 0) return `fix the ${conflicts === 1 ? 'conflict' : 'conflicts'} first`;
  if (secrets > 0) return secrets === 1 ? 'move the plain-text secret out of that file first' : 'move the plain-text secrets out of those files first';
  if (stale > 0) return `update or remove the stale ${stale === 1 ? 'reference' : 'references'}`;
  return null;
}

export function renderTerminal(result: ScanResult, opts: { color: boolean }): string {
  const c = pc.createColors(opts.color);
  const root = result.root;
  const out: string[] = ['', `  Scanning ${displayPath(root, '\0')} (read-only, nothing leaves this machine)`];
  const read = result.machineFilesRead;
  if (read.length > 0) {
    const names = read.slice(0, 3).map((p) => (p === 'crontab -l' ? 'crontab' : displayPath(p, root)));
    out.push(c.dim(`  Also read: ${names.join(', ')}${read.length > 3 ? ', ...' : ''} (${plural(read.length, 'file')})`));
  }
  const agentFiles = Object.values(result.agentFileCounts).reduce((a, b) => a + b, 0);
  const byAgent = (Object.entries(result.agentFileCounts) as [AgentFormat, number][]).filter(([, n]) => n > 0).map(([a, n]) => `${AGENT_LABELS[a]} ×${n}`);
  out.push('', `  ${plural(result.repos.length, 'repo')}   ${plural(agentFiles, 'agent instruction file')}   ${byAgent.join('  ')}`.trimEnd());
  out.push(`  ${plural(result.facts.length, 'infra fact')} found`, '');

  const counted = result.findings.filter((f) => f.type !== 'duplicated');
  if (counted.length === 0) out.push('  No conflicts, stale references or plain-text secrets found');
  const shown = BLOCKS.map((b) => ({ ...b, found: result.findings.filter((f) => f.type === b.type) })).filter((b) => b.found.length > 0);
  const pct = Math.round((100 * result.duplicatedTokens) / Math.max(result.agentTokens, 1));
  const dupLabel = `${pct < 1 ? '<1' : pct}% duplicated`;
  // One column for every label shown, so the examples line up.
  const width = Math.max(14, ...shown.map((b) => b.label(b.found.length).length), result.duplicatedTokens > 0 ? dupLabel.length : 0) + 2;
  const pad = ' '.repeat(4 + width + 1);
  for (const { found, ...block } of shown) {
    const first = found[0];
    if (!first) continue;
    const lines = example(first, found, root);
    out.push(`  ${c[block.color](block.icon)} ${block.label(found.length).padEnd(width)} ${lines[0] ?? ''}`);
    for (const line of lines.slice(1)) out.push(pad + line);
    if (found.length > 1 && block.type !== 'secret') out.push(c.dim(`${pad}+ ${found.length - 1} more`));
  }
  if (result.duplicatedTokens > 0) {
    out.push(`  ${c.cyan('◐')} ${dupLabel.padEnd(width)} ~${plural(result.duplicatedTokens, 'token')} your agents reload every session`);
  }
  // `crontab -l` is not a file; its note (often just "no crontab") stays in scan.json.
  const worktrees = result.skipped.filter((s) => s.reason === 'linked-worktree').length;
  const skippedFiles = result.skipped.filter((s) => s.path !== 'crontab -l' && s.reason !== 'linked-worktree').length;
  if (skippedFiles > 0) out.push(c.dim(`  Skipped ${plural(skippedFiles, 'file')} (too large, binary or unreadable); the list is in .sync-agent-docs/scan.json`));
  if (worktrees > 0) out.push(c.dim(`  Skipped ${plural(worktrees, 'linked worktree')} (${worktrees === 1 ? 'its main checkout is' : 'their main checkouts are'} scanned)`));

  out.push('', `  Context health: ${c.bold(`${result.score}/100`)}`, '');
  const next = nextStep(counted);
  if (next) out.push(`  Next: ${next}; every finding with its file and line is in the report.`);
  out.push('  Report: .sync-agent-docs/report.html   Share card: .sync-agent-docs/score.svg', '');
  return out.join('\n');
}
