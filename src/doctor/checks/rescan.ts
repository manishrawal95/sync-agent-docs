import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { readApplies } from '../../apply/branches.js';
import { lineHasSecret } from '../../claims/secrets.js';
import { storePath } from '../../compile/deps.js';
import { buildPlan, settledByStore } from '../../plan/build.js';
import type { PlanItem } from '../../plan/types.js';
import { shortPath } from '../../paths.js';
import { packageCommands } from '../../truth/commands.js';
import type { Check, DoctorContext, Found } from '../types.js';

/** `text` unless it looks like it holds a secret, then a fixed stand-in, so no value reaches the report. */
export const safe = (text: string, instead: string): string => (lineHasSecret(text) ? instead : text);

/** The newest unrolled apply's patch for each file, kept only while the file is as apply left it. */
async function pendingPatches(ctx: DoctorContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of (await readApplies(ctx.root, 'doctor')).applies) {
    if (entry.rolledBack) continue;
    for (const t of entry.targets ?? []) {
      const text = await readFile(t.file, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw new Error(`doctor: could not read ${shortPath(t.file, ctx.root, ctx.home)} (${err.code ?? err.message}). Check its permissions.`, { cause: err });
      });
      if (text !== null && createHash('sha256').update(text).digest('hex') === t.sha256) out.set(t.file, t.patch);
      else out.delete(t.file);
    }
  }
  return out;
}

/**
 * A conflict whose value the store already settled: names the lines that still disagree, and when apply
 * wrote a patch for every such file (one it may not change) that still applies, names those patches.
 * Null when unsettled.
 */
function settled(i: PlanItem, ctx: DoctorContext, patches: Map<string, string>): string | null {
  if (i.kind !== 'conflict') return null;
  const fact = ctx.store.facts.find((f) => f.entityId === i.entityId && f.attribute === i.attribute && i.candidates.includes(f.value));
  if (!fact) return null;
  const off = i.evidence.filter((e) => e.value !== fact.value);
  if (off.length === 0) return null;
  const show = (path: string) => shortPath(path, ctx.root, ctx.home);
  const lines = off.map((e) => `${show(e.path)}:${e.line} still says ${e.value}`).join(' and ');
  const pending = [...new Set(off.map((e) => patches.get(e.path)))];
  const next = pending.every((p) => p !== undefined)
    ? `sync-agent-docs could not change ${pending.length === 1 ? 'that file' : 'those files'}, so apply the ${pending.length === 1 ? 'patch' : 'patches'} it wrote by hand: ${pending.map(show).join(', ')}`
    : 'Run sync-agent-docs plan to settle it.';
  const subject = i.title.split(': ')[0] ?? i.title;
  return safe(`${subject}: the store says ${fact.value}, but ${lines}. ${next}`, 'a conflict the store settled still has a line that disagrees, and its text looks like it holds a secret. Run sync-agent-docs plan to settle it.');
}

/**
 * Plan items a fresh scan raises that the store has no answer and no fact for. Items the last plan.json
 * already showed and left open are one note: the owner has seen them.
 */
export const rescanCheck: Check = {
  id: 'rescan',
  async run(ctx) {
    const plan = await buildPlan({ scan: await ctx.scan(), decisions: ctx.decisions, store: ctx.storeDir, home: ctx.home, now: ctx.now, views: ctx.store.config.views });
    const seen = new Set((ctx.lastPlan?.items ?? []).map((i) => i.key));
    const open = plan.items.filter((i) => i.answer === null && !settledByStore(ctx.store.facts, i));
    const patches = await pendingPatches(ctx);
    const out: Found[] = open.filter((i) => !seen.has(i.key)).map((i) => ({
      key: `rescan:${i.key}`,
      message: settled(i, ctx, patches) ?? `new since the last plan: ${safe(i.title, `a ${i.kind} item whose text looks like it holds a secret`)}. Run sync-agent-docs plan to answer it.`,
    }));
    const known = open.length - out.length;
    if (known) out.push({ key: 'rescan:open', level: 'note', message: `${known} plan items are still open from the last plan. Run sync-agent-docs plan to answer them.` });
    return out;
  },
};

/** Store facts backed by a config file: that file must still say the same. */
export const factChecksCheck: Check = {
  id: 'fact-checks',
  async run(ctx) {
    const { facts } = await ctx.scan();
    const { root } = ctx.store.config;
    const out: Found[] = [];
    for (const f of ctx.store.facts) {
      const c = f.check;
      if (!c) continue;
      const path = storePath(c.path, root, ctx.home);
      if (facts.some((x) => x.kind === 'truth' && x.at.path === path && x.attribute === c.attribute && x.value === c.value)) continue;
      // Commands are read from package.json scripts by plan, not by the scan, so check them the same way.
      if (c.attribute === 'command' && basename(path) === 'package.json' && (await packageCommands(path))?.includes(c.value)) continue;
      const secret = lineHasSecret(c.value);
      const value = secret ? `sha256:${createHash('sha256').update(c.value).digest('hex').slice(0, 16)}` : c.value;
      const shown = shortPath(path, ctx.root, ctx.home);
      out.push({
        key: `fact-checks:${f.entityId}|${c.attribute}|${c.path}|${value}`,
        message: `${f.entityId} ${c.attribute} ${secret ? '(value hidden: it looks like a secret)' : c.value}: ${shown} no longer says so. Run sync-agent-docs scan and sync-agent-docs plan to settle it.`,
        path: shown,
      });
    }
    return out;
  },
};
