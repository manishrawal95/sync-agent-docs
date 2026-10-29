import { basename, join } from 'node:path';
import { readTextSafe } from '../discover/sources.js';
import { refusedLink, type RefusedLink } from '../compile/links.js';
import { blameLine } from '../git.js';
import { shortPath } from '../paths.js';
import { DEFAULT_VIEWS, type Decision, type StoreFact, type TruthConfig } from '../store/types.js';
import type { Attribute, Entity, Fact, Finding, Location, ScanResult } from '../types.js';
import { packageCommands } from '../truth/commands.js';
import { viewFile } from '../views/render.js';
import { decisionKey } from './decisions.js';
import { isPureRestatement, lineHash, replaceValue } from './lines.js';
import { TIERS, type Edit, type Evidence, type ItemKind, type Plan, type PlanItem, type Tier } from './types.js';

/**
 * A fact item whose every value the store already holds: known even when no decision carries this
 * item's exact key, as when a settled conflict comes back as a plain fact once every file agrees.
 */
const heldByStore = (facts: Pick<StoreFact, 'entityId' | 'attribute' | 'value'>[], i: PlanItem): boolean =>
  i.kind === 'fact' && i.candidates.every((v) => facts.some((f) => f.entityId === i.entityId && f.attribute === i.attribute && f.value === v));

/**
 * A fact item whose values are exactly the store's for that attribute, so approving it changes
 * nothing. Held is not enough: approving replaces the attribute's values, dropping any extra one.
 */
export const settledByStore = (facts: Pick<StoreFact, 'entityId' | 'attribute' | 'value'>[], i: PlanItem): boolean =>
  heldByStore(facts, i) && facts.every((f) => f.entityId !== i.entityId || f.attribute !== i.attribute || i.candidates.includes(f.value));

/** `views` are the store's own view paths, when it has a store; pointers follow them. */
export interface BuildInput { scan: ScanResult; decisions: Decision[]; store: string; home: string; now: Date; viewItems?: PlanItem[]; views?: TruthConfig['views'] }

const CONFLICT_TYPES = new Set<Finding['type']>(['conflict', 'global-local', 'possible-conflict']);
const byValue = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });
const sortedSet = (values: Iterable<string>): string[] => [...new Set(values)].sort(byValue);
const groupKey = (entityId: string, attribute: Attribute): string => `${entityId}|${attribute}`;

/** Everything the item builders share: the scan, cached file lines and the pointer import. */
class Ctx {
  private readonly lines = new Map<string, Promise<string[] | null>>();
  private readonly facts = new Map<string, Fact>();
  readonly entities: Map<string, Entity>;

  constructor(readonly scan: ScanResult, private readonly store: string, private readonly home: string, private readonly views: TruthConfig['views']) {
    for (const f of scan.facts) this.facts.set(`${f.at.path}:${f.at.line}:${f.attribute}:${f.value}`, f);
    this.entities = new Map(scan.entities.map((e) => [e.id, e]));
  }

  display(path: string): string {
    return shortPath(path, this.scan.root, this.home);
  }

  factAt(at: Location, attribute: Attribute, value: string): Fact | undefined {
    return this.facts.get(`${at.path}:${at.line}:${attribute}:${value}`);
  }

  async lineOf(path: string, line: number): Promise<string | undefined> {
    let cached = this.lines.get(path);
    if (!cached) {
      cached = readTextSafe(path).then((r) => ('text' in r ? r.text.split(/\r?\n/) : null));
      this.lines.set(path, cached);
    }
    return (await cached)?.[line - 1];
  }

  async lineCount(path: string): Promise<number> {
    await this.lineOf(path, 1);
    const lines = (await this.lines.get(path)) ?? [];
    return lines.at(-1) === '' ? lines.length - 1 : lines.length;
  }

  /**
   * A remove, or with `swap` a replace of one value by another, pinned to the line as it is now.
   * A line that no longer reads as it did at scan time (an old `--use-scan`) is refused, since its
   * line number may now point at a different line.
   */
  async edit(fact: Fact, swap?: { from: string; to: string }): Promise<Edit | null> {
    const { path, line } = fact.at;
    const text = await this.lineOf(path, line);
    if (text?.trim() !== fact.lineText) {
      throw new Error(`plan: ${this.display(path)}:${line} changed since the scan, so its edit would land on the wrong line. Run sync-agent-docs scan again, or drop --use-scan.`);
    }
    const base = { path, line, lineHash: lineHash(text), before: text };
    return swap ? { ...base, op: 'replace', after: replaceValue(text, swap.from, swap.to), from: swap.from, to: swap.to } : { ...base, op: 'remove' };
  }

