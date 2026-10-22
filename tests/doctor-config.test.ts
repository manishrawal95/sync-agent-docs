import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readChecksConfig } from '../src/doctor/config.js';

const dir = async () => realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-checks-')));
const withFile = async (value: unknown) => {
  const d = await dir();
  await writeFile(join(d, 'checks.json'), typeof value === 'string' ? value : JSON.stringify(value));
  return d;
};

describe('checks.json', () => {
  it('a missing file disables nothing and accepts nothing', async () => {
    const c = await readChecksConfig(await dir());
    expect([...c.disabled]).toEqual([]);
    expect([...c.accepted]).toEqual([]);
  });

  it('reads disabled check ids and accepted keys', async () => {
    const c = await readChecksConfig(await withFile({ schema: 1, disabled: ['live'], accepted: ['compiled:shop/CLAUDE.md:edited'] }));
    expect([...c.disabled]).toEqual(['live']);
    expect([...c.accepted]).toEqual(['compiled:shop/CLAUDE.md:edited']);
  });

  it('refuses an unknown check id by its index', async () => {
    await expect(readChecksConfig(await withFile({ schema: 1, disabled: ['rescna'] }))).rejects.toThrow(/doctor: .*checks\.json: disabled\[0\] is "rescna", which is not a check id/);
  });

  it('refuses an accepted key that is not a string', async () => {
    await expect(readChecksConfig(await withFile({ schema: 1, accepted: [3] }))).rejects.toThrow(/checks\.json: accepted\[0\] is 3, which is not a finding key/);
  });

  it('refuses an accepted key that names no check', async () => {
    await expect(readChecksConfig(await withFile({ schema: 1, accepted: ['compield:shop/CLAUDE.md:edited'] }))).rejects.toThrow(/checks\.json: accepted\[0\] is "compield:shop\/CLAUDE\.md:edited", which is not a finding key/);
  });

  it('refuses a list that is not a list', async () => {
    await expect(readChecksConfig(await withFile({ schema: 1, disabled: 'live' }))).rejects.toThrow(/checks\.json: disabled is "live", which is not a list/);
  });

  it('refuses an unknown top-level key', async () => {
    await expect(readChecksConfig(await withFile({ schema: 1, disable: ['live'] }))).rejects.toThrow(/checks\.json: "disable" is not a checks\.json key/);
  });

  it('refuses bad JSON', async () => {
    await expect(readChecksConfig(await withFile('{'))).rejects.toThrow(/doctor: .*checks\.json is not valid JSON/);
  });
});
