import { readTextSafe } from '../discover/sources.js';

/**
 * The `npm run <script>` commands a package.json lists, sorted, or null when the file is missing,
 * unreadable or broken (the scan reports a broken one; it just has no commands here).
 */
export async function packageCommands(path: string): Promise<string[] | null> {
  const read = await readTextSafe(path);
  if (!('text' in read)) return null;
  let scripts: unknown;
  try {
    scripts = (JSON.parse(read.text) as { scripts?: unknown }).scripts;
  } catch {
    return null;
  }
  if (!scripts || typeof scripts !== 'object') return null;
  return [...new Set(Object.keys(scripts).map((s) => `npm run ${s}`))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}
