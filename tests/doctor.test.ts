import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderDoctor } from '../src/doctor/run.js';
import { applied, check, commit } from './helpers/doctor.js';

/** shop's CLAUDE.md with one line added inside its compiled block. */
async function editBlock(root: string) {
  const path = join(root, 'shop', 'CLAUDE.md');
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace('<!-- sync-agent-docs:end compiled -->', 'a line typed by hand\n<!-- sync-agent-docs:end compiled -->'));
  commit(join(root, 'shop'), 'hand edit');
}

describe('doctor: compiled blocks and views', () => {
  it('is clean right after a merged apply, and writes doctor.json', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    const r = await doctor();
    expect(r.checks.filter((c) => c.status === 'drift')).toEqual([]);
    expect(r.drift).toBe(false);
    const saved = JSON.parse(await readFile(join(root, '.sync-agent-docs', 'doctor.json'), 'utf8')) as typeof r;
    expect(saved).toEqual(r);
    expect(renderDoctor(r)).toContain('No drift');
  });

  it('a hand edit inside a compiled block is drift naming the file', async () => {
    const { root, doctor, secret } = await applied({ answerAll: true });
    await editBlock(root);
    const r = await doctor();
    expect(r.drift).toBe(true);
    const c = check(r, 'compiled');
    expect(c.status).toBe('drift');
    expect(c.findings).toEqual([expect.objectContaining({ key: 'compiled:shop/CLAUDE.md:edited', level: 'drift', path: 'shop/CLAUDE.md' })]);
    const text = renderDoctor(r);
    expect(text).toContain('shop/CLAUDE.md');
    expect(text).toContain('compiled:shop/CLAUDE.md:edited');
    expect(text).not.toContain(secret);
  });

  it('an accepted key stops failing, and a disabled check is not run', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    await editBlock(root);
    await writeFile(join(root, '.sync-agent-docs', 'checks.json'), JSON.stringify({ schema: 1, accepted: ['compiled:shop/CLAUDE.md:edited'] }));
    const r = await doctor();
    expect(check(r, 'compiled').findings[0]?.level).toBe('accepted');
    expect(check(r, 'compiled').status).toBe('clean');
    expect(r.drift).toBe(false);
    await writeFile(join(root, '.sync-agent-docs', 'checks.json'), JSON.stringify({ schema: 1, disabled: ['compiled'] }));
    const off = await doctor();
    expect(check(off, 'compiled')).toEqual({ id: 'compiled', status: 'disabled', findings: [] });
  });

  it('an accepted key that matched nothing is a note on its check, once per key', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    const stale = ['compiled:shop/CLAUDE.md:edited', 'branches:shop:sync-agent-docs/apply-old'];
    await writeFile(join(root, '.sync-agent-docs', 'checks.json'), JSON.stringify({ schema: 1, accepted: [...stale, 'live:http:https://example.com/'] }));
    const r = await doctor();
    expect(r.drift).toBe(false);
    for (const key of stale) {
      const id = key.split(':')[0] as 'compiled' | 'branches';
      expect(check(r, id).findings).toEqual([expect.objectContaining({ level: 'note', message: `accepted key ${key} matched nothing; remove it from .sync-agent-docs/checks.json` })]);
    }
    expect(r.checks.flatMap((c) => c.findings).filter((f) => f.message.includes('live:'))).toEqual([]);
  });

  it('a store change makes the compiled blocks stale', async () => {
    const { store, doctor } = await applied({ answerAll: true });
    const path = join(store, 'store', 'facts.json');
    const facts = JSON.parse(await readFile(path, 'utf8')) as { facts: unknown[] };
    facts.facts.push({ entityId: 'project:shop', attribute: 'port', value: '4400', sources: [], status: 'verified' });
    await writeFile(path, JSON.stringify(facts, null, 2));
    commit(store, 'port 4400');
    const c = check(await doctor(), 'compiled');
    expect(c.findings).toContainEqual(expect.objectContaining({ key: 'compiled:shop/CLAUDE.md:stale', level: 'drift' }));
  });

  it('a missing repo and the store listed as a repo are notes, not failures', async () => {
    const { root, store, doctor } = await applied({ answerAll: true });
    const path = join(store, 'sync-agent-docs.json');
    const config = JSON.parse(await readFile(path, 'utf8')) as { repos: { name: string; path: string }[] };
    config.repos.push({ name: 'gone', path: 'gone' }, { name: 'truth', path: store });
    await writeFile(path, JSON.stringify(config, null, 2));
    commit(store, 'repos');
    const r = await doctor();
    const c = check(r, 'compiled');
    expect(c.status).toBe('clean');
    expect(c.findings.map((f) => f.level)).toEqual(['note', 'note']);
    expect(c.findings[0]?.message).toContain('gone');
    expect(root).toBeTruthy();
  });

  it('a hand-edited view block and a deleted view are drift', async () => {
    const { store, doctor } = await applied({ answerAll: true });
    const hosts = await readFile(join(store, 'hosts.md'), 'utf8');
    await writeFile(join(store, 'hosts.md'), hosts.replace('<!-- sync-agent-docs:end host:hetzner -->', 'typed by hand\n<!-- sync-agent-docs:end host:hetzner -->'));
    await rm(join(store, 'projects', 'blog.md'));
    const c = check(await doctor(), 'views');
    expect(c.status).toBe('drift');
    expect(c.findings.map((f) => f.key).sort()).toEqual(['views:hosts.md#host:hetzner:edited', 'views:projects/blog.md:out-of-date']);
    expect(c.findings.find((f) => f.key.endsWith('out-of-date'))?.message).toContain('is missing');
  });

  it('no store is a doctor error naming the folder and the next step', async () => {
    const { root, home, doctor } = await applied({ answerAll: true });
    await expect(doctor({ store: join(home, 'elsewhere') })).rejects.toThrow(/doctor: .*elsewhere.*sync-agent-docs apply/);
    expect(root).toBeTruthy();
  });
});
