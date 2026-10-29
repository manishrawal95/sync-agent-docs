import { execFileSync } from 'node:child_process';
import { chmod, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepos } from '../src/discover/repos.js';
import { classifySources, dedupeByRealPath, readTextSafe } from '../src/discover/sources.js';
import { renderTerminal } from '../src/report/terminal.js';
import { collectScan, runScan } from '../src/scan.js';
import type { RepoInfo, SkippedFile, SourceFile } from '../src/types.js';
import { materializeFixture } from './helpers/fixture.js';

describe('discover', () => {
  it('finds the three fixture repos', async () => {
    const { root } = await materializeFixture('messy-dev');
    const repos = await findRepos(root);
    expect(repos.map((r) => r.name).sort()).toEqual(['blog', 'ops', 'shop']);
  });

  it('skips node_modules and gitignored dirs', async () => {
    const { root } = await materializeFixture('messy-dev');
    await mkdir(join(root, 'shop', 'node_modules', 'x'), { recursive: true });
    await writeFile(join(root, 'shop', 'node_modules', 'x', 'CLAUDE.md'), 'port 1234\n');
    await mkdir(join(root, 'shop', 'tmp-out'), { recursive: true });
    await writeFile(join(root, 'shop', 'tmp-out', 'README.md'), 'port 1234\n');
    await mkdir(join(root, 'shop', 'tmp-out', 'nested', '.git'), { recursive: true });
    await writeFile(join(root, 'shop', '.gitignore'), 'tmp-out/\n.env\n');
    const repos = await findRepos(root);
    expect(repos.map((r) => r.name).sort()).toEqual(['blog', 'ops', 'shop']);
    const shop = repos.find((r) => r.name === 'shop');
    if (!shop) throw new Error('shop repo missing');
    const paths = (await classifySources(shop)).map((s) => s.path);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('tmp-out'))).toBe(false);
    // .env holds truth (names only), so it is read even when gitignored.
    expect(paths).toContain(join(shop.path, '.env'));
  });

  it('files ignored by a nested .gitignore or info/exclude are not read', async () => {
    const { root } = await materializeFixture('messy-dev');
    const shop = join(root, 'shop');
    await mkdir(join(shop, 'docs'), { recursive: true });
    await writeFile(join(shop, 'docs', '.gitignore'), 'private.md\n.env\n');
    await writeFile(join(shop, 'docs', 'private.md'), 'port 1234\n');
    await writeFile(join(shop, 'docs', 'public.md'), 'port 1234\n');
    await writeFile(join(shop, 'docs', '.env'), 'NAME=x\n');
    await writeFile(join(shop, 'local.md'), 'port 1234\n');
    await writeFile(join(shop, '.git', 'info', 'exclude'), 'local.md\n');
    const paths = (await classifySources({ name: 'shop', path: shop })).map((s) => s.path);
    expect(paths).not.toContain(join(shop, 'docs', 'private.md'));
    expect(paths).not.toContain(join(shop, 'local.md'));
    expect(paths).toContain(join(shop, 'docs', 'public.md'));
    expect(paths).toContain(join(shop, 'docs', '.env'));
  });

  it('an excluded .vercel/project.json and .env are still read, an excluded note is not', async () => {
    const { root } = await materializeFixture('messy-dev');
    const shop = join(root, 'shop');
    await mkdir(join(shop, '.vercel'), { recursive: true });
    await writeFile(join(shop, '.vercel', 'project.json'), '{"projectId":"prj_example","orgId":"team_example"}\n');
    await writeFile(join(shop, '.env'), 'NAME=x\n');
    await writeFile(join(shop, 'notes.md'), 'port 1234\n');
    await writeFile(join(shop, '.git', 'info', 'exclude'), '.vercel/\n.env\nnotes.md\n');
    const sources = await classifySources({ name: 'shop', path: shop });
    expect(sources).toContainEqual(expect.objectContaining({ path: join(shop, '.vercel', 'project.json'), format: 'vercel-project' }));
    expect(sources).toContainEqual(expect.objectContaining({ path: join(shop, '.env'), format: 'env' }));
    expect(sources.map((s) => s.path)).not.toContain(join(shop, 'notes.md'));
  });

  it('a folder that is not a git repo keeps root .gitignore rules without a skipped note', async () => {
    const { root } = await materializeFixture('messy-dev');
    const plain = join(root, 'plain');
    await mkdir(plain);
    await writeFile(join(plain, '.gitignore'), 'tmp.md\n');
    await writeFile(join(plain, 'tmp.md'), 'x\n');
    await writeFile(join(plain, 'kept.md'), 'x\n');
    const skipped: SkippedFile[] = [];
    const paths = (await classifySources({ name: 'plain', path: plain }, skipped)).map((s) => s.path);
    expect(paths).toEqual([join(plain, 'kept.md')]);
    expect(skipped).toEqual([]);
  });

  it('git failing to run stops the scan instead of reading files its ignore rules would drop', async () => {
    const { root } = await materializeFixture('messy-dev');
    const plain = join(root, 'plain');
    await mkdir(plain);
    await writeFile(join(plain, 'kept.md'), 'x\n');
    const path = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(classifySources({ name: 'plain', path: plain }, [])).rejects.toThrow(/git is not installed.*run again/);
    } finally {
      process.env.PATH = path;
    }
  });

  it('skips test fixture folders at any depth and a top-level test folder', async () => {
    const { root, home } = await materializeFixture('messy-dev');
    const blog = join(root, 'blog');
    const files = [
      'tests/fixtures/x/ecosystem.config.cjs', 'test/README.md', 'src/__fixtures__/README.md',
      'src/testdata/README.md', 'src/__snapshots__/README.md', 'lib/fixtures/CLAUDE.md',
    ];
    for (const f of [...files, 'src/tests/README.md']) {
      await mkdir(join(blog, f, '..'), { recursive: true });
      await writeFile(join(blog, f), f.endsWith('.cjs') ? "module.exports = { apps: [{ name: 'widget', args: 'start -p 4100' }] };\n" : 'port 4100\n');
    }
    const skipped: SkippedFile[] = [];
    const paths = (await classifySources({ name: 'blog', path: blog }, skipped)).map((x) => x.path);
    for (const f of files) expect(paths).not.toContain(join(blog, f));
    // Only a test folder at the repo root is skipped; a nested one may hold real docs.
    expect(paths).toContain(join(blog, 'src', 'tests', 'README.md'));
    expect(skipped.some((s) => /fixtures|testdata|__snapshots__|[/\\]tests?[/\\]/.test(s.path))).toBe(false);
    const scan = await collectScan(root, { home, reposOnly: true, crontabCommand: 'false' });
    expect(scan.entities.some((e) => e.names.includes('widget'))).toBe(false);
  });

  it('skips a linked worktree of a repo in the scan, noting it, and keeps a submodule', async () => {
    const { root, home } = await materializeFixture('messy-dev', { commit: true });
    execFileSync('git', ['-C', join(root, 'blog'), 'worktree', 'add', '-q', join(root, 'blog-wt'), '-b', 'wt']);
    await mkdir(join(root, 'shop', 'vendor', 'lib'), { recursive: true });
    await writeFile(join(root, 'shop', 'vendor', 'lib', '.git'), 'gitdir: ../../.git/modules/vendor/lib\n');
    const skipped: SkippedFile[] = [];
    const names = (await findRepos(root, skipped)).map((r) => r.name).sort();
    expect(names).toEqual(['blog', 'lib', 'ops', 'shop']);
    expect(skipped).toEqual([{ path: join(root, 'blog-wt'), reason: 'linked-worktree', note: `a worktree of ${join(root, 'blog')}, which is scanned instead` }]);
    const out = renderTerminal(await runScan(root, { home, reposOnly: true, crontabCommand: 'false' }), { color: false });
    expect(out).toContain('Skipped 1 linked worktree (its main checkout is scanned)');
  });

  it('does not treat a git repo inside a test fixture folder as a repo', async () => {
    const { root } = await materializeFixture('messy-dev');
    for (const d of ['blog/tests/x/inner', 'blog/src/fixtures/inner', 'blog/src/tests/kept']) await mkdir(join(root, d, '.git'), { recursive: true });
    const names = (await findRepos(root)).map((r) => r.name).sort();
    expect(names).toEqual(['blog', 'kept', 'ops', 'shop']);
  });

  it("leaves a store's own files out of the repo that holds it, and keeps the rest", async () => {
    const { root } = await materializeFixture('messy-dev');
    const ops = join(root, 'ops');
    await mkdir(join(ops, 'store'), { recursive: true });
    await mkdir(join(ops, 'docs', 'projects'), { recursive: true });
    await writeFile(join(ops, 'sync-agent-docs.json'), JSON.stringify({ views: { hosts: 'docs/hosts.md', services: 'services.md', projects: 'docs/projects' } }));
    await writeFile(join(ops, 'store', 'facts.json'), '{"facts":[]}\n');
    await writeFile(join(ops, 'docs', 'hosts.md'), 'shop runs on port 3000\n');
    await writeFile(join(ops, 'services.md'), 'port 3000\n');
    await writeFile(join(ops, 'docs', 'projects', 'shop.md'), 'port 3000\n');
    await writeFile(join(ops, 'docs', 'notes.md'), 'port 3000\n');
    const paths = (await classifySources({ name: 'ops', path: ops })).map((x) => x.path);
    for (const owned of ['sync-agent-docs.json', 'store/facts.json', 'docs/hosts.md', 'services.md', 'docs/projects/shop.md']) expect(paths).not.toContain(join(ops, owned));
    expect(paths).toContain(join(ops, 'docs', 'notes.md'));
    expect(paths).toContain(join(ops, 'CLAUDE.md'));
  });

  it("a store config with bad views falls back to the default views and says so", async () => {
    const { root } = await materializeFixture('messy-dev');
    const ops = join(root, 'ops');
    await mkdir(join(ops, 'store'), { recursive: true });
    await writeFile(join(ops, 'sync-agent-docs.json'), JSON.stringify({ views: { hosts: 42, services: '../shop', projects: '' } }));
    await writeFile(join(ops, 'hosts.md'), 'port 3000\n');
    const skipped: SkippedFile[] = [];
    const paths = (await classifySources({ name: 'ops', path: ops }, skipped)).map((x) => x.path);
    expect(paths).not.toContain(join(ops, 'hosts.md'));
    expect(skipped).toContainEqual(expect.objectContaining({ path: join(ops, 'sync-agent-docs.json'), note: expect.stringMatching(/views/) }));
    const shop = (await classifySources({ name: 'shop', path: join(root, 'shop') })).map((x) => x.path);
    expect(shop.length).toBeGreaterThan(0);
  });

  it("a store view that points outside the store folder is not skipped", async () => {
    const { root } = await materializeFixture('messy-dev');
    const ops = join(root, 'ops');
    await mkdir(join(ops, 'store'), { recursive: true });
    await mkdir(join(ops, 'docs'), { recursive: true });
    await writeFile(join(ops, 'docs', 'CLAUDE.md'), 'port 3000\n');
    await mkdir(join(ops, 'sub'), { recursive: true });
    await writeFile(join(ops, 'sync-agent-docs.json'), JSON.stringify({ views: { hosts: 'sub/../docs/CLAUDE.md', services: '/etc/passwd', projects: '..' } }));
    const skipped: SkippedFile[] = [];
    const paths = (await classifySources({ name: 'ops', path: ops }, skipped)).map((x) => x.path);
    expect(paths).toContain(join(ops, 'CLAUDE.md'));
    expect(skipped.some((x) => x.path === join(ops, 'sync-agent-docs.json'))).toBe(true);
  });

  it('a sync-agent-docs.json without a store folder is an ordinary file', async () => {
    const { root } = await materializeFixture('messy-dev');
    const ops = join(root, 'ops');
    await writeFile(join(ops, 'sync-agent-docs.json'), '{}');
    await writeFile(join(ops, 'services.md'), 'port 3000\n');
    const paths = (await classifySources({ name: 'ops', path: ops })).map((x) => x.path);
    expect(paths).toContain(join(ops, 'services.md'));
  });

  it('classifies CLAUDE.md as claim/claude and ecosystem.config.cjs as truth/pm2', async () => {
    const { root } = await materializeFixture('messy-dev');
    const sources = await classifySources({ name: 'shop', path: join(root, 'shop') });
    const byName = (n: string) => sources.find((s) => s.path.endsWith(n));
    expect(byName('/CLAUDE.md')).toMatchObject({ kind: 'claim', agent: 'claude', format: 'markdown', scope: 'repo', repo: 'shop' });
    expect(byName('/AGENTS.md')).toMatchObject({ kind: 'claim', agent: 'agents' });
    expect(byName('/README.md')).toMatchObject({ kind: 'claim', agent: null });
    expect(byName('/ecosystem.config.cjs')).toMatchObject({ kind: 'truth', format: 'pm2' });
    expect(byName('/.env')).toMatchObject({ kind: 'truth', format: 'env' });
    const blog = await classifySources({ name: 'blog', path: join(root, 'blog') });
    expect(blog.find((s) => s.path.endsWith('.vercel/project.json'))).toMatchObject({ kind: 'truth', format: 'vercel-project' });
  });

  it('workflow yml files are read as github-workflow truth', async () => {
    const { root } = await materializeFixture('messy-dev');
    const shop = join(root, 'shop');
    await mkdir(join(shop, '.github', 'workflows'), { recursive: true });
    await writeFile(join(shop, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    await writeFile(join(shop, '.github', 'workflows', 'ci.yaml'), 'name: ci\n');
    const sources = await classifySources({ name: 'shop', path: shop });
    for (const file of ['ci.yml', 'ci.yaml']) {
      expect(sources.find((s) => s.path.endsWith(`.github/workflows/${file}`))).toMatchObject({ kind: 'truth', format: 'github-workflow' });
    }
  });

  it('skips a 600 KB file, a binary file and an invalid UTF-8 file with reasons', async () => {
    const { root } = await materializeFixture('messy-dev');
    const big = join(root, 'big.md');
    const bin = join(root, 'bin.md');
    const latin = join(root, 'latin.md');
    await writeFile(big, 'a'.repeat(600 * 1024));
    await writeFile(bin, Buffer.from([0x68, 0x00, 0x69]));
    await writeFile(latin, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(await readTextSafe(big)).toEqual({ skipped: { path: big, reason: 'too-large' } });
    expect(await readTextSafe(bin)).toEqual({ skipped: { path: bin, reason: 'binary' } });
    expect(await readTextSafe(latin)).toEqual({ skipped: { path: latin, reason: 'not-utf8' } });
    const missing = await readTextSafe(join(root, 'nope.md'));
    expect('skipped' in missing && missing.skipped.reason).toBe('unreadable');
    expect(await readTextSafe(join(root, 'shop', 'README.md'))).toEqual({ text: '# shop\n\nshop runs on port 3000\n' });
    await rm(big);
  });

  it('a symlink to a device is skipped, not read without bound', async () => {
    const { root } = await materializeFixture('messy-dev');
    const dev = join(root, 'zero.md');
    await symlink('/dev/zero', dev);
    const r = await readTextSafe(dev);
    expect('skipped' in r && r.skipped.reason).toBe('unreadable');
    expect('skipped' in r && r.skipped.note).toContain('not a regular file');
  });

  it('a symlinked CLAUDE.md is kept once', async () => {
    const { root, home } = await materializeFixture('messy-dev');
    const link = join(home, '.claude', 'CLAUDE.md');
    await rm(link);
    await symlink(join(root, 'ops', 'CLAUDE.md'), link);
    const machine: SourceFile = {
      path: link, realPath: await realpath(link), repo: null,
      kind: 'claim', scope: 'machine', format: 'markdown', agent: 'claude',
    };
    const ops = await classifySources({ name: 'ops', path: join(root, 'ops') });
    const kept = dedupeByRealPath([machine, ...ops]).filter((s) => s.realPath === machine.realPath);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.scope).toBe('repo');
  });

  it('an unreadable folder is skipped with a note and the scan goes on', async () => {
    const { root } = await materializeFixture('messy-dev');
    const locked = join(root, 'shop', 'pgdata');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const skipped: SkippedFile[] = [];
      const repos = await findRepos(root, skipped);
      const shop = repos.find((r) => r.name === 'shop');
      expect(shop).toBeDefined();
      const sources = await classifySources(shop as RepoInfo, skipped);
      expect(sources.length).toBeGreaterThan(0);
      expect(skipped).toEqual([{ path: locked, reason: 'unreadable', note: 'EACCES' }]);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('an unreadable .gitignore is noted and the repo is still scanned', async () => {
    const { root } = await materializeFixture('messy-dev');
    const gi = join(root, 'blog', '.gitignore');
    await writeFile(gi, 'dist/\n');
    await chmod(gi, 0o000);
    try {
      const skipped: SkippedFile[] = [];
      const repos = await findRepos(root, skipped);
      const blog = repos.find((r) => r.name === 'blog') as RepoInfo;
      expect((await classifySources(blog, skipped)).length).toBeGreaterThan(0);
      expect(skipped).toEqual([{ path: gi, reason: 'unreadable', note: 'EACCES' }]);
    } finally {
      await chmod(gi, 0o644);
    }
  });
});
