import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aiPrompt, aiQuestions, aiSubject, detectAgentCli, runsWithToolsOff } from '../ai/pass.js';
import { openDotDir, refuseTrackedDotDir } from '../dotdir.js';
import { checkStorePath, resolveReal, shortPath } from '../paths.js';
import { runScan, type ScanOptions } from '../scan.js';
import { readJsonFile, readStore, writeJsonAtomic } from '../store/io.js';
import type { Decision } from '../store/types.js';
import { printable } from '../report/terminal.js';
import type { ScanResult } from '../types.js';
import { detectViewEdits } from '../views/edits.js';
import { exists } from '../compile/content.js';
import { detectCompiledEdits } from '../compile/edits.js';
import { buildPlan, settledByStore } from './build.js';
import { readDecisions, rememberDecisions } from './decisions.js';
import { askOpenQuestions, safeAsker, toDecision, type Asker } from './prompt.js';
import { TIERS, type Plan, type PlanItem } from './types.js';

export interface PlanOptions extends ScanOptions {
  store?: string; useScan?: boolean; acceptAuto?: boolean; asker?: Asker;
  /** Opt-in pass through the user's agent CLI, found on `path`. */
  ai?: { path: string };
  /** Where a note goes when there is no asker to print it. */
  note?: (text: string) => void;
}

/**
 * `--store`, else the store the last apply used (only an absolute path inside home), else
 * `<home>/dev/truth`. A store an apply wrote that has since gone is refused: starting a new one
 * there would drop every answer it held without a word.
 */
export async function resolveStore(root: string, home: string, flag?: string, stage = 'plan'): Promise<string> {
  if (flag) return checkStorePath(flag, home, '--store', stage, 'Pass a folder inside your home folder.');
  const path = join(root, '.sync-agent-docs', 'applies.json');
  const applies = (await readJsonFile<{ applies: { store: unknown; repos?: unknown[]; rolledBack?: unknown }[] }>(path, stage))?.applies ?? [];
  const last = applies.at(-1)?.store;
  if (last === undefined) return join(home, 'dev', 'truth');
  const dir = await checkStorePath(last, home, path, stage, 'Pass --store with the store folder you want.');
  if (applies.some((a) => a.store === last && !a.rolledBack && a.repos?.length) && !(await exists(dir))) {
    throw new Error(`${stage}: ${path} says the last apply wrote the store at ${dir}, but it is gone. Move it back, or pass --store with where it is now (or with a new folder to start over).`);
  }
  return dir;
}

/** The last scan, refused when it was made for a different folder. */
async function latestScan(root: string): Promise<ScanResult> {
  const path = join(root, '.sync-agent-docs', 'scan.json');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`plan: ${path} does not exist. Run sync-agent-docs scan first, or drop --use-scan.`, { cause: err });
    throw new Error(`plan: could not read ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Check its permissions.`, { cause: err });
  }
  let scan: ScanResult;
  try {
    scan = JSON.parse(text) as ScanResult;
  } catch (err) {
    throw new Error(`plan: ${path} is not valid JSON. Run sync-agent-docs scan again.`, { cause: err });
  }
  const want = await resolveReal(root, 'plan');
  if (typeof scan.root !== 'string' || (await resolveReal(scan.root, 'plan')) !== want) {
    throw new Error(`plan: ${path} scan.json was made for ${printable(String(scan.root))}, not ${want}. Run sync-agent-docs scan again, or drop --use-scan.`);
  }
  return scan;
}

/**
 * Asks the user's agent CLI which entity each unlinked doc line is about, after showing the cost
 * and getting a yes. Its suggestions come back as open identity questions, never as answers.
 */
async function aiPass(plan: Plan, decisions: Decision[], opts: PlanOptions & { ai: { path: string } }, show: (p: string) => string): Promise<PlanItem[]> {
  const asker = opts.asker && safeAsker(opts.asker);
  const say = (t: string): void => (asker ? asker.print(t) : opts.note?.(printable(t)));
  const cli = await detectAgentCli(opts.ai.path);
  if (!cli) {
    say('plan --ai: no claude, codex or gemini command was found on PATH, so the AI pass was skipped.');
    return [];
  }
  if (!runsWithToolsOff(cli)) {
    say(`plan --ai: found ${cli}, but sync-agent-docs cannot confirm a way to run it with tools off, so the AI pass was skipped. Install claude to use --ai.`);
    return [];
  }
  if (!asker) {
    say(`plan --ai: asking before sending anything to ${cli} needs a terminal, so the AI pass was skipped. Run sync-agent-docs plan --ai in a terminal.`);
    return [];
  }
  const decided = new Set(decisions.filter((d) => d.kind === 'ai-link').map((d) => d.subject));
  const secretLines = new Set(plan.items.filter((i) => i.tier === 'secret').flatMap((i) => (i.edits['rotate-remove'] ?? []).map((e) => `${e.path}:${e.line}`)));
  const ask = aiPrompt(plan.facts.filter((f) => !decided.has(aiSubject(f, show))), plan.entities, secretLines);
  if (!ask) {
    say('plan --ai: every doc line is already linked or answered, so nothing needs sending.');
    return [];
  }
  const reply = (await asker.ask(`Send ${ask.lines} lines (~${ask.tokens} tokens) to ${cli}? [y/N] `)).trim().toLowerCase();
  if (reply !== 'y' && reply !== 'yes') {
    say('plan --ai: Nothing was sent.');
    return [];
  }
  const { items, notes } = await aiQuestions(cli, ask, plan.entities, { path: opts.ai.path, show });
  for (const n of notes) say(n);
  const remembered = new Map(decisions.map((d) => [d.key, d]));
  for (const i of items) {
    const d = remembered.get(i.key);
    if (d && i.options.includes(d.answer)) Object.assign(i, { answer: d.answer, answeredBy: 'remembered' });
  }
  return items;
}

