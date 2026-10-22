import type { AgentFormat, Attribute, Entity, EntityKind } from '../types.js';

export const SCHEMA_VERSION = 1;

export type FactStatus = 'verified' | 'inferred';
/** A file-based assertion `doctor` reruns: the config at `path` still says `attribute` is `value`. */
export interface FactCheck { kind: 'config'; path: string; attribute: Attribute; value: string }
/** `network`, set by hand, lets `doctor --live` contact the entity's private or loopback addresses. */
export interface StoreEntity { id: string; kind: EntityKind; names: string[]; identifiers: Entity['identifiers']; notes: string; network?: 'local' | 'tailnet' }
/** `path` is relative to the scan root, `~/...` under home, else absolute. */
export interface StoreSource { path: string; line: number }
export interface StoreFact { entityId: string; attribute: Attribute; value: string; sources: StoreSource[]; status: FactStatus; check?: FactCheck }
/** A secret is recorded by location only, never its value. */
export interface StoreSecret { path: string; line: number; status: 'removed' | 'manual' | 'false-positive' }

export type ItemKind = 'fact' | 'conflict' | 'identity' | 'duplicate' | 'stale' | 'rewrite' | 'view-edit' | 'secret' | 'ai-link' | 'compiled-edit';
export interface Decision { key: string; kind: ItemKind; subject: string; candidates: string[]; answer: string; decidedAt: string }

export interface TruthConfig {
  schema: 1;
  root: string;
  /** `formats` lists agent files compile creates in that repo when they are absent; files that exist are always kept current. */
  repos: { name: string; path: string; formats?: AgentFormat[] }[];
  agentFormats: AgentFormat[];
  views: { hosts: string; services: string; projects: string };
  /** View file → block id → hash of the block as last generated, to spot hand edits. */
  generated: Record<string, Record<string, string>>;
}
export interface Store { config: TruthConfig; entities: StoreEntity[]; facts: StoreFact[]; secrets: StoreSecret[]; decisions: Decision[] }

export const DEFAULT_VIEWS: TruthConfig['views'] = { hosts: 'hosts.md', services: 'services.md', projects: 'projects' };
