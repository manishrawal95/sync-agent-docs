import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractMentions } from '../src/claims/extract.js';
import { findSecrets } from '../src/claims/secrets.js';
import { collectScan, runScan } from '../src/scan.js';
import type { SourceFile } from '../src/types.js';

const NO_CRONTAB = 'sync-agent-docs-test-no-crontab';

// Made-up IDs, built in pieces so repo secret scanners do not flag the fixtures themselves.
const SHA = ['5d76f67b8f90d04e', 'ff27b7e9c327db94c08a1b2c'].join('');
const UUID = ['3f2a9c1e', '8b7d', '4e6f', 'a5c4', '1d2e3f4a5b6c'].join('-');
const SRI = `sha512-${['Zq8xK2mP9vL4wR7n', 'B3cD5eFgHjK1L2M3', 'N4O5P6Q7R8S9T0'].join('')}=`;

/** A temp ~/dev with one git repo per key of `repos`, each holding the given files. */
async function makeDev(repos: Record<string, Record<string, string>>): Promise<{ root: string; home: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'sync-agent-docs-precision-')));
  const home = join(base, 'home');
  const root = join(home, 'dev');
  for (const [repo, files] of Object.entries(repos)) {
    const dir = join(root, repo);
    await mkdir(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
  }
  return { root, home };
}
const scan = (root: string, home: string) => collectScan(root, { home, reposOnly: true, crontabCommand: NO_CRONTAB });

const doc: SourceFile = {
  path: '/dev/shop/CLAUDE.md', realPath: '/dev/shop/CLAUDE.md', repo: 'shop',
  kind: 'claim', scope: 'repo', format: 'markdown', agent: 'claude',
};