/** An answer in the last plan.json, and who gave it there. */
type TypedAnswer = { answer: string; by: PlanItem['answeredBy'] };

/**
 * Answers typed into the last plan.json by hand, by item key, so planning again keeps them. A
 * plan.json that cannot be read is noted, not fatal: plan writes a fresh one.
 */
async function handAnswers(root: string, note: ((t: string) => void) | undefined): Promise<Map<string, TypedAnswer>> {
  const path = join(root, '.sync-agent-docs', 'plan.json');
  let last: Plan | null;
  try {
    last = await readJsonFile<Plan>(path, 'plan');
  } catch (err) {
    note?.(printable(`${(err as Error).message} Answers typed into it were not carried over; plan writes a new one.`));
    return new Map();
  }
  const out = new Map<string, TypedAnswer>();
  for (const i of last?.items ?? []) if (i.answer !== null) out.set(i.key, { answer: i.answer, by: i.answeredBy });
  return out;
}

/** Scans (or reads the last scan), builds the plan, asks what is open, remembers answers, writes plan.json. */
export async function runPlan(root: string, opts: PlanOptions): Promise<Plan> {
  const now = opts.now ?? new Date();
  await refuseTrackedDotDir(root, 'plan');
  const scan = opts.useScan ? await latestScan(root) : await runScan(root, opts);
  const storeDir = await resolveStore(root, opts.home, opts.store);
  const store = await readStore(storeDir);
  const decisions = await readDecisions(root, storeDir);
  const show = (p: string): string => shortPath(p, root, opts.home);
  const plan = await buildPlan({
    scan, decisions, store: storeDir, home: opts.home, now, views: store?.config.views,
    viewItems: store ? [...(await detectViewEdits(storeDir, store)), ...(await detectCompiledEdits(root, store, { storeDir, home: opts.home }))] : [],
  });
  for (const i of plan.items) if (i.answer === null && store && settledByStore(store.facts, i)) Object.assign(i, { answer: 'approve', answeredBy: 'remembered' });
  if (opts.ai) plan.items.push(...(await aiPass(plan, decisions, { ...opts, ai: opts.ai }, show)));
  const typed = await handAnswers(root, opts.note);
  for (const i of plan.items) {
    const last = typed.get(i.key);
    if (!last || last.answer === i.answer || !i.options.includes(last.answer)) continue;
    // An earlier remembered answer is stale when nothing settles the item now. Any other earlier
    // answer that differs from a settled item's is a hand edit: plan.json is the edit surface.
    if (i.answer === null && last.by === 'remembered') continue;
    Object.assign(i, { answer: last.answer, answeredBy: 'hand' });
  }
  const made = [];
  if (opts.acceptAuto) {
    for (const i of plan.items) {
      if (i.tier !== 'auto' || i.answer !== null) continue;
      Object.assign(i, { answer: 'approve', answeredBy: 'flag' });
      made.push(toDecision(i, 'approve', now));
    }
  }
  if (opts.asker) made.push(...(await askOpenQuestions(plan.items, opts.asker, now, show)));
  if (made.length) await rememberDecisions(root, made);
  const dir = await openDotDir(root, 'plan');
  await writeJsonAtomic(join(dir, 'plan.json'), plan);
  return plan;
}

export function renderPlanSummary(plan: Plan): string {
  const open = plan.items.filter((i) => i.answer === null).length;
  const lines = [`Plan: ${plan.items.length} items, ${plan.items.length - open} answered, ${open} open.`];
  for (const tier of TIERS) {
    const items = plan.items.filter((i) => i.tier === tier);
    if (items.length) lines.push(`  ${tier.padEnd(9)} ${items.length}${items.some((i) => i.answer === null) ? ` (${items.filter((i) => i.answer === null).length} open)` : ''}`);
  }
  lines.push(`Wrote ${join(plan.root, '.sync-agent-docs', 'plan.json')}`);
  lines.push(open ? `Next: sync-agent-docs apply. It leaves the ${open} open items alone; run sync-agent-docs plan again to answer them.` : 'Next: sync-agent-docs apply');
  return lines.join('\n');
}
