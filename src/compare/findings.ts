import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentFormat, Attribute, Fact, Finding, FindingType, Location, RepoInfo, SkippedFile, ValueGroup } from '../types.js';

export interface FindingsInput {
  facts: Fact[];
  corpus: Set<string>;
  secrets: Finding[];
  agentLines: { at: Location; text: string; agent: AgentFormat }[];
  /** Expands `~/` in path mentions; defaults to the user's home. */
  home?: string;
  /** Paths under the scan root (or home) are checked on disk; anything else may live on a server. */
  root?: string;
  /** Repos whose own config lists env names; only their docs' env names can be stale. */
  repos?: RepoInfo[];
  /** The machine pass did not run, so stale messages claim only the repos. */
  reposOnly?: boolean;
}
export interface FindingsResult { findings: Finding[]; agentTokens: number; duplicatedTokens: number; skipped: SkippedFile[] }

const COMPARED: Attribute[] = ['port', 'ip'];
const STALE_CHECKED: Attribute[] = ['ip', 'path', 'env'];
const ORDER: FindingType[] = ['conflict', 'global-local', 'possible-conflict', 'stale', 'duplicated', 'secret'];

export const tokensOf = (text: string): number => Math.ceil(text.length / 4);
const lineKey = (at: Location): string => `${at.path}\0${at.line}`;
/** `project:shop#2` → `shop`. */
export const entityName = (entityId: string): string => entityId.replace(/^[a-z]+:/, '').replace(/#\d+$/, '');

function groups(facts: Fact[]): ValueGroup[] {
  const byValue = new Map<string, ValueGroup>();
  for (const f of facts) {
    const g = byValue.get(f.value) ?? { value: f.value, at: [], truthBacked: false };
    g.at.push(f.at);
    g.truthBacked ||= f.kind === 'truth';
    byValue.set(f.value, g);
  }
  return [...byValue.values()].sort((a, b) => Number(b.truthBacked) - Number(a.truthBacked) || a.value.localeCompare(b.value));
}

/**
 * Truth and repo docs are the anchors. Anchors that disagree (for ports: a doc port outside the config set) are a conflict once a config
 * file backs one of the values (else a possible conflict). A machine-level claim that matches
 * no anchor is a global-local mismatch: the user's own agent config says something the repo does not.
 */
function compare(entityId: string, attribute: Attribute, facts: Fact[]): Finding[] {
  const name = entityName(entityId);
  const anchors = facts.filter((f) => f.kind === 'truth' || f.scope === 'repo');
  const anchorGroups = groups(anchors);
  const out: Finding[] = [];
  // A project may listen on several ports (dev, start, pm2) and a box may have several IPs
  // (public and Tailscale), so config values form a set: they disagree only when a doc names
  // a value no config backs. A doc IP outside the set may be the box's other address, so it
  // is only a possible conflict.
  const asSet = (attribute === 'port' || attribute === 'ip') && anchorGroups.some((g) => g.truthBacked);
  const anchorValues = new Set(anchorGroups.map((g) => g.value));
  const isMachine = (f: Fact): boolean => f.kind === 'claim' && f.scope === 'machine';
  if (asSet ? anchorGroups.some((g) => !g.truthBacked) : anchorGroups.length >= 2) {
    const type = anchorGroups.some((g) => g.truthBacked) && attribute !== 'ip' ? 'conflict' : 'possible-conflict';
    // A global agent file that agrees with one side carries that side's lines too, so settling the
    // conflict edits (or patches) it as well.
    const values = groups([...anchors, ...facts.filter((f) => isMachine(f) && anchorValues.has(f.value))]);
    out.push({ type, entityId, attribute, values, message: `${name} ${attribute} has ${values.length} values: ${values.map((g) => g.value).join(', ')}` });
  }
  const machineGroups = groups(facts.filter((f) => isMachine(f) && !anchorValues.has(f.value)));
  if (anchorGroups.length > 0) {
    for (const g of machineGroups) {
      // Like a doc's, a global config's IP outside the config set may be the box's other address.
      out.push({ type: attribute === 'ip' ? 'possible-conflict' : 'global-local', entityId, attribute, values: [g, ...anchorGroups], message: `your global agent config says ${name} ${attribute} ${g.value}; the repo says ${anchorGroups.map((a) => a.value).join(', ')}` });
    }
  } else if (machineGroups.length >= 2) {
    out.push({ type: 'possible-conflict', entityId, attribute, values: machineGroups, message: `${name} ${attribute} has ${machineGroups.length} values: ${machineGroups.map((g) => g.value).join(', ')}` });
  }
  return out;
}

const under = (path: string, dir: string | undefined): boolean => !!dir && (path === dir || path.startsWith(`${dir}/`));

/** The repo holding a file, by longest path prefix (nested repos win). */
function repoOf(path: string, repos: RepoInfo[]): RepoInfo | undefined {
  return repos.filter((r) => under(path, r.path)).sort((a, b) => b.path.length - a.path.length)[0];
}

/** Missing paths are the finding; a path that cannot be checked (EACCES) is noted and not called stale. */
async function exists(path: string, home: string, skipped: SkippedFile[]): Promise<boolean> {
  try {
    await access(path.startsWith('~/') ? join(home, path.slice(2)) : path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    skipped.push({ path, reason: 'unreadable', note: code ?? 'check failed' });
    return true;
  }
}

/** Whether `~/top/...` names a folder that exists here; a bare `~/file` has no top folder. */
async function hasLocalTop(path: string, home: string): Promise<boolean> {
  const [top, ...rest] = path.slice(2).split('/');
  if (!top || rest.length === 0) return false;
  return stat(join(home, top)).then((s) => s.isDirectory(), (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw new Error(`scan: could not check ${join(home, top)} (${err.code ?? err.message}). Check its permissions.`, { cause: err });
  });
}

export async function computeFindings(input: FindingsInput): Promise<FindingsResult> {
  const home = input.home ?? homedir();
  const secretLines = new Set(input.secrets.flatMap((s) => s.at ?? []).map(lineKey));
  const findings: Finding[] = [...input.secrets];
  const skipped: SkippedFile[] = [];

  const linked = new Map<string, Fact[]>();
  for (const f of input.facts) {
    if (!f.entityId || !COMPARED.includes(f.attribute)) continue;
    const key = `${f.entityId}\0${f.attribute}`;
    linked.set(key, [...(linked.get(key) ?? []), f]);
  }
  for (const [key, facts] of linked) {
    const [entityId = '', attribute] = key.split('\0') as [string, Attribute];
    findings.push(...compare(entityId, attribute, facts));
  }

  const claims = input.facts.filter((f) => f.kind === 'claim' && !secretLines.has(lineKey(f.at)));
  const truthValues = new Set(input.facts.filter((f) => f.kind === 'truth').map((f) => `${f.attribute}\0${f.value}`));
  const repos = input.repos ?? [];
  // An env name set in Vercel or on a server is invisible here, so only a repo that lists its env names locally can prove one stale.
  const envRepos = new Set(input.facts.filter((f) => f.kind === 'truth' && f.attribute === 'env').map((f) => repoOf(f.at.path, repos)?.path));
  const checkable = (f: Fact): boolean => {
    if (f.attribute === 'env') return f.scope === 'repo' && envRepos.has(repoOf(f.at.path, repos)?.path ?? '\0');
    if (f.attribute === 'path') return f.value.startsWith('~/') || under(f.value, home) || under(f.value, input.root);
    return true;
  };
  // A value already scored as disagreeing is not also counted as stale. A possible conflict is
  // unscored, so an IP there that no config knows (a dead box) is still stale.
  const inConflict = new Set(findings.filter((f) => f.type === 'conflict' || f.type === 'global-local')
    .flatMap((f) => (f.values ?? []).filter((g) => !g.truthBacked).map((g) => `${f.attribute}\0${g.value}`)));
  const stale = new Map<string, Fact[]>();
  for (const f of claims) {
    if (!STALE_CHECKED.includes(f.attribute) || !checkable(f)) continue;
    const key = `${f.attribute}\0${f.value}`;
    if (truthValues.has(key) || input.corpus.has(f.value) || inConflict.has(key)) continue;
    stale.set(key, [...(stale.get(key) ?? []), f]);
  }
  for (const [key, facts] of stale) {
    const [attribute, value = ''] = key.split('\0') as [Attribute, string];
    if (attribute === 'path' && (await exists(value, home, skipped))) continue;
    // `~/x` on a server looks the same as on this machine: only a path whose top folder exists here can be stale.
    if (attribute === 'path' && value.startsWith('~/') && !(await hasLocalTop(value, home))) continue;
    const message = input.reposOnly ? `${attribute} ${value} is in your docs but in no scanned repo config` : `${attribute} ${value} is in your docs but in no config file, and nothing on this machine uses it`;
    findings.push({ type: 'stale', attribute, values: groups(facts), at: facts.map((f) => f.at), message });
  }

  const lineText = new Map(input.agentLines.map((l) => [lineKey(l.at), l.text]));
  const copies = new Map<string, Fact[]>();
  for (const f of claims) {
    if (!f.entityId || !f.agent) continue;
    const key = `${f.entityId}\0${f.attribute}\0${f.value}`;
    copies.set(key, [...(copies.get(key) ?? []), f]);
  }
  const duplicatedLines = new Set<string>();
  for (const [key, facts] of copies) {
    const files = [...new Set(facts.map((f) => f.at.path))];
    if (files.length < 2) continue;
    const [entityId = '', attribute, value] = key.split('\0') as [string, Attribute, string];
    const repeats = facts.slice(1).map((f) => f.at);
    for (const at of repeats) duplicatedLines.add(lineKey(at));
    findings.push({
      type: 'duplicated', entityId, attribute, values: groups(facts), at: facts.map((f) => f.at),
      tokens: repeats.reduce((sum, at) => sum + tokensOf(lineText.get(lineKey(at)) ?? ''), 0),
      message: `${entityName(entityId)} ${attribute} ${value} is repeated in ${files.length} agent files`,
    });
  }

  findings.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  return {
    findings,
    skipped,
    agentTokens: input.agentLines.reduce((sum, l) => sum + tokensOf(l.text), 0),
    // Each repeated line counts once, even when it repeats several facts.
    duplicatedTokens: [...duplicatedLines].reduce((sum, k) => sum + tokensOf(lineText.get(k) ?? ''), 0),
  };
}
