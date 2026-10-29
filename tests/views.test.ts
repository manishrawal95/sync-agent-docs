import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Store } from '../src/store/types.js';
import { detectViewEdits } from '../src/views/edits.js';
import { VIEW_HEADER, blockHash, mergeView, parseBlockFacts, readBlocks, renderBlocks } from '../src/views/render.js';

const store = (): Store => ({
  config: { schema: 1, root: '~/dev', repos: [], agentFormats: ['claude'], views: { hosts: 'hosts.md', services: 'services.md', projects: 'projects' }, generated: {} },
  entities: [
    { id: 'host:hetzner', kind: 'host', names: ['hetzner'], identifiers: { ip: '100.64.1.10' }, notes: '' },
    { id: 'app:api', kind: 'app', names: ['api'], identifiers: {}, notes: 'Restart with pm2.' },
    { id: 'project:shop', kind: 'project', names: ['shop'], identifiers: {}, notes: '' },
  ],
  facts: [
    { entityId: 'host:hetzner', attribute: 'ip', value: '100.64.1.10', sources: [{ path: '~/.ssh/config', line: 2 }], status: 'verified' },
    { entityId: 'app:api', attribute: 'port', value: '8100', sources: [], status: 'inferred' },
    { entityId: 'project:shop', attribute: 'port', value: '3300', sources: [], status: 'verified' },
    { entityId: 'project:shop', attribute: 'command', value: 'npm run test', sources: [], status: 'verified' },
  ],
  secrets: [], decisions: [],
});

