import { execFileSync } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepos } from '../src/discover/repos.js';
import { classifySources } from '../src/discover/sources.js';
import { parseTruth, withoutCredentials } from '../src/truth/parse.js';
import { portsInDocLine } from '../src/truth/parsed.js';
import type { TruthResult } from '../src/types.js';
import { materializeFixture } from './helpers/fixture.js';

async function truthOf(root: string): Promise<TruthResult> {
  const repos = await findRepos(root);
  const sources = (await Promise.all(repos.map((r) => classifySources(r)))).flat();
  return parseTruth(sources.filter((s) => s.kind === 'truth'), repos);
}

describe('truth', () => {
  it('pm2 app shop has port 3300 from -p', async () => {
    const { root } = await materializeFixture('messy-dev');
    const truth = await truthOf(root);
    const shop = truth.entities.find((e) => e.names.includes('shop'));
    expect(truth.entities.filter((e) => e.names.includes('shop'))).toHaveLength(1);
    const port = truth.facts.find((f) => f.entityId === shop?.id && f.attribute === 'port');
    expect(port).toMatchObject({ value: '3300', kind: 'truth', scope: 'repo' });
    expect(port?.at).toEqual({ path: join(root, 'shop', 'ecosystem.config.cjs'), line: 6 });
  });

  it('env file yields names only', async () => {
    const { root } = await materializeFixture('messy-dev');
    const truth = await truthOf(root);
    expect(truth.facts.some((f) => f.attribute === 'env' && f.value === 'DATABASE_URL')).toBe(true);
    for (const f of truth.facts) {
      expect(f.value).not.toContain('postgres://');
      expect(f.lineText).not.toContain('postgres://');
    }
    for (const token of truth.corpus) expect(token).not.toContain('postgres');
    expect(truth.corpus.has('DATABASE_URL')).toBe(true);
  });

  it('vercel project.json sets vercelProjectId on the blog project', async () => {
    const { root } = await materializeFixture('messy-dev');
    const truth = await truthOf(root);
    const blog = truth.entities.find((e) => e.names.includes('blog'));
    expect(blog).toMatchObject({ kind: 'project', identifiers: { vercelProjectId: 'prj_fixture1' } });
  });

  it('malformed wrangler.toml is skipped with a named reason', async () => {
    const { root } = await materializeFixture('messy-dev');
    const path = join(root, 'blog', 'wrangler.toml');
    await writeFile(path, 'name = "blog-worker"\n[vars\nSECRET_KEY = "abc"\n');
    const truth = await truthOf(root);
    const skipped = truth.skipped.find((s) => s.path === path);
    expect(skipped?.reason).toBe('unreadable');
    expect(skipped?.note).toContain('wrangler');
    expect(skipped?.note).not.toContain('abc');
  });

  it('malformed compose file is skipped naming the line', async () => {
    const { root } = await materializeFixture('messy-dev');
    const path = join(root, 'shop', 'docker-compose.yml');
    await writeFile(path, 'services:\n  web:\n    image: shop\n  bad: [\n    REDIS_PASSWORD: hunter2\n');
    const skipped = (await truthOf(root)).skipped.find((s) => s.path === path);
    expect(skipped?.reason).toBe('unreadable');
    expect(skipped?.note).toMatch(/as compose near line [1-9]\d*;/);
    expect(skipped?.note).not.toContain('hunter2');
  });

  it('compose services, fly apps, wrangler vars and procfile ports become facts', async () => {
    const { root } = await materializeFixture('messy-dev');
    await writeFile(join(root, 'blog', 'docker-compose.yml'), 'services:\n  cache:\n    ports:\n      - "6380:6379"\n    environment:\n      REDIS_PASSWORD: hunter2\n');
    await writeFile(join(root, 'blog', 'fly.toml'), 'app = "blog-edge"\n[http_service]\n  internal_port = 8081\n');
    await writeFile(join(root, 'blog', 'wrangler.toml'), 'name = "blog-worker"\nroutes = ["blog.example.com/*"]\n[vars]\nSITE_MODE = "x"\n');
    await writeFile(join(root, 'blog', 'Procfile'), 'web: next start -p 4100\n');
    const truth = await truthOf(root);
    const byName = (n: string) => truth.entities.find((e) => e.names.includes(n))?.id;
    const has = (entity: string | undefined, attribute: string, value: string) =>
      truth.facts.some((f) => f.entityId === entity && f.attribute === attribute && f.value === value);
    expect(has(byName('cache'), 'port', '6380')).toBe(true);
    expect(has(byName('cache'), 'env', 'REDIS_PASSWORD')).toBe(true);
    expect(has(byName('blog-edge'), 'port', '8081')).toBe(true);
    expect(has(byName('blog-worker'), 'env', 'SITE_MODE')).toBe(true);
    expect(has(byName('blog-worker'), 'domain', 'blog.example.com')).toBe(true);
    expect(has(byName('blog'), 'port', '4100')).toBe(true);
    expect([...truth.corpus].some((t) => t.includes('hunter2'))).toBe(false);
  });

  it('a wrangler.jsonc with block comments, trailing comments and trailing commas is read', async () => {
    const { root } = await materializeFixture('messy-dev');
    await writeFile(join(root, 'blog', 'wrangler.jsonc'), [
      '/**',
      ' * For more details on how to configure Wrangler, refer to:',
      ' * https://developers.cloudflare.com/workers/wrangler/configuration/',
      ' */',
      '{',
      '  "$schema": "node_modules/wrangler/config-schema.json",',
      '  "name": "blog-worker", // the worker name',
      '  /* routes live here */',
      '  "routes": [{ "pattern": "blog.example.com/*", "zone_name": "example.com" },],',
      '  "vars": { "DOCS_URL": "https://docs.example.com/a//b,}", "NOTE": "a /* not a comment */ \\" quote", },',
      '}',
      '',
    ].join('\n'));
    const truth = await truthOf(root);
    expect(truth.skipped.filter((s) => s.path.endsWith('wrangler.jsonc'))).toEqual([]);
    const worker = truth.entities.find((e) => e.names.includes('blog-worker'))?.id;
    const has = (attribute: string, value: string) => truth.facts.some((f) => f.entityId === worker && f.attribute === attribute && f.value === value);
    expect(has('domain', 'blog.example.com')).toBe(true);
    expect(has('env', 'DOCS_URL')).toBe(true);
    expect(has('env', 'NOTE')).toBe(true);
  });

  it('truth facts never carry raw config lines', async () => {
    const { root } = await materializeFixture('messy-dev');
    const marker = 'RAWLINEVALUE';
    await writeFile(join(root, 'shop', 'ecosystem.config.cjs'), `module.exports = { apps: [{ name: 'shop', args: 'start -p 3300 --api-key ${marker}' }] };\n`);
    await writeFile(join(root, 'blog', 'fly.toml'), `app = "blog-edge"\n[http_service]\n  internal_port = 8081 # ${marker}\n`);
    const truth = await truthOf(root);
    expect(truth.facts.some((f) => f.attribute === 'port' && f.value === '3300')).toBe(true);
    for (const f of truth.facts) expect(f.lineText).not.toContain(marker);
  });

  it('git remote credentials are stripped', async () => {
    const { root } = await materializeFixture('messy-dev');
    execFileSync('git', ['-C', join(root, 'shop'), 'remote', 'add', 'origin', 'https://user:tok3nvalue@example.com/x/shop.git']);
    const truth = await truthOf(root);
    expect(truth.entities.find((e) => e.id === 'project:shop')?.identifiers.gitRemote).toBe('https://example.com/x/shop.git');
    expect([...truth.corpus].some((t) => t.includes('tok3nvalue'))).toBe(false);
  });

  it('a remote keeps scheme, host and path only, whatever its password or query holds', () => {
    expect(withoutCredentials('https://bot:Hunter2@Xk29fLq8Zr7Vn@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(withoutCredentials('https://bot:Xk29/fLq8Zr7Vn@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    // Digits and a `/` would otherwise parse as a host and port, leaving the rest of the password as a path.
    expect(withoutCredentials('https://bot:12/fLq8Zr7Vn@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    // A `?` or `#` with an `@` after it may sit inside a password, so nothing of that remote is kept.
    expect(withoutCredentials('https://github.com/o/r.git?ref=a@b#c@d')).toBe('');
    expect(withoutCredentials('https://ghp_abcDEF123456:1?x@github.com/o/r.git')).toBe('');
    expect(withoutCredentials('https://ghp_abcDEF123456:#@github.com/o/r')).toBe('');
    expect(withoutCredentials('https://github.com/o/r.git?access_token=Xk29fLq8Zr7Vn#frag')).toBe('https://github.com/o/r.git');
    expect(withoutCredentials('ssh://git@git.example.com:2222/o/r.git')).toBe('ssh://git.example.com:2222/o/r.git');
    expect(withoutCredentials('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
    expect(withoutCredentials('bot:Xk29fLq8Zr7Vn@github.com:o/r.git')).toBe('github.com:o/r.git');
    expect(withoutCredentials('/srv/a@b/r.git')).toBe('/srv/a@b/r.git');
    expect(withoutCredentials('https://[broken')).toBe('');
  });

  it('an .env that is a device is skipped, not streamed', async () => {
    const { root } = await materializeFixture('messy-dev');
    const env = join(root, 'shop', '.env');
    await rm(env);
    await symlink('/dev/zero', env);
    const truth = await truthOf(root);
    expect(truth.skipped).toContainEqual(expect.objectContaining({ path: env, reason: 'unreadable' }));
  });

  it('an app named after its project is global; a generic app is scoped to its repo', async () => {
    const { root } = await materializeFixture('messy-dev');
    await writeFile(join(root, 'shop', 'docker-compose.yml'), 'services:\n  web:\n    ports: ["8080:3000"]\n  shop-worker:\n    ports: ["8081:3001"]\n');
    const truth = await truthOf(root);
    expect(truth.entities.find((e) => e.names.includes('web'))?.within).toBe(join(root, 'shop'));
    expect(truth.entities.find((e) => e.names.includes('shop-worker'))?.within).toBeUndefined();
  });

  it('a nested package.json with its own name is its own app', async () => {
    const { root } = await materializeFixture('messy-dev');
    await mkdir(join(root, 'shop', 'landing'));
    await writeFile(join(root, 'shop', 'landing', 'package.json'), JSON.stringify({ name: 'shop-landing', scripts: { dev: 'next dev -p 3400' } }, null, 2));
    const truth = await truthOf(root);
    const landing = truth.entities.find((e) => e.names.includes('shop-landing'));
    expect(landing?.kind).toBe('app');
    expect(truth.facts.find((f) => f.value === '3400')?.entityId).toBe(landing?.id);
  });

  it('next dev or next start without a port is port 3000', async () => {
    const { root } = await materializeFixture('messy-dev');
    await writeFile(join(root, 'blog', 'package.json'), JSON.stringify({ name: 'blog', scripts: { dev: 'next dev', start: 'next start -p 3300', lint: 'eslint .' } }, null, 2));
    const truth = await truthOf(root);
    const blog = truth.entities.find((e) => e.names.includes('blog'));
    expect(truth.facts.filter((f) => f.entityId === blog?.id && f.attribute === 'port').map((f) => f.value).sort()).toEqual(['3000', '3300']);
  });

  it('a multi-line quoted .env value never yields a name', async () => {
    const { root } = await materializeFixture('messy-dev');
    const tail = 'QkFBQUFBQUFBQUFBQUFBQUFB';
    await writeFile(join(root, 'shop', '.env'), ['CERT_BLOB="first line', `${tail}=`, 'end"', "OTHER='a", `${tail}=b'`, 'TICK=`a', `${tail}=`, 'b`', 'REAL_NAME=x', ''].join('\n'));
    const truth = await truthOf(root);
    const names = truth.facts.filter((f) => f.attribute === 'env' && f.at.path.endsWith(join('shop', '.env'))).map((f) => f.value);
    expect(names).toEqual(['CERT_BLOB', 'OTHER', 'TICK', 'REAL_NAME']);
    expect([...truth.corpus].some((t) => t.includes(tail))).toBe(false);
  });

  it('a git refusal other than a missing origin is recorded, not dropped', async () => {
    const { root } = await materializeFixture('messy-dev');
    await mkdir(join(root, 'broken'));
    await writeFile(join(root, 'broken', '.git'), 'gitdir: /nonexistent\n');
    const truth = await truthOf(root);
    expect(truth.skipped.filter((s) => s.note?.startsWith('git remote'))).toEqual([{ path: join(root, 'broken'), reason: 'unreadable', note: expect.stringMatching(/^git remote/) }]);
  });

  it('ps, lsof, kill, pgrep, ssh and mkdir -p are not ports', () => {
    for (const line of ['Check with `ps -p 48213`', 'lsof -p 4000', 'kill -p 4000', 'pgrep -p 4000', 'ssh -p 2222 host', 'mkdir -p 4000']) {
      expect(portsInDocLine(line), line).toEqual([]);
    }
  });

  it('-p after a dev server command is a port', () => {
    expect(portsInDocLine('next dev -p 3000')).toEqual(['3000']);
    expect(portsInDocLine('PORT=1 npx vite -p 5173')).toContain('5173');
    expect(portsInDocLine('npm run dev -- -p 3001')).toEqual(['3001']);
  });

  it('--port and PORT= count after any command', () => {
    expect(portsInDocLine('ps --port 4000')).toEqual(['4000']);
    expect(portsInDocLine('PORT=8080 node x.js')).toEqual(['8080']);
  });

  it('each segment of a line is judged on its own command', () => {
    expect(portsInDocLine('`ps -p 1` then `next dev -p 3000`')).toEqual(['3000']);
    expect(portsInDocLine('ps -p 1 && next start -p 3000')).toEqual(['3000']);
  });
});
