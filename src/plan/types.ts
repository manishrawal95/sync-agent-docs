import type { Decision, ItemKind } from '../store/types.js';
import type { Attribute, Entity, Fact, RepoInfo, Scope, SourceKind } from '../types.js';

export type { Decision, ItemKind };
export type Tier = 'auto' | 'conflict' | 'identity' | 'move' | 'secret';
export const TIERS: readonly Tier[] = ['auto', 'conflict', 'identity', 'move', 'secret'];

/**
 * One line-level change. `lineHash` pins the line as it was at plan time; apply refuses when it
 * no longer matches. A secret edit carries only the hash, never the line's text.
 */
/** A replace also carries the value it swaps (`from` to `to`), so two replaces on one line can apply in turn. */
export interface Edit { path: string; line: number; op: 'remove' | 'replace' | 'append'; lineHash?: string; before?: string; after?: string; from?: string; to?: string; secret?: boolean }
export interface Evidence { value: string; path: string; line: number; kind: SourceKind; scope: Scope; lastCommit?: string }
export interface PlanItem {
  key: string; tier: Tier; kind: ItemKind; title: string; subject: string; candidates: string[];
  entityId?: string; attribute?: Attribute; evidence: Evidence[];
  options: string[]; recommended?: string; answer: string | null; answeredBy?: 'remembered' | 'prompt' | 'flag' | 'hand';
  /**
   * Edits apply makes for each option; an option with no entry changes no file. An item that
   * `follows` another (a rewrite riding on a conflict) keys its edits by that item's answer and
   * applies them only when its own answer is `accept`.
   */
  edits: Record<string, Edit[]>;
  follows?: string;
  /** Where a secret stays when plan cannot remove it (it sits behind a link to a file that is not an agent file). */
  secretAt?: { path: string; line: number };
  notes: string[];
}
export interface Plan { schema: 1; root: string; store: string; repos: RepoInfo[]; createdAt: string; scannedAt: string; items: PlanItem[]; entities: Entity[]; facts: Fact[] }
