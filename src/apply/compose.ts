import { shortPath } from '../paths.js';
import { mergeDecisions } from '../plan/decisions.js';
import type { Evidence, Plan, PlanItem } from '../plan/types.js';
import { DEFAULT_VIEWS, SCHEMA_VERSION, type Decision, type Store, type StoreEntity, type StoreFact, type StoreSecret } from '../store/types.js';
import type { AgentFormat, Attribute } from '../types.js';

const FORMATS: AgentFormat[] = ['claude', 'agents', 'gemini', 'cursor', 'copilot'];

/** Rows read back from a hand-edited view block the user chose to fold into the store. */
export interface FoldedBlock { entityId: string; commands: boolean; facts: { attribute: Attribute; value: string }[] }

type Shorten = (path: string) => string;

function factsFrom(i: PlanItem, values: string[], short: Shorten): StoreFact[] {
  if (!i.entityId || !i.attribute) return [];
  const { entityId, attribute } = i;
  return values.map((value) => {
    // A command item's single evidence row names the package.json that lists every script.
    const ev = i.evidence.filter((e) => e.value === value || (attribute === 'command' && e.value.split(', ').includes(value)));
    const truth = ev.find((e: Evidence) => e.kind === 'truth');
    return {
      entityId, attribute, value,
      sources: ev.map((e) => ({ path: short(e.path), line: e.line })),
      status: truth ? 'verified' : 'inferred',
      ...(truth ? { check: { kind: 'config', path: short(truth.path), attribute, value } } : {}),
    } satisfies StoreFact;
  });
}

/** The store facts one answered item asserts, or null when the answer asserts none. */
function answerFacts(i: PlanItem, short: Shorten): StoreFact[] | null {
  if (i.kind === 'fact' && i.answer === 'approve') return factsFrom(i, i.candidates, short);
  if (i.kind === 'conflict' && i.answer) return factsFrom(i, i.answer === 'all-valid' ? i.candidates : [i.answer], short);
  return null;
}

/**
 * The next store: the previous one, then folded view edits, then the plan's answers, each
 * replacing what the store held for the same entity and attribute. An attribute a folded edit
 * changed keeps the edit: it is newer than any answer remembered from an earlier plan. Pure; reads no file.
 */
export function composeStore(prev: Store | null, plan: Plan, decisions: Decision[], home: string, folded: FoldedBlock[] = []): Store {
  const short: Shorten = (p) => shortPath(p, plan.root, home);
  let facts = [...(prev?.facts ?? [])];
  const replace = (entityId: string, attributes: (a: Attribute) => boolean, next: StoreFact[]): void => {
    facts = facts.filter((f) => f.entityId !== entityId || !attributes(f.attribute)).concat(next);
  };

  const handEdited = new Set<string>();
  const valuesOf = (list: { attribute: Attribute; value: string }[], a: Attribute): string => list.filter((f) => f.attribute === a).map((f) => f.value).sort().join('\0');
  for (const b of folded) {
    const old = facts.filter((f) => f.entityId === b.entityId);
    for (const a of new Set([...old, ...b.facts].map((f) => f.attribute))) {
      if ((a === 'command') === b.commands && valuesOf(old, a) !== valuesOf(b.facts, a)) handEdited.add(`${b.entityId}|${a}`);
    }
    replace(b.entityId, (a) => (a === 'command') === b.commands, b.facts.map((r) => {
      const known = old.find((f) => f.attribute === r.attribute && f.value === r.value);
      return known ?? { entityId: b.entityId, attribute: r.attribute, value: r.value, sources: [], status: 'inferred' };
    }));
  }

  const secrets = new Map((prev?.secrets ?? []).map((s) => [`${s.path}:${s.line}`, s]));
  for (const i of plan.items) {
    if (i.answer === null) continue;
    const next = answerFacts(i, short);
    if (next && i.entityId && i.attribute && !handEdited.has(`${i.entityId}|${i.attribute}`)) replace(i.entityId, (a) => a === i.attribute, next);
    // An AI link adds to what the entity has; it never replaces a fact the user settled.
    if (i.kind === 'ai-link' && i.answer === 'yes') {
      for (const f of factsFrom(i, i.evidence.map((e) => e.value), short)) {
        if (!facts.some((x) => x.entityId === f.entityId && x.attribute === f.attribute && x.value === f.value)) facts.push(f);
      }
    }
    if (i.kind === 'secret') {
      const at = i.secretAt ?? { path: i.subject, line: i.edits['rotate-remove']?.[0]?.line ?? 0 };
      const status = i.answer === 'false-positive' ? 'false-positive' : i.secretAt ? 'manual' : 'removed';
      const s: StoreSecret = { ...at, status };
      secrets.set(`${s.path}:${s.line}`, s);
    }
  }

  const prevEntities = new Map((prev?.entities ?? []).map((e) => [e.id, e]));
  const withFacts = new Set(facts.map((f) => f.entityId));
  const entities: StoreEntity[] = [...prevEntities.values()];
  for (const e of plan.entities) {
    // Every repo gets a project card; other entities enter the store with their first fact.
    if (prevEntities.has(e.id) || (e.kind !== 'project' && !withFacts.has(e.id))) continue;
    entities.push({ id: e.id, kind: e.kind, names: e.names, identifiers: e.identifiers, notes: '' });
  }

  const repos = new Map((prev?.config.repos ?? []).map((r) => [r.path, r]));
  for (const r of plan.repos) {
    const path = shortPath(r.path, '\0', home);
    // Keeps what the owner set by hand on an entry, such as its formats.
    repos.set(path, { ...repos.get(path), name: r.name, path });
  }

  return {
    config: {
      schema: SCHEMA_VERSION, root: shortPath(plan.root, '\0', home), repos: [...repos.values()],
      agentFormats: prev?.config.agentFormats ?? FORMATS, views: prev?.config.views ?? DEFAULT_VIEWS,
      generated: prev?.config.generated ?? {},
    },
    entities: entities.sort((a, b) => a.id.localeCompare(b.id)),
    facts: facts.filter((f) => entities.some((e) => e.id === f.entityId)),
    secrets: [...secrets.values()],
    decisions: mergeDecisions(prev?.decisions ?? [], decisions),
  };
}
