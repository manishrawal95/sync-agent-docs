import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoreSecret } from '../src/store/types.js';
import { applied, check } from './helpers/doctor.js';

/** Records `secrets` in the store as apply would after the owner chose to rotate by hand. */
async function record(store: string, secrets: StoreSecret[]) {
  const path = join(store, 'store', 'facts.json');
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.secrets = secrets;
  await writeFile(path, JSON.stringify(data));
}

describe('doctor: secrets left for manual rotation', () => {
  it('a manual secret still on its line is drift named by path and line only', async () => {
    const { root, store, secret, doctor } = await applied();
    await record(store, [{ path: 'shop/AGENTS.md', line: 3, status: 'manual' }]);
    const r = await doctor();
    const c = check(r, 'secrets');
    expect(c.findings).toEqual([expect.objectContaining({ key: 'secrets:shop/AGENTS.md:3', level: 'drift', path: 'shop/AGENTS.md' })]);
    expect(c.findings[0]?.message).toContain('shop/AGENTS.md:3');
    for (const text of [JSON.stringify(r), await readFile(join(root, '.sync-agent-docs', 'doctor.json'), 'utf8')]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(`${secret.slice(0, 4)}…`);
    }
  });

  it('once the line is clean there is no finding', async () => {
    const { root, store, secret, doctor } = await applied();
    const file = join(root, 'shop', 'AGENTS.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace(secret, 'see the secret store'));
    await record(store, [{ path: 'shop/AGENTS.md', line: 3, status: 'manual' }]);
    expect(check(await doctor(), 'secrets')).toEqual({ id: 'secrets', status: 'clean', findings: [] });
  });

  it('removed and false-positive secrets are not checked', async () => {
    const { store, doctor } = await applied();
    await record(store, [{ path: 'shop/AGENTS.md', line: 3, status: 'removed' }, { path: 'shop/AGENTS.md', line: 3, status: 'false-positive' }]);
    expect(check(await doctor(), 'secrets').findings).toEqual([]);
  });

  it('a manual secret whose file is gone is a note', async () => {
    const { store, doctor } = await applied();
    await record(store, [{ path: 'shop/GONE.md', line: 1, status: 'manual' }]);
    const c = check(await doctor(), 'secrets');
    expect(c.status).toBe('clean');
    expect(c.findings).toEqual([expect.objectContaining({ key: 'secrets:shop/GONE.md:1', level: 'note' })]);
  });
});
