import { printable } from '../report/terminal.js';
import type { Decision } from '../store/types.js';
import type { Edit, PlanItem } from './types.js';

export interface Asker { ask(question: string): Promise<string>; print(text: string): void }

const TRIES = 3;

/** Scanned text can carry terminal escapes, so every question and line goes out through `printable`. */
export const safeAsker = (asker: Asker): Asker => ({ ask: (q) => asker.ask(printable(q)), print: (t) => asker.print(printable(t)) });

export function toDecision(i: PlanItem, answer: string, now: Date): Decision {
  return { key: i.key, kind: i.kind, subject: i.subject, candidates: i.candidates, answer, decidedAt: now.toISOString() };
}

function describe(i: PlanItem, show: (path: string) => string): string {
  const lines = [`\n${i.title}`];
  for (const e of i.evidence) lines.push(`  ${e.value}  ${show(e.path)}:${e.line}${e.lastCommit ? `  ${e.lastCommit}` : ''}${e.kind === 'truth' ? '  (config)' : ''}`);
  for (const n of i.notes) lines.push(`  ${n}`);
  i.options.forEach((o, n) => {
    lines.push(`  ${n + 1}) ${o}${o === i.recommended ? ' (recommended)' : ''}`);
    for (const e of i.edits[o] ?? []) lines.push(...editLines(e, show));
  });
  return lines.join('\n');
}

/** An edit as `- before` / `+ after` under its place; a secret line shows only where it is. */
function editLines(e: Edit, show: (path: string) => string): string[] {
  const pad = '       ';
  const at = e.op === 'append' ? `${show(e.path)} (added at the end)` : `${show(e.path)}:${e.line}`;
  if (e.secret) return [`${pad}${at} (line removed, not shown)`];
  return [
    `${pad}${at}`,
    ...(e.op !== 'append' && e.before !== undefined ? [`${pad}- ${e.before}`] : []),
    ...(e.op !== 'remove' && e.after !== undefined ? [`${pad}+ ${e.after}`] : []),
  ];
}

/** Number or option text; empty takes the recommendation, or leaves the item open when there is none. */
function pick(i: PlanItem, reply: string): string | null | undefined {
  const r = reply.trim();
  if (r === '') return i.recommended ?? null;
  const n = Number(r);
  if (Number.isInteger(n) && n >= 1 && n <= i.options.length) return i.options[n - 1];
  return i.options.includes(r) ? r : undefined;
}

async function askOne(i: PlanItem, asker: Asker, show: (path: string) => string): Promise<string | null> {
  asker.print(describe(i, show));
  const hint = i.recommended ? `Enter for ${i.recommended}` : 'Enter to skip';
  for (let t = 0; t < TRIES; t++) {
    const got = pick(i, await asker.ask(`Pick 1-${i.options.length} (${hint}): `));
    if (got !== undefined) return got;
    asker.print(`  Type a number from 1 to ${i.options.length}, or one of: ${i.options.join(', ')}.`);
  }
  asker.print('  Left open.');
  return null;
}

/**
 * Asks every open item in tier order and fills its answer: the auto tier as one yes/no, the rest
 * one at a time. A rewrite is asked only once the conflict it follows has a value picked.
 * Returns the decisions made here.
 */
export async function askOpenQuestions(items: PlanItem[], raw: Asker, now: Date, show: (path: string) => string = (p) => p): Promise<Decision[]> {
  const asker = safeAsker(raw);
  const made: Decision[] = [];
  const earlier = items.filter((i) => i.tier === 'secret' && i.answeredBy === 'remembered');
  if (earlier.length) asker.print(`\n${earlier.map((i) => `  answered earlier: ${i.title} -> ${i.answer ?? ''}`).join('\n')}`);
  const answer = (i: PlanItem, a: string | null): void => {
    if (a === null) return;
    Object.assign(i, { answer: a, answeredBy: 'prompt' });
    made.push(toDecision(i, a, now));
  };
  const auto = items.filter((i) => i.tier === 'auto' && i.answer === null);
  let one = items.filter((i) => i.tier !== 'auto' && i.answer === null);
  if (auto.length) {
    asker.print(`\nFacts backed by config:\n${auto.map((i) => `  ${i.title}`).join('\n')}`);
    const reply = (await asker.ask(`Approve ${auto.length} auto items? [Y/n] `)).trim().toLowerCase();
    if (reply === '' || reply === 'y' || reply === 'yes') for (const i of auto) answer(i, 'approve');
    else one = [...auto, ...one];
  }
  const byKey = new Map(items.map((i) => [i.key, i]));
  for (const i of one) {
    if (i.follows) {
      const led = byKey.get(i.follows)?.answer;
      if (!led || !(led in i.edits)) continue;
    }
    answer(i, await askOne(i, asker, show));
  }
  return made;
}
