import { blockHash, beginMarker, endMarker, markerLines, readBlocks } from '../views/render.js';

/**
 * The one reader and writer of the compiled block in an agent file. Compile, apply, plan and
 * doctor all go through here; the markers themselves are parsed by the view parser.
 */
export const COMPILED_ID = 'compiled';
const HASH = /^<!-- sync-agent-docs:hash ([0-9a-f]{16}) -->$/;
const hashLine = (hash: string): string => `<!-- sync-agent-docs:hash ${hash} -->`;

/** `recorded` is the hash compile wrote (null when its line is gone); `actual` is the body's hash now. */
export interface CompiledBlock { body: string; recorded: string | null; actual: string }

export function bodyHash(body: string): string {
  return blockHash(body.replaceAll('\r', ''));
}

/** The compiled block in `text`, or null when there is none. Broken markers throw, naming the block. */
export function readCompiledBlock(text: string): CompiledBlock | null {
  const raw = readBlocks(text)[COMPILED_ID];
  if (raw === undefined) return null;
  const lines = raw.replaceAll('\r', '').split('\n');
  const m = HASH.exec(lines[0]?.trim() ?? '');
  const body = (m ? lines.slice(1) : lines).join('\n');
  return { body, recorded: m?.[1] ?? null, actual: bodyHash(body) };
}

/**
 * `text` with its compiled block set to `body`: replaced in place, or appended after one blank line.
 * Text outside the markers is kept, and the file's CRLF endings are kept. `prefix` starts a new file.
 */
export function writeCompiledBlock(text: string | null, body: string, prefix = ''): string {
  const cr = text?.includes('\r\n') ? '\r' : '';
  const block = [beginMarker(COMPILED_ID), hashLine(bodyHash(body)), ...body.split('\n'), endMarker(COMPILED_ID)];
  // A blank file is as good as none: it gets the prefix, such as a Cursor rule's frontmatter.
  if (text === null || text.trim() === '') return `${prefix}${block.join('\n')}\n`;
  if (readCompiledBlock(text) === null) {
    const kept = text.replace(/(\r?\n)+$/, '');
    const eol = `${cr}\n`;
    return `${kept}${kept ? eol + eol : ''}${block.join(eol)}${eol}`;
  }
  const lines = text.split('\n');
  const marks = markerLines(lines);
  const at = (kind: 'begin' | 'end'): number => marks.findIndex((m) => m?.kind === kind && m.id === COMPILED_ID);
  const start = at('begin');
  const stop = at('end');
  const tail = lines[stop]?.endsWith('\r') ? '\r' : '';
  const replacement = block.map((l, i) => l + (i === block.length - 1 ? tail : cr));
  return [...lines.slice(0, start), ...replacement, ...lines.slice(stop + 1)].join('\n');
}

/** `text` without its compiled block, for checks that must ignore what compile wrote. */
export function outsideCompiled(text: string): string {
  const out: string[] = [];
  let inside = false;
  const lines = text.split('\n');
  const marks = markerLines(lines);
  for (const [i, line] of lines.entries()) {
    const m = marks[i];
    if (m?.id === COMPILED_ID) inside = m.kind === 'begin';
    else if (!inside) out.push(line);
  }
  return out.join('\n');
}

/**
 * `text` with every line of its compiled block, markers included, blanked and the line count kept,
 * so scan reads no claims there. Broken markers or a hash that does not match the body mean no
 * block compile wrote: the text comes back as is.
 */
export function blankCompiled(text: string): string {
  try {
    const block = readCompiledBlock(text);
    if (block === null || block.recorded !== block.actual) return text;
  } catch {
    // Broken markers are scanned as plain text; compile and apply refuse the file by name.
    return text;
  }
  let inside = false;
  const lines = text.split('\n');
  const marks = markerLines(lines);
  return lines
    .map((line, i) => {
      const m = marks[i];
      if (m?.id === COMPILED_ID) {
        inside = m.kind === 'begin';
        return '';
      }
      return inside ? '' : line;
    })
    .join('\n');
}
