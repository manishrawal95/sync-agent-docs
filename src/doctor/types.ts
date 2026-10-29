import type { Plan } from '../plan/types.js';
import type { Decision, Store } from '../store/types.js';
import type { ScanResult } from '../types.js';

export const CHECK_IDS = ['rescan', 'fact-checks', 'compiled', 'loaded-size', 'views', 'branches', 'applies', 'secrets', 'live'] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** `drift` fails the run; `accepted` is drift the owner listed in checks.json; `note` never fails. */
export interface DoctorFinding { key: string; level: 'drift' | 'accepted' | 'note'; message: string; path?: string }
export interface CheckResult { id: CheckId; status: 'clean' | 'drift' | 'disabled'; findings: DoctorFinding[] }

/** A network target from the store; `target` never carries credentials, a query or a fragment. */
export interface LiveTarget { kind: 'http' | 'tcp'; target: string; entityId: string; result?: 'ok' | 'failed' | 'skipped'; detail?: string }

export interface DoctorResult { schema: 1; at: string; root: string; store: string; drift: boolean; checks: CheckResult[]; live: LiveTarget[] | null }

/** What every check reads, built once per run. */
export interface DoctorContext {
  root: string; home: string; now: Date; reposOnly: boolean; storeDir: string; store: Store; decisions: Decision[];
  /** The rescan, made on first use and shared. */
  scan(): Promise<ScanResult>;
  /** The last plan.json, or null when plan never ran here. */
  lastPlan: Plan | null;
  /** Checks switched off in checks.json, for a check that reports what another would have. */
  disabled: ReadonlySet<CheckId>;
}

/** A finding a check reports before checks.json decides its level. */
export type Found = Omit<DoctorFinding, 'level'> & { level?: 'note' };
export interface Check { id: CheckId; run(ctx: DoctorContext): Promise<Found[]> }
