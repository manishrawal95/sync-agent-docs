import { basename, isAbsolute, join, sep } from 'node:path';
import type { Store } from '../store/types.js';

/** A path as the store writes it (`~/...`, relative to the scan root, or absolute) back to absolute. */
export function storePath(path: string, root: string, home: string): string {
  if (path.startsWith('~/')) return join(home, path.slice(2));
  if (isAbsolute(path)) return path;
  return join(storePath(root, home, home), path);
}

/** The repo's sync-agent-docs.json entry, or a bare one named after its folder when it is not listed. */
export function repoEntry(repoPath: string, store: Store, home: string): Store['config']['repos'][number] {
  const { root, repos } = store.config;
  return repos.find((r) => storePath(r.path, root, home) === repoPath) ?? { name: basename(repoPath), path: repoPath };
}

/**
 * The entities a repo depends on, read from the store alone: its own project, every entity with a
 * fact sourced in the repo, and entities approved identity answers tie to one of those, followed until nothing new is added.
 */
export function repoDependencies(repoPath: string, store: Store, home: string): string[] {
  const { root } = store.config;
  const deps = new Set([`project:${repoEntry(repoPath, store, home).name}`]);
  for (const f of store.facts) {
    if (f.sources.some((s) => storePath(s.path, root, home).startsWith(repoPath + sep))) deps.add(f.entityId);
  }
  let grew = true;
  while (grew) {
    const before = deps.size;
    for (const d of store.decisions) {
      if (d.kind === 'identity' && d.answer === 'same' && d.candidates.some((id) => deps.has(id))) d.candidates.forEach((id) => deps.add(id));
    }
    grew = deps.size > before;
  }
  return [...deps].sort();
}
