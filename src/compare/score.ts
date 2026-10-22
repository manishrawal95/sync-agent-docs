import type { Finding, FindingType } from '../types.js';

export const COST: Partial<Record<FindingType, number>> = { conflict: 6, 'global-local': 6, stale: 3, secret: 10 };
export const DUPLICATED_MAX = 20;

/** 100 minus a fixed cost per finding and up to 20 for duplicated agent-file tokens; never below 0. */
export function scoreOf(findings: Finding[], agentTokens: number, duplicatedTokens: number): number {
  const cost = findings.reduce((sum, f) => sum + (COST[f.type] ?? 0), 0);
  return Math.max(0, 100 - cost - Math.round((DUPLICATED_MAX * duplicatedTokens) / Math.max(agentTokens, 1)));
}