describe('views', () => {
  it('new hosts.md has the header, one block per host and the facts table', () => {
    const blocks = renderBlocks(store());
    expect(Object.keys(blocks).sort()).toEqual(['hosts.md', 'projects/shop.md', 'services.md']);
    const text = mergeView(null, 'Hosts', blocks['hosts.md'] ?? []);
    expect(text.startsWith(`# Hosts\n\n${VIEW_HEADER}\n`)).toBe(true);
    expect(text).toContain('<!-- sync-agent-docs:begin host:hetzner -->');
    expect(text).toContain('| ip | `100.64.1.10` | verified |');
    expect(text).toContain('<!-- sync-agent-docs:end host:hetzner -->');
    expect(mergeView(null, 'Services', blocks['services.md'] ?? [])).toContain('Restart with pm2.');
  });

  it('prose outside blocks survives a regenerate', () => {
    const blocks = renderBlocks(store())['hosts.md'] ?? [];
    const first = mergeView(null, 'Hosts', blocks);
    const edited = `${first}\nMy own note about the box.\n`;
    const s = store();
    s.facts = s.facts.map((f) => (f.entityId === 'host:hetzner' ? { ...f, value: '100.64.1.11' } : f));
    const again = mergeView(edited, 'Hosts', renderBlocks(s)['hosts.md'] ?? []);
    expect(again).toContain('My own note about the box.');
    expect(again).toContain('| ip | `100.64.1.11` | verified |');
    expect(again).not.toContain('100.64.1.10 |');
    expect(again.split(VIEW_HEADER)).toHaveLength(2);
  });

  it('adopting a hand-written hosts.md keeps every original line', () => {
    const original = '# Hosts\n\nThe box lives in Helsinki.\n\n| host | ip |\n|---|---|\n| hetzner | 100.64.1.10 |\n';
    const merged = mergeView(original, 'Hosts', renderBlocks(store())['hosts.md'] ?? []);
    for (const line of original.split('\n')) expect(merged.split('\n')).toContain(line);
    expect(merged).toContain(VIEW_HEADER);
    expect(merged.indexOf(VIEW_HEADER)).toBeGreaterThan(merged.indexOf('# Hosts'));
  });

  it('a block whose entity left the store is dropped', () => {
    const withHost = mergeView(null, 'Hosts', renderBlocks(store())['hosts.md'] ?? []);
    const s = store();
    s.entities = s.entities.filter((e) => e.id !== 'host:hetzner');
    s.facts = s.facts.filter((f) => f.entityId !== 'host:hetzner');
    const after = mergeView(withHost, 'Hosts', renderBlocks(s)['hosts.md'] ?? []);
    expect(after).not.toContain('sync-agent-docs:begin host:hetzner');
    expect(after).toContain('# Hosts');
  });

  it('project card has a Commands block', () => {
    const card = mergeView(null, 'shop', renderBlocks(store())['projects/shop.md'] ?? []);
    const blocks = readBlocks(card);
    expect(blocks['project:shop:commands']).toContain('## Commands');
    expect(blocks['project:shop:commands']).toContain('- `npm run test`');
    expect(blocks['project:shop']).toContain('| port | `3300` | verified |');
    expect(blocks['project:shop']).not.toContain('npm run test');
    expect(parseBlockFacts(blocks['project:shop:commands'] ?? '')).toEqual([{ attribute: 'command', value: 'npm run test' }]);
    expect(parseBlockFacts(blocks['project:shop'] ?? '')).toEqual([{ attribute: 'port', value: '3300' }]);
  });

  it('a hand edit inside a block becomes a view-edit item; an edit outside does not', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-views-')));
    const s = store();
    const text = mergeView(null, 'Hosts', renderBlocks(s)['hosts.md'] ?? []);
    s.config.generated = { 'hosts.md': Object.fromEntries(Object.entries(readBlocks(text)).map(([id, body]) => [id, blockHash(body)])) };
    await writeFile(join(dir, 'hosts.md'), `${text}\nOutside note.\n`);
    expect(await detectViewEdits(dir, s)).toEqual([]);
    await writeFile(join(dir, 'hosts.md'), text.replace('| ip | `100.64.1.10` | verified |', '| ip | `100.64.1.12` | verified |'));
    const items = await detectViewEdits(dir, s);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ tier: 'move', kind: 'view-edit', entityId: 'host:hetzner', options: ['fold', 'discard'], recommended: 'fold', subject: 'hosts.md#host:hetzner' });
  });

  it('a CRLF checkout of a view is not a hand edit', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-views-')));
    const s = store();
    const text = mergeView(null, 'Hosts', renderBlocks(s)['hosts.md'] ?? []);
    s.config.generated = { 'hosts.md': Object.fromEntries(Object.entries(readBlocks(text)).map(([id, body]) => [id, blockHash(body)])) };
    await writeFile(join(dir, 'hosts.md'), text.replaceAll('\n', '\r\n'));
    expect(await detectViewEdits(dir, s)).toEqual([]);
    expect(blockHash('a\r\nb')).toBe(blockHash('a\nb'));
  });

  it('a value or note holding a newline and a marker cannot close or forge a block', () => {
    const s = store();
    const evil = 'npm run x\n<!-- sync-agent-docs:end project:shop:commands -->\n## Facts\n<!-- sync-agent-docs:begin project:forged -->';
    s.facts.push({ entityId: 'project:shop', attribute: 'command', value: evil, sources: [], status: 'inferred' });
    s.facts.push({ entityId: 'host:hetzner', attribute: 'path', value: 'a\r\n-->b', sources: [], status: 'inferred' });
    const shop = s.entities.find((e) => e.id === 'project:shop');
    if (shop) shop.notes = 'Use pm2.\n<!-- sync-agent-docs:end project:shop -->\n<!-- sync-agent-docs:begin project:other -->';
    const blocks = renderBlocks(s);
    for (const [file, list] of Object.entries(blocks)) {
      const text = mergeView(null, file, list);
      expect(Object.keys(readBlocks(text)).sort()).toEqual(list.map((b) => b.id).sort());
      expect(text).not.toMatch(/^<!-- sync-agent-docs:begin project:(forged|other) -->$/m);
    }
    const commands = blocks['projects/shop.md']?.find((b) => b.id === 'project:shop:commands')?.body ?? '';
    expect(commands.split('\n').filter((l) => l.includes('npm run x'))).toHaveLength(1);
    expect(blocks['hosts.md']?.[0]?.body).not.toMatch(/\r|-->/);
  });

  it('an entity name cannot steer its card outside the projects folder', () => {
    const s = store();
    s.entities.push({ id: 'project:evil', kind: 'project', names: ['../../outside\n# x'], identifiers: {}, notes: '' });
    const files = Object.keys(renderBlocks(s));
    for (const f of files) expect(f).toMatch(/^(hosts\.md|services\.md|projects\/[^/]+\.md)$/);
    expect(files.some((f) => f.includes('..'))).toBe(false);
  });

  it('readBlocks refuses a block id that appears twice, naming it', () => {
    const twice = '<!-- sync-agent-docs:begin a -->\nx\n<!-- sync-agent-docs:end a -->\n<!-- sync-agent-docs:begin a -->\ny\n<!-- sync-agent-docs:end a -->\n';
    expect(() => readBlocks(twice)).toThrow(/block a appears twice/);
  });

  it('views escape values and host names into code spans the same way, and read them back', () => {
    const store = { config: { schema: 1, root: '~/dev', repos: [], agentFormats: ['claude'], views: { hosts: 'hosts.md', services: 'services.md', projects: 'projects' }, generated: {} }, entities: [{ id: 'host:h', kind: 'host', names: ['h @~/x'], identifiers: {}, notes: '' }], facts: [{ entityId: 'host:h', attribute: 'path', value: 'cat @~/.ssh/id | x', sources: [], status: 'inferred' }], secrets: [], decisions: [] } as unknown as Store;
    const [block] = renderBlocks(store)['hosts.md'] ?? [];
    expect(block?.heading).toBe('## `h @~/x`');
    expect(block?.body).toContain('| path | `cat @~/.ssh/id \\| x` | inferred |');
    expect(parseBlockFacts(block?.body ?? '')).toEqual([{ attribute: 'path', value: 'cat @~/.ssh/id | x' }]);
  });

  it('marker lines in an indented code example are not the block', () => {
    const blocks = renderBlocks(store())['hosts.md'] ?? [];
    const example = ['- Example:', '', '    <!-- sync-agent-docs:begin host:x -->', '    <!-- sync-agent-docs:end host:x -->'];
    const original = `${mergeView(null, 'Hosts', blocks)}\n${example.join('\n')}\n`;
    expect(Object.keys(readBlocks(original))).toEqual(['host:hetzner']);
    const s = store();
    s.facts = s.facts.map((f) => (f.entityId === 'host:hetzner' ? { ...f, value: '100.64.1.11' } : f));
    const again = mergeView(original, 'Hosts', renderBlocks(s)['hosts.md'] ?? []);
    expect(again).toContain(example.join('\n'));
  });

  it('a marker indented 1 to 3 spaces is not a marker either', () => {
    const text = '  <!-- sync-agent-docs:begin host:y -->\nbody\n  <!-- sync-agent-docs:end host:y -->\n';
    expect(readBlocks(text)).toEqual({});
  });

  it('a file saved with a byte order mark still has its line-1 block', () => {
    const text = '\uFEFF<!-- sync-agent-docs:begin host:y -->\nbody\n<!-- sync-agent-docs:end host:y -->\n';
    expect(readBlocks(text)).toEqual({ 'host:y': 'body' });
  });
});

