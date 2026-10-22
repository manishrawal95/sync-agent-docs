import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { writeFresh } from '../dotdir.js';
import { AGENT_FORMATS } from '../types.js';
import { insideStore } from './inside.js';
import { SCHEMA_VERSION, type Decision, type Store, type StoreEntity, type StoreFact, type StoreSecret, type TruthConfig } from './types.js';

/** Reads a schema-versioned JSON file; null when it does not exist. */
export async function readJsonFile<T>(path: string, stage: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${stage}: could not read ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Check its permissions.`, { cause: err });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${stage}: ${path} is not valid JSON. Fix it by hand or restore it from git.`, { cause: err });
  }
  const schema = (value as { schema?: unknown } | null)?.schema;
  if (schema !== SCHEMA_VERSION) {
    throw new Error(`${stage}: ${path} has schema ${String(schema)}, and this version of sync-agent-docs reads schema ${SCHEMA_VERSION}. Upgrade sync-agent-docs or restore the file from git.`);
  }
  return value as T;
}

/** Writes through a fresh temp file and a rename, creating the parent folder. */
export async function writeTextAtomic(path: string, text: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFresh(dirname(path), basename(path), text, mode);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

const paths = (dir: string) => ({
  config: join(dir, 'sync-agent-docs.json'),
  entities: join(dir, 'store', 'entities.json'),
  facts: join(dir, 'store', 'facts.json'),
  decisions: join(dir, 'store', 'decisions.json'),
});

/** Refuses a config whose views or generated files would be written outside the store. */
async function checkStorePaths(dir: string, file: string, config: TruthConfig): Promise<void> {
  const views = (config.views ?? {}) as Record<string, unknown>;
  const named: [string, unknown][] = [
    ...Object.entries(views).map(([k, v]): [string, unknown] => [`views.${k}`, v]),
    ...Object.keys(config.generated ?? {}).map((k): [string, unknown] => [`generated[${JSON.stringify(k)}]`, k]),
  ];
  for (const [key, value] of named) {
    if (!(await insideStore(dir, value))) {
      throw new Error(`store: ${file}: ${key} is ${JSON.stringify(value)}, which is not a path inside the store, so nothing was written. Change it to a file inside ${dir} and run again.`);
    }
  }
}

/** Refuses a repo whose `formats` is not a list of agent formats, before compile trusts it. */
function checkRepoFormats(file: string, config: TruthConfig): void {
  for (const [i, r] of (config.repos ?? []).entries()) {
    const formats: unknown = r.formats;
    if (formats === undefined || (Array.isArray(formats) && formats.every((f) => (AGENT_FORMATS as readonly unknown[]).includes(f)))) continue;
    throw new Error(`store: ${file}: repos[${i}].formats is ${JSON.stringify(formats)}, which is not a list of ${AGENT_FORMATS.join(', ')}, so nothing was written. Fix it by hand and run again.`);
  }
}

export async function readStore(dir: string): Promise<Store | null> {
  const p = paths(dir);
  const config = await readJsonFile<TruthConfig>(p.config, 'store');
  if (!config) return null;
  await checkStorePaths(dir, p.config, config);
  checkRepoFormats(p.config, config);
  const entities = await readJsonFile<{ entities: StoreEntity[] }>(p.entities, 'store');
  const facts = await readJsonFile<{ facts: StoreFact[]; secrets: StoreSecret[] }>(p.facts, 'store');
  const decisions = await readJsonFile<{ decisions: Decision[] }>(p.decisions, 'store');
  return { config, entities: entities?.entities ?? [], facts: facts?.facts ?? [], secrets: facts?.secrets ?? [], decisions: decisions?.decisions ?? [] };
}

/** Every store file's path and JSON text, for the caller to write. */
export function storeFiles(dir: string, store: Store): [string, string][] {
  const p = paths(dir);
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  return [
    [p.config, json(store.config)],
    [p.entities, json({ schema: SCHEMA_VERSION, entities: store.entities })],
    [p.facts, json({ schema: SCHEMA_VERSION, facts: store.facts, secrets: store.secrets })],
    [p.decisions, json({ schema: SCHEMA_VERSION, decisions: store.decisions })],
  ];
}

/** Writes every store file; returns the paths written. */
export async function writeStore(dir: string, store: Store): Promise<string[]> {
  const files = storeFiles(dir, store);
  for (const [path, text] of files) await writeTextAtomic(path, text);
  return files.map(([path]) => path);
}
