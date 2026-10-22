import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { lineHasSecret } from '../claims/secrets.js';
import type { Store } from '../store/types.js';
import type { AgentFormat } from '../types.js';
import { byFact, code, factsTable } from '../views/render.js';

export const HEADING = '## Facts from the truth store';
export const INTRO = 'Compiled by sync-agent-docs from the truth store. Do not edit inside these markers: change the store and run sync-agent-docs compile.';

/** `outside` is the file's text outside the compiled block; `card` is the project card import, if the store has one. */
export interface FormatInput { repoPath: string; store: Store; entityIds: string[]; outside: string; card: string | null }

export interface AgentCompiler {
  format: AgentFormat;
  /** Repo-relative path of the file compile writes. */
  file: string;
  /** Whether the repo already uses this format, so compile keeps it current without being told to. */
  present(repoPath: string): Promise<boolean>;
  body(input: FormatInput): string;
  /** Text a new file starts with, before the block. */
  newFilePrefix?: string;
}

/** A value that is or carries a credential never reaches a block, bare or as an assignment. */
const secretValue = (value: string): boolean => lineHasSecret(value) || lineHasSecret(`v=${value}`);

/** One section per entity with facts: the view's facts table, escaped the same way, notes left to the views. */
export function factsBody(store: Store, entityIds: string[]): string {
  const sections: string[] = [];
  for (const id of entityIds) {
    const e = store.entities.find((x) => x.id === id);
    const facts = store.facts.filter((f) => f.entityId === id && !secretValue(f.value)).sort(byFact);
    if (!e || !facts.length) continue;
    sections.push(`### ${code(e.names[0] ?? e.id)} (${e.kind})\n\n${factsTable(facts, '')}`);
  }
  return sections.join('\n\n') || 'No facts recorded for this repo yet.';
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`compile: could not check ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Check its permissions.`, { cause: err });
  }
}

/** A format whose block is the heading, the intro and the facts, present when its file exists. */
export function plainCompiler(format: AgentFormat, file: string, extra: Partial<AgentCompiler> = {}): AgentCompiler {
  return {
    format, file,
    present: (repoPath) => exists(join(repoPath, file)),
    body: (i) => `${HEADING}\n\n${INTRO}\n\n${factsBody(i.store, i.entityIds)}`,
    ...extra,
  };
}
