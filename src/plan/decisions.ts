import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openDotDir } from '../dotdir.js';
import { readJsonFile, writeJsonAtomic } from '../store/io.js';
import { SCHEMA_VERSION, type Decision, type ItemKind } from '../store/types.js';

/** Stable across rescans: the same question over the same candidate set gets the same key. */
export function decisionKey(kind: ItemKind, subject: string, candidates: string[]): string {
  const set = [...new Set(candidates)].sort();
  return createHash('sha256').update(JSON.stringify([kind, subject, set])).digest('hex').slice(0, 16);
}

/** By key; the later `decidedAt` wins. */
export function mergeDecisions(base: Decision[], added: Decision[]): Decision[] {
  const byKey = new Map(base.map((d) => [d.key, d]));
  for (const d of added) {
    const prev = byKey.get(d.key);
    if (!prev || prev.decidedAt <= d.decidedAt) byKey.set(d.key, d);
  }
  return [...byKey.values()];
}

const preStorePath = (root: string): string => join(root, '.sync-agent-docs', 'decisions.json');

async function readFile(path: string): Promise<Decision[]> {
  return (await readJsonFile<{ decisions: Decision[] }>(path, 'plan'))?.decisions ?? [];
}

/** Pre-store answers plus the store's; the store is canonical, so it wins on a shared key. */
export async function readDecisions(root: string, storeDir: string): Promise<Decision[]> {
  const pre = await readFile(preStorePath(root));
  const store = await readFile(join(storeDir, 'store', 'decisions.json'));
  const byKey = new Map(pre.map((d) => [d.key, d]));
  for (const d of store) byKey.set(d.key, d);
  return [...byKey.values()];
}

export async function rememberDecisions(root: string, decisions: Decision[]): Promise<void> {
  await openDotDir(root, 'plan');
  const merged = mergeDecisions(await readFile(preStorePath(root)), decisions);
  await writeJsonAtomic(preStorePath(root), { schema: SCHEMA_VERSION, decisions: merged });
}
