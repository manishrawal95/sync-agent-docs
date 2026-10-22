import { describe, expect, it } from 'vitest';
import { linkMentions } from '../src/link/link.js';
import type { Attribute, Entity, Mention } from '../src/types.js';

const entities: Entity[] = [
  { id: 'project:shop', kind: 'project', names: ['shop'], identifiers: {} },
  { id: 'project:blog', kind: 'project', names: ['blog'], identifiers: { domain: 'blog.example.com' } },
  { id: 'host:hetzner', kind: 'host', names: ['hetzner', '100.64.1.10'], identifiers: { ip: '100.64.1.10' } },
  { id: 'project:ui', kind: 'project', names: ['ui'], identifiers: {} },
];
const mention = (attribute: Attribute, value: string, lineText: string): Mention => ({
  attribute, value, lineText, at: { path: '/dev/x.md', line: 1 }, kind: 'claim', scope: 'repo', agent: null,
});
const linked = (m: Mention) => linkMentions([m], entities)[0]?.entityId;

describe('linkMentions', () => {
  it('README port 3000 links to shop', () => {
    expect(linked(mention('port', '3000', 'Shop runs on port 3000'))).toBe('project:shop');
  });

  it("'shop and blog both use port 5432' links nothing", () => {
    expect(linked(mention('port', '5432', 'shop and blog both use port 5432'))).toBeNull();
    expect(linked(mention('port', '4100', 'shop and blog both use port 4100'))).toBeNull();
    expect(linked(mention('port', '5432', 'shop db on port 5432'))).toBeNull();
  });

  it("'hetzner box: 100.64.1.10' links to the hetzner host by identifier", () => {
    expect(linked(mention('ip', '100.64.1.10', 'shop deploys to 100.64.1.10'))).toBe('host:hetzner');
    expect(linked(mention('domain', 'blog.example.com', 'see blog.example.com and shop'))).toBe('project:blog');
  });

  it("'listen on port 8080' with no name stays unlinked", () => {
    expect(linked(mention('port', '8080', 'listen on port 8080'))).toBeNull();
  });

  it('matches whole words only and ignores names under 3 chars', () => {
    expect(linked(mention('port', '3000', 'shopify runs on port 3000'))).toBeNull();
    expect(linked(mention('port', '3000', 'the ui shop runs on port 3000'))).toBe('project:shop');
  });

  it('an IP links by name only to a host', () => {
    expect(linked(mention('ip', '10.0.0.4', 'hetzner standby is 10.0.0.4'))).toBe('host:hetzner');
    expect(linked(mention('ip', '10.0.0.4', 'shop staging box 10.0.0.4'))).toBeNull();
  });

  it('a name inside a path or a hyphenated name does not link', () => {
    expect(linked(mention('port', '8100', 'pkill -f "port 8100" then cd ~/dev/shop/.worktrees/x'))).toBeNull();
    expect(linked(mention('port', '8100', 'shop-api listens on port 8100'))).toBeNull();
  });

  it('a table row links by its first cell only', () => {
    expect(linked(mention('port', '8500', '| `code-server` | 8500 | gated like shop |'))).toBeNull();
    expect(linked(mention('port', '3300', '| `shop` (pm2) | 3300 | Next.js app |'))).toBe('project:shop');
  });

  it('a line with two different ports links neither', () => {
    const line = 'the file lists localhost:3002 (dev runs there when shop holds 3000)';
    expect(linkMentions([mention('port', '3002', line), mention('port', '3000', line)], entities).map((f) => f.entityId)).toEqual([null, null]);
  });

  it('a host IP named on a line does not pull a second IP onto that host', () => {
    const line = 'replaced `89.0.2.64` with `100.64.1.10` in the rsync lines';
    expect(linkMentions([mention('ip', '89.0.2.64', line), mention('ip', '100.64.1.10', line)], entities).map((f) => f.entityId)).toEqual([null, 'host:hetzner']);
  });

  it('a line in a file named for one entity that names another links nothing', () => {
    const at = { path: '/dev/ops/projects/blog.md', line: 3 };
    const m = { ...mention('port', '3002', 'dev runs on 3002 when shop holds the default'), at };
    expect(linkMentions([m], entities)[0]?.entityId).toBeNull();
    expect(linkMentions([{ ...mention('port', '3002', 'blog dev runs on 3002'), at }], entities)[0]?.entityId).toBe('project:blog');
  });

  it('an app name links only to lines inside its own repo', () => {
    const app: Entity = { id: 'app:shop/web', kind: 'app', names: ['web'], identifiers: {}, within: '/dev/shop' };
    const at = (path: string) => ({ ...mention('port', '4000', 'Open the web preview at localhost:4000'), at: { path, line: 1 } });
    expect(linkMentions([at('/dev/blog/README.md'), at('/dev/shop/README.md')], [...entities, app]).map((f) => f.entityId)).toEqual([null, 'app:shop/web']);
  });

  it('an app named after its project links from any repo; a generic one only inside its own', () => {
    const own: Entity = { id: 'app:shop/shop-api', kind: 'app', names: ['shop-api'], identifiers: {} };
    const webA: Entity = { id: 'app:shop/web', kind: 'app', names: ['web'], identifiers: {}, within: '/dev/shop' };
    const webB: Entity = { id: 'app:blog/web', kind: 'app', names: ['web'], identifiers: {}, within: '/dev/blog' };
    const at = (text: string, path: string) => ({ ...mention('port', '8100', text), at: { path, line: 1 } });
    const ids = linkMentions([at('the api runs as shop-api on 8100', '/dev/ops/hosts.md'), at('the web app runs on 8100', '/dev/shop/README.md')], [own, webA, webB]).map((f) => f.entityId);
    expect(ids).toEqual(['app:shop/shop-api', 'app:shop/web']);
  });
});