describe('scan: secrets stay out and false findings stay out', () => {
  it('a private key body inside a bash fence never reaches scan.json', async () => {
    const body = randomBytes(48).toString('base64');
    const { root, home } = await makeDev({
      shop: { 'README.md': ['# shop', '', '```bash', 'cat > deploy.pem <<EOF', '-----BEGIN RSA ' + 'PRIVATE KEY-----', body, '-----END RSA ' + 'PRIVATE KEY-----', 'EOF', '```', ''].join('\n') },
    });
    await runScan(root, { home, reposOnly: true, crontabCommand: NO_CRONTAB });
    expect(await readFile(join(root, '.sync-agent-docs', 'scan.json'), 'utf8')).not.toContain(body);
  });

  it('a YAML api_key line never reaches scan.json', async () => {
    const tok = 'tf' + 'Q2x9Lm4Rt7Vb1Nc8Zk3Hy6Wd';
    const { root, home } = await makeDev({ shop: { 'README.md': `# shop\n\napi_key: ${tok}\n` } });
    const result = await runScan(root, { home, reposOnly: true, crontabCommand: NO_CRONTAB });
    expect(JSON.stringify(result)).not.toContain(tok.slice(4));
    expect(await readFile(join(root, '.sync-agent-docs', 'scan.json'), 'utf8')).not.toContain(tok.slice(4));
  });

  it('a URL with a port and an @ later in its path is not a credential', () => {
    const src = { ...doc, path: '/dev/shop/README.md' };
    expect(findSecrets(src, 'Vite serves the client at http://localhost:5173/@vite/client\n')).toEqual([]);
    expect(extractMentions(src, 'shop dev server: http://localhost:5173/@vite/client').map((m) => m.attribute)).toContain('port');
  });

  it('a URL password holding a slash, or an email as the user, is still a secret', () => {
    const src = { ...doc, path: '/dev/shop/README.md' };
    expect(findSecrets(src, 'db: postgres://app:Zq8/xW3pLm9vT2@db.example.com/shop\n')).toHaveLength(1);
    expect(findSecrets(src, 'smtp://ops@example.com:Hv7kQ2mPx9Lr@mail.example.com\n')).toHaveLength(1);
    expect(findSecrets(src, 'dev http://localhost:5173/@vite, db postgres://app:Hv7kQ2mPx9Lr@db.example.com\n')).toHaveLength(1);
  });

  it('a commit SHA, UUID or integrity hash under an ID name is not a secret', () => {
    const src = { ...doc, path: '/dev/shop/README.md' };
    const ids = [`COMMIT=${SHA}`, `TENANT_ID=${UUID}`, `integrity=${SRI}`];
    expect(findSecrets(src, `${ids.join('\n')}\n`)).toEqual([]);
    // A name that does not say ID, or says secret too, fails closed.
    const keys = [`API_KEY=${SHA}`, `CLIENT_SECRET=${UUID}`, `v=${UUID}`, `API_KEY_ID=${SHA}`];
    expect(findSecrets(src, `${keys.join('\n')}\n`)).toHaveLength(4);
    expect(findSecrets(src, `PASSWORD=${SRI}\n`)).toHaveLength(1);
  });

  it('a password that starts with digits and a slash is a secret, a port and path is not', () => {
    const src = { ...doc, path: '/dev/shop/README.md' };
    expect(findSecrets(src, 'db: postgres://app:2024/Zq8xW3pLm9@db.example.com/shop\n')).toHaveLength(1);
    const paths = ['http://localhost:5173/@vite/client', 'http://dev.example.com:8080/api/@scope/pkg', 'http://db:5432/@scope', 'http://10.0.0.5:3000/u/@me'];
    expect(findSecrets(src, `${paths.join('\n')}\n`)).toEqual([]);
  });

  it('a UUID under a secret name is a secret; an ID under a word holding "sig" is not', () => {
    const src = { ...doc, path: '/dev/shop/README.md' };
    expect(findSecrets(src, `WEBHOOK_SECRET=${UUID}\nHEROKU_API_KEY=${UUID}\nSESSION_TOKEN=${UUID}\n`)).toHaveLength(3);
    expect(findSecrets(src, `ORDER_ID=${UUID}\nDESIGN_ID=${SHA}\n`)).toEqual([]);
  });

  it('a shell script name is not a domain and file:line is not a port', () => {
    const ms = extractMentions(doc, 'shop deploys with scripts/deploy.sh:42');
    expect(ms.filter((m) => m.attribute === 'domain').map((m) => m.value)).toEqual([]);
    expect(ms.filter((m) => m.attribute === 'port').map((m) => m.value)).toEqual([]);
  });

  it('script.sh:N in a doc raises no false port conflict', async () => {
    const { root, home } = await makeDev({
      shop: {
        'package.json': JSON.stringify({ name: 'shop', scripts: { dev: 'next dev' } }, null, 2),
        'README.md': '# shop\n\nshop health check lives at scripts/health-check.sh:15\n',
      },
    });
    const r = await scan(root, home);
    expect(r.findings.filter((f) => f.type === 'conflict')).toEqual([]);
  });

  it('a netmask in a doc is not a stale host IP', async () => {
    const { root, home } = await makeDev({ shop: { 'README.md': '# shop\n\nThe VPC uses netmask 255.255.255.0.\n' } });
    const r = await scan(root, home);
    expect(r.findings.filter((f) => f.type === 'stale' && f.attribute === 'ip')).toEqual([]);
  });

  it("a generic repo name ('api') does not pull another repo's prose onto it", async () => {
    const { root, home } = await makeDev({
      api: { 'package.json': JSON.stringify({ name: 'api', scripts: { start: 'node server.js --port 4000' } }, null, 2) },
      shop: { 'README.md': '# shop\n\nThe api listens on port 5000 in this repo.\n' },
    });
    const r = await scan(root, home);
    expect(r.findings.filter((f) => f.type === 'conflict')).toEqual([]);
  });

  it('an unquoted multi-line key in .env never yields a key chunk as an env name', async () => {
    const chunk = 'Mk' + randomBytes(30).toString('hex');
    const { root, home } = await makeDev({ shop: { '.env': ['PRIVATE_KEY=-----BEGIN PRIVATE ' + 'KEY-----', 'AAAAB3NzaC1yc2E', chunk + '==', '-----END PRIVATE ' + 'KEY-----', ''].join('\n') } });
    const r = await scan(root, home);
    expect(JSON.stringify(r)).not.toContain(chunk);
  });

  it('a repo symlink to a file outside the scan root is not read', async () => {
    const { root, home } = await makeDev({ shop: { 'README.md': '# shop\n' } });
    await writeFile(join(home, '.netrc'), 'machine api.shop-internal.com login me password hunter2hunter2\n');
    await symlink(join(home, '.netrc'), join(root, 'shop', 'notes.md'));
    const r = await scan(root, home);
    expect(JSON.stringify(r)).not.toContain('hunter2hunter2');
  });

  it('a ~/ path a doc says lives on the server is not called stale on this machine', async () => {
    const { root, home } = await makeDev({ shop: { 'README.md': '# shop\n\nOn the box, the cron token lives in `~/.shop-cron-env` (chmod 600).\n' } });
    const r = await scan(root, home);
    expect(r.findings.filter((f) => f.type === 'stale' && f.attribute === 'path')).toEqual([]);
  });
  it('a long URL password is still found', () => {
    const [f] = findSecrets({ ...doc, path: '/dev/shop/README.md' }, `db: postgres://app:${'Xk29fLq8'.repeat(100)}@db.example.com/app\n`);
    expect(f?.message).toContain('Xk29');
  });

  it('a long line of half-made URLs is read in linear time', () => {
    const line = '://a:'.repeat(100000);
    const started = performance.now();
    expect(findSecrets({ ...doc, path: '/dev/shop/README.md' }, `${line}\n`)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
