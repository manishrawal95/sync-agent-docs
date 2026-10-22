import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decisionKey, readDecisions, rememberDecisions } from '../src/plan/decisions.js';
import { writeStore } from '../src/store/io.js';
import type { Decision } from '../src/store/types.js';

const temp = async () => realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-dec-')));
const d = (key: string, answer: string, decidedAt = '2026-10-22T00:00:00.000Z'): Decision => ({ key, kind: 'conflict', subject: 'project:shop|port', candidates: ['3000', '3300'], answer, decidedAt });

describe('decisions', () => {
  it('key ignores candidate order and duplicates', () => {
    expect(decisionKey('conflict', 'project:shop|port', ['3300', '3000', '3300'])).toBe(decisionKey('conflict', 'project:shop|port', ['3000', '3300']));
    expect(decisionKey('conflict', 'project:shop|port', ['3000'])).toMatch(/^[0-9a-f]{16}$/);
  });

  it('key changes when the candidate set or kind changes', () => {
    const base = decisionKey('conflict', 'project:shop|port', ['3000', '3300']);
    expect(decisionKey('conflict', 'project:shop|port', ['3000', '3300', '4000'])).not.toBe(base);
    expect(decisionKey('fact', 'project:shop|port', ['3000', '3300'])).not.toBe(base);
  });

  it('store decision wins over pre-store on the same key', async () => {
    const root = await temp();
    const store = await temp();
    await rememberDecisions(root, [d('k1', '3000'), d('k2', 'approve')]);
    await writeStore(store, {
      config: { schema: 1, root, repos: [], agentFormats: [], views: { hosts: 'hosts.md', services: 'services.md', projects: 'projects' }, generated: {} },
      entities: [], facts: [], secrets: [], decisions: [d('k1', '3300', '2026-10-21T00:00:00.000Z')],
    });
    const got = await readDecisions(root, store);
    expect(got.find((x) => x.key === 'k1')?.answer).toBe('3300');
    expect(got.find((x) => x.key === 'k2')?.answer).toBe('approve');
  });

  it('rememberDecisions keeps earlier keys and replaces a re-answered one', async () => {
    const root = await temp();
    await rememberDecisions(root, [d('k1', '3000')]);
    await rememberDecisions(root, [d('k2', 'approve'), d('k1', '3300', '2026-10-23T00:00:00.000Z')]);
    const got = await readDecisions(root, join(root, 'no-store'));
    expect(got.map((x) => `${x.key}=${x.answer}`).sort()).toEqual(['k1=3300', 'k2=approve']);
  });
});
