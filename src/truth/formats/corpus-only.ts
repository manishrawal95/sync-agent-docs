import type { FormatParser, Parsed } from '../parsed.js';
import { streamLines } from '../stream.js';

const PATH = /(?:^|[\s"'=>])((?:\/|~\/)[\w.@%+~/-]+)/g;
const ASSIGNED_NAME = /(?:^|\s)([A-Z][A-Z0-9_]{2,})=/g;

/** Paths and assigned variable names in a line; values after `=` are never kept. */
export function corpusTokens(line: string): string[] {
  const tokens: string[] = [];
  for (const m of line.matchAll(ASSIGNED_NAME)) if (m[1]) tokens.push(m[1]);
  const withoutValues = line.replace(/=\S*/g, '= ');
  for (const m of withoutValues.matchAll(PATH)) if (m[1]) tokens.push(m[1].replace(/[./]+$/, ''));
  return tokens;
}

/** LaunchAgents and systemd user units: corpus only, for stale checks. */
export const parseLaunchAgent: FormatParser = (text) => ({ corpus: text.split('\n').flatMap(corpusTokens) });

/** ~/.gitconfig: paths only, streamed. */
export async function parseGitConfig(path: string): Promise<Parsed> {
  const corpus: string[] = [];
  await streamLines(path, (line) => corpus.push(...corpusTokens(line)));
  return { corpus };
}

/** ~/.config/gh/hosts.yml: top-level keys are host names; token lines are dropped as they stream. */
export async function parseGhHosts(path: string): Promise<Parsed> {
  const corpus: string[] = [];
  await streamLines(path, (line) => {
    const m = /^([A-Za-z0-9.-]+):\s*$/.exec(line);
    if (m?.[1]) corpus.push(m[1]);
  });
  return { corpus };
}