  /** `@<store>/<view>`, the import that replaces a removed restatement in a CLAUDE.md. */
  pointer(entityId: string): string | null {
    const e = this.entities.get(entityId);
    if (!e) return null;
    return `@${shortPath(this.store, '\0', this.home)}/${viewFile(this.views, e)}`;
  }

  /** The pointer import appended to a repo CLAUDE.md, unless the file already has it. Machine files get none: they load in every project. */
  async pointerAppend(fact: Fact, entityId: string): Promise<Edit | null> {
    const ref = this.pointer(entityId);
    if (!ref || fact.scope !== 'repo' || basename(fact.at.path) !== 'CLAUDE.md') return null;
    const count = await this.lineCount(fact.at.path);
    for (let i = 1; i <= count; i++) if ((await this.lineOf(fact.at.path, i))?.trim() === ref) return null;
    return { path: fact.at.path, line: count + 1, op: 'append', after: ref };
  }

  async evidence(facts: Fact[]): Promise<Evidence[]> {
    return Promise.all(facts.map(async (f) => {
      const lastCommit = await blameLine(f.at.path, f.at.line);
      return { value: f.value, path: f.at.path, line: f.at.line, kind: f.kind, scope: f.scope, ...(lastCommit ? { lastCommit } : {}) };
    }));
  }
}

function item(tier: Tier, kind: ItemKind, subject: string, candidates: string[], rest: Omit<PlanItem, 'key' | 'tier' | 'kind' | 'subject' | 'candidates' | 'answer'>): PlanItem {
  return { key: decisionKey(kind, subject, candidates), tier, kind, subject, candidates, answer: null, ...rest };
}

const pushEdit = (list: Edit[], e: Edit | null): void => {
  if (e && !list.some((x) => x.path === e.path && x.op === e.op && x.line === e.line && x.after === e.after)) list.push(e);
};

function namesOf(ctx: Ctx, entityId: string | null | undefined): string[] {
  return entityId ? (ctx.entities.get(entityId)?.names ?? []) : [];
}

