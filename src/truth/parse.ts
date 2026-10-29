import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { readTextSafe } from '../discover/sources.js';
import type { Entity, Fact, RepoInfo, SkippedFile, SourceFile, SourceFormat, TruthResult } from '../types.js';
import { parseCompose } from './formats/compose.js';
import { parseGhHosts, parseGithubWorkflow, parseGitConfig, parseLaunchAgent } from './formats/corpus-only.js';
import { parseEnvNames } from './formats/env.js';
import { parseFly } from './formats/fly.js';
import { parsePackageJson } from './formats/package-json.js';
import { parsePm2 } from './formats/pm2.js';
import { parseProcfile } from './formats/procfile.js';
import { parseSshConfig } from './formats/ssh-config.js';
import { parseVercelJson, parseVercelProject } from './formats/vercel.js';
import { parseWranglerJson, parseWranglerToml } from './formats/wrangler.js';
import type { FormatParser, Parsed } from './parsed.js';

const run = promisify(execFile);

const PARSERS: Partial<Record<SourceFormat, FormatParser>> = {
  'package-json': parsePackageJson,
  'vercel-json': parseVercelJson,
  'vercel-project': parseVercelProject,
  pm2: parsePm2,
  compose: parseCompose,
  fly: parseFly,
  procfile: parseProcfile,
  'ssh-config': parseSshConfig,
  'launch-agent': parseLaunchAgent,
  'github-workflow': parseGithubWorkflow,
};

/** Formats whose files hold secrets: streamed line by line, never read whole. */
const STREAMED: Partial<Record<SourceFormat, (path: string) => Promise<Parsed>>> = {
  env: (path) => parseEnvNames(path),
  'shell-rc': (path) => parseEnvNames(path, true),
  'gh-hosts': parseGhHosts,
  'git-config': parseGitConfig,
};

function parserFor(file: SourceFile): FormatParser | undefined {
  if (file.format === 'wrangler') return file.path.endsWith('.toml') ? parseWranglerToml : parseWranglerJson;
  return PARSERS[file.format];
}

/** Line number only (smol-toml's `line`, yaml's `linePos`): parser messages can quote the file, and the file can hold secrets. */
function parseNote(file: SourceFile, err: unknown): string {
  const found = err as { line?: unknown; linePos?: { line?: unknown }[] };
  const line = found.line ?? found.linePos?.[0]?.line;
  const where = typeof line === 'number' ? ` near line ${line}` : '';
  return `could not parse ${file.path} as ${file.format}${where}; fix its syntax to include it`;
}

/** A package.json below the repo root with its own name is a separate app (a monorepo's landing page, say), not the project. */
function asNestedApp(file: SourceFile, result: Parsed | { skipped: SkippedFile }, repoPaths: Map<string | null, string>): Parsed | { skipped: SkippedFile } {
  const name = 'skipped' in result ? undefined : result.projectNames?.[0];
  if ('skipped' in result || file.format !== 'package-json' || !name || dirname(file.path) === repoPaths.get(file.repo)) return result;
  return { ...result, projectNames: [], apps: [name], facts: (result.facts ?? []).map((f) => ({ ...f, app: name })) };
}

async function readParsed(file: SourceFile): Promise<Parsed | { skipped: SkippedFile }> {
  const streamed = STREAMED[file.format];
  if (streamed) {
    try {
      return await streamed(file.path);
    } catch (err) {
      return { skipped: { path: file.path, reason: 'unreadable', note: (err as NodeJS.ErrnoException).code ?? 'read failed' } };
    }
  }
  const parser = parserFor(file);
  if (!parser) return {};
  const read = await readTextSafe(file.path);
  if ('skipped' in read) return read;
  try {
    return parser(read.text);
  } catch (err) {
    return { skipped: { path: file.path, reason: 'unreadable', note: parseNote(file, err) } };
  }
}

/**
 * Remote URLs can embed a token in the user part or the query; keep scheme, host and path only.
 * Everything up to the last `@` goes first, so a password holding `/` cannot pass for a host and a
 * path. An `@` inside the path itself is read the same way: the result may name the wrong host, but
 * never keeps a password. A `?` or `#` with an `@` after it may sit inside a password, so that URL
 * is dropped, as is one that still does not parse. scp syntax keeps a bare `git@`, which holds no
 * password, and loses anything else before the host.
 */