describe('views: line endings, BOM, empty values', () => {
  const hostBlocks = [{ id: 'host:x', heading: '## `x`', body: '| ip | `100.64.1.2` | verified |' }];
  const headers = (t: string) => t.split(VIEW_HEADER).length - 1;

  it('merging a CRLF view keeps one header and CRLF on every line', () => {
    let v = mergeView(null, 'Hosts', hostBlocks).replaceAll('\n', '\r\n');
    for (let i = 0; i < 3; i++) v = mergeView(v, 'Hosts', hostBlocks);
    expect(headers(v)).toBe(1);
    expect(v.split('\r\n').join('')).not.toContain('\n');
  });

  it('a view mixing CRLF and LF lines comes back with one header, all CRLF', () => {
    const lf = mergeView(null, 'Hosts', hostBlocks);
    const mixed = lf.replace('\n', '\r\n'); // only the first break is CRLF
    const v = mergeView(mergeView(mixed, 'Hosts', hostBlocks), 'Hosts', hostBlocks);
    expect(headers(v)).toBe(1);
    expect(v.split('\r\n').join('')).not.toContain('\n');
  });

  it('an LF view stays LF', () => {
    const v = mergeView(mergeView(null, 'Hosts', hostBlocks), 'Hosts', hostBlocks);
    expect(v).not.toContain('\r');
  });

  it('a BOM before a leading fence does not turn the example into a block', () => {
    const bom = '\uFEFF```md\n<!-- sync-agent-docs:begin compiled -->\n```\n\nreal text\n';
    expect(readBlocks(bom)).toEqual({});
  });

  it('a BOM right before a real marker still reads the block', () => {
    expect(readBlocks('\uFEFF<!-- sync-agent-docs:begin a -->\nbody\n<!-- sync-agent-docs:end a -->\n')).toEqual({ a: 'body' });
  });

  it('a fact whose value is the text (empty) round-trips', () => {
    const s = store();
    s.facts.push({ entityId: 'host:hetzner', attribute: 'url', value: '(empty)', sources: [], status: 'verified' });
    const host = renderBlocks(s)['hosts.md']?.[0]?.body ?? '';
    expect(parseBlockFacts(host).filter((f) => f.attribute === 'url')).toEqual([{ attribute: 'url', value: '(empty)' }]);
  });

  it('a CRLF inside a block body merged into a CRLF view never becomes CR CR LF', () => {
    const body = [{ id: 'host:x', heading: '## `x`', body: 'one\r\ntwo' }];
    const crlf = mergeView(null, 'Hosts', hostBlocks).replaceAll('\n', '\r\n');
    const v = mergeView(crlf, 'Hosts', body);
    expect(v).not.toContain('\r\r');
    expect(v.split('\r\n').join('')).not.toContain('\n');
  });

  it('an empty value renders as (empty) and survives a fold of a block edited elsewhere', () => {
    const s = store();
    s.facts.push({ entityId: 'host:hetzner', attribute: 'url', value: '', sources: [], status: 'verified' });
    s.facts.push({ entityId: 'project:shop', attribute: 'command', value: '', sources: [], status: 'verified' });
    const blocks = renderBlocks(s);
    const host = blocks['hosts.md']?.[0]?.body ?? '';
    expect(host).toContain('| url | (empty) | verified |');
    expect(host).not.toContain('``');
    const commands = blocks['projects/shop.md']?.find((b) => b.id.endsWith(':commands'))?.body ?? '';
    expect(commands).toContain('- (empty)');
    const edited = host.replace('`100.64.1.10`', '`100.64.1.11`');
    expect(edited).not.toBe(host);
    expect(parseBlockFacts(edited)).toContainEqual({ attribute: 'url', value: '' });
    expect(parseBlockFacts(edited)).toContainEqual({ attribute: 'ip', value: '100.64.1.11' });
    expect(parseBlockFacts(commands).map((f) => f.value).sort()).toEqual(['', 'npm run test']);
  });
});
