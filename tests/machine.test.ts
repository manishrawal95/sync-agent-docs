import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { machineSources } from '../src/discover/machine.js';
import { parseTruth } from '../src/truth/parse.js';
import { materializeFixture } from './helpers/fixture.js';

const NO_CRONTAB = { crontabCommand: 'sync-agent-docs-test-no-crontab' };

describe('machine pass', () => {
  it('ssh alias hetzner becomes a host entity with ip 100.64.1.10', async () => {
    const { home } = await materializeFixture('messy-dev');
    const machine = await machineSources(home, NO_CRONTAB);
    const truth = await parseTruth(machine.sources.filter((s) => s.kind === 'truth'), []);
    const host = truth.entities.find((e) => e.names.includes('hetzner'));
    expect(host).toMatchObject({ kind: 'host', identifiers: { ip: '100.64.1.10' } });
    expect(truth.facts).toContainEqual(expect.objectContaining({ entityId: host?.id, attribute: 'ip', value: '100.64.1.10', scope: 'machine' }));
  });

  it('ssh config reads Key=value, gives a multi-pattern Host one entity, and keeps the first HostName', async () => {
    const { home } = await materializeFixture('messy-dev');
    await writeFile(join(home, '.ssh', 'config'), [
      'Host=edge',
      '  Hostname=198.51.100.8',
      'Host relay',
      '  HostName = 198.51.100.9',
      'Host web prod-web *.internal',
      '  HostName 198.51.100.10',
      '  HostName 198.51.100.11',
      '',
    ].join('\n'));
    const machine = await machineSources(home, NO_CRONTAB);
    const truth = await parseTruth(machine.sources.filter((s) => s.kind === 'truth'), []);
    const ipOf = (name: string) => truth.entities.find((e) => e.kind === 'host' && e.names.includes(name))?.identifiers.ip;
    expect(ipOf('edge')).toBe('198.51.100.8');
    expect(ipOf('relay')).toBe('198.51.100.9');
    const web = truth.entities.filter((e) => e.kind === 'host' && (e.names.includes('web') || e.names.includes('prod-web')));
    expect(web).toHaveLength(1);
    expect(web[0]).toMatchObject({ id: 'host:web', identifiers: { ip: '198.51.100.10' } });
    expect(web[0]?.names).toContain('prod-web');
    expect(truth.facts.filter((f) => f.attribute === 'ip').map((f) => f.value).sort()).toEqual(['198.51.100.10', '198.51.100.8', '198.51.100.9']);
  });

  it('global CLAUDE.md is a machine-scope claude claim', async () => {
    const { home } = await materializeFixture('messy-dev');
    const { sources } = await machineSources(home, NO_CRONTAB);
    expect(sources.find((s) => s.path === join(home, '.claude', 'CLAUDE.md'))).toMatchObject({
      kind: 'claim', scope: 'machine', agent: 'claude', repo: null,
    });
  });

  it('missing crontab and an unreadable file (chmod 000) do not fail the pass', async () => {
    const { home } = await materializeFixture('messy-dev');
    const locked = join(home, '.codex', 'AGENTS.md');
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(locked, 'x\n');
    await chmod(locked, 0o000);
    const machine = await machineSources(home, NO_CRONTAB);
    expect(machine.skipped).toContainEqual(expect.objectContaining({ path: locked, reason: 'unreadable' }));
    expect(machine.skipped).toContainEqual(expect.objectContaining({ path: 'crontab -l', note: expect.stringContaining('crontab') }));
    expect(machine.sources.some((s) => s.path === locked)).toBe(false);
  });

  it('read lists exactly the files opened', async () => {
    const { home } = await materializeFixture('messy-dev');
    await mkdir(join(home, '.claude', 'projects', 'p1', 'memory'), { recursive: true });
    await writeFile(join(home, '.claude', 'projects', 'p1', 'memory', 'MEMORY.md'), '- note\n');
    await writeFile(join(home, '.claude', 'settings.json'), '{}\n');
    await writeFile(join(home, '.ssh', 'id_ed25519'), 'not read\n');
    await writeFile(join(home, '.zshrc'), 'export EDITOR=vim\nexport API_KEY=abc123\nalias ll=ls\n');
    const machine = await machineSources(home, NO_CRONTAB);
    expect([...machine.read].sort()).toEqual([
      join(home, '.claude', 'CLAUDE.md'),
      join(home, '.claude', 'projects', 'p1', 'memory', 'MEMORY.md'),
      join(home, '.ssh', 'config'),
      join(home, '.zshrc'),
    ].sort());
    const truth = await parseTruth(machine.sources.filter((s) => s.kind === 'truth'), []);
    expect(truth.facts.filter((f) => f.attribute === 'env').map((f) => f.value).sort()).toEqual(['API_KEY', 'EDITOR']);
    expect([...truth.corpus].some((t) => t.includes('abc123'))).toBe(false);
  });

  it('crontab output adds paths and names to the corpus, never values', async () => {
    const { home, root } = await materializeFixture('messy-dev');
    const fake = join(root, 'fake-crontab.sh');
    await writeFile(fake, '#!/bin/sh\nprintf "TOKEN=s3cretvalue\\n0 3 * * * /opt/app/backup.sh >> ~/backup.log\\n"\n');
    await chmod(fake, 0o755);
    const machine = await machineSources(home, { crontabCommand: fake });
    expect(machine.corpus).toContain('/opt/app/backup.sh');
    expect(machine.corpus).toContain('TOKEN');
    expect(machine.corpus.some((t) => t.includes('s3cret'))).toBe(false);
    expect(machine.read).toContain('crontab -l');
  });
});
