import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { MAX_FILE_BYTES } from '../discover/sources.js';

/**
 * Streams a file's lines to `onLine` without keeping the text, for files that hold secrets
 * (.env, shell rc, gh hosts): callers cut each line down to a name as it passes.
 * Reads at most MAX_FILE_BYTES; throws with a code for non-regular files.
 */
export async function streamLines(path: string, onLine: (line: string, lineNo: number) => void): Promise<void> {
  if (!(await stat(path)).isFile()) throw Object.assign(new Error(`${path} is not a regular file`), { code: 'ENOTFILE' });
  const input = createReadStream(path, { encoding: 'utf8', end: MAX_FILE_BYTES - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of lines) onLine(line, ++lineNo);
}
