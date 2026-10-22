import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { insideStore } from '../src/store/inside.js';
import { readStore, writeJsonAtomic, writeStore } from '../src/store/io.js';
import type { Store } from '../src/store/types.js';

const temp = async () => realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-store-')));

const sample = (): Store => ({
  config: { schema: 1, root: '~/dev', repos: [{ name: 'shop', path: '~/dev/shop' }], agentFormats: ['claude'], views: { hosts: 'hosts.md', services: 'services.md', projects: 'projects' }, generated: {} },
  entities: [{ id: 'project:shop', kind: 'project', names: ['shop'], identifiers: {}, notes: '' }],
  facts: [{ entityId: 'project:shop', attribute: 'port', value: '3300', sources: [{ path: 'shop/ecosystem.config.cjs', line: 6 }], status: 'verified', check: { kind: 'config', path: 'shop/ecosystem.config.cjs', attribute: 'port', value: '3300' } }],
  secrets: [{ path: 'shop/AGENTS.md', line: 3, status: 'removed' }],
  decisions: [{ key: 'abc', kind: 'conflict', subject: 'project:shop|port', candidates: ['3000', '3300'], answer: '3300', decidedAt: '2026-10-22T00:00:00.000Z' }],
});

describe('store', () => {
  it('store round-trips through disk', async () => {
    const dir = await temp();
    const written = await writeStore(dir, sample());
    expect(written.map((p) => p.slice(dir.length + 1)).sort()).toEqual(['store/decisions.json', 'store/entities.json', 'store/facts.json', 'sync-agent-docs.json']);
    expect(await readStore(dir)).toEqual(sample());
  });

  it('readStore returns null without sync-agent-docs.json', async () => {
    expect(await readStore(await temp())).toBeNull();
  });

  it('a newer schema is refused with the file named', async () => {
    const dir = await temp();
    await writeStore(dir, sample());
    await writeFile(join(dir, 'store', 'facts.json'), JSON.stringify({ schema: 2, facts: [], secrets: [] }));
    await expect(readStore(dir)).rejects.toThrow(/facts\.json.*schema 2/);
  });

  it('a repo formats entry that is not a list of agent formats is refused, naming it', async () => {
    for (const formats of ['claude', ['claude', 'vim'], [3]]) {
      const dir = await temp();
      const store = sample();
      await writeStore(dir, store);
      await writeFile(join(dir, 'sync-agent-docs.json'), JSON.stringify({ ...store.config, repos: [{ name: 'shop', path: '~/dev/shop', formats }] }));
      await expect(readStore(dir)).rejects.toThrow(/sync-agent-docs\.json: repos\[0\]\.formats is .*, which is not a list of claude, agents, gemini, cursor, copilot/);
    }
  });

  it('writeJsonAtomic replaces a planted symlink instead of following it', async () => {
    const dir = await temp();
    const outside = join(await temp(), 'target.json');
    await writeFile(outside, 'untouched');
    await mkdir(join(dir, 'store'));
    await symlink(outside, join(dir, 'store', 'facts.json'));
    await writeJsonAtomic(join(dir, 'store', 'facts.json'), { schema: 1, facts: [], secrets: [] });
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect(JSON.parse(await readFile(join(dir, 'store', 'facts.json'), 'utf8'))).toEqual({ schema: 1, facts: [], secrets: [] });
  });

  it('a view or generated path that leaves the store is refused, naming sync-agent-docs.json and the key', async () => {
    for (const [over, key] of [
      [{ views: { hosts: '../victim.txt', services: 'services.md', projects: 'projects' } }, 'views.hosts'],
      [{ views: { hosts: 5, services: 'services.md', projects: 'projects' } }, 'views.hosts'],
      [{ generated: { '../.ssh/x': {} } }, 'generated["../.ssh/x"]'],
      [{ generated: { '/etc/x': {} } }, 'generated["/etc/x"]'],
    ] as const) {
      const dir = await temp();
      await writeStore(dir, sample());
      const config = JSON.parse(await readFile(join(dir, 'sync-agent-docs.json'), 'utf8')) as Record<string, unknown>;
      await writeJsonAtomic(join(dir, 'sync-agent-docs.json'), { ...config, ...over });
      await expect(readStore(dir)).rejects.toThrow(`${join(dir, 'sync-agent-docs.json')}: ${key}`);
    }
  });

  it('insideStore follows a symlinked folder out of the store and refuses it', async () => {
    const dir = await temp();
    const out = await temp();
    await symlink(out, join(dir, 'link'));
    expect(await insideStore(dir, 'link/hosts.md')).toBeNull();
    expect(await insideStore(dir, 'docs/new/hosts.md')).toBe(join(dir, 'docs', 'new', 'hosts.md'));
    expect(await insideStore(dir, '')).toBeNull();
    expect(await insideStore(dir, '.')).toBeNull();
  });
});
