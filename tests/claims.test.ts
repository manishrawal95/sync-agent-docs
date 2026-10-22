import { describe, expect, it } from 'vitest';
import { extractMentions } from '../src/claims/extract.js';
import { findSecrets, mask } from '../src/claims/secrets.js';
import type { Attribute, SourceFile } from '../src/types.js';

const doc: SourceFile = {
  path: '/dev/shop/CLAUDE.md', realPath: '/dev/shop/CLAUDE.md', repo: 'shop',
  kind: 'claim', scope: 'repo', format: 'markdown', agent: 'claude',
};
const values = (text: string, attribute: Attribute) =>
  extractMentions(doc, text).filter((m) => m.attribute === attribute).map((m) => m.value);

// Built at runtime so no secret-shaped string sits in the repo.
const fakeToken = () => 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

describe('extractMentions', () => {
  it("extracts port 3000 from 'shop runs on port 3000'", () => {
    const [m] = extractMentions(doc, '# shop\n\nshop runs on port 3000\n');
    expect(m).toMatchObject({ attribute: 'port', value: '3000', at: { path: doc.path, line: 3 }, lineText: 'shop runs on port 3000', kind: 'claim', scope: 'repo', agent: 'claude' });
  });

  it('extracts ports from :N, -p N and PORT=N', () => {
    expect(values('open http://localhost:3300 or 10.1.2.3:8080, run next start -p 4000 with PORT=5000', 'port').sort()).toEqual(['3300', '4000', '5000', '8080']);
    expect(values('meeting at 10:30, ratio 16:9, port 99999', 'port')).toEqual([]);
  });

  it('extracts a port named by listens on, binds to or serves on, with or without a colon', () => {
    expect(values('shop listens on 3300', 'port')).toEqual(['3300']);
    expect(values('the api binds to :8100 and serves on 4000', 'port').sort()).toEqual(['4000', '8100']);
    expect(values('listening at 9000.', 'port')).toEqual(['9000']);
  });

  it('a listen verb before a version, a date, an address or a count is not a port', () => {
    expect(values('listens on 24.x, served on 2026-10-22, bound to 10.0.0.4, serves 3 regions, listens on 3 cores', 'port')).toEqual([]);
    expect(values('shop runs on 4 machines', 'port')).toEqual([]);
  });

  it('ignores 127.0.0.1, 0.0.0.0/0, 203.0.113.5 and v1.2.3.4', () => {
    expect(values('bind 127.0.0.1, allow 0.0.0.0/0, see 203.0.113.5, release v1.2.3.4, also 0.0.0.0 and 10.0.0.0/8', 'ip')).toEqual([]);
    expect(values('build 1.2.3.4-beta and 1.2.3.4.5', 'ip')).toEqual([]);
    expect(values('old staging box 10.0.0.4.', 'ip')).toEqual(['10.0.0.4']);
  });

  it('table cell under a Port header is a port', () => {
    const text = '| App | Port | Notes |\n|---|---|---|\n| shop | 3300 | main |\n| blog | `4100` | x |\n\nplain 5000 line\n';
    const ports = extractMentions(doc, text).filter((m) => m.attribute === 'port');
    expect(ports.map((m) => [m.value, m.at.line])).toEqual([['3300', 3], ['4100', 4]]);
  });

  it('extracts domains, urls, env names, commands and paths', () => {
    const text = [
      'site at https://shop.example.com/admin and blog.example.org',
      'see next.config.js and mail me@example.com',
      'set `SHOP_API_URL` and DATABASE_URL=... but not `GET` or `API`',
      'files in ~/dev/ops and /etc/nginx/sites, not /api/cron',
      '```bash',
      'pm2 restart shop',
      '```',
    ].join('\n');
    expect(values(text, 'url')).toEqual(['https://shop.example.com/admin']);
    expect(values(text, 'domain').sort()).toEqual(['blog.example.org', 'shop.example.com']);
    expect(values(text, 'env').sort()).toEqual(['DATABASE_URL', 'SHOP_API_URL']);
    expect(values(text, 'path').sort()).toEqual(['/etc/nginx/sites', '~/dev/ops']);
    expect(values(text, 'command')).toEqual(['pm2 restart shop']);
  });

  it('skips lines that hold a secret', () => {
    expect(extractMentions(doc, `API_TOKEN=${fakeToken()} on 10.9.8.7\n`)).toEqual([]);
  });
});

