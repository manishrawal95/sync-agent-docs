import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_IDS } from '../src/doctor/types.js';
import { loadedSize, sizeBand } from '../src/doctor/checks/loaded-size.js';
import { applied, check, commit } from './helpers/doctor.js';

// ESM namespaces cannot be spied on, so realpath is wrapped here and made to fail once by the one test that needs it.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

let home: string;
let repo: string;
let card: string;
let opts: { claude: boolean; home: string; within: string[] };

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'tf-loaded-')));
  const root = join(home, 'dev');
  repo = join(root, 'shop');
  const store = join(home, 'truth');
  card = join(store, 'projects', 'shop.md');
  await mkdir(join(store, 'projects'), { recursive: true });
  await mkdir(join(repo, 'docs'), { recursive: true });
  await mkdir(join(home, 'elsewhere'), { recursive: true });
  await writeFile(card, 'c'.repeat(2000));
  await writeFile(join(repo, 'docs', 'notes.md'), `@deep.md\n${'n'.repeat(991)}`);
  await writeFile(join(repo, 'docs', 'deep.md'), 'd'.repeat(5000));
  await writeFile(join(home, 'elsewhere', 'big.md'), 'b'.repeat(3000));
  opts = { claude: true, home, within: [root, store] };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function agentFile(text: string): Promise<{ p: string; bytes: number }> {
  const p = join(repo, 'CLAUDE.md');
  await writeFile(p, text);
  return { p, bytes: (await stat(p)).size };
}

describe('loadedSize errors', () => {
  it('stops with the doctor message when the file cannot be read', async () => {
    await expect(loadedSize(join(repo, 'CLAUDE.md'), join(repo, 'gone.md'), opts)).rejects.toThrow(/^doctor: could not read .*\(ENOENT\)\. Check its permissions\./);
  });

  it('stops with the doctor message when an import fails for a code that is not skipped', async () => {
    const { p } = await agentFile('@docs/notes.md\n');
    vi.mocked(fsp.realpath).mockRejectedValueOnce(Object.assign(new Error('i/o'), { code: 'EIO' }));
    await expect(loadedSize(p, p, opts)).rejects.toThrow(/^doctor: could not check .* imported by .*\(EIO\)\. Check its permissions\./);
  });
});

describe('sizeBand', () => {
  it('bands by whole budgets', () => {
    expect([8192, 8193, 9216, 16383, 17408].map(sizeBand)).toEqual([8, 8, 8, 8, 16]);
  });
});

describe('loadedSize', () => {
  it('counts the file plus each @ import inside the root or the store, once each', async () => {
    const { p, bytes } = await agentFile('x'.repeat(100) + '\n@~/truth/projects/shop.md\n@docs/notes.md\n  @docs/notes.md  \n');
    const r = await loadedSize(p, p, opts);
    expect(r.bytes).toBe(bytes + 2000 + 1000);
    expect(r.imports).toEqual([card, join(repo, 'docs', 'notes.md')].sort());
  });

  it('follows one level only, and ignores inline and fenced @ lines', async () => {
    const { p } = await agentFile('see @docs/deep.md\n```\n@docs/deep.md\n```\n~~~\n@docs/deep.md\n~~~\n@docs/notes.md\n');
    expect((await loadedSize(p, p, opts)).imports).toEqual([join(repo, 'docs', 'notes.md')]);
  });

  it('ends a fence only on a line of the same character, as long as the opener, with nothing after it', async () => {
    const fenced = '````\n```\n~~~\n@docs/deep.md\n```` not a closer\n@docs/deep.md\n````\n~~~\n```\n@docs/deep.md\n~~~\n```js\n@docs/deep.md\n```\n@docs/notes.md\n';
    const { p } = await agentFile(fenced);
    expect((await loadedSize(p, p, opts)).imports).toEqual([join(repo, 'docs', 'notes.md')]);
  });

  it('never counts an import outside the root and the store, direct or through a link', async () => {
    await symlink(join(home, 'elsewhere', 'big.md'), join(repo, 'docs', 'out.md'));
    const { p, bytes } = await agentFile('@~/elsewhere/big.md\n@docs/out.md\n');
    const r = await loadedSize(p, p, opts);
    expect(r.imports).toEqual([]);
    expect(r.bytes).toBe(bytes);
  });

  it('skips a missing import, a folder and a link loop', async () => {
    await symlink(join(repo, 'docs', 'loop-b'), join(repo, 'docs', 'loop-a'));
    await symlink(join(repo, 'docs', 'loop-a'), join(repo, 'docs', 'loop-b'));
    const { p, bytes } = await agentFile('@docs/gone.md\n@docs\n@docs/loop-a\n');
    expect(await loadedSize(p, p, opts)).toEqual({ bytes, imports: [] });
  });

  it('reads imports from a CRLF file', async () => {
    const { p, bytes } = await agentFile('a\r\n@docs/notes.md\r\n');
    expect((await loadedSize(p, p, opts)).bytes).toBe(bytes + 1000);
  });

  it('counts no imports for a file that is not CLAUDE.md', async () => {
    const { p } = await agentFile('@docs/notes.md\n');
    expect((await loadedSize(p, p, { ...opts, claude: false })).imports).toEqual([]);
  });
});