async function conflictItems(ctx: Ctx): Promise<{ items: PlanItem[]; groups: Set<string> }> {
  const merged = new Map<string, { entityId: string; attribute: Attribute; values: Map<string, { truthBacked: boolean; at: Location[] }>; possibleOnly: boolean }>();
  for (const f of ctx.scan.findings) {
    if (!CONFLICT_TYPES.has(f.type) || !f.entityId || !f.attribute) continue;
    const key = groupKey(f.entityId, f.attribute);
    const g = merged.get(key) ?? { entityId: f.entityId, attribute: f.attribute, values: new Map(), possibleOnly: true };
    if (f.type !== 'possible-conflict') g.possibleOnly = false;
    for (const v of f.values ?? []) {
      const slot: { truthBacked: boolean; at: Location[] } = g.values.get(v.value) ?? { truthBacked: false, at: [] };
      slot.truthBacked ||= v.truthBacked;
      for (const at of v.at) if (!slot.at.some((x) => x.path === at.path && x.line === at.line)) slot.at.push(at);
      g.values.set(v.value, slot);
    }
    merged.set(key, g);
  }

  const items: PlanItem[] = [];
  for (const [subject, g] of merged) {
    const candidates = sortedSet(g.values.keys());
    const backed = candidates.filter((v) => g.values.get(v)?.truthBacked);
    const names = namesOf(ctx, g.entityId);
    const facts = candidates.flatMap((v) => (g.values.get(v)?.at ?? []).map((at) => ctx.factAt(at, g.attribute, v)).filter((f): f is Fact => f !== undefined));
    const edits: Record<string, Edit[]> = {};
    const rewrites = new Map<string, { fact: Fact; edits: Record<string, Edit[]> }>();
    const notes: string[] = [];
    for (const pick of candidates) {
      const list: Edit[] = [];
      for (const f of facts) {
        if (f.value === pick || f.kind === 'truth' || g.values.get(f.value)?.truthBacked) continue;
        if (f.agent) {
          if (isPureRestatement(f.lineText, f.value, names)) {
            pushEdit(list, await ctx.edit(f));
            pushEdit(list, await ctx.pointerAppend(f, g.entityId));
          } else {
            const id = `${f.at.path}:${f.at.line}`;
            const r = rewrites.get(id) ?? { fact: f, edits: {} };
            const e = await ctx.edit(f, { from: f.value, to: pick });
            if (e) r.edits[pick] = [e];
            rewrites.set(id, r);
          }
        } else {
          pushEdit(list, await ctx.edit(f, { from: f.value, to: pick }));
        }
      }
      if (list.length) edits[pick] = list;
      if (backed.length && !backed.includes(pick)) notes.push(`Picking ${pick}: config disagrees; edit it by hand.`);
    }
    const conflict = item('conflict', 'conflict', subject, candidates, {
      title: `${names[0] ?? g.entityId} ${g.attribute}: ${candidates.join(' vs ')}`,
      entityId: g.entityId, attribute: g.attribute, evidence: await ctx.evidence(facts),
      options: [...candidates, 'all-valid'], ...(backed.length === 1 && !g.possibleOnly ? { recommended: backed[0] } : {}),
      edits, notes,
    });
    items.push(conflict);
    for (const { fact, edits: rEdits } of rewrites.values()) {
      const text = (await ctx.lineOf(fact.at.path, fact.at.line)) ?? fact.lineText;
      items.push(item('move', 'rewrite', `${ctx.display(fact.at.path)}|${subject}`, [lineHash(text)], {
        title: `Rewrite ${ctx.display(fact.at.path)}:${fact.at.line} to the ${g.attribute} you pick for ${names[0] ?? g.entityId}`,
        entityId: g.entityId, attribute: g.attribute, evidence: await ctx.evidence([fact]),
        options: ['accept', 'skip'], recommended: 'accept', edits: rEdits, follows: conflict.key,
        notes: ['The line says more than the value, so it is rewritten in place, not removed.'],
      }));
    }
  }
  return { items, groups: new Set(merged.keys()) };
}

async function autoItems(ctx: Ctx, conflicted: Set<string>): Promise<PlanItem[]> {
  const groups = new Map<string, Fact[]>();
  for (const f of ctx.scan.facts) {
    if (!f.entityId) continue;
    const key = groupKey(f.entityId, f.attribute);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const items: PlanItem[] = [];
  for (const [subject, facts] of groups) {
    const truth = sortedSet(facts.filter((f) => f.kind === 'truth').map((f) => f.value));
    const first = facts[0];
    if (!truth.length || conflicted.has(subject) || !first?.entityId) continue;
    const name = namesOf(ctx, first.entityId)[0] ?? first.entityId;
    items.push(item('auto', 'fact', subject, truth, {
      title: `${name} ${first.attribute}: ${truth.join(', ')}`, entityId: first.entityId, attribute: first.attribute,
      evidence: await ctx.evidence(facts), options: ['approve', 'skip'], recommended: 'approve', edits: {}, notes: [],
    }));
  }
  return items.concat(await commandItems(ctx));
}

/** One item per project whose repo root has a package.json with scripts (unique repo names only). */
async function commandItems(ctx: Ctx): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  for (const repo of ctx.scan.repos) {
    if (ctx.scan.repos.filter((r) => r.name === repo.name).length > 1) continue;
    const entityId = `project:${repo.name}`;
    if (!ctx.entities.has(entityId)) continue;
    const path = join(repo.path, 'package.json');
    const commands = await packageCommands(path);
    if (!commands?.length) continue;
    items.push(item('auto', 'fact', `${entityId}|command`, commands, {
      title: `${repo.name} commands: ${commands.join(', ')}`, entityId, attribute: 'command',
      evidence: [{ value: commands.join(', '), path, line: 1, kind: 'truth', scope: 'repo' }],
      options: ['approve', 'skip'], recommended: 'approve', edits: {}, notes: [],
    }));
  }
  return items;
}

