import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { lineHash } from '../plan/lines.js';
import type { Edit } from '../plan/types.js';
import { writeTextAtomic } from '../store/io.js';

const SECRET_NOTE = (path: string, line: number): string => `# Line ${line} of ${path} may hold a secret: rotate it, then delete that line by hand. This patch leaves it alone.`;

async function readLines(path: string): Promise<{ real: string; text: string }> {
  try {
    const real = await realpath(path);
    return { real, text: await readFile(real, 'utf8') };
  } catch (err) {
    throw new Error(`apply: could not read ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Run sync-agent-docs plan again.`, { cause: err });
  }
}

/** The file's lines without their endings: a CRLF file hashes the same as its LF twin. */
const split = (text: string): string[] => {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/** Whether `lines` already hold `line`, ignoring the spaces around either: the one test for an append that would repeat a line. */
const hasLine = (lines: readonly string[], line: string): boolean => lines.some((l) => l.trim() === line.trim());

/** Refuses an edit missing the field its op needs, or one whose pinned line changed since the plan. `shown` is the path as the user knows it. */
export function checkEdits(text: string, edits: Edit[], shown: string): void {
  const lines = split(text);
  for (const e of edits) {
    const missing = e.op !== 'append' && !e.lineHash ? 'lineHash' : e.op !== 'remove' && e.after === undefined ? 'after' : null;
    if (missing) throw new Error(`apply: ${shown} line ${e.line}: the ${e.op} edit in plan.json has no ${missing}, so nothing was written; run sync-agent-docs plan again.`);
    if (e.op === 'append') continue;
    const now = lines[e.line - 1];
    if (now === undefined || lineHash(now) !== e.lineHash) {
      throw new Error(`apply: ${shown} line ${e.line} changed since the plan, so nothing was written; run sync-agent-docs plan again.`);
    }
  }
}

/**
 * The text after the edits: removes and replaces by line number, then appends in order. Each kept
 * line keeps its own ending, so a file mixing CRLF and LF changes only where it was edited; an
 * appended line takes CRLF when the file uses it. Whether the file ended with a newline is kept.
 */
export function editText(text: string, edits: Edit[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = split(text);
  const ends = [...text.matchAll(/\r?\n/g)].map((m) => m[0]);
  const byLine = new Map(edits.filter((e) => e.op !== 'append').map((e) => [e.line, e]));
  const out: { line: string; end: string }[] = [];
  lines.forEach((line, n) => {
    const e = byLine.get(n + 1);
    if (!e) out.push({ line, end: ends[n] ?? eol });
    else if (e.op === 'replace') out.push({ line: e.after ?? line, end: ends[n] ?? eol });
  });
  for (const e of edits) if (e.op === 'append' && e.after !== undefined && !hasLine(out.map((l) => l.line), e.after)) out.push({ line: e.after, end: eol });
  const last = out.at(-1);
  if (!last) return '';
  if (text !== '' && !text.endsWith('\n')) last.end = '';
  return out.map((l) => l.line + l.end).join('');
}

/** Checks the hashes, then writes the edited text over the real file through a temp file, keeping its mode. */
export async function applyEdits(path: string, edits: Edit[]): Promise<string> {
  const { real, text } = await readLines(path);
  checkEdits(text, edits, path);
  const { mode } = await stat(real);
  await writeTextAtomic(real, editText(text, edits), mode & 0o7777);
  return real;
}

/** `s` as one POSIX shell word: single-quoted, with each `'` inside written as `'\\''`. */
export const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * A zero-context unified diff of the edits, for a file sync-agent-docs may not change itself. A secret
 * edit becomes an instruction line and is left out of the diff, so the patch never holds it.
 */
export function manualPatch(path: string, text: string, edits: Edit[], why: string): string {
  const lines = split(text);
  const name = basename(path);
  const head = [
    `# sync-agent-docs could not change ${path}: ${why}.`,
    `# Review this patch, then apply it with: cd ${shellQuote(dirname(path))} && patch -p0 < <this file>`,
    ...edits.filter((e) => e.secret).map((e) => SECRET_NOTE(path, e.line)),
  ];
  const edited = edits.filter((e) => !e.secret && e.op !== 'append');
  const kept = lines.flatMap((l, n) => {
    const e = edited.find((x) => x.line === n + 1);
    return !e ? [l.trim()] : e.op === 'replace' && e.after !== undefined ? [e.after.trim()] : [];
  });
  const appends: Edit[] = [];
  for (const e of edits) {
    if (e.secret || e.op !== 'append' || e.after === undefined || hasLine(kept, e.after)) continue;
    kept.push(e.after.trim());
    appends.push(e);
  }
  const plain = [...edited, ...appends];
  if (!plain.length) return `${head.join('\n')}\n`;
  const hunks: string[] = [];
  let delta = 0;
  for (const e of [...edited].sort((a, b) => a.line - b.line)) {
    const old = lines[e.line - 1] ?? '';
    if (e.op === 'remove') {
      hunks.push(`@@ -${e.line},1 +${e.line + delta - 1},0 @@`, `-${old}`);
      delta -= 1;
    } else {
      hunks.push(`@@ -${e.line},1 +${e.line + delta},1 @@`, `-${old}`, `+${e.after ?? old}`);
    }
  }
  if (appends.length) hunks.push(`@@ -${lines.length},0 +${lines.length + delta + 1},${appends.length} @@`, ...appends.map((e) => `+${e.after}`));
  return `${[...head, `--- ${name}`, `+++ ${name}`, ...hunks].join('\n')}\n`;
}
