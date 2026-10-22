import { entityName } from '../../src/compare/findings.js';
import type { Attribute, Finding, FindingType } from '../../src/types.js';

export interface ExpectedFinding { type: FindingType; entity?: string; attribute?: Attribute; values?: string[]; value?: string }
export interface AnswerKey {
  snapshots: { repo: string; source: string; sha: string }[];
  expected: ExpectedFinding[];
  currentReal: ExpectedFinding[];
}

/** Parses the owner-local answer key; a malformed file names itself and the missing field. */
export function loadAnswerKey(text: string, path: string): AnswerKey {
  const key = JSON.parse(text) as Partial<AnswerKey>;
  for (const field of ['snapshots', 'expected', 'currentReal'] as const) {
    if (!Array.isArray(key[field])) throw new Error(`replay: ${path} has no "${field}" array. See tests/replay.test.ts for the shape.`);
  }
  return key as AnswerKey;
}

/** True when a finding has the expected type, entity and attribute and holds every expected value. */
export function matches(f: Finding, e: ExpectedFinding): boolean {
  if (f.type !== e.type) return false;
  if (e.entity !== undefined && (!f.entityId || entityName(f.entityId) !== e.entity)) return false;
  if (e.attribute !== undefined && f.attribute !== e.attribute) return false;
  const have = new Set((f.values ?? []).map((g) => g.value));
  return [...(e.values ?? []), ...(e.value !== undefined ? [e.value] : [])].every((v) => have.has(v));
}

export const describeExpected = (e: ExpectedFinding): string =>
  [e.type, e.entity, e.attribute, ...(e.values ?? []), e.value].filter(Boolean).join(' ');
