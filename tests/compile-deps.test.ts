import { describe, expect, it } from 'vitest';
import { repoDependencies, storePath } from '../src/compile/deps.js';
import type { Store, StoreFact } from '../src/store/types.js';

const HOME = '/home/u';
const fact = (entityId: string, path: string): StoreFact => ({ entityId, attribute: 'port', value: '1', sources: [{ path, line: 1 }], status: 'verified' });
const store = (facts: StoreFact[], decisions: Store['decisions'] = []): Store => ({
  config: { schema: 1, root: '~/dev', repos: [{ name: 'shop', path: '~/dev/shop' }, { name: 'blog', path: '~/dev/blog' }], agentFormats: ['claude'], views: { hosts: 'hosts.md', services: 'services.md', projects: 'projects' }, generated: {} },
  entities: [], facts, secrets: [], decisions,
});

describe('storePath', () => {
  it('turns store paths back into absolute ones', () => {
    expect(storePath('shop/README.md', '~/dev', HOME)).toBe('/home/u/dev/shop/README.md');
    expect(storePath('~/.ssh/config', '~/dev', HOME)).toBe('/home/u/.ssh/config');
    expect(storePath('/etc/hosts', '~/dev', HOME)).toBe('/etc/hosts');
  });
});

describe('repoDependencies', () => {
  it('takes the repo project and entities sourced in the repo, not ones sourced only in a sibling', () => {
    const s = store([
      fact('project:shop', 'shop/package.json'),
      fact('host:hetzner', 'shop/ecosystem.config.cjs'),
      fact('app:feed', 'blog/README.md'),
      fact('host:box', '~/.ssh/config'),
    ]);
    expect(repoDependencies('/home/u/dev/shop', s, HOME)).toEqual(['host:hetzner', 'project:shop']);
  });

  it('counts the project even with no facts of its own', () => {
    expect(repoDependencies('/home/u/dev/blog', store([]), HOME)).toEqual(['project:blog']);
  });

  it('pulls in entities an approved identity answer ties to a dependency', () => {
    const decision = (answer: string): Store['decisions'][number] => ({ key: 'identity|hetzner', kind: 'identity', subject: 'hetzner', candidates: ['host:hetzner', 'app:hetzner'], answer, decidedAt: '2026-10-22T00:00:00Z' });
    const facts = [fact('host:hetzner', 'shop/.env'), fact('app:hetzner', 'blog/x.md')];
    expect(repoDependencies('/home/u/dev/shop', store(facts, [decision('same')]), HOME)).toEqual(['app:hetzner', 'host:hetzner', 'project:shop']);
    expect(repoDependencies('/home/u/dev/shop', store(facts, [decision('different')]), HOME)).toEqual(['host:hetzner', 'project:shop']);
  });
});
