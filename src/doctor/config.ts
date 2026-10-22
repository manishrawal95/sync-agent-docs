import { join } from 'node:path';
import { readJsonFile } from '../store/io.js';
import { CHECK_IDS, type CheckId } from './types.js';

export interface ChecksConfig { disabled: Set<CheckId>; accepted: Set<string> }

const KEYS = ['schema', 'disabled', 'accepted'];

/** The owner's `.sync-agent-docs/checks.json`: check ids to skip and finding keys to accept. Doctor never writes it. */
export async function readChecksConfig(dotDir: string): Promise<ChecksConfig> {
  const path = join(dotDir, 'checks.json');
  const raw = await readJsonFile<Record<string, unknown>>(path, 'doctor');
  if (!raw) return { disabled: new Set(), accepted: new Set() };
  const fix = 'Fix it by hand and run sync-agent-docs doctor again.';
  for (const k of Object.keys(raw)) {
    if (!KEYS.includes(k)) throw new Error(`doctor: ${path}: ${JSON.stringify(k)} is not a checks.json key (use disabled or accepted). ${fix}`);
  }
  const list = (name: 'disabled' | 'accepted', ok: (v: unknown) => boolean, what: string): string[] => {
    const value = raw[name] ?? [];
    if (!Array.isArray(value)) throw new Error(`doctor: ${path}: ${name} is ${JSON.stringify(value)}, which is not a list. ${fix}`);
    for (const [i, v] of value.entries()) {
      if (!ok(v)) throw new Error(`doctor: ${path}: ${name}[${i}] is ${JSON.stringify(v)}, which is not ${what}. ${fix}`);
    }
    return value as string[];
  };
  const disabled = list('disabled', (v) => (CHECK_IDS as readonly unknown[]).includes(v), `a check id (${CHECK_IDS.join(', ')})`);
  const accepted = list('accepted', (v) => typeof v === 'string' && CHECK_IDS.some((id) => v.startsWith(`${id}:`) && v.length > id.length + 1), 'a finding key (copy one from sync-agent-docs doctor output)');
  return { disabled: new Set(disabled as CheckId[]), accepted: new Set(accepted) };
}