function identityItems(ctx: Ctx): PlanItem[] {
  const byName = new Map<string, Entity[]>();
  for (const e of ctx.scan.entities) for (const n of new Set(e.names.map((x) => x.toLowerCase()))) byName.set(n, [...(byName.get(n) ?? []), e]);
  const items: PlanItem[] = [];
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const shared = list.some((a, i) => list.slice(i + 1).some((b) => Object.entries(a.identifiers).some(([k, v]) => b.identifiers[k as keyof Entity['identifiers']] === v)));
    if (shared) continue;
    const ids = sortedSet(list.map((e) => e.id));
    items.push(item('identity', 'identity', `identity|${name}`, ids, {
      title: `Is every "${name}" the same thing? ${ids.join(', ')}`, evidence: [], options: ['same', 'different'], edits: {},
      notes: list.map((e) => `${e.id}: ${Object.entries(e.identifiers).map(([k, v]) => `${k} ${v}`).join(', ') || 'no identifiers'}`),
    }));
  }
  return items;
}

async function moveItems(ctx: Ctx): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  for (const f of ctx.scan.findings) {
    const group = f.values?.[0];
    if (f.type === 'duplicated' && f.attribute && group) {
      const facts = group.at.map((at) => ctx.factAt(at, f.attribute as Attribute, group.value)).filter((x): x is Fact => x !== undefined);
      const names = namesOf(ctx, f.entityId);
      const edits: Edit[] = [];
      const notes: string[] = [];
      for (const fact of facts) {
        const claude = basename(fact.at.path) === 'CLAUDE.md' && fact.scope === 'repo';
        if (f.entityId && claude && isPureRestatement(fact.lineText, fact.value, names)) {
          pushEdit(edits, await ctx.edit(fact));
          pushEdit(edits, await ctx.pointerAppend(fact, f.entityId));
        } else {
          notes.push(`${ctx.display(fact.at.path)}:${fact.at.line} kept until compile.`);
        }
      }
      const lineHashes = sortedSet(await Promise.all(facts.map(async (x) => lineHash((await ctx.lineOf(x.at.path, x.at.line)) ?? x.lineText))));
      items.push(item('move', 'duplicate', `${f.entityId ?? 'none'}|${f.attribute}`, [group.value, ...lineHashes], {
        title: `${names[0] ?? f.attribute} ${f.attribute} ${group.value} is repeated in ${facts.length} agent files`,
        ...(f.entityId ? { entityId: f.entityId } : {}), attribute: f.attribute, evidence: await ctx.evidence(facts),
        options: ['approve', 'skip'], recommended: 'approve', edits: edits.length ? { approve: edits } : {}, notes,
      }));
    }
    if (f.type === 'stale' && f.attribute && group) {
      const at = group.at[0];
      const fact = at ? ctx.factAt(at, f.attribute, group.value) : undefined;
      // Stale lines in README and docs stay: people read those, and the plan only cleans agent context.
      if (!fact?.agent) continue;
      const e = await ctx.edit(fact);
      const text = (await ctx.lineOf(fact.at.path, fact.at.line)) ?? fact.lineText;
      items.push(item('move', 'stale', ctx.display(fact.at.path), [group.value, lineHash(text)], {
        title: `${ctx.display(fact.at.path)}:${fact.at.line} names ${group.value}, which nothing on the machine backs`,
        attribute: f.attribute, evidence: await ctx.evidence([fact]), options: ['delete', 'keep'], recommended: 'delete',
        edits: e ? { delete: [e] } : {}, notes: [],
      }));
    }
  }
  return items;
}

async function secretItems(ctx: Ctx): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  const copies = new Map<string, number>();
  for (const f of ctx.scan.findings) {
    const at = f.type === 'secret' ? f.at?.[0] : undefined;
    if (!at) continue;
    const text = await ctx.lineOf(at.path, at.line);
    if (text === undefined) continue;
    const hash = lineHash(text);
    const shown = ctx.display(at.path);
    // Identical lines in one file share a hash, so the nth copy is keyed apart by its number.
    const copy = (copies.get(`${at.path}\0${hash}`) ?? 0) + 1;
    copies.set(`${at.path}\0${hash}`, copy);
    items.push(item('secret', 'secret', shown, copy > 1 ? [hash, `#${copy}`] : [hash], {
      title: `Possible secret at ${shown}:${at.line}`, evidence: [], options: ['rotate-remove', 'false-positive'],
      edits: { 'rotate-remove': [{ path: at.path, line: at.line, op: 'remove', lineHash: hash, secret: true }] },
      notes: ['rotate-remove: rotate the credential first, then apply removes the line. false-positive: it is kept and not asked again.'],
    }));
  }
  return items;
}