const MESSAGE = /^shop\/CLAUDE\.md: an agent loads \d+\.\d KB from it every turn, imports included \(budget 8 KB\)\. Move what only some tasks need into a doc it links to without @\.( Imports counted: [^,]+(, [^,]+)*\.)?$/;
/** Only loaded-size runs: the other checks stop on the same broken paths, which this check must not. */
const onlyLoadedSize = (root: string) =>
  writeFile(join(root, '.sync-agent-docs', 'checks.json'), JSON.stringify({ schema: 1, disabled: CHECK_IDS.filter((id) => id !== 'loaded-size') }));
const pad = async (file: string, bytes: number) => writeFile(file, (await readFile(file, 'utf8')) + '\n' + 'x'.repeat(bytes) + '\n');

describe('doctor: loaded-size', () => {
  it('is clean right after a merged apply', async () => {
    const { doctor } = await applied({ answerAll: true });
    expect(check(await doctor(), 'loaded-size')).toEqual({ id: 'loaded-size', status: 'clean', findings: [] });
  });

  it('a CLAUDE.md over 8 KB with its card is drift, keyed by band', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    await pad(join(root, 'shop', 'CLAUDE.md'), 9 * 1024);
    commit(join(root, 'shop'), 'grow');
    const c = check(await doctor(), 'loaded-size');
    expect(c.status).toBe('drift');
    expect(c.findings).toEqual([expect.objectContaining({ key: 'loaded-size:shop/CLAUDE.md:over-8k', level: 'drift', path: 'shop/CLAUDE.md', message: expect.stringMatching(MESSAGE) })]);
  });

  it('a CLAUDE.md linked to AGENTS.md counts once, under CLAUDE.md, with its @ import', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    const shop = join(root, 'shop');
    await rm(join(shop, 'CLAUDE.md'));
    await symlink('AGENTS.md', join(shop, 'CLAUDE.md'));
    await mkdir(join(shop, 'docs'), { recursive: true });
    await writeFile(join(shop, 'docs', 'ops.md'), 'y'.repeat(5 * 1024));
    await writeFile(join(shop, 'AGENTS.md'), (await readFile(join(shop, 'AGENTS.md'), 'utf8')) + '\n@docs/ops.md\n' + 'x'.repeat(4 * 1024) + '\n');
    commit(shop, 'link and import');
    const { findings } = check(await doctor(), 'loaded-size');
    expect(findings.map((f) => f.key)).toEqual(['loaded-size:shop/CLAUDE.md:over-8k']);
    expect(findings[0]?.message).toMatch(MESSAGE);
    expect(findings[0]?.message).toContain('Imports counted: shop/docs/ops.md.');
  });

  it('a CLAUDE.md hard-linked to AGENTS.md counts once', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    const shop = join(root, 'shop');
    await rm(join(shop, 'CLAUDE.md'));
    await writeFile(join(shop, 'AGENTS.md'), (await readFile(join(shop, 'AGENTS.md'), 'utf8')) + 'x'.repeat(9 * 1024) + '\n');
    await link(join(shop, 'AGENTS.md'), join(shop, 'CLAUDE.md'));
    commit(shop, 'hard link');
    const { findings } = check(await doctor(), 'loaded-size');
    expect(findings.map((f) => f.key)).toEqual(['loaded-size:shop/CLAUDE.md:over-8k']);
  });

  it('finds nothing loaded where a link loops or a parent is not a folder', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    const shop = join(root, 'shop');
    await rm(join(shop, 'CLAUDE.md'));
    await symlink('CLAUDE.md', join(shop, 'CLAUDE.md'));
    await rm(join(shop, '.cursor'), { recursive: true, force: true });
    await writeFile(join(shop, '.cursor'), 'not a folder');
    await onlyLoadedSize(root);
    expect(check(await doctor(), 'loaded-size')).toEqual({ id: 'loaded-size', status: 'clean', findings: [] });
  });

  it('finds nothing loaded where an agent file path is a folder', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    const shop = join(root, 'shop');
    await rm(join(shop, 'CLAUDE.md'));
    await mkdir(join(shop, 'CLAUDE.md'));
    await onlyLoadedSize(root);
    expect(check(await doctor(), 'loaded-size')).toEqual({ id: 'loaded-size', status: 'clean', findings: [] });
  });

  it('exactly 8192 loaded bytes is clean, and one more is drift that reads over 8 KB', async () => {
    const { root, home, store, doctor } = await applied({ answerAll: true });
    const file = join(root, 'shop', 'CLAUDE.md');
    const loaded = () => loadedSize(file, file, { claude: true, home, within: [root, store] });
    await writeFile(file, (await readFile(file, 'utf8')) + 'x'.repeat(8192 - (await loaded()).bytes));
    expect((await loaded()).bytes).toBe(8192);
    commit(join(root, 'shop'), 'at budget');
    expect(check(await doctor(), 'loaded-size').findings).toEqual([]);
    await writeFile(file, (await readFile(file, 'utf8')) + 'x');
    commit(join(root, 'shop'), 'over budget');
    const { findings } = check(await doctor(), 'loaded-size');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('8.1 KB');
  });

  it('accepting a band does not silence a bigger one, and the old key turns into a note', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    await pad(join(root, 'shop', 'CLAUDE.md'), 17 * 1024);
    commit(join(root, 'shop'), 'grow');
    await writeFile(join(root, '.sync-agent-docs', 'checks.json'), JSON.stringify({ schema: 1, accepted: ['loaded-size:shop/CLAUDE.md:over-8k'] }));
    const c = check(await doctor(), 'loaded-size');
    expect(c.findings.map((f) => [f.key, f.level])).toEqual([
      ['loaded-size:shop/CLAUDE.md:over-16k', 'drift'],
      ['loaded-size:accepted-unused:loaded-size:shop/CLAUDE.md:over-8k', 'note'],
    ]);
  });

  it('can be disabled alone', async () => {
    const { root, doctor } = await applied({ answerAll: true });
    await writeFile(join(root, '.sync-agent-docs', 'checks.json'), JSON.stringify({ schema: 1, disabled: ['loaded-size'] }));
    const r = await doctor();
    expect(check(r, 'loaded-size')).toEqual({ id: 'loaded-size', status: 'disabled', findings: [] });
    expect(check(r, 'compiled').status).toBe('clean');
  });

  it('reports a missing repo and the store itself when the compiled check is disabled, and not otherwise', async () => {
    const { root, store, doctor } = await applied({ answerAll: true });
    const path = join(store, 'sync-agent-docs.json');
    const config = JSON.parse(await readFile(path, 'utf8')) as { repos: { name: string; path: string }[] };
    config.repos.push({ name: 'gone', path: 'gone' }, { name: 'truth', path: store });
    await writeFile(path, JSON.stringify(config, null, 2));
    commit(store, 'repos');
    await writeFile(join(root, '.sync-agent-docs', 'checks.json'), JSON.stringify({ schema: 1, disabled: ['compiled'] }));
    const r = await doctor();
    expect(check(r, 'compiled').status).toBe('disabled');
    expect(check(r, 'loaded-size').findings.map((f) => [f.key, f.level])).toEqual([['compiled:gone:not-there', 'note'], ['compiled:~/truth:store', 'note']]);
  });

  it('leaves a missing repo and the store listed as a repo to the compiled check', async () => {
    const { store, doctor } = await applied({ answerAll: true });
    const path = join(store, 'sync-agent-docs.json');
    const config = JSON.parse(await readFile(path, 'utf8')) as { repos: { name: string; path: string }[] };
    config.repos.push({ name: 'gone', path: 'gone' }, { name: 'truth', path: store });
    await writeFile(path, JSON.stringify(config, null, 2));
    commit(store, 'repos');
    const r = await doctor();
    expect(check(r, 'loaded-size')).toEqual({ id: 'loaded-size', status: 'clean', findings: [] });
    expect(check(r, 'compiled').findings.map((f) => f.key)).toEqual(['compiled:gone:not-there', 'compiled:~/truth:store']);
  });
});
