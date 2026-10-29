import { join, resolve } from 'node:path';
import { openDotDir, refuseTrackedDotDir } from '../dotdir.js';
import { readDecisions } from '../plan/decisions.js';
import { resolveStore } from '../plan/run.js';
import type { Plan } from '../plan/types.js';
import { printable } from '../report/terminal.js';
import { collectScan } from '../scan.js';
import { readJsonFile, readStore, writeJsonAtomic } from '../store/io.js';
import type { ScanResult } from '../types.js';
import { appliesCheck, branchesCheck } from './checks/branches.js';
import { compiledCheck } from './checks/compiled.js';
import { loadedSizeCheck } from './checks/loaded-size.js';
import { factChecksCheck, rescanCheck } from './checks/rescan.js';
import { secretsCheck } from './checks/secrets.js';
import { viewsCheck } from './checks/views.js';
import { readChecksConfig } from './config.js';
import { checkNetworkMarks, liveCheck, type LiveOptions } from './live.js';
import type { Check, CheckResult, DoctorContext, DoctorFinding, DoctorResult } from './types.js';

export interface DoctorOptions extends LiveOptions {
  home: string; store?: string; reposOnly?: boolean; now?: Date;
  /** Runs the live check: the only part of doctor that opens a network connection. */
  live?: boolean;
  /** Test seam passed to the rescan. */
  crontabCommand?: string;
}

const CHECKS: Check[] = [rescanCheck, factChecksCheck, compiledCheck, loadedSizeCheck, viewsCheck, branchesCheck, appliesCheck, secretsCheck];

/**
 * Reruns every enabled check against the store and records the result in `.sync-agent-docs/doctor.json`.
 * Writes nothing else. Throws when doctor itself cannot run; drift is in the result.
 */
export async function runDoctor(root: string, opts: DoctorOptions): Promise<DoctorResult> {
  const now = opts.now ?? new Date();
  await refuseTrackedDotDir(root, 'doctor');
  const storeDir = await resolveStore(root, opts.home, opts.store ? resolve(opts.store) : undefined, 'doctor');
  const store = await readStore(storeDir);
  if (!store) throw new Error(`doctor: ${storeDir} has no sync-agent-docs.json, so there is no store to check against. Run sync-agent-docs plan and sync-agent-docs apply first, or pass --store with your store folder.`);
  checkNetworkMarks(store, storeDir);
  const dot = await openDotDir(root, 'doctor');
  const config = await readChecksConfig(dot);
  let scan: Promise<ScanResult> | null = null;
  const ctx: DoctorContext = {
    root, home: opts.home, now, storeDir, store,
    decisions: await readDecisions(root, storeDir),
    lastPlan: await readJsonFile<Plan>(join(dot, 'plan.json'), 'doctor'),
    disabled: config.disabled,
    scan: () => (scan ??= collectScan(root, { home: opts.home, reposOnly: opts.reposOnly === true, now, crontabCommand: opts.crontabCommand })),
  };
  const live = opts.live ? liveCheck(opts) : null;
  const checks: CheckResult[] = [];
  for (const c of live ? [...CHECKS, live] : CHECKS) {
    if (config.disabled.has(c.id)) {
      checks.push({ id: c.id, status: 'disabled', findings: [] });
      continue;
    }
    let found;
    try {
      found = await c.run(ctx);
    } catch (err) {
      throw new Error(`doctor: the ${c.id} check could not run: ${(err as Error).message}`, { cause: err });
    }
    const findings: DoctorFinding[] = found.map((f) => ({ ...f, level: f.level ?? (config.accepted.has(f.key) ? 'accepted' : 'drift') }));
    // Every finding key starts with its check's id, so only a check that ran can say a key matched nothing.
    const keys = new Set(found.map((f) => f.key));
    for (const key of config.accepted) {
      if (key.startsWith(`${c.id}:`) && !keys.has(key)) findings.push({ key: `${c.id}:accepted-unused:${key}`, level: 'note', message: `accepted key ${key} matched nothing; remove it from .sync-agent-docs/checks.json` });
    }
    checks.push({ id: c.id, status: findings.some((f) => f.level === 'drift') ? 'drift' : 'clean', findings });
  }
  const result: DoctorResult = { schema: 1, at: now.toISOString(), root, store: storeDir, drift: checks.some((c) => c.status === 'drift'), checks, live: live && !config.disabled.has('live') ? live.results : null };
  await writeJsonAtomic(join(dot, 'doctor.json'), result);
  return result;
}

const MARK: Record<DoctorFinding['level'], string> = { drift: 'x', accepted: 'accepted', note: 'note' };

/** The terminal report: one line per check, its findings under it with their keys. */
export function renderDoctor(r: DoctorResult): string {
  const lines = [`sync-agent-docs doctor: ${printable(r.root)} against ${printable(r.store)}`, ''];
  for (const c of r.checks) {
    const drift = c.findings.filter((f) => f.level === 'drift').length;
    lines.push(`${c.status === 'drift' ? 'DRIFT' : c.status === 'disabled' ? 'off  ' : 'ok   '} ${c.id}${drift ? ` (${drift})` : ''}${c.status === 'disabled' ? ' (disabled in checks.json)' : ''}`);
    for (const f of c.findings) lines.push(`  ${MARK[f.level]}: ${printable(f.message)}`, `    key ${printable(f.key)}`);
    if (c.id === 'live' && r.live) lines.push(`  ${r.live.filter((t) => t.result === 'ok').length} of ${r.live.length} targets answered.`);
  }
  lines.push('');
  const failing = r.checks.filter((c) => c.status === 'drift').length;
  lines.push(failing
    ? `Drift found in ${failing} of ${r.checks.length} checks. To accept a finding, add its key to accepted in .sync-agent-docs/checks.json.`
    : 'No drift.');
  return lines.join('\n');
}
