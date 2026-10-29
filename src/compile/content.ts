import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { lineHasSecret } from '../claims/secrets.js';
import type { Store } from '../store/types.js';
import type { AgentFormat } from '../types.js';
import { byFact, code, factsTable } from '../views/render.js';
import { ABSENT, codeOf, nextStep } from '../paths.js';

export const HEADING = '## Facts from the truth store';
export const INTRO = 'Compiled by sync-agent-docs from the truth store. Do not edit inside these markers: change the store and run sync-agent-docs compile.';

export const NO_FACTS = 'No facts recorded for this repo yet.';
export const CARD_NOTE = "This repo's own project facts are in its project card, which this file imports outside this block.";

/**
 * `outside` is the file's text outside the compiled block; `card` is the project card import, if the store has one;
 * `project` is the repo's own project entity id; `shared` is true when the file is also another agent file on disk.
 */
export interface FormatInput { repoPath: string; store: Store; entityIds: string[]; outside: string; card: string | null; project: string; shared: boolean }

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
  return sections.join('\n\n') || NO_FACTS;
}

/** One list marker and the space after it; a fence may open right after it (`- ```). */
const LIST_MARKER = /^(?:[-*+]|\d+\.) /;

/** The trimmed lines of `text` outside code fences. A fence closes only on its own character, at least as long as the opener, with nothing after it (CommonMark). */
export function unfencedLines(text: string): string[] {
  const lines: string[] = [];
  let opener: { char: string; length: number } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const run = /^(`{3,}|~{3,})(.*)$/.exec(opener ? line : line.replace(LIST_MARKER, ''));
    const char = run?.[1]?.[0] ?? '';
    const length = run?.[1]?.length ?? 0;
    if (opener) {
      if (run && char === opener.char && length >= opener.length && run[2]?.trim() === '') opener = null;
    } else if (run && !(char === '`' && run[2]?.includes('`'))) {
      opener = { char, length };
    } else {
      lines.push(line);
    }
  }
  return lines;
}

/** A whole line that is one `@path` import: Claude Code ends the path at whitespace, so a path with a space is not one. */
export const IMPORT_LINE = /^@(\S+)$/;

/** The `@path` lines of a CLAUDE.md that Claude Code loads: whole-line imports outside code fences. */
export function importLines(text: string): string[] {
  return unfencedLines(text).flatMap((line) => IMPORT_LINE.exec(line)?.[1] ?? []);
}

/** Whether `outside` already imports the project `card` (an `@path`) on a line of its own, outside any code fence. */
export function importsCard(outside: string, card: string | null): boolean {
  return card !== null && unfencedLines(outside).includes(card);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (ABSENT.has(codeOf(err))) return false;
    throw new Error(`compile: could not check ${path} (${codeOf(err)}). ${nextStep(err)}`, { cause: err });
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
