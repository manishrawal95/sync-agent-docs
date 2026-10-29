import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { openDotDir, writeFresh } from './dotdir.js';
import { extractMentions } from './claims/extract.js';
import { blankCompiled } from './compile/block.js';
import { COMPILED_FILES } from './compile/formats/index.js';
import { blankKeyBlocks, findSecrets } from './claims/secrets.js';
import { computeFindings } from './compare/findings.js';
import { scoreOf } from './compare/score.js';
import { machineSources } from './discover/machine.js';
import { findRepos } from './discover/repos.js';
import { classifySources, dedupeByRealPath, readTextSafe } from './discover/sources.js';
import { mapLimited } from './pool.js';
import { renderHtml } from './report/html.js';
import { renderSvg } from './report/svg.js';
import { linkMentions } from './link/link.js';
import { parseTruth } from './truth/parse.js';
import { AGENT_FORMATS, type AgentFormat, type Finding, type Location, type Mention, type ScanResult, type SkippedFile } from './types.js';
import { codeOf, nextStep } from './paths.js';

export interface ScanOptions {
  home: string;
  reposOnly: boolean;
  now?: Date;
  /** Test seam: the command run as `<cmd> -l` to list cron jobs. */
  crontabCommand?: string;
}

/** Repos classified at once: each runs git, and a run over hundreds of repos must not exhaust processes or file handles. */
const GIT_CONCURRENCY = 8;

/** The whole pipeline, read-only: discover, parse truth, extract and link claims, compare, score. */
export async function collectScan(root: string, opts: ScanOptions): Promise<ScanResult> {
  const skipped: SkippedFile[] = [];
  const repos = await findRepos(root, skipped);
  const realRoot = await realpath(root);
  const repoSources = (await mapLimited(repos, GIT_CONCURRENCY, (r) => classifySources(r, skipped, realRoot))).flat();
  const machine = opts.reposOnly ? null : await machineSources(opts.home, { crontabCommand: opts.crontabCommand });
  const sources = dedupeByRealPath([...repoSources, ...(machine?.sources ?? [])]);
  skipped.push(...(machine?.skipped ?? []));

  const truth = await parseTruth(sources.filter((s) => s.kind === 'truth'), repos);
  skipped.push(...truth.skipped);
  for (const token of machine?.corpus ?? []) truth.corpus.add(token);

  const mentions: Mention[] = [];
  const secrets: Finding[] = [];
  const agentLines: { at: Location; text: string; agent: AgentFormat }[] = [];
  const agentFileCounts = Object.fromEntries(AGENT_FORMATS.map((a) => [a, 0])) as Record<AgentFormat, number>;
  for (const source of sources.filter((s) => s.kind === 'claim')) {
    const read = await readTextSafe(source.path);
    if ('skipped' in read) {
      skipped.push(read.skipped);
      continue;
    }
    // What compile wrote is the store restated: never a claim or a duplicate, though secrets are still looked for.
    // Only a file compile writes, at a repo root, with a matching hash, counts as compile's.
    const compiled = repos.some((r) => r.name === source.repo && COMPILED_FILES.some((f) => join(r.path, f) === source.path));
    const claims = blankKeyBlocks(compiled ? blankCompiled(read.text) : read.text);
    mentions.push(...extractMentions(source, claims));
    secrets.push(...findSecrets(source, read.text));
    if (source.agent) {
      agentFileCounts[source.agent] += 1;
      claims.split('\n').forEach((text, i) => agentLines.push({ at: { path: source.path, line: i + 1 }, text, agent: source.agent as AgentFormat }));
    }
  }

  const facts = [...truth.facts, ...linkMentions(mentions, truth.entities)];
  const { findings, agentTokens, duplicatedTokens, skipped: unchecked } = await computeFindings({ facts, corpus: truth.corpus, secrets, agentLines, home: opts.home, root, repos, reposOnly: opts.reposOnly });
  skipped.push(...unchecked);
  return {
    root, scannedAt: (opts.now ?? new Date()).toISOString(), repos,
    machineFilesRead: machine?.read ?? [], skipped,
    agentFileCounts, entities: truth.entities, facts, findings,
    agentTokens, duplicatedTokens, score: scoreOf(findings, agentTokens, duplicatedTokens),
  };
}

/** Runs the scan and writes `.sync-agent-docs/scan.json` next to a `.gitignore` that ignores the folder itself. */
export async function runScan(root: string, opts: ScanOptions): Promise<ScanResult> {
  await assertFolder(root);
  const result = await collectScan(root, opts);
  const out = await openDotDir(root, 'scan');
  try {
    await writeFresh(out, 'scan.json', `${JSON.stringify(result, null, 2)}\n`);
    await writeFresh(out, 'report.html', renderHtml(result));
    await writeFresh(out, 'score.svg', renderSvg(result));
  } catch (err) {
    throw new Error(`scan: could not write ${out} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Make the folder writable and run the scan again.`, { cause: err });
  }
  return result;
}

/** The path a command was given is missing or not a folder; the message says which and what to pass. */
export class NotAFolderError extends Error {}

/** Throws NotAFolderError unless `root` is an existing folder. */
export async function assertFolder(root: string): Promise<void> {
  const info = await stat(root).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw new Error(`could not open ${root} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
  });
  if (!info) throw new NotAFolderError(`${root} does not exist. Pass the folder that holds your repos.`);
  if (info.isFile()) throw new NotAFolderError(`${root} is a file; pass the folder that holds your repos.`);
  if (!info.isDirectory()) throw new NotAFolderError(`${root} is not a folder; pass the folder that holds your repos.`);
}