/** Scan reads an agent file linked to a script or a .git file, but plan proposes no edit there: it says why instead. */
async function dropLinkedEdits(items: PlanItem[], root: string, home: string): Promise<void> {
  const links = new Map<string, RefusedLink | null>();
  const refusedAt = async (path: string): Promise<RefusedLink | null> => {
    if (!links.has(path)) links.set(path, await refusedLink(path, 'plan'));
    return links.get(path) ?? null;
  };
  for (const i of items) {
    for (const [option, edits] of Object.entries(i.edits)) {
      const kept: Edit[] = [];
      for (const e of edits) {
        const refused = await refusedAt(e.path);
        if (!refused) {
          kept.push(e);
          continue;
        }
        const note = `${shortPath(e.path, root, home)} is a link to ${shortPath(refused.target, root, home)}, which is not an agent file, so plan proposes no edit there.`;
        if (!i.notes.includes(note)) i.notes.push(note);
        // A secret plan cannot remove is rotated and removed by hand, and apply records it so, never as removed.
        if (i.kind === 'secret' && option === 'rotate-remove') {
          const where = refused.inRepo ? refused.target : shortPath(refused.real, root, home);
          i.secretAt = { path: shortPath(refused.real, root, home), line: e.line };
          i.options = ['rotate-manual', 'false-positive'];
          i.notes = i.notes.filter((n) => !n.startsWith('rotate-remove:'));
          i.notes.push(`the secret stays in ${where}; rotate it, then remove it there by hand`,
            'rotate-manual: apply records that you rotate and remove it yourself. false-positive: it is kept and not asked again.');
        }
      }
      i.edits[option] = kept;
    }
    if (i.secretAt) delete i.edits['rotate-remove'];
  }
}

/** Builds the five-tier plan from a scan; remembered answers fill matching questions. */
export async function buildPlan(input: BuildInput): Promise<Plan> {
  const ctx = new Ctx(input.scan, input.store, input.home, input.views ?? DEFAULT_VIEWS);
  const conflicts = await conflictItems(ctx);
  const all = [
    ...(await autoItems(ctx, conflicts.groups)),
    ...conflicts.items,
    ...identityItems(ctx),
    ...(await moveItems(ctx)),
    ...(input.viewItems ?? []),
    ...(await secretItems(ctx)),
  ];
  const seen = new Set<string>();
  const items = all.filter((i) => !seen.has(i.key) && seen.add(i.key)).sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  await dropLinkedEdits(items, input.scan.root, input.home);
  const remembered = new Map(input.decisions.map((d) => [d.key, d]));
  // Copies of one secret line are keyed by their number, so removing one renumbers the rest: an answer
  // that edits the file, remembered for a line that is or was repeated, could land on the wrong copy.
  const copied = (x: Pick<PlanItem, 'kind' | 'subject' | 'candidates'>): string => `${x.subject}\0${x.candidates[0] ?? ''}`;
  const repeated = new Set([...items, ...input.decisions].filter((x) => x.kind === 'secret' && x.candidates.length > 1).map(copied));
  for (const i of items) {
    const d = remembered.get(i.key);
    // A secret is waved through only by a decision made for this exact line, not one that merely carries its key.
    if (i.tier === 'secret' && d && decisionKey(d.kind, d.subject, d.candidates) !== i.key) continue;
    if (i.tier === 'secret' && d && i.edits[d.answer]?.length && repeated.has(copied(i))) continue;
    if (d && i.options.includes(d.answer)) Object.assign(i, { answer: d.answer, answeredBy: 'remembered' });
  }
  return {
    schema: 1, root: input.scan.root, store: input.store, repos: input.scan.repos, createdAt: input.now.toISOString(), scannedAt: input.scan.scannedAt,
    items, entities: input.scan.entities, facts: input.scan.facts,
  };
}