describe('findSecrets', () => {
  it('detects the fixture secret and masks it to 4 chars', () => {
    const secret = 'tf' + 'Q2x9Lm4Rt7Vb1Nc8Zk3Hy6Wd';
    const [f] = findSecrets({ ...doc, path: '/dev/shop/AGENTS.md' }, `# Agents\n\nAPI_TOKEN=${secret}\n`);
    expect(f).toMatchObject({ type: 'secret', at: [{ path: '/dev/shop/AGENTS.md', line: 3 }], masked: 'tfQ2…' });
    expect(JSON.stringify(f)).not.toContain(secret.slice(4));
  });

  it('detects known token shapes and url credentials', () => {
    const text = `token ${fakeToken()}\npostgres://app:hunter2pass@db.example.com/x\n`;
    const found = findSecrets(doc, text);
    expect(found.map((f) => f.at?.[0]?.line)).toEqual([1, 2]);
    expect(JSON.stringify(found)).not.toContain('hunter2pass');
  });

  it('detects Anthropic and OpenAI keys in prose, and not sk- with short or placeholder text', () => {
    const body = 'Q2x9Lm4Rt7Vb1Nc8Zk3Hy6Wd' + 'p5Fs0Jg_Ae-Tu2Ov';
    const keys = ['sk-' + 'ant-api03-' + body, 'sk-' + 'ant-admin01-' + body, 'sk-' + 'proj-' + body, 'sk-' + 'svcacct-' + body];
    const text = keys.map((k) => `the key is ${k} for now`).join('\n') + '\n';
    const found = findSecrets(doc, text);
    expect(found.map((f) => f.at?.[0]?.line)).toEqual([1, 2, 3, 4]);
    expect(JSON.stringify(found)).not.toContain(body.slice(0, 8));
    const fakes = ['sk-ant-api03-...', 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'sk-proj-abc123', 'sk-proj-<your-key>', 'sk-proj-XXXXXXXXXXXXXXXXXXXXXXXX', 'use sk-ant-... here'];
    expect(findSecrets(doc, fakes.map((f) => `key: ${f}`).join('\n') + '\n')).toEqual([]);
  });

  it('a placeholder like API_TOKEN=<your-token> is not a secret', () => {
    const text = 'API_TOKEN=<your-token>\nAPI_TOKEN=${API_TOKEN}\nREDIRECT_URI=https://app.example.com/linkedin/callback\nKEY_PATH=/etc/ssl/private/server.pem\nAPI_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx\n';
    expect(findSecrets(doc, text)).toEqual([]);
  });

  it('truth files are not searched', () => {
    expect(findSecrets({ ...doc, kind: 'truth', format: 'env' }, `API_TOKEN=${fakeToken()}\n`)).toEqual([]);
  });

  it('mask never shows more than 4 characters', () => {
    expect(mask('abcdefghijkl')).toBe('abcd…');
    expect(mask('abcdef')).toBe('abc…');
  });

  it('a four-part version after version, release or build is not an IP, but user@ip is', () => {
    for (const line of ['Upgraded to version 2.1.0.4 last week', 'release 10.2.0.1', 'build: 1.0.0.12', '"version": "2.1.0.4"', 'version=2.1.0.4']) expect(values(line, 'ip')).toEqual([]);
    expect(values('the box is 89.0.0.9', 'ip')).toEqual(['89.0.0.9']);
    expect(values('ssh root@89.0.0.9 then rsync -az a deploy@89.0.0.10:/root/x', 'ip')).toEqual(['89.0.0.9', '89.0.0.10']);
  });
});