export function withoutCredentials(remote: string): string {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(remote)?.[0];
  if (scheme) {
    const rest = remote.slice(scheme.length);
    const query = rest.search(/[?#]/);
    if (query !== -1 && rest.includes('@', query)) return '';
    try {
      const url = new URL(scheme + (rest.split(/[?#]/)[0] ?? '').split('@').at(-1));
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      // An unparsable remote has no safe part to keep; the project is still found by its folder.
      return '';
    }
  }
  const at = remote.lastIndexOf('@');
  // A local path (`/srv/a@b/r.git`) holds no credential; only scp syntax has a user part.
  if (at === -1 || /^[/.~]/.test(remote) || /^[\w.-]+@[^@:/]+:/.test(remote)) return remote;
  return remote.slice(at + 1);
}

/**
 * A truth fact is cited by file:line, never by its text: a config line can hold a secret
 * next to the value (`args: '-p 3000 --token ...'`).
 */
function factText(attribute: string, value: string): string {
  return attribute === 'env' ? value : `${attribute} ${value}`;
}

/** The origin URL without credentials. No origin is normal; any other git failure is noted in skipped. */
async function gitRemote(repo: RepoInfo, skipped: SkippedFile[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['-C', repo.path, 'remote', 'get-url', 'origin'], { env: { ...process.env, LC_ALL: 'C' } });
    return withoutCredentials(stdout.trim()) || undefined;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (/No such remote/i.test(e.stderr ?? '')) return undefined;
    // git's own message can echo a remote URL, so only a short reason is kept.
    const reason = typeof e.code === 'string' ? e.code : /dubious ownership/i.test(e.stderr ?? '') ? 'dubious ownership' : 'not a usable git repo';
    skipped.push({ path: repo.path, reason: 'unreadable', note: `git remote: ${reason}` });
    return undefined;
  }
}

const GENERIC_NAMES = new Set([
  'api', 'app', 'web', 'www', 'site', 'backend', 'frontend', 'server', 'client', 'docs', 'core', 'cli',
  'admin', 'worker', 'workers', 'service', 'services', 'infra', 'config', 'scripts', 'tools', 'shared', 'common', 'lib',
]);

class EntityIndex {
  readonly entities: Entity[] = [];
  private readonly projects = new Map<string, Entity>();
  private readonly apps = new Map<string, Entity>();

  constructor(private readonly repoPaths: Map<string | null, string>) {}

  project(repo: string): Entity {
    let e = this.projects.get(repo);
    if (!e) {
      // A repo named like a common word (`api`, `web`) is only that project on lines inside it.
      const within = GENERIC_NAMES.has(repo.toLowerCase()) ? this.repoPaths.get(repo) : undefined;
      e = { id: `project:${repo}`, kind: 'project', names: [repo], identifiers: {}, ...(within ? { within } : {}) };
      this.projects.set(repo, e);
      this.entities.push(e);
    }
    return e;
  }

  /** An app named like its repo's project is that project: same repo is a hard identifier. */
  app(repo: string | null, name: string): Entity {
    if (repo !== null) {
      const project = this.project(repo);
      if (project.names.some((n) => n.toLowerCase() === name.toLowerCase())) return project;
    }
    const key = `${repo ?? '~'}/${name}`;
    let e = this.apps.get(key);
    if (!e) {
      // `shop-api` names its project and is safe to match anywhere; `web` is scoped to its repo.
      const within = repo !== null && !name.toLowerCase().includes(repo.toLowerCase()) ? this.repoPaths.get(repo) : undefined;
      e = { id: `app:${key}`, kind: 'app', names: [name], identifiers: {}, ...(within ? { within } : {}) };
      this.apps.set(key, e);
      this.entities.push(e);
    }
    return e;
  }

  host(alias: string): Entity {
    const id = `host:${alias}`;
    let e = this.entities.find((x) => x.id === id);
    if (!e) {
      e = { id, kind: 'host', names: [alias], identifiers: {} };
      this.entities.push(e);
    }
    return e;
  }
}

function addName(entity: Entity, name: string): void {
  if (!entity.names.some((n) => n.toLowerCase() === name.toLowerCase())) entity.names.push(name);
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Turns config files into entities, truth facts and the token corpus used for stale checks. */
export async function parseTruth(files: SourceFile[], repos: RepoInfo[]): Promise<TruthResult> {
  const repoPaths = new Map<string | null, string>(repos.map((r) => [r.name, r.path]));
  const index = new EntityIndex(repoPaths);
  const facts: Fact[] = [];
  const corpus = new Set<string>();
  const skipped: SkippedFile[] = [];

  for (const repo of repos) {
    const project = index.project(repo.name);
    const remote = await gitRemote(repo, skipped);
    if (remote) {
      project.identifiers.gitRemote = remote;
      corpus.add(remote);
    }
    corpus.add(repo.path);
  }

  const parsed = await Promise.all(files.map(async (file) => ({ file, result: asNestedApp(file, await readParsed(file), repoPaths) })));
  // Project names and app names first, so a fact's app resolves the same way whatever the file order.
  for (const { file, result } of parsed) {
    if ('skipped' in result) continue;
    if (file.repo !== null) {
      const project = index.project(file.repo);
      for (const n of result.projectNames ?? []) addName(project, n);
      Object.assign(project.identifiers, result.identifiers ?? {});
    }
  }
  for (const { file, result } of parsed) {
    if ('skipped' in result) {
      skipped.push(result.skipped);
      continue;
    }
    const base = { kind: 'truth' as const, scope: file.scope, agent: null };
    for (const app of result.apps ?? []) index.app(file.repo, app);
    for (const h of result.hosts ?? []) {
      const host = index.host(h.alias);
      for (const a of h.aliases ?? []) addName(host, a);
      if (!h.hostName) continue;
      addName(host, h.hostName);
      if (IPV4.test(h.hostName)) host.identifiers.ip = h.hostName;
      facts.push({
        ...base, entityId: host.id, attribute: IPV4.test(h.hostName) ? 'ip' : 'domain', value: h.hostName,
        at: { path: file.path, line: h.line }, lineText: factText('host', h.hostName),
      });
    }
    for (const f of result.facts ?? []) {
      const entity = f.app ? index.app(file.repo, f.app) : file.repo !== null ? index.project(file.repo) : null;
      facts.push({ ...base, entityId: entity?.id ?? null, attribute: f.attribute, value: f.value, at: { path: file.path, line: f.line }, lineText: factText(f.attribute, f.value) });
    }
    for (const t of result.corpus ?? []) corpus.add(t);
  }
  for (const f of facts) corpus.add(f.value);
  for (const e of index.entities) for (const n of e.names) corpus.add(n);
  return { entities: index.entities, facts, corpus, skipped };
}
