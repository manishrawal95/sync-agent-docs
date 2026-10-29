import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCompiledBlock, writeCompiledBlock } from '../src/compile/block.js';
import { CARD_NOTE, factsBody, NO_FACTS } from '../src/compile/content.js';
import { COMPILERS, compilerFor } from '../src/compile/formats/index.js';
import type { Store } from '../src/store/types.js';
import { MARKER } from '../src/views/render.js';

const store = (): Store => ({
  config: { schema: 1, root: '~/dev', repos: [{ name: 'shop', path: '~/dev/shop' }], agentFormats: ['claude', 'agents', 'gemini', 'cursor', 'copilot'], views: { hosts: 'hosts.md', services: 'services.md', projects: 'projects' }, generated: {} },
  entities: [
    { id: 'project:shop', kind: 'project', names: ['shop'], identifiers: {}, notes: 'Owner notes stay in the view.' },
    { id: 'host:hetzner', kind: 'host', names: ['hetzner'], identifiers: {}, notes: '' },
  ],
  facts: [
    { entityId: 'project:shop', attribute: 'port', value: '3300', sources: [], status: 'verified' },
    { entityId: 'project:shop', attribute: 'url', value: 'postgres://u:secretpass@h/db', sources: [], status: 'verified' },
    { entityId: 'project:shop', attribute: 'env', value: 'Q9vX2mLp8RtY4wZk7NbC3dFh', sources: [], status: 'inferred' },
    { entityId: 'host:hetzner', attribute: 'ip', value: '100.64.1.10', sources: [], status: 'verified' },
    { entityId: 'host:hetzner', attribute: 'path', value: 'a --> b\n<!-- sync-agent-docs:end compiled -->', sources: [], status: 'inferred' },
  ],
  secrets: [], decisions: [],
});
const IDS = ['host:hetzner', 'project:shop'];
const input = (outside = '', shared = false) => ({ repoPath: '/r', store: store(), entityIds: IDS, outside, card: '@~/truth/projects/shop.md', project: 'project:shop', shared });

describe('factsBody', () => {
  it('lists each entity with its facts and leaves notes to the views', () => {
    const body = factsBody(store(), IDS);
    expect(body).toContain('### `hetzner` (host)');
    expect(body).toContain('| port | `3300` | verified |');
    expect(body).not.toContain('Owner notes');
  });

  it('never carries a credential or a token-shaped value', () => {
    const body = factsBody(store(), IDS);
    expect(body).not.toContain('secretpass');
    expect(body).not.toContain('Q9vX2mLp8RtY4wZk7NbC3dFh');
  });

  it('escapes values so they cannot end the block early', () => {
    const body = factsBody(store(), IDS);
    const block = readCompiledBlock(writeCompiledBlock('', body));
    expect(block?.body).toBe(body);
    expect(body.split('\n').filter((l) => MARKER.test(l.trim()))).toEqual([]);
  });

  it('puts values and names in code spans, so a scanned @path is never a live Claude import', () => {
    const s = store();
    s.entities[1] = { id: 'host:hetzner', kind: 'host', names: ['het`zner @~/.ssh/config'], identifiers: {}, notes: '' };
    s.facts.push({ entityId: 'host:hetzner', attribute: 'path', value: 'cat @~/.ssh/id_ed25519 | a`b', sources: [], status: 'inferred' });
    const body = factsBody(s, IDS);
    expect(body).toContain("### `het'zner @~/.ssh/config` (host)");
    expect(body).toContain("| path | `cat @~/.ssh/id_ed25519 \\| a'b` | inferred |");
    expect(body).toContain('| port | `3300` | verified |');
    expect(body.split('\n').filter((l) => /(^|[^`\w])@~\//.test(l.replace(/`[^`]*`/g, '')))).toEqual([]);
  });

  it('says so when a repo has no facts yet', () => {
    expect(factsBody(store(), ['project:none'])).toContain('No facts recorded for this repo yet.');
  });
});

describe('format compilers', () => {
  it('covers the five formats with their files', () => {
    expect(COMPILERS.map((c) => [c.format, c.file])).toEqual([
      ['claude', 'CLAUDE.md'], ['agents', 'AGENTS.md'], ['gemini', 'GEMINI.md'],
      ['cursor', join('.cursor', 'rules', 'sync-agent-docs.mdc')], ['copilot', join('.github', 'copilot-instructions.md')],
    ]);
  });

  it('claude imports the project card, unless the line already sits outside the block', () => {
    const claude = compilerFor('claude');
    expect(claude.body(input())).toContain('\n@~/truth/projects/shop.md\n');
    expect(claude.body(input('# Shop\n@~/truth/projects/shop.md\n'))).not.toContain('@~/truth');
  });

  it('claude drops the project section when the card import sits outside the block', () => {
    const body = compilerFor('claude').body(input('# Shop\n@~/truth/projects/shop.md\n'));
    expect(body).not.toContain('### `shop` (project)');
    expect(body).not.toContain('| port | `3300` |');
    expect(body).toContain('### `hetzner` (host)');
    expect(body).toContain(CARD_NOTE);
    expect(body).not.toContain('@~/truth');
  });

  it('claude keeps the project section when the card line outside the block is inside a code fence', () => {
    const body = compilerFor('claude').body(input('```\n@~/truth/projects/shop.md\n```\n'));
    expect(body).toContain('### `shop` (project)');
    expect(body).toContain('\n@~/truth/projects/shop.md\n');
  });

  it('claude keeps the project section when it adds the import itself', () => {
    const body = compilerFor('claude').body(input());
    expect(body).toContain('### `shop` (project)');
    expect(body).not.toContain(CARD_NOTE);
  });

  it('claude keeps the project section when CLAUDE.md is also another agent file', () => {
    const body = compilerFor('claude').body(input('# Shop\n@~/truth/projects/shop.md\n', true));
    expect(body).toContain('### `shop` (project)');
    expect(body).not.toContain(CARD_NOTE);
  });

  it('a trimmed claude block with no other entity names the card, not "no facts"', () => {
    const body = compilerFor('claude').body({ ...input('@~/truth/projects/shop.md\n'), entityIds: ['project:shop'] });
    expect(body).toContain(CARD_NOTE);
    expect(body).not.toContain(NO_FACTS);
  });

  it('with no card, claude keeps the project section', () => {
    expect(compilerFor('claude').body({ ...input('@~/truth/projects/shop.md\n'), card: null })).toContain('### `shop` (project)');
  });

  it('agents, gemini and copilot carry the facts body with no import', () => {
    for (const f of ['agents', 'gemini', 'copilot'] as const) {
      for (const outside of ['', '@~/truth/projects/shop.md\n']) {
        const body = compilerFor(f).body(input(outside));
        expect(body).toContain(factsBody(store(), IDS));
        expect(body).not.toContain('@~/truth');
      }
    }
  });

  it('a new cursor rule file starts with valid frontmatter', () => {
    const prefix = compilerFor('cursor').newFilePrefix ?? '';
    expect(prefix).toMatch(/^---\ndescription: .+\nalwaysApply: true\n---\n\n$/);
  });

  it('cursor counts as present when .cursor/rules exists, the others when their file does', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tf-fmt-'));
    expect(await compilerFor('cursor').present(repo)).toBe(false);
    await mkdir(join(repo, '.cursor', 'rules'), { recursive: true });
    expect(await compilerFor('cursor').present(repo)).toBe(true);
    expect(await compilerFor('agents').present(repo)).toBe(false);
  });
});
